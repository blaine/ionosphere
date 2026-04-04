# Enhanced Boundary Detection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Whisper segment confidence and pyannote speaker diarization to the boundary detection pipeline, with formalized ground truth evaluation, to improve talk boundary accuracy.

**Architecture:** Python tools (`apps/ionosphere-appview/tools/`) handle audio extraction, Whisper re-transcription with segment confidence, and speaker diarization. Each produces JSON. A merge step combines them into an enriched transcript. TypeScript `detect-boundaries-v6.ts` consumes the enriched transcript and adds speaker-change and confidence-based scoring signals. An evaluation script scores results against ground truth.

**Tech Stack:** Python 3.13 (via uv), pyannote.audio 3.x, torch (MPS), OpenAI Whisper API, TypeScript (existing), vitest (existing)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `apps/ionosphere-appview/tools/pyproject.toml` | Python project config with uv |
| `apps/ionosphere-appview/tools/extract_audio.py` | Extract audio from HLS streams (MP3 chunks + WAV) |
| `apps/ionosphere-appview/tools/transcribe_enhanced.py` | Whisper re-transcription with segment confidence + prompt hints |
| `apps/ionosphere-appview/tools/diarize.py` | pyannote speaker diarization → JSON |
| `apps/ionosphere-appview/tools/merge_enrichment.py` | Combine transcript + diarization into unified JSON |
| `apps/ionosphere-appview/tools/evaluate.py` | Score boundaries against ground truth |
| `apps/ionosphere-appview/tools/test_evaluate.py` | Tests for evaluation scoring |
| `apps/ionosphere-appview/tools/test_merge.py` | Tests for merge/alignment logic |
| `apps/ionosphere-appview/data/ground-truth/great-hall-day-1.json` | Ground truth timestamps |
| `apps/ionosphere-appview/src/detect-boundaries-v6.ts` | Enhanced boundary detection |
| `apps/ionosphere-appview/src/detect-boundaries-v6.test.ts` | Tests for v6 scoring functions |

### Modified files

| File | Change |
|------|--------|
| `apps/ionosphere-appview/.gitignore` | Add `data/fullday/` (large audio/transcript files) |

### Stream config (shared)

The FULLDAY_STREAMS array in `transcribe-fullday.ts` is the source of truth for stream URIs. The Python tools accept stream name + URI as CLI args rather than duplicating this config.

---

## Chunk 1: Python Environment + Audio Extraction + Ground Truth

### Task 1: Python project setup

**Files:**
- Create: `apps/ionosphere-appview/tools/pyproject.toml`
- Modify: `apps/ionosphere-appview/.gitignore`

- [ ] **Step 1: Create pyproject.toml**

```toml
[project]
name = "ionosphere-tools"
version = "0.1.0"
description = "Audio enrichment tools for ionosphere boundary detection"
requires-python = ">=3.12"
dependencies = [
    "openai>=1.0",
    "pyannote-audio>=3.1",
    "torch>=2.0",
]

[project.optional-dependencies]
dev = ["pytest>=8.0"]

[tool.pytest.ini_options]
testpaths = ["."]
```

- [ ] **Step 2: Create the virtual environment**

Run: `cd apps/ionosphere-appview/tools && uv sync`
Expected: Creates `.venv/` and installs all dependencies including torch with MPS support.

- [ ] **Step 3: Verify torch MPS support**

Run: `cd apps/ionosphere-appview/tools && uv run python -c "import torch; print('MPS:', torch.backends.mps.is_available())"`
Expected: `MPS: True`

- [ ] **Step 4: Add data/fullday to gitignore**

