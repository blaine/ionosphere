"""Export stream transcripts from DB as compact JSON for the NLP pipeline."""

import json
import sqlite3
from pathlib import Path


def export_stream_transcripts(db_path: str, output_dir: str):
    conn = sqlite3.connect(db_path)

    streams = conn.execute("SELECT uri, slug FROM streams").fetchall()
    print(f"Found {len(streams)} streams")

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    exported = 0
    for stream_uri, slug in streams:
        chunks = conn.execute(
            "SELECT text, start_ms, timings FROM stream_transcripts WHERE stream_uri = ? ORDER BY chunk_index ASC",
            (stream_uri,)
        ).fetchall()

        if not chunks:
            continue

        # Reassemble into a single compact transcript
        full_text = ""
        all_timings = []
        start_ms = chunks[0][1]

        for text, chunk_start_ms, timings_json in chunks:
            timings = json.loads(timings_json)

            if full_text:
                # Add a gap between chunks if needed
                full_text += " "

            full_text += text
            all_timings.extend(timings)

        result = {
            "text": full_text,
            "startMs": start_ms,
            "timings": all_timings,
        }

        out_path = out / f"stream-{slug}.json"
        out_path.write_text(json.dumps(result))
        print(f"  {slug}: {len(full_text)} chars, {len(all_timings)} timing values")
        exported += 1

    conn.close()
    print(f"Exported {exported} stream transcripts")


if __name__ == "__main__":
    db_path = str(Path(__file__).resolve().parent.parent.parent / "apps" / "data" / "ionosphere.sqlite")
    output_dir = str(Path(__file__).resolve().parent.parent / "data" / "stream-transcripts")
    export_stream_transcripts(db_path, output_dir)
