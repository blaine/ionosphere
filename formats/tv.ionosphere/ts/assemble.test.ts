import { describe, it, expect } from "vitest";
import { assembleDocument, type TranscriptInput } from "./assemble.js";

describe("assembleDocument", () => {
  const transcript: TranscriptInput = {
    text: "Hello world this is a test",
    words: [
      { word: "Hello", start: 0.0, end: 0.5, confidence: 0.99 },
      { word: "world", start: 0.5, end: 1.0, confidence: 0.98 },
      { word: "this", start: 1.0, end: 1.3, confidence: 0.97 },
      { word: "is", start: 1.3, end: 1.5, confidence: 0.99 },
      { word: "a", start: 1.5, end: 1.6, confidence: 0.99 },
      { word: "test", start: 1.6, end: 2.0, confidence: 0.95 },
    ],
  };

  it("creates a document with text matching the transcript", () => {
    const doc = assembleDocument(transcript);
    expect(doc.text).toBe("Hello world this is a test");
  });

  it("creates timestamp facets for each word", () => {
    const doc = assembleDocument(transcript);
    const timestampFacets = doc.facets.filter((f: any) =>
      f.features.some((feat: any) => feat.$type === "tv.ionosphere.facet#timestamp")
    );
    expect(timestampFacets).toHaveLength(6);
  });

  it("timestamp facets have correct byte ranges", () => {
    const doc = assembleDocument(transcript);
    const first = doc.facets.find((f: any) =>
      f.features.some(
        (feat: any) =>
          feat.$type === "tv.ionosphere.facet#timestamp" && feat.startTime === 0
      )
    );
    expect(first).toBeDefined();
    expect(first!.index.byteStart).toBe(0);
    expect(first!.index.byteEnd).toBe(5);
  });

  it("timestamp times are in nanoseconds", () => {
    const doc = assembleDocument(transcript);
    const first = doc.facets[0];
    const ts = first.features.find(
      (f: any) => f.$type === "tv.ionosphere.facet#timestamp"
    );
    expect(ts!.startTime).toBe(0);
    expect(ts!.endTime).toBe(500_000_000);
  });
});
