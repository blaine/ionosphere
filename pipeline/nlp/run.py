"""Pipeline orchestrator: run all NLP passes on a transcript."""

import json
import sys
from pathlib import Path
from nlp.sentences import detect_sentences
from nlp.paragraphs import detect_paragraphs
from nlp.entities import detect_entities
from nlp.speaker_lookup import build_speaker_lookup
from nlp.topics import detect_topic_breaks


def process_transcript(
    transcript: dict,
    talk_rkey: str,
    pause_threshold_ms: int = 2000,
    proximity_words: int = 5,
    speaker_rows: list[tuple] | None = None,
    concept_rows: list[dict] | None = None,
) -> dict:
    """Run all NLP passes on a single transcript.

    Args:
        transcript: dict with text, startMs, timings
        talk_rkey: the talk's record key (for output naming)
        speaker_rows: optional list of (name, handle, did) tuples for entity linking
        concept_rows: optional list of concept dicts for entity linking

    Returns:
        dict with sentences, paragraphs, entities, topicBreaks, and metadata
    """
    text = transcript["text"]
    timings = transcript["timings"]
    start_ms = transcript["startMs"]

    # Pass 1: Sentence detection
    sentences = detect_sentences(text)

    # Pass 2: Paragraph segmentation
    paragraphs = detect_paragraphs(
        text=text,
        timings=timings,
        start_ms=start_ms,
        sentences=sentences,
        pause_threshold_ms=pause_threshold_ms,
        proximity_words=proximity_words,
    )

    # Pass 3: NER + entity linking
    speaker_lookup = build_speaker_lookup(speaker_rows) if speaker_rows else None
    entities = detect_entities(text, speaker_lookup=speaker_lookup, concept_rows=concept_rows)

    # Pass 4: Topic segmentation
    sentences_with_text = []
    for s in sentences:
        sent_text = text.encode("utf-8")[s["byteStart"]:s["byteEnd"]].decode("utf-8")
        sentences_with_text.append({**s, "text": sent_text})
    topic_breaks = detect_topic_breaks(sentences_with_text)

    return {
        "talkRkey": talk_rkey,
        "sentences": sentences,
        "paragraphs": paragraphs,
        "entities": entities,
        "topicBreaks": [{"byteStart": tb["byteStart"]} for tb in topic_breaks],
        "metadata": {
            "tool": "spacy/en_core_web_sm",
            "pauseThresholdMs": pause_threshold_ms,
            "proximityWords": proximity_words,
        },
    }


def main():
    """CLI: read transcripts from appview data/transcripts/, write results to pipeline/data/nlp/."""
    # Match the path used by publish.ts: apps/ionosphere-appview/data/transcripts/
    transcripts_dir = Path(__file__).resolve().parent.parent.parent / "apps" / "ionosphere-appview" / "data" / "transcripts"
    output_dir = Path(__file__).resolve().parent.parent / "data" / "nlp"
    output_dir.mkdir(parents=True, exist_ok=True)

    if not transcripts_dir.exists():
        print(f"Transcripts directory not found: {transcripts_dir}")
        print("Run from repo root, or ensure appview data/transcripts/ exists.")
        sys.exit(1)

    import sqlite3
    db_path = Path(__file__).resolve().parent.parent.parent / "apps" / "data" / "ionosphere.sqlite"
    speaker_rows = []
    concept_rows = []
    if db_path.exists():
        conn = sqlite3.connect(str(db_path))
        speaker_rows = conn.execute(
            "SELECT name, handle, speaker_did FROM speakers"
        ).fetchall()
        concept_rows = [
            {"name": r[0], "uri": r[1], "aliases": r[2] or "[]"}
            for r in conn.execute("SELECT name, uri, aliases FROM concepts").fetchall()
        ]
        conn.close()
        print(f"Loaded {len(speaker_rows)} speakers, {len(concept_rows)} concepts from DB")
    else:
        print(f"Warning: database not found at {db_path}, entity linking disabled")

    transcript_files = sorted(transcripts_dir.glob("*.json"))
    print(f"Processing {len(transcript_files)} transcripts...")

    for tf in transcript_files:
        talk_rkey = tf.stem
        transcript = json.loads(tf.read_text())

        # The cached transcript files may be in TranscriptResult format
        # (text + words array). Convert to compact format if needed.
        if "words" in transcript and "timings" not in transcript:
            from nlp.encoding import words_to_compact
            compact = words_to_compact(transcript)
        else:
            compact = transcript

        result = process_transcript(
            compact, talk_rkey=talk_rkey,
            speaker_rows=speaker_rows,
            concept_rows=concept_rows,
        )

        out_path = output_dir / f"{talk_rkey}.json"
        out_path.write_text(json.dumps(result, indent=2))
        entity_count = len(result.get("entities", []))
        topic_count = len(result.get("topicBreaks", []))
        print(f"  {talk_rkey}: {len(result['sentences'])} sentences, {len(result['paragraphs'])} paragraphs, {entity_count} entities, {topic_count} topics")

    print("Done.")


if __name__ == "__main__":
    main()
