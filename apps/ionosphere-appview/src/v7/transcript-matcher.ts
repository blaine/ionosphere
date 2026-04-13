import type {
  TranscriptInput,
  TalkSegment,
  ScheduleTalk,
  HallucinationZone,
  BoundaryMatch,
} from './types.js';
import { phoneticCode, phoneticSearch } from '../phonetic.js';

// ─── Signal types ────────────────────────────────────────────────────────────

export type Signal =
  | { type: 'self-intro'; name: string }
  | { type: 'mc-handoff'; name: string }
  | { type: 'topic'; keywords: string[] }
  | { type: 'time-proximity'; offsetDiffS: number }
  | { type: 'name-scan'; name: string };

// ─── Constants ───────────────────────────────────────────────────────────────

const SELF_INTRO_WINDOW_S = 120;
const MC_HANDOFF_LOOKBACK_S = 60;
const NAME_SCAN_WINDOW_S = 120;
const TIME_PROXIMITY_THRESHOLD_S = 600; // ±10 minutes

/** Words that should not be interpreted as names after "I'm" */
const COMMON_WORDS_AFTER_IM = new Set([
  'So', 'And', 'The', 'It', 'We', 'Not', 'But', 'All', 'Just', 'Very',
  'Really', 'Here', 'Going', 'Sure', 'Like', 'One', 'How', 'Also', 'Super',
  'Trying', 'Kind', 'From', 'A',
]);

/** Short common words to skip when extracting topic keywords from titles */
const TOPIC_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'it', 'as', 'be', 'was', 'are', 'not',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get transcript text for a time window */
function getTranscriptText(
  transcript: TranscriptInput,
  startS: number,
  endS: number,
): string {
  return transcript.words
    .filter((w) => w.start >= startS && w.end <= endS)
    .map((w) => w.word)
    .join(' ');
}

/** Get transcript words (raw tokens) for a time window */
function getTranscriptWords(
  transcript: TranscriptInput,
  startS: number,
  endS: number,
): string[] {
  return transcript.words
    .filter((w) => w.start >= startS && w.end <= endS)
    .map((w) => w.word);
}

/** Extract meaningful keywords from a talk title (skip short stop words) */
function extractTitleKeywords(title: string): string[] {
  return title
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !TOPIC_STOP_WORDS.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());
}

/** Check if two name tokens sound alike using phonetic codes */
function namesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.length < 3 || b.length < 3) return false;
  const codeA = phoneticCode(a);
  const codeB = phoneticCode(b);
  if (!codeA || !codeB) return false;
  if (codeA === codeB) return true;
  // Prefix match (3 chars)
  const minLen = Math.min(codeA.length, codeB.length);
  if (minLen >= 3 && codeA.slice(0, 3) === codeB.slice(0, 3)) return true;
  return false;
}

/** Check if an extracted name matches any speaker in the schedule entry.
 *  Tries first and last name of each comma-separated speaker. */
function nameMatchesScheduleSpeakers(name: string, speakerNames: string): boolean {
  const speakers = speakerNames.split(',').map((s) => s.trim());
  for (const speaker of speakers) {
    const parts = speaker.split(/\s+/).filter(Boolean);
    for (const part of parts) {
      if (namesMatch(name, part)) return true;
    }
  }
  return false;
}

/** Extract all unique speaker name parts from the full schedule */
function extractAllSpeakerNames(schedule: ScheduleTalk[]): string[] {
  const names = new Set<string>();
  for (const talk of schedule) {
    const speakers = talk.speaker_names.split(',').map((s) => s.trim());
    for (const speaker of speakers) {
      const parts = speaker.split(/\s+/).filter(Boolean);
      for (const part of parts) {
        if (part.length >= 3) names.add(part);
      }
    }
  }
  return [...names];
}

// ─── extractSignals ───────────────────────────────────────────────────────────

/**
 * Extract identity signals from transcript text in a time range.
 * Self-intro and topic signals come from [startS, startS+120s].
 * MC-handoff signals come from [startS-60s, startS].
 * Name-scan signals search for known speaker names in the first 120s.
 *
 * @param knownSpeakerNames Optional list of all speaker name parts from the schedule.
 *   When provided, searches the intro window and MC handoff window for phonetic matches.
 */
