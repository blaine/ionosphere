import { describe, it, expect } from "vitest";
import { encode, decode, decodeToDocument, decodeToDocumentWithStructure, type CompactTranscript } from "./transcript-encoding.js";
import type { TranscriptResult } from "./index.js";

describe("transcript encoding", () => {
  // Contiguous speech: words flow without gaps
  const contiguous: TranscriptResult = {
    text: "hello world this is a test",
    words: [
      { word: "hello", start: 0.0, end: 0.1, confidence: 0.99 },
      { word: "world", start: 0.1, end: 0.2, confidence: 0.98 },
      { word: "this", start: 0.2, end: 0.35, confidence: 0.97 },
      { word: "is", start: 0.35, end: 0.45, confidence: 0.99 },
      { word: "a", start: 0.45, end: 0.5, confidence: 0.99 },
      { word: "test", start: 0.5, end: 0.9, confidence: 0.95 },
    ],
  };

  // Speech with a pause in the middle
  const withPause: TranscriptResult = {
    text: "before pause after pause",
    words: [
      { word: "before", start: 1.0, end: 1.3, confidence: 0.99 },
      { word: "pause", start: 1.3, end: 1.6, confidence: 0.99 },
      // 2 second gap here
      { word: "after", start: 3.6, end: 3.9, confidence: 0.99 },
      { word: "pause", start: 3.9, end: 4.2, confidence: 0.99 },
    ],
  };

  describe("encode", () => {
    it("encodes contiguous speech as all positive durations", () => {
      const compact = encode(contiguous);
      expect(compact.startMs).toBe(0);
      // All positive — no gaps
      expect(compact.timings.every((v) => v > 0)).toBe(true);
      expect(compact.timings).toEqual([100, 100, 150, 100, 50, 400]);
    });

    it("encodes gaps as negative values", () => {
      const compact = encode(withPause);
      expect(compact.startMs).toBe(1000);
      expect(compact.timings).toEqual([300, 300, -2000, 300, 300]);
    });

    it("preserves text", () => {
      const compact = encode(contiguous);
      expect(compact.text).toBe("hello world this is a test");
    });
  });

  describe("decode", () => {
    it("round-trips contiguous speech", () => {
      const compact = encode(contiguous);
      const decoded = decode(compact);
      expect(decoded.words).toHaveLength(6);
      expect(decoded.words[0].word).toBe("hello");
      expect(decoded.words[0].start).toBeCloseTo(0.0, 2);
      expect(decoded.words[0].end).toBeCloseTo(0.1, 2);
      expect(decoded.words[5].word).toBe("test");
      expect(decoded.words[5].start).toBeCloseTo(0.5, 2);
      expect(decoded.words[5].end).toBeCloseTo(0.9, 2);
    });

    it("round-trips speech with pauses", () => {
      const compact = encode(withPause);
      const decoded = decode(compact);
      expect(decoded.words).toHaveLength(4);
      expect(decoded.words[1].end).toBeCloseTo(1.6, 2);
      expect(decoded.words[2].start).toBeCloseTo(3.6, 2);
    });
  });

  describe("decodeToDocument", () => {
    it("produces timestamp facets for each word", () => {
      const compact = encode(contiguous);
      const doc = decodeToDocument(compact);
      expect(doc.text).toBe("hello world this is a test");
      const tsFacets = doc.facets.filter((f) =>
        f.features.some((feat) => feat.$type === "tv.ionosphere.facet#timestamp")
      );
      expect(tsFacets).toHaveLength(6);
    });

    it("has correct byte ranges", () => {
      const compact = encode(contiguous);
      const doc = decodeToDocument(compact);
      // "hello" = bytes 0-5
      expect(doc.facets[0].index.byteStart).toBe(0);
      expect(doc.facets[0].index.byteEnd).toBe(5);
      // "world" = bytes 6-11
      expect(doc.facets[1].index.byteStart).toBe(6);
      expect(doc.facets[1].index.byteEnd).toBe(11);
    });

    it("has timestamps in nanoseconds", () => {
      const compact = encode(contiguous);
      const doc = decodeToDocument(compact);
      const ts = doc.facets[0].features[0];
      expect(ts.startTime).toBe(0);
      expect(ts.endTime).toBe(100_000_000); // 100ms in ns
    });
  });

  describe("size comparison", () => {
    it("compact format is much smaller than full facets", () => {
      const compact = encode(contiguous);
      const doc = decodeToDocument(compact);

      const compactSize = JSON.stringify({
        text: compact.text,
        startMs: compact.startMs,
        timings: compact.timings,
      }).length;

      const fullSize = JSON.stringify(doc).length;

      console.log(`Compact: ${compactSize} bytes, Full: ${fullSize} bytes, Ratio: ${(fullSize / compactSize).toFixed(1)}x`);
      expect(compactSize).toBeLessThan(fullSize);
    });
  });

  describe("decodeToDocumentWithStructure", () => {
    it("adds sentence and paragraph facets from NLP annotations", () => {
      const compact = encode(contiguous);
      const annotations = {
        sentences: [
          { byteStart: 0, byteEnd: 11 },  // "hello world"
          { byteStart: 12, byteEnd: 26 },  // "this is a test"
        ],
        paragraphs: [
          { byteStart: 0, byteEnd: 26 },
        ],
      };
      const doc = decodeToDocumentWithStructure(compact, annotations);

      const sentenceFacets = doc.facets.filter(f =>
        f.features.some(feat => feat.$type === "tv.ionosphere.facet#sentence")
      );
      const paragraphFacets = doc.facets.filter(f =>
        f.features.some(feat => feat.$type === "tv.ionosphere.facet#paragraph")
      );
      expect(sentenceFacets).toHaveLength(2);
      expect(paragraphFacets).toHaveLength(1);
      // Original timestamp facets still present
      const tsFacets = doc.facets.filter(f =>
        f.features.some(feat => feat.$type === "tv.ionosphere.facet#timestamp")
      );
      expect(tsFacets).toHaveLength(6);
    });

    it("produces valid document without annotations (backward compatible)", () => {
      const compact = encode(contiguous);
      const doc = decodeToDocumentWithStructure(compact, null);
      // Same as decodeToDocument — just timestamp facets
      expect(doc.facets.length).toBe(6);
    });

    it("adds entity, speaker-segment, and topic-break facets", () => {
      const compact = encode(contiguous);
      const annotations = {
        sentences: [{ byteStart: 0, byteEnd: 26 }],
        paragraphs: [{ byteStart: 0, byteEnd: 26 }],
        entities: [
          { byteStart: 0, byteEnd: 5, label: "hello", nerType: "PERSON", speakerDid: "did:plc:abc123" },
          { byteStart: 6, byteEnd: 11, label: "world", nerType: "ORG", conceptUri: "at://did:plc:xyz/tv.ionosphere.concept/test" },
          { byteStart: 12, byteEnd: 16, label: "this", nerType: "PRODUCT" },
        ],
        speakerSegments: [
          { byteStart: 0, byteEnd: 26, speakerDid: "did:plc:abc123", speakerName: "Test Speaker" },
        ],
        topicBreaks: [{ byteStart: 12 }],
      };
      const doc = decodeToDocumentWithStructure(compact, annotations);

      const speakerRefs = doc.facets.filter(f => f.features.some(feat => feat.$type === "tv.ionosphere.facet#speaker-ref"));
      const conceptRefs = doc.facets.filter(f => f.features.some(feat => feat.$type === "tv.ionosphere.facet#concept-ref"));
      const entities = doc.facets.filter(f => f.features.some(feat => feat.$type === "tv.ionosphere.facet#entity"));
      const speakerSegs = doc.facets.filter(f => f.features.some(feat => feat.$type === "tv.ionosphere.facet#speaker-segment"));
      const topicBreaks = doc.facets.filter(f => f.features.some(feat => feat.$type === "tv.ionosphere.facet#topic-break"));

      expect(speakerRefs).toHaveLength(1);
      expect(speakerRefs[0].features[0].speakerDid).toBe("did:plc:abc123");
      expect(conceptRefs).toHaveLength(1);
      expect(conceptRefs[0].features[0].conceptUri).toBe("at://did:plc:xyz/tv.ionosphere.concept/test");
      expect(entities).toHaveLength(1);
      expect(entities[0].features[0].label).toBe("this");
      expect(speakerSegs).toHaveLength(1);
      expect(topicBreaks).toHaveLength(1);
    });

    it("handles missing optional annotation fields gracefully", () => {
      const compact = encode(contiguous);
      const annotations = {
        sentences: [{ byteStart: 0, byteEnd: 26 }],
        paragraphs: [{ byteStart: 0, byteEnd: 26 }],
      };
      const doc = decodeToDocumentWithStructure(compact, annotations);
      const tsFacets = doc.facets.filter(f => f.features.some(feat => feat.$type === "tv.ionosphere.facet#timestamp"));
      expect(tsFacets).toHaveLength(6);
    });
  });
});
