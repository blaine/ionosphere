# Ionosphere: Semantically Enriched Conference Video Archive

## Overview

Ionosphere is an AT Protocol-native video archive that transforms conference talk recordings into a browsable, semantically enriched knowledge base. Conference talks become richly annotated documents with synchronized transcripts, concept cross-references, speaker profiles, and a navigable knowledge graph. MTV meets the British Library and Wikipedia.

The first corpus is ATmosphereConf 2026 (126 VOD records from Streamplace, ~100 schedule events).

**Domain:** ionosphere.tv
**NSID namespace:** `tv.ionosphere.*`

## Architecture

Follows the pannacotta pattern: diverse source lexicons -> lenses -> internal lexicons -> appview -> render. Uses RelationalText for the document model and `pub.layers.annotation` for semantic enrichment layers. panproto for schema versioning.

### Source Data

- **`place.stream.video`** records from `did:plc:rbvrr34edl5ddpuwcubjiost` (stream.place), served from PDS at `iameli.com`. 126 VOD records, 1080p HLS CMAF playback via `vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist?uri=<at-uri>`.
- **`community.lexicon.calendar.event`** records from `did:plc:3xewinw4wtimo2lqfy5fm5sw` (atmosphereconf.org). ~100 schedule events with title, description, room, type, category, speakers (handle + name), start/end times.

### Domain Lexicons

- **`tv.ionosphere.talk`** — Title, speaker refs, track/room, start/end times, video ref (AT URI to `place.stream.video`), transcript as RelationalText document with word-level temporal facets, source schedule ref.
- **`tv.ionosphere.speaker`** — Name, AT Protocol handle/DID, bio, affiliations, talk refs.
- **`tv.ionosphere.concept`** — Knowledge entity: name, aliases, description, Wikidata ref. Created by LLM enrichment, curated by humans.
- **`tv.ionosphere.event`** — Conference-level metadata: name, dates, location, tracks/rooms, schedule ref. Supports multiple conferences.

### Annotation Facet Types

Defined in the format-lexicon (`formats/tv.ionosphere/ionosphere.lexicon.json`), not as AT Protocol record lexicons. These are RelationalText feature types used within documents.

- **`speaker-segment`** — featureClass: block. Marks a speaker turn within the transcript.
  - `speakerUri`: AT URI to `tv.ionosphere.speaker` record
  - `startTime`: number (nanoseconds from video start)
  - `endTime`: number (nanoseconds from video start)

- **`concept-ref`** — featureClass: inline. Links a text span to a concept.
  - `conceptUri`: AT URI to `tv.ionosphere.concept` record

- **`speaker-ref`** — featureClass: inline. Links a mention of a person to a speaker record.
  - `speakerUri`: AT URI to `tv.ionosphere.speaker` record

- **`talk-xref`** — featureClass: inline. Cross-reference to another talk.
  - `talkUri`: AT URI to `tv.ionosphere.talk` record

- **`link`** — featureClass: inline. External URL reference.
  - `url`: string (URI)
  - `title`: string (optional)

- **`timestamp`** — featureClass: meta. Word-level timing for video sync.
  - `startTime`: number (nanoseconds from video start)
  - `endTime`: number (nanoseconds from video start)

## Data Layer: Progressive Enhancement

Each stage enriches but does not gate. A talk with no transcript still renders with schedule metadata and video. A transcript without LLM enrichment still plays with timestamps. Concepts get richer as more talks reference them. Records arrive independently and the view gets progressively richer.

### Stage 1: Ingest & Correlate

Pull `place.stream.video` and `community.lexicon.calendar.event` records. Correlate by fuzzy title matching + time overlap. Filter noise (lunch breaks, test streams, duplicates). Produce one `tv.ionosphere.talk` per real talk, linking to both source records. Manual overrides for tricky matches.

### Stage 2: Transcribe

Download audio from each VOD via HLS endpoint. Run through transcription service with word-level timestamps. Output: plain text + word timing array. Transcription provider evaluated at implementation time (Whisper, Deepgram, AssemblyAI — compare cost/quality on samples first).

### Stage 3: Document Assembly

Convert transcript + timestamps into a RelationalText document. Facets include:
- `timestamp` facets on every word/word-group (temporal anchoring)
- `speaker-segment` facets marking speaker turns

Speaker diarization (identifying who speaks when within a single audio stream) is deferred for v1. Single-speaker talks get one `speaker-segment` for the entire transcript. Multi-speaker sessions (panels, Q&A) default to one segment per scheduled speaker, with manual refinement as a curation task. Diarization can be added as a later enrichment stage without changing the document model.

### Stage 4: LLM Enrichment

Pass transcript through an LLM to identify and annotate:
- Concept mentions -> create/link `tv.ionosphere.concept` records
- Speaker/person mentions -> link to `tv.ionosphere.speaker` records
- Cross-references to other talks -> `talk-xref` facets
- External links/references mentioned verbally -> `link` facets