export function extractSignals(
  transcript: TranscriptInput,
  startS: number,
  endS: number,
  knownSpeakerNames?: string[],
): Signal[] {
  const signals: Signal[] = [];

  const introEnd = Math.min(startS + SELF_INTRO_WINDOW_S, endS);
  const introText = getTranscriptText(transcript, startS, introEnd);

  // ── Self-introduction patterns ──
  // "my name is {WORD}" or "my name's {WORD}"
  const myNamePattern = /\bmy name(?:'s| is)\s+([A-Z][a-z]+)/g;
  let m: RegExpExecArray | null;
  while ((m = myNamePattern.exec(introText)) !== null) {
    const name = m[1];
    if (name) signals.push({ type: 'self-intro', name });
  }

  // "I'm {WORD}" — only if WORD starts uppercase and isn't a common word
  const imPattern = /\bI'm\s+([A-Z][a-z]+)/g;
  while ((m = imPattern.exec(introText)) !== null) {
    const name = m[1];
    if (name && !COMMON_WORDS_AFTER_IM.has(name)) {
      signals.push({ type: 'self-intro', name });
    }
  }

  // ── MC handoff patterns (in the gap before segment) ──
  const mcStart = Math.max(0, startS - MC_HANDOFF_LOOKBACK_S);
  const mcText = getTranscriptText(transcript, mcStart, startS);

  const pleaseWelcomePattern = /\bplease welcome\s+([A-Z][a-z]+)/gi;
  while ((m = pleaseWelcomePattern.exec(mcText)) !== null) {
    const name = m[1];
    if (name) signals.push({ type: 'mc-handoff', name });
  }

  const nextUpIsPattern = /\bnext up (?:is|we have)\s+([A-Z][a-z]+)/gi;
  while ((m = nextUpIsPattern.exec(mcText)) !== null) {
    const name = m[1];
    if (name) signals.push({ type: 'mc-handoff', name });
  }

  // "setting up next" — no name, but note as MC handoff marker (name = '')
  if (/\bsetting up next\b/i.test(mcText)) {
    signals.push({ type: 'mc-handoff', name: '' });
  }

  // ── Broader name scanning (Improvement #2) ──
  // Search intro window and MC handoff window for any known speaker name
  if (knownSpeakerNames && knownSpeakerNames.length > 0) {
    const nameScanEnd = Math.min(startS + NAME_SCAN_WINDOW_S, endS);
    const introWords = getTranscriptWords(transcript, startS, nameScanEnd);
    const mcWords = getTranscriptWords(transcript, mcStart, startS);

    // Track names already found by self-intro/mc-handoff patterns to avoid duplicates
    const alreadyFoundNames = new Set(
      signals
        .filter((s) => s.type === 'self-intro' || s.type === 'mc-handoff')
        .map((s) => (s as { name: string }).name.toLowerCase()),
    );

    for (const speakerName of knownSpeakerNames) {
      if (alreadyFoundNames.has(speakerName.toLowerCase())) continue;

      // Check intro window
      if (phoneticSearch(speakerName, introWords)) {
        signals.push({ type: 'name-scan', name: speakerName });
        continue;
      }

      // Check MC handoff window
      if (phoneticSearch(speakerName, mcWords)) {
        signals.push({ type: 'name-scan', name: speakerName });
      }
    }
  }

  // ── Topic keywords ──
  // This is computed per-schedule entry in matchSegmentToSchedule,
  // but we can return a signal with all words from the intro window.
  // We store a pre-tokenized bag of lowercased words for matching.
  const introWords = introText
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4);

  if (introWords.length > 0) {
    signals.push({ type: 'topic', keywords: introWords });
  }

  return signals;
}

// ─── matchSegmentToSchedule ───────────────────────────────────────────────────

/**
 * Match extracted signals against schedule candidates.
 * Returns the best match or null.
 *
 * @param timeProximities Optional map from rkey to offset difference in seconds.
 *   Used when schedule start times are available to add time-proximity as a signal.
 * @param looseMode When true, accepts weaker matches (single keyword, time-only with
 *   one candidate). Used in second-pass matching.
 */
