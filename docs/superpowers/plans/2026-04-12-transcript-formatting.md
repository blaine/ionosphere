# Transcript Formatting Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add NLP-based sentence and paragraph detection to transcripts so they render as structured prose instead of a wall of text.

**Architecture:** A Python NLP pipeline (spaCy) produces sentence/paragraph annotation layers as JSON files. A TypeScript publish step validates and publishes these as layers.pub AT Protocol records. The document assembly step reads annotation layers and emits structural facets (`#sentence`, `#paragraph`) that the React renderer consumes as inline spans and block elements. The old `tv.ionosphere.annotation` system is removed entirely.

**Tech Stack:** Python 3.12+, spaCy (`en_core_web_sm`), vitest, layers.pub lexicons, panproto, React/Next.js

**Spec:** `docs/superpowers/specs/2026-04-12-transcript-formatting-design.md`

**Scope note:** This plan implements the rendering pipeline (NLP → facets → renderer) end-to-end. Publishing layers.pub records to the PDS and creating panproto lenses are deferred to a follow-up — the vendored lexicons and spec are forward preparation. The immediate goal is formatted transcripts in the browser.

**UX note:** Removing the old annotation system (Task 13) will temporarily remove concept highlighting from talk pages. Concepts return via NLP in Phase 2. If this is unacceptable, Task 13 can be deferred and the old overlay path kept alongside the new structural facets.

---

## Chunk 1: Vendor layers.pub lexicons and define new facet types

### Task 1: Vendor layers.pub lexicon definitions

**Files:**
- Create: `lexicons/pub/layers/defs.json`
- Create: `lexicons/pub/layers/expression/expression.json`
- Create: `lexicons/pub/layers/segmentation/segmentation.json`
- Create: `lexicons/pub/layers/annotation/annotationLayer.json`

- [ ] **Step 1: Create the `pub.layers.defs` shared definitions lexicon**

Vendor the subset of `pub.layers.defs` that we use: `span`, `temporalSpan`, `uuid`, `tokenRef`, `anchor`, `annotationMetadata`, `featureMap`, `feature`. Pull the field definitions from https://docs.layers.pub/lexicons/defs. These are the shared types referenced by the other lexicons.

- [ ] **Step 2: Create the `pub.layers.expression.expression` lexicon**

Vendor the expression record schema from https://docs.layers.pub/lexicons/expression. Required fields: `id`, `kindUri`, `kind`, `text`, `language`, `createdAt`. Optional: `sourceRef`, `parentRef`, `anchor`, `metadata`, `features`.

- [ ] **Step 3: Create the `pub.layers.segmentation.segmentation` lexicon**

Vendor the segmentation record schema from https://docs.layers.pub/lexicons/segmentation. This includes the `segmentation` record and the `tokenization` and `token` object defs.

- [ ] **Step 4: Create the `pub.layers.annotation.annotationLayer` lexicon**

Vendor the annotation layer record schema from https://docs.layers.pub/lexicons/annotation. This includes `annotationLayer` record and the `annotation` object def.

- [ ] **Step 5: Commit**

```bash
git add lexicons/pub/
git commit -m "feat: vendor layers.pub lexicons for transcript enrichment"
```

### Task 2: Add sentence and paragraph facet types to the format lexicon

**Files:**
- Modify: `formats/tv.ionosphere/ionosphere.lexicon.json`

- [ ] **Step 1: Add `#sentence` (inline) and `#paragraph` (block) facet entries**

Add to the `features` array in `formats/tv.ionosphere/ionosphere.lexicon.json`:

```json
{
  "typeId": "tv.ionosphere.facet#sentence",
  "featureClass": "inline",
  "expandStart": false,
  "expandEnd": false
},
{
  "typeId": "tv.ionosphere.facet#paragraph",
  "featureClass": "block",
  "expandStart": false,
  "expandEnd": false
}
```

- [ ] **Step 2: Commit**

```bash
git add formats/tv.ionosphere/ionosphere.lexicon.json
git commit -m "feat: add sentence (inline) and paragraph (block) facet types"
```

