// apps/ionosphere/src/lib/snap-targets.test.ts
import { describe, it, expect } from "vitest";
import { computeSnapTargets, findNearestSnap, type SnapTarget } from "./snap-targets";

describe("computeSnapTargets", () => {
  it("finds silence gaps > 2s from word timestamps", () => {
    const words = [
      { start: 10, end: 11, speaker: "A" },
      { start: 11.1, end: 12, speaker: "A" },
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
    const result = findNearestSnap(targets, 101.5, "start", 3);
    expect(result).not.toBeNull();
    expect(result!.snappedTime).toBeCloseTo(102.5);
  });

  it("clamps offset to word boundary if overshoot", () => {
    const targets: SnapTarget[] = [
      { type: "silence_gap", time: 100, gapStart: 98, gapEnd: 102, priority: 1, nearestWordAfterGap: 102.2 },
    ];
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
    expect(result!.target.type).toBe("silence_gap");
  });

  it("resolves end boundary snap to gapStart - offset", () => {
    const targets: SnapTarget[] = [
      { type: "silence_gap", time: 100, gapStart: 98, gapEnd: 102, priority: 1 },
    ];
    const result = findNearestSnap(targets, 99, "end", 3);
    expect(result).not.toBeNull();
    expect(result!.snappedTime).toBeCloseTo(97.5);
  });

  it("clamps end boundary offset to word boundary if overshoot", () => {
    const targets: SnapTarget[] = [
      { type: "silence_gap", time: 100, gapStart: 98, gapEnd: 102, priority: 1, nearestWordBeforeGap: 97.8 },
    ];
    const result = findNearestSnap(targets, 99, "end", 3);
    expect(result).not.toBeNull();
    expect(result!.snappedTime).toBeCloseTo(97.8);
  });
});