export function matchSegmentToSchedule(
  signals: Signal[],
  schedule: ScheduleTalk[],
  timeProximities?: Map<string, number>,
  looseMode = false,
): {
  rkey: string;
  title: string;
  confidence: 'high' | 'medium' | 'low';
  signals: string[];
} | null {
  if (schedule.length === 0) return null;

  // Collect name signals (self-intro, mc-handoff, and name-scan)
  const nameSignals = signals.filter(
    (s): s is { type: 'self-intro' | 'mc-handoff' | 'name-scan'; name: string } =>
      (s.type === 'self-intro' || s.type === 'mc-handoff' || s.type === 'name-scan') &&
      s.name.length > 0,
  );

  // Collect transcript word bag from topic signals
  const transcriptWords: string[] = [];
  for (const s of signals) {
    if (s.type === 'topic') transcriptWords.push(...s.keywords);
  }

  type Candidate = {
    talk: ScheduleTalk;
    nameMatch: boolean;
    nameSource: 'self-intro' | 'mc-handoff' | 'name-scan' | null;
    topicMatchCount: number;
    timeProximity: boolean;
    timeOffsetS: number;
    matchedSignals: string[];
  };

  const candidates: Candidate[] = [];

  for (const talk of schedule) {
    const matchedSignals: string[] = [];
    let nameMatch = false;
    let nameSource: 'self-intro' | 'mc-handoff' | 'name-scan' | null = null;

    // Check name signals against this talk's speakers
    for (const sig of nameSignals) {
      if (nameMatchesScheduleSpeakers(sig.name, talk.speaker_names)) {
        nameMatch = true;
        if (sig.type === 'self-intro' && nameSource !== 'self-intro') {
          nameSource = 'self-intro';
        } else if (sig.type === 'name-scan' && nameSource !== 'self-intro') {
          nameSource = 'name-scan';
        } else if (sig.type === 'mc-handoff' && nameSource === null) {
          nameSource = 'mc-handoff';
        }
        matchedSignals.push(`${sig.type}:${sig.name}`);
        break; // one name match per talk is enough
      }
    }

    // Check topic keywords
    const titleKeywords = extractTitleKeywords(talk.title);
    const matchedKeywords = titleKeywords.filter((kw) => transcriptWords.includes(kw));
    const topicThreshold = looseMode ? 1 : 2;
    if (matchedKeywords.length >= topicThreshold) {
      matchedSignals.push(`topic:${matchedKeywords.slice(0, 5).join(',')}`);
    }

    // Check time proximity
    let timeProximity = false;
    let timeOffsetS = Infinity;
    if (timeProximities) {
      const offsetDiff = timeProximities.get(talk.rkey);
      if (offsetDiff !== undefined && Math.abs(offsetDiff) <= TIME_PROXIMITY_THRESHOLD_S) {
        timeProximity = true;
        timeOffsetS = Math.abs(offsetDiff);
        matchedSignals.push(`time-proximity:${offsetDiff > 0 ? '+' : ''}${Math.round(offsetDiff)}s`);
      }
    }

    // Determine if this candidate qualifies
    const hasName = nameMatch;
    const hasTopic = matchedKeywords.length >= topicThreshold;
    const hasTime = timeProximity;

    // In normal mode: need name or 2+ topic keywords (existing behavior) or time+any
    // In loose mode: accept time-only if single candidate, or single keyword match
    const qualifies = hasName || hasTopic || (hasTime && (hasName || hasTopic)) ||
      (looseMode && hasTime);

    if (qualifies) {
      candidates.push({
        talk,
        nameMatch,
        nameSource,
        topicMatchCount: matchedKeywords.length,
        timeProximity,
        timeOffsetS,
        matchedSignals,
      });
    }
  }

  if (candidates.length === 0) return null;

  // In loose mode with time-only matches, only accept if there's a single candidate
  if (looseMode) {
    const timeOnlyCandidates = candidates.filter(
      (c) => !c.nameMatch && c.topicMatchCount < 1 && c.timeProximity,
    );
    if (timeOnlyCandidates.length > 0 && candidates.length === timeOnlyCandidates.length) {
      // All candidates are time-only — only accept if exactly one
      if (candidates.length > 1) return null;
    }
  }

  // Sort: high confidence first
  candidates.sort((a, b) => {
    const scoreA = confidenceScore(a.nameMatch, a.nameSource, a.topicMatchCount, a.timeProximity, a.timeOffsetS);
    const scoreB = confidenceScore(b.nameMatch, b.nameSource, b.topicMatchCount, b.timeProximity, b.timeOffsetS);
    return scoreB - scoreA;
  });

  const best = candidates[0];
  const confidence = getConfidence(best.nameMatch, best.nameSource, best.topicMatchCount, best.timeProximity);

  return {
    rkey: best.talk.rkey,
    title: best.talk.title,
    confidence,
    signals: best.matchedSignals,
  };
}

