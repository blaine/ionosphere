# layers.pub Record Publishing via Panproto Lenses — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish NLP enrichment data as layers.pub AT Protocol records, with panproto lenses as the authoritative transform pipeline, and index those records back into the appview's materialized document view.

**Architecture:** Data flows through panproto lenses: compact transcript → expression + segmentation (Lens 1), NLP annotations → annotation layers (Lens 2). The appview indexes layers.pub records and rebuilds the materialized talk document using a reverse lens (Lens 3). No parallel TypeScript transform pipelines — lenses are the single source of truth.

**Tech Stack:** @panproto/core v0.25.1 (WASM), AT Protocol lexicons, better-sqlite3, Hono, vitest

**Spec:** `docs/superpowers/specs/2026-04-13-layers-pub-publishing-design.md`

---

## File Structure

### New files
- `formats/tv.ionosphere/nlpAnnotations.lexicon.json` — NLP annotations schema (lens source, not published to PDS)
- `formats/tv.ionosphere/lenses/transcript-to-expression.lens.json` — Lens 1 spec
- `formats/tv.ionosphere/lenses/nlp-to-annotation-layers.lens.json` — Lens 2 spec
- `formats/tv.ionosphere/lenses/layers-to-document.lens.json` — Lens 3 spec
- `formats/tv.ionosphere/ts/layers-pub.ts` — layers.pub record builders (runs data through panproto lenses)
- `apps/ionosphere-appview/src/layers-indexer.ts` — indexer for layers.pub records + document rebuild
- `apps/ionosphere-appview/src/__tests__/layers-pub.test.ts` — round-trip test: publish → index → verify

### Modified files
- `apps/ionosphere-appview/src/publish.ts` — add Stage 6 (layers.pub publishing)
- `apps/ionosphere-appview/src/db.ts` — add 3 new tables (layers_expressions, layers_segmentations, layers_annotations)
- `apps/ionosphere-appview/src/indexer.ts` — add layers.pub collections to IONOSPHERE_COLLECTIONS + wire to layers-indexer

---

## Chunk 1: NLP Annotations Lexicon + Lens 1 (Transcript → Expression + Segmentation)

### Task 1: Define the NLP annotations lexicon

This lexicon formalizes the JSON shape produced by the NLP pipeline so panproto can use it as a lens source schema. It is never published to PDS.

**Files:**
- Create: `formats/tv.ionosphere/nlpAnnotations.lexicon.json`

- [ ] **Step 1: Write the lexicon**

The NLP JSON has this shape (from `pipeline/data/nlp/*.json`):
```json
{
  "talkRkey": "string",
  "sentences": [{ "byteStart": 0, "byteEnd": 214 }],
  "paragraphs": [{ "byteStart": 0, "byteEnd": 1729 }],
  "entities": [{ "byteStart": 15, "byteEnd": 19, "label": "Matt", "nerType": "PERSON", "conceptUri": "at://..." }],
  "topicBreaks": [{ "byteStart": 1596 }],
  "metadata": { "tool": "spacy/en_core_web_sm", "pauseThresholdMs": 2000, "proximityWords": 5 }
}
```

Write `formats/tv.ionosphere/nlpAnnotations.lexicon.json` as an ATProto lexicon that models this exactly. Key types:
- `nlpSentence`: `{ byteStart: integer, byteEnd: integer }`
- `nlpParagraph`: `{ byteStart: integer, byteEnd: integer }`
- `nlpEntity`: `{ byteStart: integer, byteEnd: integer, label: string, nerType: string, conceptUri?: string (format: at-uri) }`
- `nlpTopicBreak`: `{ byteStart: integer }`
- `nlpMetadata`: `{ tool: string, pauseThresholdMs?: integer, proximityWords?: integer }`
- Main record: `{ talkRkey: string, sentences: nlpSentence[], paragraphs: nlpParagraph[], entities: nlpEntity[], topicBreaks: nlpTopicBreak[], metadata: nlpMetadata }`

- [ ] **Step 2: Validate the lexicon parses with panproto**

```bash
cd apps/ionosphere-appview
npx tsx -e "
  import { loadSchema } from '../../formats/tv.ionosphere/ts/panproto.js';
  import nlp from '../../formats/tv.ionosphere/nlpAnnotations.lexicon.json' assert { type: 'json' };
  const schema = await loadSchema(nlp);
  console.log('NLP annotations schema loaded:', !!schema);
"
```

