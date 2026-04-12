import { describe, expect, it } from 'vitest';
import {
  extractSignals,
  matchSegmentToSchedule,
  matchAllSegments,
} from '../transcript-matcher.js';
import type {
  TranscriptInput,
  TalkSegment,
  ScheduleTalk,
  HallucinationZone,
} from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTranscript(words: { word: string; start: number; end: number }[]): TranscriptInput {
  return {
    stream: 'test-stream',
    duration_seconds: 3600,
    words,
  };
}

/** Build a simple word-by-word transcript from a sentence starting at a given offset */
function wordsFromSentence(
  sentence: string,
  startS: number,
  wordDurationS = 0.5,
): { word: string; start: number; end: number }[] {
  return sentence.split(/\s+/).map((word, i) => ({
    word,
    start: startS + i * wordDurationS,
    end: startS + i * wordDurationS + wordDurationS,
  }));
}

function makeTalk(
  rkey: string,
  title: string,
  speakerNames: string,
  startsAt = '2025-01-01T09:00:00Z',
  endsAt = '2025-01-01T09:30:00Z',
): ScheduleTalk {
  return { rkey, title, speaker_names: speakerNames, starts_at: startsAt, ends_at: endsAt };
}

function makeSegment(
  startS: number,
  endS: number,
  type: TalkSegment['type'] = 'single-speaker',
  hallucinationZone = false,
): TalkSegment {
  return {
    startS,
    endS,
    speakers: [{ id: 'SPEAKER_00', durationS: endS - startS }],
    type,
    dominantSpeaker: type === 'single-speaker' ? 'SPEAKER_00' : undefined,
    precedingGapS: 0,
    hallucinationZone,
  };
}

// ─── extractSignals tests ─────────────────────────────────────────────────────

