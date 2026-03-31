/**
 * Fix video alignment by finding the correct VOD for each talk.
 *
 * Strategy: for each talk, find the VOD from the same room/creator
 * whose recording window covers the talk's scheduled start time.
 * Compute the offset within that VOD. If the talk already has a
 * good match (duration ratio 0.5-2x), leave it alone.
 */
import { openDb, migrate } from "./db.js";

const PDS_URL = "https://iameli.com";
const VOD_DID = "did:plc:rbvrr34edl5ddpuwcubjiost";

const CREATOR_ROOMS: Record<string, string> = {
  "did:plc:7tattzlorncahxgtdiuci7x7": "Great Hall South",
  "did:plc:djb6ssvz5wvuuqpdihlgh3xa": "Performance Theatre",
  "did:plc:jcahd7fl7h23c24ftxuhkhiw": "Room 2301",
};

// Day 2 (March 27) was science track — all in one room via GHS creator
// even though schedule says "Performance Theatre" for some
const ROOM_ALIASES: Record<string, string[]> = {
  "Performance Theatre": ["Performance Theatre", "Great Hall South"],
  "Great Hall South": ["Great Hall South"],
  "Room 2301": ["Room 2301"],
  "Bukhman Lounge": ["Bukhman Lounge"], // no stream
  "2301 Classroom": ["Room 2301"],
  "2311 Classroom": [],
};

interface VodInfo {
  uri: string;
  title: string;
  creator: string;
  room: string;
  durationNs: number;
  startTime: Date;
  endTime: Date;
}

async function fetchAllVods(): Promise<VodInfo[]> {
  const records: any[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      repo: VOD_DID,
      collection: "place.stream.video",
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(
      `${PDS_URL}/xrpc/com.atproto.repo.listRecords?${params}`
    );
    const data = await res.json();
    records.push(...data.records);
    cursor = data.cursor;
  } while (cursor);

  return records.map((r) => {
    const v = r.value;
    const endTime = new Date(v.createdAt);
    const startTime = new Date(endTime.getTime() - v.duration / 1e6);
    return {
      uri: r.uri,
      title: v.title,
      creator: v.creator,
      room: CREATOR_ROOMS[v.creator] || "unknown",
      durationNs: v.duration,
      startTime,
      endTime,
    };
  });
}

async function main() {
  const db = openDb();
  migrate(db);

  try {
    db.exec(
      "ALTER TABLE talks ADD COLUMN video_offset_ns INTEGER DEFAULT 0"
    );
  } catch {}

  console.log("Fetching VOD records...");
  const vods = await fetchAllVods();
  console.log(`  ${vods.length} VODs\n`);

  const talks = db
    .prepare(
      `SELECT rkey, title, room, starts_at, ends_at, video_uri, duration
       FROM talks ORDER BY starts_at`
    )
    .all() as Array<{
    rkey: string;
    title: string;
    room: string;
    starts_at: string;
    ends_at: string;
    video_uri: string;
    duration: number;
  }>;

  const update = db.prepare(
    "UPDATE talks SET video_uri = ?, duration = ?, video_offset_ns = ? WHERE rkey = ?"
  );

  let fixed = 0;
  let noRecording = 0;
  let alreadyGood = 0;

  for (const talk of talks) {
    const schedStart = new Date(talk.starts_at);
    const schedEnd = new Date(talk.ends_at);
    const schedDurMin =
      (schedEnd.getTime() - schedStart.getTime()) / 1000 / 60;
    const vidDurMin = talk.duration / 1e9 / 60;
    const ratio = schedDurMin > 0 ? vidDurMin / schedDurMin : 1;

    // If current VOD is reasonable (30%-200% of scheduled), leave it
    if (ratio >= 0.5 && ratio <= 2.0) {
      alreadyGood++;
      continue;
    }

    // Find VODs that cover this talk's scheduled start time
    // Check all rooms that might apply (Day 2 science track was flexible)
    const possibleRooms = ROOM_ALIASES[talk.room] || [talk.room];
    const candidates = vods.filter(
      (v) =>
        possibleRooms.includes(v.room) &&
        v.startTime <= schedStart &&
        v.endTime >= schedStart
    );

    if (candidates.length === 0) {
      // Also try: any VOD from any creator that covers this time
      // (Day 2 had all streams in GHS)
      const anyCandidates = vods.filter(
        (v) => v.startTime <= schedStart && v.endTime >= schedStart
      );

      if (anyCandidates.length > 0) {
        // Pick the longest one
        const best = anyCandidates.sort(
          (a, b) => b.durationNs - a.durationNs
        )[0];
        const offsetMs =
          schedStart.getTime() - best.startTime.getTime();
        const offsetNs = Math.round(offsetMs * 1e6);

        console.log(
          `FIXED (any room): ${talk.title}`
        );
        console.log(
          `  → "${best.title}" at ${(offsetMs / 1000 / 60).toFixed(1)} min offset`
        );
        update.run(best.uri, best.durationNs, offsetNs, talk.rkey);
        fixed++;
      } else {
        console.log(`NO RECORDING: ${talk.title} (${talk.room})`);
        noRecording++;
      }
      continue;
    }

    // Pick the best candidate — prefer longest VOD that covers the whole talk
    const best = candidates.sort(
      (a, b) => b.durationNs - a.durationNs
    )[0];
    const offsetMs = schedStart.getTime() - best.startTime.getTime();
    const offsetNs = Math.round(offsetMs * 1e6);

    // Sanity check: offset should be positive and less than VOD duration
    if (offsetNs < 0 || offsetNs > best.durationNs) {
      console.log(
        `BAD OFFSET: ${talk.title} — ${(offsetMs / 1000 / 60).toFixed(1)} min into ${(best.durationNs / 1e9 / 60).toFixed(0)} min VOD`
      );
      continue;
    }

    console.log(`FIXED: ${talk.title}`);
    console.log(
      `  → "${best.title}" at ${(offsetMs / 1000 / 60).toFixed(1)} min offset (${(best.durationNs / 1e9 / 60).toFixed(0)} min VOD)`
    );
    update.run(best.uri, best.durationNs, offsetNs, talk.rkey);
    fixed++;
  }

  console.log(
    `\n${alreadyGood} already good, ${fixed} fixed, ${noRecording} no recording`
  );
  db.close();
}

main().catch(console.error);
