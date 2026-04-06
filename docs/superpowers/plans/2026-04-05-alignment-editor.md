# Alignment Editor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an NLE-style alignment editor for correcting talk boundaries, verifying talks, and naming speakers in the track timeline view.

**Architecture:** A TimelineEngine (React context + store) owns viewport, editing state, and an append-only corrections sidecar. Rendering layers (talk segments, waveform/diarization, snap guides, interaction overlay) subscribe to the engine. The appview gets two new endpoints for loading/saving the corrections JSON.

**Tech Stack:** React 18, Next.js 15, TypeScript, Tailwind CSS, Hono (appview API), nanoid (IDs)

**Spec:** `docs/superpowers/specs/2026-04-05-alignment-editor-design.md`

---

## Chunk 1: Data Layer (Corrections + Engine Core)

### Task 1: Correction Types and Replay Logic

**Files:**
- Create: `apps/ionosphere/src/lib/corrections.ts`
- Create: `apps/ionosphere/src/lib/corrections.test.ts`

- [ ] **Step 1: Write failing tests for correction replay**

```ts
// apps/ionosphere/src/lib/corrections.test.ts
import { describe, it, expect } from "vitest";
import { replayCorrections, type CorrectionEntry, type BaseTalk } from "./corrections";

const baseTalks: BaseTalk[] = [
  { rkey: "talk1", title: "First Talk", speakers: ["Alice"], startSeconds: 100, endSeconds: 500, confidence: "high" },
  { rkey: "talk2", title: "Second Talk", speakers: ["Bob"], startSeconds: 500, endSeconds: 900, confidence: "high" },
];

function entry(action: CorrectionEntry["action"]): CorrectionEntry {
  return { id: "test", timestamp: new Date().toISOString(), streamSlug: "test", action };
}

describe("replayCorrections", () => {
  it("returns base talks when no corrections", () => {
    const result = replayCorrections(baseTalks, []);
    expect(result.talks).toEqual(baseTalks.map(t => ({ ...t, verified: false })));
    expect(result.speakerNames).toEqual(new Map());
  });

  it("applies move_boundary to start edge", () => {
    const corrections = [entry({ type: "move_boundary", talkRkey: "talk1", edge: "start", fromSeconds: 100, toSeconds: 110 })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks[0].startSeconds).toBe(110);
  });

  it("applies move_boundary to end edge", () => {
    const corrections = [entry({ type: "move_boundary", talkRkey: "talk1", edge: "end", fromSeconds: 500, toSeconds: 480 })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks[0].endSeconds).toBe(480);
  });

  it("applies split_talk", () => {
    const corrections = [entry({ type: "split_talk", talkRkey: "talk1", atSeconds: 300, newRkey: "talk1b" })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks).toHaveLength(3);
    expect(result.talks[0]).toMatchObject({ rkey: "talk1", startSeconds: 100, endSeconds: 300 });
    expect(result.talks[1]).toMatchObject({ rkey: "talk1b", startSeconds: 300, endSeconds: 500, title: "Untitled" });
  });

  it("applies add_talk", () => {
    const corrections = [entry({ type: "add_talk", rkey: "talk3", title: "New Talk", startSeconds: 950, endSeconds: 1100 })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks).toHaveLength(3);
    expect(result.talks[2]).toMatchObject({ rkey: "talk3", title: "New Talk" });
  });

  it("applies remove_talk", () => {
    const corrections = [entry({ type: "remove_talk", talkRkey: "talk1" })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks).toHaveLength(1);
    expect(result.talks[0].rkey).toBe("talk2");
  });

  it("applies set_talk_title", () => {
    const corrections = [entry({ type: "set_talk_title", talkRkey: "talk1", title: "Renamed" })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks[0].title).toBe("Renamed");
  });

  it("applies verify_talk and unverify_talk", () => {
    const corrections = [
      entry({ type: "verify_talk", talkRkey: "talk1" }),
      entry({ type: "unverify_talk", talkRkey: "talk1" }),
    ];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks[0].verified).toBe(false);
  });

  it("applies name_speaker", () => {
    const corrections = [entry({ type: "name_speaker", speakerId: "SPEAKER_01", name: "Alice Smith" })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.speakerNames.get("SPEAKER_01")).toBe("Alice Smith");
  });

  it("respects undo cursor", () => {
    const corrections = [
      entry({ type: "move_boundary", talkRkey: "talk1", edge: "start", fromSeconds: 100, toSeconds: 110 }),
      entry({ type: "move_boundary", talkRkey: "talk1", edge: "start", fromSeconds: 110, toSeconds: 120 }),
    ];
    const result = replayCorrections(baseTalks, corrections, 1); // only first correction
    expect(result.talks[0].startSeconds).toBe(110);
  });

  it("respects undo cursor = 0 (no corrections applied)", () => {
    const corrections = [entry({ type: "move_boundary", talkRkey: "talk1", edge: "start", fromSeconds: 100, toSeconds: 999 })];
    const result = replayCorrections(baseTalks, corrections, 0);
    expect(result.talks[0].startSeconds).toBe(100);
  });

  it("handles null endSeconds in base talk", () => {
    const talks: BaseTalk[] = [
      { rkey: "t1", title: "Last Talk", speakers: [], startSeconds: 800, endSeconds: null, confidence: "high" },
    ];
    const corrections = [entry({ type: "move_boundary", talkRkey: "t1", edge: "end", fromSeconds: 0, toSeconds: 1000 })];
    const result = replayCorrections(talks, corrections);
    expect(result.talks[0].endSeconds).toBe(1000);
  });

  it("splits talk with null endSeconds", () => {
    const talks: BaseTalk[] = [
      { rkey: "t1", title: "Last Talk", speakers: [], startSeconds: 800, endSeconds: null, confidence: "high" },
    ];
    const corrections = [entry({ type: "split_talk", talkRkey: "t1", atSeconds: 900, newRkey: "t1b" })];
    const result = replayCorrections(talks, corrections);
    expect(result.talks[0]).toMatchObject({ rkey: "t1", endSeconds: 900 });
    expect(result.talks[1]).toMatchObject({ rkey: "t1b", startSeconds: 900, endSeconds: null });
  });

  it("composes multiple operations on the same talk", () => {
    const corrections = [
      entry({ type: "move_boundary", talkRkey: "talk1", edge: "start", fromSeconds: 100, toSeconds: 90 }),
      entry({ type: "split_talk", talkRkey: "talk1", atSeconds: 300, newRkey: "talk1b" }),
      entry({ type: "set_talk_title", talkRkey: "talk1b", title: "Second Half" }),
      entry({ type: "verify_talk", talkRkey: "talk1b" }),
    ];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks[0]).toMatchObject({ rkey: "talk1", startSeconds: 90, endSeconds: 300 });
    expect(result.talks[1]).toMatchObject({ rkey: "talk1b", title: "Second Half", startSeconds: 300, verified: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/ionosphere && npx vitest run src/lib/corrections.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement corrections module**

```ts
// apps/ionosphere/src/lib/corrections.ts

export interface BaseTalk {
  rkey: string;
  title: string;
  speakers: string[];
  startSeconds: number;
  endSeconds: number | null;
  confidence: string;
}

export interface EffectiveTalk extends BaseTalk {
  verified: boolean;
}

export type CorrectionAction =
  | { type: "move_boundary"; talkRkey: string; edge: "start" | "end"; fromSeconds: number; toSeconds: number }
  | { type: "split_talk"; talkRkey: string; atSeconds: number; newRkey: string }
  | { type: "add_talk"; rkey: string; title: string; startSeconds: number; endSeconds: number }
  | { type: "remove_talk"; talkRkey: string }
  | { type: "set_talk_title"; talkRkey: string; title: string }
  | { type: "verify_talk"; talkRkey: string }
  | { type: "unverify_talk"; talkRkey: string }
  | { type: "name_speaker"; speakerId: string; name: string };

export interface CorrectionEntry {
  id: string;
  timestamp: string;
  authorDid?: string;
  streamSlug: string;
  action: CorrectionAction;
}

export interface ReplayResult {
  talks: EffectiveTalk[];
  speakerNames: Map<string, string>;
}

