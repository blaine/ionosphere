/**
 * Track data for full-day conference streams.
 *
 * Reads stream metadata, transcripts, and diarization from the DB
 * (indexed from AT Protocol records). Falls back to local files
 * for local dev where records may not be published yet.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

const VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";
const DATA_DIR = path.resolve(import.meta.dirname, "../data/fullday");

// Hardcoded stream configs — used as fallback when no stream records in DB
export interface StreamConfig {
  slug: string;
  name: string;
  room: string;
  dayLabel: string;
  uri: string;
  dirName: string;
  durationSeconds: number;
}

export const STREAMS: StreamConfig[] = [
  { slug: "great-hall-day-1", name: "Great Hall - Saturday", room: "Great Hall South", dayLabel: "Saturday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadw52j22", dirName: "Great_Hall___Day_1", durationSeconds: 28433 },
  { slug: "great-hall-day-2", name: "Great Hall - Sunday", room: "Great Hall South", dayLabel: "Sunday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miighlz53o22", dirName: "Great_Hall___Day_2", durationSeconds: 28433 },
  { slug: "room-2301-day-1", name: "Room 2301 - Saturday", room: "Room 2301", dayLabel: "Saturday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadx2dj22", dirName: "Room_2301___Day_1", durationSeconds: 27400 },
  { slug: "room-2301-day-2", name: "Room 2301 - Sunday", room: "Room 2301", dayLabel: "Sunday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadxeqn22", dirName: "Room_2301___Day_2", durationSeconds: 27000 },
  { slug: "performance-theatre-day-1", name: "Performance Theatre - Saturday", room: "Performance Theatre", dayLabel: "Saturday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwgvz22", dirName: "Performance_Theater___Day_1", durationSeconds: 24500 },
  { slug: "performance-theatre-day-2", name: "Performance Theatre - Sunday", room: "Performance Theatre", dayLabel: "Sunday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwqgy22", dirName: "Performance_Theater___Day_2", durationSeconds: 27300 },
  { slug: "atscience", name: "ATScience - Friday", room: "ATScience", dayLabel: "Friday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadvruo22", dirName: "ATScience", durationSeconds: 29675 },
];

function playbackUrl(uri: string): string {
  return `${VOD_ENDPOINT}?uri=${encodeURIComponent(uri)}`;
}

// --- DB-based data loading ---

function getStreamFromDb(db: Database.Database, slug: string): any | null {
  return db.prepare("SELECT * FROM streams WHERE slug = ?").get(slug) as any;
}

function getStreamsFromDb(db: Database.Database): any[] {
  return db.prepare("SELECT * FROM streams ORDER BY day_label, name").all() as any[];
}

/** Decode chunked stream transcripts from DB, reassembling into a single document. */
function decodeChunkedTranscript(chunks: any[]): { text: string; facets: any[]; words: Array<{ start: number; end: number; speaker: string }> } {
  const facets: any[] = [];
  const words: Array<{ start: number; end: number; speaker: string }> = [];
  let fullText = "";
  let byteOffset = 0;

  for (const chunk of chunks) {
    const timings: number[] = JSON.parse(chunk.timings);
    const chunkWords = chunk.text.split(" ");
    let timeMs = 0;

    for (let i = 0; i < chunkWords.length; i++) {
      if (!chunkWords[i]) continue;
      const wordText = chunkWords[i] + " ";
      const byteStart = byteOffset;
      const wordBytes = Buffer.byteLength(wordText, "utf-8");
      byteOffset += wordBytes;
      fullText += wordText;

      const gap = timings[i * 2] || 0;
      const dur = timings[i * 2 + 1] || 0;
      timeMs += gap;
      const startMs = timeMs;
      timeMs += dur;
      const endMs = timeMs;

      facets.push({
        index: { byteStart, byteEnd: byteOffset },
        features: [{
          $type: "tv.ionosphere.facet#timestamp",
          startTime: Math.round(startMs * 1e6),
          endTime: Math.round(endMs * 1e6),
        }],
      });

      words.push({ start: startMs / 1000, end: endMs / 1000, speaker: "" });
    }
  }

  return { text: fullText, facets, words };
}

function getStreamTranscriptFromDb(db: Database.Database, streamUri: string): { text: string; facets: any[] } | null {
  const chunks = db.prepare(
    "SELECT * FROM stream_transcripts WHERE stream_uri = ? ORDER BY chunk_index ASC"
  ).all(streamUri) as any[];
  if (chunks.length === 0) return null;
  const { text, facets } = decodeChunkedTranscript(chunks);
  return { text, facets };
}

function getStreamWordsFromDb(db: Database.Database, streamUri: string): Array<{ start: number; end: number; speaker: string }> {
  const chunks = db.prepare(
    "SELECT * FROM stream_transcripts WHERE stream_uri = ? ORDER BY chunk_index ASC"
  ).all(streamUri) as any[];
  if (chunks.length === 0) return [];
  return decodeChunkedTranscript(chunks).words;
}

