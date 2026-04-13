"""Convert word-level transcript format to compact (text + timings) format."""


def words_to_compact(transcript: dict) -> dict:
    """Convert TranscriptResult {text, words[{word, start, end}]} to compact {text, startMs, timings}."""
    words = transcript.get("words", [])
    if not words:
        return {"text": transcript.get("text", ""), "startMs": 0, "timings": []}

    start_ms = round(words[0]["start"] * 1000)
    timings = []
    cursor = start_ms

    for w in words:
        word_start_ms = round(w["start"] * 1000)
        word_end_ms = round(w["end"] * 1000)
        duration = word_end_ms - word_start_ms

        gap = word_start_ms - cursor
        if gap > 0:
            timings.append(-gap)

        timings.append(max(duration, 1))
        cursor = word_end_ms

    return {
        "text": transcript["text"],
        "startMs": start_ms,
        "timings": timings,
    }
