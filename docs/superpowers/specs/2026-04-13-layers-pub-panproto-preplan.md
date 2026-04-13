# layers.pub Record Publishing + Panproto Lenses — Pre-Plan

**Status:** Pre-plan for next session
**Depends on:** Phases 1-3 enrichment (complete), concept deduplication (complete)

## Context

The NLP enrichment pipeline produces sentence/paragraph/entity/topic annotations that are currently stored as ionosphere facets in pre-assembled RelationalText documents. The layers.pub lexicons are vendored (`lexicons/pub/layers/`) but no actual AT Protocol records are published.

This work makes the enrichment data first-class AT Protocol records — publishable, indexable, and interoperable with the broader layers.pub ecosystem.

## What Exists

### Vendored lexicons (in `lexicons/pub/layers/`)
- `defs.json` — shared types: span, temporalSpan, uuid, tokenRef, anchor, annotationMetadata, feature/featureMap
- `expression/expression.json` — record: id, kind, text, language, sourceRef, parentRef, anchor, metadata
- `segmentation/segmentation.json` — record: expression ref, tokenizations (with textSpan + temporalSpan per token)
- `annotation/annotationLayer.json` — record: expression ref, kind/subkind, sourceMethod, annotations array

### Existing panproto integration (`formats/tv.ionosphere/ts/panproto.ts`)
- WASM-based runtime (lazy singleton init)
- `loadSchema()` — parse lexicon JSON into BuiltSchema
- `buildMigration()` — explicit migration between schemas
- `createLens()` — auto-generated lens between schemas
- `autoGenerateWithHints()` — protolens chain with morphism hints
- `createPipeline()` — PipelineBuilder for combinator transforms
- `serializeChain()` / `serializeMigrationSpec()` — serialization for storage

### Existing lenses (`formats/tv.ionosphere/lenses/`)
- `openai-whisper-to-transcript.lens.json`
- `transcript-to-document.lens.json`
- `schedule-to-talk.lens.json`
- `vod-to-talk.lens.json`

## What Needs to Be Built

### 1. Publish layers.pub records to PDS

For each transcript, publish:

**Expression record** (`pub.layers.expression.expression`):
- `kind: "transcript"`
- `text`: the transcript text
- `language: "en"`
- `sourceRef`: AT URI of the `tv.ionosphere.transcript` record
- `createdAt`: timestamp

**Segmentation record** (`pub.layers.segmentation.segmentation`):
- `expression`: AT URI of the expression record above
- One tokenization with `kind: "whitespace"`
- Each token has `textSpan` (byteStart/byteEnd) and `temporalSpan` (start/ending in ms)
- Derived from the compact transcript's timing data

**Annotation layers** (`pub.layers.annotation.annotationLayer`):
- **Sentence layer**: `kind: "span"`, `subkind: "sentence-boundary"`, `sourceMethod: "automatic"`
- **Paragraph layer**: `kind: "span"`, `subkind: "paragraph-boundary"`, `sourceMethod: "automatic"`
- **Entity layer**: `kind: "span"`, `subkind: "ner"`, `sourceMethod: "automatic"`, with `knowledgeRefs` for resolved entities
- **Topic layer**: `kind: "span"`, `subkind: "topic-segment"`, `sourceMethod: "automatic"`
- Each layer references the expression record and includes `metadata` (tool, confidence, timestamp)

### 2. Panproto lenses

**Lens: compact transcript → layers.pub expression + segmentation**
- Source: `tv.ionosphere.transcript` (text, startMs, timings)
- Target: `pub.layers.expression.expression` + `pub.layers.segmentation.segmentation`
- This is the transform that `decodeToDocument` / `encode` already implement in code — the lens formalizes it

**Lens: NLP annotations → layers.pub annotation layers**
- Source: NLP pipeline JSON output (sentences, paragraphs, entities, topicBreaks)
- Target: `pub.layers.annotation.annotationLayer` records
- Mostly structural mapping — the NLP output already has byte ranges and labels

**Lens: layers.pub → ionosphere document facets**
- Source: layers.pub records (expression + segmentation + annotation layers)
- Target: RelationalText document with ionosphere facets (#timestamp, #sentence, #paragraph, etc.)
- This is the reverse of what `decodeToDocumentWithStructure` does — reading layers.pub records and emitting facets

### 3. Appview indexer updates

The appview needs to index layers.pub records from Jetstream:
- Add `pub.layers.expression.expression`, `pub.layers.segmentation.segmentation`, `pub.layers.annotation.annotationLayer` to `IONOSPHERE_COLLECTIONS`
- Create DB tables for these records
- On indexing, rebuild the pre-assembled document from the layers.pub records (using the lens)

### 4. Schema versioning

- Initialize panproto VCS for the layers.pub schemas
- Pin to layers.pub v0.5.0 (current vendored version)
- Define migration strategy for when layers.pub evolves

## Architecture Decision: Build-Time vs Runtime

Currently, document assembly happens at **build time** (publish.ts) and the assembled document is stored on the talk record. With layers.pub records, the assembly could move to **runtime** (appview reads layers.pub records and assembles on the fly).

**Recommendation:** Keep build-time assembly for the ionosphere document (fast serving), AND publish layers.pub records alongside (for interoperability). The layers.pub records are the canonical source; the ionosphere document is a materialized view.

## Suggested Task Order

1. Write the publish step for layers.pub expression + segmentation records
2. Write the publish step for annotation layer records
3. Define panproto lens: compact transcript → expression + segmentation
4. Define panproto lens: NLP annotations → annotation layers
5. Update appview indexer to handle layers.pub records
6. Initialize panproto VCS, tag v0.5.0
7. Test round-trip: publish → index → serve → verify in browser
8. Define panproto lens: layers.pub → ionosphere document facets (reverse lens)

## Questions for the Session

- Should we publish layers.pub records under the ionosphere.tv DID, or a separate account?
- How should the appview discover which annotation layers belong to a given transcript? (By expression URI reference? By convention?)
- Do we want to support third-party annotation layers from other DIDs? (e.g., someone else annotating our transcripts)
- Should the panproto lenses be published as `org.relationaltext.lens` records (like the existing ones)?
