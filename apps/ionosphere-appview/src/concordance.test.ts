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

  it("builds entries sorted alphabetically (case-insensitive)", () => {
    const entries = buildConcordance(transcripts);
    const terms = entries.map((e) => e.term);
    const sorted = [...terms].sort((a, b) => a.localeCompare(b));
    expect(terms).toEqual(sorted);
  });

  it("excludes stopwords", () => {
    const entries = buildConcordance(transcripts);
    const terms = entries.map((e) => e.term.toLowerCase());
    expect(terms).not.toContain("is");
    expect(terms).not.toContain("a");
    expect(terms).not.toContain("for");
  });

  it("aggregates across talks with counts", () => {
    const entries = buildConcordance(transcripts);
    // "protocol" may appear as "Protocol" (proper noun) or "protocol" depending on casing
    const protocol = entries.find((e) => e.term.toLowerCase() === "protocol");
    expect(protocol).toBeDefined();
    const totalTalks = protocol!.talks.length + protocol!.subentries.reduce((s, sub) => s + sub.talks.length, 0);
    expect(totalTalks).toBeGreaterThanOrEqual(2);
  });

  it("includes first timestamp", () => {
    const entries = buildConcordance(transcripts);
    const protocol = entries.find((e) => e.term.toLowerCase() === "protocol");
    expect(protocol).toBeDefined();
    const allTalks = [...protocol!.talks, ...protocol!.subentries.flatMap((s) => s.talks)];
    for (const talk of allTalks) {
      expect(talk.firstTimestampNs).toBeGreaterThanOrEqual(0);
    }
  });

  it("non-proper terms are lowercase", () => {
    const entries = buildConcordance(transcripts);
    for (const entry of entries) {
      if (!entry.proper) {
        expect(entry.term).toBe(entry.term.toLowerCase());
      }
    }
  });

  it("handles empty input", () => {
    expect(buildConcordance([])).toEqual([]);
  });
});
