# Re-transcribe Hallucination Zones

**Date**: 2026-04-12
**Status**: Approved
**File**: `apps/ionosphere-appview/src/retranscribe-hallucinations.ts`

## Problem

Whisper hallucinates during silence/break periods in full-day conference streams, producing repeating phrases ("Transcription by CastingWords", "0 0 0 0", Welsh text, song lyrics, etc.). These hallucination zones cover ~20% of stream content and obscure real talk boundaries and content. The root cause: fixed 20-minute chunking means Whisper's context window fills with garbage from previous silence, causing cascading hallucination.

## Approach

Re-transcribe only the hallucination zones using diarization-aligned chunk boundaries. The diarization data shows exactly when real speech starts and stops, so we can give Whisper chunks that begin with real speech — clean context from the first word.

Uses existing OpenAI Whisper API (same as original transcription). Splices results back into `transcript-enriched.json`, replacing the hallucinated words.

## Pipeline

```
v7 boundary JSON (hallucinationZones) + HLS stream + diarization
  ↓
1. For each hallucination zone with diarization speech:
   a. Extract audio from HLS via ffmpeg (zone.startS → zone.endS)
   b. Split at diarization gaps if > 25 min (Whisper's limit)
   c. Transcribe via OpenAI Whisper API (word timestamps)
  ↓
2. Load transcript-enriched.json
  ↓
3. For each zone: remove hallucinated words, insert new words
  ↓
4. Write updated transcript-enriched.json
```

## Chunking Strategy

For each hallucination zone:
1. Load diarization segments overlapping the zone
2. Find first speech onset and last speech offset
3. If no speech in zone → skip (genuinely silent)
4. If speech < 25 min → one chunk
5. If speech > 25 min → split at diarization gaps > 5s

Each chunk starts at a diarization speech onset, ensuring Whisper gets clean context.

## Audio Extraction

Use ffmpeg to extract audio from the HLS VOD endpoint:
```bash
ffmpeg -ss <startS> -t <durationS> -i "<playlist_url>" -vn -ac 1 -ar 16000 -f mp3 <output.mp3>
```

Stream URIs come from the `STREAMS` config (same as existing transcription pipeline). Playlist URL: `https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist?uri=<uri>`.

## Transcript Splicing

After re-transcription of a zone:
1. Filter out existing words where `startS >= zone.startS && endS <= zone.endS`
2. Insert new words (with timestamps relative to zone start, adjusted to absolute stream time)
3. Re-sort word array by start time
4. Recalculate `total_words`

## CLI

```bash
npx tsx src/retranscribe-hallucinations.ts \
  --stream-slug room-2301-day-2 \
  --boundaries data/fullday/Room_2301___Day_2/transcript-enriched-boundaries-v7.json \
  --diarization data/fullday/Room_2301___Day_2/diarization.json
```

Requires: `OPENAI_API_KEY` in environment (from `.env`).

Reads stream URI from `STREAMS` config. Writes updated `transcript-enriched.json` in the same fullday directory.

## Scope

**Does:**
- Extract audio for hallucination zones from HLS
- Re-transcribe with diarization-aligned chunks
- Splice new words into existing transcript

**Does not:**
- Re-run diarization (existing is good)
- Re-run v7 boundary detection (separate step)
- Publish to PDS (separate step)

## Expected Impact

Hallucination zones covering actual talks (where diarization shows real speech):
- R2301 D2: 96-209m (Content Mod Futures, start of Blacksky)
- PT D2: 117-210m (Community Privacy, Cooperate & Succeed)
- PT D1: 124-200m (end of morning session)
- GH D2: 180-267m (lunch period — mostly DJ music, limited real speech)
- ATScience: 264-280m (Welsh hallucination over Astrosky start)
- Various short zones (< 5 min)

Re-transcription should recover talk content currently lost, improving v7 match accuracy from 90% toward 95%+.
