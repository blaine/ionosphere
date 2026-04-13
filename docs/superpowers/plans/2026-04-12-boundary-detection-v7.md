# Boundary Detection v7 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace transcript-gap-based boundary detection with a diarization-first pipeline that avoids hallucination zones and cross-track errors.

**Architecture:** Three-stage pipeline — diarization segmentation builds talk-shaped segments from audio, transcript content matching identifies which talk each segment contains, schedule reconciliation fills gaps and outputs v6-compatible JSON. Reuses `phonetic.ts` and `db.ts` from existing codebase.

**Tech Stack:** TypeScript, better-sqlite3 (existing DB), vitest (existing test runner)

**Spec:** `docs/superpowers/specs/2026-04-12-boundary-detection-v7-design.md`
**Verification notes:** `docs/alignment-verification-notes.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/detect-boundaries-v7.ts` | CLI entry point, orchestrates pipeline |
| `src/v7/diarization-segmenter.ts` | Stage 1: parse diarization, build talk segments, detect hallucination |
| `src/v7/transcript-matcher.ts` | Stage 2: extract identity signals, match segments to schedule |
| `src/v7/schedule-reconciler.ts` | Stage 3: resolve conflicts, fill gaps, compute end times |
| `src/v7/hallucination-detector.ts` | Detect known hallucination patterns in transcript |
| `src/v7/types.ts` | Shared interfaces: TalkSegment, BoundaryMatch, HallucinationZone, etc. |
| `src/v7/__tests__/diarization-segmenter.test.ts` | Tests for Stage 1 |
| `src/v7/__tests__/transcript-matcher.test.ts` | Tests for Stage 2 |
| `src/v7/__tests__/schedule-reconciler.test.ts` | Tests for Stage 3 |
| `src/v7/__tests__/hallucination-detector.test.ts` | Tests for hallucination detection |

Reused from existing code:
- `src/phonetic.ts` — fuzzy speaker name matching
- `src/db.ts` — SQLite access for schedule data
- `src/tracks.ts` — `STREAM_MATCH` config, `STREAMS` config, `DAY_DATES`

---

## Chunk 1: Types + Hallucination Detection

### Task 1: Shared Types

**Files:**
- Create: `src/v7/types.ts`

- [ ] **Step 1: Create type definitions**

```ts
// src/v7/types.ts

export interface DiarizationInput {
  speakers: string[];
  segments: { start: number; end: number; speaker: string }[];
  total_segments: number;
}

export interface TranscriptInput {
  stream: string;
  duration_seconds: number;
  words: { word: string; start: number; end: number; speaker?: string; confidence?: number }[];
}

export interface TalkSegment {
  startS: number;
  endS: number;
  speakers: { id: string; durationS: number }[];
  type: 'single-speaker' | 'panel' | 'unknown';
  dominantSpeaker?: string;
  precedingGapS: number;
  hallucinationZone: boolean;
}

export interface HallucinationZone {
  startS: number;
  endS: number;
  pattern: string;
}

export interface ScheduleTalk {
  rkey: string;
  title: string;
  starts_at: string;
  ends_at: string;
  speaker_names: string;
}

export interface BoundaryMatch {
  rkey: string;
  title: string;
  startTimestamp: number;  // seconds — v6 compat field name
  endTimestamp: number | null;
  confidence: 'high' | 'medium' | 'low' | 'unverifiable';
  signals: string[];
  panel: boolean;
  hallucinationZones: HallucinationZone[];
}

export interface V7Output {
  stream: string;
  results: BoundaryMatch[];
  hallucinationZones: HallucinationZone[];
  unmatchedSegments: TalkSegment[];
  unmatchedSchedule: string[];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/v7/types.ts
git commit -m "feat(v7): shared type definitions for boundary detection pipeline"
```

### Task 2: Hallucination Detector