export function replayCorrections(
  baseTalks: BaseTalk[],
  corrections: CorrectionEntry[],
  cursor?: number,
): ReplayResult {
  const limit = cursor ?? corrections.length;
  const active = corrections.slice(0, limit);

  let talks: EffectiveTalk[] = baseTalks.map((t) => ({ ...t, verified: false }));
  const speakerNames = new Map<string, string>();

  for (const entry of active) {
    const { action } = entry;

    switch (action.type) {
      case "move_boundary": {
        talks = talks.map((t) => {
          if (t.rkey !== action.talkRkey) return t;
          if (action.edge === "start") return { ...t, startSeconds: action.toSeconds };
          return { ...t, endSeconds: action.toSeconds };
        });
        break;
      }
      case "split_talk": {
        const idx = talks.findIndex((t) => t.rkey === action.talkRkey);
        if (idx === -1) break;
        const original = talks[idx];
        const first: EffectiveTalk = { ...original, endSeconds: action.atSeconds };
        const second: EffectiveTalk = {
          ...original,
          rkey: action.newRkey,
          title: "Untitled",
          startSeconds: action.atSeconds,
          verified: false,
        };
        talks = [...talks.slice(0, idx), first, second, ...talks.slice(idx + 1)];
        break;
      }
      case "add_talk": {
        const newTalk: EffectiveTalk = {
          rkey: action.rkey,
          title: action.title,
          speakers: [],
          startSeconds: action.startSeconds,
          endSeconds: action.endSeconds,
          confidence: "manual",
          verified: false,
        };
        talks = [...talks, newTalk].sort((a, b) => a.startSeconds - b.startSeconds);
        break;
      }
      case "remove_talk": {
        talks = talks.filter((t) => t.rkey !== action.talkRkey);
        break;
      }
      case "set_talk_title": {
        talks = talks.map((t) =>
          t.rkey === action.talkRkey ? { ...t, title: action.title } : t,
        );
        break;
      }
      case "verify_talk": {
        talks = talks.map((t) =>
          t.rkey === action.talkRkey ? { ...t, verified: true } : t,
        );
        break;
      }
      case "unverify_talk": {
        talks = talks.map((t) =>
          t.rkey === action.talkRkey ? { ...t, verified: false } : t,
        );
        break;
      }
      case "name_speaker": {
        speakerNames.set(action.speakerId, action.name);
        break;
      }
    }
  }

  return { talks, speakerNames };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/ionosphere && npx vitest run src/lib/corrections.test.ts`
Expected: All 14 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere/src/lib/corrections.ts apps/ionosphere/src/lib/corrections.test.ts
git commit -m "feat(editor): correction types and replay logic with tests"
```

---

### Task 2: Snap Target Computation

**Files:**
- Create: `apps/ionosphere/src/lib/snap-targets.ts`
- Create: `apps/ionosphere/src/lib/snap-targets.test.ts`

- [ ] **Step 1: Write failing tests for snap target computation**

```ts
// apps/ionosphere/src/lib/snap-targets.test.ts
import { describe, it, expect } from "vitest";
import { computeSnapTargets, findNearestSnap, type SnapTarget } from "./snap-targets";

describe("computeSnapTargets", () => {
  it("finds silence gaps > 2s from word timestamps", () => {
    const words = [
      { start: 10, end: 11, speaker: "A" },
      { start: 11.1, end: 12, speaker: "A" },
      // 3s gap here
      { start: 15, end: 16, speaker: "A" },
    ];
    const targets = computeSnapTargets(words, []);
    const silenceTargets = targets.filter((t) => t.type === "silence_gap");
    expect(silenceTargets).toHaveLength(1);
    expect(silenceTargets[0].gapStart).toBeCloseTo(12);
    expect(silenceTargets[0].gapEnd).toBeCloseTo(15);
  });

  it("finds speaker change points from diarization", () => {
    const diarization = [
      { start: 10, end: 20, speaker: "SPEAKER_01" },
      { start: 20, end: 30, speaker: "SPEAKER_02" },
    ];
    const targets = computeSnapTargets([], diarization);
    const changes = targets.filter((t) => t.type === "speaker_change");
    expect(changes).toHaveLength(1);
    expect(changes[0].time).toBeCloseTo(20);
  });

  it("returns targets sorted by time", () => {
    const words = [
      { start: 50, end: 51, speaker: "A" },
      { start: 55, end: 56, speaker: "A" },
    ];
    const diarization = [
      { start: 10, end: 52, speaker: "S1" },
      { start: 52, end: 60, speaker: "S2" },
    ];
    const targets = computeSnapTargets(words, diarization);
    for (let i = 1; i < targets.length; i++) {
      expect(targets[i].time).toBeGreaterThanOrEqual(targets[i - 1].time);
    }
  });
});

describe("findNearestSnap", () => {
  it("returns nearest snap target within radius, resolving edge-aware offset", () => {
    const targets: SnapTarget[] = [
      { type: "silence_gap", time: 100, gapStart: 98, gapEnd: 102, priority: 1 },
    ];
    // Dragging a start boundary — should snap to gapEnd + 0.5s offset
    const result = findNearestSnap(targets, 101.5, "start", 3);
    expect(result).not.toBeNull();
    expect(result!.snappedTime).toBeCloseTo(102.5); // gapEnd + 500ms
  });

  it("clamps offset to word boundary if overshoot", () => {
    const targets: SnapTarget[] = [
      { type: "silence_gap", time: 100, gapStart: 98, gapEnd: 102, priority: 1, nearestWordAfterGap: 102.2 },
    ];
    // gapEnd + 500ms = 102.5, but nearest word starts at 102.2 — clamp
    const result = findNearestSnap(targets, 101.5, "start", 3);
    expect(result).not.toBeNull();
    expect(result!.snappedTime).toBeCloseTo(102.2);
  });

  it("returns null when no targets within radius", () => {
    const targets: SnapTarget[] = [
      { type: "silence_gap", time: 100, gapStart: 98, gapEnd: 102, priority: 1 },
    ];
    const result = findNearestSnap(targets, 200, "start", 3);
    expect(result).toBeNull();
  });

  it("picks highest priority when multiple targets within radius", () => {
    const targets: SnapTarget[] = [
      { type: "speaker_change", time: 100, priority: 2 },
      { type: "silence_gap", time: 100.5, gapStart: 99, gapEnd: 101, priority: 1 },
    ];
    const result = findNearestSnap(targets, 100.2, "start", 3);
    expect(result!.target.type).toBe("silence_gap"); // priority 1 wins
  });

  it("resolves end boundary snap to gapStart - offset", () => {
    const targets: SnapTarget[] = [
      { type: "silence_gap", time: 100, gapStart: 98, gapEnd: 102, priority: 1 },
    ];
    const result = findNearestSnap(targets, 99, "end", 3);
    expect(result).not.toBeNull();
    expect(result!.snappedTime).toBeCloseTo(97.5); // gapStart - 500ms
  });

  it("clamps end boundary offset to word boundary if overshoot", () => {
    const targets: SnapTarget[] = [
      { type: "silence_gap", time: 100, gapStart: 98, gapEnd: 102, priority: 1, nearestWordBeforeGap: 97.8 },
    ];
    // gapStart - 500ms = 97.5, but nearest word ends at 97.8 — clamp
    const result = findNearestSnap(targets, 99, "end", 3);
    expect(result).not.toBeNull();
    expect(result!.snappedTime).toBeCloseTo(97.8);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/ionosphere && npx vitest run src/lib/snap-targets.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement snap targets module**

```ts
// apps/ionosphere/src/lib/snap-targets.ts

export interface SnapTarget {
  type: "silence_gap" | "speaker_change" | "low_confidence" | "word_boundary";
  time: number; // representative position in seconds
  priority: number; // 1 = highest (silence gap), 4 = lowest (word boundary)
  gapStart?: number;
  gapEnd?: number;
  nearestWordBeforeGap?: number;
  nearestWordAfterGap?: number;
}

export interface SnapResult {
  target: SnapTarget;
  snappedTime: number;
}

interface Word {
  start: number;
  end: number;
  speaker: string;
}

interface DiarizationSegment {
  start: number;
  end: number;
  speaker: string;
}

const SILENCE_GAP_THRESHOLD = 2; // seconds
const SNAP_OFFSET = 0.5; // 500ms breathing room

export function computeSnapTargets(
  words: Word[],
  diarization: DiarizationSegment[],
): SnapTarget[] {
  const targets: SnapTarget[] = [];

  // Silence gaps from word timestamps
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > SILENCE_GAP_THRESHOLD) {
      targets.push({
        type: "silence_gap",
        time: (words[i - 1].end + words[i].start) / 2,
        priority: 1,
        gapStart: words[i - 1].end,
        gapEnd: words[i].start,
        nearestWordBeforeGap: words[i - 1].end,
        nearestWordAfterGap: words[i].start,
      });
    }
  }

  // Speaker change points from diarization
  for (let i = 1; i < diarization.length; i++) {
    if (diarization[i].speaker !== diarization[i - 1].speaker) {
      targets.push({
        type: "speaker_change",
        time: diarization[i].start,
        priority: 2,
      });
    }
  }

  // Sort by time for binary search
  targets.sort((a, b) => a.time - b.time);
  return targets;
}

/**
 * Find the nearest snap target within `radiusSeconds` of `timeSeconds`.
 * Edge-aware: resolves to the near edge of the feature + 500ms offset.
 */
export function findNearestSnap(
  targets: SnapTarget[],
  timeSeconds: number,
  edge: "start" | "end",
  radiusSeconds: number,
): SnapResult | null {
  // Binary search for the closest target
  let lo = 0;
  let hi = targets.length - 1;
  const candidates: SnapTarget[] = [];

  // Find targets within radius using binary search
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (targets[mid].time < timeSeconds - radiusSeconds) {
      lo = mid + 1;
    } else if (targets[mid].time > timeSeconds + radiusSeconds) {
      hi = mid - 1;
    } else {
      // Found one in range — expand outward to find all
      let left = mid;
      while (left > 0 && targets[left - 1].time >= timeSeconds - radiusSeconds) left--;
      let right = mid;
      while (right < targets.length - 1 && targets[right + 1].time <= timeSeconds + radiusSeconds) right++;
      for (let i = left; i <= right; i++) candidates.push(targets[i]);
      break;
    }
  }

  if (candidates.length === 0) return null;

  // Pick highest priority (lowest number), then closest
  candidates.sort((a, b) => a.priority - b.priority || Math.abs(a.time - timeSeconds) - Math.abs(b.time - timeSeconds));
  const best = candidates[0];

  return { target: best, snappedTime: resolveSnapPosition(best, edge) };
}

