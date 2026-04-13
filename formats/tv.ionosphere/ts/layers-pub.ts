/**
 * Lens transforms from tv.ionosphere records to pub.layers records.
 *
 * Lens 1: transcriptToLayersPub
 *   tv.ionosphere.transcript → pub.layers.expression.expression
 *                             + pub.layers.segmentation.segmentation
 *
 * The timings replay algorithm matches decodeToDocument() in
 * transcript-encoding.ts — uses TextEncoder for correct UTF-8 byte offsets,
 * and indexOf with searchFrom for word position tracking.
 */

export interface TranscriptRecord {
  $type: string;
  talkUri: string;
  text: string;
  startMs: number;
  timings: number[];
}

export interface ExpressionRecord {
  $type: 'pub.layers.expression.expression';
  id: string;
  kind: string;
  text: string;
  language: string;
  sourceRef: string;
  metadata: {
    tool: string;
    timestamp: string;
  };
  createdAt: string;
}

export interface TokenSpan {
  byteStart: number;
  byteEnd: number;
}

export interface TemporalSpan {
  start: number;
  ending: number;
}

export interface Token {
  tokenIndex: number;
  text: string;
  textSpan: TokenSpan;
  temporalSpan: TemporalSpan;
}

export interface Tokenization {
  kind: string;
  tokens: Token[];
}

export interface SegmentationRecord {
  $type: 'pub.layers.segmentation.segmentation';
  expression: string;
  tokenizations: Tokenization[];
  createdAt: string;
}

export interface LayersPubResult {
  expression: ExpressionRecord;
  segmentation: SegmentationRecord;
}

/**
 * Lens 1: Transform a compact transcript record into layers.pub
 * expression + segmentation records.
 *
 * The timings replay algorithm (matching decodeToDocument):
 * - Split text by whitespace to get words
 * - Use TextEncoder for UTF-8 byte offsets
 * - Initialize cursor at startMs
 * - Iterate timings: negative = silence gap, positive = word duration
 * - Each word becomes a token with text span and temporal span
 */
export async function transcriptToLayersPub(
  transcript: TranscriptRecord,
  did: string,
  talkRkey: string,
): Promise<LayersPubResult> {
  const now = new Date().toISOString();

  // Build expression record
  const expression: ExpressionRecord = {
    $type: 'pub.layers.expression.expression',
    id: talkRkey,
    kind: 'transcript',
    text: transcript.text,
    language: 'en',
    sourceRef: `at://${did}/tv.ionosphere.transcript/${talkRkey}-transcript`,
    metadata: {
      tool: 'ionosphere-pipeline',
      timestamp: now,
    },
    createdAt: now,
  };

  // Build segmentation record using timings replay algorithm
  // (matches decodeToDocument in transcript-encoding.ts)
  const encoder = new TextEncoder();
  const words = transcript.text.split(/\s+/).filter((w) => w.length > 0);
  const tokens: Token[] = [];

  let cursor = transcript.startMs; // ms
  let wordIndex = 0;
  let searchFrom = 0;

  for (const value of transcript.timings) {
    if (value < 0) {
      // Silence gap — advance cursor by absolute value
      cursor += Math.abs(value);
    } else {
      // Word duration
      if (wordIndex < words.length) {
        const word = words[wordIndex];
        const idx = transcript.text.indexOf(word, searchFrom);
        if (idx !== -1) {
          const byteStart = encoder.encode(transcript.text.slice(0, idx)).length;
          const byteEnd = encoder.encode(
            transcript.text.slice(0, idx + word.length),
          ).length;

          tokens.push({
            tokenIndex: wordIndex,
            text: word,
            textSpan: { byteStart, byteEnd },
            temporalSpan: { start: cursor, ending: cursor + value },
          });

          searchFrom = idx + word.length;
        }
        cursor += value;
        wordIndex++;
      }
    }
  }

  const segmentation: SegmentationRecord = {
    $type: 'pub.layers.segmentation.segmentation',
    expression: `at://${did}/pub.layers.expression.expression/${talkRkey}-expression`,
    tokenizations: [
      {
        kind: 'word',
        tokens,
      },
    ],
    createdAt: now,
  };

  return { expression, segmentation };
}

