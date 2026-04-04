"""Tests for evaluate.py scoring logic."""
from evaluate import score_boundaries


def test_perfect_score():
    ground_truth = [
        {"rkey": "a", "title": "Talk A", "ground_truth_start": 100, "tolerance_seconds": 30, "verified": True},
        {"rkey": "b", "title": "Talk B", "ground_truth_start": 500, "tolerance_seconds": 30, "verified": True},
    ]
    boundaries = [
        {"rkey": "a", "startTimestamp": 100},
        {"rkey": "b", "startTimestamp": 500},
    ]
    result = score_boundaries(ground_truth, boundaries)
    assert result["accuracy"] == 1.0
    assert result["mean_absolute_error"] == 0.0
    assert all(t["pass"] for t in result["talks"])


def test_one_miss():
    ground_truth = [
        {"rkey": "a", "title": "Talk A", "ground_truth_start": 100, "tolerance_seconds": 30, "verified": True},
        {"rkey": "b", "title": "Talk B", "ground_truth_start": 500, "tolerance_seconds": 30, "verified": True},
    ]
    boundaries = [
        {"rkey": "a", "startTimestamp": 110},
        {"rkey": "b", "startTimestamp": 600},
    ]
    result = score_boundaries(ground_truth, boundaries)
    assert result["accuracy"] == 0.5
    assert result["talks"][0]["pass"] is True
    assert result["talks"][1]["pass"] is False


def test_unverified_skipped():
    ground_truth = [
        {"rkey": "a", "title": "Talk A", "ground_truth_start": 100, "tolerance_seconds": 30, "verified": True},
        {"rkey": "b", "title": "Talk B", "ground_truth_start": 500, "tolerance_seconds": 30, "verified": False},
    ]
    boundaries = [
        {"rkey": "a", "startTimestamp": 100},
        {"rkey": "b", "startTimestamp": 999},
    ]
    result = score_boundaries(ground_truth, boundaries)
    assert result["accuracy"] == 1.0
    assert len([t for t in result["talks"] if t.get("skipped")]) == 1


def test_missing_boundary():
    ground_truth = [
        {"rkey": "a", "title": "Talk A", "ground_truth_start": 100, "tolerance_seconds": 30, "verified": True},
    ]
    boundaries = []
    result = score_boundaries(ground_truth, boundaries)
    assert result["accuracy"] == 0.0