function confidenceScore(
  nameMatch: boolean,
  nameSource: 'self-intro' | 'mc-handoff' | 'name-scan' | null,
  topicMatchCount: number,
  timeProximity: boolean,
  timeOffsetS: number,
): number {
  let score = 0;
  if (nameMatch) {
    if (nameSource === 'self-intro') score += 3;
    else if (nameSource === 'name-scan') score += 2.5;
    else score += 2; // mc-handoff
  }
  if (topicMatchCount >= 2) score += 2;
  else if (topicMatchCount === 1) score += 1;
  if (timeProximity) {
    // Closer time = higher score, max 1.5 points
    score += Math.max(0, 1.5 - (timeOffsetS / TIME_PROXIMITY_THRESHOLD_S));
  }
  return score;
}

function getConfidence(
  nameMatch: boolean,
  nameSource: 'self-intro' | 'mc-handoff' | 'name-scan' | null,
  topicMatchCount: number,
  timeProximity: boolean,
): 'high' | 'medium' | 'low' {
  // High: speaker name match + topic keyword match (2+ keywords)
  // Also high: time proximity + name + topic (any count)
  if (nameMatch && topicMatchCount >= 2) return 'high';
  if (timeProximity && nameMatch && topicMatchCount >= 1) return 'high';

  // Medium: self-intro or name-scan match only, OR 2+ topic keywords only
  // Also medium: time proximity + any other signal
  if (nameMatch && (nameSource === 'self-intro' || nameSource === 'name-scan')) return 'medium';
  if (topicMatchCount >= 2) return 'medium';
  if (timeProximity && (nameMatch || topicMatchCount >= 1)) return 'medium';

  // Low: mc-handoff name only, or 1 keyword only, or time-proximity only
  return 'low';
}

// ─── Time proximity computation ─────────────────────────────────────────────

/**
 * Compute time proximity map: for each schedule talk, how far its expected
 * stream offset is from the segment's actual start time.
 *
 * Uses the first scheduled talk's starts_at as the reference point and the
 * first segment's startS as time zero.
 */
function computeTimeProximities(
  segmentStartS: number,
  schedule: ScheduleTalk[],
  firstScheduleUnixS: number,
  firstSegmentStartS: number,
): Map<string, number> {
  const proximities = new Map<string, number>();

  for (const talk of schedule) {
    const talkUnixS = Date.parse(talk.starts_at) / 1000;
    if (isNaN(talkUnixS)) continue;

    // Expected offset into stream based on schedule
    const expectedOffsetS = talkUnixS - firstScheduleUnixS + firstSegmentStartS;
    // Actual offset of this segment
    const diffS = segmentStartS - expectedOffsetS;
    proximities.set(talk.rkey, diffS);
  }

  return proximities;
}

// ─── matchAllSegments ─────────────────────────────────────────────────────────

/**
 * Orchestrate: match all TalkSegments against schedule, returning BoundaryMatches.
 * Includes a second pass for process-of-elimination matching.
 */