Append to `apps/ionosphere-appview/.gitignore`:
```
data/fullday/
```

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere-appview/tools/pyproject.toml apps/ionosphere-appview/.gitignore
git commit -m "feat: add Python tooling environment for audio enrichment"
```

---

### Task 2: Ground truth data

**Files:**
- Create: `apps/ionosphere-appview/data/ground-truth/great-hall-day-1.json`

Ground truth timestamps from manual verification (memory notes). Times in seconds from stream start. Note: some talks were not manually verified — these have `verified: false`.

- [ ] **Step 1: Create ground truth JSON**

```json
{
  "stream": "Great Hall - Day 1",
  "notes": "Manually verified timestamps from stream playback. Tolerance is per-talk based on transition clarity.",
  "talks": [
    {
      "rkey": "gDELD0M",
      "title": "Landslide",
      "speaker": "Erin Kissane",
      "ground_truth_start": 990,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "Stream starts garbled, first talk begins ~16:30"
    },
    {
      "rkey": "QK9Ae6Y",
      "title": "Groundings with my Siblings: Lessons Learned Building for Community",
      "speaker": "Rudy Fraser",
      "ground_truth_start": 4254,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "1:10:54 from stream start"
    },
    {
      "rkey": "obaP26x",
      "title": "Who owns the group chat? Building collaborative spaces on ATProto",
      "speaker": "Brittany Ellich",
      "ground_truth_start": 6260,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "1:44:20 from stream start"
    },
    {
      "rkey": "000Syverson",
      "title": "Sattestations",
      "speaker": "Paul Syverson",
      "ground_truth_start": 11760,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "3:16:00 — garbled break zone before this talk. v5 detected 3:02:28 (outlier)"
    },
    {
      "rkey": "81Xovjr",
      "title": "Feeds Are The New Websites",
      "speaker": "Mike McCue",
      "ground_truth_start": 12594,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "3:29:54 — v5 detected 3:29:13"
    },
    {
      "rkey": "LZxV6dv",
      "title": "Consent Before Cryptography",
      "speaker": "Tessa Brown",
      "ground_truth_start": 13531,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "3:45:31 — v5 detected 3:46:39"
    },
    {
      "rkey": "Y561Qv6",
      "title": "From protocol to product: How Expo powers the next wave of social apps",
      "speaker": "Eliot",
      "ground_truth_start": 15368,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "4:16:08 — v5 detected 4:16:53"
    },
    {
      "rkey": "aQ1J9GE",
      "title": "2026 Atmosphere Report",
      "speaker": "Paul Frazee",
      "ground_truth_start": 17475,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "4:51:15 — v5 detected 4:50:27"
    },
    {
      "rkey": "2EG4YMj",
      "title": "What 350,000 users taught me about growing on Open Social",
      "speaker": "Tori",
      "ground_truth_start": 21451,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "5:57:31 — v5 detected 5:56:13"
    },
    {
      "rkey": "000Jer",
      "title": "The Future of Open Source is Social",
      "speaker": "Jer Miller",
      "ground_truth_start": 22062,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "6:07:42 — v5 detected 6:07:21"
    },
    {
      "rkey": "2EGLPML",
      "title": "Burning down data walls in the US Fire Service and beyond",
      "speaker": "Stephan Noel",
      "ground_truth_start": 22514,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "6:15:14 — v5 detected 6:15:02"
    },
    {
      "rkey": "OD2G9j8",
      "title": "The Phoenix Architecture",
      "speaker": "Chad Fowler",
      "ground_truth_start": 23426,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "6:30:26 — v5 detected 6:28:27 (borderline)"
    },
    {
      "rkey": "rj8Xv62",
      "title": "This Title Left Intentionally Blank",
      "speaker": "Blaine Cook",
      "ground_truth_start": 25228,
      "tolerance_seconds": 120,
      "verified": true,
      "notes": "7:00:28"
    }
  ]
}
```

Note: Some talks from the v5 results (ODxNLMM "kpop", 7Rrv0E0 "Beyond Bluesky", OD6Gd0A "Semble") don't have ground truth timestamps in the notes. They're included in v5 output but not verified. Tony Schneider's bonus talk also not included (not on schedule).

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere-appview/data/ground-truth/great-hall-day-1.json
git commit -m "data: add Great Hall Day 1 ground truth timestamps"
```

---

### Task 3: Audio extraction script

**Files:**
- Create: `apps/ionosphere-appview/tools/extract_audio.py`

This script extracts audio from an HLS stream, producing:
- 20-minute MP3 chunks (for Whisper, 16kHz mono 32kbps)
- Full WAV (for pyannote, 16kHz mono)

Skips files that already exist.

- [ ] **Step 1: Write extract_audio.py**

```python
"""
Extract audio from HLS streams for transcription and diarization.

Produces:
  - 20-minute MP3 chunks (for Whisper, ≤25MB each)
  - Full WAV (for pyannote diarization, 16kHz mono)

Usage:
  uv run python extract_audio.py <stream_name> <stream_uri> [--output-dir DIR]

Example:
  uv run python extract_audio.py "Great Hall - Day 1" \
    "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadw52j22"
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist"
CHUNK_SECONDS = 20 * 60  # 20-minute chunks


def playlist_url(uri: str) -> str:
    return f"{VOD_ENDPOINT}?uri={quote(uri, safe='')}"


def stream_duration(url: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", url],
        capture_output=True, text=True, timeout=60,
    )
    return float(result.stdout.strip() or 0)


def extract_chunks(url: str, duration: float, out_dir: Path) -> list[Path]:
    """Extract 20-minute MP3 chunks for Whisper."""
    chunks = []
    num_chunks = int(duration // CHUNK_SECONDS) + (1 if duration % CHUNK_SECONDS > 0 else 0)

    for i in range(num_chunks):
        start = i * CHUNK_SECONDS
        chunk_dur = min(CHUNK_SECONDS, duration - start)
        chunk_path = out_dir / f"chunk-{i:03d}.mp3"
        chunks.append(chunk_path)

        if chunk_path.exists():
            print(f"  Chunk {i+1}/{num_chunks}: exists")
            continue

        print(f"  Chunk {i+1}/{num_chunks}: extracting {start}s-{start+chunk_dur:.0f}s...")
        subprocess.run(
            ["ffmpeg", "-i", url, "-ss", str(start), "-t", str(chunk_dur),
             "-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1",
             "-b:a", "32k", str(chunk_path), "-y"],
            capture_output=True, timeout=600,
            check=True,
        )

    return chunks


def extract_wav(url: str, out_dir: Path) -> Path:
    """Extract full WAV for pyannote diarization."""
    wav_path = out_dir / "full.wav"
    if wav_path.exists():
        print("  WAV: exists")
        return wav_path

    print("  Extracting full WAV for diarization...")
    subprocess.run(
        ["ffmpeg", "-i", url, "-vn", "-acodec", "pcm_s16le",
         "-ar", "16000", "-ac", "1", str(wav_path), "-y"],
        capture_output=True, timeout=1800,
        check=True,
    )
    return wav_path


def main():
    parser = argparse.ArgumentParser(description="Extract audio from HLS streams")
    parser.add_argument("stream_name", help="Stream name (e.g. 'Great Hall - Day 1')")
    parser.add_argument("stream_uri", help="AT Protocol URI for the stream")
    parser.add_argument("--output-dir", type=Path,
                        default=Path(__file__).parent.parent / "data" / "fullday")
    args = parser.parse_args()

    safe_name = args.stream_name.replace(" ", "_").replace("-", "_")
    out_dir = args.output_dir / safe_name
    out_dir.mkdir(parents=True, exist_ok=True)

    url = playlist_url(args.stream_uri)
    print(f"Stream: {args.stream_name}")
    print(f"URL: {url}")

    duration = stream_duration(url)
    if duration <= 0:
        print("ERROR: Could not determine stream duration", file=sys.stderr)
        sys.exit(1)
    print(f"Duration: {duration/3600:.1f}h ({duration:.0f}s)")

    # Extract chunks and WAV
    chunks = extract_chunks(url, duration, out_dir)
    wav = extract_wav(url, out_dir)

    # Save manifest
    manifest = {
        "stream_name": args.stream_name,
        "stream_uri": args.stream_uri,
        "duration_seconds": duration,
        "chunks": [str(c.name) for c in chunks],
        "wav": str(wav.name),
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"\nDone: {len(chunks)} chunks + WAV → {out_dir}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Test extraction on a short segment (manual)**

Run: `cd apps/ionosphere-appview/tools && uv run python extract_audio.py "Great Hall - Day 1" "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadw52j22"`

Expected: Creates `data/fullday/Great_Hall___Day_1/` with chunk MP3s, full.wav, and manifest.json. This will take a while (8h stream).

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/tools/extract_audio.py
git commit -m "feat: audio extraction script for HLS streams"
```

