import json
from pathlib import Path
from nlp.run import process_transcript


def test_process_transcript_produces_output():
    """Integration test: full pipeline on a simple transcript."""
    transcript = {
        "text": "Hello world. This is a test. After a long pause. New topic here.",
        "startMs": 0,
        "timings": [100, 100, 100, 100, 100, 100, -3000, 100, 100, 100, 100, 100, 100, 100],
    }

    result = process_transcript(transcript, talk_rkey="test-talk")

    # Should have sentences and paragraphs
    assert "sentences" in result
    assert "paragraphs" in result
    assert len(result["sentences"]) >= 2
    assert len(result["paragraphs"]) >= 1
    # Each sentence has byte ranges
    for s in result["sentences"]:
        assert "byteStart" in s
        assert "byteEnd" in s
    # Metadata present
    assert "metadata" in result
    assert result["metadata"]["tool"] == "spacy/en_core_web_sm"
