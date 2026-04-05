# Track Timeline View

## Goal

A browsable view for full-day conference streams, showing the video with talk segments on a visual timeline, speaker diarization as colored bands, and the existing transcript/comments display synced to playback.

## Route & Navigation

- `/tracks` — index page listing all streams (7 total)
- `/tracks/[stream]` — individual stream view (e.g. `/tracks/great-hall-day-1`)
- Talks that have a fullday video source link to their track view from the talk page

## Layout

1. **Video player** — full-day HLS stream, same player component used elsewhere
2. **Timeline bar** — horizontal bar spanning stream duration
   - Talk segments as labeled, proportionally-sized blocks
   - Playback scrubber line moving with the video
   - Click anywhere on the timeline to seek
   - Click a talk segment to jump to its start
3. **Speaker diarization band** — thin colored strip below the timeline showing speaker activity. Each speaker gets a consistent color. Hovering shows speaker ID.
4. **Talk list** — ordered list of talks in the stream with start times, speakers, and jump-to action
5. **Transcript view** — the full track transcript (from `transcript-enriched.json`), synced to playback position. Talk boundaries shown as markers within the continuous transcript. No switching between per-talk transcripts — the track transcript IS the transcript, with talk segments as markers on it.

## API

New endpoint: `tv.ionosphere.getTrack`

**Input:** stream identifier (slug like `great-hall-day-1` or stream URI)

**Output:**
```json
{
  "stream": "Great Hall - Day 1",
  "streamUri": "at://...",
  "durationSeconds": 28433,
  "playbackUrl": "https://vod-beta.stream.place/...",
  "talks": [
    {
      "rkey": "gDELD0M",
      "title": "Landslide",
      "speakers": ["Erin Kissane"],
      "startSeconds": 990,
      "endSeconds": 4254,
      "confidence": "high"
    }
  ],
  "diarization": [
    { "start": 0, "end": 45.2, "speaker": "SPEAKER_00" },
    { "start": 45.2, "end": 120.5, "speaker": "SPEAKER_01" }
  ]
}
```

The diarization array is served from the per-stream JSON files already on disk. For the initial implementation, serve the full diarization data — it's ~3000 segments per stream which is manageable. Can be simplified later if needed.

## Data Sources

All data already exists:
- Stream URIs and playback URLs: hardcoded in `transcribe-fullday.ts`, also derivable from stream records
- Talk segments with offsets: `video_segments` field on talk records in DB
- Diarization: `data/fullday/<stream>/diarization.json`
- Track transcripts: `data/fullday/<stream>/transcript-enriched.json` (full track with timestamps + speaker labels)

## Stream Slug Mapping

| Slug | Stream Name | URI |
|------|------------|-----|
| great-hall-day-1 | Great Hall - Day 1 | at://...3miieadw52j22 |
| great-hall-day-2 | Great Hall - Day 2 | at://...3miighlz53o22 |
| room-2301-day-1 | Room 2301 - Day 1 | at://...3miieadx2dj22 |
| room-2301-day-2 | Room 2301 - Day 2 | at://...3miieadxeqn22 |
| performance-theatre-day-1 | Performance Theater - Day 1 | at://...3miieadwgvz22 |
| performance-theatre-day-2 | Performance Theater - Day 2 | at://...3miieadwqgy22 |
| atscience | ATScience - Full Day | at://...3miieadvruo22 |

## Frontend Components

- **TrackIndex** — `/tracks` page, lists all streams with room, day, duration, talk count
- **TrackView** — `/tracks/[stream]` page, orchestrates the layout
- **StreamTimeline** — the horizontal timeline with talk segments and scrubber
- **DiarizationBand** — colored speaker band below timeline
- **TrackTalkList** — ordered talk list with jump-to actions

Reuses existing:
- Video player component
- TranscriptView (adapted to use track-level transcript rather than per-talk)

## Not In Scope

- Drag-to-edit boundaries (future)
- Speaker naming / mapping diarization IDs to real names (future)
- Waveform visualization (future)