**Files:**
- Create: `src/v7/hallucination-detector.ts`
- Create: `src/v7/__tests__/hallucination-detector.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/v7/__tests__/hallucination-detector.test.ts
import { describe, it, expect } from "vitest";
import { detectHallucinationZones } from "../hallucination-detector.js";
import type { TranscriptInput, DiarizationInput } from "../types.js";

describe("detectHallucinationZones", () => {
  it("detects CastingWords loops", () => {
    const words = Array.from({ length: 30 }, (_, i) => ({
      word: ["Transcription", "by", "CastingWords"][i % 3],
      start: 100 + i * 0.5,
      end: 100 + i * 0.5 + 0.3,
    }));
    const zones = detectHallucinationZones(
      { stream: "test", duration_seconds: 200, words } as TranscriptInput,
      { speakers: [], segments: [], total_segments: 0 }  // no diarization speech
    );
    expect(zones.length).toBeGreaterThan(0);
    expect(zones[0].pattern).toContain("CastingWords");
  });

  it("detects numeric zero loops", () => {
    const words = Array.from({ length: 50 }, (_, i) => ({
      word: "0",
      start: 200 + i * 0.2,
      end: 200 + i * 0.2 + 0.1,
    }));
    const zones = detectHallucinationZones(
      { stream: "test", duration_seconds: 300, words } as TranscriptInput,
      { speakers: [], segments: [], total_segments: 0 }
    );
    expect(zones.length).toBeGreaterThan(0);
    expect(zones[0].pattern).toContain("zero");
  });

  it("detects diarization silence with transcript words", () => {
    // Transcript has words from 100-200s, but diarization has no segments there
    const words = Array.from({ length: 20 }, (_, i) => ({
      word: "hello",
      start: 100 + i * 5,
      end: 100 + i * 5 + 1,
    }));
    const diarization: DiarizationInput = {
      speakers: ["SPEAKER_00"],
      segments: [
        { start: 0, end: 90, speaker: "SPEAKER_00" },
        { start: 210, end: 300, speaker: "SPEAKER_00" },
      ],
      total_segments: 2,
    };
    const zones = detectHallucinationZones(
      { stream: "test", duration_seconds: 300, words } as TranscriptInput,
      diarization
    );
    expect(zones.length).toBeGreaterThan(0);
    expect(zones[0].startS).toBeLessThanOrEqual(100);
    expect(zones[0].endS).toBeGreaterThanOrEqual(195);
  });

  it("does not flag real speech as hallucination", () => {
    const words = [
      { word: "Hello", start: 10, end: 11 },
      { word: "my", start: 11, end: 11.5 },
      { word: "name", start: 11.5, end: 12 },
      { word: "is", start: 12, end: 12.5 },
      { word: "Justin", start: 12.5, end: 13 },
    ];
    const diarization: DiarizationInput = {
      speakers: ["SPEAKER_00"],
      segments: [{ start: 9, end: 14, speaker: "SPEAKER_00" }],
      total_segments: 1,
    };
    const zones = detectHallucinationZones(
      { stream: "test", duration_seconds: 30, words } as TranscriptInput,
      diarization
    );
    expect(zones.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/ionosphere-appview && npx vitest run src/v7/__tests__/hallucination-detector.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement hallucination detector**

```ts
// src/v7/hallucination-detector.ts
import type { TranscriptInput, DiarizationInput, HallucinationZone } from "./types.js";

/** Known repeating hallucination phrases. Each entry: [pattern words, label]. */
const HALLUCINATION_PATTERNS: [string[], string][] = [
  [["Transcription", "by", "CastingWords"], "CastingWords loop"],
  [["Transcribed", "by", "https://otter"], "otter.ai loop"],
  [["Transcription", "by", "ESO"], "ESO Translation loop"],
  [["Microsoft", "Office", "Word", "Document"], "MSWord loop"],
  [["Transcripts", "provided", "by", "Transcription", "Outsourcing"], "Transcription Outsourcing loop"],
  [["UGA", "Extension", "Office"], "UGA Extension loop"],
  [["Thank", "you", "for", "watching"], "Thank you for watching loop"],
  [["Subs", "by", "www"], "subtitle attribution loop"],
  [["www", "fema", "gov"], "fema.gov loop"],
];

/** Minimum consecutive zeros to flag as hallucination. */
const ZERO_LOOP_THRESHOLD = 20;

/** Minimum repetitions of a phrase to flag as hallucination loop. */
const PHRASE_REPEAT_THRESHOLD = 3;

/**
 * Detect hallucination zones using two methods:
 * 1. Pattern matching: known repeating phrases in transcript
 * 2. Silence mismatch: diarization shows no speech but transcript has words
 */
