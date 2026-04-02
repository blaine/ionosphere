import { openDb, migrate } from "./db.js";
import { correlate, type ScheduleEvent, type VodRecord } from "./correlate.js";
import { loadLens, applyLens, init as initPanproto, createPipeline } from "@ionosphere/format/lenses";
import type { ProtolensChainHandle } from "@ionosphere/format/lenses";
import { resolveLensRecord } from "./lens-resolver.js";

const scheduleLens = loadLens("schedule-to-talk.lens.json");

/**
 * Build a native panproto pipeline for the schedule-to-talk transform.
 * Returns null if WASM is not available.
 *
 * Uses the PipelineBuilder combinator API (@panproto/core@0.23+):
 *   renameField — rename JSON property keys
 *   hoistField — unnest fields from intermediate objects
 */
async function buildSchedulePipeline(): Promise<ProtolensChainHandle | null> {
  try {
    const pp = await initPanproto();
    const parent = "community.lexicon.calendar.event:body";
    const ad = `${parent}.additionalData`;

    return createPipeline(pp)
      .renameField(parent, "name", "title")
      .hoistField(parent, ad, "room")
      .hoistField(parent, ad, "category")
      .hoistField(parent, ad, "type")
      .renameField(parent, "type", "talkType")
      .hoistField(parent, ad, "speakers")
      .build();
  } catch {
    // WASM not available — fall back to JS applyLens
    return null;
  }
}

const SCHEDULE_DID = "did:plc:3xewinw4wtimo2lqfy5fm5sw";
const SCHEDULE_COLLECTION = "community.lexicon.calendar.event";
const VOD_DID = "did:plc:rbvrr34edl5ddpuwcubjiost";
const VOD_COLLECTION = "place.stream.video";
const VOD_PDS = "https://iameli.com";
const BSKY_API = "https://bsky.social";

const IONOSPHERE_DID = "did:plc:ionosphere-placeholder";
const EVENT_URI = `at://${IONOSPHERE_DID}/tv.ionosphere.event/atmosphereconf-2026`;

async function fetchAllRecords(
  baseUrl: string,
  repo: string,
  collection: string
): Promise<any[]> {
  const records: any[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ repo, collection, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(
      `${baseUrl}/xrpc/com.atproto.repo.listRecords?${params}`
    );
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
    const data = await res.json();
    records.push(...data.records);
    cursor = data.cursor;
  } while (cursor);

  return records;
}