Expected: `NLP annotations schema loaded: true`

- [ ] **Step 3: Commit**

```bash
git add formats/tv.ionosphere/nlpAnnotations.lexicon.json
git commit -m "feat: define tv.ionosphere.nlpAnnotations lexicon for lens source schema"
```

### Task 2: Define Lens 1 — compact transcript → expression + segmentation

This lens transforms `tv.ionosphere.transcript` records into `pub.layers.expression.expression` + `pub.layers.segmentation.segmentation` records. It is the authoritative transform for the text and temporal mapping.

**Files:**
- Create: `formats/tv.ionosphere/lenses/transcript-to-expression.lens.json`
- Create: `formats/tv.ionosphere/ts/layers-pub.ts`
- Create: `apps/ionosphere-appview/src/__tests__/layers-pub.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/ionosphere-appview/src/__tests__/layers-pub.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { transcriptToLayersPub } from '../../../formats/tv.ionosphere/ts/layers-pub.js';

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

    // Check third token (after gap)
    expect(tok.tokens[2].text).toBe('foo');
    expect(tok.tokens[2].temporalSpan.start).toBe(1600); // 1000+200+300+100gap
    expect(tok.tokens[2].temporalSpan.ending).toBe(1750);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/ionosphere-appview
npx vitest run src/__tests__/layers-pub.test.ts
```

Expected: FAIL — `transcriptToLayersPub` does not exist yet.

- [ ] **Step 3: Write the layers-pub module with Lens 1**

Create `formats/tv.ionosphere/ts/layers-pub.ts`. This module initializes panproto, loads the transcript and layers.pub schemas, builds the lens, and exposes `transcriptToLayersPub()`.

The function must:
1. Initialize panproto WASM (via existing `init()` from panproto.ts)
2. Load `tv.ionosphere.transcript` schema and `pub.layers.expression.expression` + `pub.layers.segmentation.segmentation` schemas
3. Use `autoGenerateWithHints()` to create a protolens chain with hints mapping transcript fields to layers.pub fields
4. Run the transcript record through the lens
5. Post-process: inject `$type`, `sourceRef`, `expression` URI (pre-computed from DID + rkey), `createdAt`
6. Return `{ expression, segmentation }`

The timings replay algorithm is the same as `decodeToDocument()` in `transcript-encoding.ts`:
- Split text by whitespace to get words
- Use TextEncoder for UTF-8 byte offsets
- Iterate timings: negative = silence gap (advance cursor), positive = word duration
- Each word becomes a token with `textSpan: { byteStart, byteEnd }` and `temporalSpan: { start, ending }` in ms