---

## Chunk 2: Whisper Re-transcription with Segment Confidence

### Task 4: Enhanced Whisper transcription

**Files:**
- Create: `apps/ionosphere-appview/tools/transcribe_enhanced.py`

Re-transcribes audio chunks using the Whisper API with:
- Both `word` and `segment` timestamp granularities
- Prompt hints (speaker names, talk titles, venue)
- Segment-level `avg_logprob` and `no_speech_prob`

- [ ] **Step 1: Write transcribe_enhanced.py**

```python
"""
Re-transcribe audio chunks with segment confidence and prompt hints.

Reads chunk MP3s from extract_audio output, sends to Whisper API with
both word and segment granularities, saves enhanced transcript JSON.

Usage:
  OPENAI_API_KEY=... uv run python transcribe_enhanced.py <stream_dir> [--prompt HINT]

Example:
  uv run python transcribe_enhanced.py ../data/fullday/Great_Hall___Day_1 \
    --prompt "ATmosphereConf 2026, Great Hall South. Speakers: Erin Kissane, Rudy Fraser, ..."
"""
import argparse
import json
import os
import sys
from pathlib import Path

from openai import OpenAI


def transcribe_chunk(client: OpenAI, chunk_path: Path, prompt: str) -> dict:
    """Transcribe a single chunk with both word and segment granularities."""
    with open(chunk_path, "rb") as f:
        response = client.audio.transcriptions.create(
            model="whisper-1",
            file=f,
            response_format="verbose_json",
            timestamp_granularities=["word", "segment"],
            language="en",
            prompt=prompt,
        )

    words = [
        {"word": w.word, "start": w.start, "end": w.end}
        for w in (response.words or [])
    ]

    segments = [
        {
            "id": s.id,
            "start": s.start,
            "end": s.end,
            "text": s.text,
            "avg_logprob": s.avg_logprob,
            "no_speech_prob": s.no_speech_prob,
            "compression_ratio": s.compression_ratio,
        }
        for s in (response.segments or [])
    ]

    return {"text": response.text, "words": words, "segments": segments}


def main():
    parser = argparse.ArgumentParser(description="Re-transcribe with segment confidence")
    parser.add_argument("stream_dir", type=Path, help="Directory with extracted audio chunks")
    parser.add_argument("--prompt", default="ATmosphereConf 2026 conference talk.",
                        help="Whisper prompt hint")
    parser.add_argument("--force", action="store_true", help="Re-transcribe even if cached")
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    client = OpenAI()
    manifest_path = args.stream_dir / "manifest.json"
    if not manifest_path.exists():
        print(f"ERROR: No manifest.json in {args.stream_dir}", file=sys.stderr)
        sys.exit(1)

    manifest = json.loads(manifest_path.read_text())
    chunk_names = manifest["chunks"]
    duration = manifest["duration_seconds"]

    print(f"Stream: {manifest['stream_name']}")
    print(f"Chunks: {len(chunk_names)}")
    print(f"Prompt: {args.prompt[:80]}...")

    all_words = []
    all_segments = []
    full_text = ""
    chunk_seconds = 20 * 60

    for i, chunk_name in enumerate(chunk_names):
        chunk_path = args.stream_dir / chunk_name
        cache_path = args.stream_dir / f"transcript-{i:03d}.json"
        start_offset = i * chunk_seconds

        if cache_path.exists() and not args.force:
            print(f"  Chunk {i+1}/{len(chunk_names)}: cached")
            cached = json.loads(cache_path.read_text())
            all_words.extend(cached["words"])
            all_segments.extend(cached["segments"])
            full_text += (" " if full_text else "") + cached["text"]
            continue

        if not chunk_path.exists():
            print(f"  Chunk {i+1}/{len(chunk_names)}: SKIP (no audio)")
            continue

        print(f"  Chunk {i+1}/{len(chunk_names)}: transcribing...")
        try:
            result = transcribe_chunk(client, chunk_path, args.prompt)
        except Exception as e:
            print(f"  Chunk {i+1}/{len(chunk_names)}: FAILED ({e})")
            cache_path.write_text(json.dumps({"text": "", "words": [], "segments": []}))
            continue

        # Offset timestamps to absolute stream position
        for w in result["words"]:
            w["start"] += start_offset
            w["end"] += start_offset
        for s in result["segments"]:
            s["start"] += start_offset
            s["end"] += start_offset

        cache_path.write_text(json.dumps(result))
        all_words.extend(result["words"])
        all_segments.extend(result["segments"])
        full_text += (" " if full_text else "") + result["text"]
        print(f"    {len(result['words'])} words, {len(result['segments'])} segments")

    # Save stitched transcript
    output = {
        "stream": manifest["stream_name"],
        "duration_seconds": duration,
        "text": full_text,
        "words": all_words,
        "segments": all_segments,
        "total_words": len(all_words),
        "total_segments": len(all_segments),
    }
    output_path = args.stream_dir / "transcript-enhanced.json"
    output_path.write_text(json.dumps(output, indent=2))
    print(f"\nDone: {len(all_words)} words, {len(all_segments)} segments → {output_path}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run on Great Hall Day 1 (after audio extraction)**

Run:
```bash
cd apps/ionosphere-appview/tools
OPENAI_API_KEY=... uv run python transcribe_enhanced.py ../data/fullday/Great_Hall___Day_1 \
  --prompt "ATmosphereConf 2026, Great Hall South. Speakers: Erin Kissane, Rudy Fraser, Brittany Ellich, Paul Syverson, Mike McCue, Tessa Brown, Eliot, Paul Frazee, Tori, Jer Miller, Stephan Noel, Chad Fowler, Blaine Cook, Tony Schneider."