Annotations stored as `pub.layers.annotation` layers with source metadata.

### Stage 5: Appview Indexing

SQLite materialization from annotation layers:
- `talks` — title, speaker, times, document JSON, video ref
- `talk_concepts` — join table
- `talk_speakers` — join table
- `talk_crossrefs` — join table
- `concepts` — vocabulary table
- `speakers` — vocabulary table

### Stage 6: Render

Next.js SSG. Video streams from Streamplace at runtime. Transcript sync is client-side JS. Data baked at build time from appview SQLite.

### Appview Role

The appview serves two purposes: (1) a build-time data layer that the Next.js SSG reads from to generate static pages, and (2) a development server for iterating on data and testing. The shipped site is fully static — the appview does not need to run in production. It can be promoted to a live service later if needed (e.g., for search, real-time updates, or API consumers).

## Frontend & Playback

### Global Timestamp State

The video player broadcasts current playback time. Every annotation has temporal bounds from word-level timestamps. Components subscribe to global time and activate/deactivate themselves autonomously. No central controller — each annotation is a reactive entity, same pattern as pannacotta's ingredient quantity scaling.

```
VideoPlayer -> currentTime (global state)
                |
    TranscriptView (Pretext-rendered)
        +-- word spans: scroll-to + highlight on match
        +-- concept-ref chips: glow/activate on match
        +-- speaker-segment blocks: current speaker indicator
        +-- talk-xref chips: activate when mentioned
```

Click a word in the transcript -> seek video. Click a concept -> navigate to concept page. Bidirectional.

### Page Types

- **Talk page** — video + synced transcript + sidebar (metadata, speakers, concepts)
- **Speaker page** — bio, all talks, concept co-occurrences
- **Concept page** — description, Wikidata link, all talks mentioning it, timeline of mentions
- **Browse/index** — by day, track, category, concept, speaker. The research librarian view.
- **Home** — conference overview, featured/recent talks

### SSG

All pages statically generated. Video streams from Streamplace at runtime. Transcript sync is client-side JS. Data baked from appview SQLite at build time.

## Project Structure

```
ionosphere/
+-- package.json                  # pnpm workspace root
+-- pnpm-workspace.yaml
+-- tsconfig.json
+-- lexicons/
|   +-- tv/ionosphere/
|       +-- talk.json
|       +-- speaker.json
|       +-- concept.json
|       +-- event.json
+-- formats/
|   +-- tv.ionosphere/
|       +-- ionosphere.lexicon.json   # facet type definitions
|       +-- lenses/
|       |   +-- schedule-to-talk.lens.json       # calendar.event -> tv.ionosphere.talk
|       |   +-- transcript-to-document.lens.json # raw transcript -> RelationalText doc
|       +-- ts/                       # annotation, enrichment utilities
+-- apps/
|   +-- ionosphere/                   # Next.js SSG frontend
|   |   +-- src/
|   |       +-- app/
|   |       |   +-- talks/
|   |       |   +-- speakers/
|   |       |   +-- concepts/
|   |       |   +-- components/
|   |       |       +-- VideoPlayer.tsx
|   |       |       +-- TranscriptView.tsx
|   |       |       +-- AnnotationChips.tsx
|   |       |       +-- TimestampProvider.tsx
|   |       +-- lib/
|   +-- ionosphere-appview/           # Hono server, SQLite, indexer
|       +-- src/
|           +-- appview.ts
|           +-- db.ts
|           +-- ingest.ts
|           +-- correlate.ts
|           +-- transcribe.ts
|           +-- enrich.ts
|           +-- indexer.ts
|           +-- routes.ts
+-- scripts/
|   +-- ingest.ts                     # CLI: pull source data
|   +-- transcribe.ts                 # CLI: run transcription
|   +-- enrich.ts                     # CLI: run LLM enrichment
+-- data/                             # cached source data, transcripts
```

### Dependencies

- `relational-text` — document model, facets, annotation layers
- `@atproto/api` — AT Protocol client
- `hono` — HTTP server for appview
- `better-sqlite3` — appview storage
- `next` — SSG frontend
- Pretext — transcript layout (integration TBD based on available API)
- panproto — schema versioning

## Transcription

Provider to be evaluated at implementation time. Candidates:
- **Whisper (local)** — free, good quality, word-level timestamps via whisper.cpp or faster-whisper. Requires GPU for reasonable speed.
- **Deepgram** — fast, good word-level timestamps, ~$0.0043/min (Nova-2). ~$0.50 for the full corpus.
- **AssemblyAI** — good diarization, word-level timestamps, ~$0.01/min. ~$1.20 for the full corpus.

Decision deferred — will compare on a few sample talks first.

## Enrichment

LLM-assisted annotation generates first-pass semantic layers. Humans refine via a curation interface (design TBD, not in initial scope). Each annotation layer carries source metadata (algorithm, model, version, timestamp) so provenance is transparent.
