"""
Evaluate boundary detection results against ground truth.

Usage:
  uv run python evaluate.py <boundaries.json> <ground-truth.json>

Example:
  uv run python evaluate.py ../data/fullday/Great_Hall___Day_1/boundaries-v6.json \
    ../data/ground-truth/great-hall-day-1.json
"""
import argparse
import json
import sys
from pathlib import Path


def fmt(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h}:{m:02d}:{s:02d}"


def score_boundaries(
    ground_truth: list[dict],
    boundaries: list[dict],
) -> dict:
    """Score detected boundaries against ground truth.

    Returns accuracy, mean absolute error, and per-talk breakdown.
    Only verified ground truth entries are scored.
    """
    boundary_map = {b["rkey"]: b for b in boundaries}

    talks = []
    verified_count = 0
    pass_count = 0
    total_error = 0.0

    for gt in ground_truth:
        if not gt.get("verified", True):
            talks.append({
                "rkey": gt["rkey"],
                "title": gt.get("title", ""),
                "skipped": True,
                "reason": "not verified",
            })
            continue

        verified_count += 1
        detected = boundary_map.get(gt["rkey"])

        if detected is None:
            talks.append({
                "rkey": gt["rkey"],
                "title": gt.get("title", ""),
                "pass": False,
                "reason": "not detected",
                "ground_truth": gt["ground_truth_start"],
            })
            continue

        error = abs(detected["startTimestamp"] - gt["ground_truth_start"])
        passed = error <= gt["tolerance_seconds"]
        if passed:
            pass_count += 1
        total_error += error

        talks.append({
            "rkey": gt["rkey"],
            "title": gt.get("title", ""),
            "pass": passed,
            "error_seconds": round(error, 1),
            "ground_truth": gt["ground_truth_start"],
            "detected": detected["startTimestamp"],
            "tolerance": gt["tolerance_seconds"],
            "ground_truth_fmt": fmt(gt["ground_truth_start"]),
            "detected_fmt": fmt(detected["startTimestamp"]),
        })

    accuracy = pass_count / verified_count if verified_count > 0 else 0.0
    mae = total_error / verified_count if verified_count > 0 else 0.0

    return {
        "accuracy": accuracy,
        "mean_absolute_error": round(mae, 1),
        "verified_count": verified_count,
        "pass_count": pass_count,
        "talks": talks,
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate boundaries against ground truth")
    parser.add_argument("boundaries", type=Path)
    parser.add_argument("ground_truth", type=Path)
    args = parser.parse_args()

    boundaries_data = json.loads(args.boundaries.read_text())
    gt_data = json.loads(args.ground_truth.read_text())

    results_list = boundaries_data.get("results", boundaries_data)
    if isinstance(results_list, dict):
        results_list = [results_list]

    result = score_boundaries(gt_data["talks"], results_list)

    print(f"Accuracy: {result['accuracy']:.0%} ({result['pass_count']}/{result['verified_count']})")
    print(f"Mean Absolute Error: {result['mean_absolute_error']}s")
    print()
    print(f"{'Talk':<50} {'GT':>8} {'Det':>8} {'Err':>6} {'Pass':>5}")
    print("-" * 85)
    for t in result["talks"]:
        if t.get("skipped"):
            print(f"{t['title'][:49]:<50} {'SKIPPED':>8}")
            continue
        gt_str = t.get("ground_truth_fmt", "?")
        det_str = t.get("detected_fmt", "?")
        err = t.get("error_seconds", "?")
        passed = "+" if t["pass"] else "X"
        print(f"{t['title'][:49]:<50} {gt_str:>8} {det_str:>8} {str(err):>5}s {passed:>5}")


if __name__ == "__main__":
    main()
