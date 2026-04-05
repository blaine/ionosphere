# Track Timeline View Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browsable full-day stream view with video, talk segments on a timeline, speaker diarization bands, and synced transcript.

**Architecture:** New `/tracks` routes in the Next.js frontend, new `getTrack` API endpoint in the Hono appview serving stream metadata + talk segments + diarization from existing data. Timeline and diarization are new client components; video player and transcript view are reused.

**Tech Stack:** Next.js (App Router), React, Hono, SQLite, existing HLS player

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `apps/ionosphere-appview/src/tracks.ts` | Track data: stream config, diarization loading, getTrack handler |
| `apps/ionosphere/src/app/tracks/page.tsx` | `/tracks` index page (server component) |
| `apps/ionosphere/src/app/tracks/[stream]/page.tsx` | `/tracks/[stream]` detail page (server component) |
| `apps/ionosphere/src/app/tracks/[stream]/TrackViewContent.tsx` | Client component orchestrating player + timeline + transcript |
| `apps/ionosphere/src/app/components/StreamTimeline.tsx` | Horizontal timeline with talk segments + scrubber |
| `apps/ionosphere/src/app/components/DiarizationBand.tsx` | Colored speaker band |

### Modified files

| File | Change |
|------|--------|
| `apps/ionosphere-appview/src/routes.ts` | Register `getTrack` and `getTracks` endpoints |
| `apps/ionosphere/src/lib/api.ts` | Add `getTracks()` and `getTrack(stream)` functions |
| `apps/ionosphere/src/app/components/NavHeader.tsx` | Add "Tracks" link to nav |

---

## Chunk 1: API Endpoint

### Task 1: Track data module

**Files:**
- Create: `apps/ionosphere-appview/src/tracks.ts`

- [ ] **Step 1: Create tracks.ts with stream config and getTrack handler**

This module:
- Defines the 7 stream configs (slug, name, room, day, URI)
- Loads diarization JSON from disk
- Queries talks from DB filtered by room/day
- Returns combined track data

```typescript
// tracks.ts structure:
// - STREAMS array with slug, name, room, day, uri
// - getTrackData(db, slug) -> { stream metadata, talks with offsets, diarization }
// - getTracksIndex(db) -> list of streams with talk counts
```

Key details:
- Stream slugs: `great-hall-day-1`, `great-hall-day-2`, etc.
- Diarization loaded from `data/fullday/<DirName>/diarization.json`
- Talk offsets read from `video_segments` JSON field on talk records
- Filter to only talks that have a fullday segment matching this stream URI
- PDT timezone conversion: `datetime(starts_at, '-7 hours')` for date filtering

- [ ] **Step 2: Register endpoints in routes.ts**

Add to routes.ts:
- `GET /xrpc/tv.ionosphere.getTracks` — returns `{ tracks: [...] }` with slug, name, room, day, duration, talkCount
- `GET /xrpc/tv.ionosphere.getTrack?stream=<slug>` — returns full track data

- [ ] **Step 3: Test the endpoint**

Run: `curl -s http://localhost:9401/xrpc/tv.ionosphere.getTracks | python3 -m json.tool | head -20`
Run: `curl -s "http://localhost:9401/xrpc/tv.ionosphere.getTrack?stream=great-hall-day-1" | python3 -m json.tool | head -40`

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere-appview/src/tracks.ts apps/ionosphere-appview/src/routes.ts
git commit -m "feat: getTrack and getTracks API endpoints"
```

---

### Task 2: API client functions

**Files:**
- Modify: `apps/ionosphere/src/lib/api.ts`

- [ ] **Step 1: Add getTracks and getTrack to api.ts**

```typescript
export async function getTracks() {
  return fetchApi<{ tracks: any[] }>("/xrpc/tv.ionosphere.getTracks");
}

