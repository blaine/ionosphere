export interface TranscriptFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{
    $type: string;
    startTime?: number;
    endTime?: number;
    conceptUri?: string;
    conceptRkey?: string;
    conceptName?: string;
    [key: string]: any;
  }>;
}

export interface TranscriptDocument {
  text: string;
  facets: TranscriptFacet[];
}

export interface WordSpan {
  text: string;
  startTime: number;
  endTime: number;
  byteStart: number;
  byteEnd: number;
  // Shared boundary times with adjacent words. These ensure that
  // the brightness at word N's right edge == word N+1's left edge.
  boundaryStartTime: number; // midpoint between prev word's end and this word's start
  boundaryEndTime: number;   // midpoint between this word's end and next word's start
}

export interface ConceptSpan {
  byteStart: number;
  byteEnd: number;
  conceptUri: string;
  conceptRkey: string;
  conceptName: string;
}

export function extractData(doc: TranscriptDocument) {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(doc.text);
  const decoder = new TextDecoder();

  const words: WordSpan[] = [];
  const concepts: ConceptSpan[] = [];

  for (const f of doc.facets) {
    for (const feat of f.features) {
      if (feat.$type === "tv.ionosphere.facet#timestamp") {
        words.push({
          text: decoder.decode(
            textBytes.slice(f.index.byteStart, f.index.byteEnd)
          ),
          startTime: feat.startTime!,
          endTime: feat.endTime!,
          byteStart: f.index.byteStart,
          byteEnd: f.index.byteEnd,
        });
      } else if (feat.$type === "tv.ionosphere.facet#concept-ref") {
        concepts.push({
          byteStart: f.index.byteStart,
          byteEnd: f.index.byteEnd,
          conceptUri: feat.conceptUri!,
          conceptRkey: feat.conceptRkey!,
          conceptName: feat.conceptName!,
        });
      }
    }
  }

  words.sort((a, b) => a.startTime - b.startTime);

  // Compute shared boundary times between adjacent words.
  // The midpoint between word N's endTime and word N+1's startTime
  // is used by both words, guaranteeing brightness continuity.
  for (let i = 0; i < words.length; i++) {
    words[i].boundaryStartTime = i === 0
      ? words[i].startTime
      : (words[i - 1].endTime + words[i].startTime) / 2;
    words[i].boundaryEndTime = i === words.length - 1
      ? words[i].endTime
      : (words[i].endTime + words[i + 1].startTime) / 2;
  }

  // Build a lookup: for each word, which concepts overlap it?
  const wordConcepts = words.map((w) =>
    concepts.filter(
      (c) => c.byteStart < w.byteEnd && c.byteEnd > w.byteStart
    )
  );

  return { words, concepts, wordConcepts };
}

// --- Brightness ---

export const BASE_BRIGHTNESS = 0.3;
export const PEAK_BRIGHTNESS = 1.0;
export const WINDOW_NS = 2_000_000_000; // 2 second falloff

export function brightnessAtTime(currentTimeNs: number, timeNs: number): number {
  const dist = Math.abs(currentTimeNs - timeNs);
  if (dist > WINDOW_NS) return BASE_BRIGHTNESS;
  const t = 1 - dist / WINDOW_NS;
  return BASE_BRIGHTNESS + (PEAK_BRIGHTNESS - BASE_BRIGHTNESS) * t * t;
}

// Concept color: amber tint whose saturation scales with brightness.
// When dim (far from playhead), concepts are barely distinguishable
// from plain text. When lit, they glow gold.
export function toColor(
  brightness: number,
  concept: ConceptSpan | null
): string {
  const v = Math.round(brightness * 255);
  if (!concept) {
    return `rgb(${v} ${v} ${v})`;
  }
  // Saturation scales with brightness — dim concepts are nearly gray
  const sat = brightness * brightness; // quadratic: very low at base, strong at peak
  const r = Math.round(v + sat * (255 - v) * 0.2);
  const g = Math.round(v - sat * v * 0.15);
  const b = Math.round(v - sat * v * 0.55);
  return `rgb(${Math.min(255, r)} ${Math.max(0, g)} ${Math.max(0, b)})`;
}