```

Expected: Creates `transcript-enhanced.json` with words + segments including `avg_logprob` and `no_speech_prob`.

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/tools/transcribe_enhanced.py
git commit -m "feat: enhanced Whisper transcription with segment confidence"
```

---

## Chunk 3: Speaker Diarization

### Task 5: pyannote diarization script

**Files:**
- Create: `apps/ionosphere-appview/tools/diarize.py`

Runs pyannote.audio speaker diarization on the full WAV, produces speaker segments JSON.

- [ ] **Step 1: Write diarize.py**

```python
"""
Speaker diarization using pyannote.audio.

Reads full.wav from extract_audio output, runs diarization, saves
speaker segments as JSON.

Usage:
  uv run python diarize.py <stream_dir> [--min-speakers N] [--max-speakers N]

Requires a HuggingFace token with access to pyannote models:
  export HF_TOKEN=...

First run will download the model (~1GB).
"""
import argparse
import json
import os
import sys
from pathlib import Path

import torch
from pyannote.audio import Pipeline


def main():
    parser = argparse.ArgumentParser(description="Speaker diarization")
    parser.add_argument("stream_dir", type=Path, help="Directory with full.wav")
    parser.add_argument("--min-speakers", type=int, default=None)
    parser.add_argument("--max-speakers", type=int, default=None)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    wav_path = args.stream_dir / "full.wav"
    output_path = args.stream_dir / "diarization.json"

    if output_path.exists() and not args.force:
        print(f"Diarization already exists: {output_path}")
        return

    if not wav_path.exists():
        print(f"ERROR: {wav_path} not found. Run extract_audio.py first.", file=sys.stderr)
        sys.exit(1)

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("ERROR: HF_TOKEN not set. Get one at https://huggingface.co/settings/tokens", file=sys.stderr)
        print("  You also need to accept the model terms at:")
        print("  https://huggingface.co/pyannote/speaker-diarization-3.1")
        print("  https://huggingface.co/pyannote/segmentation-3.0")
        sys.exit(1)

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    print(f"Device: {device}")
    print(f"Audio: {wav_path}")

    # Load pipeline
    print("Loading pyannote pipeline...")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=hf_token,
    )
    pipeline.to(device)

    # Run diarization
    print("Running diarization (this may take a while for long streams)...")
    diarize_params = {}
    if args.min_speakers is not None:
        diarize_params["min_speakers"] = args.min_speakers
    if args.max_speakers is not None:
        diarize_params["max_speakers"] = args.max_speakers

    diarization = pipeline(str(wav_path), **diarize_params)

    # Convert to JSON-serializable format
    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append({
            "start": round(turn.start, 3),
            "end": round(turn.end, 3),
            "speaker": speaker,
        })

    # Summary
    speakers = sorted(set(s["speaker"] for s in segments))
    print(f"\nFound {len(speakers)} speakers, {len(segments)} segments")
    for spk in speakers:
        spk_segs = [s for s in segments if s["speaker"] == spk]
        total_dur = sum(s["end"] - s["start"] for s in spk_segs)
        print(f"  {spk}: {len(spk_segs)} segments, {total_dur/60:.1f} min")

    output = {
        "speakers": speakers,
        "segments": segments,
        "total_segments": len(segments),
    }
    output_path.write_text(json.dumps(output, indent=2))
    print(f"\nSaved: {output_path}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run on Great Hall Day 1 (after audio extraction)**

Run:
```bash
cd apps/ionosphere-appview/tools
HF_TOKEN=... uv run python diarize.py ../data/fullday/Great_Hall___Day_1
```

Expected: Creates `diarization.json` with speaker segments. May take 10-30 minutes for an 8h stream.

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/tools/diarize.py
git commit -m "feat: pyannote speaker diarization script"
```

---

## Chunk 4: Merge Enrichment + Evaluation

### Task 6: Merge enrichment data

