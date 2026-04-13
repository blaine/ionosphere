# Boundary Detection v7 — Diarization-First Pipeline

**Date**: 2026-04-12
**Status**: Approved
**File**: `apps/ionosphere-appview/src/detect-boundaries-v7.ts`

## Problem

The v6 boundary detector uses transcript gaps and Whisper speaker labels as primary signals. During manual verification of all 7 streams, we found this approach fails badly in hallucination zones (Whisper fills silence with repeating text like "Transcription by CastingWords", "0 0 0 0", song lyrics) and causes cross-track assignment errors when matching by schedule time + room.

Key finding: **diarization data tracks actual audio** and shows real speech boundaries even through hallucination zones. A 94-minute silence gap on PT D2 was completely invisible in the transcript but obvious in diarization.

## Approach

**Diarization first, transcript second.** Build a timeline of talk-shaped segments from diarization, then use transcript content to identify which talk each segment contains. Schedule provides candidate talks but never dictates timing.

## Pipeline

```
Diarization JSON + Transcript JSON + Schedule (DB)
  ↓
Stage 1: Diarization Segmentation
  ↓
Stage 2: Transcript Content Matching
  ↓
Stage 3: Schedule Reconciliation
  ↓
Boundary JSON (v6-compatible format)
```

## Stage 1: Diarization Segmentation

**Input**: `diarization.json` (`{segments: [{start, end, speaker}], speakers: []}`)

**Process**:
- Merge adjacent same-speaker segments with < 5s gaps into speech blocks
- Classify gaps between blocks:
  - \> 60s = **session break**
  - 30-60s = **likely talk boundary**
  - < 30s = **within-talk pause**
- Group blocks between session breaks into sessions
- Within each session, classify by speaker distribution:
  - One speaker > 70% duration = **single-speaker talk**
  - Multiple speakers with balanced time = **panel**
- **Hallucination detection**: Where diarization shows silence but transcript has words, mark as hallucination zone. Also detect known patterns:
  - Repeating phrases in ~30s loops ("Transcription by CastingWords", "Transcribed by https://otter.ai")
  - Numeric zeros ("0 0 0 0 0")
  - "Microsoft Office Word Document MSWordDoc"
  - "Transcription by ESO Translation by --"
  - "UGA Extension Office of Communications and Creative Services"
  - Non-English loops (Welsh "Rwy n gobeithio...")
  - Song lyrics between known gaps (DJ music on GH D2)
  - URLs/attribution ("Subs by www.zeoranger.co.uk", "www.fema.gov")
  - "Thank you for watching" / "Thank you" loops

**Output**:
```ts
interface TalkSegment {
  startS: number;
  endS: number;
  speakers: { id: string; durationS: number }[];
  type: 'single-speaker' | 'panel' | 'unknown';
  dominantSpeaker?: string;
  precedingGapS: number;
  hallucinationZone: boolean;
}

interface HallucinationZone {
  startS: number;
  endS: number;
  pattern: string;
}
```

## Stage 2: Transcript Content Matching

For each `TalkSegment`, extract identity signals from transcript text in that time range.

**Signals (ordered by reliability)**:

1. **MC handoffs**: "please welcome {NAME}", "next up is {NAME}", "setting up next". Found in the 30-60s before a talk starts.
2. **Self-introductions**: "my name is {NAME}", "I'm {NAME} I'm from/at/with {ORG}". First 60s of a talk. Strongest identity signal.
3. **Topic keywords**: Nouns/phrases from first 2 minutes matched against talk titles.
4. **Speaker name matching**: Fuzzy/phonetic match against schedule speaker list. Handles Whisper mangling ("Jekard"/"Jacquard", "Wardmuller"/"Werdmuller").

**Matching logic**:
- Hallucination zone segments: `confidence = 'unverifiable'`, candidates from schedule by time window
- Speaker name + topic keyword match: `confidence = 'high'`
- Speaker name OR topic keyword match: `confidence = 'medium'`
- No match: `confidence = 'low'`

**Panel handling**: When segment type is `panel`, extract ALL speaker names and match multiple schedule entries to the same time range. Flag as `panel: true`.

**Output**:
```ts
interface BoundaryMatch {
  rkey: string;
  title: string;
  startS: number;
  endS: number;
  confidence: 'high' | 'medium' | 'low' | 'unverifiable';
  signals: string[];
  panel: boolean;
  hallucinationZones: HallucinationZone[];
}
```

## Stage 3: Schedule Reconciliation

1. **Validate matches**: Resolve duplicate assignments (same rkey to multiple segments). Pick highest confidence.
2. **Unmatched schedule entries**: If scheduled time falls in hallucination zone, assign as `unverifiable`. If within a panel's range, assign with `low` confidence. Otherwise omit with log message.
3. **Unmatched segments**: Real speech with no schedule match. Output as `unknown-talk` for manual review.
4. **End time calculation**: Each talk ends at next talk's start minus gap, or diarization silence onset. Last talk in session ends at last diarization speech. Absolute last talk ends at stream duration or last speech.

## Output Format

Compatible with v6 for downstream use by `refine-boundaries-llm.ts` and `apply-boundaries.ts`:

```ts
{
  stream: string;
  results: BoundaryMatch[];
  hallucinationZones: HallucinationZone[];
  unmatchedSegments: TalkSegment[];
  unmatchedSchedule: string[];
}
```

## CLI Interface

```bash
npx tsx src/detect-boundaries-v7.ts \
  data/fullday/<Dir>/transcript-enriched.json \
  --diarization data/fullday/<Dir>/diarization.json \
  --stream-slug great-hall-day-1
```

`--diarization` is required. Stream slug pulls schedule from DB.

## Confidence Tiers

| Tier | Meaning | Action |
|------|---------|--------|
| high | Diarization boundary + transcript confirms speaker and topic | Auto-accept |
| medium | Diarization boundary exists, partial transcript match | Review recommended |
| low | Weak match, possibly wrong assignment | Manual verification needed |
| unverifiable | Talk in hallucination zone, no audio evidence | Check video or remove |

## Future: Hallucination Re-transcription (Phase C)

Marked hallucination zones enable a future pipeline stage: re-transcribe those audio regions using diarization-derived boundaries as chunking points, giving Whisper clean context without the rotted pre-context that causes hallucination cascading. This is out of scope for v7 but the data model supports it.

## Validation

Run v7 on all 7 streams and compare output against the manually verified ground truth from the April 12 audit. Success criteria:
- All `high` confidence results match ground truth
- No cross-track assignment errors
- All hallucination zones correctly detected
- Unmatched segments/schedule entries are legitimate (talks not recorded, etc.)
