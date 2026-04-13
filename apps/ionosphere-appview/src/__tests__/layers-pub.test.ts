import { describe, it, expect } from 'vitest';
import { transcriptToLayersPub, nlpToAnnotationLayers } from '../../../../formats/tv.ionosphere/ts/layers-pub.js';

describe('Lens 1: transcript → expression + segmentation', () => {
  const transcript = {
    $type: 'tv.ionosphere.transcript',
    talkUri: 'at://did:plc:test/tv.ionosphere.talk/test-talk',
    text: 'Hello world foo bar',
    startMs: 1000,
    // word durations: Hello=200ms, world=300ms, 100ms gap, foo=150ms, bar=250ms
    timings: [200, 300, -100, 150, 250],
  };

  const did = 'did:plc:test';
  const talkRkey = 'test-talk';

  it('produces an expression record with correct fields', async () => {
    const { expression } = await transcriptToLayersPub(transcript, did, talkRkey);
    expect(expression.$type).toBe('pub.layers.expression.expression');
    expect(expression.id).toBe('test-talk');
    expect(expression.kind).toBe('transcript');
    expect(expression.text).toBe('Hello world foo bar');
    expect(expression.language).toBe('en');
    expect(expression.sourceRef).toBe('at://did:plc:test/tv.ionosphere.transcript/test-talk-transcript');
    expect(expression.metadata.tool).toBe('ionosphere-pipeline');
    expect(expression.metadata.timestamp).toBeDefined();
    expect(expression.createdAt).toBeDefined();
  });

  it('produces a segmentation record with word tokens', async () => {
    const { segmentation } = await transcriptToLayersPub(transcript, did, talkRkey);
    expect(segmentation.$type).toBe('pub.layers.segmentation.segmentation');
    expect(segmentation.expression).toBe(
      'at://did:plc:test/pub.layers.expression.expression/test-talk-expression'
    );
    expect(segmentation.tokenizations).toHaveLength(1);

    const tok = segmentation.tokenizations[0];
    expect(tok.kind).toBe('word');
    expect(tok.tokens).toHaveLength(4);

    // Check first token
    expect(tok.tokens[0].tokenIndex).toBe(0);
    expect(tok.tokens[0].text).toBe('Hello');
    expect(tok.tokens[0].textSpan.byteStart).toBe(0);
    expect(tok.tokens[0].textSpan.byteEnd).toBe(5);
    expect(tok.tokens[0].temporalSpan.start).toBe(1000);
    expect(tok.tokens[0].temporalSpan.ending).toBe(1200);

    // Check third token (after gap) — byte offsets and temporal span
    expect(tok.tokens[2].text).toBe('foo');
    expect(tok.tokens[2].textSpan.byteStart).toBe(12); // "Hello world " = 12 bytes
    expect(tok.tokens[2].textSpan.byteEnd).toBe(15);
    expect(tok.tokens[2].temporalSpan.start).toBe(1600); // 1000+200+300+100gap
    expect(tok.tokens[2].temporalSpan.ending).toBe(1750);
  });
});

describe('Lens 2: NLP annotations → annotation layers', () => {
  const nlpAnnotations = {
    talkRkey: 'test-talk',
    sentences: [
      { byteStart: 0, byteEnd: 11 },
      { byteStart: 12, byteEnd: 19 },
    ],
    paragraphs: [
      { byteStart: 0, byteEnd: 19 },
    ],
    entities: [
      { byteStart: 0, byteEnd: 5, label: 'Hello', nerType: 'MISC' },
      { byteStart: 12, byteEnd: 15, label: 'foo', nerType: 'ORG', conceptUri: 'at://did:plc:test/tv.ionosphere.concept/foo' },
    ],
    topicBreaks: [
      { byteStart: 12 },
    ],
    metadata: { tool: 'spacy/en_core_web_sm' },
  };

  const did = 'did:plc:test';
  const talkRkey = 'test-talk';
  const expressionUri = 'at://did:plc:test/pub.layers.expression.expression/test-talk-expression';

  it('produces 4 annotation layer records', async () => {
    const layers = await nlpToAnnotationLayers(nlpAnnotations, did, talkRkey, expressionUri);
    expect(Object.keys(layers)).toEqual(['sentences', 'paragraphs', 'entities', 'topics']);
  });

  it('sentences layer has correct structure', async () => {
    const { sentences } = await nlpToAnnotationLayers(nlpAnnotations, did, talkRkey, expressionUri);
    expect(sentences.$type).toBe('pub.layers.annotation.annotationLayer');
    expect(sentences.expression).toBe(expressionUri);
    expect(sentences.kind).toBe('span');
    expect(sentences.subkind).toBe('sentence-boundary');
    expect(sentences.sourceMethod).toBe('automatic');
    expect(sentences.metadata.tool).toBe('ionosphere-nlp-pipeline');
    expect(sentences.annotations).toHaveLength(2);
    expect(sentences.annotations[0].anchor.textSpan).toEqual({ byteStart: 0, byteEnd: 11 });
  });

  it('entities layer wraps features in featureMap', async () => {
    const { entities } = await nlpToAnnotationLayers(nlpAnnotations, did, talkRkey, expressionUri);
    expect(entities.annotations).toHaveLength(2);

    // Plain entity — nerType is always present
    const plain = entities.annotations[0];
    expect(plain.label).toBe('Hello');
    expect(plain.features.entries).toContainEqual({ key: 'nerType', value: 'MISC' });

    // Entity with conceptUri — all known keys forwarded to features
    const withConcept = entities.annotations[1];
    expect(withConcept.features.entries).toContainEqual({
      key: 'conceptUri',
      value: 'at://did:plc:test/tv.ionosphere.concept/foo',
    });
    expect(withConcept.features.entries).toContainEqual({ key: 'nerType', value: 'ORG' });
  });

  it('topics layer has correct subkind and uses zero-width spans', async () => {
    const { topics } = await nlpToAnnotationLayers(nlpAnnotations, did, talkRkey, expressionUri);
    expect(topics.subkind).toBe('topic-segment');
    expect(topics.annotations).toHaveLength(1);
    expect(topics.annotations[0].anchor.textSpan).toEqual({ byteStart: 12, byteEnd: 12 });
  });
});
