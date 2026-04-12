from nlp.sentences import detect_sentences


def test_basic_sentences():
    text = "Hello world. This is a test. And another sentence."
    sentences = detect_sentences(text)
    assert len(sentences) == 3
    # Each sentence is a dict with byteStart and byteEnd
    assert sentences[0]["byteStart"] == 0
    assert sentences[0]["byteEnd"] == len("Hello world.".encode("utf-8"))
    assert sentences[1]["byteStart"] == len("Hello world. ".encode("utf-8"))


def test_speech_without_punctuation():
    """spaCy should detect sentence boundaries even with poor punctuation."""
    text = "so the thing is we need to think about this carefully and then we can move on to the next topic which is about protocols"
    sentences = detect_sentences(text)
    # spaCy should find at least 1 sentence (the whole text if no clear boundary)
    assert len(sentences) >= 1
    # All sentences should cover the full text
    assert sentences[0]["byteStart"] == 0
    assert sentences[-1]["byteEnd"] == len(text.encode("utf-8"))


def test_empty_text():
    sentences = detect_sentences("")
    assert sentences == []


def test_byte_offsets_for_unicode():
    text = "Caf\u00e9 is great. Let\u2019s go."
    sentences = detect_sentences(text)
    # Byte offsets must account for multi-byte characters
    full_bytes = text.encode("utf-8")
    assert sentences[-1]["byteEnd"] == len(full_bytes)
