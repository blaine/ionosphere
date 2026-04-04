import { describe, it, expect } from "vitest";
import {
  scoreSpeakerChange,
  scoreConfidenceDrop,
  findLowConfidenceZones,
} from "./detect-boundaries-v6.js";

describe("scoreSpeakerChange", () => {
  it("returns high score when dominant speaker changes", () => {
    const wordsBefore = [
      { word: "thanks", start: 0, end: 1, speaker: "SPEAKER_00" },
      { word: "everyone", start: 1, end: 2, speaker: "SPEAKER_00" },
    ];
    const wordsAfter = [
      { word: "hello", start: 5, end: 6, speaker: "SPEAKER_01" },
      { word: "there", start: 6, end: 7, speaker: "SPEAKER_01" },
    ];
    const result = scoreSpeakerChange(wordsBefore, wordsAfter);
    expect(result.score).toBeGreaterThanOrEqual(12);
    expect(result.signal).toContain("speaker_change");
  });

  it("returns higher score when speaker sets are completely different", () => {
    const wordsBefore = [
      { word: "a", start: 0, end: 1, speaker: "SPEAKER_00" },
      { word: "b", start: 1, end: 2, speaker: "SPEAKER_02" },
    ];
    const wordsAfter = [
      { word: "c", start: 5, end: 6, speaker: "SPEAKER_01" },
      { word: "d", start: 6, end: 7, speaker: "SPEAKER_03" },
    ];
    const result = scoreSpeakerChange(wordsBefore, wordsAfter);
    expect(result.score).toBe(15);
    expect(result.signal).toContain("set_change");
  });

  it("returns zero when same speaker continues", () => {
    const wordsBefore = [
      { word: "and", start: 0, end: 1, speaker: "SPEAKER_00" },
      { word: "also", start: 1, end: 2, speaker: "SPEAKER_00" },
    ];
    const wordsAfter = [
      { word: "next", start: 5, end: 6, speaker: "SPEAKER_00" },
      { word: "slide", start: 6, end: 7, speaker: "SPEAKER_00" },
    ];
    const result = scoreSpeakerChange(wordsBefore, wordsAfter);
    expect(result.score).toBe(0);
  });

  it("handles missing speaker data gracefully", () => {
    const wordsBefore = [{ word: "hi", start: 0, end: 1 }];
    const wordsAfter = [{ word: "bye", start: 5, end: 6 }];
    const result = scoreSpeakerChange(wordsBefore, wordsAfter);
    expect(result.score).toBe(0);
  });
});

describe("scoreConfidenceDrop", () => {
  it("penalizes gaps near low avg_logprob (garbled audio)", () => {
    const segments = [
      { start: 0, end: 10, avg_logprob: -0.3, no_speech_prob: 0.1 },
      { start: 10, end: 20, avg_logprob: -1.5, no_speech_prob: 0.8 },
      { start: 20, end: 30, avg_logprob: -0.2, no_speech_prob: 0.05 },
    ];
    const result = scoreConfidenceDrop(segments, 15, 30);
    expect(result.score).toBeLessThan(0);
    expect(result.signal).toContain("garbled");
  });

  it("returns zero for high confidence segments", () => {
    const segments = [
      { start: 0, end: 10, avg_logprob: -0.2, no_speech_prob: 0.05 },
      { start: 10, end: 20, avg_logprob: -0.3, no_speech_prob: 0.1 },
    ];
    const result = scoreConfidenceDrop(segments, 10, 10);
    expect(result.score).toBe(0);
  });

  it("penalizes gaps near no_speech zones", () => {
    const segments = [
      { start: 0, end: 10, avg_logprob: -0.3, no_speech_prob: 0.9 },
      { start: 10, end: 20, avg_logprob: -0.3, no_speech_prob: 0.8 },
    ];
    const result = scoreConfidenceDrop(segments, 10, 15);
    expect(result.score).toBeLessThan(0);
    expect(result.signal).toContain("no_speech");
  });
});

describe("findLowConfidenceZones", () => {
  it("finds contiguous low-confidence segments", () => {
    const segments = [
      { start: 0, end: 10, avg_logprob: -0.3, no_speech_prob: 0.1 },
      { start: 10, end: 20, avg_logprob: -1.5, no_speech_prob: 0.9 },
      { start: 20, end: 30, avg_logprob: -1.8, no_speech_prob: 0.85 },
      { start: 30, end: 45, avg_logprob: -1.2, no_speech_prob: 0.6 },
      { start: 45, end: 55, avg_logprob: -0.2, no_speech_prob: 0.05 },
    ];
    const zones = findLowConfidenceZones(segments);
    expect(zones.length).toBe(1);
    expect(zones[0].start).toBe(10);
    expect(zones[0].end).toBe(45);
  });

  it("ignores short low-confidence stretches", () => {
    const segments = [
      { start: 0, end: 10, avg_logprob: -1.5, no_speech_prob: 0.9 },
      { start: 10, end: 20, avg_logprob: -0.2, no_speech_prob: 0.05 },
    ];
    const zones = findLowConfidenceZones(segments);
    // 10s is under the 30s minimum
    expect(zones.length).toBe(0);
  });

  it("returns empty for all-good segments", () => {
    const segments = [
      { start: 0, end: 10, avg_logprob: -0.3, no_speech_prob: 0.1 },
      { start: 10, end: 20, avg_logprob: -0.2, no_speech_prob: 0.05 },
    ];
    expect(findLowConfidenceZones(segments)).toEqual([]);
  });
});
