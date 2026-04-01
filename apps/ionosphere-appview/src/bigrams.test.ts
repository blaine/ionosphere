import { describe, it, expect } from "vitest";
import { extractBigrams } from "./bigrams.js";

describe("extractBigrams", () => {
  const texts = [
    { text: "AT Protocol is a decentralized protocol for open source social networking", talkRkey: "t1" },
    { text: "Building open source tools with AT Protocol", talkRkey: "t2" },
    { text: "Content moderation in decentralized open source systems", talkRkey: "t3" },
  ];

  it("extracts bigrams appearing in multiple talks", () => {
    const bigrams = extractBigrams(texts, new Set(), 2, 0);
    const terms = bigrams.map(b => b.term);
    expect(terms).toContain("open source");
  });

  it("boosts known concept terms", () => {
    const known = new Set(["content moderation"]);
    const bigrams = extractBigrams(texts, known, 1, 0);
    const terms = bigrams.map(b => b.term);
    expect(terms).toContain("content moderation");
  });

  it("excludes stopword-only bigrams", () => {
    const bigrams = extractBigrams(texts, new Set(), 1, 0);
    for (const b of bigrams) {
      // Neither word should be empty after stopword filtering
      expect(b.words[0].length).toBeGreaterThan(0);
      expect(b.words[1].length).toBeGreaterThan(0);
    }
  });

  it("returns empty for empty input", () => {
    expect(extractBigrams([], new Set())).toEqual([]);
  });
});
