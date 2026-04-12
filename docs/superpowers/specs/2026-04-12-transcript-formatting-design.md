# Transcript Formatting: NLP Enrichment Pipeline

**Date:** 2026-04-12
**Status:** Approved

## Problem

Transcripts are currently rendered as an infinitely long, unbroken run of text. Word-level timing and concept facets exist, but there is no structural formatting — no sentences, no paragraphs, no visual hierarchy. The goal is for transcripts to read as though they were essays.

## Constraints

- **Text is immutable.** The pipeline adds structural annotations only — no words are modified, added, or removed. Transcript editing is a separate future concern.
- **Reliability over ambition.** Each enrichment pass must be dependable enough to run unsupervised across all transcripts. Noisy output is worse than no output.
- **Build-time processing.** NLP runs once in the batch pipeline; results are published as AT Protocol records. Zero runtime cost.
- **Python NLP stack.** spaCy for sentence detection and NER; sentence-transformers for topic segmentation.

## Schema Design: layers.pub Integration

The enrichment pipeline uses [layers.pub](https://layers.pub) (`pub.layers.*`) lexicons — composable AT Protocol schemas for linguistic annotation. This gives us a standard, interoperable representation with built-in support for multiple annotation passes, provenance tracking, and manual overrides.

**Vendoring strategy:** layers.pub is at v0.5.0 draft. We vendor the specific lexicon definitions we use into `lexicons/pub/layers/` in this repo. Panproto lenses provide forward-compatibility — when layers.pub evolves, we define migrations rather than rewriting our pipeline. This follows the project's principle of prioritizing the lens layer for forward-compat.

### Record Architecture

#### 1. Source transcript (existing)

`tv.ionosphere.transcript` — compact storage format with `text`, `startMs`, and `timings` array. Stays as-is. Source of truth for raw transcription output.

#### 2. Expression record

`pub.layers.expression.expression` (kind: `"transcript"`) — the transcript text published as a layers.pub expression. Links back to the ionosphere transcript via `sourceRef`. This is the anchoring point for all annotations.

#### 3. Segmentation record

`pub.layers.segmentation.segmentation` — word-level tokenization derived from the transcript's compact timing data. Each token carries:
- `textSpan`: UTF-8 byte offsets (`byteStart`, `byteEnd`)
- `temporalSpan`: timing in milliseconds (`start`, `ending`)

This replaces the per-word timestamp facets with a standard representation.

#### 4. Annotation layers

`pub.layers.annotation.annotationLayer` — one record per enrichment pass:

| Pass | `kind` | `subkind` | `sourceMethod` |
|------|--------|-----------|----------------|
| Sentence detection | `span` | `sentence-boundary` | `automatic` |
| Paragraph segmentation | `span` | `paragraph-boundary` | `automatic` |
| Topic segmentation (future) | `span` | `topic-segment` | `automatic` |
| Named entity recognition (future) | `span` | `ner` | `automatic` |
| Concept linking (future) | `span` | `concept` | `automatic` |
| Speaker attribution (future) | `span` | `speaker` | `automatic` |
| Manual corrections (future) | varies | varies | `manual-native` |

Each layer includes `metadata` (agent, tool, confidence, timestamp) for provenance. Pipeline parameters (e.g., paragraph pause threshold) are stored in `metadata.features` so provenance is complete and results are reproducible.

#### 5. Manual override layer (future)

A separate annotation layer with `sourceMethod: "manual-native"` and higher `rank`. The merge step prefers higher-ranked layers. Example: correcting "Blue Sky" to link to the Bluesky concept record is an annotation in this layer that supersedes the auto-detected concept. Published as first-class AT Protocol records — auditable, attributable, and preservable across pipeline re-runs.

### Relationship to existing `tv.ionosphere.annotation`

The existing `tv.ionosphere.annotation` record type (concept mentions anchored to byte ranges) continues to work as-is for Phase 1. The NLP pipeline produces layers.pub annotation layers for structural annotations (sentences, paragraphs) — these are a different concern and do not conflict.

In Phase 2, when we add NLP-based concept/entity detection, the layers.pub annotation system becomes the canonical source for all enrichment annotations. At that point, existing `tv.ionosphere.annotation` records are migrated to layers.pub annotation layers via a panproto migration. The appview indexer reads both formats during the transition period.

### Panproto Integration

- **Lenses:** Transform between compact transcript format (`tv.ionosphere.transcript`) and layers.pub expression + segmentation format. Lens definitions live in `formats/tv.ionosphere/lenses/`.
- **Schema validation:** Validate all layers.pub records before publishing to PDS. Runs in the TypeScript publish step (after the Python NLP pipeline outputs JSON).
- **Migration support:** As layers.pub evolves from v0.5.0, panproto migrations keep ionosphere records compatible. Vendored lexicons in `lexicons/pub/layers/` are the pinned source of truth.
- **Pipeline boundary:** The Python NLP pipeline outputs annotation layer JSON files. The TypeScript publish step validates them against panproto-parsed lexicons and publishes to PDS. This reuses the existing panproto TypeScript integration.

## Pipeline Architecture

```
transcript record (text + timings)
        |
        v
+-------------------+
| Pass 1: Sentences |  <-- spaCy sentence boundary detection
+---------+---------+
          |
          v
+--------------------+
| Pass 2: Paragraphs |  <-- pause data + sentence boundaries
+---------+----------+
          |
          v
+--------------------+
| Pass N: (future)   |  <-- topics, entities, speaker linking
+---------+----------+
          |
          v
+--------------------+
| Override layer     |  <-- manual corrections (higher rank)
+---------+----------+
          |
          v
+--------------------+
| Merge & publish    |  <-- assemble RelationalText document
+--------------------+
```

Properties:
- **Each pass is a standalone Python module** with a consistent interface: takes transcript text + timings + prior layer output, returns a new annotation layer.
- **Passes are additive** — they never modify text, only emit new annotations.
- **Override layer applies last** — manual corrections supersede auto-generated annotations at matching byte ranges via `rank`.
- **Idempotent** — re-running the pipeline produces the same output; manual overrides are preserved because they are separate records.

### Pass 1: Sentence Boundary Detection

**Tool:** spaCy with `en_core_web_sm`. The small model is nearly as accurate as the transformer model for sentence boundary detection (its most battle-tested feature), and runs without GPU on a standard dev machine. If accuracy proves insufficient on speech transcripts, upgrade to `en_core_web_trf` in a later pass.

spaCy's sentence segmenter uses dependency parsing, which is significantly more robust than punctuation-splitting for speech transcripts where Whisper's punctuation can be unreliable.

**Output:** An annotation layer with one annotation per sentence, anchored by byte span.

**Reliability:** Very high (95%+ accuracy on messy speech text).

### Pass 2: Paragraph Segmentation

**Tool:** Custom algorithm combining two signals.

**Signal 1 — Pause duration:** The transcript's timing data encodes silence gaps as negative values. Pauses above a tunable threshold are paragraph boundary candidates. Default threshold: **2.0 seconds** (a conservative starting point — most speech pauses are under 1s; pauses over 2s reliably indicate topic transitions).

**Signal 2 — Sentence alignment:** Paragraph breaks only occur at sentence boundaries (from Pass 1). A long pause mid-sentence is a speaker thinking, not a paragraph break.

**Algorithm:**
```
for each silence gap > pause_threshold_ms (default: 2000):
    find the nearest sentence boundary (from Pass 1)
    if the sentence boundary is within proximity_words (default: 5) of the pause:
        emit paragraph break at that sentence boundary
```

The proximity constraint of 5 words allows for the common case where a speaker finishes a thought (pause), says a brief connective phrase ("so", "and then"), and starts the next topic — the paragraph break lands at the sentence boundary closest to the actual pause.

Both `pause_threshold_ms` and `proximity_words` are stored in the annotation layer's `metadata.features` for reproducibility.

**Reliability:** High. Pause duration is a genuine speech signal, and constraining to sentence boundaries eliminates false positives.

## Rendering

### Format Lexicon Updates

Two new facet types added to `tv.ionosphere.facet`:

| Facet type | `featureClass` | Description |
|---|---|---|
| `tv.ionosphere.facet#sentence` | `inline` | Wraps all words in a sentence as a contiguous inline span |
| `tv.ionosphere.facet#paragraph` | `block` | Groups sentences into a block-level paragraph container |

Note: the annotation _storage_ format is layers.pub annotation layers (on the PDS). The _rendering_ format is ionosphere facets in the RelationalText document. The document assembly step bridges these — it reads layers.pub annotations and emits ionosphere facets. This separation means the renderer does not need to know about layers.pub.

### DOM Structure

The renderer groups words into sentence spans and sentences into paragraph blocks:

```html
<div>                          <!-- paragraph (block) -->
  <span>                       <!-- sentence (inline) -->
    <span>word</span> <span>word</span> <span>word</span>
  </span>
  <span>                       <!-- sentence (inline) -->
    <span>word</span> <span>word</span>
  </span>
</div>
<div>                          <!-- paragraph (block) -->
  <span>                       <!-- sentence (inline) -->
    <span>word</span> <span>word</span>
  </span>
</div>
```

This mirrors the layers.pub expression hierarchy (transcript > paragraph > sentence) and maps directly to the format lexicon's `featureClass` system (`block` for paragraphs, `inline` for sentences).

Sentence spans provide styling hooks for hover, selection, and transitions at sentence granularity. Paragraph blocks provide natural vertical whitespace.

### Data Model Changes: `extractData` → Hierarchical Structure

The current `extractData` function in `src/lib/transcript.ts` returns a flat `{ words: WordSpan[], concepts, wordConcepts }`. This must change to return a hierarchical structure:

```typescript
interface ParagraphSpan {
  byteStart: number;
  byteEnd: number;
  sentences: SentenceSpan[];
}

interface SentenceSpan {
  byteStart: number;
  byteEnd: number;
  words: WordSpan[];  // existing WordSpan type, unchanged
}

interface TranscriptStructure {
  paragraphs: ParagraphSpan[];
  concepts: ConceptSpan[];
  // wordConcepts lookup remains flat (indexed by global word index)
  wordConcepts: ConceptSpan[][];
}
```

`extractData` builds this hierarchy by:
1. Extracting all word spans from `#timestamp` facets (existing logic, unchanged).
2. Reading `#paragraph` facets to get paragraph byte ranges. Sorting by `byteStart`.
3. Reading `#sentence` facets to get sentence byte ranges. Sorting by `byteStart`.
4. Assigning each word to its containing sentence (by byte range overlap).
5. Assigning each sentence to its containing paragraph (by byte range overlap).
6. Words not covered by any sentence facet form singleton sentences. Sentences not covered by any paragraph facet form singleton paragraphs. This graceful degradation means the renderer works identically on transcripts that have not yet been enriched.

The brightness gradient system (`boundaryStartTime`/`boundaryEndTime`) continues to use the global word ordering — paragraph visual gaps do not affect the temporal continuity of the gradient. The existing `WordSpanComponent` is reused unchanged inside the sentence/paragraph wrappers.

### Document Assembly

Document assembly is a **build-time step** that runs after the NLP pipeline and before publishing. It:
1. Reads the compact transcript record (`tv.ionosphere.transcript`).
2. Reads all layers.pub annotation layer records for this transcript.
3. Converts layers.pub sentence/paragraph annotations into `#sentence` and `#paragraph` ionosphere facets.
4. Merges with existing `#timestamp` and `#concept-ref` facets from `decodeToDocument`.
5. Writes the assembled RelationalText document onto the `tv.ionosphere.talk` record's `document` field.

This replaces the current runtime assembly in the appview serve path with a pre-computed document. The appview serves the pre-assembled document directly — zero runtime cost.

Annotation layers of different `subkind` values naturally have overlapping byte ranges (a paragraph span contains sentence spans, which contain word spans). This is expected and correct — they represent different levels of the hierarchy, not conflicting annotations.

### Scroll/Time Mapping

Both `TranscriptView` and `WindowedTranscriptView` must account for paragraph whitespace in their scroll-to-time and time-to-scroll mappings.

**TranscriptView:** The line-map computation already handles variable-height content. Paragraph `<div>` elements with margin/padding become part of the natural layout — no special handling needed beyond the existing line grouping logic.

**WindowedTranscriptView:** The `computeMonospaceLayout` function currently returns `LineEntry[]` with uniform `LINE_HEIGHT`. Changes:
- Accept an additional `paragraphBreaks: Set<number>` parameter (set of word indices where a paragraph starts).
- When a word is a paragraph start, insert a gap of `PARAGRAPH_GAP` pixels (default: `LINE_HEIGHT`, i.e., one blank line) before its line entry.
- `LineEntry` gains `isParagraphStart: boolean` for rendering the gap spacer.
- Gap entries have no time range — `timeToScrollY` and `scrollYToTime` skip gaps by treating them as extensions of the preceding line's time range (scrolling through a gap seeks to the end of the previous paragraph).

## Testing Strategy

**Python pipeline (pytest):**
- Golden-file tests: run the sentence/paragraph pipeline on 2-3 known transcripts, compare output annotation layers to curated expected output. These transcripts should cover: a clean well-punctuated talk, a messy conversational panel, and a lightning talk with rapid transitions.
- Unit tests for the paragraph algorithm: verify that paragraph breaks only land at sentence boundaries, that pauses below threshold produce no breaks, and that the proximity constraint works correctly.

**TypeScript rendering (vitest):**
- Unit tests for the updated `extractData`: verify hierarchical output from facets, and verify graceful degradation when sentence/paragraph facets are absent (flat word array wrapped in singleton sentence/paragraph).
- Snapshot tests for `computeMonospaceLayout` with paragraph gaps.

**Manual validation:**
- After running the pipeline on all transcripts, spot-check 5-10 talks across different rooms/talk types. Verify paragraph breaks land at natural topic transitions, not mid-thought. Measure average sentences-per-paragraph (expect 3-8 for well-structured talks).

## Phase Roadmap

### Phase 1 — Structural formatting (this work)

- Python NLP pipeline: sentence detection (spaCy) + paragraph segmentation (pause + sentence alignment)
- layers.pub expression + segmentation records for each transcript
- Sentence and paragraph annotation layers
- Panproto lenses: compact transcript <-> layers.pub expression + segmentation
- Document assembly reads annotation layers, emits structural facets
- Renderer: sentences as inline spans, paragraphs as block elements
- **Goal:** Transcripts read as paragraphed prose

### Phase 2 — Entity recognition + record linking

- spaCy NER pass in the pipeline
- AT Protocol record resolver: people -> Bluesky profiles (DID resolution via handle/display name lookup), projects -> `tv.ionosphere.concept` records
- Entity annotation layer with `knowledgeRefs` to resolved records
- Renderer: entity spans as links/tooltips to profiles and concept pages
- **Goal:** People and projects mentioned in talks are clickable, linked to real AT Protocol identities

### Phase 3 — Topic segmentation

- Sentence-transformer embedding pass (e.g., `all-MiniLM-L6-v2`)
- Sliding-window cosine similarity topic boundary detection
- Topic segment annotation layer
- Renderer: section dividers or topic labels at major transitions
- UI: topic-based navigation within a talk (jump to "Q&A", "Demo", etc.)
- **Goal:** Long talks become navigable by topic

### Phase 4 — Manual curation layer

- UI for creating manual override annotations (correct a concept link, fix an entity, adjust a paragraph break)
- Published as AT Protocol records with `sourceMethod: "manual-native"`, higher `rank`
- Pipeline respects overrides on re-run
- Multi-user: anyone with write access can contribute corrections
- **Goal:** Community-curated enrichment that improves over time

### Phase 5 — Concept enrichment + cross-talk linking

- Supersede auto-detected concepts with curated concept records
- Cross-reference talks that mention the same entities/concepts
- `tv.ionosphere.facet#talk-xref` links between related talks
- Knowledge graph across the entire conference
- **Goal:** The archive becomes a connected knowledge base, not just isolated transcripts
