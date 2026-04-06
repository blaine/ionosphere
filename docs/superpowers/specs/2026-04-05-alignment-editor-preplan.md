# Alignment Editor Pre-Plan

## Context

We have a working track timeline view (`/tracks/[stream]`) showing full-day conference streams with talk segments, speaker diarization, and synced transcripts. The current pipeline (v6 + LLM refinement) achieves 100% accuracy / 11s MAE on ground truth, but many streams have no ground truth yet and the remaining errors require manual correction.

The next step is building NLE-style alignment editing tools so that talk boundaries can be visually verified and adjusted directly in the browser, like segment editing in Final Cut Pro or DaVinci Resolve.

## What We Have

### Data

- **7 full-day streams** (Great Hall Sat/Sun, Room 2301 Sat/Sun, Perf Theatre Sat/Sun, ATScience Friday)
- **~358K words** transcribed with Whisper segment confidence (`avg_logprob`, `no_speech_prob`)
- **Speaker diarization** for all streams (pyannote, 21-68 speakers per stream, ~1600-3800 segments each)
- **Boundary results** per stream (`transcript-enriched-boundaries-v6-refined.json`) with detected talk starts, confidence, refinement method (LLM/diarization-fallback/manual)
- **Ground truth** for Great Hall Day 1 only (13 verified talks, 11s MAE)
- **Talk records** in the DB with `video_segments` containing fullday stream offsets

### Current UI

- `/tracks/[stream]` — video player (1/3 vh), zoomable timeline with talk segments + speaker diarization band, tabs for Talks list and Transcript (reuses existing infinite-scroll TranscriptView)
- Zoom: scroll/pinch to zoom, shift+scroll to pan, +/- buttons, Reset
- Colors: golden angle hue spacing, stable across zoom (keyed by rkey/speaker ID)
- Timeline click seeks video
- Talk list highlights active talk, click seeks

### Known Issues in Current UI

- Video displays as narrow band (aspect ratio not constrained properly on some viewports)
- Some layout edge cases with scroll containers
- Zoom gesture can conflict with page scroll on some browsers/trackpads
- No way to edit anything — read-only

## What We Want to Build

### Core: Drag-to-Edit Talk Boundaries

The primary interaction: grab a talk boundary edge on the timeline and drag it to adjust where the talk starts or ends. This is the NLE razor/trim metaphor.

**Key design questions:**
- Should boundaries be discrete (snap to silence gaps / speaker changes) or continuous (any position)?
- How do we handle the gap between talks (MC intro, applause, setup)?
- Can two talks overlap? Or must they be contiguous?
- What happens to the "unassigned" time between talks (MC segments, breaks)?

**Likely approach:** Talk segments on the timeline become editable regions. Each boundary is a draggable handle. Dragging snaps to nearby useful positions (silence gaps, speaker changes, transcript word boundaries) but can be overridden. Talks don't overlap but gaps between them are allowed (representing MC/transition time).

### Waveform or Energy Display

NLEs show audio waveform to help identify silence gaps, applause, and speech. We have:
- Whisper segment confidence (`avg_logprob`, `no_speech_prob`) which roughly correlates with audio energy
- Speaker diarization segments which show speech/silence patterns
- Raw word timestamps which show speech density

A pseudo-waveform derived from word density + confidence would be cheaper than computing actual audio waveform but still useful for visual alignment.

### Verification Workflow

1. Open track view → see all detected boundaries on timeline
2. Play from each boundary — video + transcript sync shows what's happening
3. If boundary is wrong: drag to correct position
4. Mark talk as "verified" — builds ground truth
5. Save corrections → updates DB + boundary JSON

### Speaker Assignment

Currently speakers are anonymous (SPEAKER_00, SPEAKER_01). The diarization data could be enriched by:
- Mapping dominant speaker in each talk segment to the known speaker name
- Allowing manual correction of speaker labels
- Using this to identify where speakers appear across the full day (panels, Q&A, etc.)

### Data Model for Edits

Corrections need to be:
- Persisted (survive appview restart)
- Exportable (can update production PDS records)
- Versionable (track who changed what when)

