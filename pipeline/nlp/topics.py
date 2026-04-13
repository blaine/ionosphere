"""Pass 4: Topic segmentation using sentence embeddings."""

import numpy as np

_model = None


def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


def detect_topic_breaks(
    sentences: list[dict],
    window_size: int = 3,
    similarity_threshold: float = 0.3,
    min_segment_sentences: int = 5,
) -> list[dict]:
    """Detect topic boundaries using sentence embedding similarity.

    Args:
        sentences: list of dicts with byteStart, byteEnd, text
        window_size: number of sentences per comparison window
        similarity_threshold: cosine similarity below this = topic break
        min_segment_sentences: minimum sentences between breaks

    Returns:
        list of dicts with byteStart and sentenceIndex
    """
    if len(sentences) < window_size * 2:
        return []

    model = _get_model()
    texts = [s["text"] for s in sentences]
    embeddings = model.encode(texts, show_progress_bar=False)

    similarities = []
    for i in range(window_size, len(sentences) - window_size + 1):
        left = np.mean(embeddings[i - window_size:i], axis=0)
        right = np.mean(embeddings[i:i + window_size], axis=0)
        cos_sim = np.dot(left, right) / (np.linalg.norm(left) * np.linalg.norm(right))
        similarities.append((i, float(cos_sim)))

    breaks = []
    last_break = 0
    for sent_idx, sim in similarities:
        if sim < similarity_threshold and (sent_idx - last_break) >= min_segment_sentences:
            breaks.append({
                "byteStart": sentences[sent_idx]["byteStart"],
                "sentenceIndex": sent_idx,
            })
            last_break = sent_idx

    return breaks
