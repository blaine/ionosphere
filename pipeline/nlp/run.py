"""Pipeline orchestrator: run all NLP passes on a transcript."""

import json
import sys
from pathlib import Path
from nlp.sentences import detect_sentences
from nlp.paragraphs import detect_paragraphs


def process_transcript(
    transcript: dict,
    talk_rkey: str,
    pause_threshold_ms: int = 2000,
    proximity_words: int = 5,
) -> dict:
    """Run all NLP passes on a single transcript.

    Args:
        transcript: dict with text, startMs, timings
        talk_rkey: the talk's record key (for output naming)

    Returns:
        dict with sentences, paragraphs, and metadata
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

    return {
        "talkRkey": talk_rkey,
        "sentences": sentences,
        "paragraphs": paragraphs,
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

        result = process_transcript(compact, talk_rkey=talk_rkey)

        out_path = output_dir / f"{talk_rkey}.json"
        out_path.write_text(json.dumps(result, indent=2))
        print(f"  {talk_rkey}: {len(result['sentences'])} sentences, {len(result['paragraphs'])} paragraphs")

    print("Done.")


if __name__ == "__main__":
    main()
