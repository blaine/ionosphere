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

export interface EntitySpan {
  byteStart: number;
  byteEnd: number;
  label: string;
  nerType?: string;
  speakerDid?: string;
  conceptUri?: string;
  conceptName?: string;
}

export interface SentenceSpan {
  byteStart: number;
  byteEnd: number;
  words: WordSpan[];
}

export interface ParagraphSpan {
  byteStart: number;
  byteEnd: number;
  sentences: SentenceSpan[];
}

export function extractData(doc: TranscriptDocument) {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(doc.text);
  const decoder = new TextDecoder();

  const words: WordSpan[] = [];
  const concepts: ConceptSpan[] = [];
  const entities: EntitySpan[] = [];
  const topicBreakPositions: number[] = [];

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
          boundaryStartTime: 0,
          boundaryEndTime: 0,
        });
      } else if (feat.$type === "tv.ionosphere.facet#concept-ref") {
        concepts.push({
          byteStart: f.index.byteStart,
          byteEnd: f.index.byteEnd,
          conceptUri: feat.conceptUri!,
          conceptRkey: feat.conceptRkey!,
          conceptName: feat.conceptName!,
        });
        entities.push({
          byteStart: f.index.byteStart,
          byteEnd: f.index.byteEnd,
          label: feat.conceptName!,
          conceptUri: feat.conceptUri,
          conceptName: feat.conceptName,
        });
      } else if (feat.$type === "tv.ionosphere.facet#speaker-ref") {
        entities.push({
          byteStart: f.index.byteStart,
          byteEnd: f.index.byteEnd,
          label: feat.label!,
          speakerDid: feat.speakerDid,
        });
      } else if (feat.$type === "tv.ionosphere.facet#entity") {
        entities.push({
          byteStart: f.index.byteStart,
          byteEnd: f.index.byteEnd,
          label: feat.label!,
          nerType: feat.nerType,
        });
      } else if (feat.$type === "tv.ionosphere.facet#topic-break") {
        topicBreakPositions.push(f.index.byteStart);
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

  // --- Build hierarchical structure: paragraphs > sentences > words ---

  // Extract sentence facets
  const sentenceRanges: Array<{ byteStart: number; byteEnd: number }> = [];
  const paragraphRanges: Array<{ byteStart: number; byteEnd: number }> = [];

  for (const f of doc.facets) {
    for (const feat of f.features) {
      if (feat.$type === "tv.ionosphere.facet#sentence") {
        sentenceRanges.push({ byteStart: f.index.byteStart, byteEnd: f.index.byteEnd });
      } else if (feat.$type === "tv.ionosphere.facet#paragraph") {
        paragraphRanges.push({ byteStart: f.index.byteStart, byteEnd: f.index.byteEnd });
      }
    }
  }

  sentenceRanges.sort((a, b) => a.byteStart - b.byteStart);
  paragraphRanges.sort((a, b) => a.byteStart - b.byteStart);

  // If no sentence facets, wrap all words in one singleton sentence
  if (sentenceRanges.length === 0 && words.length > 0) {
    sentenceRanges.push({
      byteStart: 0,
      byteEnd: textBytes.length,
    });
  }

  // If no paragraph facets, wrap all sentences in one singleton paragraph
  if (paragraphRanges.length === 0 && sentenceRanges.length > 0) {
    paragraphRanges.push({
      byteStart: 0,
      byteEnd: textBytes.length,
    });
  }

  // Assign words to sentences
  const sentences: SentenceSpan[] = sentenceRanges.map((s) => ({
    byteStart: s.byteStart,
    byteEnd: s.byteEnd,
    words: [],
  }));

  // Track unassigned words for catch-all sentence
  const assignedWords = new Set<number>();

  for (let wi = 0; wi < words.length; wi++) {
    const w = words[wi];
    for (const s of sentences) {
      if (w.byteStart >= s.byteStart && w.byteEnd <= s.byteEnd) {
        s.words.push(w);
        assignedWords.add(wi);
        break;
      }
    }
  }

  // Words not covered by any sentence go into a catch-all sentence
  if (assignedWords.size < words.length) {
    const catchAll: SentenceSpan = {
      byteStart: 0,
      byteEnd: textBytes.length,
      words: [],
    };
    for (let wi = 0; wi < words.length; wi++) {
      if (!assignedWords.has(wi)) {
        catchAll.words.push(words[wi]);
      }
    }
    sentences.push(catchAll);
  }

  // Assign sentences to paragraphs
  const paragraphs: ParagraphSpan[] = paragraphRanges.map((p) => ({
    byteStart: p.byteStart,
    byteEnd: p.byteEnd,
    sentences: [],
  }));

  const assignedSentences = new Set<number>();

  for (let si = 0; si < sentences.length; si++) {
    const s = sentences[si];
    for (const p of paragraphs) {
      if (s.byteStart >= p.byteStart && s.byteEnd <= p.byteEnd) {
        p.sentences.push(s);
        assignedSentences.add(si);
        break;
      }
    }
  }

  // Sentences not covered by any paragraph go into a catch-all paragraph
  if (assignedSentences.size < sentences.length) {
    const catchAll: ParagraphSpan = {
      byteStart: 0,
      byteEnd: textBytes.length,
      sentences: [],
    };
    for (let si = 0; si < sentences.length; si++) {
      if (!assignedSentences.has(si)) {
        catchAll.sentences.push(sentences[si]);
      }
    }
    paragraphs.push(catchAll);
  }

  // Map topic break byte positions to paragraph indices
  const topicBreaks = new Set<number>();
  for (const pos of topicBreakPositions) {
    for (let pi = 0; pi < paragraphs.length; pi++) {
      if (pos >= paragraphs[pi].byteStart && pos <= paragraphs[pi].byteEnd) {
        topicBreaks.add(pi);
        break;
      }
    }
  }

  return { words, concepts, wordConcepts, paragraphs, entities, topicBreaks };
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
