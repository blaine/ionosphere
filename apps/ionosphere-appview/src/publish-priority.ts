/**
 * Publish updated talk records for priority talks to the production PDS.
 *
 * Usage: BOT_PASSWORD=... npx tsx src/publish-priority.ts gDELD0M rj8Xv62
 */
import { PdsClient } from "./pds-client.js";
import { openDb } from "./db.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { encode } from "@ionosphere/format/transcript-encoding";

const PDS_URL = process.env.PDS_URL ?? "https://jellybaby.us-east.host.bsky.network";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.tv";
const BOT_PASSWORD = process.env.BOT_PASSWORD;

if (!BOT_PASSWORD) {
  console.error("Need BOT_PASSWORD env var");
  process.exit(1);
}

const rkeys = process.argv.slice(2);
if (rkeys.length === 0) {
  console.error("Usage: npx tsx src/publish-priority.ts <rkey> [rkey...]");
  process.exit(1);
}

async function main() {
  const pds = new PdsClient(PDS_URL);
  await pds.login(BOT_HANDLE, BOT_PASSWORD);
  const did = pds.getDid();
  console.log(`Logged in as ${did}`);

  const db = openDb();
  const eventUri = `at://${did}/tv.ionosphere.event/atmosphereconf-2026`;

  for (const rkey of rkeys) {
    const talk = db.prepare(
      "SELECT * FROM talks WHERE rkey = ? AND video_uri IS NOT NULL"
    ).get(rkey) as any;

    if (!talk) {
      console.log(`${rkey}: not found in DB`);
      continue;
    }

    const speakerRkeys = db.prepare(
      `SELECT s.rkey FROM speakers s
       JOIN talk_speakers ts ON s.uri = ts.speaker_uri
       WHERE ts.talk_uri = ?`
    ).all(talk.uri) as any[];

    const speakerUris = speakerRkeys.map(
      (s: any) => `at://${did}/tv.ionosphere.speaker/${s.rkey}`
    );

    const record: any = {
      $type: "tv.ionosphere.talk",
      title: talk.title,
      eventUri,
      ...(speakerUris.length > 0 && { speakerUris }),
      videoUri: talk.video_uri,
      ...(talk.video_offset_ns && { videoOffsetNs: talk.video_offset_ns }),
      ...(talk.schedule_uri && { scheduleUri: talk.schedule_uri }),
      ...(talk.room && { room: talk.room }),
      ...(talk.category && { category: talk.category }),
      ...(talk.talk_type && { talkType: talk.talk_type }),
      ...(talk.starts_at && { startsAt: talk.starts_at }),
      ...(talk.ends_at && { endsAt: talk.ends_at }),
      ...(talk.duration && { duration: talk.duration }),
      ...(talk.description && { description: talk.description }),
      ...(talk.video_segments && { videoSegments: JSON.parse(talk.video_segments) }),
    };

    await pds.putRecord("tv.ionosphere.talk", rkey, record);
    console.log(`${rkey}: talk published (videoUri=${talk.video_uri})`);

    // Also publish transcript if available
    const transcriptPath = path.resolve(import.meta.dirname, `../../data/transcripts/${rkey}.json`);
    if (existsSync(transcriptPath)) {
      const transcript = JSON.parse(readFileSync(transcriptPath, "utf-8"));
      const compact = encode(transcript);
      const talkUri = `at://${did}/tv.ionosphere.talk/${rkey}`;
      await pds.putRecord("tv.ionosphere.transcript", `${rkey}-transcript`, {
        $type: "tv.ionosphere.transcript",
        talkUri,
        text: compact.text,
        startMs: compact.startMs,
        timings: compact.timings,
      });
      console.log(`${rkey}: transcript published (${transcript.words.length} words)`);
    }
  }

  db.close();
  console.log("Done");
}

main().catch(console.error);