function parseScheduleEvent(record: any, lens: any): ScheduleEvent | null {
  const v = record.value;
  const ad = v.additionalData;
  if (!ad?.isAtmosphereconf) return null;
  if (v.status === "community.lexicon.calendar.event#cancelled") return null;
  const type = ad?.type || "";
  if (["info", "food"].includes(type)) return null;

  const mapped = applyLens(lens, v);

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
  const v = record.value;
  const endTime = new Date(v.createdAt);
  const startTime = new Date(endTime.getTime() - v.duration / 1e6);
  return {
    uri: record.uri,
    title: v.title,
    creator: v.creator,
    duration: v.duration,
    createdAt: v.createdAt,
    startTime,
    endTime,
    room: "",
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function main() {
  // Try to build native panproto pipeline (WASM-backed, bidirectional)
  const schedulePipeline = await buildSchedulePipeline();
  if (schedulePipeline) {
    console.log("Using panproto PipelineBuilder for schedule-to-talk transform");
  }

  // Fall back to JSON lens spec (JS-only applyLens) if WASM is not available
  let scheduleLensResolved;
  try {
    const resolved = await resolveLensRecord("community.lexicon.calendar.event", "tv.ionosphere.talk");
    if (resolved?.chainJson) scheduleLensResolved = JSON.parse(resolved.chainJson);
  } catch {}
  const effectiveLens = scheduleLensResolved ?? scheduleLens;

  console.log("Fetching schedule events...");
  const scheduleRaw = await fetchAllRecords(
    BSKY_API,
    SCHEDULE_DID,
    SCHEDULE_COLLECTION
  );
  const schedule = scheduleRaw
    .map((r) => parseScheduleEvent(r, effectiveLens))
    .filter((e): e is ScheduleEvent => e !== null);
  console.log(
    `  ${schedule.length} schedule events (filtered from ${scheduleRaw.length})`
  );

  console.log("Fetching VOD records...");
  const vodRaw = await fetchAllRecords(VOD_PDS, VOD_DID, VOD_COLLECTION);
  const vods = vodRaw.map(parseVodRecord);
  console.log(`  ${vods.length} VOD records`);

  console.log("Correlating (title + time-window matching)...");
  const matches = correlate(schedule, vods);

  const withVideo = matches.filter((m) => m.primaryVideo);
  const noVideo = matches.filter((m) => !m.primaryVideo);
  const titleMatches = matches.filter((m) => m.method === "title");
  const timeMatches = matches.filter((m) => m.method === "time-window");
  console.log(
    `  ${matches.length} talks: ${titleMatches.length} title-matched, ${timeMatches.length} time-window, ${noVideo.length} no recording`
  );

  const db = openDb();
  migrate(db);

  // Ensure video_offset_ns and video_segments columns exist
  try {
    db.exec(
      "ALTER TABLE talks ADD COLUMN video_offset_ns INTEGER DEFAULT 0"
    );
  } catch {}
  try {
    db.exec("ALTER TABLE talks ADD COLUMN video_segments TEXT"); // JSON
  } catch {}

  // Insert event
  db.prepare(
    `INSERT OR REPLACE INTO events (uri, did, rkey, name, description, location, starts_at, ends_at, tracks, schedule_repo, vod_repo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    EVENT_URI,
    IONOSPHERE_DID,
    "atmosphereconf-2026",
    "ATmosphereConf 2026",
    "The global gathering for the AT Protocol community.",
    "AMS Student Nest, UBC, Vancouver, BC, Canada",
    "2026-03-26T00:00:00Z",
    "2026-03-29T23:59:59Z",
    JSON.stringify([
      "Great Hall South",
      "Performance Theatre",
      "Room 2301",
    ]),
    SCHEDULE_DID,
    VOD_DID
  );

  // Collect unique speakers from ALL talks (not just matched)
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
    insertSpeaker.run(
      uri,
      IONOSPHERE_DID,
      rkey,
      speaker.name,
      speaker.handle
    );
  }
  console.log(`  ${speakerMap.size} speakers`);

  // Insert talks
  const insertTalk = db.prepare(
    `INSERT OR REPLACE INTO talks
     (uri, did, rkey, title, description, video_uri, video_offset_ns, video_segments, schedule_uri, event_uri, room, category, talk_type, starts_at, ends_at, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

    const primary = m.primaryVideo;

    insertTalk.run(
      talkUri,
      IONOSPHERE_DID,
      rkey,
      m.schedule.name,
      m.schedule.description,
      primary?.vodUri || null,
      primary?.offsetNs || 0,
      m.allSegments.length > 0
        ? JSON.stringify(m.allSegments)
        : null,
      m.schedule.uri,
      EVENT_URI,
      m.schedule.room,
      m.schedule.category,
      m.schedule.type,
      m.schedule.startsAt,
      m.schedule.endsAt,
      primary
        ? Math.round(primary.coverageMs * 1e6)
        : 0
    );

    for (const s of m.schedule.speakers) {
      const speakerRkey = slugify(s.id);
      const speakerUri = `at://${IONOSPHERE_DID}/tv.ionosphere.speaker/${speakerRkey}`;
      insertTalkSpeaker.run(talkUri, speakerUri);
    }

    insertPipelineStatus.run(talkUri);
  }

  console.log(`\nIngested ${matches.length} talks into database.`);
  console.log(
    `  ${withVideo.length} with video, ${noVideo.length} without`
  );

  if (noVideo.length > 0) {
    console.log(`\nTalks with no recording:`);
    for (const m of noVideo) {
      console.log(`  - ${m.schedule.name} (${m.schedule.room})`);
    }
  }

  // Show time-window matches for review
  if (timeMatches.length > 0) {
    console.log(`\nTime-window matched talks (verify these):`);
    for (const m of timeMatches) {
      if (m.primaryVideo) {
        console.log(
          `  ${m.schedule.name} → "${m.primaryVideo.vodTitle}" at ${(m.primaryVideo.offsetNs / 1e9 / 60).toFixed(1)} min`
        );
      }
    }
  }

  db.close();
}

main().catch(console.error);
