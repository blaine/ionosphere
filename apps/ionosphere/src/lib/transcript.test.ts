import { describe, it, expect } from "vitest";
import {
  extractData,
  brightnessAtTime,
  toColor,
  BASE_BRIGHTNESS,
  PEAK_BRIGHTNESS,
  WINDOW_NS,
  type TranscriptDocument,
  type ConceptSpan,
} from "./transcript";

// ---------------------------------------------------------------------------
// Helper: build a TranscriptDocument from simple word descriptors
// ---------------------------------------------------------------------------

function makeDoc(
  words: Array<{ text: string; startNs: number; endNs: number }>,
  concepts: Array<{
    text: string;
    conceptUri: string;
    conceptRkey: string;
    conceptName: string;
  }> = []
): TranscriptDocument {
  const encoder = new TextEncoder();

  // Build the full text by joining words with spaces
  const fullText = words.map((w) => w.text).join(" ");
  const facets: TranscriptDocument["facets"] = [];

  // Compute byte offsets for each word
  let charOffset = 0;
  for (const w of words) {
    const prefix = fullText.slice(0, charOffset);
    const byteStart = encoder.encode(prefix).length;
    const byteEnd = byteStart + encoder.encode(w.text).length;

    facets.push({
      index: { byteStart, byteEnd },
      features: [
        {
          $type: "tv.ionosphere.facet#timestamp",
          startTime: w.startNs,
          endTime: w.endNs,
        },
      ],
    });

    charOffset += w.text.length + 1; // +1 for the space separator
  }

  // Add concept facets — find matching text to compute byte ranges
  for (const c of concepts) {
    const idx = fullText.indexOf(c.text);
    if (idx === -1) throw new Error(`Concept text "${c.text}" not found in document`);
    const byteStart = encoder.encode(fullText.slice(0, idx)).length;
    const byteEnd = byteStart + encoder.encode(c.text).length;

    facets.push({
      index: { byteStart, byteEnd },
      features: [
        {
          $type: "tv.ionosphere.facet#concept-ref",
          conceptUri: c.conceptUri,
          conceptRkey: c.conceptRkey,
          conceptName: c.conceptName,
        },
      ],
    });
  }

  return { text: fullText, facets };
}

// ---------------------------------------------------------------------------
// extractData
// ---------------------------------------------------------------------------