export function detectHallucinationZones(
  transcript: TranscriptInput,
  diarization: DiarizationInput,
): HallucinationZone[] {
  const zones: HallucinationZone[] = [];

  // Method 1: Known phrase patterns
  zones.push(...detectPhrasePatterns(transcript));

  // Method 2: Numeric zero loops
  zones.push(...detectZeroLoops(transcript));

  // Method 3: Diarization silence with transcript words
  zones.push(...detectSilenceMismatch(transcript, diarization));

  // Merge overlapping zones
  return mergeZones(zones);
}

function detectPhrasePatterns(transcript: TranscriptInput): HallucinationZone[] {
  const zones: HallucinationZone[] = [];
  const words = transcript.words;

  for (const [pattern, label] of HALLUCINATION_PATTERNS) {
    let matchCount = 0;
    let firstMatchStart: number | null = null;
    let lastMatchEnd: number | null = null;

    for (let i = 0; i <= words.length - pattern.length; i++) {
      const matches = pattern.every((p, j) => words[i + j].word === p);
      if (matches) {
        matchCount++;
        if (firstMatchStart === null) firstMatchStart = words[i].start;
        lastMatchEnd = words[i + pattern.length - 1].end;
      } else if (matchCount >= PHRASE_REPEAT_THRESHOLD && firstMatchStart !== null && lastMatchEnd !== null) {
        zones.push({ startS: firstMatchStart, endS: lastMatchEnd, pattern: label });
        matchCount = 0;
        firstMatchStart = null;
        lastMatchEnd = null;
      }
    }

    if (matchCount >= PHRASE_REPEAT_THRESHOLD && firstMatchStart !== null && lastMatchEnd !== null) {
      zones.push({ startS: firstMatchStart, endS: lastMatchEnd, pattern: label });
    }
  }

  return zones;
}

function detectZeroLoops(transcript: TranscriptInput): HallucinationZone[] {
  const zones: HallucinationZone[] = [];
  let runStart: number | null = null;
  let runCount = 0;

  for (const w of transcript.words) {
    if (w.word === "0") {
      if (runStart === null) runStart = w.start;
      runCount++;
    } else {
      if (runCount >= ZERO_LOOP_THRESHOLD && runStart !== null) {
        zones.push({ startS: runStart, endS: w.start, pattern: "numeric zeros" });
      }
      runStart = null;
      runCount = 0;
    }
  }

  if (runCount >= ZERO_LOOP_THRESHOLD && runStart !== null) {
    const last = transcript.words[transcript.words.length - 1];
    zones.push({ startS: runStart, endS: last.end, pattern: "numeric zeros" });
  }

  return zones;
}

function detectSilenceMismatch(
  transcript: TranscriptInput,
  diarization: DiarizationInput,
): HallucinationZone[] {
  if (diarization.segments.length === 0) return [];

  const zones: HallucinationZone[] = [];

  // Find diarization silence gaps > 60s
  const sortedSegs = [...diarization.segments].sort((a, b) => a.start - b.start);
  const silenceGaps: { start: number; end: number }[] = [];

  for (let i = 1; i < sortedSegs.length; i++) {
    const gap = sortedSegs[i].start - sortedSegs[i - 1].end;
    if (gap > 60) {
      silenceGaps.push({ start: sortedSegs[i - 1].end, end: sortedSegs[i].start });
    }
  }

  // Check if transcript has words during these silence gaps
  for (const gap of silenceGaps) {
    const wordsInGap = transcript.words.filter(
      (w) => w.start >= gap.start && w.end <= gap.end
    );
    if (wordsInGap.length > 10) {
      zones.push({
        startS: gap.start,
        endS: gap.end,
        pattern: "diarization silence with transcript words",
      });
    }
  }

  return zones;
}

