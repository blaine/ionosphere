import { describe, expect, it } from 'vitest';
import { detectHallucinationZones } from '../hallucination-detector.js';
import type { DiarizationInput, TranscriptInput } from '../types.js';

// Helper: build a transcript with words spaced 1 second apart starting at `startS`
function makeWords(
  phrase: string,
  repeatCount: number,
  startS: number,
  wordDurationS = 0.5,
): TranscriptInput['words'] {
  const wordList = phrase.split(/\s+/).filter(Boolean);
  const words: TranscriptInput['words'] = [];
  let t = startS;
  for (let i = 0; i < repeatCount; i++) {
    for (const word of wordList) {
      words.push({ word, start: t, end: t + wordDurationS });
      t += wordDurationS + 0.1;
    }
    // Small gap between repeats
    t += 0.5;
  }
  return words;
}

// Helper: build a transcript with N consecutive "0" words
function makeZeroWords(count: number, startS: number): TranscriptInput['words'] {
  return Array.from({ length: count }, (_, i) => ({
    word: '0',
    start: startS + i * 0.3,
    end: startS + i * 0.3 + 0.2,
  }));
}

// Helper: empty diarization (no speech at all)
function emptyDiarization(): DiarizationInput {
  return { speakers: [], segments: [], total_segments: 0 };
}

// Helper: diarization covering a range
function makeDiarization(
  segments: { start: number; end: number; speaker: string }[],
): DiarizationInput {
  const speakers = [...new Set(segments.map((s) => s.speaker))];
  return { speakers, segments, total_segments: segments.length };
}

// Helper: real speech words (non-hallucination content)
function makeRealSpeech(startS: number): TranscriptInput['words'] {
  const sentence =
    'Welcome to the AT Protocol conference today we are discussing distributed social networking';
  return makeWords(sentence, 1, startS);
}

