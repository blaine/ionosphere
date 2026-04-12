import type {
  TranscriptInput,
  TalkSegment,
  ScheduleTalk,
  HallucinationZone,
  BoundaryMatch,
} from './types.js';
import { phoneticCode } from '../phonetic.js';

// ─── Signal types ────────────────────────────────────────────────────────────

export type Signal =
  | { type: 'self-intro'; name: string }
  | { type: 'mc-handoff'; name: string }
  | { type: 'topic'; keywords: string[] };

// ─── Constants ───────────────────────────────────────────────────────────────

const SELF_INTRO_WINDOW_S = 120;
const MC_HANDOFF_LOOKBACK_S = 60;

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

/** Extract a potential name following a trigger pattern.
 *  Returns the first capitalized word that follows. */
function extractNameAfter(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  if (!match) return null;
  // The capture group is the name word
  return match[1] ?? null;
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

// ─── extractSignals ───────────────────────────────────────────────────────────

/**
 * Extract identity signals from transcript text in a time range.
 * Self-intro and topic signals come from [startS, startS+120s].
 * MC-handoff signals come from [startS-60s, startS].
 */
export function extractSignals(
  transcript: TranscriptInput,
  startS: number,
  endS: number,
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
 */
export function matchSegmentToSchedule(
  signals: Signal[],
  schedule: ScheduleTalk[],
): {
  rkey: string;
  title: string;
  confidence: 'high' | 'medium' | 'low';
  signals: string[];
} | null {
  if (schedule.length === 0) return null;

  // Collect name signals (self-intro and mc-handoff with names)
  const nameSignals = signals.filter(
    (s): s is { type: 'self-intro' | 'mc-handoff'; name: string } =>
      (s.type === 'self-intro' || s.type === 'mc-handoff') && s.name.length > 0,
  );

  // Collect transcript word bag from topic signals
  const transcriptWords: string[] = [];
  for (const s of signals) {
    if (s.type === 'topic') transcriptWords.push(...s.keywords);
  }

  type Candidate = {
    talk: ScheduleTalk;
    nameMatch: boolean;
    nameSource: 'self-intro' | 'mc-handoff' | null;
    topicMatchCount: number;
    matchedSignals: string[];
  };

  const candidates: Candidate[] = [];

  for (const talk of schedule) {
    const matchedSignals: string[] = [];
    let nameMatch = false;
    let nameSource: 'self-intro' | 'mc-handoff' | null = null;

    // Check name signals
    for (const sig of nameSignals) {
      if (nameMatchesScheduleSpeakers(sig.name, talk.speaker_names)) {
        nameMatch = true;
        if (sig.type === 'self-intro' && nameSource !== 'self-intro') {
          nameSource = 'self-intro';
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
    if (matchedKeywords.length >= 2) {
      matchedSignals.push(`topic:${matchedKeywords.slice(0, 5).join(',')}`);
    }

    if (nameMatch || matchedKeywords.length >= 1) {
      candidates.push({
        talk,
        nameMatch,
        nameSource,
        topicMatchCount: matchedKeywords.length,
        matchedSignals,
      });
    }
  }

  if (candidates.length === 0) return null;

  // Sort: high confidence first
  candidates.sort((a, b) => {
    const scoreA = confidenceScore(a.nameMatch, a.nameSource, a.topicMatchCount);
    const scoreB = confidenceScore(b.nameMatch, b.nameSource, b.topicMatchCount);
    return scoreB - scoreA;
  });

  const best = candidates[0];
  const confidence = getConfidence(best.nameMatch, best.nameSource, best.topicMatchCount);

  return {
    rkey: best.talk.rkey,
    title: best.talk.title,
    confidence,
    signals: best.matchedSignals,
  };
}

function confidenceScore(
  nameMatch: boolean,
  nameSource: 'self-intro' | 'mc-handoff' | null,
  topicMatchCount: number,
): number {
  let score = 0;
  if (nameMatch) {
    score += nameSource === 'self-intro' ? 3 : 2; // self-intro stronger than mc-handoff
  }
  if (topicMatchCount >= 2) score += 2;
  else if (topicMatchCount === 1) score += 1;
  return score;
}

function getConfidence(
  nameMatch: boolean,
  nameSource: 'self-intro' | 'mc-handoff' | null,
  topicMatchCount: number,
): 'high' | 'medium' | 'low' {
  // High: speaker name match + topic keyword match (2+ keywords)
  if (nameMatch && topicMatchCount >= 2) return 'high';

  // Medium: self-intro name match only OR 2+ topic keywords only
  if (nameMatch && nameSource === 'self-intro') return 'medium';
  if (topicMatchCount >= 2) return 'medium';

  // Low: mc-handoff name only, or 1 keyword only
  return 'low';
}

// ─── matchAllSegments ─────────────────────────────────────────────────────────

/**
 * Orchestrate: match all TalkSegments against schedule, returning BoundaryMatches.
 */
export function matchAllSegments(
  segments: TalkSegment[],
  transcript: TranscriptInput,
  schedule: ScheduleTalk[],
  hallucinationZones: HallucinationZone[],
): BoundaryMatch[] {
  const results: BoundaryMatch[] = [];

  for (const segment of segments) {
    const signals = extractSignals(transcript, segment.startS, segment.endS);

    if (segment.type === 'panel') {
      // For panel segments, try to match multiple schedule entries
      const matches: BoundaryMatch[] = [];

      for (const talk of schedule) {
        const nameSignals = signals.filter(
          (s): s is { type: 'self-intro' | 'mc-handoff'; name: string } =>
            (s.type === 'self-intro' || s.type === 'mc-handoff') && s.name.length > 0,
        );
        const transcriptWords: string[] = [];
        for (const s of signals) {
          if (s.type === 'topic') transcriptWords.push(...s.keywords);
        }

        const matchedSignals: string[] = [];
        let nameMatch = false;
        let nameSource: 'self-intro' | 'mc-handoff' | null = null;

        for (const sig of nameSignals) {
          if (nameMatchesScheduleSpeakers(sig.name, talk.speaker_names)) {
            nameMatch = true;
            if (sig.type === 'self-intro') nameSource = 'self-intro';
            else if (nameSource === null) nameSource = 'mc-handoff';
            matchedSignals.push(`${sig.type}:${sig.name}`);
          }
        }

        const titleKeywords = extractTitleKeywords(talk.title);
        const matchedKeywords = titleKeywords.filter((kw) => transcriptWords.includes(kw));
        if (matchedKeywords.length >= 2) {
          matchedSignals.push(`topic:${matchedKeywords.slice(0, 5).join(',')}`);
        }

        if (nameMatch || matchedKeywords.length >= 2) {
          const confidence = getConfidence(nameMatch, nameSource, matchedKeywords.length);
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

      if (matches.length > 0) {
        results.push(...matches);
      } else {
        // No match found — check if in hallucination zone
        const overlappingZones = hallucinationZones.filter(
          (z) => z.startS < segment.endS && z.endS > segment.startS,
        );
        // Attempt time-based fallback (not included in output if no match)
        // Panel with no signal matches — skip
      }
    } else {
      // Single-speaker or unknown
      const match = matchSegmentToSchedule(signals, schedule);
      const overlappingZones = hallucinationZones.filter(
        (z) => z.startS < segment.endS && z.endS > segment.startS,
      );

      if (match) {
        const isHallucinationAffected =
          segment.hallucinationZone && match.signals.length === 0;

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
      } else if (segment.hallucinationZone) {
        // Hallucination zone with no match — mark as unverifiable using time fallback
        // We don't emit a result without an rkey, so skip unless we have a time match
        // (time-based fallback would be done by schedule reconciler in Stage 3)
      }
      // else: no match, no hallucination — leave for unmatchedSegments
    }
  }

  return results;
}
