# Enhanced Boundary Detection Pipeline

## Goal

Improve talk boundary detection reliability by adding two new signal layers — Whisper segment confidence and speaker diarization — while formalizing evaluation against ground truth. Train on Great Hall Day 1; reserve other 6 streams for verification to avoid overfitting.

## Current State

**Pipeline:** `transcribe-fullday.ts` → `detect-boundaries-v5.ts` → `apply-boundaries.ts`

**v5 signals:** silence gaps, transition phrases, phonetic speaker name matching, title keywords, DP assignment with drift tracking, forward-scan refinement.

**v5 results (Great Hall Day 1, 16 talks):** 12/13 verified within 2 min of ground truth. One outlier (Sattestations, 3:02 vs 3:16) in a garbled break zone.

**Weaknesses:**
- Garbled zone detection uses fragile word-repetition patterns
- No speaker identity signal — can't distinguish MC from presenter
- No automated evaluation — manual eyeballing only

## Design

### Architecture

```
HLS stream
  → ffmpeg extract audio (once, shared)
  → [parallel]
      Whisper re-transcription (with prompt hints + segment confidence)
      pyannote speaker diarization
  → merge enrichment data into unified transcript JSON
  → detect-boundaries-v6.ts (enhanced scoring)
  → evaluate against ground truth
```

### Layer 1: Audio Extraction (shared)

Single extraction step produces audio files consumed by both Whisper and pyannote. 20-minute MP3 chunks for Whisper (25MB limit), plus full WAV for pyannote (needs uncompressed audio for best results, and has no size limit).

Extracted audio stored in `data/fullday/<stream-name>/` so it persists across runs.

### Layer 2: Whisper Re-transcription with Segment Confidence

Re-transcribe Great Hall Day 1 using both `word` and `segment` timestamp granularities. Each segment gains `avg_logprob` and `no_speech_prob` fields.

Prompt hints per chunk: speaker names, talk titles, venue name ("ATmosphereConf 2026, Great Hall South"). This dramatically improves transcription quality (learned last session).

Output: enhanced transcript JSON with both word-level timestamps and segment-level confidence.

### Layer 3: Speaker Diarization (pyannote.audio)

**Tool:** pyannote.audio 3.x — state-of-the-art speaker diarization. Runs on MPS (Apple Silicon GPU).

**Input:** WAV audio (full stream or chunked).

**Output:** Speaker segments — `[{start, end, speaker_id}]` — aligned to word timestamps.

**Integration:** Each word in the transcript gets a `speaker` field. Boundary detection uses speaker-change points as signals.

**Panel handling:** Multiple speakers within a talk segment is expected. The boundary signal is whether the *set of active speakers* changes across a gap, not individual turn-taking.

**Broader value:** Speaker diarization is a first-class annotation layer, useful beyond boundary detection (city council meetings, interviews, panels, etc.).

### Layer 4: Enhanced Boundary Detection (v6)

New signals added to v5's scoring:

| Signal | Weight | Description |
|--------|--------|-------------|
| `speaker_change` | 12 | Dominant speaker before gap ≠ dominant speaker after gap |
| `speaker_set_change` | 8 | Set of speakers in prev window ≠ set in next window |
| `confidence_drop` | 6 | Low `avg_logprob` zone (music, applause, bad mic) near gap |
| `no_speech_zone` | 4 | High `no_speech_prob` segments reinforcing gap detection |

Weights are initial estimates; tuned against ground truth.

Garbled zone detection replaced: instead of word-repetition pattern matching, use `avg_logprob < threshold` and `no_speech_prob > threshold`.

### Layer 5: Ground Truth & Evaluation

Formalize Great Hall Day 1 ground truth as structured JSON:

```json
{
  "stream": "Great Hall - Day 1",
  "talks": [
    {
      "rkey": "gDELD0M",
      "title": "Landslide",
      "speaker": "Erin Kissane",
      "ground_truth_start": 990,
      "tolerance_seconds": 120
    },
    ...
  ]
}
```

Evaluation script scores a boundary detection run:
- Accuracy: % of talks within tolerance of ground truth
- Mean absolute error (seconds)
- Per-talk breakdown with pass/fail

### Project Structure

```
apps/ionosphere-appview/
  tools/
    requirements.txt
    extract_audio.py        # shared audio extraction from HLS
    diarize.py              # pyannote speaker diarization → JSON
    transcribe_enhanced.py  # Whisper with segment confidence + prompt hints
    merge_enrichment.py     # combine transcription + diarization into unified JSON
    evaluate.py             # score boundaries against ground truth
  src/
    detect-boundaries-v6.ts # enhanced detection
  data/
    ground-truth/
      great-hall-day-1.json
    fullday/                # extracted audio + enriched transcripts
```

Python tools are standalone scripts that produce JSON. TypeScript pipeline consumes JSON. Clean boundary between languages.

### Dev Workflow

1. Extract audio for Great Hall Day 1 (once)
2. Run Whisper re-transcription with segment confidence
3. Run pyannote diarization
4. Merge into enriched transcript
5. Run v6 boundary detection
6. Evaluate against ground truth
7. Iterate on scoring weights
8. When satisfied, run on verification streams (other 6) to check generalization

### Dependencies

**Python (new):**
- `pyannote.audio` ≥ 3.1
- `torch` (with MPS support)
- `openai` (for Whisper API)

**Existing:**
- `ffmpeg` (already used)
- `openai` npm package (existing, but Whisper calls move to Python)
