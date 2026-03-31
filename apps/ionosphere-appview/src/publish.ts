/**
 * Publish ionosphere records to the local PDS.
 *
 * Reads from the SQLite database and writes AT Protocol records
 * for events, speakers, talks, and concepts.
 *
 * Usage: npx tsx src/publish.ts
 */
import { PdsClient, slugToRkey } from "./pds-client.js";
import { openDb } from "./db.js";

const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.test";
const BOT_PASSWORD = process.env.BOT_PASSWORD ?? "ionosphere-dev-password";

async function main() {
  const pds = new PdsClient(PDS_URL);
  await pds.login(BOT_HANDLE, BOT_PASSWORD);
  const did = pds.getDid();
  console.log(`Logged in as ${did}`);

  const db = openDb();

  // Disable FK checks during URI migration (we're updating PKs that are referenced)
  db.pragma("foreign_keys = OFF");

  // 1. Publish event record
  const event = db
    .prepare("SELECT * FROM events LIMIT 1")
    .get() as any;

  if (event) {
    const eventRkey = event.rkey;
    const eventUri = await pds.putRecord("tv.ionosphere.event", eventRkey, {
      $type: "tv.ionosphere.event",
      name: event.name,
      description: event.description,
      location: event.location,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      tracks: JSON.parse(event.tracks || "[]"),
      scheduleRepo: event.schedule_repo,
      vodRepo: event.vod_repo,
    });
    console.log(`Event: ${eventUri}`);

    // Update the event URI in the database to use the real DID
    // Must update talks' event_uri first (FK constraint)
    const realEventUri = `at://${did}/tv.ionosphere.event/${eventRkey}`;
    db.prepare("UPDATE talks SET event_uri = ? WHERE event_uri = ?").run(
      realEventUri,
      event.uri
    );
    db.prepare("UPDATE events SET uri = ?, did = ? WHERE rkey = ?").run(
      realEventUri,
      did,
      eventRkey
    );
  }

  // 2. Publish speaker records
  const speakers = db.prepare("SELECT * FROM speakers").all() as any[];
  console.log(`\nPublishing ${speakers.length} speakers...`);

  for (const speaker of speakers) {
    const rkey = speaker.rkey;
    const uri = await pds.putRecord("tv.ionosphere.speaker", rkey, {
      $type: "tv.ionosphere.speaker",
      name: speaker.name,
      ...(speaker.handle && { handle: speaker.handle }),
      ...(speaker.speaker_did && { did: speaker.speaker_did }),
      ...(speaker.bio && { bio: speaker.bio }),
      ...(speaker.affiliations && {
        affiliations: JSON.parse(speaker.affiliations),
      }),
    });

    // Update URI — must update join table references first (FK constraint)
    const realUri = `at://${did}/tv.ionosphere.speaker/${rkey}`;
    db.prepare("UPDATE talk_speakers SET speaker_uri = ? WHERE speaker_uri = ?").run(
      realUri,
      speaker.uri
    );
    db.prepare("UPDATE speakers SET uri = ?, did = ? WHERE rkey = ?").run(
      realUri,
      did,
      rkey
    );
  }
  console.log(`  Done.`);

  // 3. Publish concept records
  const concepts = db.prepare("SELECT * FROM concepts").all() as any[];
  if (concepts.length > 0) {
    console.log(`\nPublishing ${concepts.length} concepts...`);
    for (const concept of concepts) {
      const rkey = concept.rkey;
      const uri = await pds.putRecord("tv.ionosphere.concept", rkey, {
        $type: "tv.ionosphere.concept",
        name: concept.name,
        ...(concept.aliases && { aliases: JSON.parse(concept.aliases) }),
        ...(concept.description && { description: concept.description }),
        ...(concept.wikidata_id && { wikidataId: concept.wikidata_id }),
        ...(concept.url && { url: concept.url }),
      });

      const realUri = `at://${did}/tv.ionosphere.concept/${rkey}`;
      db.prepare("UPDATE talk_concepts SET concept_uri = ? WHERE concept_uri = ?").run(
        realUri,
        concept.uri
      );
      db.prepare("UPDATE concepts SET uri = ?, did = ? WHERE rkey = ?").run(
        realUri,
        did,
        rkey
      );
    }
    console.log(`  Done.`);
  }

  // 4. Publish talk records
  const talks = db.prepare("SELECT * FROM talks").all() as any[];
  console.log(`\nPublishing ${talks.length} talks...`);

  const realEventUri = `at://${did}/tv.ionosphere.event/${event?.rkey}`;

  for (const talk of talks) {
    const rkey = talk.rkey;

    // Get speaker URIs for this talk (now using real DIDs)
    const talkSpeakers = db
      .prepare(
        `SELECT s.uri FROM speakers s
         JOIN talk_speakers ts ON s.uri = ts.speaker_uri
         WHERE ts.talk_uri = ?`
      )
      .all(talk.uri) as any[];

    // But talk_speakers still references old URIs — look up by rkey instead
    const talkSpeakersByRkey = db
      .prepare(
        `SELECT s.rkey FROM speakers s
         JOIN talk_speakers ts ON s.uri = ts.speaker_uri
         WHERE ts.talk_uri = ?`
      )
      .all(talk.uri) as any[];
    const speakerUris = talkSpeakersByRkey.map(
      (s: any) => `at://${did}/tv.ionosphere.speaker/${s.rkey}`
    );

    const record: Record<string, unknown> = {
      $type: "tv.ionosphere.talk",
      title: talk.title,
      eventUri: realEventUri,
      ...(speakerUris.length > 0 && { speakerUris }),
      ...(talk.video_uri && { videoUri: talk.video_uri }),
      ...(talk.schedule_uri && { scheduleUri: talk.schedule_uri }),
      ...(talk.room && { room: talk.room }),
      ...(talk.category && { category: talk.category }),
      ...(talk.talk_type && { talkType: talk.talk_type }),
      ...(talk.starts_at && { startsAt: talk.starts_at }),
      ...(talk.ends_at && { endsAt: talk.ends_at }),
      ...(talk.duration && { duration: talk.duration }),
      ...(talk.description && { description: talk.description }),
      // Document stored separately — too large for a single PDS record
      // when it contains per-word timestamp facets. Will be stored as
      // a separate record or blob in a future iteration.
    };

    await pds.putRecord("tv.ionosphere.talk", rkey, record);

    // Update URI — must update join table references first (FK constraint)
    const realUri = `at://${did}/tv.ionosphere.talk/${rkey}`;
    db.prepare("UPDATE talk_speakers SET talk_uri = ? WHERE talk_uri = ?").run(
      realUri,
      talk.uri
    );
    db.prepare("UPDATE talk_concepts SET talk_uri = ? WHERE talk_uri = ?").run(
      realUri,
      talk.uri
    );
    db.prepare("UPDATE talk_crossrefs SET from_talk_uri = ? WHERE from_talk_uri = ?").run(
      realUri,
      talk.uri
    );
    db.prepare("UPDATE talk_crossrefs SET to_talk_uri = ? WHERE to_talk_uri = ?").run(
      realUri,
      talk.uri
    );
    db.prepare("UPDATE pipeline_status SET talk_uri = ? WHERE talk_uri = ?").run(
      realUri,
      talk.uri
    );
    db.prepare("UPDATE talks SET uri = ?, did = ? WHERE rkey = ?").run(
      realUri,
      did,
      rkey
    );
  }
  console.log(`  Done.`);

  // Re-enable FK checks and verify integrity
  db.pragma("foreign_keys = ON");
  const fkErrors = db.pragma("foreign_key_check") as any[];
  if (fkErrors.length > 0) {
    console.error(`\nWARNING: ${fkErrors.length} foreign key violations found`);
    for (const e of fkErrors.slice(0, 5)) {
      console.error(`  ${e.table}: rowid=${e.rowid} → ${e.parent}`);
    }
  }

  console.log(`\nAll records published to ${PDS_URL}`);
  console.log(`DID: ${did}`);
  console.log(`Verify: curl http://localhost:2690/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=tv.ionosphere.talk&limit=5`);

  db.close();
}

main().catch(console.error);
