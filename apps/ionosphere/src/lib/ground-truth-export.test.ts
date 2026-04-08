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
