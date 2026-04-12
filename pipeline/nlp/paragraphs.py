"""Pass 2: Paragraph segmentation from pause data and sentence boundaries."""


def detect_paragraphs(
    text: str,
    timings: list[int],
    start_ms: int,
    sentences: list[dict],
    pause_threshold_ms: int = 2000,
    proximity_words: int = 5,
) -> list[dict]:
    """Detect paragraph boundaries using pause duration and sentence structure.

    Paragraph breaks are only inserted at sentence boundaries — never mid-sentence.
    A long pause (>= pause_threshold_ms) triggers a break only when a sentence
    boundary falls within proximity_words of the pause location.

    Args:
        text: The full transcript text.
        timings: Mixed-sign list where positive values are word durations (ms)
                 and negative values are silence gaps (absolute value in ms)
                 before the next word.
        start_ms: Absolute time offset of the first word (ms).
        sentences: List of sentence dicts with byteStart and byteEnd keys.
        pause_threshold_ms: Minimum silence duration to consider a paragraph break.
        proximity_words: Max word-index distance from pause to nearest sentence boundary.

    Returns:
        List of paragraph dicts with byteStart and byteEnd (UTF-8 byte offsets).
    """
    if not text or not sentences:
        return []

    # Build a char→byte offset map once (O(n))
    char_to_byte = []
    byte_pos = 0
    for ch in text:
        char_to_byte.append(byte_pos)
        byte_pos += len(ch.encode("utf-8"))
    char_to_byte.append(byte_pos)  # sentinel for end-of-string

    # Find word start char offsets (preserving order of words in text)
    words = text.split()
    word_byte_starts = []
    char_offset = 0
    for w in words:
        idx = text.index(w, char_offset)
        word_byte_starts.append(char_to_byte[idx])
        char_offset = idx + len(w)

    # Map each sentence boundary (byteStart) to its approximate word index.
    # We find the word whose byte start is closest to / at the sentence boundary.
    def sentence_start_word_index(byte_start: int) -> int:
        """Return the word index whose byte start is nearest to byte_start."""
        best_idx = 0
        best_dist = abs(word_byte_starts[0] - byte_start) if word_byte_starts else 0
        for i, wb in enumerate(word_byte_starts):
            dist = abs(wb - byte_start)
            if dist < best_dist:
                best_dist = dist
                best_idx = i
        return best_idx

    # Pre-compute word indices for all sentence boundaries (skip index 0 — that's
    # always the start of the first paragraph, not a potential break).
    sentence_word_indices = []
    for sent in sentences:
        sentence_word_indices.append(sentence_start_word_index(sent["byteStart"]))

    # Walk timings to find word indices where long pauses occur.
    # The word_index before a pause is the last word of the current span.
    # The word after the pause starts the next potential paragraph.
    pause_after_word = []  # word indices AFTER which a long pause occurs
    word_index = -1  # incremented when we encounter a word duration
    for t in timings:
        if t >= 0:
            # Positive value: duration of the next word
            word_index += 1
        else:
            # Negative value: silence gap before the next word
            gap_ms = abs(t)
            if gap_ms >= pause_threshold_ms and word_index >= 0:
                pause_after_word.append(word_index)

    if not pause_after_word:
        # No qualifying pauses — single paragraph spanning everything
        return [{"byteStart": sentences[0]["byteStart"], "byteEnd": sentences[-1]["byteEnd"]}]

    # For each long pause, find the nearest sentence boundary within proximity_words.
    # A sentence boundary is a candidate break point only if it's a sentence START
    # (index > 0, since we never break before the first sentence).
    break_byte_starts: set[int] = set()
    for pause_word in pause_after_word:
        best_sent_idx = None
        best_dist = proximity_words + 1  # exclusive upper bound
        for si, sw in enumerate(sentence_word_indices):
            if si == 0:
                continue  # can't break before the first sentence
            dist = abs(sw - (pause_word + 1))  # distance from word-after-pause to sentence start
            if dist <= proximity_words and dist < best_dist:
                best_dist = dist
                best_sent_idx = si
        if best_sent_idx is not None:
            break_byte_starts.add(sentences[best_sent_idx]["byteStart"])

    if not break_byte_starts:
        # Pauses exist but no sentence boundaries are nearby — single paragraph
        return [{"byteStart": sentences[0]["byteStart"], "byteEnd": sentences[-1]["byteEnd"]}]

    # Build paragraph spans from the collected sentence-boundary break points.
    # Sort sentences and group them into paragraphs.
    sorted_breaks = sorted(break_byte_starts)
    paragraphs = []
    para_start_byte = sentences[0]["byteStart"]

    for sent in sentences[1:]:
        if sent["byteStart"] in sorted_breaks:
            # Close current paragraph just before this sentence
            prev_sent = next(
                s for s in reversed(sentences)
                if s["byteStart"] < sent["byteStart"]
            )
            paragraphs.append({"byteStart": para_start_byte, "byteEnd": prev_sent["byteEnd"]})
            para_start_byte = sent["byteStart"]

    # Close the final paragraph
    paragraphs.append({"byteStart": para_start_byte, "byteEnd": sentences[-1]["byteEnd"]})

    return paragraphs