describe("extractData", () => {
  it("extracts words sorted by start time", () => {
    // Provide words out of order to verify sorting
    const doc = makeDoc([
      { text: "world", startNs: 2_000_000_000, endNs: 3_000_000_000 },
      { text: "hello", startNs: 1_000_000_000, endNs: 2_000_000_000 },
    ]);

    const { words } = extractData(doc);
    expect(words).toHaveLength(2);
    expect(words[0].text).toBe("hello");
    expect(words[1].text).toBe("world");
    expect(words[0].startTime).toBeLessThan(words[1].startTime);
  });

  it("computes shared boundary times (midpoints between adjacent words)", () => {
    const doc = makeDoc([
      { text: "one", startNs: 1000, endNs: 2000 },
      { text: "two", startNs: 3000, endNs: 4000 },
      { text: "three", startNs: 5000, endNs: 6000 },
    ]);

    const { words } = extractData(doc);
    expect(words).toHaveLength(3);

    // First word: boundaryStartTime === its own startTime
    expect(words[0].boundaryStartTime).toBe(1000);
    // First word boundaryEndTime = midpoint(2000, 3000) = 2500
    expect(words[0].boundaryEndTime).toBe(2500);

    // KEY INVARIANT: word[N].boundaryEndTime === word[N+1].boundaryStartTime
    expect(words[0].boundaryEndTime).toBe(words[1].boundaryStartTime);
    expect(words[1].boundaryEndTime).toBe(words[2].boundaryStartTime);

    // Last word: boundaryEndTime === its own endTime
    expect(words[2].boundaryEndTime).toBe(6000);
  });

  it("matches concepts to words by byte range overlap", () => {
    const doc = makeDoc(
      [
        { text: "hello", startNs: 1000, endNs: 2000 },
        { text: "world", startNs: 2000, endNs: 3000 },
      ],
      [
        {
          text: "hello",
          conceptUri: "at://did:example/concept/1",
          conceptRkey: "1",
          conceptName: "Greeting",
        },
      ]
    );

    const { wordConcepts } = extractData(doc);
    // "hello" should have the concept
    expect(wordConcepts[0]).toHaveLength(1);
    expect(wordConcepts[0][0].conceptName).toBe("Greeting");
    // "world" should not
    expect(wordConcepts[1]).toHaveLength(0);
  });

  it("handles empty document", () => {
    const doc: TranscriptDocument = { text: "", facets: [] };
    const { words, concepts, wordConcepts } = extractData(doc);
    expect(words).toHaveLength(0);
    expect(concepts).toHaveLength(0);
    expect(wordConcepts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// brightnessAtTime
// ---------------------------------------------------------------------------

describe("brightnessAtTime", () => {
  it("returns PEAK_BRIGHTNESS when currentTime equals wordTime", () => {
    expect(brightnessAtTime(5_000_000_000, 5_000_000_000)).toBe(PEAK_BRIGHTNESS);
  });

  it("returns BASE_BRIGHTNESS beyond WINDOW_NS", () => {
    const far = 10_000_000_000;
    expect(brightnessAtTime(0, far)).toBe(BASE_BRIGHTNESS);
    expect(brightnessAtTime(far, 0)).toBe(BASE_BRIGHTNESS);
  });

  it("returns intermediate values within the window", () => {
    const half = WINDOW_NS / 2;
    const b = brightnessAtTime(0, half);
    expect(b).toBeGreaterThan(BASE_BRIGHTNESS);
    expect(b).toBeLessThan(PEAK_BRIGHTNESS);
  });

  it("is symmetric around current time", () => {
    const center = 5_000_000_000;
    const offset = 500_000_000;
    expect(brightnessAtTime(center, center + offset)).toBe(
      brightnessAtTime(center, center - offset)
    );
  });

  it("uses quadratic easing (drop from half to edge > drop from quarter to half)", () => {
    const center = 5_000_000_000;
    const quarter = WINDOW_NS / 4;
    const half = WINDOW_NS / 2;
    const threeQuarter = (WINDOW_NS * 3) / 4;

    const bQuarter = brightnessAtTime(center, center + quarter);
    const bHalf = brightnessAtTime(center, center + half);
    const bThreeQuarter = brightnessAtTime(center, center + threeQuarter);

    const dropQuarterToHalf = bQuarter - bHalf;
    const dropHalfToThreeQuarter = bHalf - bThreeQuarter;

    // Quadratic ease-out: t^2 curve means the brightness drops
    // less steeply farther from center (flattening toward BASE)
    expect(dropQuarterToHalf).toBeGreaterThan(dropHalfToThreeQuarter);
  });
});

// ---------------------------------------------------------------------------
// toColor
// ---------------------------------------------------------------------------

describe("toColor", () => {
  it("returns grayscale (r===g===b) for non-concept words", () => {
    const color = toColor(0.6, null);
    // Parse rgb(r g b)
    const match = color.match(/rgb\((\d+) (\d+) (\d+)\)/);
    expect(match).not.toBeNull();
    const [, r, g, b] = match!;
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it("returns amber tint (r>g>b) for concept words at high brightness", () => {
    const concept: ConceptSpan = {
      byteStart: 0,
      byteEnd: 5,
      conceptUri: "at://did:example/concept/1",
      conceptRkey: "1",
      conceptName: "Test",
    };
    const color = toColor(PEAK_BRIGHTNESS, concept);
    const match = color.match(/rgb\((\d+) (\d+) (\d+)\)/);
    expect(match).not.toBeNull();
    const [r, g, b] = [Number(match![1]), Number(match![2]), Number(match![3])];
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it("returns near-gray for concepts at BASE_BRIGHTNESS", () => {
    const concept: ConceptSpan = {
      byteStart: 0,
      byteEnd: 5,
      conceptUri: "at://did:example/concept/1",
      conceptRkey: "1",
      conceptName: "Test",
    };
    const color = toColor(BASE_BRIGHTNESS, concept);
    const match = color.match(/rgb\((\d+) (\d+) (\d+)\)/);
    expect(match).not.toBeNull();
    const [r, g, b] = [Number(match![1]), Number(match![2]), Number(match![3])];
    // At low brightness, the saturation is very low (sat = 0.3*0.3 = 0.09)
    // so all channels should be close together
    expect(Math.abs(r - g)).toBeLessThan(10);
    expect(Math.abs(g - b)).toBeLessThan(15);
  });
});