**Files:**
- Create: `apps/ionosphere-appview/tools/merge_enrichment.py`
- Create: `apps/ionosphere-appview/tools/test_merge.py`

Combines transcript (with segment confidence) and diarization into a single enriched transcript JSON. Each word gets a `speaker` field by aligning word timestamps with diarization segments.

- [ ] **Step 1: Write the test**

```python
# test_merge.py
"""Tests for merge_enrichment.py alignment logic."""
from merge_enrichment import assign_speakers_to_words, find_dominant_speaker


def test_assign_speakers_basic():
    words = [
        {"word": "hello", "start": 0.0, "end": 0.5},
        {"word": "world", "start": 0.6, "end": 1.0},
        {"word": "goodbye", "start": 5.0, "end": 5.5},
    ]
    diarization = [
        {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_00"},
        {"start": 4.5, "end": 6.0, "speaker": "SPEAKER_01"},
    ]
    result = assign_speakers_to_words(words, diarization)
    assert result[0]["speaker"] == "SPEAKER_00"
    assert result[1]["speaker"] == "SPEAKER_00"
    assert result[2]["speaker"] == "SPEAKER_01"


def test_assign_speakers_gap():
    """Words in a gap between diarization segments get nearest speaker."""
    words = [
        {"word": "um", "start": 3.0, "end": 3.2},
    ]
    diarization = [
        {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_00"},
        {"start": 4.0, "end": 6.0, "speaker": "SPEAKER_01"},
    ]
    result = assign_speakers_to_words(words, diarization)
    # Closer to SPEAKER_01 (1.0s gap vs 1.0s gap — tie goes to next)
    assert result[0]["speaker"] in ("SPEAKER_00", "SPEAKER_01")


def test_dominant_speaker():
    words = [
        {"word": "a", "start": 0, "end": 1, "speaker": "SPEAKER_00"},
        {"word": "b", "start": 1, "end": 2, "speaker": "SPEAKER_00"},
        {"word": "c", "start": 2, "end": 3, "speaker": "SPEAKER_01"},
    ]
    assert find_dominant_speaker(words) == "SPEAKER_00"


def test_dominant_speaker_empty():
    assert find_dominant_speaker([]) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ionosphere-appview/tools && uv run pytest test_merge.py -v`
Expected: FAIL — `merge_enrichment` module not found.

- [ ] **Step 3: Write merge_enrichment.py**

```python
"""
Merge transcript and diarization into unified enriched transcript.

Aligns word timestamps with diarization speaker segments so each word
gets a speaker label. Also carries forward segment-level confidence.

Usage:
  uv run python merge_enrichment.py <stream_dir>
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path


def assign_speakers_to_words(
    words: list[dict],
    diarization: list[dict],
) -> list[dict]:
    """Assign a speaker label to each word based on diarization segments.

    For each word, find the diarization segment that overlaps its midpoint.
    If no segment overlaps, assign the nearest segment's speaker.
    """
    if not diarization:
        return words

    result = []
    dia_idx = 0

    for word in words:
        mid = (word["start"] + word["end"]) / 2
        speaker = None

        # Advance diarization index to find overlapping segment
        while dia_idx < len(diarization) and diarization[dia_idx]["end"] < mid:
            dia_idx += 1

        # Check current and nearby segments for overlap
        for offset in (0, -1, 1):
            idx = dia_idx + offset
            if 0 <= idx < len(diarization):
                seg = diarization[idx]
                if seg["start"] <= mid <= seg["end"]:
                    speaker = seg["speaker"]
                    break

        # No overlap — find nearest
        if speaker is None:
            best_dist = float("inf")
            for seg in diarization:
                dist = min(abs(seg["start"] - mid), abs(seg["end"] - mid))
                if dist < best_dist:
                    best_dist = dist
                    speaker = seg["speaker"]

        result.append({**word, "speaker": speaker})

    return result


def find_dominant_speaker(words: list[dict]) -> str | None:
    """Find the speaker with the most words in a list."""
    speakers = [w.get("speaker") for w in words if w.get("speaker")]
    if not speakers:
        return None
    return Counter(speakers).most_common(1)[0][0]


def main():
    parser = argparse.ArgumentParser(description="Merge transcript + diarization")
    parser.add_argument("stream_dir", type=Path)
    args = parser.parse_args()

    transcript_path = args.stream_dir / "transcript-enhanced.json"
    diarization_path = args.stream_dir / "diarization.json"
    output_path = args.stream_dir / "transcript-enriched.json"

    if not transcript_path.exists():
        print(f"ERROR: {transcript_path} not found", file=sys.stderr)
        sys.exit(1)

    transcript = json.loads(transcript_path.read_text())
    words = transcript["words"]
    segments = transcript.get("segments", [])

    # Load diarization if available
    if diarization_path.exists():
        diarization = json.loads(diarization_path.read_text())
        dia_segments = diarization["segments"]
        print(f"Diarization: {len(dia_segments)} segments, {len(diarization['speakers'])} speakers")
        words = assign_speakers_to_words(words, dia_segments)
    else:
        print("No diarization data — skipping speaker assignment")

    output = {
        "stream": transcript["stream"],
        "duration_seconds": transcript["duration_seconds"],
        "words": words,
        "segments": segments,
        "total_words": len(words),
        "total_segments": len(segments),
    }
    output_path.write_text(json.dumps(output, indent=2))

    # Stats
    if any(w.get("speaker") for w in words):
        speakers = Counter(w.get("speaker") for w in words if w.get("speaker"))
        print(f"\nSpeaker word counts:")
        for spk, count in speakers.most_common():
            print(f"  {spk}: {count} words")

    print(f"\nSaved: {output_path}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests**

Run: `cd apps/ionosphere-appview/tools && uv run pytest test_merge.py -v`
Expected: All 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere-appview/tools/merge_enrichment.py apps/ionosphere-appview/tools/test_merge.py
git commit -m "feat: merge transcript and diarization into enriched JSON"
```

