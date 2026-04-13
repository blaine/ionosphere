"""Pass 1: Sentence boundary detection using spaCy."""

import spacy

_nlp = None


def _get_nlp():
    global _nlp
    if _nlp is None:
        _nlp = spacy.load("en_core_web_sm")
    return _nlp


def detect_sentences(text: str) -> list[dict]:
    """Detect sentence boundaries and return byte-range spans.

    Returns a list of dicts, each with:
        byteStart: int — UTF-8 byte offset of sentence start
        byteEnd: int — UTF-8 byte offset of sentence end (exclusive)
    """
    if not text.strip():
        return []

    nlp = _get_nlp()
    doc = nlp(text)
    sentences = []

    for sent in doc.sents:
        # spaCy gives character offsets; convert to byte offsets
        byte_start = len(text[:sent.start_char].encode("utf-8"))
        byte_end = len(text[:sent.end_char].encode("utf-8"))
        sentences.append({
            "byteStart": byte_start,
            "byteEnd": byte_end,
        })

    return sentences