function getDiarizationFromDb(db: Database.Database, streamUri: string): any[] {
  const chunks = db.prepare(
    "SELECT * FROM stream_diarizations WHERE stream_uri = ? ORDER BY chunk_index ASC"
  ).all(streamUri) as any[];
  if (chunks.length === 0) return [];
  const segments: any[] = [];
  for (const chunk of chunks) {
    const raw = JSON.parse(chunk.segments);
    // Convert from integer ms (AT Protocol format) to float seconds (internal format)
    for (const seg of raw) {
      segments.push({
        start: (seg.startMs ?? seg.start * 1000) / 1000,
        end: (seg.endMs ?? seg.end * 1000) / 1000,
        speaker: seg.speaker,
      });
    }
  }
  return segments;
}

// --- Local file fallback ---

function loadDiarizationFromFile(dirName: string): any[] {
  const diaPath = path.join(DATA_DIR, dirName, "diarization.json");
  if (!existsSync(diaPath)) return [];
  const data = JSON.parse(readFileSync(diaPath, "utf-8"));
  return data.segments || [];
}

function loadTranscriptFromFile(dirName: string): { text: string; facets: any[] } | null {
  const txPath = path.join(DATA_DIR, dirName, "transcript-enriched.json");
  if (!existsSync(txPath)) return null;
  const data = JSON.parse(readFileSync(txPath, "utf-8"));
  const words: any[] = data.words || [];
  if (words.length === 0) return null;

  const facets: any[] = [];
  let text = "";
  let byteOffset = 0;

  for (const w of words) {
    const wordText = w.word + " ";
    const byteStart = byteOffset;
    const wordBytes = Buffer.byteLength(wordText, "utf-8");
    byteOffset += wordBytes;
    text += wordText;
    facets.push({
      index: { byteStart, byteEnd: byteOffset },
      features: [{
        $type: "tv.ionosphere.facet#timestamp",
        startTime: Math.round(w.start * 1e9),
        endTime: Math.round(w.end * 1e9),
      }],
    });
  }

  return { text, facets };
}

function loadWordsFromFile(dirName: string): Array<{ start: number; end: number; speaker: string }> {
  const txPath = path.join(DATA_DIR, dirName, "transcript-enriched.json");
  if (!existsSync(txPath)) return [];
  const data = JSON.parse(readFileSync(txPath, "utf-8"));
  return (data.words || []).map((w: any) => ({ start: w.start, end: w.end, speaker: w.speaker }));
}

// --- Room + day matching ---
// The schedule data uses room names that don't always match the stream names.
// ATScience (Friday) used multiple rooms but was one stream.

const DAY_DATES: Record<string, string> = {
  "Friday": "2026-03-27",
  "Saturday": "2026-03-28",
  "Sunday": "2026-03-29",
};

// Stream-to-talk matching: room + date, or rkey prefix for ATScience
const STREAM_MATCH: Record<string, { rooms?: string[]; rkeyPrefix?: string }> = {
  "great-hall-day-1": { rooms: ["Great Hall South"] },
  "great-hall-day-2": { rooms: ["Great Hall South"] },
  "room-2301-day-1": { rooms: ["Room 2301"] },
  "room-2301-day-2": { rooms: ["Room 2301"] },
  "performance-theatre-day-1": { rooms: ["Performance Theatre"] },
  "performance-theatre-day-2": { rooms: ["Performance Theatre"] },
  "atscience": { rkeyPrefix: "ats26-" },
};

function getTalksForStream(db: Database.Database, slug: string, dayLabel: string): any[] {
  const match = STREAM_MATCH[slug];
  if (!match) return [];

  // ATScience: match by rkey prefix (spans multiple rooms on Friday)
  if (match.rkeyPrefix) {
    return db.prepare(
      `SELECT t.rkey, t.title, t.starts_at, t.ends_at, t.duration,
              GROUP_CONCAT(s.name) as speaker_names
       FROM talks t
       LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
       LEFT JOIN speakers s ON ts.speaker_uri = s.uri
       WHERE t.rkey LIKE ?
       GROUP BY t.rkey
       ORDER BY t.starts_at ASC`
    ).all(`${match.rkeyPrefix}%`) as any[];
  }

  // Other streams: match by room + date
  const date = DAY_DATES[dayLabel];
  if (!date || !match.rooms?.length) return [];

  const placeholders = match.rooms.map(() => "?").join(",");
  return db.prepare(
    `SELECT t.rkey, t.title, t.starts_at, t.ends_at, t.duration,
            GROUP_CONCAT(s.name) as speaker_names
     FROM talks t
     LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
     LEFT JOIN speakers s ON ts.speaker_uri = s.uri
     WHERE t.room IN (${placeholders}) AND t.starts_at LIKE ?
     GROUP BY t.rkey
     ORDER BY t.starts_at ASC`
  ).all(...match.rooms, `${date}%`) as any[];
}

// --- Public API ---