---

### Task 7: Evaluation script

**Files:**
- Create: `apps/ionosphere-appview/tools/evaluate.py`
- Create: `apps/ionosphere-appview/tools/test_evaluate.py`

Scores boundary detection results against ground truth.

- [ ] **Step 1: Write the test**

```python
# test_evaluate.py
"""Tests for evaluate.py scoring logic."""
from evaluate import score_boundaries


def test_perfect_score():
    ground_truth = [
        {"rkey": "a", "title": "Talk A", "ground_truth_start": 100, "tolerance_seconds": 30, "verified": True},
        {"rkey": "b", "title": "Talk B", "ground_truth_start": 500, "tolerance_seconds": 30, "verified": True},
    ]
    boundaries = [
        {"rkey": "a", "startTimestamp": 100},
        {"rkey": "b", "startTimestamp": 500},
    ]
    result = score_boundaries(ground_truth, boundaries)
    assert result["accuracy"] == 1.0
    assert result["mean_absolute_error"] == 0.0
    assert all(t["pass"] for t in result["talks"])


def test_one_miss():
    ground_truth = [
        {"rkey": "a", "title": "Talk A", "ground_truth_start": 100, "tolerance_seconds": 30, "verified": True},
        {"rkey": "b", "title": "Talk B", "ground_truth_start": 500, "tolerance_seconds": 30, "verified": True},
    ]
    boundaries = [
        {"rkey": "a", "startTimestamp": 110},
        {"rkey": "b", "startTimestamp": 600},  # 100s off, outside tolerance
    ]
    result = score_boundaries(ground_truth, boundaries)
    assert result["accuracy"] == 0.5
    assert result["talks"][0]["pass"] is True
    assert result["talks"][1]["pass"] is False


def test_unverified_skipped():
    ground_truth = [
        {"rkey": "a", "title": "Talk A", "ground_truth_start": 100, "tolerance_seconds": 30, "verified": True},
        {"rkey": "b", "title": "Talk B", "ground_truth_start": 500, "tolerance_seconds": 30, "verified": False},
    ]
    boundaries = [
        {"rkey": "a", "startTimestamp": 100},
        {"rkey": "b", "startTimestamp": 999},
    ]
    result = score_boundaries(ground_truth, boundaries)
    assert result["accuracy"] == 1.0  # only verified talks count
    assert len([t for t in result["talks"] if t.get("skipped")]) == 1


def test_missing_boundary():
    ground_truth = [
        {"rkey": "a", "title": "Talk A", "ground_truth_start": 100, "tolerance_seconds": 30, "verified": True},
    ]
    boundaries = []
    result = score_boundaries(ground_truth, boundaries)
    assert result["accuracy"] == 0.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ionosphere-appview/tools && uv run pytest test_evaluate.py -v`
Expected: FAIL — `evaluate` module not found.

- [ ] **Step 3: Write evaluate.py**

```python
"""
Evaluate boundary detection results against ground truth.

Usage:
  uv run python evaluate.py <boundaries.json> <ground-truth.json>

Example:
  uv run python evaluate.py ../data/fullday/Great_Hall___Day_1/boundaries-v6.json \
    ../data/ground-truth/great-hall-day-1.json
"""
import argparse
import json
import sys
from pathlib import Path


def fmt(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h}:{m:02d}:{s:02d}"


def score_boundaries(
    ground_truth: list[dict],
    boundaries: list[dict],
) -> dict:
    """Score detected boundaries against ground truth.

    Returns accuracy, mean absolute error, and per-talk breakdown.
    Only verified ground truth entries are scored.
    """
    boundary_map = {b["rkey"]: b for b in boundaries}

    talks = []
    verified_count = 0
    pass_count = 0
    total_error = 0.0

    for gt in ground_truth:
        if not gt.get("verified", True):
            talks.append({
                "rkey": gt["rkey"],
                "title": gt.get("title", ""),
                "skipped": True,
                "reason": "not verified",
            })
            continue

        verified_count += 1
        detected = boundary_map.get(gt["rkey"])

        if detected is None:
            talks.append({
                "rkey": gt["rkey"],
                "title": gt.get("title", ""),
                "pass": False,
                "reason": "not detected",
                "ground_truth": gt["ground_truth_start"],
            })
            continue

        error = abs(detected["startTimestamp"] - gt["ground_truth_start"])
        passed = error <= gt["tolerance_seconds"]
        if passed:
            pass_count += 1
        total_error += error

        talks.append({
            "rkey": gt["rkey"],
            "title": gt.get("title", ""),
            "pass": passed,
            "error_seconds": round(error, 1),
            "ground_truth": gt["ground_truth_start"],
            "detected": detected["startTimestamp"],
            "tolerance": gt["tolerance_seconds"],
            "ground_truth_fmt": fmt(gt["ground_truth_start"]),
            "detected_fmt": fmt(detected["startTimestamp"]),
        })

    accuracy = pass_count / verified_count if verified_count > 0 else 0.0
    mae = total_error / verified_count if verified_count > 0 else 0.0

    return {
        "accuracy": accuracy,
        "mean_absolute_error": round(mae, 1),
        "verified_count": verified_count,
        "pass_count": pass_count,
        "talks": talks,
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate boundaries against ground truth")
    parser.add_argument("boundaries", type=Path)
    parser.add_argument("ground_truth", type=Path)
    args = parser.parse_args()

    boundaries_data = json.loads(args.boundaries.read_text())
    gt_data = json.loads(args.ground_truth.read_text())

    results_list = boundaries_data.get("results", boundaries_data)
    if isinstance(results_list, dict):
        results_list = [results_list]

    result = score_boundaries(gt_data["talks"], results_list)

    print(f"Accuracy: {result['accuracy']:.0%} ({result['pass_count']}/{result['verified_count']})")
    print(f"Mean Absolute Error: {result['mean_absolute_error']}s")
    print()
    print(f"{'Talk':<50} {'GT':>8} {'Det':>8} {'Err':>6} {'Pass':>5}")
    print("-" * 85)
    for t in result["talks"]:
        if t.get("skipped"):
            print(f"{t['title'][:49]:<50} {'SKIPPED':>8}")
            continue
        gt_str = t.get("ground_truth_fmt", "?")
        det_str = t.get("detected_fmt", "?")
        err = t.get("error_seconds", "?")
        passed = "✓" if t["pass"] else "✗"
        print(f"{t['title'][:49]:<50} {gt_str:>8} {det_str:>8} {str(err):>5}s {passed:>5}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests**

Run: `cd apps/ionosphere-appview/tools && uv run pytest test_evaluate.py -v`
Expected: All 4 tests pass.

- [ ] **Step 5: Evaluate v5 against ground truth (baseline)**

Run:
```bash
cd apps/ionosphere-appview/tools
uv run python evaluate.py /tmp/fullday-transcripts/Great_Hall_-_Day_1-boundaries-v5.json \
  ../data/ground-truth/great-hall-day-1.json