function resolveSnapPosition(target: SnapTarget, edge: "start" | "end"): number {
  if (target.type === "silence_gap" && target.gapStart != null && target.gapEnd != null) {
    if (edge === "start") {
      // Dragging start boundary — snap to end of gap + offset (before first word)
      const ideal = target.gapEnd + SNAP_OFFSET;
      // Clamp to nearest word if offset overshoots
      if (target.nearestWordAfterGap != null && ideal > target.nearestWordAfterGap) {
        return target.nearestWordAfterGap;
      }
      return ideal;
    } else {
      // Dragging end boundary — snap to start of gap - offset (after last word)
      const ideal = target.gapStart - SNAP_OFFSET;
      if (target.nearestWordBeforeGap != null && ideal < target.nearestWordBeforeGap) {
        return target.nearestWordBeforeGap;
      }
      return ideal;
    }
  }

  // Speaker changes and other targets: use the target time directly
  return target.time;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/ionosphere && npx vitest run src/lib/snap-targets.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere/src/lib/snap-targets.ts apps/ionosphere/src/lib/snap-targets.test.ts
git commit -m "feat(editor): snap target computation with edge-aware offset"
```

---

### Task 3: Timeline Engine Store

**Files:**
- Create: `apps/ionosphere/src/lib/timeline-engine.ts`

This is a React context + store that composes the corrections and snap logic. No separate test file — the corrections and snap logic are tested independently; the engine is a thin integration layer that will be tested via component interaction in later tasks.

- [ ] **Step 1: Create the timeline engine**

```ts
// apps/ionosphere/src/lib/timeline-engine.ts
"use client";

import {
  createContext,
  useContext,
  useReducer,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import {
  replayCorrections,
  type BaseTalk,
  type EffectiveTalk,
  type CorrectionEntry,
  type CorrectionAction,
} from "./corrections";
import {
  computeSnapTargets,
  findNearestSnap,
  type SnapTarget,
  type SnapResult,
} from "./snap-targets";

// --- Types ---

export type EditMode = "select" | "trim" | "split" | "add";

interface DragState {
  talkRkey: string;
  edge: "start" | "end";
  originalSeconds: number;
  currentSeconds: number;
}

interface EngineState {
  // Editing
  editingEnabled: boolean;
  mode: EditMode;
  selectedTalkRkey: string | null;
  activeDrag: DragState | null;

  // Corrections
  corrections: CorrectionEntry[];
  undoCursor: number; // index into corrections: entries [0, undoCursor) are applied
  savedCursor: number; // cursor at last save — for dirty detection

  // Data (set on init, not part of reducer)
  streamSlug: string;
  baseTalks: BaseTalk[];
  authorDid?: string;
}

type EngineAction =
  | { type: "TOGGLE_EDITING" }
  | { type: "SET_MODE"; mode: EditMode }
  | { type: "SELECT_TALK"; rkey: string | null }
  | { type: "START_DRAG"; talkRkey: string; edge: "start" | "end"; seconds: number }
  | { type: "UPDATE_DRAG"; seconds: number }
  | { type: "COMMIT_DRAG" }
  | { type: "CANCEL_DRAG" }
  | { type: "APPLY_CORRECTION"; action: CorrectionAction }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "MARK_SAVED" }
  | { type: "LOAD_CORRECTIONS"; corrections: CorrectionEntry[] };

function generateId(): string {
  return crypto.randomUUID();
}

function engineReducer(state: EngineState, action: EngineAction): EngineState {
  switch (action.type) {
    case "TOGGLE_EDITING":
      return {
        ...state,
        editingEnabled: !state.editingEnabled,
        mode: "select",
        selectedTalkRkey: null,
        activeDrag: null,
      };

    case "SET_MODE":
      return { ...state, mode: action.mode, activeDrag: null };

    case "SELECT_TALK":
      return { ...state, selectedTalkRkey: action.rkey };

    case "START_DRAG":
      return {
        ...state,
        activeDrag: {
          talkRkey: action.talkRkey,
          edge: action.edge,
          originalSeconds: action.seconds,
          currentSeconds: action.seconds,
        },
      };

    case "UPDATE_DRAG":
      if (!state.activeDrag) return state;
      return {
        ...state,
        activeDrag: { ...state.activeDrag, currentSeconds: action.seconds },
      };

    case "COMMIT_DRAG": {
      if (!state.activeDrag) return state;
      const { talkRkey, edge, originalSeconds, currentSeconds } = state.activeDrag;
      if (Math.abs(originalSeconds - currentSeconds) < 0.05) {
        return { ...state, activeDrag: null };
      }
      const correction: CorrectionEntry = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        authorDid: state.authorDid,
        streamSlug: state.streamSlug,
        action: {
          type: "move_boundary",
          talkRkey,
          edge,
          fromSeconds: originalSeconds,
          toSeconds: currentSeconds,
        },
      };
      const corrections = [...state.corrections.slice(0, state.undoCursor), correction];
      return {
        ...state,
        corrections,
        undoCursor: corrections.length,
        activeDrag: null,
      };
    }

    case "CANCEL_DRAG":
      return { ...state, activeDrag: null };

    case "APPLY_CORRECTION": {
      const correction: CorrectionEntry = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        authorDid: state.authorDid,
        streamSlug: state.streamSlug,
        action: action.action,
      };
      const corrections = [...state.corrections.slice(0, state.undoCursor), correction];
      return { ...state, corrections, undoCursor: corrections.length };
    }

    case "UNDO":
      if (state.undoCursor <= 0) return state;
      return { ...state, undoCursor: state.undoCursor - 1 };

    case "REDO":
      if (state.undoCursor >= state.corrections.length) return state;
      return { ...state, undoCursor: state.undoCursor + 1 };

    case "MARK_SAVED":
      return { ...state, savedCursor: state.undoCursor };

    case "LOAD_CORRECTIONS":
      return {
        ...state,
        corrections: action.corrections,
        undoCursor: action.corrections.length,
        savedCursor: action.corrections.length,
      };

    default:
      return state;
  }
}

// --- Context ---

interface TimelineEngineContextValue {
  // State
  editingEnabled: boolean;
  mode: EditMode;
  selectedTalkRkey: string | null;
  activeDrag: DragState | null;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;

  // Derived
  effectiveTalks: EffectiveTalk[];
  speakerNames: Map<string, string>;
  snapTargets: SnapTarget[];

  // Viewport (managed externally, exposed here for coordinate conversion)
  windowStart: number;
  windowEnd: number;
  containerWidth: number;

  // Coordinate conversion
  timeToPixel: (seconds: number) => number;
  pixelToTime: (px: number) => number;

  // Snap
  findSnap: (timeSeconds: number, edge: "start" | "end", radiusPx: number) => SnapResult | null;

  // Actions
  toggleEditing: () => void;
  setMode: (mode: EditMode) => void;
  selectTalk: (rkey: string | null) => void;
  startDrag: (talkRkey: string, edge: "start" | "end", seconds: number) => void;
  updateDrag: (seconds: number) => void;
  commitDrag: () => void;
  cancelDrag: () => void;
  applyCorrection: (action: CorrectionAction) => void;
  undo: () => void;
  redo: () => void;
  markSaved: () => void;
  getCorrectionsToSave: () => CorrectionEntry[];
}

const TimelineEngineContext = createContext<TimelineEngineContextValue | null>(null);

export function useTimelineEngine() {
  const ctx = useContext(TimelineEngineContext);
  if (!ctx) throw new Error("useTimelineEngine must be used within TimelineEngineProvider");
  return ctx;
}

// --- Provider ---

interface TimelineEngineProviderProps {
  children: ReactNode;
  streamSlug: string;
  baseTalks: BaseTalk[];
  words: Array<{ start: number; end: number; speaker: string }>;
  diarization: Array<{ start: number; end: number; speaker: string }>;
  initialCorrections?: CorrectionEntry[];
  authorDid?: string;
  // Viewport props (managed by parent zoom component)
  windowStart: number;
  windowEnd: number;
  containerWidth: number;
}

