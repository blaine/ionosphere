export interface ScheduleEvent {
  uri: string;
  name: string;
  startsAt: string;
  endsAt: string;
  type: string;
  room: string;
  category: string;
  speakers: Array<{ id: string; name: string }>;
  description: string;
}

export interface VodRecord {
  uri: string;
  title: string;
  creator: string;
  duration: number; // nanoseconds
  createdAt: string;
  // Computed fields
  startTime: Date; // createdAt - duration
  endTime: Date; // createdAt
  room: string; // from creator mapping
}

export interface VideoSegment {
  vodUri: string;
  vodTitle: string;
  offsetNs: number; // offset into this VOD where the talk starts
  coverageMs: number; // how much of the talk this segment covers
}

export interface Match {
  schedule: ScheduleEvent;
  primaryVideo: VideoSegment | null; // best single segment
  allSegments: VideoSegment[]; // all VODs that cover part of this talk
  confidence: number;
  method: "title" | "time-window" | "none";
}

// Creator DID → room mapping (ATmosphereConf 2026 specific)
const CREATOR_ROOMS: Record<string, string> = {
  "did:plc:7tattzlorncahxgtdiuci7x7": "Great Hall South",
  "did:plc:djb6ssvz5wvuuqpdihlgh3xa": "Performance Theatre",
  "did:plc:jcahd7fl7h23c24ftxuhkhiw": "Room 2301",
};

const NOISE_TITLES = new Set([
  "lunch",
  "lunch break",
  "break",
  "doors open",
  "starting soon",
  "join us tomorrow",
  "lunch day",
  "breakfast",
  "coffee break",
  "irl only",
  "no stream",
]);

function isNoise(title: string): boolean {
  const lower = title.toLowerCase().trim();
  if (NOISE_TITLES.has(lower)) return true;
  if (lower.startsWith("lunch")) return true;
  if (lower.startsWith("doors open")) return true;
  if (lower.startsWith("atmosphereconf starting")) return true;
  if (lower.startsWith("atmoshereconf starting")) return true;
  if (lower.startsWith("join us")) return true;
  if (lower.startsWith("please join")) return true;
  if (lower.startsWith("follow @")) return true;
  if (lower.includes("starting soon")) return true;
  return false;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wordsA = new Set(na.split(" "));
  const wordsB = new Set(nb.split(" "));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}

/**
 * Enrich VOD records with computed start/end times and room.
 */
export function enrichVods(vods: VodRecord[]): VodRecord[] {
  return vods
    .filter((v) => !isNoise(v.title))
    .map((v) => {
      const endTime = new Date(v.createdAt);
      const startTime = new Date(endTime.getTime() - v.duration / 1e6);
      return {
        ...v,
        startTime,
        endTime,
        room: CREATOR_ROOMS[v.creator] || "unknown",
      };
    });
}

/**
 * Two-pass correlation:
 *
 * Pass 1 (title match): Match by title similarity, same as before.
 * Only accept matches where the VOD duration is 30-200% of scheduled duration.
 *
 * Pass 2 (time-window): For unmatched talks, find VODs from the same room
 * whose recording window covers the talk's scheduled start time. Compute offset.
 *
 * Result: every talk gets a Match with either a primaryVideo or null (no recording).
 */
export function correlate(
  schedule: ScheduleEvent[],
  rawVods: VodRecord[]
): Match[] {
  const vods = enrichVods(rawVods);
  const matches: Match[] = [];
  const usedVodsForTitleMatch = new Set<string>();

  // Pass 1: title matching (for VODs that are 1:1 with talks)
  for (const event of schedule) {
    const schedStart = new Date(event.startsAt);
    const schedEnd = new Date(event.endsAt);
    const schedDurMs = schedEnd.getTime() - schedStart.getTime();

    let bestMatch: VodRecord | null = null;
    let bestScore = 0;

    for (const vod of vods) {
      if (usedVodsForTitleMatch.has(vod.uri)) continue;
      const score = titleSimilarity(event.name, vod.title);
      if (score <= bestScore) continue;

      // Duration sanity check: VOD should be 30-250% of scheduled time
      const vodDurMs = vod.duration / 1e6;
      const ratio = vodDurMs / schedDurMs;
      if (ratio < 0.3 || ratio > 2.5) continue;

      bestScore = score;
      bestMatch = vod;
    }

    if (bestMatch && bestScore >= 0.5) {
      usedVodsForTitleMatch.add(bestMatch.uri);
      matches.push({
        schedule: event,
        primaryVideo: {
          vodUri: bestMatch.uri,
          vodTitle: bestMatch.title,
          offsetNs: 0,
          coverageMs: bestMatch.duration / 1e6,
        },
        allSegments: [
          {
            vodUri: bestMatch.uri,
            vodTitle: bestMatch.title,
            offsetNs: 0,
            coverageMs: bestMatch.duration / 1e6,
          },
        ],
        confidence: bestScore,
        method: "title",
      });
    }
  }

  // Pass 2: time-window matching for unmatched talks
  const matchedEventUris = new Set(matches.map((m) => m.schedule.uri));

  for (const event of schedule) {
    if (matchedEventUris.has(event.uri)) continue;

    const schedStart = new Date(event.startsAt);
    const schedEnd = new Date(event.endsAt);

    // Find all VODs that overlap with this talk's time window
    const isDay2 = schedStart.getUTCDate() === 27; // March 27 = science day, all in GHS
    const overlapping = vods.filter((v) => {
      // Room match: strict on Days 3-4, relaxed on Day 2
      const roomMatch = v.room === event.room || (isDay2 && v.room === "Great Hall South");
      if (!roomMatch) return false;

      // Time overlap: VOD recording window overlaps talk scheduled time
      return v.startTime <= schedStart && v.endTime > schedStart;
    });

    if (overlapping.length === 0) {
      // No recording
      matches.push({
        schedule: event,
        primaryVideo: null,
        allSegments: [],
        confidence: 0,
        method: "none",
      });
      continue;
    }

    // Build segments from all overlapping VODs
    const segments: VideoSegment[] = overlapping.map((v) => {
      const offsetMs = schedStart.getTime() - v.startTime.getTime();
      const vodRemainingMs = v.endTime.getTime() - schedStart.getTime();
      const talkDurMs = schedEnd.getTime() - schedStart.getTime();
      const coverageMs = Math.min(vodRemainingMs, talkDurMs);

      return {
        vodUri: v.uri,
        vodTitle: v.title,
        offsetNs: Math.round(offsetMs * 1e6),
        coverageMs,
      };
    });

    // Primary = longest coverage
    const primary = segments.sort((a, b) => b.coverageMs - a.coverageMs)[0];

    matches.push({
      schedule: event,
      primaryVideo: primary,
      allSegments: segments,
      confidence: 0.7,
      method: "time-window",
    });
  }

  return matches.sort(
    (a, b) =>
      new Date(a.schedule.startsAt).getTime() -
      new Date(b.schedule.startsAt).getTime()
  );
}
