from nlp.paragraphs import detect_paragraphs


def test_basic_paragraphs():
    text = "Hello world. This is sentence two. After a long pause here. New topic starts."
    sentences = [
        {"byteStart": 0, "byteEnd": 12},
        {"byteStart": 13, "byteEnd": 34},
        {"byteStart": 35, "byteEnd": 59},
        {"byteStart": 60, "byteEnd": 77},
    ]
    # Big pause gap (3000ms) between word 5 ("two.") and word 6 ("After")
    # Words: Hello(0) world.(1) This(2) is(3) sentence(4) two.(5)
    #        After(6) a(7) long(8) pause(9) here.(10) New(11) topic(12) starts.(13)
    timings = [100, 100, 100, 100, 100, 100, -3000, 100, 100, 100, 100, 100, 100, 100]
    start_ms = 0

    paragraphs = detect_paragraphs(
        text=text,
        timings=timings,
        start_ms=start_ms,
        sentences=sentences,
        pause_threshold_ms=2000,
        proximity_words=5,
    )
    # Should detect a paragraph break at the sentence boundary near the 3s pause
    assert len(paragraphs) == 2
    assert paragraphs[0]["byteStart"] == 0
    assert paragraphs[1]["byteStart"] == 35  # "After a long pause..."


def test_no_long_pauses_single_paragraph():
    text = "One sentence. Two sentence."
    sentences = [
        {"byteStart": 0, "byteEnd": 13},
        {"byteStart": 14, "byteEnd": 27},
    ]
    timings = [100, 100, 100, 100]
    paragraphs = detect_paragraphs(
        text=text, timings=timings, start_ms=0,
        sentences=sentences,
    )
    assert len(paragraphs) == 1


def test_empty_input():
    paragraphs = detect_paragraphs(
        text="", timings=[], start_ms=0, sentences=[],
    )
    assert paragraphs == []