export function TimelineEngineProvider({
  children,
  streamSlug,
  baseTalks,
  words,
  diarization,
  initialCorrections,
  authorDid,
  windowStart,
  windowEnd,
  containerWidth,
}: TimelineEngineProviderProps) {
  const [state, dispatch] = useReducer(engineReducer, {
    editingEnabled: false,
    mode: "select",
    selectedTalkRkey: null,
    activeDrag: null,
    corrections: initialCorrections ?? [],
    undoCursor: initialCorrections?.length ?? 0,
    savedCursor: initialCorrections?.length ?? 0,
    streamSlug,
    baseTalks,
    authorDid,
  });

  // Replay corrections to get effective state
  const { talks: effectiveTalks, speakerNames } = useMemo(
    () => replayCorrections(state.baseTalks, state.corrections, state.undoCursor),
    [state.baseTalks, state.corrections, state.undoCursor],
  );

  // Pre-compute snap targets
  const snapTargets = useMemo(
    () => computeSnapTargets(words, diarization),
    [words, diarization],
  );

  // Coordinate conversion
  const windowDuration = windowEnd - windowStart;
  const timeToPixel = useCallback(
    (seconds: number) => ((seconds - windowStart) / windowDuration) * containerWidth,
    [windowStart, windowDuration, containerWidth],
  );
  const pixelToTime = useCallback(
    (px: number) => windowStart + (px / containerWidth) * windowDuration,
    [windowStart, containerWidth, windowDuration],
  );

  const findSnap = useCallback(
    (timeSeconds: number, edge: "start" | "end", radiusPx: number) => {
      const radiusSeconds = (radiusPx / containerWidth) * windowDuration;
      return findNearestSnap(snapTargets, timeSeconds, edge, radiusSeconds);
    },
    [snapTargets, containerWidth, windowDuration],
  );

  const value: TimelineEngineContextValue = useMemo(() => ({
    editingEnabled: state.editingEnabled,
    mode: state.mode,
    selectedTalkRkey: state.selectedTalkRkey,
    activeDrag: state.activeDrag,
    isDirty: state.undoCursor !== state.savedCursor,
    canUndo: state.undoCursor > 0,
    canRedo: state.undoCursor < state.corrections.length,
    effectiveTalks,
    speakerNames,
    snapTargets,
    windowStart,
    windowEnd,
    containerWidth,
    timeToPixel,
    pixelToTime,
    findSnap,
    toggleEditing: () => dispatch({ type: "TOGGLE_EDITING" }),
    setMode: (mode: EditMode) => dispatch({ type: "SET_MODE", mode }),
    selectTalk: (rkey: string | null) => dispatch({ type: "SELECT_TALK", rkey }),
    startDrag: (talkRkey: string, edge: "start" | "end", seconds: number) =>
      dispatch({ type: "START_DRAG", talkRkey, edge, seconds }),
    updateDrag: (seconds: number) => dispatch({ type: "UPDATE_DRAG", seconds }),
    commitDrag: () => dispatch({ type: "COMMIT_DRAG" }),
    cancelDrag: () => dispatch({ type: "CANCEL_DRAG" }),
    applyCorrection: (action: CorrectionAction) =>
      dispatch({ type: "APPLY_CORRECTION", action }),
    undo: () => dispatch({ type: "UNDO" }),
    redo: () => dispatch({ type: "REDO" }),
    markSaved: () => dispatch({ type: "MARK_SAVED" }),
    getCorrectionsToSave: () => state.corrections.slice(0, state.undoCursor),
  }), [state, effectiveTalks, speakerNames, snapTargets, windowStart, windowEnd, containerWidth, timeToPixel, pixelToTime, findSnap]);

  return (
    <TimelineEngineContext.Provider value={value}>
      {children}
    </TimelineEngineContext.Provider>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/ionosphere && npx tsc --noEmit`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere/src/lib/timeline-engine.ts
git commit -m "feat(editor): timeline engine context and reducer"
```

---

### Task 4: Corrections API Endpoints

**Files:**
- Modify: `apps/ionosphere-appview/src/routes.ts` (add two endpoints)

- [ ] **Step 1: Add corrections endpoints to routes.ts**

Add the following before the `return app;` at the end of `createRoutes()`, after the existing tracks routes (line ~529 in routes.ts). Also add the necessary imports at the top.

Add to imports at top of file:
```ts
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
```

Note: `readFileSync` is already imported — extend that import to include `existsSync`, `writeFileSync`, and `mkdirSync`.

Add the CORS middleware update — change `"Access-Control-Allow-Methods"` from `"GET, OPTIONS"` to `"GET, PUT, OPTIONS"`.

Add endpoints before `return app;`:
```ts
  // --- Corrections sidecar ---

  app.get("/xrpc/tv.ionosphere.getCorrections", (c) => {
    const stream = c.req.query("stream");
    if (!stream) return c.json({ error: "missing stream parameter" }, 400);

    const correctionsPath = path.resolve(
      import.meta.dirname,
      `../data/corrections/corrections-${stream}.json`,
    );
    if (!existsSync(correctionsPath)) {
      return c.json({ corrections: [] });
    }
    const data = JSON.parse(readFileSync(correctionsPath, "utf-8"));
    return c.json({ corrections: data });
  });

  // Valid stream slugs (prevents path traversal)
  // Note: STREAMS is not exported from tracks.ts yet — add `export` to the STREAMS array,
  // then import it: `import { getTracksIndex, getTrackData, STREAMS } from "./tracks.js";`
  const validSlugs = new Set(STREAMS.map((s) => s.slug));

  app.put("/xrpc/tv.ionosphere.putCorrections", async (c) => {
    const body = await c.req.json();
    const stream = body.stream;
    const corrections = body.corrections;
    if (!stream || !Array.isArray(corrections)) {
      return c.json({ error: "missing stream or corrections" }, 400);
    }
    if (!validSlugs.has(stream)) {
      return c.json({ error: "invalid stream" }, 400);
    }

    const dir = path.resolve(import.meta.dirname, "../data/corrections");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const correctionsPath = path.resolve(dir, `corrections-${stream}.json`);
    writeFileSync(correctionsPath, JSON.stringify(corrections, null, 2));
    // NOTE: No authentication — acceptable for local dev, will need auth for production
    return c.json({ ok: true, count: corrections.length });
  });
```

- [ ] **Step 2: Create the corrections data directory**

Run: `mkdir -p apps/ionosphere-appview/data/corrections`

- [ ] **Step 3: Verify the appview still starts**

Run: `cd apps/ionosphere-appview && npm run build` (or `npx tsc --noEmit`)
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere-appview/src/routes.ts
git commit -m "feat(editor): corrections load/save API endpoints"
```

---

## Chunk 2: UI Components — Toolbar, Talk Segments, and Integration

### Task 5: NLE Toolbar Component

**Files:**
- Create: `apps/ionosphere/src/app/components/TimelineToolbar.tsx`

- [ ] **Step 1: Create the toolbar component**

```tsx
// apps/ionosphere/src/app/components/TimelineToolbar.tsx
"use client";

import { useTimelineEngine, type EditMode } from "@/lib/timeline-engine";

const MODE_BUTTONS: { mode: EditMode; label: string; shortcut: string }[] = [
  { mode: "select", label: "Select", shortcut: "V" },
  { mode: "trim", label: "Trim", shortcut: "T" },
  { mode: "split", label: "Split", shortcut: "S" },
  { mode: "add", label: "Add", shortcut: "A" },
];

export default function TimelineToolbar({ onSave }: { onSave: () => void }) {
  const {
    editingEnabled,
    toggleEditing,
    mode,
    setMode,
    canUndo,
    canRedo,
    undo,
    redo,
    isDirty,
    effectiveTalks,
    selectedTalkRkey,
    applyCorrection,
  } = useTimelineEngine();

  const verifiedCount = effectiveTalks.filter((t) => t.verified).length;
  const totalCount = effectiveTalks.length;

  const handleDelete = () => {
    if (!selectedTalkRkey) return;
    const talk = effectiveTalks.find((t) => t.rkey === selectedTalkRkey);
    if (!talk) return;
    if (talk.verified && !confirm("Delete verified talk?")) return;
    applyCorrection({ type: "remove_talk", talkRkey: selectedTalkRkey });
  };

  return (
    <div className="flex flex-col gap-1">
      {/* Top row: Edit toggle + verification progress */}
      <div className="flex items-center gap-2">
        <button
          onClick={toggleEditing}
          className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
            editingEnabled
              ? "bg-blue-600 text-white"
              : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
          }`}
        >
          {editingEnabled ? "Editing" : "Edit"}
        </button>
        <span className="text-xs text-neutral-500">
          {verifiedCount}/{totalCount} verified
        </span>
      </div>

      {/* Bottom row: Mode buttons + undo/redo + save (only when editing) */}
      {editingEnabled && (
        <div className="flex items-center gap-1">
          {/* Mode buttons */}
          <div className="flex items-center gap-0.5 border-r border-neutral-700 pr-2 mr-1">
            {MODE_BUTTONS.map(({ mode: m, label, shortcut }) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  mode === m
                    ? "bg-neutral-700 text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800"
                }`}
                title={`${label} (${shortcut})`}
              >
                {label}
              </button>
            ))}
            <button
              onClick={handleDelete}
              disabled={!selectedTalkRkey}
              className="px-2 py-0.5 text-xs rounded text-neutral-500 hover:text-red-400 hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Delete (Backspace)"
            >
              Delete
            </button>
          </div>

          {/* Undo/Redo */}
          <div className="flex items-center gap-0.5 border-r border-neutral-700 pr-2 mr-1">
            <button
              onClick={undo}
              disabled={!canUndo}
              className="px-2 py-0.5 text-xs rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 disabled:opacity-30"
              title="Undo (Ctrl+Z)"
            >
              Undo
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              className="px-2 py-0.5 text-xs rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 disabled:opacity-30"
              title="Redo (Ctrl+Shift+Z)"
            >
              Redo
            </button>
          </div>

          {/* Save */}
          <button
            onClick={onSave}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              isDirty
                ? "bg-blue-600/20 text-blue-400 hover:bg-blue-600/30"
                : "text-neutral-600 cursor-default"
            }`}
            disabled={!isDirty}
            title="Save (Ctrl+S)"
          >
            Save{isDirty ? " *" : ""}
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/ionosphere && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere/src/app/components/TimelineToolbar.tsx
git commit -m "feat(editor): NLE toolbar component with mode buttons"
```

---

### Task 6: Refactor StreamTimeline to Use Engine

**Files:**
- Modify: `apps/ionosphere/src/app/components/StreamTimeline.tsx`

The existing StreamTimeline is ~100 lines. Refactor it to read from the engine's `effectiveTalks` and show edit affordances. Keep the existing click-to-seek behavior when not in edit mode.

- [ ] **Step 1: Refactor StreamTimeline**

Replace the full contents of `StreamTimeline.tsx`:

```tsx
// apps/ionosphere/src/app/components/StreamTimeline.tsx
"use client";

import { useRef, useCallback, useMemo } from "react";
import { useTimestamp } from "./TimestampProvider";
import { talkColor, buildIndexMap } from "@/lib/track-colors";
import { useTimelineEngine } from "@/lib/timeline-engine";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface StreamTimelineProps {
  /** All talk rkeys for stable color assignment (full list, not just visible). */
  allTalkRkeys: string[];
}

export default function StreamTimeline({ allTalkRkeys }: StreamTimelineProps) {
  const { currentTimeNs, seekTo } = useTimestamp();
  const barRef = useRef<HTMLDivElement>(null);
  const currentTimeSec = currentTimeNs / 1e9;

  const {
    effectiveTalks,
    editingEnabled,
    mode,
    selectedTalkRkey,
    selectTalk,
    activeDrag,
    windowStart,
    windowEnd,
    timeToPixel,
    pixelToTime,
    startDrag,
    applyCorrection,
  } = useTimelineEngine();

  const windowDuration = windowEnd - windowStart;

  // Stable color index from ALL talks
  const colorIndex = useMemo(
    () => buildIndexMap(allTalkRkeys),
    [allTalkRkeys],
  );

  // Filter to visible talks
  const visibleTalks = useMemo(
    () => effectiveTalks.filter(
      (t) => t.startSeconds < windowEnd && (t.endSeconds ?? windowEnd) > windowStart,
    ),
    [effectiveTalks, windowStart, windowEnd],
  );

  const handleBarClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!barRef.current) return;
      const rect = barRef.current.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      const seconds = windowStart + fraction * windowDuration;

      if (editingEnabled && mode === "split" && selectedTalkRkey) {
        const talk = effectiveTalks.find((t) => t.rkey === selectedTalkRkey);
        if (talk && seconds > talk.startSeconds && seconds < (talk.endSeconds ?? windowEnd)) {
          const newRkey = Math.random().toString(36).slice(2, 10);
          applyCorrection({ type: "split_talk", talkRkey: selectedTalkRkey, atSeconds: seconds, newRkey });
          return;
        }
      }

      if (editingEnabled && mode === "select") {
        // Find which talk was clicked
        const clicked = visibleTalks.find(
          (t) => seconds >= t.startSeconds && seconds < (t.endSeconds ?? windowEnd),
        );
        selectTalk(clicked?.rkey ?? null);
        if (clicked) {
          seekTo(clicked.startSeconds * 1e9);
          return;
        }
      }

      seekTo(seconds * 1e9);
    },
    [windowStart, windowDuration, seekTo, editingEnabled, mode, selectedTalkRkey, effectiveTalks, visibleTalks, selectTalk, applyCorrection, windowEnd],
  );

  const handleEdgeMouseDown = useCallback(
    (e: React.MouseEvent, talkRkey: string, edge: "start" | "end", seconds: number) => {
      if (!editingEnabled || mode !== "trim") return;
      e.stopPropagation();
      startDrag(talkRkey, edge, seconds);
    },
    [editingEnabled, mode, startDrag],
  );

  const scrubberPct = Math.min(100, Math.max(0,
    ((currentTimeSec - windowStart) / windowDuration) * 100,
  ));

  return (
    <div
      ref={barRef}
      onClick={handleBarClick}
      className="relative w-full h-10 bg-neutral-900 rounded cursor-pointer overflow-hidden border border-neutral-800"
    >
      {visibleTalks.map((talk, i) => {
        const talkStart = Math.max(talk.startSeconds, windowStart);
        const talkEnd = Math.min(talk.endSeconds ?? windowEnd, windowEnd);
        if (talkStart >= windowEnd || talkEnd <= windowStart) return null;

        // If this talk's boundary is being dragged, use the drag position
        let displayStart = talkStart;
        let displayEnd = talkEnd;
        if (activeDrag?.talkRkey === talk.rkey) {
          if (activeDrag.edge === "start") displayStart = Math.max(activeDrag.currentSeconds, windowStart);
          if (activeDrag.edge === "end") displayEnd = Math.min(activeDrag.currentSeconds, windowEnd);
        }

        const left = ((displayStart - windowStart) / windowDuration) * 100;
        const width = ((displayEnd - displayStart) / windowDuration) * 100;
        const isSelected = selectedTalkRkey === talk.rkey;

        return (
          <div
            key={`${talk.rkey}-${i}`}
            className={`absolute top-0 h-full flex items-center overflow-hidden ${
              isSelected ? "ring-2 ring-white/50 z-[5]" : ""
            }`}
            style={{
              left: `${left}%`,
              width: `${width}%`,
              backgroundColor: talkColor(talk.rkey, colorIndex),
            }}
            title={`${talk.title} (${formatTime(talk.startSeconds)})`}
          >
            {/* Left edge drag handle */}
            {editingEnabled && mode === "trim" && (
              <div
                className="absolute left-0 top-0 w-1 h-full cursor-col-resize hover:bg-white/40 z-[6]"
                onMouseDown={(e) => handleEdgeMouseDown(e, talk.rkey, "start", talk.startSeconds)}
              />
            )}

            <span className="text-[10px] text-neutral-300 px-1 truncate">
              {talk.title}
            </span>

            {/* Verified badge */}
            {talk.verified && (
              <span className="absolute top-0.5 right-1 text-[8px] text-green-400">&#10003;</span>
            )}

            {/* Right edge drag handle */}
            {editingEnabled && mode === "trim" && (
              <div
                className="absolute right-0 top-0 w-1 h-full cursor-col-resize hover:bg-white/40 z-[6]"
                onMouseDown={(e) => handleEdgeMouseDown(e, talk.rkey, "end", talk.endSeconds ?? windowEnd)}
              />
            )}
          </div>
        );
      })}

      {/* Scrubber */}
      <div
        className="absolute top-0 h-full w-0.5 bg-white/80 z-10 pointer-events-none"
        style={{ left: `${scrubberPct}%` }}
      />

      {/* Time labels */}
      <div className="absolute bottom-0 left-1 text-[9px] text-neutral-500">
        {formatTime(windowStart)}
      </div>
      <div className="absolute bottom-0 right-1 text-[9px] text-neutral-500">
        {formatTime(windowEnd)}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/ionosphere && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere/src/app/components/StreamTimeline.tsx
git commit -m "refactor(editor): StreamTimeline reads from TimelineEngine"
```

