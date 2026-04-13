/**
 * Lens transforms between tv.ionosphere records and pub.layers records.
 *
 * Lens 1: transcriptToLayersPub
 *   tv.ionosphere.transcript → pub.layers.expression.expression
 *                             + pub.layers.segmentation.segmentation
 *
 * Lens 2: nlpToAnnotationLayers
 *   NLP annotations → 4 pub.layers.annotation.annotationLayer records
 *
 * Lens 3: layersPubToDocument (reverse)
 *   pub.layers records → tv.ionosphere document with facets
 *
 * The timings replay algorithm matches decodeToDocument() in
 * transcript-encoding.ts — uses TextEncoder for correct UTF-8 byte offsets,
 * and indexOf with searchFrom for word position tracking.
 */

import type { Document, DocumentFacet, CompactTranscript } from './transcript-encoding.js';

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

export interface TextToken {
  tokenIndex: number;
  textSpan: TokenSpan;
}

export interface TemporalToken {
  tokenIndex: number;
  temporalSpan: TemporalSpan;
}

export interface TextTokenization {
  kind: string;
  tokens: TextToken[];
}

export interface TemporalTokenization {
  kind: string;
  tokens: TemporalToken[];
}

export interface SegmentationRecord {
  $type: 'pub.layers.segmentation.segmentation';
  expression: string;
  tokenizations: TextTokenization[];
  createdAt: string;
}

export interface TemporalSegmentationRecord {
  $type: 'pub.layers.segmentation.segmentation';
  expression: string;
  tokenizations: TemporalTokenization[];
  createdAt: string;
}

/** Maximum tokens per segmentation record to stay under PDS body limits (~200KB CBOR) */
const MAX_TOKENS_PER_RECORD = 2000;

export interface LayersPubResult {
  expression: ExpressionRecord;
  segmentations: SegmentationRecord[];
  temporals: TemporalSegmentationRecord[];
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

  // Build segmentation records using timings replay algorithm
  // (matches decodeToDocument in transcript-encoding.ts)
  // Two records: textSpan-only (word boundaries) and temporalSpan-only (timing)
  const encoder = new TextEncoder();
  const words = transcript.text.split(/\s+/).filter((w) => w.length > 0);
  const textTokens: TextToken[] = [];
  const temporalTokens: TemporalToken[] = [];

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

          textTokens.push({
            tokenIndex: wordIndex,
            textSpan: { byteStart, byteEnd },
          });

          temporalTokens.push({
            tokenIndex: wordIndex,
            temporalSpan: { start: cursor, ending: cursor + value },
          });

          searchFrom = idx + word.length;
        }
        cursor += value;
        wordIndex++;
      }
    }
  }

  const expressionUri = `at://${did}/pub.layers.expression.expression/${talkRkey}-expression`;

  // Chunk tokens to stay under PDS body limits
  const segmentations: SegmentationRecord[] = [];
  const temporals: TemporalSegmentationRecord[] = [];

  for (let i = 0; i < textTokens.length; i += MAX_TOKENS_PER_RECORD) {
    const textChunk = textTokens.slice(i, i + MAX_TOKENS_PER_RECORD);
    const temporalChunk = temporalTokens.slice(i, i + MAX_TOKENS_PER_RECORD);

    segmentations.push({
      $type: 'pub.layers.segmentation.segmentation',
      expression: expressionUri,
      tokenizations: [{ kind: 'word', tokens: textChunk }],
      createdAt: now,
    });

    temporals.push({
      $type: 'pub.layers.segmentation.segmentation',
      expression: expressionUri,
      tokenizations: [{ kind: 'word-temporal', tokens: temporalChunk }],
      createdAt: now,
    });
  }

  return { expression, segmentations, temporals };
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