```

Expected: Shows per-talk accuracy. This establishes the v5 baseline we're improving on.

- [ ] **Step 6: Commit**

```bash
git add apps/ionosphere-appview/tools/evaluate.py apps/ionosphere-appview/tools/test_evaluate.py
git commit -m "feat: evaluation script for boundary detection accuracy"
```

---

## Chunk 5: Enhanced Boundary Detection (v6)

### Task 8: detect-boundaries-v6.ts

**Files:**
- Create: `apps/ionosphere-appview/src/detect-boundaries-v6.ts`
- Create: `apps/ionosphere-appview/src/detect-boundaries-v6.test.ts`

Copy v5 as baseline, add new scoring signals:
- Speaker change detection from diarization data
- Confidence-based garbled zone detection from segment data
- Replace word-repetition garbled zone detection

- [ ] **Step 1: Write tests for new scoring functions**

```typescript
// detect-boundaries-v6.test.ts
import { describe, it, expect } from "vitest";
import {
  scoreSpeakerChange,
  scoreConfidenceDrop,
  findLowConfidenceZones,
} from "./detect-boundaries-v6.js";

describe("scoreSpeakerChange", () => {
  it("returns high score when dominant speaker changes", () => {
    const wordsBefore = [
      { word: "thanks", start: 0, end: 1, speaker: "SPEAKER_00" },
      { word: "everyone", start: 1, end: 2, speaker: "SPEAKER_00" },
    ];
    const wordsAfter = [
      { word: "hello", start: 5, end: 6, speaker: "SPEAKER_01" },
      { word: "there", start: 6, end: 7, speaker: "SPEAKER_01" },
    ];
    const result = scoreSpeakerChange(wordsBefore, wordsAfter);
    expect(result.score).toBeGreaterThanOrEqual(12);
    expect(result.signal).toContain("speaker_change");
  });

  it("returns zero when same speaker continues", () => {
    const wordsBefore = [
      { word: "and", start: 0, end: 1, speaker: "SPEAKER_00" },
      { word: "also", start: 1, end: 2, speaker: "SPEAKER_00" },
    ];
    const wordsAfter = [
      { word: "next", start: 5, end: 6, speaker: "SPEAKER_00" },
      { word: "slide", start: 6, end: 7, speaker: "SPEAKER_00" },
    ];
    const result = scoreSpeakerChange(wordsBefore, wordsAfter);
    expect(result.score).toBe(0);
  });

  it("handles missing speaker data gracefully", () => {
    const wordsBefore = [{ word: "hi", start: 0, end: 1 }];
    const wordsAfter = [{ word: "bye", start: 5, end: 6 }];
    const result = scoreSpeakerChange(wordsBefore, wordsAfter);
    expect(result.score).toBe(0);
  });
});

describe("scoreConfidenceDrop", () => {
  it("scores high for low avg_logprob near gap", () => {
    const segments = [
      { start: 0, end: 10, avg_logprob: -0.3, no_speech_prob: 0.1 },
      { start: 10, end: 20, avg_logprob: -1.5, no_speech_prob: 0.8 }, // bad
      { start: 20, end: 30, avg_logprob: -0.2, no_speech_prob: 0.05 },
    ];
    const result = scoreConfidenceDrop(segments, 15, 10);
    expect(result.score).toBeGreaterThan(0);
    expect(result.signal).toContain("confidence_drop");
  });

  it("returns zero for high confidence segments", () => {
    const segments = [
      { start: 0, end: 10, avg_logprob: -0.2, no_speech_prob: 0.05 },
      { start: 10, end: 20, avg_logprob: -0.3, no_speech_prob: 0.1 },
    ];
    const result = scoreConfidenceDrop(segments, 10, 10);
    expect(result.score).toBe(0);
  });
});