---

### Task 7: Interaction Overlay (Drag Handling)

**Files:**
- Create: `apps/ionosphere/src/app/components/InteractionOverlay.tsx`

This component renders on top of the timeline and handles mouse move/up during drag operations. It also renders snap guide lines.

- [ ] **Step 1: Create the interaction overlay**

```tsx
// apps/ionosphere/src/app/components/InteractionOverlay.tsx
"use client";

import { useEffect, useCallback, useState } from "react";
import { useTimelineEngine } from "@/lib/timeline-engine";

export default function InteractionOverlay() {
  const {
    editingEnabled,
    activeDrag,
    updateDrag,
    commitDrag,
    cancelDrag,
    pixelToTime,
    timeToPixel,
    findSnap,
    windowStart,
    windowEnd,
  } = useTimelineEngine();

  const [snapGuide, setSnapGuide] = useState<{ px: number; label: string } | null>(null);

  // Global mouse handlers during drag
  useEffect(() => {
    if (!activeDrag) {
      setSnapGuide(null);
      return;
    }

    const onMouseMove = (e: MouseEvent) => {
      const timeline = document.querySelector("[data-timeline-bar]") as HTMLElement;
      if (!timeline) return;
      const rect = timeline.getBoundingClientRect();
      const px = e.clientX - rect.left;
      let timeSeconds = pixelToTime(px);

      // Check for snap (unless Alt is held)
      if (!e.altKey) {
        const snapResult = findSnap(timeSeconds, activeDrag.edge, 10);
        if (snapResult) {
          timeSeconds = snapResult.snappedTime;
          const snapPx = timeToPixel(snapResult.snappedTime);
          setSnapGuide({ px: snapPx, label: snapResult.target.type.replace("_", " ") });
        } else {
          setSnapGuide(null);
        }
      } else {
        setSnapGuide(null);
      }

      updateDrag(timeSeconds);
    };

    const onMouseUp = () => {
      commitDrag();
      setSnapGuide(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelDrag();
        setSnapGuide(null);
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeDrag, pixelToTime, timeToPixel, findSnap, updateDrag, commitDrag, cancelDrag]);

  if (!editingEnabled) return null;

  const windowDuration = windowEnd - windowStart;

  return (
    <>
      {/* Snap guide line */}
      {snapGuide && (
        <div
          className="absolute top-0 h-full w-px bg-yellow-400/60 z-20 pointer-events-none"
          style={{ left: `${snapGuide.px}px` }}
        >
          <span className="absolute -top-4 left-1 text-[8px] text-yellow-400 whitespace-nowrap">
            {snapGuide.label}
          </span>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/ionosphere && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere/src/app/components/InteractionOverlay.tsx
git commit -m "feat(editor): interaction overlay with drag and snap guides"
```

---

### Task 8: Keyboard Shortcuts

**Files:**
- Create: `apps/ionosphere/src/app/components/useEditorKeyboard.ts`

A hook that registers keyboard shortcuts when the editor is active.

- [ ] **Step 1: Create the keyboard hook**

```ts
// apps/ionosphere/src/app/components/useEditorKeyboard.ts
"use client";

import { useEffect } from "react";
import { useTimelineEngine } from "@/lib/timeline-engine";
import { useTimestamp } from "./TimestampProvider";

export function useEditorKeyboard(onSave: () => void) {
  const {
    editingEnabled,
    toggleEditing,
    mode,
    setMode,
    selectedTalkRkey,
    effectiveTalks,
    applyCorrection,
    undo,
    redo,
    canUndo,
    canRedo,
    activeDrag,
    cancelDrag,
    selectTalk,
  } = useTimelineEngine();

  const { seekTo, currentTimeNs, paused, setPaused } = useTimestamp();
  const currentTimeSec = currentTimeNs / 1e9;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const ctrl = e.ctrlKey || e.metaKey;

      // --- Playback shortcuts (always active) ---
      switch (e.key) {
        case " ":
          e.preventDefault();
          setPaused(!paused);
          return;
        case "ArrowLeft":
          e.preventDefault();
          seekTo((currentTimeSec - (e.shiftKey ? 0.1 : 1)) * 1e9);
          return;
        case "ArrowRight":
          e.preventDefault();
          seekTo((currentTimeSec + (e.shiftKey ? 0.1 : 1)) * 1e9);
          return;
        case "j":
        case "J":
          seekTo((currentTimeSec - 5) * 1e9);
          return;
        case "k":
        case "K":
          setPaused(!paused);
          return;
        case "l":
        case "L":
          seekTo((currentTimeSec + 5) * 1e9);
          return;
      }

      // --- Editing shortcuts (only when editing) ---
      if (!editingEnabled) return;

      // Save
      if (ctrl && e.key === "s") {
        e.preventDefault();
        onSave();
        return;
      }

      // Undo/Redo
      if (ctrl && e.key === "z" && !e.shiftKey && canUndo) {
        e.preventDefault();
        undo();
        return;
      }
      if (ctrl && e.key === "z" && e.shiftKey && canRedo) {
        e.preventDefault();
        redo();
        return;
      }

      // Mode switching
      if (!ctrl) {
        switch (e.key) {
          case "v": setMode("select"); return;
          case "t": setMode("trim"); return;
          case "s": setMode("split"); return;
          case "a": setMode("add"); return;
        }
      }

      // Escape
      if (e.key === "Escape") {
        if (activeDrag) {
          cancelDrag();
        } else if (selectedTalkRkey) {
          selectTalk(null);
        } else {
          toggleEditing();
        }
        return;
      }

      // Selected talk actions
      if (selectedTalkRkey) {
        const talk = effectiveTalks.find((t) => t.rkey === selectedTalkRkey);
        if (!talk) return;

        switch (e.key) {
          case "Enter":
            applyCorrection(
              talk.verified
                ? { type: "unverify_talk", talkRkey: selectedTalkRkey }
                : { type: "verify_talk", talkRkey: selectedTalkRkey },
            );
            return;
          case "Backspace":
          case "Delete":
            if (talk.verified && !confirm("Delete verified talk?")) return;
            applyCorrection({ type: "remove_talk", talkRkey: selectedTalkRkey });
            return;
          case "[":
            e.preventDefault();
            applyCorrection({
              type: "move_boundary",
              talkRkey: selectedTalkRkey,
              edge: "start",
              fromSeconds: talk.startSeconds,
              toSeconds: talk.startSeconds - (e.shiftKey ? 0.1 : 1),
            });
            return;
          case "]":
            e.preventDefault();
            applyCorrection({
              type: "move_boundary",
              talkRkey: selectedTalkRkey,
              edge: "end",
              fromSeconds: talk.endSeconds ?? 0,
              toSeconds: (talk.endSeconds ?? 0) + (e.shiftKey ? 0.1 : 1),
            });
            return;
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [editingEnabled, mode, selectedTalkRkey, effectiveTalks, currentTimeSec, paused, activeDrag, canUndo, canRedo, onSave, setMode, selectTalk, applyCorrection, undo, redo, cancelDrag, toggleEditing, seekTo, setPaused]);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/ionosphere && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere/src/app/components/useEditorKeyboard.ts
git commit -m "feat(editor): keyboard shortcuts hook for playback and editing"
```

---

### Task 9: Integrate Engine into TrackViewContent

**Files:**
- Modify: `apps/ionosphere/src/app/tracks/[stream]/TrackViewContent.tsx`
- Modify: `apps/ionosphere/src/lib/api.ts` (add corrections fetch/save)

This is the main integration task — wire the engine provider, toolbar, keyboard hook, and refactored StreamTimeline into the track view.

- [ ] **Step 1: Add corrections API helpers to api.ts**

Find the `getTrack` function in `apps/ionosphere/src/lib/api.ts` and add after it:

```ts
export async function getCorrections(stream: string) {
  return fetchApi<{ corrections: any[] }>(`/xrpc/tv.ionosphere.getCorrections?stream=${encodeURIComponent(stream)}`);
}

export async function saveCorrections(stream: string, corrections: any[]) {
  const res = await fetch(`${API_BASE}/xrpc/tv.ionosphere.putCorrections`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream, corrections }),
  });
  return res.json();
}
```

- [ ] **Step 2: Rewrite TrackViewContent to use the engine**

Replace the full contents of `TrackViewContent.tsx`. Key changes:
- Wrap in `TimelineEngineProvider`
- Add the toolbar and keyboard hook
- Pass `words` data through for snap computation
- Manage viewport state in the zoom component, pass to engine
- Load/save corrections via API