If panproto's auto-generated lens cannot handle the timings array → token list transform natively (likely — this is algorithmic, not structural), implement the timings replay in TypeScript and feed the pre-built token array into the lens as a morphism hint's computed field. The lens still owns the structural mapping; the timings replay is a computed input.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/ionosphere-appview
npx vitest run src/__tests__/layers-pub.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add formats/tv.ionosphere/ts/layers-pub.ts formats/tv.ionosphere/lenses/transcript-to-expression.lens.json apps/ionosphere-appview/src/__tests__/layers-pub.test.ts
git commit -m "feat: Lens 1 — compact transcript to layers.pub expression + segmentation"
```

---

## Chunk 2: Lens 2 (NLP Annotations → Annotation Layers)

### Task 3: Define Lens 2 — NLP annotations → 4 annotation layers

This lens transforms the NLP pipeline JSON into 4 `pub.layers.annotation.annotationLayer` records (sentences, paragraphs, entities, topics).

**Files:**
- Create: `formats/tv.ionosphere/lenses/nlp-to-annotation-layers.lens.json`
- Modify: `formats/tv.ionosphere/ts/layers-pub.ts` — add `nlpToAnnotationLayers()`
- Modify: `apps/ionosphere-appview/src/__tests__/layers-pub.test.ts` — add Lens 2 tests

- [ ] **Step 1: Write the failing tests**

Add to `apps/ionosphere-appview/src/__tests__/layers-pub.test.ts`:

```typescript
import { nlpToAnnotationLayers } from '../../../formats/tv.ionosphere/ts/layers-pub.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/ionosphere-appview
npx vitest run src/__tests__/layers-pub.test.ts
```

Expected: FAIL — `nlpToAnnotationLayers` does not exist.

- [ ] **Step 3: Implement nlpToAnnotationLayers in layers-pub.ts**

Add `nlpToAnnotationLayers()` to `formats/tv.ionosphere/ts/layers-pub.ts`.

The function:
1. Loads the NLP annotations schema and annotation layer schema via panproto
2. Builds protolens with hints for each annotation type
3. For each of the 4 annotation types, maps the NLP data to a `pub.layers.annotation.annotationLayer` record:

**Sentences layer** (`{talkRkey}-sentences`):
- Each sentence `{ byteStart, byteEnd }` → annotation with `anchor: { textSpan: { byteStart, byteEnd } }`, `label`: truncated text (or "sentence")

**Paragraphs layer** (`{talkRkey}-paragraphs`):
- Each paragraph → annotation with `anchor: { textSpan }`, `label: "paragraph"`

**Entities layer** (`{talkRkey}-entities`):
- Each entity → annotation with `anchor: { textSpan }`, `label: entity.label`
- `features: { entries: [] }` — forward all entity keys beyond byteStart/byteEnd/label into entries: `nerType` always, `conceptUri` if present, and any future keys (e.g., `speakerDid`) passthrough automatically

**Topics layer** (`{talkRkey}-topics`):
- Each topicBreak → annotation with `anchor: { textSpan: { byteStart, byteEnd: byteStart } }` (zero-width), `label: "topic-break"`

All layers get: `$type`, `expression` URI, `kind: "span"`, `sourceMethod: "automatic"`, `metadata: { tool, timestamp }`, `createdAt`.

Similar to Lens 1: if the structural fan-out (one source → four targets) is beyond what panproto's protolens can express natively, implement the fan-out in TypeScript and use the lens for each individual layer's structural mapping. The lens remains authoritative for the shape of each annotation layer record.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/ionosphere-appview
npx vitest run src/__tests__/layers-pub.test.ts
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add formats/tv.ionosphere/ts/layers-pub.ts formats/tv.ionosphere/lenses/nlp-to-annotation-layers.lens.json apps/ionosphere-appview/src/__tests__/layers-pub.test.ts
git commit -m "feat: Lens 2 — NLP annotations to 4 annotation layer records"
```

---

## Chunk 3: Publish Pipeline Stage 6

### Task 4: Add layers.pub publishing to publish.ts

Wire the lens functions into the existing publish pipeline as a new Stage 6.

**Files:**
- Modify: `apps/ionosphere-appview/src/publish.ts` — add Stage 6
- Modify: `apps/ionosphere-appview/src/__tests__/layers-pub.test.ts` — add integration test

- [ ] **Step 1: Write the failing integration test**

Add to `apps/ionosphere-appview/src/__tests__/layers-pub.test.ts`:

```typescript
describe('Stage 6: layers.pub publish pipeline', () => {
  it('produces 6 records for a talk with transcript + NLP data', async () => {
    // Use real fixture data from pipeline/data/
    // Read a compact transcript and NLP annotations for the same talk
    // Run both lenses, verify 6 records produced with correct rkeys and $type values
  });
});
```

The test should use fixture data from `pipeline/data/nlp/ats26-keynote.json` and a corresponding transcript to verify end-to-end record production. It does NOT publish to a PDS — it verifies the lens output shape.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/ionosphere-appview
npx vitest run src/__tests__/layers-pub.test.ts
```

- [ ] **Step 3: Add Stage 6 to publish.ts**

Add after the existing transcript publishing stage in `apps/ionosphere-appview/src/publish.ts`:

```typescript
// ── Stage 6: layers.pub records ────────────────────────────────────────────
console.log("\n=== Stage 6: layers.pub records ===");
```

For each talk that has both a transcript and NLP annotations:
- Transcripts: `apps/data/transcripts/{rkey}.json` (same path as existing Stage 5, resolved via `../../data/transcripts` from `src/`)
- NLP: `pipeline/data/nlp/{rkey}.json` (same path as existing Stage 4)

1. Load transcript JSON → `encode()` → CompactTranscript
2. Load NLP annotations JSON
3. Call `transcriptToLayersPub(transcriptRecord, did, rkey)` → expression + segmentation
4. Call `nlpToAnnotationLayers(nlpData, did, rkey, expressionUri)` → 4 annotation layers
5. Publish all 6 records via `pds.putRecord()` — parallel within each talk using `Promise.all()`
6. Log progress: `Published 6 layers.pub records for {rkey}`

Record collections and rkeys:
- `pub.layers.expression.expression` / `{rkey}-expression`
- `pub.layers.segmentation.segmentation` / `{rkey}-segmentation`
- `pub.layers.annotation.annotationLayer` / `{rkey}-sentences`
- `pub.layers.annotation.annotationLayer` / `{rkey}-paragraphs`
- `pub.layers.annotation.annotationLayer` / `{rkey}-entities`
- `pub.layers.annotation.annotationLayer` / `{rkey}-topics`

Also publish the 3 new lens files (transcript-to-expression, nlp-to-annotation-layers, layers-to-document) in Stage 1 alongside the existing 4 lenses.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/ionosphere-appview
npx vitest run src/__tests__/layers-pub.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere-appview/src/publish.ts apps/ionosphere-appview/src/__tests__/layers-pub.test.ts
git commit -m "feat: publish layers.pub records in Stage 6 of publish pipeline"
```

