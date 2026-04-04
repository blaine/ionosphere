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
