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


def test_process_transcript_with_enrichment():
    """Full pipeline with entity and topic passes."""
    transcript = {
        "text": "Matt Akamatsu is presenting. The AT Protocol is decentralized. Now we discuss a completely different topic about cooking recipes and baking cakes with flour and sugar and eggs.",
        "startMs": 0,
        "timings": [100, 100, 100, 100, 100, 100, 100, 100, 100, -3000, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
    }
    speaker_rows = [("Matt Akamatsu", "matsulab.com", "did:plc:matt123")]
    concept_rows = [{"name": "AT Protocol", "uri": "at://did/concept/atp", "aliases": "[]"}]

    result = process_transcript(
        transcript, talk_rkey="test",
        speaker_rows=speaker_rows,
        concept_rows=concept_rows,
    )

    assert "entities" in result
    assert "topicBreaks" in result
    assert len(result["entities"]) >= 1
    # At least one resolved entity
    resolved = [e for e in result["entities"] if e.get("speakerDid") or e.get("conceptUri")]
    assert len(resolved) >= 1