```tsx
// apps/ionosphere/src/app/tracks/[stream]/TrackViewContent.tsx
"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { TimestampProvider, useTimestamp } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import TranscriptView from "@/app/components/TranscriptView";
import StreamTimeline from "@/app/components/StreamTimeline";
import DiarizationBand from "@/app/components/DiarizationBand";
import TimelineToolbar from "@/app/components/TimelineToolbar";
import InteractionOverlay from "@/app/components/InteractionOverlay";
import { useEditorKeyboard } from "@/app/components/useEditorKeyboard";
import { TimelineEngineProvider, useTimelineEngine } from "@/lib/timeline-engine";
import { getCorrections, saveCorrections } from "@/lib/api";
import type { BaseTalk, CorrectionEntry } from "@/lib/corrections";

interface Talk {
  rkey: string;
  title: string;
  speakers: string[];
  startSeconds: number;
  endSeconds: number | null;
  confidence: string;
}

interface TrackData {
  slug: string;
  name: string;
  room: string;
  dayLabel: string;
  streamUri: string;
  durationSeconds: number;
  playbackUrl: string;
  talks: Talk[];
  diarization: Array<{ start: number; end: number; speaker: string }>;
  transcript?: { text: string; facets: any[] };
  words?: Array<{ start: number; end: number; speaker: string }>;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// --- Talk List (reads from engine) ---

function TalkList() {
  const { seekTo, currentTimeNs } = useTimestamp();
  const { effectiveTalks, editingEnabled, selectedTalkRkey, selectTalk } = useTimelineEngine();
  const currentTimeSec = currentTimeNs / 1e9;
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [Math.floor(currentTimeSec / 60)]);

  return (
    <div className="space-y-1 p-4">
      {effectiveTalks.map((talk, i) => {
        const isActive =
          currentTimeSec >= talk.startSeconds &&
          (talk.endSeconds ? currentTimeSec < talk.endSeconds : i === effectiveTalks.length - 1);
        const isSelected = selectedTalkRkey === talk.rkey;

        return (
          <button
            key={`${talk.rkey}-${i}`}
            ref={isActive ? activeRef : undefined}
            onClick={() => {
              if (editingEnabled) selectTalk(talk.rkey);
              seekTo(talk.startSeconds * 1e9);
            }}
            className={`w-full text-left px-3 py-2 rounded transition-colors flex items-baseline gap-3 ${
              isSelected
                ? "bg-blue-900/30 text-neutral-100 ring-1 ring-blue-500/50"
                : isActive
                  ? "bg-neutral-800 text-neutral-100"
                  : "hover:bg-neutral-800/50 text-neutral-400"
            }`}
          >
            <span className="text-xs font-mono shrink-0 w-16 text-neutral-500">
              {formatTime(talk.startSeconds)}
            </span>
            <span className="text-sm flex-1 truncate">
              {talk.verified && <span className="text-green-400 mr-1">&#10003;</span>}
              {talk.title}
            </span>
            <span className="text-xs text-neutral-600 shrink-0 hidden sm:inline">
              {talk.speakers.join(", ")}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function TrackViewInner({ track, words }: { track: TrackData; words: Array<{ start: number; end: number; speaker: string }> }) {
  const [activeTab, setActiveTab] = useState<"talks" | "transcript">("talks");
  const hasTranscript = !!(track.transcript?.facets?.length);
  const containerRef = useRef<HTMLDivElement>(null);
  const { currentTimeNs } = useTimestamp();
  const currentTimeSec = currentTimeNs / 1e9;

  // Zoom state
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panCenter, setPanCenter] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  // Corrections state
  const [initialCorrections, setInitialCorrections] = useState<CorrectionEntry[]>([]);
  const [correctionsLoaded, setCorrectionsLoaded] = useState(false);

  // Load corrections on mount
  useEffect(() => {
    getCorrections(track.slug).then((data) => {
      setInitialCorrections(data.corrections || []);
      setCorrectionsLoaded(true);
    }).catch(() => setCorrectionsLoaded(true));
  }, [track.slug]);

  const allSpeakers = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const s of track.diarization) {
      if (!seen.has(s.speaker)) {
        seen.add(s.speaker);
        ordered.push(s.speaker);
      }
    }
    return ordered;
  }, [track.diarization]);

  const allTalkRkeys = useMemo(
    () => track.talks.map((t) => t.rkey),
    [track.talks],
  );

  // Viewport
  const center = panCenter ?? currentTimeSec;
  const windowDuration = track.durationSeconds / zoomLevel;
  const windowStart = Math.max(0, Math.min(
    center - windowDuration / 2,
    track.durationSeconds - windowDuration,
  ));
  const windowEnd = windowStart + windowDuration;

  // Measure container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Gesture handling
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        const zoomDelta = e.deltaY > 0 ? 0.8 : 1.25;
        setZoomLevel((prev) => Math.max(1, Math.min(64, prev * zoomDelta)));
      }
      if (Math.abs(e.deltaX) > 0 || e.shiftKey) {
        const panDelta = (e.deltaX || e.deltaY) * (windowDuration / 1000);
        setPanCenter((prev) => {
          const c = prev ?? currentTimeSec;
          return Math.max(windowDuration / 2, Math.min(track.durationSeconds - windowDuration / 2, c + panDelta));
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [windowDuration, track.durationSeconds, currentTimeSec]);

  useEffect(() => {
    if (zoomLevel <= 1) setPanCenter(null);
  }, [zoomLevel]);

  const visibleDiarization = track.diarization.filter(
    (s) => s.start < windowEnd && s.end > windowStart,
  );

  const baseTalks: BaseTalk[] = useMemo(
    () => track.talks.map((t) => ({
      rkey: t.rkey,
      title: t.title,
      speakers: t.speakers,
      startSeconds: t.startSeconds,
      endSeconds: t.endSeconds,
      confidence: t.confidence,
    })),
    [track.talks],
  );

  // Save ref — SaveHandler sets this so the toolbar can call it
  const saveRef = useRef<(() => void) | null>(null);

  if (!correctionsLoaded) {
    return <div className="p-4 text-neutral-500">Loading...</div>;
  }

  return (
    <TimelineEngineProvider
      streamSlug={track.slug}
      baseTalks={baseTalks}
      words={words}
      diarization={track.diarization}
      initialCorrections={initialCorrections}
      windowStart={windowStart}
      windowEnd={windowEnd}
      containerWidth={containerWidth}
    >
      <div className="h-full flex flex-col">
        <div className="shrink-0 px-4 pt-3 border-b border-neutral-800">
          <div className="max-w-5xl mx-auto">
            <div className="mb-2">
              <h1 className="text-lg font-bold">{track.name}</h1>
              <p className="text-xs text-neutral-500">
                {track.room} · {track.talks.length} talks · {formatTime(track.durationSeconds)}
              </p>
            </div>

            <div className="mb-2 max-h-[33vh] overflow-hidden rounded-lg bg-black">
              <VideoPlayer videoUri={track.streamUri} />
            </div>

            <div className="mb-2">
              <TimelineToolbar onSave={() => saveRef.current?.()} />
              <SaveHandler streamSlug={track.slug} saveRef={saveRef} />
            </div>

            <div ref={containerRef} className="mb-2">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setZoomLevel((z) => Math.max(1, z / 2))}
                    disabled={zoomLevel <= 1}
                    className="px-2 py-0.5 text-xs rounded bg-neutral-800 text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
                  >
                    −
                  </button>
                  <span className="text-xs text-neutral-500 w-10 text-center">
                    {zoomLevel <= 1 ? "Full" : `${zoomLevel.toFixed(zoomLevel < 2 ? 1 : 0)}x`}
                  </span>
                  <button
                    onClick={() => setZoomLevel((z) => Math.min(64, z * 2))}
                    disabled={zoomLevel >= 64}
                    className="px-2 py-0.5 text-xs rounded bg-neutral-800 text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
                  >
                    +
                  </button>
                </div>
                {zoomLevel > 1 && (
                  <>
                    <span className="text-xs text-neutral-600">
                      {formatTime(windowStart)} — {formatTime(windowEnd)}
                    </span>
                    <button
                      onClick={() => { setZoomLevel(1); setPanCenter(null); }}
                      className="text-xs text-neutral-600 hover:text-neutral-300 ml-auto"
                    >
                      Reset
                    </button>
                  </>
                )}
              </div>

              <div className="relative" data-timeline-bar>
                <StreamTimeline allTalkRkeys={allTalkRkeys} />
                <InteractionOverlay />
              </div>

              {track.diarization.length > 0 && (
                <div className="mt-1">
                  <DiarizationBand
                    segments={visibleDiarization}
                    allSpeakers={allSpeakers}
                    durationSeconds={windowDuration}
                    offsetSeconds={windowStart}
                  />
                </div>
              )}
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => setActiveTab("talks")}
                className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "talks"
                    ? "border-neutral-300 text-neutral-100"
                    : "border-transparent text-neutral-500 hover:text-neutral-300"
                }`}
              >
                Talks
              </button>
              <button
                onClick={() => setActiveTab("transcript")}
                disabled={!hasTranscript}
                className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "transcript"
                    ? "border-neutral-300 text-neutral-100"
                    : "border-transparent text-neutral-500 hover:text-neutral-300"
                } ${!hasTranscript ? "opacity-30 cursor-not-allowed" : ""}`}
              >
                Transcript
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0">
          <div className="max-w-5xl mx-auto h-full">
            {activeTab === "talks" && (
              <div className="h-full overflow-y-auto">
                <TalkList />
              </div>
            )}
            {activeTab === "transcript" && hasTranscript && (
              <TranscriptView document={track.transcript!} />
            )}
          </div>
        </div>
      </div>
    </TimelineEngineProvider>
  );
}

/** Inner component that has access to the engine context for saving */
function SaveHandler({
  streamSlug,
  saveRef,
}: {
  streamSlug: string;
  saveRef: React.MutableRefObject<(() => void) | null>;
}) {
  const engine = useTimelineEngine();

  const handleSave = useCallback(async () => {
    const corrections = engine.getCorrectionsToSave();
    await saveCorrections(streamSlug, corrections);
    engine.markSaved();
  }, [engine, streamSlug]);

  // Expose save to toolbar via ref
  useEffect(() => { saveRef.current = handleSave; }, [handleSave, saveRef]);

  useEditorKeyboard(handleSave);

  return null;
}

export default function TrackViewContent({ track }: { track: TrackData }) {
  // Extract words from transcript for snap computation
  // Words come from the server-side data (not the faceted transcript)
  const words = track.words ?? [];

  return (
    <TimestampProvider>
      <TrackViewInner track={track} words={words} />
    </TimestampProvider>
  );
}
```

