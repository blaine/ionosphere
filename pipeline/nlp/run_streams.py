"""Run NLP pipeline on stream transcripts (without LLM pass — too large)."""

import json
import sqlite3
import sys
from pathlib import Path
from nlp.sentences import detect_sentences
from nlp.paragraphs import detect_paragraphs
from nlp.entities import detect_entities
from nlp.speaker_lookup import build_speaker_lookup
from nlp.topics import detect_topic_breaks


def main():
    streams_dir = Path(__file__).resolve().parent.parent / "data" / "stream-transcripts"
    output_dir = Path(__file__).resolve().parent.parent / "data" / "stream-nlp"
    output_dir.mkdir(parents=True, exist_ok=True)

    if not streams_dir.exists():
        print("Run export_streams.py first")
        sys.exit(1)

    # Load speaker/concept data
    db_path = Path(__file__).resolve().parent.parent.parent / "apps" / "data" / "ionosphere.sqlite"
    speaker_rows = []
    concept_rows = []
    if db_path.exists():
        conn = sqlite3.connect(str(db_path))
        speaker_rows = conn.execute("SELECT name, handle, speaker_did FROM speakers").fetchall()
        concept_rows = [
            {"name": r[0], "uri": r[1], "aliases": r[2] or "[]"}
            for r in conn.execute("SELECT name, uri, aliases FROM concepts").fetchall()
        ]
        conn.close()
        print(f"Loaded {len(speaker_rows)} speakers, {len(concept_rows)} concepts", flush=True)

    speaker_lookup = build_speaker_lookup(speaker_rows) if speaker_rows else None

    for tf in sorted(streams_dir.glob("*.json")):
        slug = tf.stem.replace("stream-", "")
        transcript = json.loads(tf.read_text())
        text = transcript["text"]
        timings = transcript["timings"]
        start_ms = transcript["startMs"]

        print(f"Processing {slug} ({len(text)} chars)...", flush=True)

        # Pass 1: Sentences
        sentences = detect_sentences(text)
        print(f"  {len(sentences)} sentences", flush=True)

        # Pass 2: Paragraphs
        paragraphs = detect_paragraphs(
            text=text, timings=timings, start_ms=start_ms,
            sentences=sentences,
        )
        print(f"  {len(paragraphs)} paragraphs", flush=True)

        # Pass 3: NER + entity linking (no LLM — too large)
        entities = detect_entities(text, speaker_lookup=speaker_lookup, concept_rows=concept_rows)
        print(f"  {len(entities)} entities", flush=True)

        # Pass 4: Topic segmentation
        sentences_with_text = []
        for s in sentences:
            sent_text = text.encode("utf-8")[s["byteStart"]:s["byteEnd"]].decode("utf-8")
            sentences_with_text.append({**s, "text": sent_text})
        topic_breaks = detect_topic_breaks(sentences_with_text)
        print(f"  {len(topic_breaks)} topics", flush=True)

        result = {
            "slug": slug,
            "sentences": sentences,
            "paragraphs": paragraphs,
            "entities": entities,
            "topicBreaks": [{"byteStart": tb["byteStart"]} for tb in topic_breaks],
        }

        out_path = output_dir / f"stream-{slug}.json"
        out_path.write_text(json.dumps(result, indent=2))
        print(f"  Done: {slug}", flush=True)

    print("All streams processed.")


if __name__ == "__main__":
    main()