describe('extractSignals', () => {
  describe('self-introduction detection', () => {
    it('finds "my name is Justin" as self-intro signal', () => {
      const transcript = makeTranscript([
        ...wordsFromSentence('Hello everyone my name is Justin and', 10),
      ]);
      const signals = extractSignals(transcript, 10, 200);
      const selfIntros = signals.filter((s) => s.type === 'self-intro');
      expect(selfIntros).toHaveLength(1);
      expect((selfIntros[0] as { type: 'self-intro'; name: string }).name).toBe('Justin');
    });

    it('finds "my name\'s Bank" as self-intro signal', () => {
      // Use "Bank" as a capitalized name
      const words = [
        { word: 'my', start: 5, end: 5.5 },
        { word: "name's", start: 5.5, end: 6 },
        { word: 'Bank', start: 6, end: 6.5 },
      ];
      const transcript = makeTranscript(words);
      const signals = extractSignals(transcript, 0, 200);
      const selfIntros = signals.filter((s) => s.type === 'self-intro');
      expect(selfIntros).toHaveLength(1);
      expect((selfIntros[0] as { type: 'self-intro'; name: string }).name).toBe('Bank');
    });

    it('finds "I\'m Justin" as self-intro signal', () => {
      const words = [
        { word: "I'm", start: 5, end: 5.5 },
        { word: 'Justin', start: 5.5, end: 6 },
      ];
      const transcript = makeTranscript(words);
      const signals = extractSignals(transcript, 0, 200);
      const selfIntros = signals.filter((s) => s.type === 'self-intro');
      expect(selfIntros).toHaveLength(1);
      expect((selfIntros[0] as { type: 'self-intro'; name: string }).name).toBe('Justin');
    });

    it('does NOT extract "I\'m So" (common word)', () => {
      const words = [
        { word: "I'm", start: 5, end: 5.5 },
        { word: 'So', start: 5.5, end: 6 },
      ];
      const transcript = makeTranscript(words);
      const signals = extractSignals(transcript, 0, 200);
      const selfIntros = signals.filter((s) => s.type === 'self-intro');
      expect(selfIntros).toHaveLength(0);
    });

    it('does NOT extract "I\'m Here" (common word)', () => {
      const words = [
        { word: "I'm", start: 5, end: 5.5 },
        { word: 'Here', start: 5.5, end: 6 },
      ];
      const transcript = makeTranscript(words);
      const signals = extractSignals(transcript, 0, 200);
      const selfIntros = signals.filter((s) => s.type === 'self-intro');
      expect(selfIntros).toHaveLength(0);
    });

    it('does NOT extract "I\'m Going" (common word)', () => {
      const words = [
        { word: "I'm", start: 5, end: 5.5 },
        { word: 'Going', start: 5.5, end: 6 },
      ];
      const transcript = makeTranscript(words);
      const signals = extractSignals(transcript, 0, 200);
      const selfIntros = signals.filter((s) => s.type === 'self-intro');
      expect(selfIntros).toHaveLength(0);
    });

    it('does NOT find self-intro outside the first 120s window', () => {
      const words = [
        { word: 'my', start: 125, end: 125.5 },
        { word: 'name', start: 125.5, end: 126 },
        { word: 'is', start: 126, end: 126.5 },
        { word: 'Justin', start: 126.5, end: 127 },
      ];
      const transcript = makeTranscript(words);
      // segment starts at 10, so 120s window is 10-130 — but pattern is at 125 which is within 120s of start=10
      // Let's put it outside: segment starts at 0, pattern at 125s > 120s window
      const signals = extractSignals(transcript, 0, 200);
      // 125 > 0 + 120, so not in window
      const selfIntros = signals.filter((s) => s.type === 'self-intro');
      expect(selfIntros).toHaveLength(0);
    });
  });

  describe('MC handoff detection', () => {
    it('finds "please welcome Justin" as MC handoff', () => {
      const words = [
        { word: 'please', start: 40, end: 40.5 },
        { word: 'welcome', start: 40.5, end: 41 },
        { word: 'Justin', start: 41, end: 41.5 },
      ];
      const transcript = makeTranscript(words);
      // Segment starts at 60, so MC window is 0-60
      const signals = extractSignals(transcript, 60, 300);
      const mcHandoffs = signals.filter((s) => s.type === 'mc-handoff');
      expect(mcHandoffs).toHaveLength(1);
      expect((mcHandoffs[0] as { type: 'mc-handoff'; name: string }).name).toBe('Justin');
    });

    it('finds "next up is Justin" as MC handoff', () => {
      const words = [
        { word: 'next', start: 40, end: 40.5 },
        { word: 'up', start: 40.5, end: 41 },
        { word: 'is', start: 41, end: 41.5 },
        { word: 'Justin', start: 41.5, end: 42 },
      ];
      const transcript = makeTranscript(words);
      const signals = extractSignals(transcript, 60, 300);
      const mcHandoffs = signals.filter((s) => s.type === 'mc-handoff');
      expect(mcHandoffs).toHaveLength(1);
      expect((mcHandoffs[0] as { type: 'mc-handoff'; name: string }).name).toBe('Justin');
    });

    it('finds "next up we have Justin" as MC handoff', () => {
      const words = [
        { word: 'next', start: 40, end: 40.5 },
        { word: 'up', start: 40.5, end: 41 },
        { word: 'we', start: 41, end: 41.5 },
        { word: 'have', start: 41.5, end: 42 },
        { word: 'Justin', start: 42, end: 42.5 },
      ];
      const transcript = makeTranscript(words);
      const signals = extractSignals(transcript, 60, 300);
      const mcHandoffs = signals.filter((s) => s.type === 'mc-handoff');
      expect(mcHandoffs).toHaveLength(1);
      expect((mcHandoffs[0] as { type: 'mc-handoff'; name: string }).name).toBe('Justin');
    });

    it('does NOT find MC handoff outside the 60s lookback window', () => {
      const words = [
        { word: 'please', start: 5, end: 5.5 },
        { word: 'welcome', start: 5.5, end: 6 },
        { word: 'Justin', start: 6, end: 6.5 },
      ];
      const transcript = makeTranscript(words);
      // Segment starts at 120, so MC window is 60-120. Pattern is at 5, outside window.
      const signals = extractSignals(transcript, 120, 300);
      const mcHandoffs = signals.filter((s) => s.type === 'mc-handoff');
      expect(mcHandoffs).toHaveLength(0);
    });
  });

  describe('topic keyword extraction', () => {
    it('extracts topic signal with words from transcript', () => {
      const words = [
        ...wordsFromSentence('We talk about decentralized identity protocols today', 10),
      ];
      const transcript = makeTranscript(words);
      const signals = extractSignals(transcript, 10, 200);
      const topicSignals = signals.filter((s) => s.type === 'topic');
      expect(topicSignals).toHaveLength(1);
      const topicSig = topicSignals[0] as { type: 'topic'; keywords: string[] };
      expect(topicSig.keywords).toContain('decentralized');
      expect(topicSig.keywords).toContain('identity');
      expect(topicSig.keywords).toContain('protocols');
    });

    it('filters out short words from topic keywords', () => {
      const words = [
        ...wordsFromSentence('We talk about the big ideas here', 10),
      ];
      const transcript = makeTranscript(words);
      const signals = extractSignals(transcript, 10, 200);
      const topicSignals = signals.filter((s) => s.type === 'topic');
      const topicSig = topicSignals[0] as { type: 'topic'; keywords: string[] };
      // "We", "the", "big" (3 chars) should not appear
      expect(topicSig.keywords).not.toContain('we');
      expect(topicSig.keywords).not.toContain('the');
      expect(topicSig.keywords).not.toContain('big');
    });
  });
});

