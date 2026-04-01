import { describe, it, expect } from "vitest";
import { buildConcordance } from "./concordance.js";

describe("buildConcordance", () => {
  const transcripts = [
    {
      talkRkey: "talk-1",
      talkTitle: "Building with AT Protocol",
      text: "AT Protocol is a decentralized protocol for social networking",
      startMs: 0,
      timings: [300, 300, -50, 200, 400, 300, -50, 200, 300, 400],
    },
    {
      talkRkey: "talk-2",
      talkTitle: "Decentralized Identity",
      text: "Protocol design for decentralized identity systems",
      startMs: 0,
      timings: [400, 300, -50, 200, 500, 300, 400],
    },
  ];

  it("builds entries sorted alphabetically", () => {
    const entries = buildConcordance(transcripts);
    const words = entries.map((e) => e.word);
    expect(words).toEqual([...words].sort());
  });

  it("excludes stopwords", () => {
    const entries = buildConcordance(transcripts);
    const words = entries.map((e) => e.word);
    expect(words).not.toContain("is");
    expect(words).not.toContain("a");
    expect(words).not.toContain("for");
  });

  it("aggregates across talks with counts", () => {
    const entries = buildConcordance(transcripts);
    const protocol = entries.find((e) => e.word === "protocol");
    expect(protocol).toBeDefined();
    expect(protocol!.talks).toHaveLength(2);
  });

  it("includes first timestamp", () => {
    const entries = buildConcordance(transcripts);
    const protocol = entries.find((e) => e.word === "protocol");
    for (const talk of protocol!.talks) {
      expect(talk.firstTimestampNs).toBeGreaterThanOrEqual(0);
    }
  });

  it("lowercases all words", () => {
    const entries = buildConcordance(transcripts);
    for (const entry of entries) {
      expect(entry.word).toBe(entry.word.toLowerCase());
    }
  });

  it("handles empty input", () => {
    expect(buildConcordance([])).toEqual([]);
  });
});
