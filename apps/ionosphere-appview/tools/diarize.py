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

    # Load HF token from .env if not in environment
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists() and not os.environ.get("HF_TOKEN"):
        for line in env_path.read_text().splitlines():
            if line.startswith("HF_TOKEN="):
                os.environ["HF_TOKEN"] = line.split("=", 1)[1].strip()

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
        token=hf_token,
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