export async function getTrack(stream: string) {
  return fetchApi<any>(`/xrpc/tv.ionosphere.getTrack?stream=${encodeURIComponent(stream)}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere/src/lib/api.ts
git commit -m "feat: add getTracks/getTrack API client functions"
```

---

## Chunk 2: Track Pages

### Task 3: Tracks index page

**Files:**
- Create: `apps/ionosphere/src/app/tracks/page.tsx`
- Modify: `apps/ionosphere/src/app/components/NavHeader.tsx`

- [ ] **Step 1: Create /tracks index page**

Server component. Calls `getTracks()`, renders a list of streams grouped by day. Each links to `/tracks/[slug]`. Shows room name, day, duration, talk count.

Follow the pattern from `apps/ionosphere/src/app/talks/page.tsx`.

- [ ] **Step 2: Add "Tracks" to NavHeader**

Add a link alongside the existing Talks, Speakers, Concepts links.

- [ ] **Step 3: Test**

Open `http://127.0.0.1:9402/tracks` — should show 7 streams.

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere/src/app/tracks/page.tsx apps/ionosphere/src/app/components/NavHeader.tsx
git commit -m "feat: tracks index page with nav link"
```

---

### Task 4: Track detail page shell

**Files:**
- Create: `apps/ionosphere/src/app/tracks/[stream]/page.tsx`
- Create: `apps/ionosphere/src/app/tracks/[stream]/TrackViewContent.tsx`

- [ ] **Step 1: Create the server page**

`page.tsx`: Server component that calls `getTrack(params.stream)`, passes data to `TrackViewContent`.

- [ ] **Step 2: Create TrackViewContent client component**

Initial version: video player at top, talk list below with jump-to buttons. Wire up `TimestampProvider` so seeking works.

The video player uses the stream URI directly (no offset — we're playing the whole stream). Talk list items call `onSeek` with the talk's start time in nanoseconds.

- [ ] **Step 3: Test**

Open `http://127.0.0.1:9402/tracks/great-hall-day-1` — should show video + talk list. Clicking a talk should seek the video.

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere/src/app/tracks/\[stream\]/
git commit -m "feat: track detail page with video player and talk list"
```

---

## Chunk 3: Timeline + Diarization

### Task 5: StreamTimeline component

**Files:**
- Create: `apps/ionosphere/src/app/components/StreamTimeline.tsx`

- [ ] **Step 1: Build the timeline**

Client component. Props: `talks` (with start/end seconds), `durationSeconds`, `currentTimeNs`, `onSeek`.

Renders:
- Horizontal bar (full width) representing the stream duration
- Talk segments as colored blocks with labels (truncated to fit)
- Vertical scrubber line at current playback position
- Click anywhere to seek

Use CSS for layout — talk blocks are absolutely positioned with `left` and `width` as percentages of duration.

- [ ] **Step 2: Wire into TrackViewContent**

Add `StreamTimeline` between the video player and the talk list. Pass current time from `TimestampProvider` and talks from API data.

- [ ] **Step 3: Test**

Timeline should show colored blocks for each talk. Scrubber should move with video playback. Clicking should seek.

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere/src/app/components/StreamTimeline.tsx apps/ionosphere/src/app/tracks/\[stream\]/TrackViewContent.tsx
git commit -m "feat: stream timeline with talk segments and scrubber"
```

---

### Task 6: DiarizationBand component

**Files:**
- Create: `apps/ionosphere/src/app/components/DiarizationBand.tsx`

- [ ] **Step 1: Build the diarization band**

Client component. Props: `segments` (from diarization JSON), `durationSeconds`.

Renders a thin horizontal bar with colored blocks for each speaker. Speaker → color mapping generated deterministically from speaker ID (hash to hue). Adjacent segments from the same speaker merged for performance.

- [ ] **Step 2: Wire into TrackViewContent**

Add below the `StreamTimeline`.

- [ ] **Step 3: Test**

Colored bands should appear below the timeline. Different speakers should have different colors.

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere/src/app/components/DiarizationBand.tsx apps/ionosphere/src/app/tracks/\[stream\]/TrackViewContent.tsx
git commit -m "feat: speaker diarization band on track timeline"
```

---

## Chunk 4: Transcript Integration

### Task 7: Track transcript in the detail view

**Files:**
- Modify: `apps/ionosphere/src/app/tracks/[stream]/TrackViewContent.tsx`

- [ ] **Step 1: Add transcript display**

The API endpoint should include the track transcript data (or a reference to it). Add the transcript below the timeline/talk list, using the existing `TranscriptView` component or a simplified version.

The track transcript is the full `transcript-enriched.json` content. For the API, serve the word-level data with timestamps so the existing transcript sync works. The transcript is large (~50-65K words) so consider pagination or virtualized rendering.

Initial approach: serve transcript words grouped into chunks (~500 words each) and render the chunk containing the current playback position + surrounding chunks.

- [ ] **Step 2: Test**

Transcript should auto-scroll to current playback position. Talk boundary markers should be visible.

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere/src/app/tracks/\[stream\]/TrackViewContent.tsx
git commit -m "feat: synced transcript display in track view"
```

---

## Notes

- The transcript integration (Task 7) is the most complex piece due to the size of full-day transcripts. A simple initial approach (render a window around the current time) is fine — optimize later.
- The existing `TranscriptView` expects a `TranscriptDocument` format. The track transcript is in a different format (raw words with timestamps). Either adapt TranscriptView or build a simpler `TrackTranscript` component that just renders timestamped text.
- Diarization data is ~3000 segments per stream. Rendering all of them as DOM elements works fine — it's just colored divs.
