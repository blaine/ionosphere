/**
 * Hallucination detector for v7 boundary detection pipeline.
 *
 * Whisper (speech-to-text) produces garbage output during silence, often
 * repeating known phrases ("Transcription by CastingWords", "0 0 0 0", etc.).
 * This module identifies those zones so the boundary detector can discount
 * transcript evidence from those time ranges.
 *
 * Three detection methods:
 *   1. Pattern matching: known repeating attribution phrases
 *   2. Numeric zero loops: 20+ consecutive "0" words
 *   3. Diarization silence mismatch: diarization gap > 60s but transcript
 *      has words in that range
 */

import type { DiarizationInput, HallucinationZone, TranscriptInput } from './types.js';

// Known hallucination patterns (Whisper repeats these during silence).
// `minWords` is the minimum number of words needed to match (for window sizing).
const HALLUCINATION_PATTERNS: { pattern: RegExp; name: string; minWords: number }[] = [
  { pattern: /transcription\s+by\s+castingwords/i, name: 'CastingWords attribution', minWords: 3 },
  { pattern: /otter\.ai/i, name: 'otter.ai attribution', minWords: 1 },
  { pattern: /eso\s+translation/i, name: 'ESO Translation attribution', minWords: 2 },
  { pattern: /msword\s+document/i, name: 'MSWord Document attribution', minWords: 2 },
  { pattern: /transcription\s+outsourcing/i, name: 'Transcription Outsourcing attribution', minWords: 2 },
  { pattern: /uga\s+extension/i, name: 'UGA Extension attribution', minWords: 2 },
  { pattern: /thank\s+you\s+for\s+watching/i, name: 'Thank you for watching', minWords: 4 },
  { pattern: /fema\.gov/i, name: 'fema.gov attribution', minWords: 1 },
  { pattern: /subtitles?\s+by/i, name: 'subtitle attribution', minWords: 2 },
  { pattern: /subtitle\s+translation/i, name: 'subtitle translation', minWords: 2 },
  { pattern: /closed\s+caption(?:ing|s?)\s+by/i, name: 'closed captioning attribution', minWords: 3 },
];

// Minimum repeats of a pattern to count as a hallucination zone
const MIN_PATTERN_REPEATS = 3;

// Number of consecutive zero words to trigger detection
const ZERO_LOOP_THRESHOLD = 20;

// Diarization gap that counts as silence
const DIARIZATION_SILENCE_GAP_S = 60;

// Merge zones within this many seconds of each other
const MERGE_WITHIN_S = 60;

/**
 * Find individual occurrences of a phrase pattern in a word stream.
 *
 * For each pattern, scans word-by-word using a sliding window of `minWords`
 * words. When the pattern matches, records the occurrence and advances past
 * those words to avoid double-counting the same phrase occurrence.
 *
 * Returns zones where the phrase repeats >= MIN_PATTERN_REPEATS times.
 */
function detectPatternZones(
  words: TranscriptInput['words'],
): HallucinationZone[] {
  const zones: HallucinationZone[] = [];

  for (const { pattern, name, minWords } of HALLUCINATION_PATTERNS) {
    // Collect each individual match occurrence as { startS, endS }
    const occurrences: { startS: number; endS: number }[] = [];

    let i = 0;
    while (i < words.length) {
      const windowEnd = Math.min(words.length, i + minWords);
      const windowText = words
        .slice(i, windowEnd)
        .map((w) => w.word)
        .join(' ');

      if (pattern.test(windowText)) {
        occurrences.push({
          startS: words[i].start,
          endS: words[windowEnd - 1].end,
        });
        // Advance by minWords to count each phrase occurrence separately
        i += minWords;
      } else {
        i++;
      }
    }

    if (occurrences.length >= MIN_PATTERN_REPEATS) {
      // Emit one zone spanning all occurrences
      zones.push({
        startS: occurrences[0].startS,
        endS: occurrences[occurrences.length - 1].endS,
        pattern: name,
      });
    }
  }

  return zones;
}

// Maximum gap between consecutive zero words to stay in the same run (seconds)
const ZERO_RUN_MAX_GAP_S = 5;

/**
 * Detect runs of 20+ consecutive "0" words (numeric zero loops).
 * Breaks runs when consecutive zeros have a gap > ZERO_RUN_MAX_GAP_S.
 */
function detectZeroLoopZones(words: TranscriptInput['words']): HallucinationZone[] {
  const zones: HallucinationZone[] = [];
  let runStart = -1;
  let runLength = 0;

  const endRun = (lastIdx: number) => {
    if (runLength >= ZERO_LOOP_THRESHOLD) {
      zones.push({
        startS: words[runStart].start,
        endS: words[lastIdx].end,
        pattern: 'numeric zero loop',
      });
    }
    runStart = -1;
    runLength = 0;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i].word.trim();
    if (w === '0') {
      if (runStart === -1) {
        runStart = i;
        runLength = 1;
      } else {
        // Check for time gap that would break the run
        const gap = words[i].start - words[i - 1].end;
        if (gap > ZERO_RUN_MAX_GAP_S) {
          endRun(i - 1);
          runStart = i;
          runLength = 1;
        } else {
          runLength++;
        }
      }
    } else {
      if (runStart !== -1) {
        endRun(i - 1);
      }
    }
  }

  // Handle trailing run
  if (runStart !== -1) {
    endRun(words.length - 1);
  }

  return zones;
}

/**
 * Detect zones where diarization shows silence (gap > 60s) but the
 * transcript has words during that period.
 */
function detectDiarizationSilenceMismatch(
  words: TranscriptInput['words'],
  diarization: DiarizationInput,
): HallucinationZone[] {
  const zones: HallucinationZone[] = [];
  const segments = diarization.segments;

  if (segments.length < 2) return zones;

  for (let i = 0; i < segments.length - 1; i++) {
    const gapStart = segments[i].end;
    const gapEnd = segments[i + 1].start;
    const gapDuration = gapEnd - gapStart;

    if (gapDuration < DIARIZATION_SILENCE_GAP_S) continue;

    // Find words that fall within this silence gap
    const wordsInGap = words.filter(
      (w) => w.start >= gapStart && w.end <= gapEnd,
    );

    if (wordsInGap.length > 0) {
      zones.push({
        startS: wordsInGap[0].start,
        endS: wordsInGap[wordsInGap.length - 1].end,
        pattern: 'diarization silence mismatch',
      });
    }
  }

  return zones;
}

/**
 * Merge overlapping or near-adjacent zones (within MERGE_WITHIN_S seconds).
 */
function mergeZones(zones: HallucinationZone[]): HallucinationZone[] {
  if (zones.length === 0) return [];

  const sorted = [...zones].sort((a, b) => a.startS - b.startS);
  const merged: HallucinationZone[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current.startS <= last.endS + MERGE_WITHIN_S) {
      // Merge: extend end, concatenate patterns if different
      last.endS = Math.max(last.endS, current.endS);
      if (!last.pattern.includes(current.pattern)) {
        last.pattern = `${last.pattern}; ${current.pattern}`;
      }
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

/**
 * Detect all hallucination zones in the given transcript, cross-referenced
 * with diarization data.
 */
export function detectHallucinationZones(
  transcript: TranscriptInput,
  diarization: DiarizationInput,
): HallucinationZone[] {
  const { words } = transcript;
  if (words.length === 0) return [];

  const patternZones = detectPatternZones(words);
  const zeroZones = detectZeroLoopZones(words);
  const silenceZones = detectDiarizationSilenceMismatch(words, diarization);

  const allZones = [...patternZones, ...zeroZones, ...silenceZones];
  return mergeZones(allZones);
}
