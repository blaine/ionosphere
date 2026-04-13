/**
 * Schedule Reconciler — Stage 3 of the v7 boundary detection pipeline.
 *
 * Takes matched boundaries from Stage 2 and:
 * 1. Deduplicates: if the same rkey appears multiple times, keeps highest confidence
 * 2. Computes end times: uses the next talk's start (with gap handling)
 * 3. Handles unmatched schedule entries (hallucination zones → unverifiable, else unmatchedSchedule)
 * 4. Collects unmatched segments (diarization segments that got no match)
 * 5. Assembles the final V7Output
 */

import type {
  BoundaryMatch,
  HallucinationZone,
  ScheduleTalk,
  TalkSegment,
  V7Output,
} from './types.js';

// A gap larger than this (seconds) between consecutive matched talks is treated
// as a session break.  The last talk before the break gets its end time from
// the diarization segment rather than the next talk's start.
const SESSION_BREAK_GAP_S = 60;

// Numeric rank for confidence levels (higher = better)
const CONFIDENCE_RANK: Record<BoundaryMatch['confidence'], number> = {
  high: 4,
  medium: 3,
  low: 2,
  unverifiable: 1,
};

/**
 * Deduplicate matches: when the same rkey appears more than once, keep only
 * the instance with the highest confidence.  Ties are broken by earlier start.
 */
function deduplicateMatches(matches: BoundaryMatch[]): BoundaryMatch[] {
  const best = new Map<string, BoundaryMatch>();

  for (const match of matches) {
    const existing = best.get(match.rkey);
    if (!existing) {
      best.set(match.rkey, match);
    } else {
      const existingRank = CONFIDENCE_RANK[existing.confidence];
      const newRank = CONFIDENCE_RANK[match.confidence];
      if (newRank > existingRank) {
        best.set(match.rkey, match);
      } else if (newRank === existingRank && match.startTimestamp < existing.startTimestamp) {
        best.set(match.rkey, match);
      }
    }
  }

  return [...best.values()];
}

/**
 * Find the TalkSegment whose time range best covers a given start timestamp.
 * Returns the segment whose startS is closest (from below) to startTimestamp.
 */
function findSegmentForMatch(
  match: BoundaryMatch,
  segments: TalkSegment[],
): TalkSegment | undefined {
  // Find the segment that contains or immediately precedes the match start
  let best: TalkSegment | undefined;
  for (const seg of segments) {
    if (seg.startS <= match.startTimestamp + 1) {
      if (!best || seg.startS > best.startS) {
        best = seg;
      }
    }
  }
  return best;
}

/**
 * Check whether a scheduled time overlaps any hallucination zone.
 */
function isInHallucinationZone(
  startsAt: string,
  hallucinationZones: HallucinationZone[],
  streamStartUnixS: number,
): boolean {
  // We work in stream-relative seconds.  The schedule's starts_at is an
  // ISO timestamp; without an absolute anchor we can't convert it.  Instead
  // we rely on the caller to pass absolute seconds when the zone was detected,
  // but since ScheduleTalk carries ISO strings, we do a best-effort check:
  // if ANY hallucination zone exists and the schedule entry has no matched
  // boundary, we use the zone's stream-relative window.
  //
  // In practice, callers who know the stream's wall-clock start can compare
  // properly.  For the common case we just check all zones.
  if (hallucinationZones.length === 0) return false;

  // Parse the ISO string into a Date epoch seconds
  const talkEpochS = Date.parse(startsAt) / 1000;
  if (isNaN(talkEpochS)) return false;

  // Convert to stream-relative offset
  const relativeS = talkEpochS - streamStartUnixS;

  return hallucinationZones.some(
    (z) => relativeS >= z.startS && relativeS <= z.endS,
  );
}

/**
 * Compute end times for each deduplicated match.
 *
 * Rules (in order):
 *  1. Sort matches by startTimestamp.
 *  2. For each match, the default end = next match's startTimestamp.
 *  3. If the gap to the next match > SESSION_BREAK_GAP_S, treat this as the
 *     last talk before a break → use the diarization segment's endS.
 *  4. For the absolute last match: use min(streamDurationS, segment.endS).
 */
