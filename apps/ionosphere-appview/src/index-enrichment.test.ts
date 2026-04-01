import { describe, it, expect } from "vitest";
import {
  enrichIndex,
  type ConceptData,
  type TalkRef,
} from "./index-enrichment.js";

describe("enrichIndex", () => {
  const talks: TalkRef[] = [
    { rkey: "t1", title: "Talk One", count: 3, firstTimestampNs: 0 },
    { rkey: "t2", title: "Talk Two", count: 2, firstTimestampNs: 1000 },
    { rkey: "t3", title: "Talk Three", count: 1, firstTimestampNs: 2000 },
  ];

  const concepts: ConceptData[] = [
    {
      name: "AT Protocol",
      rkey: "at-protocol",
      aliases: ["atproto"],
      talkRkeys: ["t1", "t2"],
    },
    {
      name: "decentralization",
      rkey: "decentralization",
      aliases: [],
      talkRkeys: ["t1", "t3"],
    },
  ];

  it("creates subentries for words in 3+ talks", () => {
    const entries = [{ word: "protocol", proper: false, talks }];
    const enriched = enrichIndex(entries, concepts);
    const entry = enriched.find((e) => e.term === "protocol");
    expect(entry!.subentries.length).toBeGreaterThan(0);
  });

  it("generates see references from concept aliases", () => {
    const entries = [
      { word: "atproto", proper: false, talks: [talks[0]] },
      { word: "protocol", proper: false, talks },
    ];
    const enriched = enrichIndex(entries, concepts);
    const atproto = enriched.find((e) => e.term === "atproto");
    expect(atproto!.see).toContain("AT Protocol");
  });

  it("generates see also from shared concepts", () => {
    const entries = [
      { word: "protocol", proper: false, talks },
      {
        word: "decentralization",
        proper: false,
        talks: [talks[0], talks[2]],
      },
    ];
    const enriched = enrichIndex(entries, concepts);
    const protocol = enriched.find((e) => e.term === "protocol");
    // protocol and decentralization share concept "AT Protocol" (t1) and "decentralization" (t1)
    expect(protocol!.seeAlso.length).toBeGreaterThan(0);
  });

  it("passes through entries with few talks as-is", () => {
    const entries = [{ word: "zurich", proper: false, talks: [talks[0]] }];
    const enriched = enrichIndex(entries, concepts);
    expect(enriched[0].subentries).toEqual([]);
    expect(enriched[0].talks).toHaveLength(1);
  });

  it("computes totalCount from talk counts", () => {
    const entries = [{ word: "protocol", proper: false, talks }];
    const enriched = enrichIndex(entries, concepts);
    const entry = enriched.find((e) => e.term === "protocol");
    expect(entry!.totalCount).toBe(6); // 3 + 2 + 1
  });

  it("generates inversions for multi-word proper nouns", () => {
    const entries = [
      {
        word: "AT Protocol",
        proper: true,
        talks: [talks[0]],
      },
    ];
    const enriched = enrichIndex(entries, concepts);
    const inversion = enriched.find((e) => e.term === "Protocol, AT");
    expect(inversion).toBeDefined();
    expect(inversion!.see).toContain("AT Protocol");
  });

  it("limits seeAlso to 5 entries", () => {
    // Create many entries that share concepts
    const manyEntries = Array.from({ length: 10 }, (_, i) => ({
      word: `word${i}`,
      proper: false,
      talks: [talks[0], talks[1], talks[2]],
    }));
    const enriched = enrichIndex(manyEntries, concepts);
    for (const entry of enriched) {
      expect(entry.seeAlso.length).toBeLessThanOrEqual(5);
    }
  });
});
