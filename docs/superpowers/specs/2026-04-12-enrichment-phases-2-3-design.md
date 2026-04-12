# Enrichment Phases 2-3: NER + Entity Linking, Topic Segmentation

**Date:** 2026-04-12
**Status:** Approved
**Depends on:** Phase 1 transcript formatting (complete)

## Goal

Add named entity recognition with AT Protocol record linking (Phase 2) and topic segmentation with visual dividers (Phase 3) to the existing NLP enrichment pipeline. Achieve feature parity with the old concept system while adding speaker attribution and topic navigation, before deploying.

## Constraints

- **Text is immutable.** Same as Phase 1 — annotations only, no word changes.
- **Build-time processing.** New passes extend the existing Python pipeline.
- **Leverage existing data.** Speaker records, diarization records, and concept records are already in the database. Use them for entity resolution.
- **layers.pub annotation model.** Each pass produces a separate annotation layer, consistent with Phase 1's approach.

## Pipeline Passes

### Pass 3: Named Entity Recognition + Entity Linking

**Input:** transcript text + speaker records (from SQLite) + diarization records (from SQLite) + concept records (from SQLite)

**Steps:**

1. **Build speaker lookup.** Query `speakers` table, build a map of `{name, aliases, handle, did}` for all speakers. Include normalized variants (lowercase, first-name-only for disambiguation with diarization context).

2. **Load diarization.** Query `stream_diarizations` table for the talk's stream. Map diarization time ranges to speaker identities. Each segment tells us who is speaking when — this provides context for resolving ambiguous names.

3. **Run spaCy NER.** The existing `en_core_web_sm` model (already loaded for sentence detection) provides NER via `doc.ents`. Extract entities with types: PERSON, ORG, PRODUCT, WORK_OF_ART, GPE, EVENT. Compute byte ranges using the same char→byte conversion as sentence detection.

4. **Resolve entities:**
   - **PERSON entities:** Match against speaker lookup by name similarity. Use diarization context for disambiguation — if a first name is mentioned while a known speaker with that first name is presenting or was just speaking, prefer that match. Resolved entities get a `speakerDid` linking to the Bluesky profile.
   - **ORG/PRODUCT entities:** Match against concept records by name and aliases. Resolved entities get a `conceptUri`.
   - **Unresolved entities:** Keep as labeled spans with NER type but no link target. Available for manual curation in Phase 4.

5. **Emit speaker attribution.** For each diarization segment, emit a speaker-segment annotation spanning the corresponding byte range in the transcript. Cross-reference diarization time ranges with word timestamps to find byte boundaries.

**Output:** NLP JSON with `entities` array and `speakerSegments` array.

### Pass 4: Topic Segmentation

**Input:** transcript text + sentence boundaries (from Pass 1)

**Steps:**

1. **Embed sentences.** Run each sentence through `all-MiniLM-L6-v2` (384-dim sentence embeddings). The model is ~80MB, downloaded on first run. Embedding 300 sentences takes ~2 seconds on CPU.

2. **Compute similarity.** For each pair of adjacent sentence windows (window size N, default 3 sentences), compute cosine similarity between the mean embedding of the left window and the right window.

3. **Detect boundaries.** Similarity drops below a threshold (tunable, default 0.3) indicate topic shifts. Apply a minimum segment length (default 5 sentences) to avoid over-segmentation.

4. **Snap to structure.** Topic breaks are snapped to the nearest paragraph boundary where possible (since paragraphs already represent pause-based thought transitions). If no paragraph boundary is within 2 sentences of the detected break, snap to the nearest sentence boundary.

**Output:** NLP JSON with `topicBreaks` array (byte positions of topic boundaries).

**Parameters stored in metadata:** `embeddingModel`, `windowSize`, `similarityThreshold`, `minSegmentSentences`.

## Facet Schema

**Existing facets now populated:**

| Facet type | Class | Use |
|---|---|---|
| `tv.ionosphere.facet#speaker-segment` | `block` | Wraps diarization segment — attributes text to speaker |
| `tv.ionosphere.facet#speaker-ref` | `inline` | Links person mention to speaker DID/profile |
| `tv.ionosphere.facet#concept-ref` | `inline` | Links ORG/PRODUCT mention to concept record |

**New facets to add to format lexicon:**

