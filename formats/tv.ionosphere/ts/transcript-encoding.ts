/**
 * Compact transcript encoding and decoding.
 *
 * Storage format (tv.ionosphere.transcript):
 *   - text: full transcript string
 *   - startMs: absolute start time of first word
 *   - timings: flat array where positive = word duration (ms),
 *     negative = silence gap (abs ms) before next word.
 *     Words assumed contiguous by default.
 *
 * Rendering format (RelationalText document):
 *   - text + facets with byte ranges and nanosecond timestamps
 *
 * The lens between these is this module.
 */

import type { TranscriptResult, WordTimestamp } from "./index.js";

export interface CompactTranscript {
  text: string;
  startMs: number;
  timings: number[];
}

export interface DocumentFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, any>>;
}

export interface Document {
  text: string;
  facets: DocumentFacet[];
}

/**
 * Encode a word-level transcript into the compact format.
 *
 * Input: TranscriptResult with { text, words: [{ word, start, end }] }
 * Output: CompactTranscript with { text, startMs, timings }
 */
export function encode(transcript: TranscriptResult): CompactTranscript {
  if (transcript.words.length === 0) {
    return { text: transcript.text, startMs: 0, timings: [] };
  }

  const startMs = Math.round(transcript.words[0].start * 1000);
  const timings: number[] = [];
  let cursor = startMs; // current time in ms

  for (let i = 0; i < transcript.words.length; i++) {
    const word = transcript.words[i];
    const wordStartMs = Math.round(word.start * 1000);
    const wordEndMs = Math.round(word.end * 1000);
    const durationMs = wordEndMs - wordStartMs;

    // Check for gap between previous word end and this word start
    const gap = wordStartMs - cursor;
    if (gap > 0) {
      timings.push(-gap);
    }

    timings.push(Math.max(durationMs, 1)); // min 1ms duration
    cursor = wordEndMs;
  }

  return { text: transcript.text, startMs, timings };
}

/**
 * Decode compact format back into word-level timestamps.
 */
export function decode(compact: CompactTranscript): TranscriptResult {
  const words = compact.text.split(/\s+/).filter((w) => w.length > 0);
  const timestamps: WordTimestamp[] = [];

  let cursor = compact.startMs; // ms
  let wordIndex = 0;

  for (const value of compact.timings) {
    if (value < 0) {
      // Silence gap
      cursor += Math.abs(value);
    } else {
      // Word duration
      if (wordIndex < words.length) {
        timestamps.push({
          word: words[wordIndex],
          start: cursor / 1000,
          end: (cursor + value) / 1000,
          confidence: 1.0,
        });
        cursor += value;
        wordIndex++;
      }
    }
  }

  return { text: compact.text, words: timestamps };
}

/**
 * Decode compact format directly into a RelationalText document
 * with timestamp facets. This is the lens output.
 */
export function decodeToDocument(compact: CompactTranscript): Document {
  const encoder = new TextEncoder();
  const words = compact.text.split(/\s+/).filter((w) => w.length > 0);
  const facets: DocumentFacet[] = [];

  let cursor = compact.startMs; // ms
  let wordIndex = 0;
  let searchFrom = 0;

  for (const value of compact.timings) {
    if (value < 0) {
      cursor += Math.abs(value);
    } else {
      if (wordIndex < words.length) {
        const word = words[wordIndex];
        const idx = compact.text.indexOf(word, searchFrom);
        if (idx !== -1) {
          const byteStart = encoder.encode(compact.text.slice(0, idx)).length;
          const byteEnd = encoder.encode(
            compact.text.slice(0, idx + word.length)
          ).length;

          facets.push({
            index: { byteStart, byteEnd },
            features: [
              {
                $type: "tv.ionosphere.facet#timestamp",
                startTime: cursor * 1_000_000, // ms → ns
                endTime: (cursor + value) * 1_000_000,
              },
            ],
          });

          searchFrom = idx + word.length;
        }
        cursor += value;
        wordIndex++;
      }
    }
  }

  return { text: compact.text, facets };
}