describe('detectHallucinationZones', () => {
  describe('pattern matching', () => {
    it('detects CastingWords attribution loops (3+ repeats)', () => {
      const words = makeWords('Transcription by CastingWords', 5, 100);
      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 300,
        words,
      };
      const zones = detectHallucinationZones(transcript, emptyDiarization());
      expect(zones.length).toBeGreaterThan(0);
      expect(zones[0].pattern).toMatch(/castingwords/i);
    });

    it('detects otter.ai attribution loops (3+ repeats)', () => {
      const words = makeWords('otter.ai automatic transcription', 4, 200);
      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 400,
        words,
      };
      const zones = detectHallucinationZones(transcript, emptyDiarization());
      expect(zones.length).toBeGreaterThan(0);
      expect(zones[0].pattern).toMatch(/otter\.ai/i);
    });

    it('does NOT flag a pattern that appears fewer than 3 times', () => {
      const words = makeWords('Transcription by CastingWords', 2, 100);
      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 300,
        words,
      };
      const zones = detectHallucinationZones(transcript, emptyDiarization());
      expect(zones.filter((z) => /castingwords/i.test(z.pattern))).toHaveLength(0);
    });

    it('detects Thank you for watching loops', () => {
      const words = makeWords('Thank you for watching', 6, 50);
      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 200,
        words,
      };
      const zones = detectHallucinationZones(transcript, emptyDiarization());
      expect(zones.length).toBeGreaterThan(0);
      expect(zones[0].pattern).toMatch(/thank you for watching/i);
    });
  });

  describe('numeric zero loops', () => {
    it('detects 20+ consecutive zero words', () => {
      const words = makeZeroWords(25, 500);
      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 1000,
        words,
      };
      const zones = detectHallucinationZones(transcript, emptyDiarization());
      expect(zones.length).toBeGreaterThan(0);
      expect(zones[0].pattern).toBe('numeric zero loop');
      expect(zones[0].startS).toBeCloseTo(500, 0);
    });

    it('does NOT flag fewer than 20 consecutive zeros', () => {
      const words = makeZeroWords(15, 500);
      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 1000,
        words,
      };
      const zones = detectHallucinationZones(transcript, emptyDiarization());
      expect(zones.filter((z) => z.pattern === 'numeric zero loop')).toHaveLength(0);
    });

    it('detects exactly 20 zeros', () => {
      const words = makeZeroWords(20, 100);
      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 500,
        words,
      };
      const zones = detectHallucinationZones(transcript, emptyDiarization());
      expect(zones.filter((z) => z.pattern === 'numeric zero loop')).toHaveLength(1);
    });

    it('correctly identifies time range of zero loop', () => {
      const words = makeZeroWords(30, 1000);
      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 2000,
        words,
      };
      const zones = detectHallucinationZones(transcript, emptyDiarization());
      const zeroZone = zones.find((z) => z.pattern === 'numeric zero loop');
      expect(zeroZone).toBeDefined();
      expect(zeroZone!.startS).toBeGreaterThanOrEqual(1000);
      expect(zeroZone!.endS).toBeLessThanOrEqual(1000 + 30 * 0.5 + 5);
    });
  });

  describe('diarization silence mismatch', () => {
    it('detects transcript words during a 60s+ diarization gap', () => {
      // Diarization: speaker active 0-100, then gap, then 200-300
      const diarization = makeDiarization([
        { start: 0, end: 100, speaker: 'SPEAKER_00' },
        { start: 200, end: 300, speaker: 'SPEAKER_00' },
      ]);

      // Transcript has words during the 100-200 gap
      const gapWords = makeWords('some garbled text here', 3, 120);
      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 300,
        words: gapWords,
      };

      const zones = detectHallucinationZones(transcript, diarization);
      expect(zones.length).toBeGreaterThan(0);
      expect(zones[0].pattern).toBe('diarization silence mismatch');
      expect(zones[0].startS).toBeGreaterThanOrEqual(120);
      expect(zones[0].endS).toBeLessThanOrEqual(200);
    });

    it('does NOT flag transcript words in a gap shorter than 60s', () => {
      // Diarization: gap of only 30s
      const diarization = makeDiarization([
        { start: 0, end: 100, speaker: 'SPEAKER_00' },
        { start: 130, end: 200, speaker: 'SPEAKER_00' },
      ]);

      const gapWords = makeWords('some text in short gap', 1, 105);
      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 200,
        words: gapWords,
      };

      const zones = detectHallucinationZones(transcript, diarization);
      expect(
        zones.filter((z) => z.pattern === 'diarization silence mismatch'),
      ).toHaveLength(0);
    });

    it('does NOT flag when transcript words are outside the silence gap', () => {
      const diarization = makeDiarization([
        { start: 0, end: 100, speaker: 'SPEAKER_00' },
        { start: 200, end: 300, speaker: 'SPEAKER_00' },
      ]);

      // Words are BEFORE the gap starts
      const words = makeWords('real speech here', 2, 50);
      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 300,
        words,
      };

      const zones = detectHallucinationZones(transcript, diarization);
      expect(
        zones.filter((z) => z.pattern === 'diarization silence mismatch'),
      ).toHaveLength(0);
    });
  });

  describe('does NOT flag real speech as hallucination', () => {
    it('returns no zones for a clean transcript with matching diarization', () => {
      const words = makeRealSpeech(0);
      // Extend with more real speech
      const moreWords = makeRealSpeech(30);
      const allWords = [...words, ...moreWords];

      const diarization = makeDiarization([
        { start: 0, end: 60, speaker: 'SPEAKER_00' },
      ]);

      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 60,
        words: allWords,
      };

      const zones = detectHallucinationZones(transcript, diarization);
      expect(zones).toHaveLength(0);
    });

    it('returns no zones for empty transcript', () => {
      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 300,
        words: [],
      };
      const zones = detectHallucinationZones(transcript, emptyDiarization());
      expect(zones).toHaveLength(0);
    });
  });

  describe('zone merging', () => {
    it('merges overlapping zones from different detectors', () => {
      // Zero loop followed by CastingWords within 60s
      const zeroWords = makeZeroWords(25, 100);
      const castingWords = makeWords('Transcription by CastingWords', 4, 120);
      const allWords = [...zeroWords, ...castingWords];

      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 300,
        words: allWords,
      };

      const zones = detectHallucinationZones(transcript, emptyDiarization());
      // Should be merged into 1 zone or at most 2 (within 60s merge window)
      expect(zones.length).toBeLessThanOrEqual(2);
    });

    it('does NOT merge zones more than 60s apart', () => {
      // Two separate zero loops 120s apart
      const zeroWords1 = makeZeroWords(25, 100);
      const zeroWords2 = makeZeroWords(25, 300); // 300 - (100 + ~10) > 60s
      const allWords = [...zeroWords1, ...zeroWords2];

      const transcript: TranscriptInput = {
        stream: 'test',
        duration_seconds: 500,
        words: allWords,
      };

      const zones = detectHallucinationZones(transcript, emptyDiarization());
      expect(zones.length).toBe(2);
    });
  });
});