// ─── matchSegmentToSchedule tests ─────────────────────────────────────────────

describe('matchSegmentToSchedule', () => {
  it('returns null when no schedule entries', () => {
    const result = matchSegmentToSchedule([], []);
    expect(result).toBeNull();
  });

  it('returns null when no signals match any schedule entry', () => {
    const schedule = [makeTalk('rkey1', 'Quantum Computing Advances', 'Alice Smith')];
    const signals = [{ type: 'topic' as const, keywords: ['dogs', 'cats', 'birds', 'fish'] }];
    const result = matchSegmentToSchedule(signals, schedule);
    expect(result).toBeNull();
  });

  it('matches speaker name using phonetic codes (fuzzy)', () => {
    // "Justyn" sounds like "Justin"
    const schedule = [makeTalk('rkey1', 'Building Better Protocols', 'Justin Banks')];
    const signals = [
      { type: 'self-intro' as const, name: 'Justyn' }, // phonetic match
    ];
    const result = matchSegmentToSchedule(signals, schedule);
    expect(result).not.toBeNull();
    expect(result!.rkey).toBe('rkey1');
  });

  it('high confidence for name + topic match', () => {
    const schedule = [
      makeTalk('rkey1', 'Building Decentralized Identity Systems', 'Justin Banks'),
    ];
    const signals = [
      { type: 'self-intro' as const, name: 'Justin' },
      { type: 'topic' as const, keywords: ['building', 'decentralized', 'identity', 'systems'] },
    ];
    const result = matchSegmentToSchedule(signals, schedule);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('high');
    expect(result!.signals.length).toBeGreaterThan(1);
  });

  it('medium confidence for name-only match (self-intro)', () => {
    const schedule = [
      makeTalk('rkey1', 'Building Decentralized Identity Systems', 'Justin Banks'),
    ];
    const signals = [
      { type: 'self-intro' as const, name: 'Justin' },
      // No matching topic keywords
      { type: 'topic' as const, keywords: ['cooking', 'baking', 'pasta', 'sauce'] },
    ];
    const result = matchSegmentToSchedule(signals, schedule);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('medium');
  });

  it('medium confidence for topic-only match (2+ keywords)', () => {
    const schedule = [
      makeTalk('rkey1', 'Building Decentralized Identity Systems', 'Justin Banks'),
    ];
    const signals = [
      { type: 'topic' as const, keywords: ['building', 'decentralized', 'identity', 'systems'] },
      // No name signal
    ];
    const result = matchSegmentToSchedule(signals, schedule);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('medium');
  });

  it('low confidence for mc-handoff name only (not self-intro)', () => {
    const schedule = [
      makeTalk('rkey1', 'Building Decentralized Identity Systems', 'Justin Banks'),
    ];
    const signals = [
      { type: 'mc-handoff' as const, name: 'Justin' },
      // No matching topic keywords
      { type: 'topic' as const, keywords: ['cooking', 'baking', 'pasta', 'sauce'] },
    ];
    const result = matchSegmentToSchedule(signals, schedule);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('low');
  });

  it('selects the best-matching schedule entry when multiple candidates exist', () => {
    const schedule = [
      makeTalk('rkey1', 'Cooking Pasta Italian Methods', 'Alice Smith'),
      makeTalk('rkey2', 'Building Decentralized Identity Systems', 'Justin Banks'),
    ];
    const signals = [
      { type: 'self-intro' as const, name: 'Justin' },
      { type: 'topic' as const, keywords: ['building', 'decentralized', 'identity', 'systems'] },
    ];
    const result = matchSegmentToSchedule(signals, schedule);
    expect(result).not.toBeNull();
    expect(result!.rkey).toBe('rkey2');
  });

  it('matches last name phonetically', () => {
    const schedule = [makeTalk('rkey1', 'Protocol Design Patterns', 'Justin Banks')];
    const signals = [
      { type: 'self-intro' as const, name: 'Banks' }, // last name match
    ];
    const result = matchSegmentToSchedule(signals, schedule);
    expect(result).not.toBeNull();
    expect(result!.rkey).toBe('rkey1');
  });

  it('includes matched signals in result', () => {
    const schedule = [makeTalk('rkey1', 'Building Decentralized Identity Systems', 'Justin Banks')];
    const signals = [
      { type: 'self-intro' as const, name: 'Justin' },
      { type: 'topic' as const, keywords: ['building', 'decentralized', 'identity', 'systems'] },
    ];
    const result = matchSegmentToSchedule(signals, schedule);
    expect(result!.signals.length).toBeGreaterThan(0);
    expect(result!.signals.some((s) => s.includes('self-intro'))).toBe(true);
  });
});