export function matchAllSegments(
  segments: TalkSegment[],
  transcript: TranscriptInput,
  schedule: ScheduleTalk[],
  hallucinationZones: HallucinationZone[],
): BoundaryMatch[] {
  const results: BoundaryMatch[] = [];

  // Pre-compute schedule reference time and known speaker names
  const sortedSchedule = [...schedule].sort(
    (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at),
  );
  const firstScheduleUnixS =
    sortedSchedule.length > 0 ? Date.parse(sortedSchedule[0].starts_at) / 1000 : 0;

  const sortedSegments = [...segments].sort((a, b) => a.startS - b.startS);
  const firstSegmentStartS = sortedSegments.length > 0 ? sortedSegments[0].startS : 0;

  const knownSpeakerNames = extractAllSpeakerNames(schedule);

  // ── First pass: standard matching ──
  const matchedRkeys = new Set<string>();

  for (const segment of segments) {
    const signals = extractSignals(transcript, segment.startS, segment.endS, knownSpeakerNames);

    // Compute time proximities for this segment
    const timeProximities = firstScheduleUnixS > 0
      ? computeTimeProximities(segment.startS, schedule, firstScheduleUnixS, firstSegmentStartS)
      : undefined;

    if (segment.type === 'panel') {
      // For panel segments, try to match multiple schedule entries
      const matches = matchPanelSegment(
        signals, segment, schedule, hallucinationZones, timeProximities,
      );
      for (const match of matches) {
        matchedRkeys.add(match.rkey);
      }
      results.push(...matches);
    } else {
      // Single-speaker or unknown
      const match = matchSegmentToSchedule(signals, schedule, timeProximities);
      const overlappingZones = hallucinationZones.filter(
        (z) => z.startS < segment.endS && z.endS > segment.startS,
      );

      if (match) {
        const isHallucinationAffected =
          segment.hallucinationZone && match.signals.length === 0;

        matchedRkeys.add(match.rkey);
        results.push({
          rkey: match.rkey,
          title: match.title,
          startTimestamp: segment.startS,
          endTimestamp: segment.endS,
          confidence: isHallucinationAffected ? 'unverifiable' : match.confidence,
          signals: match.signals,
          panel: false,
          hallucinationZones: overlappingZones,
        });
      }
    }
  }

  // ── Second pass: process of elimination (Improvement #3) ──
  const unmatchedSegments = segments.filter(
    (seg) => !results.some(
      (r) => Math.abs(r.startTimestamp - seg.startS) < 5,
    ),
  );
  const unmatchedSchedule = schedule.filter((t) => !matchedRkeys.has(t.rkey));

  if (unmatchedSegments.length > 0 && unmatchedSchedule.length > 0) {
    const secondPassResults = secondPassMatching(
      unmatchedSegments,
      unmatchedSchedule,
      transcript,
      hallucinationZones,
      knownSpeakerNames,
      firstScheduleUnixS,
      firstSegmentStartS,
    );

    results.push(...secondPassResults);
  }

  return results;
}

/**
 * Second pass: match remaining unmatched segments to unmatched schedule entries
 * using looser criteria and order-based matching.
 */
function secondPassMatching(
  unmatchedSegments: TalkSegment[],
  unmatchedSchedule: ScheduleTalk[],
  transcript: TranscriptInput,
  hallucinationZones: HallucinationZone[],
  knownSpeakerNames: string[],
  firstScheduleUnixS: number,
  firstSegmentStartS: number,
): BoundaryMatch[] {
  const results: BoundaryMatch[] = [];
  const usedRkeys = new Set<string>();
  const usedSegments = new Set<number>(); // index into unmatchedSegments

  // Sort both by time for order-based matching
  const sortedSegments = [...unmatchedSegments].sort((a, b) => a.startS - b.startS);
  const sortedSchedule = [...unmatchedSchedule].sort(
    (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at),
  );

  // Attempt 1: try matching with loose criteria (single keyword, name-scan matches)
  for (let i = 0; i < sortedSegments.length; i++) {
    const segment = sortedSegments[i];
    const signals = extractSignals(transcript, segment.startS, segment.endS, knownSpeakerNames);

    const remainingSchedule = sortedSchedule.filter((t) => !usedRkeys.has(t.rkey));

    const timeProximities = firstScheduleUnixS > 0
      ? computeTimeProximities(segment.startS, remainingSchedule, firstScheduleUnixS, firstSegmentStartS)
      : undefined;

    const match = matchSegmentToSchedule(signals, remainingSchedule, timeProximities, true);

    if (match) {
      const overlappingZones = hallucinationZones.filter(
        (z) => z.startS < segment.endS && z.endS > segment.startS,
      );

      usedRkeys.add(match.rkey);
      usedSegments.add(i);
      results.push({
        rkey: match.rkey,
        title: match.title,
        startTimestamp: segment.startS,
        endTimestamp: segment.endS,
        confidence: match.confidence,
        signals: [...match.signals, 'second-pass'],
        panel: segment.type === 'panel',
        hallucinationZones: overlappingZones,
      });
    }
  }

  // Attempt 2: order-based matching for remaining unmatched
  // If segments and schedule entries are both sorted by time, the Nth unmatched
  // segment likely corresponds to the Nth unmatched schedule entry when they
  // are in roughly the right time region.
  const stillUnmatchedSegments = sortedSegments.filter((_, i) => !usedSegments.has(i));
  const stillUnmatchedSchedule = sortedSchedule.filter((t) => !usedRkeys.has(t.rkey));

  if (stillUnmatchedSegments.length > 0 && stillUnmatchedSchedule.length > 0) {
    const minLen = Math.min(stillUnmatchedSegments.length, stillUnmatchedSchedule.length);
    for (let i = 0; i < minLen; i++) {
      const segment = stillUnmatchedSegments[i];
      const talk = stillUnmatchedSchedule[i];

      // Only accept order-based match if time proximity is reasonable
      const talkUnixS = Date.parse(talk.starts_at) / 1000;
      if (isNaN(talkUnixS)) continue;

      const expectedOffsetS = talkUnixS - firstScheduleUnixS + firstSegmentStartS;
      const diffS = Math.abs(segment.startS - expectedOffsetS);

      // Allow wider window for order-based matching (20 minutes)
      if (diffS > 1200) continue;

      const overlappingZones = hallucinationZones.filter(
        (z) => z.startS < segment.endS && z.endS > segment.startS,
      );

      results.push({
        rkey: talk.rkey,
        title: talk.title,
        startTimestamp: segment.startS,
        endTimestamp: segment.endS,
        confidence: 'low',
        signals: [`order-match`, `time-proximity:${Math.round(segment.startS - expectedOffsetS)}s`],
        panel: segment.type === 'panel',
        hallucinationZones: overlappingZones,
      });
    }
  }

  return results;
}

