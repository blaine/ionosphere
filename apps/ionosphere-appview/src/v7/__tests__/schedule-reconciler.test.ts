import { describe, expect, it } from 'vitest';
import { reconcileSchedule } from '../schedule-reconciler.js';
import type {
  BoundaryMatch,
  HallucinationZone,
  ScheduleTalk,
  TalkSegment,
} from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMatch(
  rkey: string,
  startTimestamp: number,
  confidence: BoundaryMatch['confidence'] = 'high',
  signals: string[] = ['self-intro:Alice'],
): BoundaryMatch {
  return {
    rkey,
    title: `Talk ${rkey}`,
    startTimestamp,
    endTimestamp: null,
    confidence,
    signals,
    panel: false,
    hallucinationZones: [],
  };
}

function makeSegment(
  startS: number,
  endS: number,
  hallucinationZone = false,
): TalkSegment {
  return {
    startS,
    endS,
    speakers: [{ id: 'SPEAKER_00', durationS: endS - startS }],
    type: 'single-speaker',
    dominantSpeaker: 'SPEAKER_00',
    precedingGapS: 0,
    hallucinationZone,
  };
}

function makeTalk(
  rkey: string,
  startsAt = '2026-03-28T09:00:00Z',
  endsAt = '2026-03-28T09:30:00Z',
): ScheduleTalk {
  return {
    rkey,
    title: `Talk ${rkey}`,
    starts_at: startsAt,
    ends_at: endsAt,
    speaker_names: 'Alice Smith',
  };
}

