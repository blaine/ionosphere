# layers.pub Record Publishing via Panproto Lenses — Design

**Status:** Approved
**Date:** 2026-04-13
**Depends on:** NLP enrichment pipeline (complete), concept deduplication (complete)

## Overview

Publish enrichment data as first-class AT Protocol records using the layers.pub schema. Panproto lenses are the authoritative transforms — all data flows through lenses, no parallel TypeScript pipelines. The existing ionosphere document (text + facets embedded on the talk record) becomes a materialized view rebuilt from layers.pub records.

## Decisions

- **DID:** Publish under ionosphere.tv
- **Annotation layer references:** Point to the transcript's AT URI (`tv.ionosphere.transcript`)
- **Third-party layers:** Not supported yet (no moderation). Comments and reactions are unaffected.
- **Lens namespace:** `org.relationaltext.lens` (consistent with existing 4 lenses)
- **Record keys:** Deterministic, derived from talk rkey (e.g., `{talk.rkey}-expression`)
- **Expression kind:** `kind: "transcript"` (no `kindUri` — it requires AT URI format, and there's no meaningful record to reference)
- **Segmentation tokenization:** `kind: "word"` — carries the temporal mapping; annotations use `anchor.textSpan` (byte offsets) directly
- **Publish ordering:** Expression URI pre-computed from DID + rkey; all records publish in parallel
- **Architecture:** Lenses-first (Approach B) — lenses are authoritative, publish step runs data through lenses

## Section 1: Record Model & Relationships

For each transcript, 6 new records published under ionosphere.tv:

```
tv.ionosphere.transcript/{talk.rkey}-transcript  (already exists)
    │
    ▼ sourceRef
pub.layers.expression.expression/{talk.rkey}-expression
    │
    ├── pub.layers.segmentation.segmentation/{talk.rkey}-segmentation
    │       └── tokenization: kind "word", tokens with textSpan + temporalSpan
    │
    ├── pub.layers.annotation.annotationLayer/{talk.rkey}-sentences
    ├── pub.layers.annotation.annotationLayer/{talk.rkey}-paragraphs
    ├── pub.layers.annotation.annotationLayer/{talk.rkey}-entities
    └── pub.layers.annotation.annotationLayer/{talk.rkey}-topics
```

Example AT URI: `at://did:plc:xxxxxx/pub.layers.expression.expression/atproto-for-everyone-expression`

> **Future work:** A `-speakers` annotation layer (`subkind: "speaker-segment"`) for diarization spans.
> The NLP pipeline does not yet produce `speakerSegments` data, so this layer is deferred until the
> diarization pipeline is integrated.

### Expression record

| Field | Value |
|---|---|
| `id` | talk rkey |
| `$type` | `"pub.layers.expression.expression"` |
| `kind` | `"transcript"` |
| `text` | full transcript text |
| `language` | `"en"` |
| `sourceRef` | AT URI of `tv.ionosphere.transcript` record |
| `metadata` | `{ tool: "ionosphere-pipeline", timestamp: "<ISO 8601 datetime>" }` |
| `createdAt` | ISO 8601 timestamp |

### Segmentation record

| Field | Value |
|---|---|
| `expression` | AT URI of expression (pre-computed) |
| `tokenizations` | Single tokenization, `kind: "word"` |
| `createdAt` | ISO 8601 timestamp |

Each token: `tokenIndex` (0-based), `text` (word), `textSpan` (UTF-8 byte offsets), `temporalSpan` (start/ending in ms, derived from compact transcript timings).

### Annotation layers

All records include `$type: "pub.layers.annotation.annotationLayer"`. All reference the expression URI. All use `sourceMethod: "automatic"`. `createdAt` is optional in the lexicon but always included.

| rkey suffix | kind | subkind | annotations |
|---|---|---|---|
| `-sentences` | `"span"` | `"sentence-boundary"` | One annotation per sentence. `anchor: { textSpan: { byteStart, byteEnd } }`, `label`: first ~50 chars of sentence text. |
| `-paragraphs` | `"span"` | `"paragraph-boundary"` | One annotation per paragraph. `anchor: { textSpan: { byteStart, byteEnd } }`, `label`: `"paragraph"`. |
| `-entities` | `"span"` | `"ner"` | One annotation per entity mention. `anchor: { textSpan: { byteStart, byteEnd } }`, `label`: entity name. `features: { entries: [{ key: "nerType", value: "PERSON" }, { key: "speakerDid", value: "did:plc:..." }, { key: "conceptUri", value: "at://..." }] }` (only applicable keys included). |
| `-topics` | `"span"` | `"topic-segment"` | One annotation per topic break. `anchor: { textSpan: { byteStart, byteEnd } }` where `byteEnd = byteStart` (zero-width span). `label`: `"topic-break"`. |

`metadata` on all layers: `{ tool: "ionosphere-nlp-pipeline", timestamp: "<ISO 8601 datetime>" }`.

## Section 2: Panproto Lens Architecture

Three lenses. All authoritative — data flows through them.

### Lens 1: Compact Transcript → Expression + Segmentation

- **Source:** `tv.ionosphere.transcript` (text, startMs, timings)
- **Target:** `pub.layers.expression.expression` + `pub.layers.segmentation.segmentation`
- **Transform:** maps text → text, injects kind/language, replays timings array to produce token list with textSpan + temporalSpan
- **Fan-out:** Single source → two target records (protolens chain)
- **Morphism hints:** `text → text`, `startMs + timings → tokenizations[0].tokens`

### Lens 2: NLP Annotations → Annotation Layers

- **Source:** `tv.ionosphere.nlpAnnotations` (new lexicon, not published to PDS — exists as lens source schema)
- **Target:** 4× `pub.layers.annotation.annotationLayer`
- **Transform:** Byte ranges → `anchor.textSpan`, labels → `annotation.label`, entity metadata → `features`
- **Fan-out:** Single source → four target records

The `tv.ionosphere.nlpAnnotations` lexicon formalizes the NlpAnnotations TypeScript interface as a proper schema that panproto can parse and validate.

### Lens 3: Layers.pub → Ionosphere Document Facets (reverse)

- **Source:** expression + segmentation + annotation layers
- **Target:** RelationalText document with ionosphere facets (`{ text, facets }`)
- **Purpose:** Materialized view builder, used by appview indexer
- **Round-trip property:** Lens 1+2 followed by Lens 3 should reproduce the same document that `decodeToDocumentWithStructure` currently produces. This is the correctness test.

### Lens storage

Published as `org.relationaltext.lens` records (consistent with existing 4 lenses). Rkeys: `transcript-to-expression`, `nlp-to-annotation-layers`, `layers-to-document`.

## Section 3: Publish Pipeline

New Stage 6 in `publish.ts`, runs after transcript publishing.

For each talk with both transcript and NLP annotation files:

1. Load compact transcript (`transcripts/{rkey}.json`)
2. Load NLP annotations (`nlp/{rkey}.json`)
3. Run **Lens 1** via panproto WASM → expression + segmentation records
4. Run **Lens 2** via panproto WASM → 4 annotation layer records
5. Inject AT URIs (pre-computed from DID + rkey): `sourceRef` on expression, `expression` ref on segmentation and all annotation layers
6. Publish all 6 records via `PdsClient.putRecord()` (parallel within each talk, sequential across talks)

**Idempotency:** Deterministic rkeys mean re-publish overwrites, no duplicates.

**Rate limiting:** ~98 talks × 6 records = ~588 putRecord calls. Records within a single talk publish in parallel (6 concurrent). Talks are processed sequentially. The existing PdsClient writeDelay (100ms) and 429/backoff handling apply.

**Skip condition:** If a talk has transcript but no NLP annotations, skip layers.pub entirely for that talk (keep as a unit).

**WASM lifecycle:** Panproto runtime initializes once (lazy singleton), schemas load once at stage start, each talk runs data through compiled lenses.

## Section 4: Appview Indexer Updates

### New Jetstream subscriptions

Add to `IONOSPHERE_COLLECTIONS`:
- `pub.layers.expression.expression`
- `pub.layers.segmentation.segmentation`
- `pub.layers.annotation.annotationLayer`

**DID filter:** Only index records from ionosphere.tv DID (no third-party layers).

### New DB tables

```sql
layers_expressions:
  rkey TEXT, did TEXT, expression_uri TEXT, transcript_uri TEXT,
  text TEXT, language TEXT, created_at TEXT

layers_segmentations:
  rkey TEXT, did TEXT, expression_uri TEXT,
  tokens_json TEXT, created_at TEXT

layers_annotations:
  rkey TEXT, did TEXT, expression_uri TEXT,
  kind TEXT, subkind TEXT, annotations_json TEXT, created_at TEXT
```

Key indexes: `expression_uri` (find all layers for expression), `transcript_uri` (find expression for transcript).

### Document rebuild on ingest

When any layers.pub record arrives or updates:

1. Look up the expression URI → transcript URI
2. Check for complete set: expression + segmentation + at least one annotation layer
3. If complete, run **Lens 3** (layers.pub → ionosphere document facets) to produce materialized `{ text, facets }`
4. Update the talk record's `document` field in DB

**Deletion:** If an annotation layer is deleted, rebuild with remaining layers (graceful degradation — fewer annotations). If the expression record is deleted, cascade-delete its segmentation and annotation rows from the DB and clear the talk's materialized document. Annotation/segmentation JSON is stored as TEXT blobs — all queries are by expression URI, not individual annotations, so this is sufficient.

**Backfill:** Add three new collections to existing startup backfill loop; records go through same ingest → rebuild path.

## Section 5: Schema Versioning

### Panproto VCS initialization

- `schema init` in project
- Add layers.pub lexicons + ionosphere lexicons + NLP annotations lexicon + all lens definitions
- `schema commit` initial state
- `schema tag v0.5.0` — pin to current vendored layers.pub version

### What's tracked

- `lexicons/pub/layers/*.json`
- `formats/tv.ionosphere/ionosphere.lexicon.json`
- `formats/tv.ionosphere/nlpAnnotations.lexicon.json` (new)
- `formats/tv.ionosphere/lenses/*.lens.json` (existing 4 + new 3)

### Migration strategy

When layers.pub evolves: vendor updated lexicons, `schema diff`, update lenses if needed. The materialized view insulates the frontend — layers.pub can change without affecting ionosphere document format until we choose to update.

## Task Order

1. Define `tv.ionosphere.nlpAnnotations` lexicon (lens source schema)
2. Define Lens 1: compact transcript → expression + segmentation
3. Define Lens 2: NLP annotations → 4 annotation layers
4. Add publish Stage 6: run lenses, publish 6 records per talk
5. Define Lens 3: layers.pub → ionosphere document facets (reverse)
6. Add appview DB tables + indexer for layers.pub collections (depends on 5)
7. Wire indexer rebuild: on layers.pub ingest, run Lens 3, update talk document
8. Initialize panproto VCS, tag v0.5.0
9. Test round-trip: publish → index → rebuild → verify document matches current output
10. Deploy