| Facet type | Class | Use |
|---|---|---|
| `tv.ionosphere.facet#topic-break` | `block` | Topic boundary — renderer inserts divider |
| `tv.ionosphere.facet#entity` | `inline` | Unresolved entity — has label + NER type, no linked record |

## Document Assembly

The `NlpAnnotations` interface in `transcript-encoding.ts` extends to:

```typescript
interface NlpAnnotations {
  sentences: Array<{ byteStart: number; byteEnd: number }>;
  paragraphs: Array<{ byteStart: number; byteEnd: number }>;
  entities: Array<{
    byteStart: number; byteEnd: number;
    label: string; nerType: string;
    speakerDid?: string; conceptUri?: string;
  }>;
  speakerSegments: Array<{
    byteStart: number; byteEnd: number;
    speakerDid: string; speakerName: string;
  }>;
  topicBreaks: Array<{ byteStart: number }>;
}
```

`decodeToDocumentWithStructure` maps these to facets:
- `entities` with `speakerDid` → `#speaker-ref` facets
- `entities` with `conceptUri` → `#concept-ref` facets
- `entities` with neither → `#entity` facets (unresolved)
- `speakerSegments` → `#speaker-segment` facets
- `topicBreaks` → `#topic-break` facets

## Renderer Changes

### Entity spans

`extractData` returns `entities: EntitySpan[]` with byte range, label, NER type, and optional link target. The renderer overlays these on word spans:

- **`#speaker-ref`** — renders as a link styled with a subtle blue underline. Clicking navigates to the speaker page or Bluesky profile.
- **`#concept-ref`** — renders as a link with amber underline (matching existing concept highlighting). Clicking navigates to the concept page.
- **`#entity`** (unresolved) — renders as subtly styled text (dotted underline, slightly different color) to indicate a recognized entity without a link.

These are inline facets that overlay on word spans. A word can have multiple facets (timestamp + entity). The existing `wordConcepts` pattern in `extractData` extends to handle all entity types.

### Speaker segments

Not visually rendered in this phase. The data is stored in facets for future use (speaker-colored text, margin labels, etc.). Getting the attribution data right is the priority.

### Topic dividers

A subtle `<hr>` between paragraphs where a topic break falls:

```html
<div class="mb-4"><!-- paragraph --></div>
<hr class="border-neutral-800 my-6" />
<div class="mb-4"><!-- paragraph --></div>
```

`extractData` returns `topicBreaks: Set<number>` — a set of paragraph indices where topic breaks occur. The renderer checks this set when iterating paragraphs and inserts dividers.

## Speaker Lookup Generation

The Python pipeline reads speaker data directly from the SQLite database (Python's `sqlite3` is in the standard library). The lookup table is built at pipeline startup:

```python
speakers = db.execute("SELECT name, handle, speaker_did FROM speakers").fetchall()
lookup = {}
for name, handle, did in speakers:
    lookup[name.lower()] = {"name": name, "handle": handle, "did": did}
    # Also index by first name for diarization-context matching
    first = name.split()[0].lower()
    if first not in lookup:
        lookup[first] = {"name": name, "handle": handle, "did": did}
```

This is ephemeral — rebuilt each pipeline run from the current speaker records. No separate file to maintain.

## Dependencies

**New Python dependency:** `sentence-transformers>=2.0` (adds torch, transformers, tokenizers — ~2GB install). Build-time only, no runtime impact.

**spaCy NER:** Zero-cost addition — `en_core_web_sm` already loaded for sentence detection. NER entities are read from `doc.ents` in the same pass.

**SQLite access:** Python `sqlite3` standard library. Pipeline reads speaker, diarization, and concept records from the same database the appview uses.

## Testing Strategy

**Python pipeline (pytest):**
- Unit tests for speaker lookup construction (name variants, first-name matching)
- Unit tests for entity resolution (exact match, first-name match with diarization context, unresolved fallback)
- Unit tests for topic segmentation (boundary detection, minimum segment length, snap-to-paragraph)
- Integration test: full pipeline on a known transcript, verify entity and topic output

**TypeScript (vitest):**
- `decodeToDocumentWithStructure` with entity/speaker/topic annotations
- `extractData` with entity facets and topic breaks
- Renderer: entity links, topic dividers between paragraphs

**Manual validation:**
- Spot-check 5-10 talks: verify entity links point to correct profiles/concepts
- Verify topic breaks land at natural transitions, not mid-thought
- Check that speaker attribution aligns with diarization (correct speaker for each segment)