/**
 * Lens 3 (reverse): Transform pub.layers records back into an ionosphere
 * RelationalText document with facets.
 *
 * This is the materialized view builder — used by the appview indexer to
 * rebuild the talk document when layers.pub records arrive via Jetstream.
 *
 * Timestamp facets are generated from the compact transcript (text + startMs
 * + timings), not from segmentation temporalSpans. This allows the
 * segmentation record to remain small (textSpan only) while keeping temporal
 * data available separately.
 *
 * Round-trip property:
 *   transcriptToLayersPub + nlpToAnnotationLayers + layersPubToDocument
 *   should produce the SAME document as decodeToDocumentWithStructure.
 */
export async function layersPubToDocument(
  expression: ExpressionRecord,
  segmentations: SegmentationRecord | SegmentationRecord[],
  annotationLayers: AnnotationLayersResult,
  compact?: CompactTranscript,
): Promise<Document> {
  const facets: DocumentFacet[] = [];

  // Merge all segmentation chunks into a single token list
  const segArray = Array.isArray(segmentations) ? segmentations : [segmentations];
  const allTokens = segArray.flatMap((s) => s.tokenizations[0].tokens);

  // 1. Timestamp facets from compact transcript timings
  //    Uses the same replay algorithm as decodeToDocument() — the segmentation
  //    provides byte offsets, the compact transcript provides timing.
  if (compact) {
    let cursor = compact.startMs;
    let tokenIdx = 0;

    for (const value of compact.timings) {
      if (value < 0) {
        cursor += Math.abs(value);
      } else {
        if (tokenIdx < allTokens.length) {
          const token = allTokens[tokenIdx];
          facets.push({
            index: {
              byteStart: token.textSpan.byteStart,
              byteEnd: token.textSpan.byteEnd,
            },
            features: [
              {
                $type: 'tv.ionosphere.facet#timestamp',
                startTime: cursor * 1_000_000, // ms → ns
                endTime: (cursor + value) * 1_000_000,
              },
            ],
          });
          cursor += value;
          tokenIdx++;
        }
      }
    }
  }

  // 2. Sentence facets
  for (const ann of annotationLayers.sentences.annotations) {
    facets.push({
      index: {
        byteStart: ann.anchor.textSpan.byteStart,
        byteEnd: ann.anchor.textSpan.byteEnd,
      },
      features: [{ $type: 'tv.ionosphere.facet#sentence' }],
    });
  }

  // 3. Paragraph facets
  for (const ann of annotationLayers.paragraphs.annotations) {
    facets.push({
      index: {
        byteStart: ann.anchor.textSpan.byteStart,
        byteEnd: ann.anchor.textSpan.byteEnd,
      },
      features: [{ $type: 'tv.ionosphere.facet#paragraph' }],
    });
  }

  // 4. Entity facets — route based on features entries
  //    conceptUri → #concept-ref, else → #entity
  //    (speakerDid routing not needed — zero instances in actual data)
  for (const ann of annotationLayers.entities.annotations) {
    const entries = ann.features?.entries ?? [];
    const conceptUriEntry = entries.find((e) => e.key === 'conceptUri');
    const nerTypeEntry = entries.find((e) => e.key === 'nerType');

    if (conceptUriEntry) {
      facets.push({
        index: {
          byteStart: ann.anchor.textSpan.byteStart,
          byteEnd: ann.anchor.textSpan.byteEnd,
        },
        features: [
          {
            $type: 'tv.ionosphere.facet#concept-ref',
            conceptUri: conceptUriEntry.value,
            conceptName: ann.label,
          },
        ],
      });
    } else {
      facets.push({
        index: {
          byteStart: ann.anchor.textSpan.byteStart,
          byteEnd: ann.anchor.textSpan.byteEnd,
        },
        features: [
          {
            $type: 'tv.ionosphere.facet#entity',
            label: ann.label,
            nerType: nerTypeEntry?.value,
          },
        ],
      });
    }
  }

  // 5. Topic break facets
  for (const ann of annotationLayers.topics.annotations) {
    facets.push({
      index: {
        byteStart: ann.anchor.textSpan.byteStart,
        byteEnd: ann.anchor.textSpan.byteEnd,
      },
      features: [{ $type: 'tv.ionosphere.facet#topic-break' }],
    });
  }

  return { text: expression.text, facets };
}
