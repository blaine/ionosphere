# Re-transcribe Hallucination Zones Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-transcribe Whisper hallucination zones using diarization-aligned chunk boundaries, splicing clean results back into `transcript-enriched.json`.

**Architecture:** Single CLI tool that reads v7 boundary output for hallucination zones, extracts audio from HLS for each zone, re-transcribes with OpenAI Whisper API using diarization-derived chunk points, and patches the transcript in-place.

**Tech Stack:** TypeScript, OpenAI Whisper API, ffmpeg (audio extraction), existing `transcript-enriched.json` format

**Spec:** `docs/superpowers/specs/2026-04-12-retranscribe-hallucinations-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/retranscribe-hallucinations.ts` | CLI tool: parse args, orchestrate extraction/transcription/splicing |

Reused from existing code:
- `src/transcribe-fullday.ts` — reference for `extractChunk`, `transcribeChunk` patterns (copy/adapt, don't import — that file has hardcoded stream configs)
- `src/v7/types.ts` — `HallucinationZone`, `DiarizationInput`
- `src/tracks.ts` — `STREAMS` config for stream URIs

---

## Chunk 1: The Tool

### Task 1: retranscribe-hallucinations.ts

**Files:**
- Create: `apps/ionosphere-appview/src/retranscribe-hallucinations.ts`

- [ ] **Step 1: Implement the CLI tool**

The tool needs these parts:

**CLI arg parsing:**
```
npx tsx src/retranscribe-hallucinations.ts \
  --stream-slug <slug> \
  --boundaries <path-to-v7-boundaries.json> \
  --diarization <path-to-diarization.json>
```

Also needs `OPENAI_API_KEY` from environment (load via `./env.js` like existing code).

**Core logic:**

```ts
import "./env.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import OpenAI from "openai";
import type { HallucinationZone, DiarizationInput } from "./v7/types.js";
```

1. **Load inputs:**
   - Parse v7 boundaries JSON → extract `hallucinationZones` array
   - Load diarization JSON
   - Load existing `transcript-enriched.json` from the stream's fullday dir
   - Get stream URI from `STREAMS` config (import from tracks.ts or inline)

2. **For each hallucination zone:**
   - Find diarization segments that overlap the zone
   - If no diarization speech → skip (log "no speech in zone, skipping")
   - Compute chunk boundaries from diarization:
     - Start at first speech segment onset within zone
     - End at last speech segment offset within zone
     - If total duration > 20 min (Whisper's practical limit at 32kbps), split at diarization gaps > 5s
   - Extract audio for each chunk via ffmpeg:
     ```
     ffmpeg -ss <startS> -i "<playlistUrl>" -t <durationS> -vn -acodec libmp3lame -ar 16000 -ac 1 -b:a 32k "<tmpFile>" -y
     ```
     Use a temp directory: `<streamDir>/retranscribe-chunks/`
   - Transcribe each chunk via OpenAI Whisper API (same params as `transcribe-fullday.ts`):
     ```ts
     const response = await client.audio.transcriptions.create({
       model: "whisper-1",
       file: createReadStream(chunkPath),
       response_format: "verbose_json",
       timestamp_granularities: ["word"],
     });
     ```
   - Adjust word timestamps: Whisper returns timestamps relative to chunk start, so add the chunk's absolute start time: `word.start += chunkStartS; word.end += chunkStartS;`

3. **Splice into transcript:**
   - Load `transcript-enriched.json`
   - For each re-transcribed zone:
     - Remove all words where `word.start >= zone.startS && word.start <= zone.endS`
     - Insert new words
   - Sort all words by start time
   - Update `total_words`
   - Write back to `transcript-enriched.json`
   - Also back up original as `transcript-enriched.json.bak` before first write

**Console output:**
```
=== Re-transcribing hallucination zones for room-2301-day-2 ===
  Loaded 9 hallucination zones
  Zone 1: 96.0m - 209.0m (113.0m)
    Diarization speech: 5 segments, 12.3m total
    Chunks: 1 (12.3m)
    Extracting audio... done
    Transcribing chunk 1/1... 847 words
  Zone 2: ...
  ...
  Splicing 2,341 new words into transcript
  Removed 8,542 hallucinated words
  Wrote transcript-enriched.json (backup: .bak)
```

**Key references in existing code:**
- `transcribe-fullday.ts:64-76` — `extractChunk` function (ffmpeg command)
- `transcribe-fullday.ts:81-98` — `transcribeChunk` function (OpenAI API call)
- `transcribe-fullday.ts:38-41` — `FULLDAY_STREAMS` for stream URIs
- `tracks.ts:27-34` — `STREAMS` config with URIs and dir names

**Stream URI → playlist URL:**
```ts
const VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";
const playlistUrl = `${VOD_ENDPOINT}?uri=${encodeURIComponent(streamUri)}`;
```

**STREAMS config for slug → URI + dirName mapping** (from tracks.ts):
```ts
const STREAMS = [
  { slug: "great-hall-day-1", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadw52j22", dirName: "Great_Hall___Day_1" },
  { slug: "great-hall-day-2", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miighlz53o22", dirName: "Great_Hall___Day_2" },
  { slug: "room-2301-day-1", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadx2dj22", dirName: "Room_2301___Day_1" },
  { slug: "room-2301-day-2", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadxeqn22", dirName: "Room_2301___Day_2" },
  { slug: "performance-theatre-day-1", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwgvz22", dirName: "Performance_Theater___Day_1" },
  { slug: "performance-theatre-day-2", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwqgy22", dirName: "Performance_Theater___Day_2" },
  { slug: "atscience", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadvruo22", dirName: "ATScience" },
];
```

- [ ] **Step 2: Test on a small hallucination zone first**

Pick ATScience (Welsh hallucination, only 16 min zone) as a test case:

```bash
cd apps/ionosphere-appview
source .env && export OPENAI_API_KEY

# First generate v7 boundaries if not already present
npx tsx src/detect-boundaries-v7.ts \
  data/fullday/ATScience/transcript-enriched.json \
  --diarization data/fullday/ATScience/diarization.json \
  --stream-slug atscience

# Then re-transcribe
npx tsx src/retranscribe-hallucinations.ts \
  --stream-slug atscience \
  --boundaries data/fullday/ATScience/transcript-enriched-boundaries-v7.json \
  --diarization data/fullday/ATScience/diarization.json
```

Verify:
- Check that `transcript-enriched.json.bak` was created
- Compare word count before and after
- Spot-check the re-transcribed zone: are the Welsh hallucinations gone? Is there English content now?

- [ ] **Step 3: Commit**

```bash
git add src/retranscribe-hallucinations.ts
git commit -m "feat: retranscribe hallucination zones using diarization-aligned chunks"
```

### Task 2: Run on All Streams

- [ ] **Step 1: Generate v7 boundaries for all streams** (if not already done)

- [ ] **Step 2: Re-transcribe each stream**

```bash
cd apps/ionosphere-appview
source .env && export OPENAI_API_KEY

for slug in atscience great-hall-day-1 great-hall-day-2 room-2301-day-1 room-2301-day-2 performance-theatre-day-1 performance-theatre-day-2; do
  dir=$(echo "$slug" | sed 's/great-hall-day-1/Great_Hall___Day_1/' | sed 's/great-hall-day-2/Great_Hall___Day_2/' | sed 's/room-2301-day-1/Room_2301___Day_1/' | sed 's/room-2301-day-2/Room_2301___Day_2/' | sed 's/performance-theatre-day-1/Performance_Theater___Day_1/' | sed 's/performance-theatre-day-2/Performance_Theater___Day_2/' | sed 's/atscience/ATScience/')
  echo "=== $slug ==="
  npx tsx src/retranscribe-hallucinations.ts \
    --stream-slug "$slug" \
    --boundaries "data/fullday/$dir/transcript-enriched-boundaries-v7.json" \
    --diarization "data/fullday/$dir/diarization.json"
  echo
done
```

- [ ] **Step 3: Re-run v7 detection on updated transcripts**

Run v7 again with the patched transcripts to see if match accuracy improves:

```bash
for slug in atscience great-hall-day-1 great-hall-day-2 room-2301-day-1 room-2301-day-2 performance-theatre-day-1 performance-theatre-day-2; do
  dir=$(...)
  echo "=== $slug ==="
  npx tsx src/detect-boundaries-v7.ts \
    "data/fullday/$dir/transcript-enriched.json" \
    --diarization "data/fullday/$dir/diarization.json" \
    --stream-slug "$slug" 2>&1 | grep -E "^(Results|Unmatched sch)"
done
```

Expected: match accuracy improves from 90% toward 95%+ as previously-unverifiable talks become matchable.

- [ ] **Step 4: Commit updated transcripts**

```bash
git add -A
git commit -m "data: re-transcribed hallucination zones across all 7 streams"
```