function computeEndTimes(
  matches: BoundaryMatch[],
  segments: TalkSegment[],
  streamDurationS: number,
): BoundaryMatch[] {
  const sorted = [...matches].sort((a, b) => a.startTimestamp - b.startTimestamp);

  return sorted.map((match, idx) => {
    const seg = findSegmentForMatch(match, segments);
    const segEndS = seg?.endS ?? streamDurationS;

    let endTimestamp: number;

    if (idx < sorted.length - 1) {
      const nextStart = sorted[idx + 1].startTimestamp;
      const gap = nextStart - match.startTimestamp;

      if (gap > SESSION_BREAK_GAP_S) {
        // Last talk before a session break — use segment end
        endTimestamp = segEndS;
      } else {
        // Normal case: end at the next talk's start
        endTimestamp = nextStart;
      }
    } else {
      // Absolute last match
      endTimestamp = Math.min(streamDurationS, segEndS);
    }

    return { ...match, endTimestamp };
  });
}

/**
 * Collect TalkSegments that have no BoundaryMatch assigned to them.
 *
 * A segment is considered "assigned" if any match's startTimestamp falls
 * within [seg.startS - 5, seg.endS + 5].
 */
function collectUnmatchedSegments(
  segments: TalkSegment[],
  matches: BoundaryMatch[],
): TalkSegment[] {
  return segments.filter((seg) => {
    return !matches.some(
      (m) => m.startTimestamp >= seg.startS - 5 && m.startTimestamp <= seg.endS + 5,
    );
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reconcile matched boundaries, fill gaps, and assemble the final V7Output.
 *
 * @param matches          Raw BoundaryMatch list from Stage 2
 * @param segments         TalkSegments from Stage 1 (diarization-segmenter)
 * @param schedule         Full schedule for this stream from the DB
 * @param hallucinationZones  Zones detected in Stage 0
 * @param streamDurationS  Total stream duration in seconds
 * @param streamName       Human-readable stream name (for V7Output.stream)
 * @param streamStartUnixS Optional: wall-clock start of the stream as Unix seconds.
 *                         Used to map schedule ISO timestamps into stream-relative
 *                         offsets when checking hallucination zones.
 *                         Defaults to 0 (disables the check — all unmatched
 *                         schedule entries go to unmatchedSchedule).
 */
export function reconcileSchedule(
  matches: BoundaryMatch[],
  segments: TalkSegment[],
  schedule: ScheduleTalk[],
  hallucinationZones: HallucinationZone[],
  streamDurationS: number,
  streamName = 'unknown',
  streamStartUnixS = 0,
): V7Output {
  // 1. Deduplicate
  const deduped = deduplicateMatches(matches);

  // 2. Compute end times
  const withEnds = computeEndTimes(deduped, segments, streamDurationS);

  // 3. Unmatched schedule
  const matchedRkeys = new Set(withEnds.map((m) => m.rkey));
  const unmatchedScheduleEntries: BoundaryMatch[] = [];
  const unmatchedScheduleRkeys: string[] = [];

  for (const talk of schedule) {
    if (matchedRkeys.has(talk.rkey)) continue;

    if (
      streamStartUnixS > 0 &&
      isInHallucinationZone(talk.starts_at, hallucinationZones, streamStartUnixS)
    ) {
      // In a hallucination zone — mark as unverifiable result
      unmatchedScheduleEntries.push({
        rkey: talk.rkey,
        title: talk.title,
        startTimestamp: 0,
        endTimestamp: null,
        confidence: 'unverifiable',
        signals: [],
        panel: false,
        hallucinationZones,
      });
    } else {
      unmatchedScheduleRkeys.push(talk.rkey);
    }
  }

  // 4. Unmatched segments
  const unmatchedSegments = collectUnmatchedSegments(segments, withEnds);

  // 5. Assemble V7Output
  const allResults = [
    ...withEnds,
    ...unmatchedScheduleEntries,
  ].sort((a, b) => a.startTimestamp - b.startTimestamp);

  return {
    stream: streamName,
    results: allResults,
    hallucinationZones,
    unmatchedSegments,
    unmatchedSchedule: unmatchedScheduleRkeys,
  };
}