**Note:** The `words` field needs to be added to the track API response. See step 3.

- [ ] **Step 3: Add words to track API response**

In `apps/ionosphere-appview/src/tracks.ts`, the `getTrackData` function returns `transcript` (pre-processed text + facets). We also need the raw word array for snap target computation.

Add a `loadWords` function after the existing `loadTranscript` function:

```ts
function loadWords(dirName: string): Array<{ start: number; end: number; speaker: string }> {
  const txPath = path.join(DATA_DIR, dirName, "transcript-enriched.json");
  if (!existsSync(txPath)) return [];
  const data = JSON.parse(readFileSync(txPath, "utf-8"));
  return (data.words || []).map((w: any) => ({
    start: w.start,
    end: w.end,
    speaker: w.speaker,
  }));
}
```

Then in `getTrackData`, add `const words = loadWords(stream.dirName);` before the return statement, and add `words` to the return object:

Change:
```ts
  return {
    slug: stream.slug,
    ...
    diarization,
    transcript,
  };
```
To:
```ts
  return {
    slug: stream.slug,
    ...
    diarization,
    transcript,
    words,
  };
```

- [ ] **Step 4: Verify TypeScript compiles in both apps**

Run: `cd apps/ionosphere && npx tsc --noEmit && cd ../ionosphere-appview && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere/src/app/tracks/\[stream\]/TrackViewContent.tsx \
        apps/ionosphere/src/lib/api.ts \
        apps/ionosphere-appview/src/tracks.ts
git commit -m "feat(editor): integrate timeline engine into track view"
```

---

## Chunk 3: Waveform Band, Speaker Naming, and Ground Truth Export

### Task 10: Waveform/Diarization Band

**Files:**
- Create: `apps/ionosphere/src/app/components/WaveformBand.tsx`

A combined waveform/diarization visualization that morphs with zoom level. At low zoom it shows speaker-colored blocks (like the current DiarizationBand). At high zoom it becomes a speaker-colored area chart where height = word density.

- [ ] **Step 1: Create the waveform band component**

```tsx
// apps/ionosphere/src/app/components/WaveformBand.tsx
"use client";

import { useMemo } from "react";
import { speakerColor, buildIndexMap } from "@/lib/track-colors";
import { useTimelineEngine } from "@/lib/timeline-engine";

interface WaveformBandProps {
  words: Array<{ start: number; end: number; speaker: string }>;
  diarization: Array<{ start: number; end: number; speaker: string }>;
  allSpeakers: string[];
  zoomLevel: number;
}

interface Bin {
  startTime: number;
  endTime: number;
  wordCount: number;
  dominantSpeaker: string;
}

export default function WaveformBand({
  words,
  diarization,
  allSpeakers,
  zoomLevel,
}: WaveformBandProps) {
  const { windowStart, windowEnd } = useTimelineEngine();
  const windowDuration = windowEnd - windowStart;

  const colorIndex = useMemo(
    () => buildIndexMap(allSpeakers),
    [allSpeakers],
  );

  // At low zoom (< 4x), render as simple diarization blocks
  // At high zoom (>= 4x), render as waveform bins
  const useWaveform = zoomLevel >= 4;

  // Compute waveform bins from words in the visible window
  const bins = useMemo(() => {
    if (!useWaveform || words.length === 0) return [];

    const binCount = Math.min(400, Math.max(50, Math.round(windowDuration * 2)));
    const binDuration = windowDuration / binCount;
    const result: Bin[] = [];

    for (let i = 0; i < binCount; i++) {
      const binStart = windowStart + i * binDuration;
      const binEnd = binStart + binDuration;
      const speakerCounts = new Map<string, number>();
      let count = 0;

      for (const w of words) {
        if (w.end < binStart) continue;
        if (w.start > binEnd) break;
        count++;
        speakerCounts.set(w.speaker, (speakerCounts.get(w.speaker) || 0) + 1);
      }

      let dominant = "";
      let maxCount = 0;
      for (const [spk, cnt] of speakerCounts) {
        if (cnt > maxCount) { dominant = spk; maxCount = cnt; }
      }

      result.push({ startTime: binStart, endTime: binEnd, wordCount: count, dominantSpeaker: dominant });
    }

    return result;
  }, [words, windowStart, windowEnd, windowDuration, useWaveform]);

  const maxWordCount = useMemo(
    () => Math.max(1, ...bins.map((b) => b.wordCount)),
    [bins],
  );

  // Diarization blocks for low zoom
  const visibleDiarization = useMemo(() => {
    if (useWaveform) return [];
    return diarization.filter((s) => s.end > windowStart && s.start < windowEnd);
  }, [diarization, windowStart, windowEnd, useWaveform]);

  // Merge adjacent same-speaker diarization segments
  const merged = useMemo(() => {
    if (visibleDiarization.length === 0) return [];
    const result: typeof visibleDiarization = [];
    let current = {
      ...visibleDiarization[0],
      start: Math.max(visibleDiarization[0].start, windowStart),
      end: Math.min(visibleDiarization[0].end, windowEnd),
    };
    for (let i = 1; i < visibleDiarization.length; i++) {
      const seg = visibleDiarization[i];
      const clipped = {
        ...seg,
        start: Math.max(seg.start, windowStart),
        end: Math.min(seg.end, windowEnd),
      };
      if (clipped.speaker === current.speaker && clipped.start - current.end < 1) {
        current.end = clipped.end;
      } else {
        result.push(current);
        current = clipped;
      }
    }
    result.push(current);
    return result;
  }, [visibleDiarization, windowStart, windowEnd]);

  const bandHeight = useWaveform ? 24 : 12;

  return (
    <div
      className="relative w-full bg-neutral-900 rounded overflow-hidden border border-neutral-800"
      style={{ height: `${bandHeight}px` }}
    >
      {useWaveform
        ? bins.map((bin, i) => {
            if (bin.wordCount === 0) return null;
            const left = ((bin.startTime - windowStart) / windowDuration) * 100;
            const width = ((bin.endTime - bin.startTime) / windowDuration) * 100;
            const height = (bin.wordCount / maxWordCount) * 100;

            return (
              <div
                key={i}
                className="absolute bottom-0"
                style={{
                  left: `${left}%`,
                  width: `${Math.max(width, 0.2)}%`,
                  height: `${height}%`,
                  backgroundColor: bin.dominantSpeaker
                    ? speakerColor(bin.dominantSpeaker, colorIndex)
                    : "transparent",
                }}
              />
            );
          })
        : merged.map((seg, i) => {
            const left = ((seg.start - windowStart) / windowDuration) * 100;
            const width = ((seg.end - seg.start) / windowDuration) * 100;
            if (width < 0.05) return null;
            return (
              <div
                key={i}
                className="absolute top-0 h-full"
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  backgroundColor: speakerColor(seg.speaker, colorIndex),
                }}
                title={seg.speaker}
              />
            );
          })}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/ionosphere && npx tsc --noEmit`

- [ ] **Step 3: Wire WaveformBand into TrackViewContent**

In `TrackViewContent.tsx`, replace the existing `<DiarizationBand>` usage with `<WaveformBand>`, passing the required props (`words`, `diarization`, `allSpeakers`, `zoomLevel`).

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere/src/app/components/WaveformBand.tsx \
        apps/ionosphere/src/app/tracks/\[stream\]/TrackViewContent.tsx
git commit -m "feat(editor): waveform/diarization band with zoom morphing"
```

---

### Task 11: Speaker Popover

**Files:**
- Create: `apps/ionosphere/src/app/components/SpeakerPopover.tsx`

- [ ] **Step 1: Create the speaker popover**

```tsx
// apps/ionosphere/src/app/components/SpeakerPopover.tsx
"use client";

import { useState, useRef, useEffect } from "react";
import { useTimelineEngine } from "@/lib/timeline-engine";

interface SpeakerPopoverProps {
  speakerId: string;
  position: { x: number; y: number };
  onClose: () => void;
}