---

## Chunk 2: Python NLP pipeline

### Task 3: Set up the Python enrichment project

**Files:**
- Create: `pipeline/pyproject.toml`
- Create: `pipeline/nlp/__init__.py`

- [ ] **Step 1: Create `pipeline/pyproject.toml`**

```toml
[project]
name = "ionosphere-nlp"
version = "0.1.0"
description = "NLP enrichment pipeline for ionosphere transcripts"
requires-python = ">=3.12"
dependencies = [
    "spacy>=3.7",
]

[project.optional-dependencies]
dev = ["pytest>=8.0"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

- [ ] **Step 2: Create the package init**

Create `pipeline/nlp/__init__.py` (empty file).

- [ ] **Step 3: Create `pipeline/tests/__init__.py`**

Empty file (needed for pytest discovery).

- [ ] **Step 4: Add `.gitignore` entries for Python artifacts**

Add to the repo root `.gitignore`:
```
pipeline/.venv/
pipeline/data/
__pycache__/
*.pyc
```

- [ ] **Step 5: Install dependencies**

```bash
cd pipeline
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
python -m spacy download en_core_web_sm
```

- [ ] **Step 6: Commit**

```bash
git add pipeline/pyproject.toml pipeline/nlp/__init__.py pipeline/tests/__init__.py .gitignore
git commit -m "feat: scaffold Python NLP pipeline project"
```

### Task 4: Implement sentence boundary detection (Pass 1)

**Files:**
- Create: `pipeline/tests/test_sentences.py`
- Create: `pipeline/nlp/sentences.py`

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_sentences.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/test_sentences.py -v
```
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement `detect_sentences`**

Create `pipeline/nlp/sentences.py`:

```python
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
    text_bytes = text.encode("utf-8")
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/test_sentences.py -v
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/nlp/sentences.py pipeline/tests/test_sentences.py
git commit -m "feat: sentence boundary detection via spaCy"
```

### Task 5: Implement paragraph segmentation (Pass 2)

**Files:**
- Create: `pipeline/tests/test_paragraphs.py`
- Create: `pipeline/nlp/paragraphs.py`

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_paragraphs.py`:

```python
from nlp.paragraphs import detect_paragraphs


def test_basic_paragraphs():
    text = "Hello world. This is sentence two. After a long pause here. New topic starts."
    sentences = [
        {"byteStart": 0, "byteEnd": 12},
        {"byteStart": 13, "byteEnd": 34},
        {"byteStart": 35, "byteEnd": 59},
        {"byteStart": 60, "byteEnd": 77},
    ]
    # Words: "Hello"=0, "world."=1, "This"=2, "is"=3, "sentence"=4, "two."=5,
    #        "After"=6, "a"=7, "long"=8, "pause"=9, "here."=10,
    #        "New"=11, "topic"=12, "starts."=13
    # Big pause gap (3000ms) between word index 5 and 6 (between sentence 2 and 3)
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/test_paragraphs.py -v
```
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement `detect_paragraphs`**

Create `pipeline/nlp/paragraphs.py`:

```python
"""Pass 2: Paragraph segmentation using pause duration + sentence boundaries."""