---

## Chunk 4: Lens 3 (Reverse) + Appview Indexer

### Task 5: Define Lens 3 — layers.pub → ionosphere document facets

This is the reverse lens: given layers.pub records, produce the materialized RelationalText document with ionosphere facets. Used by the appview indexer.

**Files:**
- Create: `formats/tv.ionosphere/lenses/layers-to-document.lens.json`
- Modify: `formats/tv.ionosphere/ts/layers-pub.ts` — add `layersPubToDocument()`
- Modify: `apps/ionosphere-appview/src/__tests__/layers-pub.test.ts` — add round-trip test

- [ ] **Step 1: Write the failing round-trip test**

This is the critical correctness test. Feed a real transcript + NLP annotations through Lens 1+2, then feed the output through Lens 3, and compare the result with what `decodeToDocumentWithStructure()` produces for the same input.

```typescript
import { decodeToDocumentWithStructure, encode } from '../../../formats/tv.ionosphere/ts/transcript-encoding.js';
import { transcriptToLayersPub, nlpToAnnotationLayers, layersPubToDocument } from '../../../formats/tv.ionosphere/ts/layers-pub.js';

describe('Lens 3: round-trip correctness', () => {
  it('layers.pub → document matches decodeToDocumentWithStructure output', async () => {
    // Load real fixture data
    // Transcripts: apps/data/transcripts/{rkey}.json (resolved from publish.ts: ../../data/transcripts)
    // NLP: pipeline/data/nlp/{rkey}.json
    const transcriptData = /* read from apps/data/transcripts/ats26-keynote.json */;
    const nlpData = /* read from pipeline/data/nlp/ats26-keynote.json */;

    // Path A: existing direct path
    const compact = encode(transcriptData);
    const directDoc = decodeToDocumentWithStructure(compact, nlpData);

    // Path B: through lenses
    const transcriptRecord = { text: compact.text, startMs: compact.startMs, timings: compact.timings, talkUri: 'at://test/tv.ionosphere.talk/test' };
    const { expression, segmentation } = await transcriptToLayersPub(transcriptRecord, 'did:plc:test', 'test');
    const annotationLayers = await nlpToAnnotationLayers(nlpData, 'did:plc:test', 'test', 'at://...');
    const lensDoc = await layersPubToDocument(expression, segmentation, annotationLayers);

    // Compare
    expect(lensDoc.text).toBe(directDoc.text);
    expect(lensDoc.facets.length).toBe(directDoc.facets.length);
    // Facets may be in different order — sort by byteStart then compare
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/ionosphere-appview
npx vitest run src/__tests__/layers-pub.test.ts
```

- [ ] **Step 3: Implement layersPubToDocument**

Add `layersPubToDocument()` to `formats/tv.ionosphere/ts/layers-pub.ts`.

Inputs: expression record, segmentation record, annotation layers (object with sentences/paragraphs/entities/topics).

Output: `{ text: string, facets: DocumentFacet[] }` — same shape as `decodeToDocumentWithStructure()`.

