/**
 * Track data for full-day conference streams.
 *
 * Provides stream configs, diarization loading, and talk-to-stream
 * offset mapping for the track timeline view.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

const VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";
const DATA_DIR = path.resolve(import.meta.dirname, "../data/fullday");

export interface StreamConfig {
  slug: string;
  name: string;
  room: string;
  day: number;
  dayLabel: string;
  uri: string;
  dirName: string;
  durationSeconds: number;
}

export const STREAMS: StreamConfig[] = [
  { slug: "great-hall-day-1", name: "Great Hall - Saturday", room: "Great Hall South", day: 1, dayLabel: "Saturday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadw52j22", dirName: "Great_Hall___Day_1", durationSeconds: 28433 },
  { slug: "great-hall-day-2", name: "Great Hall - Sunday", room: "Great Hall South", day: 2, dayLabel: "Sunday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miighlz53o22", dirName: "Great_Hall___Day_2", durationSeconds: 28433 },
  { slug: "room-2301-day-1", name: "Room 2301 - Saturday", room: "Room 2301", day: 1, dayLabel: "Saturday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadx2dj22", dirName: "Room_2301___Day_1", durationSeconds: 27400 },
  { slug: "room-2301-day-2", name: "Room 2301 - Sunday", room: "Room 2301", day: 2, dayLabel: "Sunday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadxeqn22", dirName: "Room_2301___Day_2", durationSeconds: 27000 },
  { slug: "performance-theatre-day-1", name: "Performance Theatre - Saturday", room: "Performance Theatre", day: 1, dayLabel: "Saturday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwgvz22", dirName: "Performance_Theater___Day_1", durationSeconds: 24500 },
  { slug: "performance-theatre-day-2", name: "Performance Theatre - Sunday", room: "Performance Theatre", day: 2, dayLabel: "Sunday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwqgy22", dirName: "Performance_Theater___Day_2", durationSeconds: 27300 },
  { slug: "atscience", name: "ATScience - Friday", room: "ATScience", day: 1, dayLabel: "Friday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadvruo22", dirName: "ATScience", durationSeconds: 29675 },
];

const PDT_DATES: Record<number, string> = { 1: "2026-03-28", 2: "2026-03-29" };
const ATSCIENCE_DATE = "2026-03-27";

function playbackUrl(uri: string): string {
  return `${VOD_ENDPOINT}?uri=${encodeURIComponent(uri)}`;
}

function loadDiarization(dirName: string): any[] {
  const diaPath = path.join(DATA_DIR, dirName, "diarization.json");
  if (!existsSync(diaPath)) return [];
  const data = JSON.parse(readFileSync(diaPath, "utf-8"));
  return data.segments || [];
}

const transcriptCache = new Map<string, { text: string; facets: any[] }>();

function loadTranscript(dirName: string): { text: string; facets: any[] } | null {
  if (transcriptCache.has(dirName)) return transcriptCache.get(dirName)!;

  const txPath = path.join(DATA_DIR, dirName, "transcript-enriched.json");
  if (!existsSync(txPath)) return null;
  const data = JSON.parse(readFileSync(txPath, "utf-8"));
  const words: any[] = data.words || [];
  if (words.length === 0) return null;

  // Build text and compute byte offsets in a single pass
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

  const result = { text, facets };
  transcriptCache.set(dirName, result);
  return result;
}

function loadWords(dirName: string): Array<{ start: number; end: number; speaker: string }> {
  const txPath = path.join(DATA_DIR, dirName, "transcript-enriched.json");
  if (!existsSync(txPath)) return [];
  const data = JSON.parse(readFileSync(txPath, "utf-8"));
  return (data.words || []).map((w: any) => ({
    start: w.start,
    end: w.end,
    speaker: w.speaker,
  }));
}

export function getTracksIndex(db: Database.Database) {
  return STREAMS.map((s) => {
    // Count talks that have a fullday segment for this stream
    const talks = db.prepare(
      `SELECT COUNT(*) as cnt FROM talks
       WHERE video_segments LIKE ?`
    ).get(`%${s.uri}%`) as { cnt: number };

    return {
      slug: s.slug,
      name: s.name,
      room: s.room,
      dayLabel: s.dayLabel,
      durationSeconds: s.durationSeconds,
      talkCount: talks.cnt,
      playbackUrl: playbackUrl(s.uri),
    };
  });
}

export function getTrackData(db: Database.Database, slug: string) {
  const stream = STREAMS.find((s) => s.slug === slug);
  if (!stream) return null;

  // Get all talks that have a fullday segment for this stream URI
  const allTalks = db.prepare(
    `SELECT t.rkey, t.title, t.video_segments, t.starts_at,
            GROUP_CONCAT(s.name) as speaker_names
     FROM talks t
     LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
     LEFT JOIN speakers s ON ts.speaker_uri = s.uri
     WHERE t.video_segments LIKE ?
     GROUP BY t.uri
     ORDER BY t.starts_at ASC`
  ).all(`%${stream.uri}%`) as any[];

  // Extract the offset for this specific stream from video_segments
  const talks = allTalks.map((t) => {
    const segments = JSON.parse(t.video_segments || "[]");
    const fulldaySeg = segments.find(
      (seg: any) => seg.type === "fullday" && seg.uri === stream.uri
    );
    if (!fulldaySeg) return null;

    const startSeconds = fulldaySeg.offsetNs / 1e9;
    const endSeconds = fulldaySeg.endOffsetNs ? fulldaySeg.endOffsetNs / 1e9 : null;

    return {
      rkey: t.rkey,
      title: t.title,
      speakers: t.speaker_names ? t.speaker_names.split(",").map((n: string) => n.trim()) : [],
      startSeconds,
      endSeconds,
      confidence: fulldaySeg.confidence || "medium",
    };
  }).filter(Boolean).sort((a: any, b: any) => a.startSeconds - b.startSeconds);

  // Fill in end times from the next talk's start time where missing
  for (let i = 0; i < talks.length; i++) {
    if (!talks[i]!.endSeconds && i < talks.length - 1) {
      talks[i]!.endSeconds = talks[i + 1]!.startSeconds;
    }
  }

  const diarization = loadDiarization(stream.dirName);
  const transcript = loadTranscript(stream.dirName);
  const words = loadWords(stream.dirName);

  return {
    slug: stream.slug,
    name: stream.name,
    room: stream.room,
    dayLabel: stream.dayLabel,
    streamUri: stream.uri,
    durationSeconds: stream.durationSeconds,
    playbackUrl: playbackUrl(stream.uri),
    talks,
    diarization,
    transcript,
    words,
  };
}