def detect_paragraphs(
    text: str,
    timings: list[int],
    start_ms: int,
    sentences: list[dict],
    pause_threshold_ms: int = 2000,
    proximity_words: int = 5,
) -> list[dict]:
    """Detect paragraph boundaries from timing gaps and sentence boundaries.

    Returns a list of paragraph dicts with byteStart and byteEnd.
    """
    if not text.strip() or not sentences:
        return []

    text_bytes = text.encode("utf-8")

    # Find word indices where long pauses occur
    pause_word_indices: list[int] = []
    word_index = 0
    for value in timings:
        if value < 0:
            if abs(value) >= pause_threshold_ms:
                pause_word_indices.append(word_index)
        else:
            word_index += 1

    if not pause_word_indices:
        # No long pauses — entire text is one paragraph
        return [{"byteStart": sentences[0]["byteStart"],
                 "byteEnd": sentences[-1]["byteEnd"]}]

    # Build a char→byte offset map once, then compute word byte starts
    text_bytes = text.encode("utf-8")
    char_to_byte = []
    byte_pos = 0
    for ch in text:
        char_to_byte.append(byte_pos)
        byte_pos += len(ch.encode("utf-8"))
    char_to_byte.append(byte_pos)  # sentinel for end of text

    # Find word start char offsets using split positions
    words = text.split()
    word_byte_starts: list[int] = []
    char_offset = 0
    for w in words:
        idx = text.index(w, char_offset)
        word_byte_starts.append(char_to_byte[idx])
        char_offset = idx + len(w)

    def word_index_for_byte(byte_pos: int) -> int:
        """Find the word index closest to a byte position."""
        best = 0
        for i, wb in enumerate(word_byte_starts):
            if wb <= byte_pos:
                best = i
        return best

    # Find sentence boundaries (byte positions where one sentence ends
    # and the next begins)
    sentence_break_byte_positions: list[int] = []
    sentence_break_word_indices: list[int] = []
    for i in range(1, len(sentences)):
        bp = sentences[i]["byteStart"]
        sentence_break_byte_positions.append(bp)
        sentence_break_word_indices.append(word_index_for_byte(bp))

    # For each long pause, find the nearest sentence boundary
    paragraph_break_bytes: set[int] = set()
    for pause_wi in pause_word_indices:
        best_dist = float("inf")
        best_bp = None
        for sb_wi, sb_bp in zip(
            sentence_break_word_indices, sentence_break_byte_positions
        ):
            dist = abs(sb_wi - pause_wi)
            if dist <= proximity_words and dist < best_dist:
                best_dist = dist
                best_bp = sb_bp
        if best_bp is not None:
            paragraph_break_bytes.add(best_bp)

    # Build paragraph spans from the break points
    sorted_breaks = sorted(paragraph_break_bytes)
    paragraphs: list[dict] = []
    current_start = sentences[0]["byteStart"]

    for brk in sorted_breaks:
        # Find the sentence that ends just before this break
        para_end = brk
        for s in sentences:
            if s["byteEnd"] <= brk:
                para_end = s["byteEnd"]
        paragraphs.append({"byteStart": current_start, "byteEnd": para_end})
        current_start = brk

    # Final paragraph
    paragraphs.append({
        "byteStart": current_start,
        "byteEnd": sentences[-1]["byteEnd"],
    })

    return paragraphs
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/test_paragraphs.py -v
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/nlp/paragraphs.py pipeline/tests/test_paragraphs.py
git commit -m "feat: paragraph segmentation from pause data + sentence boundaries"
```

### Task 6: Pipeline orchestrator — process all transcripts

**Files:**
- Create: `pipeline/nlp/run.py`
- Create: `pipeline/tests/test_run.py`

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_run.py`:

```python
import json
import os
from pathlib import Path
from nlp.run import process_transcript


def test_process_transcript_produces_output(tmp_path):
    """Integration test: full pipeline on a simple transcript."""
    transcript = {
        "text": "Hello world. This is a test. After a long pause. New topic here.",
        "startMs": 0,
        "timings": [100, 100, 100, 100, 100, 100, -3000, 100, 100, 100, 100, 100, 100, 100],
    }

    result = process_transcript(transcript, talk_rkey="test-talk")

    # Should have sentences and paragraphs
    assert "sentences" in result
    assert "paragraphs" in result
    assert len(result["sentences"]) >= 2
    assert len(result["paragraphs"]) >= 1
    # Each sentence has byte ranges
    for s in result["sentences"]:
        assert "byteStart" in s
        assert "byteEnd" in s
    # Metadata present
    assert "metadata" in result
    assert result["metadata"]["tool"] == "spacy/en_core_web_sm"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/test_run.py -v
```

- [ ] **Step 3: Implement the orchestrator**

Create `pipeline/nlp/run.py`:

```python
"""Pipeline orchestrator: run all NLP passes on a transcript."""

import json
import sys
from pathlib import Path
from nlp.sentences import detect_sentences
from nlp.paragraphs import detect_paragraphs


def process_transcript(
    transcript: dict,
    talk_rkey: str,
    pause_threshold_ms: int = 2000,
    proximity_words: int = 5,
) -> dict:
    """Run all NLP passes on a single transcript.

    Args:
        transcript: dict with text, startMs, timings
        talk_rkey: the talk's record key (for output naming)

    Returns:
        dict with sentences, paragraphs, and metadata
    """
    text = transcript["text"]
    timings = transcript["timings"]
    start_ms = transcript["startMs"]

    # Pass 1: Sentence detection
    sentences = detect_sentences(text)

    # Pass 2: Paragraph segmentation
    paragraphs = detect_paragraphs(
        text=text,
        timings=timings,
        start_ms=start_ms,
        sentences=sentences,
        pause_threshold_ms=pause_threshold_ms,
        proximity_words=proximity_words,
    )

    return {
        "talkRkey": talk_rkey,
        "sentences": sentences,
        "paragraphs": paragraphs,
        "metadata": {
            "tool": "spacy/en_core_web_sm",
            "pauseThresholdMs": pause_threshold_ms,
            "proximityWords": proximity_words,
        },
    }


def main():
    """CLI: read transcripts from appview data/transcripts/, write results to pipeline/data/nlp/."""
    # Match the path used by publish.ts: apps/ionosphere-appview/data/transcripts/
    transcripts_dir = Path(__file__).resolve().parent.parent.parent / "apps" / "ionosphere-appview" / "data" / "transcripts"
    output_dir = Path(__file__).resolve().parent.parent / "data" / "nlp"
    output_dir.mkdir(parents=True, exist_ok=True)

    if not transcripts_dir.exists():
        print(f"Transcripts directory not found: {transcripts_dir}")
        sys.exit(1)

    transcript_files = sorted(transcripts_dir.glob("*.json"))
    print(f"Processing {len(transcript_files)} transcripts...")

    for tf in transcript_files:
        talk_rkey = tf.stem
        transcript = json.loads(tf.read_text())

        # The cached transcript files contain TranscriptResult format
        # (text + words array). We need to encode to compact format first.
        # But the pipeline needs text + timings. Let's derive timings from words.
        if "words" in transcript and "timings" not in transcript:
            from nlp.encoding import words_to_compact
            compact = words_to_compact(transcript)
        else:
            compact = transcript

        result = process_transcript(compact, talk_rkey=talk_rkey)

        out_path = output_dir / f"{talk_rkey}.json"
        out_path.write_text(json.dumps(result, indent=2))
        print(f"  {talk_rkey}: {len(result['sentences'])} sentences, {len(result['paragraphs'])} paragraphs")

    print("Done.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Create `pipeline/nlp/encoding.py` — helper to convert word-level transcripts to compact format**

```python
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/ -v
```
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add pipeline/nlp/run.py pipeline/nlp/encoding.py pipeline/tests/test_run.py
git commit -m "feat: NLP pipeline orchestrator with CLI entry point"
```

---

## Chunk 3: TypeScript — update `extractData` for hierarchical structure

### Task 7: Add `ParagraphSpan` and `SentenceSpan` types and update `extractData`

**Files:**
- Modify: `apps/ionosphere/src/lib/transcript.ts`
- Modify: `apps/ionosphere/src/lib/transcript.test.ts`

- [ ] **Step 1: Write failing tests for hierarchical extraction**

Add to `apps/ionosphere/src/lib/transcript.test.ts`:

```typescript
describe("extractData — hierarchical structure", () => {
  it("groups words into sentences and paragraphs when facets present", () => {
    const doc = makeDoc([
      { text: "Hello", startNs: 1000, endNs: 2000 },
      { text: "world.", startNs: 2000, endNs: 3000 },
      { text: "New", startNs: 4000, endNs: 5000 },
      { text: "sentence.", startNs: 5000, endNs: 6000 },
    ]);
    const encoder = new TextEncoder();
    const text = "Hello world. New sentence.";
    // Add sentence facets
    doc.facets.push({
      index: {
        byteStart: 0,
        byteEnd: encoder.encode("Hello world.").length,
      },
      features: [{ $type: "tv.ionosphere.facet#sentence" }],
    });
    doc.facets.push({
      index: {
        byteStart: encoder.encode("Hello world. ").length,
        byteEnd: encoder.encode(text).length,
      },
      features: [{ $type: "tv.ionosphere.facet#sentence" }],
    });
    // Add paragraph facet (one paragraph covering everything)
    doc.facets.push({
      index: { byteStart: 0, byteEnd: encoder.encode(text).length },
      features: [{ $type: "tv.ionosphere.facet#paragraph" }],
    });

    const result = extractData(doc);
    expect(result.paragraphs).toHaveLength(1);
    expect(result.paragraphs[0].sentences).toHaveLength(2);
    expect(result.paragraphs[0].sentences[0].words).toHaveLength(2);
    expect(result.paragraphs[0].sentences[1].words).toHaveLength(2);
  });

  it("gracefully degrades to singleton paragraph/sentence when no structural facets", () => {
    const doc = makeDoc([
      { text: "Hello", startNs: 1000, endNs: 2000 },
      { text: "world", startNs: 2000, endNs: 3000 },
    ]);

    const result = extractData(doc);
    // Should still have paragraphs/sentences structure
    expect(result.paragraphs).toHaveLength(1);
    expect(result.paragraphs[0].sentences).toHaveLength(1);
    expect(result.paragraphs[0].sentences[0].words).toHaveLength(2);
    // Legacy flat access still works
    expect(result.words).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/ionosphere && npx vitest run src/lib/transcript.test.ts
```
Expected: FAIL — `paragraphs` property does not exist

- [ ] **Step 3: Add types and update `extractData`**

Add these types to `apps/ionosphere/src/lib/transcript.ts`:

```typescript
export interface SentenceSpan {
  byteStart: number;
  byteEnd: number;
  words: WordSpan[];
}

export interface ParagraphSpan {
  byteStart: number;
  byteEnd: number;
  sentences: SentenceSpan[];
}
```

Update `extractData` to return `paragraphs: ParagraphSpan[]` alongside the existing flat `words` array. The function extracts `#sentence` and `#paragraph` facets, groups words into sentences by byte range overlap, groups sentences into paragraphs, and falls back to singleton wrappers when structural facets are absent.

Key logic:
1. Extract words and concepts as before (existing code unchanged).
2. Extract sentence facets (byteStart/byteEnd from `#sentence` features). Sort by byteStart.
3. Extract paragraph facets (byteStart/byteEnd from `#paragraph` features). Sort by byteStart.
4. If no sentence facets: wrap all words in one sentence. If no paragraph facets: wrap all sentences in one paragraph.
5. Assign each word to its sentence (word.byteStart >= sentence.byteStart && word.byteEnd <= sentence.byteEnd).
6. Assign each sentence to its paragraph (sentence.byteStart >= paragraph.byteStart && sentence.byteEnd <= paragraph.byteEnd).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/ionosphere && npx vitest run src/lib/transcript.test.ts
```
Expected: all PASS (both new and existing tests)

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere/src/lib/transcript.ts apps/ionosphere/src/lib/transcript.test.ts
git commit -m "feat: hierarchical extractData with paragraph/sentence grouping"
```

---

## Chunk 4: Update the renderer

### Task 8: Update `TranscriptView` to render paragraphs and sentences

**Files:**
- Modify: `apps/ionosphere/src/app/components/TranscriptView.tsx`

- [ ] **Step 1: Update the render tree**

Replace the flat `words.map(...)` rendering with a nested structure:

```tsx
{paragraphs.map((para, pi) => (
  <div key={pi} className="mb-4">
    {para.sentences.map((sent, si) => (
      <span key={si} className="sentence">
        {sent.words.map((word, wi) => {
          const globalIdx = /* compute global word index */;
          return (
            <WordSpanComponent
              key={globalIdx}
              ref={(el) => setWordRef(globalIdx, el)}
              word={word}
              concept={wordConcepts[globalIdx]?.[0] || null}
              currentTimeNs={currentTimeNs}
              onSeek={handleSeek}
              hasComment={wordHasComment.has(globalIdx)}
            />
          );
        })}
      </span>
    ))}
  </div>
))}
```

The `useMemo` call to `extractData` now destructures `paragraphs` alongside `words` and `wordConcepts`. The global word index is computed by maintaining a running counter across paragraphs and sentences.

The comment system, reaction groups, text selection, and scroll/time mappings continue to use the flat `words` array (unchanged). Only the DOM structure changes to add the paragraph/sentence grouping.

- [ ] **Step 2: Verify in browser**

Start the dev server and load a talk page. Verify:
- Transcripts without structural facets render identically to before (graceful degradation)
- No console errors
- Scroll-to-time and click-to-seek still work
- Comments and reactions still work

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere/src/app/components/TranscriptView.tsx
git commit -m "feat: render transcripts with paragraph/sentence DOM structure"
```

### Task 9: Update `WindowedTranscriptView` for paragraph gaps

**Files:**
- Modify: `apps/ionosphere/src/app/components/WindowedTranscriptView.tsx`

- [ ] **Step 1: Update `computeMonospaceLayout` to accept paragraph breaks**

Add a `paragraphStartIndices: Set<number>` parameter. When a word is a paragraph start (its global index is in the set), insert a gap of `LINE_HEIGHT` pixels before that line entry. Add `isParagraphStart: boolean` to `LineEntry`.

- [ ] **Step 2: Update the rendering to add paragraph gap spacers**

For each visible line with `isParagraphStart: true`, render a gap spacer `div` above it.

- [ ] **Step 3: Update `timeToScrollY` and `scrollYToTime`**

Gap entries have no time range. Scrolling through a gap seeks to the end of the preceding line's time range (treating the gap as an extension of the previous paragraph's final time).

- [ ] **Step 4: Verify in browser**

Load the track view (which uses `WindowedTranscriptView`). Verify paragraph gaps appear and scroll behavior is smooth.

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere/src/app/components/WindowedTranscriptView.tsx
git commit -m "feat: WindowedTranscriptView paragraph gap support"
```

---

## Chunk 5: Document assembly and publish pipeline

### Task 10: Update document assembly to include structural facets