export function getTracksIndex(db: Database.Database) {
  const dbStreams = getStreamsFromDb(db);
  const streamConfigs = dbStreams.length > 0
    ? dbStreams.map((s: any) => ({ slug: s.slug, name: s.name, room: s.room, dayLabel: s.day_label, uri: s.stream_video_uri, durationSeconds: s.duration_seconds }))
    : STREAMS.map((s) => ({ slug: s.slug, name: s.name, room: s.room, dayLabel: s.dayLabel, uri: s.uri, durationSeconds: s.durationSeconds }));

  return streamConfigs.map((s) => {
    const talks = getTalksForStream(db, s.slug, s.dayLabel);
    return {
      slug: s.slug,
      name: s.name,
      room: s.room,
      dayLabel: s.dayLabel,
      durationSeconds: s.durationSeconds,
      talkCount: talks.length,
      playbackUrl: playbackUrl(s.uri),
    };
  });
}

export function getTrackData(db: Database.Database, slug: string) {
  const dbStream = getStreamFromDb(db, slug);
  const hardcoded = STREAMS.find((s) => s.slug === slug);

  const streamUri = dbStream?.stream_video_uri ?? hardcoded?.uri;
  if (!streamUri) return null;

  const name = dbStream?.name ?? hardcoded?.name ?? slug;
  const room = dbStream?.room ?? hardcoded?.room ?? "";
  const dayLabel = dbStream?.day_label ?? hardcoded?.dayLabel ?? "";
  const durationSeconds = dbStream?.duration_seconds ?? hardcoded?.durationSeconds ?? 0;

  // Try to get talks with precise video_segments offsets first
  const segmentTalks = db.prepare(
    `SELECT t.rkey, t.title, t.video_segments, t.starts_at, t.ends_at,
            GROUP_CONCAT(s.name) as speaker_names
     FROM talks t
     LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
     LEFT JOIN speakers s ON ts.speaker_uri = s.uri
     WHERE t.video_segments LIKE ?
     GROUP BY t.uri
     ORDER BY t.starts_at ASC`
  ).all(`%${streamUri}%`) as any[];

  let talks: any[];

  if (segmentTalks.length > 0) {
    // Use precise boundary-detected offsets from video_segments
    talks = segmentTalks.map((t) => {
      const segments = JSON.parse(t.video_segments || "[]");
      const fulldaySeg = segments.find(
        (seg: any) => seg.type === "fullday" && seg.uri === streamUri
      );
      if (!fulldaySeg) return null;
      return {
        rkey: t.rkey,
        title: t.title,
        speakers: t.speaker_names ? t.speaker_names.split(",").map((n: string) => n.trim()) : [],
        startSeconds: fulldaySeg.offsetNs / 1e9,
        endSeconds: fulldaySeg.endOffsetNs ? fulldaySeg.endOffsetNs / 1e9 : null,
        confidence: fulldaySeg.confidence || "high",
      };
    }).filter(Boolean).sort((a: any, b: any) => a.startSeconds - b.startSeconds);
  } else {
    // Fallback: use scheduled times with approximate offsets
    const rawTalks = getTalksForStream(db, slug, dayLabel);
    const streamDate = DAY_DATES[dayLabel];
    const dayStart = new Date(`${streamDate}T16:00:00Z`);
    talks = rawTalks.map((t) => {
      const talkStart = new Date(t.starts_at);
      const talkEnd = t.ends_at ? new Date(t.ends_at) : null;
      return {
        rkey: t.rkey,
        title: t.title,
        speakers: t.speaker_names ? t.speaker_names.split(",").map((n: string) => n.trim()) : [],
        startSeconds: Math.max(0, (talkStart.getTime() - dayStart.getTime()) / 1000),
        endSeconds: talkEnd ? (talkEnd.getTime() - dayStart.getTime()) / 1000 : null,
        confidence: "medium",
      };
    }).sort((a: any, b: any) => a.startSeconds - b.startSeconds);
  }

  // Fill in end times from the next talk's start where missing
  for (let i = 0; i < talks.length; i++) {
    if (!talks[i].endSeconds && i < talks.length - 1) {
      talks[i].endSeconds = talks[i + 1].startSeconds;
    }
  }

  // Load data: DB first, then local files
  const diarization = getDiarizationFromDb(db, `at://${dbStream?.did ?? ""}/${dbStream ? "tv.ionosphere.stream/" + slug : ""}`)
    || (hardcoded ? loadDiarizationFromFile(hardcoded.dirName) : []);

  const streamRecordUri = dbStream ? `at://${dbStream.did}/tv.ionosphere.stream/${slug}` : "";
  const transcript = getStreamTranscriptFromDb(db, streamRecordUri)
    ?? (hardcoded ? loadTranscriptFromFile(hardcoded.dirName) : null);
  const words = getStreamWordsFromDb(db, streamRecordUri).length > 0
    ? getStreamWordsFromDb(db, streamRecordUri)
    : (hardcoded ? loadWordsFromFile(hardcoded.dirName) : []);

  return {
    slug,
    name,
    room,
    dayLabel,
    streamUri,
    durationSeconds,
    playbackUrl: playbackUrl(streamUri),
    talks,
    diarization,
    transcript,
    words,
  };
}
