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
