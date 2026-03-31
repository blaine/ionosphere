import { openDb, migrate } from "./db.js";
import { correlate, type ScheduleEvent, type VodRecord } from "./correlate.js";
import { loadLens, applyLens } from "@ionosphere/format/lenses";

const scheduleLens = loadLens("schedule-to-talk.lens.json");

const SCHEDULE_DID = "did:plc:3xewinw4wtimo2lqfy5fm5sw";
const SCHEDULE_COLLECTION = "community.lexicon.calendar.event";
const VOD_DID = "did:plc:rbvrr34edl5ddpuwcubjiost";
const VOD_COLLECTION = "place.stream.video";
const VOD_PDS = "https://iameli.com";
const BSKY_API = "https://bsky.social";

// ionosphere.tv's own DID — placeholder until the real DID is created.
const IONOSPHERE_DID = "did:plc:ionosphere-placeholder";

const EVENT_URI = `at://${IONOSPHERE_DID}/tv.ionosphere.event/atmosphereconf-2026`;

async function fetchAllRecords(baseUrl: string, repo: string, collection: string): Promise<any[]> {
  const records: any[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ repo, collection, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${baseUrl}/xrpc/com.atproto.repo.listRecords?${params}`);
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
    const data = await res.json();
    records.push(...data.records);
    cursor = data.cursor;
  } while (cursor);

  return records;
}

function parseScheduleEvent(record: any): ScheduleEvent | null {
  const v = record.value;
  const ad = v.additionalData;
  if (!ad?.isAtmosphereconf) return null;
  if (v.status === "community.lexicon.calendar.event#cancelled") return null;
  const type = ad?.type || "";
  if (["info", "food"].includes(type)) return null;

  const mapped = applyLens(scheduleLens, v);

  return {
    uri: record.uri,
    name: mapped.title,
    startsAt: mapped.startsAt,
    endsAt: mapped.endsAt,
    type: mapped.talkType || "",
    room: mapped.room || "",
    category: mapped.category || "",
    speakers: mapped.speakers || [],
    description: mapped.description || "",
  };
}

function parseVodRecord(record: any): VodRecord {
  return {
    uri: record.uri,
    title: record.value.title,
    creator: record.value.creator,
    duration: record.value.duration,
    createdAt: record.value.createdAt,
  };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function main() {
  console.log("Fetching schedule events...");
  const scheduleRaw = await fetchAllRecords(BSKY_API, SCHEDULE_DID, SCHEDULE_COLLECTION);
  const schedule = scheduleRaw.map(parseScheduleEvent).filter((e): e is ScheduleEvent => e !== null);
  console.log(`  ${schedule.length} schedule events (filtered from ${scheduleRaw.length})`);

  console.log("Fetching VOD records...");
  const vodRaw = await fetchAllRecords(VOD_PDS, VOD_DID, VOD_COLLECTION);
  const vods = vodRaw.map(parseVodRecord);
  console.log(`  ${vods.length} VOD records`);

  console.log("Correlating...");
  const matches = correlate(schedule, vods);
  console.log(`  ${matches.length} matches`);

  const db = openDb();
  migrate(db);

  // Insert event
  db.prepare(
    `INSERT OR REPLACE INTO events (uri, did, rkey, name, description, location, starts_at, ends_at, tracks, schedule_repo, vod_repo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    EVENT_URI, IONOSPHERE_DID, "atmosphereconf-2026",
    "ATmosphereConf 2026",
    "The global gathering for the AT Protocol community.",
    "AMS Student Nest, UBC, Vancouver, BC, Canada",
    "2026-03-26T00:00:00Z", "2026-03-29T23:59:59Z",
    JSON.stringify(["Great Hall South", "Performance Theatre", "Room 2301"]),
    SCHEDULE_DID, VOD_DID
  );

  // Collect unique speakers
  const speakerMap = new Map<string, { name: string; handle: string }>();
  for (const m of matches) {
    for (const s of m.schedule.speakers) {
      if (!speakerMap.has(s.id)) {
        speakerMap.set(s.id, { name: s.name, handle: s.id });
      }
    }
  }

  const insertSpeaker = db.prepare(
    `INSERT OR REPLACE INTO speakers (uri, did, rkey, name, handle) VALUES (?, ?, ?, ?, ?)`
  );
  for (const [handle, speaker] of speakerMap) {
    const rkey = slugify(handle);
    const uri = `at://${IONOSPHERE_DID}/tv.ionosphere.speaker/${rkey}`;
    insertSpeaker.run(uri, IONOSPHERE_DID, rkey, speaker.name, speaker.handle);
  }
  console.log(`  ${speakerMap.size} speakers`);

  const insertTalk = db.prepare(
    `INSERT OR REPLACE INTO talks (uri, did, rkey, title, description, video_uri, schedule_uri, event_uri, room, category, talk_type, starts_at, ends_at, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertTalkSpeaker = db.prepare(
    `INSERT OR REPLACE INTO talk_speakers (talk_uri, speaker_uri) VALUES (?, ?)`
  );
  const insertPipelineStatus = db.prepare(
    `INSERT OR REPLACE INTO pipeline_status (talk_uri, ingested) VALUES (?, 1)`
  );

  for (const m of matches) {
    const rkey = m.schedule.uri.split("/").pop()!;
    const talkUri = `at://${IONOSPHERE_DID}/tv.ionosphere.talk/${rkey}`;

    insertTalk.run(
      talkUri, IONOSPHERE_DID, rkey, m.schedule.name, m.schedule.description,
      m.vod.uri, m.schedule.uri, EVENT_URI, m.schedule.room,
      m.schedule.category, m.schedule.type, m.schedule.startsAt,
      m.schedule.endsAt, m.vod.duration
    );

    for (const s of m.schedule.speakers) {
      const speakerRkey = slugify(s.id);
      const speakerUri = `at://${IONOSPHERE_DID}/tv.ionosphere.speaker/${speakerRkey}`;
      insertTalkSpeaker.run(talkUri, speakerUri);
    }

    insertPipelineStatus.run(talkUri);
  }

  console.log(`\nIngested ${matches.length} talks into database.`);

  const unmatchedSchedule = schedule.filter(
    (s) => !matches.some((m) => m.schedule.uri === s.uri)
  );
  if (unmatchedSchedule.length > 0) {
    console.log(`\nUnmatched schedule events (${unmatchedSchedule.length}):`);
    for (const s of unmatchedSchedule) {
      console.log(`  - ${s.name} (${s.type})`);
    }
  }

  db.close();
}

main().catch(console.error);
