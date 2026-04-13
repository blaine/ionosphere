import { describe, expect, it } from 'vitest';
import { segmentDiarization } from '../diarization-segmenter.js';
import type { DiarizationInput, HallucinationZone } from '../types.js';

// Helpers

function makeDiarization(
  segments: { start: number; end: number; speaker: string }[],
): DiarizationInput {
  const speakers = [...new Set(segments.map((s) => s.speaker))];
  return { speakers, segments, total_segments: segments.length };
}

function noZones(): HallucinationZone[] {
  return [];
}

function makeZone(startS: number, endS: number): HallucinationZone {
  return { startS, endS, pattern: 'test-pattern' };
}

describe('segmentDiarization', () => {
  describe('empty / trivial input', () => {
    it('returns empty array for empty diarization', () => {
      const result = segmentDiarization(
        { speakers: [], segments: [], total_segments: 0 },
        noZones(),
      );
      expect(result).toHaveLength(0);
    });

    it('handles single segment', () => {
      const diar = makeDiarization([{ start: 0, end: 30, speaker: 'SPEAKER_00' }]);
      const result = segmentDiarization(diar, noZones());
      expect(result).toHaveLength(1);
      expect(result[0].startS).toBe(0);
      expect(result[0].endS).toBe(30);
      expect(result[0].type).toBe('single-speaker');
      expect(result[0].dominantSpeaker).toBe('SPEAKER_00');
      expect(result[0].precedingGapS).toBe(0);
      expect(result[0].hallucinationZone).toBe(false);
    });
  });

  describe('same-speaker gap merging (< 5s)', () => {
    it('merges same-speaker segments with tiny gaps into one speech block', () => {
      const diar = makeDiarization([
        { start: 0, end: 10, speaker: 'SPEAKER_00' },
        { start: 12, end: 20, speaker: 'SPEAKER_00' }, // 2s gap — should merge
        { start: 22, end: 30, speaker: 'SPEAKER_00' }, // 2s gap — should merge
      ]);
      const result = segmentDiarization(diar, noZones());
      expect(result).toHaveLength(1);
      expect(result[0].startS).toBe(0);
      expect(result[0].endS).toBe(30);
      expect(result[0].type).toBe('single-speaker');
    });

    it('does NOT merge same-speaker segments with gap >= 5s at block level (becomes within-talk pause)', () => {
      // 5s+ gap between same speaker — creates two blocks but NOT a boundary since < 30s
      const diar = makeDiarization([
        { start: 0, end: 10, speaker: 'SPEAKER_00' },
        { start: 20, end: 30, speaker: 'SPEAKER_00' }, // 10s gap — separate block, but < 30s so within-talk
      ]);
      const result = segmentDiarization(diar, noZones());
      // Should still be one TalkSegment since 10s gap < 30s threshold for boundary
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('single-speaker');
    });
  });

  describe('session breaks (> 60s gaps)', () => {
    it('splits on a gap > 60s between any speakers', () => {
      const diar = makeDiarization([
        { start: 0, end: 30, speaker: 'SPEAKER_00' },
        { start: 130, end: 160, speaker: 'SPEAKER_01' }, // 100s gap
      ]);
      const result = segmentDiarization(diar, noZones());
      expect(result).toHaveLength(2);
      expect(result[0].endS).toBe(30);
      expect(result[1].startS).toBe(130);
    });

    it('sets precedingGapS correctly after session break', () => {
      const diar = makeDiarization([
        { start: 0, end: 30, speaker: 'SPEAKER_00' },
        { start: 130, end: 160, speaker: 'SPEAKER_01' }, // 100s gap
      ]);
      const result = segmentDiarization(diar, noZones());
      expect(result[0].precedingGapS).toBe(0);
      expect(result[1].precedingGapS).toBe(100);
    });

    it('splits on session break even with same speaker', () => {
      const diar = makeDiarization([
        { start: 0, end: 30, speaker: 'SPEAKER_00' },
        { start: 130, end: 160, speaker: 'SPEAKER_00' }, // 100s gap, same speaker
      ]);
      const result = segmentDiarization(diar, noZones());
      expect(result).toHaveLength(2);
    });
  });

  describe('talk boundaries (30-60s gaps with speaker change)', () => {
    it('splits at 30-60s gap when speaker changes', () => {
      const diar = makeDiarization([
        { start: 0, end: 30, speaker: 'SPEAKER_00' },
        { start: 75, end: 105, speaker: 'SPEAKER_01' }, // 45s gap + speaker change
      ]);
      const result = segmentDiarization(diar, noZones());
      expect(result).toHaveLength(2);
      expect(result[1].precedingGapS).toBe(45);
    });

    it('does NOT split at 30-60s gap when same speaker continues', () => {
      const diar = makeDiarization([
        { start: 0, end: 30, speaker: 'SPEAKER_00' },
        { start: 75, end: 105, speaker: 'SPEAKER_00' }, // 45s gap, same speaker — no boundary
      ]);
      const result = segmentDiarization(diar, noZones());
      expect(result).toHaveLength(1);
    });

    it('does NOT split at gap < 30s even with speaker change', () => {
      const diar = makeDiarization([
        { start: 0, end: 30, speaker: 'SPEAKER_00' },
        { start: 50, end: 80, speaker: 'SPEAKER_01' }, // 20s gap + speaker change — within-talk pause
      ]);
      const result = segmentDiarization(diar, noZones());
      expect(result).toHaveLength(1);
    });
  });

  describe('speaker classification', () => {
    it('classifies a segment as single-speaker when one speaker > 70%', () => {
      const diar = makeDiarization([
        { start: 0, end: 80, speaker: 'SPEAKER_00' }, // 80s dominant
        { start: 80, end: 100, speaker: 'SPEAKER_01' }, // 20s — within one talk
      ]);
      const result = segmentDiarization(diar, noZones());
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('single-speaker');
      expect(result[0].dominantSpeaker).toBe('SPEAKER_00');
    });

    it('classifies a segment as panel when speakers are balanced', () => {
      const diar = makeDiarization([
        { start: 0, end: 25, speaker: 'SPEAKER_00' },
        { start: 25, end: 50, speaker: 'SPEAKER_01' },
        { start: 50, end: 75, speaker: 'SPEAKER_02' },
        { start: 75, end: 100, speaker: 'SPEAKER_03' },
      ]);
      const result = segmentDiarization(diar, noZones());
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('panel');
      expect(result[0].dominantSpeaker).toBeUndefined();
    });

    it('aggregates speaker durations correctly', () => {
      const diar = makeDiarization([
        { start: 0, end: 30, speaker: 'SPEAKER_00' },
        { start: 35, end: 55, speaker: 'SPEAKER_01' },
        { start: 60, end: 90, speaker: 'SPEAKER_00' }, // SPEAKER_00 total = 60s, SPEAKER_01 = 20s
      ]);
      const result = segmentDiarization(diar, noZones());
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('single-speaker');
      expect(result[0].dominantSpeaker).toBe('SPEAKER_00');
      const s0 = result[0].speakers.find((s) => s.id === 'SPEAKER_00');
      expect(s0?.durationS).toBe(60);
    });
  });

  describe('panel detection from real data patterns', () => {
    it('treats many short alternating segments with tiny gaps as one panel segment', () => {
      // Simulate a real panel: 4 speakers, short segments, < 5s gaps
      const segments: { start: number; end: number; speaker: string }[] = [];
      const speakers = ['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_02', 'SPEAKER_03'];
      let t = 0;
      for (let i = 0; i < 20; i++) {
        const speaker = speakers[i % 4];
        segments.push({ start: t, end: t + 15, speaker });
        t += 15 + 2; // 2s gap — tiny, should all merge into one segment
      }
      const diar = makeDiarization(segments);
      const result = segmentDiarization(diar, noZones());
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('panel');
    });
  });

  describe('hallucination zone marking', () => {
    it('marks segment as hallucinationZone when it overlaps a zone', () => {
      const diar = makeDiarization([
        { start: 100, end: 200, speaker: 'SPEAKER_00' },
      ]);
      const zones = [makeZone(150, 180)];
      const result = segmentDiarization(diar, zones);
      expect(result).toHaveLength(1);
      expect(result[0].hallucinationZone).toBe(true);
    });

    it('does NOT mark segment when zone is outside its range', () => {
      const diar = makeDiarization([
        { start: 100, end: 200, speaker: 'SPEAKER_00' },
      ]);
      const zones = [makeZone(250, 300)];
      const result = segmentDiarization(diar, zones);
      expect(result[0].hallucinationZone).toBe(false);
    });

    it('marks only the overlapping segment, not others', () => {
      const diar = makeDiarization([
        { start: 0, end: 50, speaker: 'SPEAKER_00' },
        { start: 150, end: 200, speaker: 'SPEAKER_01' }, // 100s gap — session break
      ]);
      const zones = [makeZone(160, 180)]; // overlaps second segment only
      const result = segmentDiarization(diar, zones);
      expect(result).toHaveLength(2);
      expect(result[0].hallucinationZone).toBe(false);
      expect(result[1].hallucinationZone).toBe(true);
    });

    it('marks segment when zone partially overlaps start', () => {
      const diar = makeDiarization([
        { start: 100, end: 200, speaker: 'SPEAKER_00' },
      ]);
      const zones = [makeZone(80, 120)]; // zone starts before segment
      const result = segmentDiarization(diar, zones);
      expect(result[0].hallucinationZone).toBe(true);
    });

    it('marks segment when zone partially overlaps end', () => {
      const diar = makeDiarization([
        { start: 100, end: 200, speaker: 'SPEAKER_00' },
      ]);
      const zones = [makeZone(180, 220)]; // zone ends after segment
      const result = segmentDiarization(diar, zones);
      expect(result[0].hallucinationZone).toBe(true);
    });
  });

  describe('lightning talk pattern (multiple short sessions with 30-60s gaps)', () => {
    it('splits a series of lightning talks separated by 45s gaps with speaker changes', () => {
      const talks = [
        // Talk 1: single speaker, 20 minutes
        { start: 0, end: 1200, speaker: 'SPEAKER_00' },
        // 45s gap, new speaker
        { start: 1245, end: 2445, speaker: 'SPEAKER_01' },
        // 45s gap, new speaker
        { start: 2490, end: 3690, speaker: 'SPEAKER_02' },
      ];
      const diar = makeDiarization(talks);
      const result = segmentDiarization(diar, noZones());
      expect(result).toHaveLength(3);
      expect(result[0].dominantSpeaker).toBe('SPEAKER_00');
      expect(result[1].dominantSpeaker).toBe('SPEAKER_01');
      expect(result[2].dominantSpeaker).toBe('SPEAKER_02');
      expect(result[1].precedingGapS).toBe(45);
      expect(result[2].precedingGapS).toBe(45);
    });
  });

  describe('input ordering', () => {
    it('handles unsorted diarization segments', () => {
      // Provide segments out of order
      const diar = makeDiarization([
        { start: 200, end: 250, speaker: 'SPEAKER_01' },
        { start: 0, end: 50, speaker: 'SPEAKER_00' },
        { start: 400, end: 450, speaker: 'SPEAKER_02' }, // 150s gap — session break
      ]);
      const result = segmentDiarization(diar, noZones());
      // 200-50=150s gap between first and second would be a session break if sorted
      // But 200-50 = 150 > 60 so they split; then 400-250 = 150 > 60 so they split too
      expect(result).toHaveLength(3);
      expect(result[0].startS).toBe(0);
      expect(result[1].startS).toBe(200);
      expect(result[2].startS).toBe(400);
    });
  });
});