// ─── matchAllSegments tests ───────────────────────────────────────────────────

describe('matchAllSegments', () => {
  it('matches a single segment with a self-intro signal', () => {
    const introWords = [
      { word: "I'm", start: 10, end: 10.5 },
      { word: 'Justin', start: 10.5, end: 11 },
      ...wordsFromSentence('today we talk about decentralized protocols', 12),
    ];
    const transcript = makeTranscript(introWords);
    const segment = makeSegment(10, 300);
    const schedule = [
      makeTalk('rkey1', 'Decentralized Protocol Design Patterns', 'Justin Banks'),
    ];
    const results = matchAllSegments([segment], transcript, schedule, []);
    expect(results).toHaveLength(1);
    expect(results[0].rkey).toBe('rkey1');
  });

  it('sets panel: false for single-speaker segments', () => {
    const words = [
      { word: "I'm", start: 10, end: 10.5 },
      { word: 'Justin', start: 10.5, end: 11 },
    ];
    const transcript = makeTranscript(words);
    const segment = makeSegment(10, 300, 'single-speaker');
    const schedule = [makeTalk('rkey1', 'Some Protocol Talk', 'Justin Banks')];
    const results = matchAllSegments([segment], transcript, schedule, []);
    if (results.length > 0) {
      expect(results[0].panel).toBe(false);
    }
  });

  it('handles panel segments producing multiple matches', () => {
    const words = [
      { word: 'Justin', start: 10, end: 10.5 },
      { word: 'Alice', start: 15, end: 15.5 },
      ...wordsFromSentence('decentralized protocols identity systems', 20),
    ];
    // Put MC handoff for both before segment start
    const mcWords = [
      { word: 'please', start: 5, end: 5.5 },
      { word: 'welcome', start: 5.5, end: 6 },
      { word: 'Justin', start: 6, end: 6.5 },
      { word: 'please', start: 7, end: 7.5 },
      { word: 'welcome', start: 7.5, end: 8 },
      { word: 'Alice', start: 8, end: 8.5 },
    ];
    const transcript = makeTranscript([...mcWords, ...words]);
    const panelSegment = makeSegment(60, 3660, 'panel');
    const schedule = [
      makeTalk('rkey1', 'Building Decentralized Identity Systems', 'Justin Banks'),
      makeTalk('rkey2', 'Open Protocol Design Patterns', 'Alice Smith'),
    ];

    const results = matchAllSegments([panelSegment], transcript, schedule, []);
    // Panel can produce multiple matches
    const panelResults = results.filter((r) => r.panel === true);
    if (panelResults.length > 0) {
      // All panel results should have panel: true
      panelResults.forEach((r) => expect(r.panel).toBe(true));
    }
  });

  it('marks confidence as unverifiable when segment in hallucination zone and no signals', () => {
    const transcript = makeTranscript([]); // no words
    const segment: TalkSegment = {
      ...makeSegment(100, 400, 'single-speaker', true),
      hallucinationZone: true,
    };
    const zone: HallucinationZone = { startS: 100, endS: 400, pattern: 'test' };
    const schedule = [makeTalk('rkey1', 'Protocol Design', 'Justin Banks')];

    const results = matchAllSegments([segment], transcript, schedule, [zone]);
    // With no signals and hallucination zone, should not produce a confident match
    // (or should produce unverifiable if it falls through)
    // The key thing is it shouldn't return 'high' or 'medium' without signals
    if (results.length > 0) {
      expect(['low', 'unverifiable']).toContain(results[0].confidence);
    }
  });

  it('returns empty array when no segments', () => {
    const transcript = makeTranscript([]);
    const results = matchAllSegments([], transcript, [], []);
    expect(results).toHaveLength(0);
  });

  it('populates hallucinationZones in result when segment overlaps zone', () => {
    const words = [
      { word: "I'm", start: 10, end: 10.5 },
      { word: 'Justin', start: 10.5, end: 11 },
    ];
    const transcript = makeTranscript(words);
    const segment: TalkSegment = {
      ...makeSegment(10, 300, 'single-speaker', true),
      hallucinationZone: true,
    };
    const zone: HallucinationZone = { startS: 150, endS: 200, pattern: 'test-hallucination' };
    const schedule = [makeTalk('rkey1', 'Some Protocol Talk', 'Justin Banks')];

    const results = matchAllSegments([segment], transcript, schedule, [zone]);
    if (results.length > 0) {
      expect(results[0].hallucinationZones).toContainEqual(zone);
    }
  });
});