export default function SpeakerPopover({ speakerId, position, onClose }: SpeakerPopoverProps) {
  const { speakerNames, applyCorrection, effectiveTalks } = useTimelineEngine();
  const [name, setName] = useState(speakerNames.get(speakerId) || "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Find talks where this speaker is dominant (rough heuristic)
  const relatedTalks = effectiveTalks.filter((t) =>
    t.speakers.some((s) => s.toLowerCase().includes(speakerId.toLowerCase())),
  );

  const handleSubmit = () => {
    if (name.trim()) {
      applyCorrection({ type: "name_speaker", speakerId, name: name.trim() });
    }
    onClose();
  };

  return (
    <div
      className="fixed z-50 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl p-3 w-64"
      style={{ left: position.x, top: position.y }}
    >
      <div className="text-xs text-neutral-500 mb-2">{speakerId}</div>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
          if (e.key === "Escape") onClose();
        }}
        placeholder="Speaker name"
        className="w-full px-2 py-1 text-sm bg-neutral-900 border border-neutral-700 rounded text-neutral-200 placeholder-neutral-600 mb-2"
      />
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500"
        >
          Save
        </button>
        <button
          onClick={onClose}
          className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
        >
          Cancel
        </button>
      </div>
      {relatedTalks.length > 0 && (
        <div className="mt-2 border-t border-neutral-700 pt-2">
          <div className="text-[10px] text-neutral-500 mb-1">Appears in:</div>
          {relatedTalks.slice(0, 5).map((t) => (
            <div key={t.rkey} className="text-[10px] text-neutral-400 truncate">
              {t.title}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/ionosphere && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere/src/app/components/SpeakerPopover.tsx
git commit -m "feat(editor): speaker naming popover"
```

---

### Task 12: Ground Truth Export

**Files:**
- Create: `apps/ionosphere/src/lib/ground-truth-export.ts`
- Create: `apps/ionosphere/src/lib/ground-truth-export.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/ionosphere/src/lib/ground-truth-export.test.ts
import { describe, it, expect } from "vitest";
import { exportGroundTruth } from "./ground-truth-export";
import type { EffectiveTalk } from "./corrections";

describe("exportGroundTruth", () => {
  it("exports only verified talks", () => {
    const talks: EffectiveTalk[] = [
      { rkey: "t1", title: "Talk 1", speakers: ["Alice"], startSeconds: 100, endSeconds: 500, confidence: "high", verified: true },
      { rkey: "t2", title: "Talk 2", speakers: ["Bob"], startSeconds: 500, endSeconds: 900, confidence: "high", verified: false },
    ];
    const result = exportGroundTruth("test-stream", talks, new Map());
    expect(result.talks).toHaveLength(1);
    expect(result.talks[0].rkey).toBe("t1");
    expect(result.talks[0].verified).toBe(true);
    expect(result.talks[0].ground_truth_start).toBe(100);
    expect(result.talks[0].tolerance_seconds).toBe(120);
  });

  it("includes speaker name from mapping", () => {
    const talks: EffectiveTalk[] = [
      { rkey: "t1", title: "Talk 1", speakers: [], startSeconds: 100, endSeconds: 500, confidence: "high", verified: true },
    ];
    const speakerNames = new Map([["SPEAKER_01", "Alice Smith"]]);
    // The dominant speaker logic is at the integration level.
    // For the export function, we pass speaker name directly.
    const result = exportGroundTruth("test-stream", talks, speakerNames, { t1: "SPEAKER_01" });
    expect(result.talks[0].speaker).toBe("Alice Smith");
  });

  it("returns empty string for unnamed speaker", () => {
    const talks: EffectiveTalk[] = [
      { rkey: "t1", title: "Talk 1", speakers: [], startSeconds: 100, endSeconds: 500, confidence: "high", verified: true },
    ];
    const result = exportGroundTruth("test-stream", talks, new Map(), { t1: "SPEAKER_99" });
    expect(result.talks[0].speaker).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/ionosphere && npx vitest run src/lib/ground-truth-export.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement ground truth export**

```ts
// apps/ionosphere/src/lib/ground-truth-export.ts
import type { EffectiveTalk } from "./corrections";

interface GroundTruthTalk {
  rkey: string;
  title: string;
  speaker: string;
  ground_truth_start: number;
  tolerance_seconds: number;
  verified: boolean;
  notes: string;
}

interface GroundTruthExport {
  stream: string;
  talks: GroundTruthTalk[];
}

export function exportGroundTruth(
  streamSlug: string,
  talks: EffectiveTalk[],
  speakerNames: Map<string, string>,
  dominantSpeakers?: Record<string, string>, // rkey -> speakerId
): GroundTruthExport {
  const verified = talks.filter((t) => t.verified);

  return {
    stream: streamSlug,
    talks: verified.map((t) => {
      const speakerId = dominantSpeakers?.[t.rkey];
      const speaker = speakerId ? (speakerNames.get(speakerId) || "") : "";

      return {
        rkey: t.rkey,
        title: t.title,
        speaker,
        ground_truth_start: t.startSeconds,
        tolerance_seconds: 120,
        verified: true,
        notes: `Verified via alignment editor. Confidence: ${t.confidence}.`,
      };
    }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/ionosphere && npx vitest run src/lib/ground-truth-export.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere/src/lib/ground-truth-export.ts apps/ionosphere/src/lib/ground-truth-export.test.ts
git commit -m "feat(editor): ground truth export from verified talks"
```

---

### Task 13: Add Mode (Drag-to-Create) and SpeakerPopover Integration

**Files:**
- Modify: `apps/ionosphere/src/app/components/InteractionOverlay.tsx`
- Modify: `apps/ionosphere/src/app/components/WaveformBand.tsx`
- Modify: `apps/ionosphere/src/app/tracks/[stream]/TrackViewContent.tsx`

This task implements the missing Add mode interaction and wires the SpeakerPopover into the waveform band.

- [ ] **Step 1: Add drag-to-create to InteractionOverlay**

Add state for Add mode drag (separate from trim drag):

```tsx
// In InteractionOverlay, add:
const [addDrag, setAddDrag] = useState<{ startTime: number; currentTime: number } | null>(null);

// Add mode: mousedown on empty gap starts a drag to define new segment
useEffect(() => {
  if (!editingEnabled || mode !== "add") return;

  const timeline = document.querySelector("[data-timeline-bar]") as HTMLElement;
  if (!timeline) return;

  const onMouseDown = (e: MouseEvent) => {
    const rect = timeline.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const time = pixelToTime(px);
    setAddDrag({ startTime: time, currentTime: time });
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!addDrag) return;
    const rect = timeline.getBoundingClientRect();
    const px = e.clientX - rect.left;
    setAddDrag((prev) => prev ? { ...prev, currentTime: pixelToTime(px) } : null);
  };

  const onMouseUp = () => {
    if (!addDrag) return;
    const start = Math.min(addDrag.startTime, addDrag.currentTime);
    const end = Math.max(addDrag.startTime, addDrag.currentTime);
    if (end - start > 5) { // Minimum 5 second segment
      const rkey = crypto.randomUUID().slice(0, 8);
      applyCorrection({ type: "add_talk", rkey, title: "Untitled", startSeconds: start, endSeconds: end });
    }
    setAddDrag(null);
  };

  timeline.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  return () => {
    timeline.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  };
}, [editingEnabled, mode, addDrag, pixelToTime, applyCorrection]);
```

Also render the add-drag preview rectangle:
```tsx
{addDrag && (
  <div
    className="absolute top-0 h-full bg-blue-500/20 border border-blue-500/40 z-20 pointer-events-none"
    style={{
      left: `${timeToPixel(Math.min(addDrag.startTime, addDrag.currentTime))}px`,
      width: `${Math.abs(timeToPixel(addDrag.currentTime) - timeToPixel(addDrag.startTime))}px`,
    }}
  />
)}
```

Add `applyCorrection` and `mode` to the destructured engine values.

- [ ] **Step 2: Add click handler for SpeakerPopover to WaveformBand**

In `WaveformBand.tsx`, add a click handler that identifies the speaker at the clicked position and opens the popover:

```tsx
// Add to WaveformBand props:
onSpeakerClick?: (speakerId: string, position: { x: number; y: number }) => void;

// Add to the band container div:
onClick={(e) => {
  if (!onSpeakerClick) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const fraction = (e.clientX - rect.left) / rect.width;
  const time = windowStart + fraction * windowDuration;
  // Find speaker at this time from diarization
  const seg = diarization.find((s) => s.start <= time && s.end >= time);
  if (seg) {
    onSpeakerClick(seg.speaker, { x: e.clientX, y: e.clientY });
  }
}}
```

- [ ] **Step 3: Wire SpeakerPopover into TrackViewContent**

In `TrackViewInner`, add state for the popover and render it:

```tsx
import SpeakerPopover from "@/app/components/SpeakerPopover";

// In TrackViewInner:
const [speakerPopover, setSpeakerPopover] = useState<{ speakerId: string; position: { x: number; y: number } } | null>(null);

// In the WaveformBand usage:
<WaveformBand
  words={words}
  diarization={track.diarization}
  allSpeakers={allSpeakers}
  zoomLevel={zoomLevel}
  onSpeakerClick={(speakerId, position) => setSpeakerPopover({ speakerId, position })}
/>

// After the timeline area, render the popover:
{speakerPopover && (
  <SpeakerPopover
    speakerId={speakerPopover.speakerId}
    position={speakerPopover.position}
    onClose={() => setSpeakerPopover(null)}
  />
)}
```

- [ ] **Step 4: Replace DiarizationBand with WaveformBand in TrackViewContent**

In the template, replace the `<DiarizationBand>` section:

Old:
```tsx
{track.diarization.length > 0 && (
  <div className="mt-1">
    <DiarizationBand
      segments={visibleDiarization}
      allSpeakers={allSpeakers}
      durationSeconds={windowDuration}
      offsetSeconds={windowStart}
    />
  </div>
)}
```

New:
```tsx
{track.diarization.length > 0 && (
  <div className="mt-1">
    <WaveformBand
      words={words}
      diarization={track.diarization}
      allSpeakers={allSpeakers}
      zoomLevel={zoomLevel}
      onSpeakerClick={(speakerId, position) => setSpeakerPopover({ speakerId, position })}
    />
  </div>
)}
```

Update imports: remove `DiarizationBand`, add `WaveformBand` and `SpeakerPopover`.

- [ ] **Step 5: Verify TypeScript compiles and tests pass**

Run: `cd apps/ionosphere && npx tsc --noEmit && npx vitest run`
Expected: All tests pass, no type errors

- [ ] **Step 6: Commit**

```bash
git add apps/ionosphere/src/app/components/InteractionOverlay.tsx \
        apps/ionosphere/src/app/components/WaveformBand.tsx \
        apps/ionosphere/src/app/components/SpeakerPopover.tsx \
        apps/ionosphere/src/app/tracks/\[stream\]/TrackViewContent.tsx
git commit -m "feat(editor): add mode drag-to-create, speaker popover integration, waveform band"
```

---

### Task 14: Manual Smoke Test

This is not automated — verify the full flow works in the browser.

- [ ] **Step 1: Start the dev servers**

Run: `cd apps/ionosphere-appview && npm run dev` (in one terminal)
Run: `cd apps/ionosphere && npm run dev` (in another terminal)

- [ ] **Step 2: Verify read-only mode still works**

Navigate to `http://localhost:3002/tracks/great-hall-day-1`. Verify:
- Video player loads
- Timeline shows talk segments with colors
- Waveform/diarization band shows at bottom
- Click to seek works
- Zoom/pan works
- Talk list and transcript tabs work

- [ ] **Step 3: Test edit mode**

Click "Edit" button. Verify:
- Toolbar appears with mode buttons
- Select mode: clicking talks highlights them, talk list highlights selected
- Trim mode: boundary handles appear on hover, drag works with snap guides
- Split mode: clicking on a talk splits it
- Add mode: click-drag on an empty gap creates a new segment
- Delete: select a talk, press Backspace to delete
- Keyboard shortcuts (Space, arrows, J/K/L, V/T/S/A)
- Undo/redo (Ctrl+Z / Ctrl+Shift+Z)
- Boundary nudging ([ and ] with selected talk)
- Playhead nudging (arrow keys, shift+arrows)

- [ ] **Step 4: Test save/load cycle**

Make an edit, press Ctrl+S (or click Save). Reload the page. Verify the edit persists.

- [ ] **Step 5: Test verification**

Select a talk, press Enter to verify. Verify checkmark appears on timeline and talk list. Check the progress counter updates.

- [ ] **Step 6: Test waveform morphing**

Zoom in past 4x. Verify the diarization band transitions from flat speaker-colored blocks to a height-varying waveform.

- [ ] **Step 7: Test speaker naming**

Click on a diarization segment. Verify the popover appears with the speaker ID and text input. Type a name, click Save. Verify the name appears in tooltips.