/**
 * Lens 2: Transform NLP annotations into 4 pub.layers annotation layer records.
 *
 * Produces:
 *   - sentences layer (sentence-boundary spans)
 *   - paragraphs layer (paragraph-boundary spans)
 *   - entities layer (NER spans with featureMap)
 *   - topics layer (topic-segment zero-width spans)
 */

export interface NlpAnnotations {
  talkRkey: string;
  sentences: Array<{ byteStart: number; byteEnd: number }>;
  paragraphs: Array<{ byteStart: number; byteEnd: number }>;
  entities: Array<{
    byteStart: number;
    byteEnd: number;
    label: string;
    [key: string]: unknown;
  }>;
  topicBreaks: Array<{ byteStart: number }>;
  metadata: { tool: string; [key: string]: unknown };
}

export interface Annotation {
  anchor: { textSpan: { byteStart: number; byteEnd: number } };
  label: string;
  features?: { entries: Array<{ key: string; value: unknown }> };
}

export interface AnnotationLayerRecord {
  $type: 'pub.layers.annotation.annotationLayer';
  expression: string;
  kind: string;
  subkind: string;
  sourceMethod: string;
  metadata: { tool: string; timestamp: string };
  annotations: Annotation[];
  createdAt: string;
}

export interface AnnotationLayersResult {
  sentences: AnnotationLayerRecord;
  paragraphs: AnnotationLayerRecord;
  entities: AnnotationLayerRecord;
  topics: AnnotationLayerRecord;
}

export async function nlpToAnnotationLayers(
  nlpAnnotations: NlpAnnotations,
  did: string,
  talkRkey: string,
  expressionUri: string,
): Promise<AnnotationLayersResult> {
  const now = new Date().toISOString();

  const baseMeta = {
    tool: 'ionosphere-nlp-pipeline',
    timestamp: now,
  };

  // Keys to exclude when forwarding entity fields to featureMap entries
  const entityExcludeKeys = new Set(['byteStart', 'byteEnd', 'label']);

  // Sentences layer
  const sentences: AnnotationLayerRecord = {
    $type: 'pub.layers.annotation.annotationLayer',
    expression: expressionUri,
    kind: 'span',
    subkind: 'sentence-boundary',
    sourceMethod: 'automatic',
    metadata: { ...baseMeta },
    annotations: nlpAnnotations.sentences.map((s) => ({
      anchor: { textSpan: { byteStart: s.byteStart, byteEnd: s.byteEnd } },
      label: 'sentence',
    })),
    createdAt: now,
  };

  // Paragraphs layer
  const paragraphs: AnnotationLayerRecord = {
    $type: 'pub.layers.annotation.annotationLayer',
    expression: expressionUri,
    kind: 'span',
    subkind: 'paragraph-boundary',
    sourceMethod: 'automatic',
    metadata: { ...baseMeta },
    annotations: nlpAnnotations.paragraphs.map((p) => ({
      anchor: { textSpan: { byteStart: p.byteStart, byteEnd: p.byteEnd } },
      label: 'paragraph',
    })),
    createdAt: now,
  };

  // Entities layer — forward all extra keys into featureMap entries
  const entities: AnnotationLayerRecord = {
    $type: 'pub.layers.annotation.annotationLayer',
    expression: expressionUri,
    kind: 'span',
    subkind: 'ner',
    sourceMethod: 'automatic',
    metadata: { ...baseMeta },
    annotations: nlpAnnotations.entities.map((e) => {
      const entries: Array<{ key: string; value: unknown }> = [];
      for (const [key, value] of Object.entries(e)) {
        if (!entityExcludeKeys.has(key)) {
          entries.push({ key, value });
        }
      }
      return {
        anchor: { textSpan: { byteStart: e.byteStart, byteEnd: e.byteEnd } },
        label: e.label,
        features: { entries },
      };
    }),
    createdAt: now,
  };

  // Topics layer — zero-width spans (byteEnd === byteStart)
  const topics: AnnotationLayerRecord = {
    $type: 'pub.layers.annotation.annotationLayer',
    expression: expressionUri,
    kind: 'span',
    subkind: 'topic-segment',
    sourceMethod: 'automatic',
    metadata: { ...baseMeta },
    annotations: nlpAnnotations.topicBreaks.map((t) => ({
      anchor: { textSpan: { byteStart: t.byteStart, byteEnd: t.byteStart } },
      label: 'topic-break',
    })),
    createdAt: now,
  };

  return { sentences, paragraphs, entities, topics };
}
