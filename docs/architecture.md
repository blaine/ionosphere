# Ionosphere Architecture

**What it is:** A semantically enriched conference video archive for ATmosphereConf 2026, built as an AT Protocol native app.

## Data Flow

```
Source PDSes                    Ionosphere PDS                 Appview                    Frontend
─────────────                   ──────────────                 ───────                    ────────
Streamplace PDS ──┐
  (VOD records)   │   Lens       Ionosphere PDS               SQLite                     Next.js
                  ├──────────→  (ionosphere.tv)  ──Jetstream──→ Indexer ──Hono XRPC──→   ionosphere.tv
Schedule PDS ─────┤  Transforms    talks                       profiles
  (calendar)      │               speakers                     concordance                Concordance
                  │               concepts                     comments      ←──OAuth──→  Comments
OpenAI Whisper ───┘               annotations                                             ReactionBar
  (transcription)                 transcripts
                                  comments (user-written)
```

## The Panproto Lens Layer

This is the key architectural insight: **upstream source schemas will change**. The lens layer insulates the internal data model from external schema drift.

### Lenses defined (in `formats/tv.ionosphere/lenses/`)

1. **`schedule-to-talk.lens.json`**: `community.lexicon.calendar.event` → `tv.ionosphere.talk`
   - Renames: `name` → `title`
   - Hoists: `additionalData.room` → `room`, `additionalData.category` → `category`, `additionalData.type` → `talkType`
   - Now uses panproto's native `PipelineBuilder` combinators (v0.25.1)

2. **`vod-to-talk.lens.json`**: `place.stream.video` → `tv.ionosphere.talk`
   - Maps Streamplace's VOD records to video URIs + offsets on talks

3. **`openai-whisper-to-transcript.lens.json`**: `openai.whisper.verbose_json` → `tv.ionosphere.transcript`
   - Maps Whisper's word-level timestamps to ionosphere's compact transcript format

4. **`transcript-to-document.lens.json`**: `transcript.raw` → `tv.ionosphere.facet`
   - Transforms raw transcripts into the Document/Facet model used for rendering

### How ingest works (`src/ingest.ts`)

```
Schedule PDS → listRecords → applyLens(schedule-to-talk) → putRecord(tv.ionosphere.talk)
VOD PDS → listRecords → applyLens(vod-to-talk) → merge into talks (video_uri, offset)
```

The `buildSchedulePipeline()` function now uses panproto's native pipeline:

```typescript
pipeline([
  renameField('name', 'title'),
  hoistField('additionalData.room', 'room'),
  hoistField('additionalData.category', 'category'),
  hoistField('additionalData.type', 'talkType'),
])
```

With `autoGenerateWithHints()` available for cross-namespace lens generation with seeded vertex correspondences — so when Streamplace changes their lexicon, we update the lens, not the pipeline.

## Enrichment Pipeline

```
Talk + Transcript → OpenAI (gpt-5.4-mini) → Concepts + Annotations
                                           → Concept Clusters (LLM clustering)
                                           → Concept Merges (deduplication)
                                           → Cross-references between talks
```

This runs as a batch process (`enrich-all.ts`), writing concept and annotation records back to the PDS. The appview indexes them via Jetstream.

## Full-Day Stream Processing

```
Streamplace full-day VODs → Sprites (parallel)
  → ffmpeg HLS extract (20-min chunks)
  → Whisper transcription (per chunk)
  → Stitch into continuous transcript
  → LLM boundary detection (gpt-5.4-mini)
    - Find silence gaps in transcript
    - Classify gaps as talk transitions
    - Map transitions to schedule in order
    - Anchor from start, predict next via expected duration
  → Talk offsets (seconds into full-day stream)
```

### Boundary Detection Algorithm (v4)

1. Find the first talk transition (stream setup → opening remarks)
2. For each subsequent talk: expected transition = previous start + scheduled duration
3. Search ±7 minutes around the expected timestamp for silence gaps
4. Ask the LLM to identify which gap is the actual transition between the two talks
5. Use the detected timestamp as the anchor for the next prediction
6. Falls back to schedule duration if no transition found (extrapolated)

Results: 104 talks detected across 7 full-day streams, 82 high confidence.

## The AT Protocol Model

Everything is records on a PDS:

- **Reads**: public, federated via Jetstream
- **Writes**: OAuth-scoped (`repo:tv.ionosphere.comment`)
- **Comments**: written to the user's OWN PDS, discovered via public Jetstream
- **Identity**: `ionosphere.tv` as an AT Protocol handle (DID verified via `.well-known/atproto-did`)

The appview is a materializer — it indexes from Jetstream, never stores authoritative data. The PDS is the source of truth.

### Lexicons

- `tv.ionosphere.event` — conference metadata
- `tv.ionosphere.talk` — individual talk records
- `tv.ionosphere.speaker` — speaker profiles
- `tv.ionosphere.concept` — semantic concepts extracted from talks
- `tv.ionosphere.annotation` — concept mentions anchored to transcript byte ranges
- `tv.ionosphere.transcript` — compact word-level transcripts
- `tv.ionosphere.comment` — user comments, emoji reactions, threaded replies
- `org.relationaltext.lens` — lens transformation specs

### XRPC Endpoints (appview)

- `tv.ionosphere.getTalks` — list all talks with speaker names + reaction summary
- `tv.ionosphere.getTalk` — single talk with transcript document, speakers, concepts
- `tv.ionosphere.getComments` — comments with author profiles (joined from cache)
- `tv.ionosphere.getSpeakers` / `getSpeaker` — speaker listings and detail
- `tv.ionosphere.getConcepts` / `getConcept` — concept listings and detail
- `tv.ionosphere.getConceptClusters` — thematic concept clusters
- `tv.ionosphere.getConcordance` — full word index (10k+ entries)
- `tv.ionosphere.getTimecodes` — on-demand per-term timecodes
- `tv.ionosphere.invalidate` — cache invalidation + frontend ISR trigger

## Frontend Architecture

- **Next.js** on Fly.io, standalone mode
- **ISR** with 1-hour revalidate + on-demand via `/api/revalidate`
- **Concordance**: book-index column layout — greedy-fill columns to viewport height, scroll wheel pages horizontally through the alphabet, mobile falls back to vertical scroll with progressive loading
- **Comments**: optimistic rendering, inline text-selection reactions, ReactionBar for whole-talk reactions
- **Video**: HLS.js with AAC track selection, audio settled before auto-play
- **Profiles**: appview-side DID→handle/avatar cache (24h TTL, resolved via public API)

## Deployment

- **Frontend**: `ionosphere-web` on Fly.io (sjc, 512MB, auto-suspend)
- **Appview**: `ionosphere-appview` on Fly.io (sjc, 1GB, always-on for Jetstream)
- **PDS**: Bluesky-hosted at `jellybaby.us-east.host.bsky.network`
- **Processing**: Fly Sprites for parallel transcription workloads
- **DNS**: `ionosphere.tv` (frontend), `api.ionosphere.tv` (appview)
- **Repos**: GitHub (`blaine/ionosphere`), Tangled (`blaine.bsky.social/ionosphere`)