Options:
- **A) Write to local JSON** (simplest, like current boundary-timings.csv)
- **B) Write to DB** (update `video_segments` directly)
- **C) Write to AT Protocol** (new lexicon for alignment corrections, published to PDS)

Option B for local dev, graduating to C for production. The AT Protocol approach makes corrections social — anyone could submit alignment corrections.

## Technical Considerations

### Timeline Interaction Layer

The current `StreamTimeline` is a simple div with absolutely-positioned colored blocks. For drag editing we need:
- Hit detection on boundary edges (not just the block interior)
- Drag handles with visual affordance (resize cursors, highlighted edges)
- Drag constraints (min segment duration, can't overlap adjacent talk)
- Snap-to guides (silence gaps, speaker changes, word boundaries)
- Undo/redo

This is a significant step up from the current passive display. Libraries like `@use-gesture/react` could help with drag interactions. Canvas rendering might be needed for smooth scrubbing at high zoom.

### Snap Targets

When dragging a boundary, nearby "interesting" positions should attract the handle:
- Silence gaps > 3s (from word timestamps)
- Speaker change points (from diarization)
- Low-confidence zone edges (from Whisper segments)
- Transcript word boundaries (for precise alignment)

These are all derivable from existing data — no new processing needed.

### Performance

Full-day transcripts are 50-65K words. The current TranscriptView renders all words and handles it well. The timeline has ~16-24 talk segments and ~1600-3800 diarization segments — no performance concern. Drag interactions need 60fps which means the timeline render path must be efficient (CSS transforms, not re-layout).

### Keyboard Shortcuts

NLE users expect:
- J/K/L for reverse/pause/forward
- Arrow keys for frame-by-frame (or word-by-word in our case)
- I/O for setting in/out points
- Spacebar for play/pause
- [ ] for nudging boundaries

## Dependencies

- Current track timeline view (done)
- Stable colors (done)
- Zoom + pan (done)
- Video player seeking (done)
- TranscriptView sync (done)

## What to Decide Before Building

1. **Interaction model**: Should editing be a separate mode (toggle "Edit" button) or always-on with hover affordance?
2. **Granularity**: Edit individual talk boundaries, or also allow adding/removing/splitting talks?
3. **Persistence**: Local-only for now, or AT Protocol from the start?
4. **Waveform**: Worth building a pseudo-waveform from word density, or skip it?
5. **Scope**: Just boundaries, or also speaker naming in this iteration?
6. **Multi-user**: Can multiple people edit the same stream? Conflict resolution?

## Suggested Decomposition

1. **Phase 1: Drag-to-edit boundaries** — core NLE trim interaction on the timeline, persisted to local JSON, undo/redo
2. **Phase 2: Snap targets** — silence gaps, speaker changes, word boundaries as magnetic snap points
3. **Phase 3: Verification workflow** — mark talks as verified, build ground truth, evaluation scoring
4. **Phase 4: Speaker naming** — map diarization IDs to known speakers, manual correction
5. **Phase 5: AT Protocol persistence** — publish corrections as records, social verification

## References

- Current track view: `apps/ionosphere/src/app/tracks/[stream]/TrackViewContent.tsx`
- Timeline component: `apps/ionosphere/src/app/components/StreamTimeline.tsx`
- Diarization band: `apps/ionosphere/src/app/components/DiarizationBand.tsx`
- Color system: `apps/ionosphere/src/lib/track-colors.ts`
- Boundary detection: `apps/ionosphere-appview/src/detect-boundaries-v6.ts`
- LLM refinement: `apps/ionosphere-appview/src/refine-boundaries-llm.ts`
- Track API: `apps/ionosphere-appview/src/tracks.ts`
- Boundary results: `apps/ionosphere-appview/data/fullday/<stream>/transcript-enriched-boundaries-v6-refined.json`
- Ground truth: `apps/ionosphere-appview/data/ground-truth/great-hall-day-1.json`
- Diarization data: `apps/ionosphere-appview/data/fullday/<stream>/diarization.json`
- Transcript data: `apps/ionosphere-appview/data/fullday/<stream>/transcript-enriched.json`
