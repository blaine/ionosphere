"""
Re-transcribe audio chunks with segment confidence and prompt hints.

Reads chunk MP3s from extract_audio output, sends to Whisper API with
both word and segment granularities, saves enhanced transcript JSON.

Usage:
  OPENAI_API_KEY=... uv run python transcribe_enhanced.py <stream_dir> [--prompt HINT]

Example:
  uv run python transcribe_enhanced.py ../data/fullday/Great_Hall___Day_1 \
    --prompt "ATmosphereConf 2026, Great Hall South. Speakers: Erin Kissane, ..."
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

    # Load API key from .env if not in environment
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists() and not os.environ.get("OPENAI_API_KEY"):
        for line in env_path.read_text().splitlines():
            if line.startswith("OPENAI_API_KEY="):
                os.environ["OPENAI_API_KEY"] = line.split("=", 1)[1].strip()

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