function makeZone(startS: number, endS: number): HallucinationZone {
  return { startS, endS, pattern: 'test pattern' };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('reconcileSchedule', () => {
  describe('empty inputs', () => {
    it('handles all-empty inputs gracefully', () => {
      const output = reconcileSchedule([], [], [], [], 3600, 'test-stream');
      expect(output.stream).toBe('test-stream');
      expect(output.results).toHaveLength(0);
      expect(output.unmatchedSegments).toHaveLength(0);
      expect(output.unmatchedSchedule).toHaveLength(0);
      expect(output.hallucinationZones).toHaveLength(0);
    });

    it('handles matches with no schedule', () => {
      const matches = [makeMatch('talk-1', 100), makeMatch('talk-2', 500)];
      const segments = [makeSegment(100, 490), makeSegment(500, 900)];
      const output = reconcileSchedule(matches, segments, [], [], 3600, 'test-stream');
      expect(output.results).toHaveLength(2);
      expect(output.unmatchedSchedule).toHaveLength(0);
    });
  });

  describe('deduplication', () => {
    it('deduplicates same rkey and keeps the highest confidence match', () => {
      const matches = [
        makeMatch('talk-1', 100, 'low'),
        makeMatch('talk-1', 200, 'high'),
        makeMatch('talk-1', 150, 'medium'),
      ];
      const segments = [makeSegment(100, 900)];
      const output = reconcileSchedule(matches, segments, [], [], 3600, 'test-stream');

      const talk1Results = output.results.filter((r) => r.rkey === 'talk-1');
      expect(talk1Results).toHaveLength(1);
      expect(talk1Results[0].confidence).toBe('high');
    });

    it('deduplicates same rkey: same confidence keeps earlier start', () => {
      const matches = [
        makeMatch('talk-1', 300, 'medium'),
        makeMatch('talk-1', 100, 'medium'),
      ];
      const segments = [makeSegment(100, 900)];
      const output = reconcileSchedule(matches, segments, [], [], 3600, 'test-stream');

      const talk1Results = output.results.filter((r) => r.rkey === 'talk-1');
      expect(talk1Results).toHaveLength(1);
      expect(talk1Results[0].startTimestamp).toBe(100);
    });
  });

  describe('end time computation', () => {
    it('computes end time from next talk start (gap <= 60s)', () => {
      // Gap of 30s between talks — should use next start, not segment end
      const matches = [makeMatch('talk-1', 100), makeMatch('talk-2', 130)];
      const segments = [makeSegment(100, 125), makeSegment(130, 400)];
      const output = reconcileSchedule(matches, segments, [], [], 3600, 'test-stream');

      const talk1 = output.results.find((r) => r.rkey === 'talk-1');
      expect(talk1?.endTimestamp).toBe(130);
    });

    it('last talk gets stream duration as end (when segment end > stream duration)', () => {
      const matches = [makeMatch('talk-1', 100), makeMatch('talk-2', 500)];
      const segments = [makeSegment(100, 490), makeSegment(500, 9999)];
      const streamDurationS = 3600;
      const output = reconcileSchedule(matches, segments, [], [], streamDurationS, 'test-stream');

      const talk2 = output.results.find((r) => r.rkey === 'talk-2');
      expect(talk2?.endTimestamp).toBe(streamDurationS);
    });

    it('last talk uses segment endS when smaller than stream duration', () => {
      const matches = [makeMatch('talk-1', 100), makeMatch('talk-2', 500)];
      const segments = [makeSegment(100, 490), makeSegment(500, 800)];
      const streamDurationS = 3600;
      const output = reconcileSchedule(matches, segments, [], [], streamDurationS, 'test-stream');

      const talk2 = output.results.find((r) => r.rkey === 'talk-2');
      expect(talk2?.endTimestamp).toBe(800);
    });

    it('session break: last talk before break gets segment end, not next session start', () => {
      // talk-1 ends (segment) at 490, but next talk starts at 700 (gap = 600s > 60s)
      const matches = [
        makeMatch('talk-1', 100),
        makeMatch('talk-3', 700), // next session after a large break
      ];
      const segments = [
        makeSegment(100, 490), // talk-1's segment
        makeSegment(700, 1100),
      ];
      const output = reconcileSchedule(matches, segments, [], [], 3600, 'test-stream');

      const talk1 = output.results.find((r) => r.rkey === 'talk-1');
      // gap is 600s > SESSION_BREAK_GAP_S (60s) → should use segment endS (490)
      expect(talk1?.endTimestamp).toBe(490);

      // talk-3 is the last, should get min(streamDuration, segEnd)
      const talk3 = output.results.find((r) => r.rkey === 'talk-3');
      expect(talk3?.endTimestamp).toBe(1100);
    });

    it('no session break: small gap uses next talk start', () => {
      const matches = [
        makeMatch('talk-1', 100),
        makeMatch('talk-2', 140), // gap = 40s, not a session break
      ];
      const segments = [makeSegment(100, 135), makeSegment(140, 400)];
      const output = reconcileSchedule(matches, segments, [], [], 3600, 'test-stream');

      const talk1 = output.results.find((r) => r.rkey === 'talk-1');
      expect(talk1?.endTimestamp).toBe(140);
    });
  });

  describe('unmatched schedule entries', () => {
    it('unmatched schedule talk outside hallucination zone → unmatchedSchedule list', () => {
      const schedule = [makeTalk('talk-1'), makeTalk('talk-unmatched')];
      const matches = [makeMatch('talk-1', 100)];
      const segments = [makeSegment(100, 500)];

      const output = reconcileSchedule(matches, segments, schedule, [], 3600, 'test-stream');

      expect(output.unmatchedSchedule).toContain('talk-unmatched');
      expect(output.results.find((r) => r.rkey === 'talk-unmatched')).toBeUndefined();
    });

    it('unmatched schedule in hallucination zone → unverifiable result', () => {
      // Stream starts at Unix epoch 1743066000 (2026-03-27T09:00:00Z)
      // talk-unmatched starts_at = 2026-03-27T09:30:00Z = epoch +1800s
      const streamStartUnixS = 1743066000; // 2026-03-27T09:00:00Z

      // Hallucination zone at stream-relative 1800-2400s
      const zones: HallucinationZone[] = [makeZone(1800, 2400)];

      // talk starts at 2026-03-27T09:30:00Z → relative offset 1800s
      const talkStartsAt = new Date(streamStartUnixS * 1000 + 1800 * 1000).toISOString();
      const schedule = [makeTalk('talk-unmatched', talkStartsAt)];
      const matches: BoundaryMatch[] = [];
      const segments: TalkSegment[] = [];

      const output = reconcileSchedule(
        matches, segments, schedule, zones, 3600, 'test-stream', streamStartUnixS,
      );

      expect(output.unmatchedSchedule).not.toContain('talk-unmatched');
      const unverifiable = output.results.find((r) => r.rkey === 'talk-unmatched');
      expect(unverifiable).toBeDefined();
      expect(unverifiable?.confidence).toBe('unverifiable');
    });

    it('unmatched schedule with no streamStartUnixS → goes to unmatchedSchedule (safe default)', () => {
      const zones: HallucinationZone[] = [makeZone(1800, 2400)];
      const schedule = [makeTalk('talk-unmatched')];
      const output = reconcileSchedule([], [], schedule, zones, 3600, 'test-stream');
      // No streamStartUnixS means zone check is disabled
      expect(output.unmatchedSchedule).toContain('talk-unmatched');
    });
  });

  describe('unmatched segments', () => {
    it('segments with no BoundaryMatch → unmatchedSegments', () => {
      const matches = [makeMatch('talk-1', 100)];
      const segments = [
        makeSegment(100, 500),  // matched (talk-1)
        makeSegment(600, 900),  // unmatched
      ];
      const output = reconcileSchedule(matches, segments, [], [], 3600, 'test-stream');

      expect(output.unmatchedSegments).toHaveLength(1);
      expect(output.unmatchedSegments[0].startS).toBe(600);
    });

    it('all segments matched → empty unmatchedSegments', () => {
      const matches = [makeMatch('talk-1', 100), makeMatch('talk-2', 500)];
      const segments = [makeSegment(100, 490), makeSegment(500, 900)];
      const output = reconcileSchedule(matches, segments, [], [], 3600, 'test-stream');

      expect(output.unmatchedSegments).toHaveLength(0);
    });
  });

  describe('output assembly', () => {
    it('results are sorted by startTimestamp', () => {
      const matches = [
        makeMatch('talk-2', 500),
        makeMatch('talk-1', 100),
        makeMatch('talk-3', 900),
      ];
      const segments = [
        makeSegment(100, 490),
        makeSegment(500, 890),
        makeSegment(900, 1200),
      ];
      const output = reconcileSchedule(matches, segments, [], [], 3600, 'test-stream');

      const starts = output.results.map((r) => r.startTimestamp);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
    });

    it('includes hallucinationZones in output', () => {
      const zones = [makeZone(100, 200)];
      const output = reconcileSchedule([], [], [], zones, 3600, 'test-stream');
      expect(output.hallucinationZones).toHaveLength(1);
      expect(output.hallucinationZones[0].startS).toBe(100);
    });

    it('sets stream name on output', () => {
      const output = reconcileSchedule([], [], [], [], 3600, 'great-hall-day-1');
      expect(output.stream).toBe('great-hall-day-1');
    });
  });
});
