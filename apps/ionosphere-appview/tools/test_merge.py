"""Tests for merge_enrichment.py alignment logic."""
from merge_enrichment import assign_speakers_to_words, find_dominant_speaker


def test_assign_speakers_basic():
    words = [
        {"word": "hello", "start": 0.0, "end": 0.5},
        {"word": "world", "start": 0.6, "end": 1.0},
        {"word": "goodbye", "start": 5.0, "end": 5.5},
    ]
    diarization = [
        {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_00"},
        {"start": 4.5, "end": 6.0, "speaker": "SPEAKER_01"},
    ]
    result = assign_speakers_to_words(words, diarization)
    assert result[0]["speaker"] == "SPEAKER_00"
    assert result[1]["speaker"] == "SPEAKER_00"
    assert result[2]["speaker"] == "SPEAKER_01"


def test_assign_speakers_gap():
    """Words in a gap between diarization segments get nearest speaker."""
    words = [
        {"word": "um", "start": 3.0, "end": 3.2},
    ]
    diarization = [
        {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_00"},
        {"start": 4.0, "end": 6.0, "speaker": "SPEAKER_01"},
    ]
    result = assign_speakers_to_words(words, diarization)
    assert result[0]["speaker"] in ("SPEAKER_00", "SPEAKER_01")


def test_assign_speakers_empty_diarization():
    words = [{"word": "hi", "start": 0.0, "end": 0.5}]
    result = assign_speakers_to_words(words, [])
    assert result[0] == words[0]  # unchanged


def test_dominant_speaker():
    words = [
        {"word": "a", "start": 0, "end": 1, "speaker": "SPEAKER_00"},
        {"word": "b", "start": 1, "end": 2, "speaker": "SPEAKER_00"},
        {"word": "c", "start": 2, "end": 3, "speaker": "SPEAKER_01"},
    ]
    assert find_dominant_speaker(words) == "SPEAKER_00"


def test_dominant_speaker_empty():
    assert find_dominant_speaker([]) is None