describe("findLowConfidenceZones", () => {
  it("finds contiguous low-confidence segments", () => {
    const segments = [
      { start: 0, end: 10, avg_logprob: -0.3, no_speech_prob: 0.1 },
      { start: 10, end: 20, avg_logprob: -1.5, no_speech_prob: 0.9 },
      { start: 20, end: 30, avg_logprob: -1.8, no_speech_prob: 0.85 },
      { start: 30, end: 40, avg_logprob: -0.2, no_speech_prob: 0.05 },
    ];
    const zones = findLowConfidenceZones(segments);
    expect(zones.length).toBe(1);
    expect(zones[0].start).toBe(10);
    expect(zones[0].end).toBe(30);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/ionosphere-appview && npx vitest run src/detect-boundaries-v6.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Copy v5 as baseline and add new scoring functions**

Start from `detect-boundaries-v5.ts`. Key changes:

1. **New interfaces** for enriched data:
   - `EnrichedWord` extends `Word` with optional `speaker: string`
   - `Segment` with `start, end, avg_logprob, no_speech_prob, compression_ratio`

2. **New exported scoring functions:**
   - `scoreSpeakerChange(wordsBefore, wordsAfter)` → `{ score, signal }`
   - `scoreConfidenceDrop(segments, gapTimestamp, windowSec)` → `{ score, signal }`
   - `findLowConfidenceZones(segments)` → `Array<{ start, end }>`

3. **Modified `scoreGapGeneric`:** adds confidence scoring if segments available.

4. **Modified `selectTransitionsDP`:** adds speaker-change scoring during gap evaluation.

5. **Modified `findUsableTranscriptStart`:** uses `findLowConfidenceZones` instead of word-repetition.

6. **Input format:** reads enriched transcript JSON (with `words[].speaker` and `segments[]`), falls back gracefully to plain transcript format.

The full file is a copy of v5 with these additions — keep all existing v5 logic intact.

- [ ] **Step 4: Run tests**

Run: `cd apps/ionosphere-appview && npx vitest run src/detect-boundaries-v6.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run v6 on existing v5 transcript (no enrichment yet)**

Run: `cd apps/ionosphere-appview && npx tsx src/detect-boundaries-v6.ts /tmp/fullday-transcripts/Great_Hall_-_Day_1.json`

Expected: Should produce equivalent results to v5 (no enrichment data = no new signals). Validates backward compatibility.

- [ ] **Step 6: Commit**

```bash
git add apps/ionosphere-appview/src/detect-boundaries-v6.ts apps/ionosphere-appview/src/detect-boundaries-v6.test.ts
git commit -m "feat: boundary detection v6 with speaker change and confidence scoring"
```

---

## Chunk 6: Integration & First Run

### Task 9: End-to-end pipeline run

This is an execution task, not a code task. Run the full pipeline on Great Hall Day 1.

- [ ] **Step 1: Extract audio**

```bash
cd apps/ionosphere-appview/tools
uv run python extract_audio.py "Great Hall - Day 1" \
  "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadw52j22"
```

This will take ~20-30 minutes (8h stream download + extraction).

- [ ] **Step 2: Run Whisper re-transcription**

```bash
cd apps/ionosphere-appview/tools
OPENAI_API_KEY=... uv run python transcribe_enhanced.py \
  ../data/fullday/Great_Hall___Day_1 \
  --prompt "ATmosphereConf 2026, Great Hall South. Speakers: Erin Kissane, Rudy Fraser, Brittany Ellich, Paul Syverson, Mike McCue, Tessa Brown, Eliot, Paul Frazee, Tori, Jer Miller, Stephan Noel, Chad Fowler, Blaine Cook, Tony Schneider."
```

- [ ] **Step 3: Run speaker diarization**

```bash
cd apps/ionosphere-appview/tools
HF_TOKEN=... uv run python diarize.py ../data/fullday/Great_Hall___Day_1
```

- [ ] **Step 4: Merge enrichment**

```bash
cd apps/ionosphere-appview/tools
uv run python merge_enrichment.py ../data/fullday/Great_Hall___Day_1
```

- [ ] **Step 5: Run v6 boundary detection**

```bash
cd apps/ionosphere-appview
npx tsx src/detect-boundaries-v6.ts data/fullday/Great_Hall___Day_1/transcript-enriched.json
```

- [ ] **Step 6: Evaluate against ground truth**

```bash
cd apps/ionosphere-appview/tools
uv run python evaluate.py \
  ../data/fullday/Great_Hall___Day_1/Great_Hall___Day_1-boundaries-v6.json \
  ../data/ground-truth/great-hall-day-1.json
```

- [ ] **Step 7: Compare v6 vs v5 baseline**

Run evaluate.py on the v5 results too and compare accuracy + MAE. Document findings.

---

## Notes

- **HuggingFace token:** pyannote models require accepting terms at huggingface.co. User needs `HF_TOKEN`.
- **OpenAI API cost:** Re-transcribing an 8h stream ≈ 24 chunks × ~$0.006/min × 20min = ~$2.88.
- **Audio storage:** Full WAV for 8h stream ≈ ~900MB. MP3 chunks ≈ ~350MB total. Gitignored.
- **Iterating on weights:** After the first run, scoring weights in v6 can be tuned by modifying constants and re-running evaluate. No re-transcription or re-diarization needed.