function mergeZones(zones: HallucinationZone[]): HallucinationZone[] {
  if (zones.length === 0) return [];
  const sorted = [...zones].sort((a, b) => a.startS - b.startS);
  const merged: HallucinationZone[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    // Merge if overlapping or within 60s
    if (curr.startS <= prev.endS + 60) {
      prev.endS = Math.max(prev.endS, curr.endS);
      if (!prev.pattern.includes(curr.pattern)) {
        prev.pattern += " + " + curr.pattern;
      }
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/ionosphere-appview && npx vitest run src/v7/__tests__/hallucination-detector.test.ts
```

Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/v7/
git commit -m "feat(v7): hallucination detector with pattern + diarization silence detection"
```

---

## Chunk 2: Diarization Segmenter (Stage 1)

### Task 3: Diarization Segmenter

**Files:**
- Create: `src/v7/diarization-segmenter.ts`
- Create: `src/v7/__tests__/diarization-segmenter.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/v7/__tests__/diarization-segmenter.test.ts
import { describe, it, expect } from "vitest";
import { segmentDiarization } from "../diarization-segmenter.js";
import type { DiarizationInput, HallucinationZone } from "../types.js";

function makeDiarization(segments: { start: number; end: number; speaker: string }[]): DiarizationInput {
  const speakers = [...new Set(segments.map(s => s.speaker))];
  return { speakers, segments, total_segments: segments.length };
}

describe("segmentDiarization", () => {
  it("creates single-speaker segments from continuous speech with gaps", () => {
    const diar = makeDiarization([
      { start: 0, end: 1800, speaker: "SPEAKER_00" },     // Talk 1: 0-30m
      { start: 1860, end: 3600, speaker: "SPEAKER_01" },   // Talk 2: 31-60m (60s gap)
    ]);
    const result = segmentDiarization(diar, []);
    expect(result.length).toBe(2);
    expect(result[0].dominantSpeaker).toBe("SPEAKER_00");
    expect(result[1].dominantSpeaker).toBe("SPEAKER_01");
    expect(result[1].precedingGapS).toBeCloseTo(60, 0);
  });

  it("detects session breaks at gaps > 60s", () => {
    const diar = makeDiarization([
      { start: 0, end: 1800, speaker: "SPEAKER_00" },
      // 76-minute gap (break)
      { start: 6360, end: 8000, speaker: "SPEAKER_01" },
    ]);
    const result = segmentDiarization(diar, []);
    expect(result.length).toBe(2);
    expect(result[1].precedingGapS).toBeGreaterThan(4000);
  });

  it("identifies panels (multiple balanced speakers)", () => {
    const diar = makeDiarization([
      { start: 0, end: 600, speaker: "SPEAKER_00" },
      { start: 600, end: 1200, speaker: "SPEAKER_01" },
      { start: 1200, end: 1800, speaker: "SPEAKER_02" },
      { start: 1800, end: 2400, speaker: "SPEAKER_00" },
    ]);
    const result = segmentDiarization(diar, []);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("panel");
    expect(result[0].speakers.length).toBe(3);
  });

  it("marks segments overlapping hallucination zones", () => {
    const diar = makeDiarization([
      { start: 0, end: 1800, speaker: "SPEAKER_00" },
      // no diarization segments from 1800-5000 (hallucination zone)
      { start: 5000, end: 7000, speaker: "SPEAKER_01" },
    ]);
    const hallucinationZones: HallucinationZone[] = [
      { startS: 1800, endS: 5000, pattern: "CastingWords loop" },
    ];
    const result = segmentDiarization(diar, hallucinationZones);
    // Should not create a segment in the hallucination zone
    expect(result.length).toBe(2);
    expect(result[0].hallucinationZone).toBe(false);
    expect(result[1].hallucinationZone).toBe(false);
  });

  it("splits talk boundaries at 30-60s gaps with speaker changes", () => {
    const diar = makeDiarization([
      { start: 0, end: 1500, speaker: "SPEAKER_00" },
      // 45s gap + speaker change
      { start: 1545, end: 3000, speaker: "SPEAKER_01" },
    ]);
    const result = segmentDiarization(diar, []);
    expect(result.length).toBe(2);
    expect(result[0].type).toBe("single-speaker");
    expect(result[1].type).toBe("single-speaker");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/ionosphere-appview && npx vitest run src/v7/__tests__/diarization-segmenter.test.ts
```

- [ ] **Step 3: Implement diarization segmenter**

The segmenter should:
1. Sort diarization segments by start time
2. Merge same-speaker segments with < 5s gaps into speech blocks
3. Find gaps between blocks, classifying as break (>60s), boundary (30-60s + speaker change), or pause (<30s)
4. Group blocks between breaks into sessions
5. Within each session, group blocks between boundary gaps into talk segments
6. For each talk segment, compute speaker distribution and classify as single-speaker (one speaker > 70%) or panel
7. Mark any segment that overlaps a hallucination zone

Implementation in `src/v7/diarization-segmenter.ts`. Core function signature:

```ts
export function segmentDiarization(
  diarization: DiarizationInput,
  hallucinationZones: HallucinationZone[],
): TalkSegment[]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/ionosphere-appview && npx vitest run src/v7/__tests__/diarization-segmenter.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/v7/
git commit -m "feat(v7): diarization segmenter — stage 1 of pipeline"
```

---

## Chunk 3: Transcript Matcher (Stage 2)

### Task 4: Transcript Matcher

**Files:**
- Create: `src/v7/transcript-matcher.ts`
- Create: `src/v7/__tests__/transcript-matcher.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/v7/__tests__/transcript-matcher.test.ts
import { describe, it, expect } from "vitest";
import { extractSignals, matchSegmentToSchedule } from "../transcript-matcher.js";
import type { TranscriptInput, TalkSegment, ScheduleTalk } from "../types.js";

describe("extractSignals", () => {
  it("finds self-introductions", () => {
    const words = "Hello my name is Justin Bank I am a journalist".split(" ").map((w, i) => ({
      word: w, start: 100 + i, end: 101 + i,
    }));
    const signals = extractSignals({ words } as TranscriptInput, 99, 115);
    expect(signals).toContainEqual(expect.objectContaining({ type: "self-intro" }));
    expect(signals.find(s => s.type === "self-intro")?.name).toContain("Justin");
  });

  it("finds MC handoffs", () => {
    const words = "please welcome Justin for his talk".split(" ").map((w, i) => ({
      word: w, start: 90 + i, end: 91 + i,
    }));
    const signals = extractSignals({ words } as TranscriptInput, 89, 100);
    expect(signals).toContainEqual(expect.objectContaining({ type: "mc-handoff" }));
  });

  it("extracts topic keywords", () => {
    const words = "I will talk about sovereign media and how publishers can".split(" ").map((w, i) => ({
      word: w, start: 100 + i, end: 101 + i,
    }));
    const signals = extractSignals({ words } as TranscriptInput, 99, 115);
    expect(signals).toContainEqual(expect.objectContaining({ type: "topic" }));
  });
});

describe("matchSegmentToSchedule", () => {
  const schedule: ScheduleTalk[] = [
    { rkey: "talk1", title: "Sovereign Media Economics", starts_at: "2026-03-28T17:30:00Z", ends_at: "2026-03-28T18:00:00Z", speaker_names: "Natalie Mullins" },
    { rkey: "talk2", title: "AI in the Atmosphere", starts_at: "2026-03-28T18:00:00Z", ends_at: "2026-03-28T18:30:00Z", speaker_names: "Cameron Stream" },
  ];

  it("matches by speaker name + topic", () => {
    const signals = [
      { type: "self-intro" as const, name: "Natalie" },
      { type: "topic" as const, keywords: ["sovereign", "media"] },
    ];
    const match = matchSegmentToSchedule(signals, schedule);
    expect(match?.rkey).toBe("talk1");
    expect(match?.confidence).toBe("high");
  });

  it("returns medium confidence for speaker-only match", () => {
    const signals = [{ type: "self-intro" as const, name: "Cameron" }];
    const match = matchSegmentToSchedule(signals, schedule);
    expect(match?.rkey).toBe("talk2");
    expect(match?.confidence).toBe("medium");
  });

  it("returns null for no match", () => {
    const signals = [{ type: "self-intro" as const, name: "Unknown Person" }];
    const match = matchSegmentToSchedule(signals, schedule);
    expect(match).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/ionosphere-appview && npx vitest run src/v7/__tests__/transcript-matcher.test.ts
```

- [ ] **Step 3: Implement transcript matcher**

Core functions:
- `extractSignals(transcript, startS, endS)` — scan transcript words in range for self-intros, MC handoffs, topic keywords
- `matchSegmentToSchedule(signals, schedule)` — fuzzy match signals against schedule using `phoneticCode` from `../phonetic.js`
- `matchAllSegments(segments, transcript, schedule, hallucinationZones)` — orchestrate matching for all segments

Speaker name matching should use phonetic codes for fuzzy matching (handles "Jekard"/"Jacquard", "Wardmuller"/"Werdmuller"). Topic matching should tokenize talk titles and look for 2+ matching keywords in the first 2 minutes of transcript.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/ionosphere-appview && npx vitest run src/v7/__tests__/transcript-matcher.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/v7/
git commit -m "feat(v7): transcript matcher — stage 2 of pipeline"
```

---

## Chunk 4: Schedule Reconciler (Stage 3) + CLI

### Task 5: Schedule Reconciler

**Files:**
- Create: `src/v7/schedule-reconciler.ts`
- Create: `src/v7/__tests__/schedule-reconciler.test.ts`

- [ ] **Step 1: Write failing tests**

Tests should cover:
- Duplicate assignment resolution (same rkey matched to multiple segments → keep highest confidence)
- Unmatched schedule entries in hallucination zones → `unverifiable`
- Unmatched segments → `unmatchedSegments` output
- End time calculation: next talk start minus gap, or diarization silence onset
- Last talk in session: ends at last speech, not next session start

- [ ] **Step 2: Run tests, verify fail**
- [ ] **Step 3: Implement reconciler**

Core function:
```ts
export function reconcileSchedule(
  matches: BoundaryMatch[],
  segments: TalkSegment[],
  schedule: ScheduleTalk[],
  hallucinationZones: HallucinationZone[],
  streamDurationS: number,
): V7Output
```

- [ ] **Step 4: Run tests, verify pass**
- [ ] **Step 5: Commit**

```bash
git add src/v7/
git commit -m "feat(v7): schedule reconciler — stage 3 of pipeline"
```

### Task 6: CLI Entry Point

**Files:**
- Create: `src/detect-boundaries-v7.ts`

- [ ] **Step 1: Implement CLI**

Wire together all three stages:
1. Parse args: `<transcript.json> --diarization <diarization.json> --stream-slug <slug>`
2. Load transcript JSON and diarization JSON
3. Load schedule from DB using `STREAM_MATCH[slug]` (reuse pattern from `tracks.ts`)
4. Run pipeline: `detectHallucinationZones` → `segmentDiarization` → `matchAllSegments` → `reconcileSchedule`
5. Print summary table (like v6)
6. Write output to `<transcript>-boundaries-v7.json`

- [ ] **Step 2: Test manually against one stream**

```bash
cd apps/ionosphere-appview
npx tsx src/detect-boundaries-v7.ts \
  data/fullday/ATScience/transcript-enriched.json \
  --diarization data/fullday/ATScience/diarization.json \
  --stream-slug atscience
```

Compare output against manually verified ground truth from April 12 audit.

- [ ] **Step 3: Commit**

```bash
git add src/detect-boundaries-v7.ts
git commit -m "feat(v7): CLI entry point for boundary detection pipeline"
```

---

## Chunk 5: Validation Against Ground Truth

### Task 7: Run Against All 7 Streams

- [ ] **Step 1: Run v7 on all streams**

```bash
cd apps/ionosphere-appview
for dir in ATScience Great_Hall___Day_1 Great_Hall___Day_2 Room_2301___Day_1 Room_2301___Day_2 Performance_Theater___Day_1 Performance_Theater___Day_2; do
  slug=$(echo "$dir" | sed 's/Great_Hall___Day_1/great-hall-day-1/' | sed 's/Great_Hall___Day_2/great-hall-day-2/' | sed 's/Room_2301___Day_1/room-2301-day-1/' | sed 's/Room_2301___Day_2/room-2301-day-2/' | sed 's/Performance_Theater___Day_1/performance-theatre-day-1/' | sed 's/Performance_Theater___Day_2/performance-theatre-day-2/' | sed 's/ATScience/atscience/')
  echo "=== $slug ==="
  npx tsx src/detect-boundaries-v7.ts \
    "data/fullday/$dir/transcript-enriched.json" \
    --diarization "data/fullday/$dir/diarization.json" \
    --stream-slug "$slug"
  echo
done
```

- [ ] **Step 2: Compare against current DB state (ground truth)**

Write a quick comparison script that loads the v7 output and the current DB video_segments, computing:
- Talks matched correctly (same rkey, start within 60s)
- Talks missed by v7
- Talks v7 found that aren't in ground truth
- Average start time error for matched talks

- [ ] **Step 3: Fix any systematic issues found**
- [ ] **Step 4: Commit final version**

```bash
git add -A
git commit -m "feat(v7): boundary detection v7 complete — diarization-first pipeline"
```