Transform:
1. `text` comes from the expression record
2. Timestamp facets: iterate segmentation tokens, for each token create a facet with `$type: "tv.ionosphere.facet#timestamp"`, `startTime` and `endTime` in nanoseconds (ms × 1_000_000), `byteStart`/`byteEnd` from token's textSpan
3. Sentence facets: from sentences annotation layer, each annotation → facet with `$type: "tv.ionosphere.facet#sentence"`
4. Paragraph facets: similar, `$type: "tv.ionosphere.facet#paragraph"`
5. Entity facets: route by features — if has `conceptUri` → `#concept-ref`, else → `#entity`
6. Topic facets: `$type: "tv.ionosphere.facet#topic-break"`, zero-width span

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/ionosphere-appview
npx vitest run src/__tests__/layers-pub.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add formats/tv.ionosphere/ts/layers-pub.ts formats/tv.ionosphere/lenses/layers-to-document.lens.json apps/ionosphere-appview/src/__tests__/layers-pub.test.ts
git commit -m "feat: Lens 3 — layers.pub records to ionosphere document facets (round-trip verified)"
```

### Task 6: Add layers.pub DB tables

**Files:**
- Modify: `apps/ionosphere-appview/src/db.ts`

- [ ] **Step 1: Add 3 new tables to migrate()**

Add after the existing `_cursor` table creation in `apps/ionosphere-appview/src/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS layers_expressions (
  uri TEXT PRIMARY KEY,
  rkey TEXT NOT NULL,
  did TEXT NOT NULL,
  transcript_uri TEXT NOT NULL,
  text TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- uri IS the expression URI for this table; other tables reference it via expression_uri
CREATE INDEX IF NOT EXISTS idx_layers_expr_transcript ON layers_expressions(transcript_uri);

CREATE TABLE IF NOT EXISTS layers_segmentations (
  uri TEXT PRIMARY KEY,
  rkey TEXT NOT NULL,
  did TEXT NOT NULL,
  expression_uri TEXT NOT NULL,
  tokens_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_layers_seg_expression ON layers_segmentations(expression_uri);

CREATE TABLE IF NOT EXISTS layers_annotations (
  uri TEXT PRIMARY KEY,
  rkey TEXT NOT NULL,
  did TEXT NOT NULL,
  expression_uri TEXT NOT NULL,
  kind TEXT NOT NULL,
  subkind TEXT NOT NULL,
  annotations_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_layers_ann_expression ON layers_annotations(expression_uri);
```

- [ ] **Step 2: Verify DB migration runs clean**

```bash
cd apps/ionosphere-appview
npx tsx -e "
  import { openDb, migrate } from './src/db.js';
  const db = openDb();
  migrate(db);
  const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'layers_%'\").all();
  console.log('New tables:', tables.map(t => t.name));
"
```

Expected: `New tables: ['layers_expressions', 'layers_segmentations', 'layers_annotations']`

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/db.ts
git commit -m "feat: add layers.pub DB tables (expressions, segmentations, annotations)"
```

### Task 7: Wire layers.pub indexer into appview

**Files:**
- Create: `apps/ionosphere-appview/src/layers-indexer.ts`
- Modify: `apps/ionosphere-appview/src/indexer.ts`

- [ ] **Step 1: Create the layers-indexer module**

Create `apps/ionosphere-appview/src/layers-indexer.ts` with these functions:

```typescript
export function indexExpression(db, did, rkey, uri, record): void
export function indexSegmentation(db, did, rkey, uri, record): void
export function indexAnnotationLayer(db, did, rkey, uri, record): void
export function deleteExpression(db, uri): void
export function deleteSegmentation(db, uri): void
export function deleteAnnotationLayer(db, uri): void
export async function rebuildDocument(db, expressionUri): Promise<void>
```

**indexExpression:** INSERT OR REPLACE into `layers_expressions`. The record's `uri` IS the expression URI (used by other tables' `expression_uri` FK). Extract `sourceRef` as `transcript_uri`.

**indexSegmentation:** INSERT OR REPLACE into `layers_segmentations`. Store tokenizations as JSON.

**indexAnnotationLayer:** INSERT OR REPLACE into `layers_annotations`. Store annotations array as JSON.

**deleteExpression:** DELETE from `layers_expressions` WHERE uri. CASCADE: also delete from `layers_segmentations` and `layers_annotations` WHERE expression_uri matches. Clear the talk's document field in the talks table.

**deleteSegmentation/deleteAnnotationLayer:** DELETE the specific row, then call `rebuildDocument`.

**rebuildDocument:**
1. Look up expression by `uri` (= expression_uri) → get transcript_uri
2. Look up segmentation by expression_uri
3. Look up all annotation layers by expression_uri
4. If expression + segmentation exist, call `layersPubToDocument()` (Lens 3)
5. Find the talk_uri from the transcript table using transcript_uri
6. UPDATE the talk's `document` field with `JSON.stringify(document)`

- [ ] **Step 2: Wire into indexer.ts**

Add 3 new collections to `IONOSPHERE_COLLECTIONS`:

```typescript
"pub.layers.expression.expression",
"pub.layers.segmentation.segmentation",
"pub.layers.annotation.annotationLayer",
```

Add DID filter in `processEvent()` — only process layers.pub records from the bot DID:

```typescript
if (collection.startsWith("pub.layers.") && event.did !== BOT_DID) return;
```

The `BOT_DID` is already resolved in `appview.ts` — pass it to the indexer or make it available as a module-level constant.

Add delete and create/update cases for the 3 new collections in the switch statements, calling the functions from `layers-indexer.ts`.

After each create/update of a layers.pub record, call `rebuildDocument()` with the expression URI.

- [ ] **Step 3: Test indexer locally**

```bash
cd apps/ionosphere-appview
# Start local environment
docker compose up -d
PORT=9401 npx tsx src/appview.ts &
# Publish records
PDS_URL=http://localhost:2690 BOT_HANDLE=ionosphere.test BOT_PASSWORD=ionosphere-dev-password npx tsx src/publish.ts
# Verify layers.pub records were indexed
curl -s http://localhost:9401/xrpc/tv.ionosphere.getTalk?rkey=ats26-keynote | python3 -c "import sys,json; d=json.load(sys.stdin); print('Has document:', bool(d.get('document'))); print('Facet count:', len(d['document']['facets']) if d.get('document') else 0)"
```

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere-appview/src/layers-indexer.ts apps/ionosphere-appview/src/indexer.ts
git commit -m "feat: index layers.pub records and rebuild materialized documents via Lens 3"
```

---

## Chunk 5: Schema Versioning + Final Verification

### Task 8: Initialize panproto VCS

**Files:**
- Project root — panproto VCS state

- [ ] **Step 1: Initialize and commit schemas**

```bash
# From project root
schema init
schema add lexicons/pub/layers/
schema add formats/tv.ionosphere/ionosphere.lexicon.json
schema add formats/tv.ionosphere/nlpAnnotations.lexicon.json
schema add formats/tv.ionosphere/lenses/
schema commit -m "Initial schema commit: layers.pub v0.5.0, ionosphere facets, NLP annotations, 7 lenses"
schema tag v0.5.0
```

- [ ] **Step 2: Verify VCS state**

```bash
schema log
schema status
```

Expected: clean state, one commit, tagged v0.5.0.

- [ ] **Step 3: Commit VCS state to git**

```bash
git add .panproto/ # or wherever schema VCS stores its state
git commit -m "feat: initialize panproto VCS, tag layers.pub v0.5.0"
```

### Task 9: End-to-end verification

- [ ] **Step 1: Run full test suite**

```bash
cd apps/ionosphere-appview
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 2: Run publish against local PDS and verify round-trip**

```bash
cd apps/ionosphere-appview
docker compose up -d
PORT=9401 npx tsx src/appview.ts &
PDS_URL=http://localhost:2690 BOT_HANDLE=ionosphere.test BOT_PASSWORD=ionosphere-dev-password npx tsx src/publish.ts
```

Verify:
1. layers.pub records appear in PDS (check via `com.atproto.repo.listRecords`)
2. Appview indexes them and rebuilds documents
3. Documents served via API match previous output
4. Frontend renders correctly at http://127.0.0.1:9402/talks

- [ ] **Step 3: Commit any fixes**

### Task 10: Deploy

- [ ] **Step 1: Deploy appview**

```bash
flyctl deploy --config fly.appview.toml --remote-only
```

- [ ] **Step 2: Publish to production PDS**

```bash
cd apps/ionosphere-appview
PDS_URL=https://jellybaby.us-east.host.bsky.network \
BOT_HANDLE=ionosphere.tv \
BOT_PASSWORD=<app-password> \
npx tsx src/publish.ts
```

- [ ] **Step 3: Invalidate caches**

```bash
curl -X POST https://api.ionosphere.tv/xrpc/tv.ionosphere.invalidate
```

- [ ] **Step 4: Deploy frontend**

```bash
flyctl deploy --config fly.web.toml --remote-only
```

- [ ] **Step 5: Verify production**

Check https://ionosphere.tv/talks — documents should render with all enrichment annotations intact.