**Files:**
- Modify: `formats/tv.ionosphere/ts/transcript-encoding.ts`
- Modify: `formats/tv.ionosphere/ts/transcript-encoding.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `formats/tv.ionosphere/ts/transcript-encoding.test.ts`:

```typescript
describe("decodeToDocumentWithStructure", () => {
  it("adds sentence and paragraph facets from NLP annotations", () => {
    const compact = encode(contiguous);
    const annotations = {
      sentences: [
        { byteStart: 0, byteEnd: 11 },  // "hello world"
        { byteStart: 12, byteEnd: 26 },  // "this is a test"
      ],
      paragraphs: [
        { byteStart: 0, byteEnd: 26 },
      ],
    };
    const doc = decodeToDocumentWithStructure(compact, annotations);

    const sentenceFacets = doc.facets.filter(f =>
      f.features.some(feat => feat.$type === "tv.ionosphere.facet#sentence")
    );
    const paragraphFacets = doc.facets.filter(f =>
      f.features.some(feat => feat.$type === "tv.ionosphere.facet#paragraph")
    );
    expect(sentenceFacets).toHaveLength(2);
    expect(paragraphFacets).toHaveLength(1);
  });

  it("produces valid document without annotations (backward compatible)", () => {
    const compact = encode(contiguous);
    const doc = decodeToDocumentWithStructure(compact, null);
    // Same as decodeToDocument
    expect(doc.facets.length).toBe(6); // just timestamp facets
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd formats/tv.ionosphere && npx vitest run ts/transcript-encoding.test.ts
```

- [ ] **Step 3: Implement `decodeToDocumentWithStructure`**

Add to `formats/tv.ionosphere/ts/transcript-encoding.ts`:

```typescript
export interface NlpAnnotations {
  sentences: Array<{ byteStart: number; byteEnd: number }>;
  paragraphs: Array<{ byteStart: number; byteEnd: number }>;
}

export function decodeToDocumentWithStructure(
  compact: CompactTranscript,
  annotations: NlpAnnotations | null,
): Document {
  // Start with the base document (timestamp facets)
  const doc = decodeToDocument(compact);

  if (!annotations) return doc;

  // Add sentence facets
  for (const s of annotations.sentences) {
    doc.facets.push({
      index: { byteStart: s.byteStart, byteEnd: s.byteEnd },
      features: [{ $type: "tv.ionosphere.facet#sentence" }],
    });
  }

  // Add paragraph facets
  for (const p of annotations.paragraphs) {
    doc.facets.push({
      index: { byteStart: p.byteStart, byteEnd: p.byteEnd },
      features: [{ $type: "tv.ionosphere.facet#paragraph" }],
    });
  }

  return doc;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd formats/tv.ionosphere && npx vitest run ts/transcript-encoding.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add formats/tv.ionosphere/ts/transcript-encoding.ts formats/tv.ionosphere/ts/transcript-encoding.test.ts
git commit -m "feat: decodeToDocumentWithStructure for NLP annotations"
```

### Task 11: Update publish.ts to include assembled documents on talk records

**Files:**
- Modify: `apps/ionosphere-appview/src/publish.ts`

- [ ] **Step 1: Update the talk publishing step**

After publishing transcripts (step 4 in publish.ts), add a step that:
1. For each talk, checks if NLP output exists at `pipeline/data/nlp/{rkey}.json`
2. If it does, reads the NLP annotations
3. Calls `decodeToDocumentWithStructure` with the compact transcript + annotations
4. Includes the assembled `document` field on the `tv.ionosphere.talk` record

This moves document assembly from serve time to publish time, as specified in the design.

- [ ] **Step 2: Verify by running publish in dry-run or against local PDS**

Check that talk records now include the `document` field with sentence/paragraph facets.

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/publish.ts
git commit -m "feat: publish assembled documents with structural facets on talk records"
```

### Task 12: Update appview routes to serve pre-assembled documents

**Files:**
- Modify: `apps/ionosphere-appview/src/routes.ts`

- [ ] **Step 1: Remove `overlayAnnotations` and serve pre-assembled document**

In the `getTalk` route handler:
1. Remove the `overlayAnnotations` function entirely (lines 17-59).
2. Remove the annotation overlay logic in the route (lines 173-185).
3. If the talk record has a `document` field in the DB, serve it directly.
4. Fall back to `decodeToDocument` from the compact transcript if no pre-assembled document exists (backward compatibility during transition).

- [ ] **Step 2: Update the indexer to store the document field**

In `apps/ionosphere-appview/src/indexer.ts`, update the `indexTalk` function's INSERT statement (line 176-197). The `talks` table already has a `document TEXT` column (line 54 of db.ts), but the INSERT does not include it. Add `document` to the column list and bind `record.document ? JSON.stringify(record.document) : null` as the value. This is a SQL change — the column list and VALUES placeholders must both be updated.

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/routes.ts apps/ionosphere-appview/src/indexer.ts
git commit -m "feat: serve pre-assembled documents, remove overlayAnnotations"
```

---

## Chunk 6: Remove old enrichment system

### Task 13: Remove old annotation/enrichment code

**Files:**
- Delete: `apps/ionosphere-appview/src/enrich.ts`
- Delete: `apps/ionosphere-appview/src/enrich-all.ts`
- Delete: `apps/ionosphere-appview/src/publish-annotations.ts`
- Modify: `apps/ionosphere-appview/src/indexer.ts` — remove `tv.ionosphere.annotation` handling
- Modify: `apps/ionosphere-appview/src/routes.ts` — remove annotation-related queries from `getTalk`

- [ ] **Step 1: Delete enrichment files**

```bash
rm apps/ionosphere-appview/src/enrich.ts
rm apps/ionosphere-appview/src/enrich-all.ts
rm apps/ionosphere-appview/src/publish-annotations.ts
```

- [ ] **Step 2: Remove annotation indexing from `indexer.ts`**

Remove `"tv.ionosphere.annotation"` from `IONOSPHERE_COLLECTIONS` array (line 28). Remove the annotation delete case (lines 72-75). Remove the annotation create/update case (lines 116-117). Remove the `indexAnnotation` function and `rebuildTalkConcepts` helper.

- [ ] **Step 3: Remove annotation queries from `routes.ts`**

In the `getTalk` route, remove the concepts query (lines 149-157) and the annotation overlay logic. The concepts data will return via layers.pub in Phase 2.

- [ ] **Step 4: Remove annotation publishing from `publish.ts`**

Remove step 6 (lines 158-177) that publishes `tv.ionosphere.annotation` records.

- [ ] **Step 5: Verify the appview still starts and serves talks**

```bash
cd apps/ionosphere-appview && npx tsx src/appview.ts
```
Hit the `/xrpc/tv.ionosphere.getTalk?rkey=<some-rkey>` endpoint and verify it returns a talk with a document.

- [ ] **Step 6: Commit**

```bash
git add -A apps/ionosphere-appview/src/
git commit -m "chore: remove old enrichment system (enrich.ts, annotations, overlayAnnotations)"
```

---

## Chunk 7: End-to-end integration and verification

**IMPORTANT:** Tasks 11-12 create the publish-time document assembly path, but existing talks in the appview DB will have NULL documents until a full re-publish is done. Task 14 performs this re-publish. Do NOT deploy Tasks 11-12 without running Task 14, or existing talks will lose concept overlays with no replacement.

### Task 14: Run the full pipeline end-to-end

- [ ] **Step 1: Run the Python NLP pipeline on all transcripts**

```bash
cd pipeline && source .venv/bin/activate && python -m nlp.run
```

Verify output files appear in `pipeline/data/nlp/` with sentence and paragraph data.

- [ ] **Step 2: Spot-check 3-5 NLP output files**

Open output JSON files for talks of different types (presentation, panel, lightning talk). Verify:
- Sentence count is reasonable (expect 50-300 for a 20-min talk)
- Paragraph count is reasonable (expect 5-30)
- Byte ranges are valid (byteStart < byteEnd, monotonically increasing)
- Paragraph boundaries fall at sentence boundaries

- [ ] **Step 3: Run the TypeScript publish pipeline**

```bash
cd apps/ionosphere-appview && npx tsx src/publish.ts
```

Verify talk records now include the `document` field with structural facets.

- [ ] **Step 4: Start the appview and frontend, verify in browser**

Start the dev environment and load several talk pages. Verify:
- Paragraphs have visible vertical spacing
- Sentences are grouped as inline spans
- Scroll-to-time and click-to-seek work correctly
- The playhead brightness gradient is smooth across paragraph breaks
- Comments and reactions still work
- Talks without NLP data still render correctly (graceful degradation)

- [ ] **Step 5: Commit any fixes found during verification**

```bash
git add -A && git commit -m "fix: integration fixes from end-to-end verification"
```

### Task 15: Final cleanup

- [ ] **Step 1: Run all tests**

```bash
# Python
cd pipeline && source .venv/bin/activate && pytest -v

# TypeScript
cd ../.. && npx vitest run
```

All tests should pass.

- [ ] **Step 2: Update `.gitignore` for Python artifacts**

Add to `.gitignore`:
```
pipeline/.venv/
pipeline/data/
__pycache__/
*.pyc
```

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: final cleanup — tests passing, gitignore updated"
```