/**
 * Match a panel segment against schedule entries, producing multiple matches.
 */
function matchPanelSegment(
  signals: Signal[],
  segment: TalkSegment,
  schedule: ScheduleTalk[],
  hallucinationZones: HallucinationZone[],
  timeProximities?: Map<string, number>,
): BoundaryMatch[] {
  const matches: BoundaryMatch[] = [];

  // Collect name signals (self-intro, mc-handoff, and name-scan)
  const nameSignals = signals.filter(
    (s): s is { type: 'self-intro' | 'mc-handoff' | 'name-scan'; name: string } =>
      (s.type === 'self-intro' || s.type === 'mc-handoff' || s.type === 'name-scan') &&
      s.name.length > 0,
  );
  const transcriptWords: string[] = [];
  for (const s of signals) {
    if (s.type === 'topic') transcriptWords.push(...s.keywords);
  }

  for (const talk of schedule) {
    const matchedSignals: string[] = [];
    let nameMatch = false;
    let nameSource: 'self-intro' | 'mc-handoff' | 'name-scan' | null = null;

    for (const sig of nameSignals) {
      if (nameMatchesScheduleSpeakers(sig.name, talk.speaker_names)) {
        nameMatch = true;
        if (sig.type === 'self-intro') nameSource = 'self-intro';
        else if (sig.type === 'name-scan' && nameSource !== 'self-intro') nameSource = 'name-scan';
        else if (nameSource === null) nameSource = 'mc-handoff';
        matchedSignals.push(`${sig.type}:${sig.name}`);
      }
    }

    const titleKeywords = extractTitleKeywords(talk.title);
    const matchedKeywords = titleKeywords.filter((kw) => transcriptWords.includes(kw));
    if (matchedKeywords.length >= 2) {
      matchedSignals.push(`topic:${matchedKeywords.slice(0, 5).join(',')}`);
    }

    // Check time proximity
    let timeProximity = false;
    if (timeProximities) {
      const offsetDiff = timeProximities.get(talk.rkey);
      if (offsetDiff !== undefined && Math.abs(offsetDiff) <= TIME_PROXIMITY_THRESHOLD_S) {
        timeProximity = true;
        matchedSignals.push(`time-proximity:${offsetDiff > 0 ? '+' : ''}${Math.round(offsetDiff)}s`);
      }
    }

    if (nameMatch || matchedKeywords.length >= 2 || (timeProximity && (nameMatch || matchedKeywords.length >= 1))) {
      const confidence = getConfidence(nameMatch, nameSource, matchedKeywords.length, timeProximity);
      const overlappingZones = hallucinationZones.filter(
        (z) => z.startS < segment.endS && z.endS > segment.startS,
      );

      matches.push({
        rkey: talk.rkey,
        title: talk.title,
        startTimestamp: segment.startS,
        endTimestamp: segment.endS,
        confidence: segment.hallucinationZone && matchedSignals.length === 0
          ? 'unverifiable'
          : confidence,
        signals: matchedSignals,
        panel: true,
        hallucinationZones: overlappingZones,
      });
    }
  }

  return matches;
}
