from nlp.topics import detect_topic_breaks


def test_detects_topic_change():
    """Distinct topics should produce at least one break."""
    sentences = [
        {"byteStart": 0, "byteEnd": 30, "text": "Today we will make a cake."},
        {"byteStart": 31, "byteEnd": 65, "text": "First mix the flour and sugar."},
        {"byteStart": 66, "byteEnd": 100, "text": "Then add the eggs and butter."},
        {"byteStart": 101, "byteEnd": 135, "text": "Bake at 350 degrees for 30 minutes."},
        {"byteStart": 136, "byteEnd": 170, "text": "Let it cool before adding frosting."},
        {"byteStart": 171, "byteEnd": 210, "text": "NASA launched a new rocket to Mars."},
        {"byteStart": 211, "byteEnd": 250, "text": "The spacecraft will orbit the red planet."},
        {"byteStart": 251, "byteEnd": 295, "text": "Astronauts may visit Mars within ten years."},
        {"byteStart": 296, "byteEnd": 340, "text": "The mission costs billions of dollars."},
        {"byteStart": 341, "byteEnd": 380, "text": "Space exploration advances human knowledge."},
    ]
    breaks = detect_topic_breaks(sentences)
    assert len(breaks) >= 1
    assert any(4 <= b["sentenceIndex"] <= 6 for b in breaks)


def test_no_breaks_for_single_topic():
    sentences = [
        {"byteStart": 0, "byteEnd": 30, "text": "The cat sat on the mat."},
        {"byteStart": 31, "byteEnd": 60, "text": "The cat was very happy."},
        {"byteStart": 61, "byteEnd": 90, "text": "It purred loudly all day."},
    ]
    breaks = detect_topic_breaks(sentences, min_segment_sentences=2)
    assert len(breaks) <= 1


def test_empty_input():
    assert detect_topic_breaks([]) == []


def test_too_few_sentences():
    sentences = [{"byteStart": 0, "byteEnd": 10, "text": "Hello."}]
    assert detect_topic_breaks(sentences) == []
