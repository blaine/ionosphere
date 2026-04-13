# Enrichment Phases 2-3 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named entity recognition with AT Protocol record linking and topic segmentation to the transcript enrichment pipeline, achieving feature parity before deployment.

**Architecture:** Two new Python NLP passes (entity detection + topic segmentation) extend the existing pipeline. Entity resolution matches against speaker/concept records from the SQLite database, with diarization context for disambiguation. Topic boundaries use sentence embeddings with cosine similarity. The TypeScript document assembly and React renderer extend to handle entity links and topic dividers.

**Tech Stack:** Python 3.12+, spaCy NER (`en_core_web_sm`), sentence-transformers (`all-MiniLM-L6-v2`), sqlite3 (stdlib), vitest, React/Next.js

**Spec:** `docs/superpowers/specs/2026-04-12-enrichment-phases-2-3-design.md`

---

## Chunk 1: New facet types + NlpAnnotations extension

### Task 1: Add topic-break and entity facet types to format lexicon

**Files:**
- Modify: `formats/tv.ionosphere/ionosphere.lexicon.json`

- [ ] **Step 1: Add `#topic-break` (block) and `#entity` (inline) to the features array**

```json
{
  "typeId": "tv.ionosphere.facet#topic-break",
  "featureClass": "block",
  "expandStart": false,
  "expandEnd": false
},
{
  "typeId": "tv.ionosphere.facet#entity",
  "featureClass": "inline",
  "expandStart": false,
  "expandEnd": false
}
```

- [ ] **Step 2: Commit**

```bash
git add formats/tv.ionosphere/ionosphere.lexicon.json
git commit -m "feat: add topic-break (block) and entity (inline) facet types"
```

### Task 2: Extend NlpAnnotations and decodeToDocumentWithStructure

**Files:**
- Modify: `formats/tv.ionosphere/ts/transcript-encoding.ts`
- Modify: `formats/tv.ionosphere/ts/transcript-encoding.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `formats/tv.ionosphere/ts/transcript-encoding.test.ts`, in the `decodeToDocumentWithStructure` describe block:

```typescript
it("adds entity, speaker-segment, and topic-break facets", () => {
  const compact = encode(contiguous);
  const annotations = {
    sentences: [{ byteStart: 0, byteEnd: 26 }],
    paragraphs: [{ byteStart: 0, byteEnd: 26 }],
    entities: [
      {
        byteStart: 0, byteEnd: 5, label: "hello", nerType: "PERSON",
        speakerDid: "did:plc:abc123",
      },
      {
        byteStart: 6, byteEnd: 11, label: "world", nerType: "ORG",
        conceptUri: "at://did:plc:xyz/tv.ionosphere.concept/test",
      },
      {
        byteStart: 12, byteEnd: 16, label: "this", nerType: "PRODUCT",
      },
    ],
    speakerSegments: [
      {
        byteStart: 0, byteEnd: 26, speakerDid: "did:plc:abc123",
        speakerName: "Test Speaker",
      },
    ],
    topicBreaks: [{ byteStart: 12 }],
  };
  const doc = decodeToDocumentWithStructure(compact, annotations);

  const speakerRefs = doc.facets.filter(f =>
    f.features.some(feat => feat.$type === "tv.ionosphere.facet#speaker-ref")
  );
  const conceptRefs = doc.facets.filter(f =>
    f.features.some(feat => feat.$type === "tv.ionosphere.facet#concept-ref")
  );
  const entities = doc.facets.filter(f =>
    f.features.some(feat => feat.$type === "tv.ionosphere.facet#entity")
  );
  const speakerSegs = doc.facets.filter(f =>
    f.features.some(feat => feat.$type === "tv.ionosphere.facet#speaker-segment")
  );
  const topicBreaks = doc.facets.filter(f =>
    f.features.some(feat => feat.$type === "tv.ionosphere.facet#topic-break")
  );

  expect(speakerRefs).toHaveLength(1);
  expect(speakerRefs[0].features[0].speakerDid).toBe("did:plc:abc123");
  expect(conceptRefs).toHaveLength(1);
  expect(conceptRefs[0].features[0].conceptUri).toBe("at://did:plc:xyz/tv.ionosphere.concept/test");
  expect(entities).toHaveLength(1); // unresolved entity
  expect(entities[0].features[0].label).toBe("this");
  expect(speakerSegs).toHaveLength(1);
  expect(topicBreaks).toHaveLength(1);
});

it("handles missing optional annotation fields gracefully", () => {
  const compact = encode(contiguous);
  const annotations = {
    sentences: [{ byteStart: 0, byteEnd: 26 }],
    paragraphs: [{ byteStart: 0, byteEnd: 26 }],
    // No entities, speakerSegments, or topicBreaks
  };
  const doc = decodeToDocumentWithStructure(compact, annotations);
  // Should have sentences + paragraphs + timestamps, nothing else
  const tsFacets = doc.facets.filter(f =>
    f.features.some(feat => feat.$type === "tv.ionosphere.facet#timestamp")
  );
  expect(tsFacets).toHaveLength(6);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd formats/tv.ionosphere && npx vitest run ts/transcript-encoding.test.ts
```

- [ ] **Step 3: Extend NlpAnnotations interface and decodeToDocumentWithStructure**

Update `formats/tv.ionosphere/ts/transcript-encoding.ts`:

```typescript
export interface NlpAnnotations {
  sentences: Array<{ byteStart: number; byteEnd: number }>;
  paragraphs: Array<{ byteStart: number; byteEnd: number }>;
  entities?: Array<{
    byteStart: number; byteEnd: number;
    label: string; nerType: string;
    speakerDid?: string; conceptUri?: string;
  }>;
  speakerSegments?: Array<{
    byteStart: number; byteEnd: number;
    speakerDid: string; speakerName: string;
  }>;
  topicBreaks?: Array<{ byteStart: number }>;
}
```

Add to `decodeToDocumentWithStructure`, after the paragraph facet loop:

```typescript
  // Entity facets — route to speaker-ref, concept-ref, or generic entity
  for (const e of annotations.entities ?? []) {
    if (e.speakerDid) {
      doc.facets.push({
        index: { byteStart: e.byteStart, byteEnd: e.byteEnd },
        features: [{
          $type: "tv.ionosphere.facet#speaker-ref",
          speakerDid: e.speakerDid,
          label: e.label,
        }],
      });
    } else if (e.conceptUri) {
      doc.facets.push({
        index: { byteStart: e.byteStart, byteEnd: e.byteEnd },
        features: [{
          $type: "tv.ionosphere.facet#concept-ref",
          conceptUri: e.conceptUri,
          conceptName: e.label,
        }],
      });
    } else {
      doc.facets.push({
        index: { byteStart: e.byteStart, byteEnd: e.byteEnd },
        features: [{
          $type: "tv.ionosphere.facet#entity",
          label: e.label,
          nerType: e.nerType,
        }],
      });
    }
  }

  // Speaker segment facets
  for (const seg of annotations.speakerSegments ?? []) {
    doc.facets.push({
      index: { byteStart: seg.byteStart, byteEnd: seg.byteEnd },
      features: [{
        $type: "tv.ionosphere.facet#speaker-segment",
        speakerDid: seg.speakerDid,
        speakerName: seg.speakerName,
      }],
    });
  }

  // Topic break facets
  for (const tb of annotations.topicBreaks ?? []) {
    doc.facets.push({
      index: { byteStart: tb.byteStart, byteEnd: tb.byteStart },
      features: [{ $type: "tv.ionosphere.facet#topic-break" }],
    });
  }
```

- [ ] **Step 4: Run tests to verify all pass**

```bash
cd formats/tv.ionosphere && npx vitest run ts/transcript-encoding.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add formats/tv.ionosphere/ts/transcript-encoding.ts formats/tv.ionosphere/ts/transcript-encoding.test.ts
git commit -m "feat: extend NlpAnnotations with entities, speakers, topic breaks"
```

---

## Chunk 2: Python NER + entity linking

### Task 3: Install sentence-transformers dependency

**Files:**
- Modify: `pipeline/pyproject.toml`

- [ ] **Step 1: Add sentence-transformers to dependencies**

```toml
dependencies = [
    "spacy>=3.7",
    "sentence-transformers>=2.0",
]
```

- [ ] **Step 2: Install**

```bash
cd pipeline && source .venv/bin/activate && pip install -e ".[dev]"
```

- [ ] **Step 3: Verify sentence-transformers loads**

```bash
python -c "from sentence_transformers import SentenceTransformer; print('OK')"
```

- [ ] **Step 4: Commit**

```bash
git add pipeline/pyproject.toml
git commit -m "feat: add sentence-transformers dependency for topic segmentation"
```

### Task 4: Implement speaker lookup builder

**Files:**
- Create: `pipeline/nlp/speaker_lookup.py`
- Create: `pipeline/tests/test_speaker_lookup.py`

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_speaker_lookup.py`:

```python
from nlp.speaker_lookup import build_speaker_lookup


def test_build_lookup_from_rows():
    """Build lookup from speaker database rows."""
    rows = [
        ("Matt Akamatsu", "matsulab.com", "did:plc:matt123"),
        ("Rowan Cockett", "row1.ca", "did:plc:rowan456"),
        ("Jay Graber", "jay.bsky.team", "did:plc:jay789"),
    ]
    lookup = build_speaker_lookup(rows)

    # Full name match (case-insensitive)
    assert lookup.resolve("Matt Akamatsu") is not None
    assert lookup.resolve("Matt Akamatsu")["did"] == "did:plc:matt123"
    assert lookup.resolve("matt akamatsu")["did"] == "did:plc:matt123"

    # First name match
    assert lookup.resolve("Matt") is not None
    assert lookup.resolve("Matt")["did"] == "did:plc:matt123"

    # Handle match
    assert lookup.resolve("row1.ca") is not None
    assert lookup.resolve("row1.ca")["did"] == "did:plc:rowan456"

    # No match
    assert lookup.resolve("Unknown Person") is None


def test_first_name_collision_returns_none():
    """When multiple speakers share a first name, first-name lookup returns None (ambiguous)."""
    rows = [
        ("Matt Akamatsu", "matsulab.com", "did:plc:matt1"),
        ("Matt Jones", "mattj.com", "did:plc:matt2"),
    ]
    lookup = build_speaker_lookup(rows)

    # Full name still works
    assert lookup.resolve("Matt Akamatsu")["did"] == "did:plc:matt1"
    # First name alone is ambiguous
    assert lookup.resolve("Matt") is None


def test_empty_speakers():
    lookup = build_speaker_lookup([])
    assert lookup.resolve("Anyone") is None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/test_speaker_lookup.py -v
```

- [ ] **Step 3: Implement speaker_lookup.py**

Create `pipeline/nlp/speaker_lookup.py`:

```python
"""Build a speaker lookup table from database records for entity resolution."""


class SpeakerLookup:
    def __init__(self):
        self._by_full_name: dict[str, dict] = {}
        self._by_first_name: dict[str, dict | None] = {}
        self._by_handle: dict[str, dict] = {}

    def add(self, name: str, handle: str | None, did: str | None):
        entry = {"name": name, "handle": handle, "did": did}
        self._by_full_name[name.lower()] = entry

        if handle:
            self._by_handle[handle.lower()] = entry

        first = name.split()[0].lower()
        if first in self._by_first_name:
            # Collision — mark as ambiguous
            self._by_first_name[first] = None
        else:
            self._by_first_name[first] = entry

    def resolve(self, name: str) -> dict | None:
        key = name.lower().strip()
        # Try full name first
        if key in self._by_full_name:
            return self._by_full_name[key]
        # Try handle
        if key in self._by_handle:
            return self._by_handle[key]
        # Try first name (returns None if ambiguous)
        if key in self._by_first_name:
            return self._by_first_name[key]
        return None


def build_speaker_lookup(rows: list[tuple]) -> SpeakerLookup:
    """Build lookup from database rows of (name, handle, speaker_did)."""
    lookup = SpeakerLookup()
    for name, handle, did in rows:
        lookup.add(name, handle, did)
    return lookup
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/test_speaker_lookup.py -v
```

- [ ] **Step 5: Commit**

```bash
git add pipeline/nlp/speaker_lookup.py pipeline/tests/test_speaker_lookup.py
git commit -m "feat: speaker lookup builder for entity resolution"
```

### Task 5: Implement NER + entity linking pass

**Files:**
- Create: `pipeline/nlp/entities.py`
- Create: `pipeline/tests/test_entities.py`

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_entities.py`:

```python
from nlp.entities import detect_entities
from nlp.speaker_lookup import build_speaker_lookup


def test_detects_person_entities():
    text = "Matt Akamatsu is presenting today."
    rows = [("Matt Akamatsu", "matsulab.com", "did:plc:matt123")]
    lookup = build_speaker_lookup(rows)

    entities = detect_entities(text, speaker_lookup=lookup)

    persons = [e for e in entities if e["nerType"] == "PERSON"]
    assert len(persons) >= 1
    # Should resolve to the speaker
    resolved = [e for e in persons if e.get("speakerDid")]
    assert len(resolved) >= 1
    assert resolved[0]["speakerDid"] == "did:plc:matt123"


def test_detects_org_entities():
    text = "The work at Bluesky is impressive."
    concepts = [{"name": "Bluesky", "uri": "at://did/concept/bluesky", "aliases": "[]"}]

    entities = detect_entities(text, concept_rows=concepts)

    orgs = [e for e in entities if e.get("conceptUri")]
    assert len(orgs) >= 1


def test_unresolved_entities_have_label():
    text = "Barack Obama spoke at the conference."
    entities = detect_entities(text)

    persons = [e for e in entities if e["nerType"] == "PERSON"]
    assert len(persons) >= 1
    assert persons[0].get("speakerDid") is None
    assert persons[0]["label"] == "Barack Obama"


def test_byte_offsets_correct():
    text = "Matt Akamatsu presented."
    entities = detect_entities(text)
    if entities:
        e = entities[0]
        # Verify byte range matches the label
        text_at_range = text.encode("utf-8")[e["byteStart"]:e["byteEnd"]].decode("utf-8")
        assert e["label"] in text_at_range or text_at_range in e["label"]


def test_empty_text():
    entities = detect_entities("")
    assert entities == []
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/test_entities.py -v
```

- [ ] **Step 3: Implement entities.py**

Create `pipeline/nlp/entities.py`:

```python
"""Pass 3: Named entity recognition + entity linking."""

import json
import spacy

_nlp = None


def _get_nlp():
    global _nlp
    if _nlp is None:
        _nlp = spacy.load("en_core_web_sm")
    return _nlp


def detect_entities(
    text: str,
    speaker_lookup=None,
    concept_rows: list[dict] | None = None,
) -> list[dict]:
    """Detect named entities and resolve against speaker/concept records.

    Returns a list of entity dicts with:
        byteStart, byteEnd: UTF-8 byte offsets
        label: entity text
        nerType: spaCy entity type (PERSON, ORG, PRODUCT, etc.)
        speakerDid: (optional) resolved speaker DID
        conceptUri: (optional) resolved concept URI
    """
    if not text.strip():
        return []

    nlp = _get_nlp()
    doc = nlp(text)

    # Build concept lookup
    concept_lookup: dict[str, str] = {}
    if concept_rows:
        for c in concept_rows:
            concept_lookup[c["name"].lower()] = c["uri"]
            aliases = c.get("aliases", "[]")
            if isinstance(aliases, str):
                try:
                    aliases = json.loads(aliases)
                except (json.JSONDecodeError, TypeError):
                    aliases = []
            for alias in aliases:
                concept_lookup[alias.lower()] = c["uri"]

    entities = []
    for ent in doc.ents:
        if ent.label_ not in ("PERSON", "ORG", "PRODUCT", "WORK_OF_ART", "GPE", "EVENT"):
            continue

        byte_start = len(text[:ent.start_char].encode("utf-8"))
        byte_end = len(text[:ent.end_char].encode("utf-8"))

        entity = {
            "byteStart": byte_start,
            "byteEnd": byte_end,
            "label": ent.text,
            "nerType": ent.label_,
        }

        # Try to resolve
        if ent.label_ == "PERSON" and speaker_lookup:
            match = speaker_lookup.resolve(ent.text)
            if match and match.get("did"):
                entity["speakerDid"] = match["did"]
        elif ent.label_ in ("ORG", "PRODUCT", "WORK_OF_ART"):
            uri = concept_lookup.get(ent.text.lower())
            if uri:
                entity["conceptUri"] = uri

        entities.append(entity)

    return entities
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/test_entities.py -v
```

- [ ] **Step 5: Commit**

```bash
git add pipeline/nlp/entities.py pipeline/tests/test_entities.py
git commit -m "feat: NER + entity linking against speakers and concepts"
```

---

## Chunk 3: Topic segmentation

### Task 6: Implement topic segmentation pass

**Files:**
- Create: `pipeline/nlp/topics.py`
- Create: `pipeline/tests/test_topics.py`

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_topics.py`:

```python
from nlp.topics import detect_topic_breaks


def test_detects_topic_change():
    """Distinct topics should produce at least one break."""
    sentences = [
        # Topic 1: cooking
        {"byteStart": 0, "byteEnd": 30, "text": "Today we will make a cake."},
        {"byteStart": 31, "byteEnd": 65, "text": "First mix the flour and sugar."},
        {"byteStart": 66, "byteEnd": 100, "text": "Then add the eggs and butter."},
        {"byteStart": 101, "byteEnd": 135, "text": "Bake at 350 degrees for 30 minutes."},
        {"byteStart": 136, "byteEnd": 170, "text": "Let it cool before adding frosting."},
        # Topic 2: space exploration (very different)
        {"byteStart": 171, "byteEnd": 210, "text": "NASA launched a new rocket to Mars."},
        {"byteStart": 211, "byteEnd": 250, "text": "The spacecraft will orbit the red planet."},
        {"byteStart": 251, "byteEnd": 295, "text": "Astronauts may visit Mars within ten years."},
        {"byteStart": 296, "byteEnd": 340, "text": "The mission costs billions of dollars."},
        {"byteStart": 341, "byteEnd": 380, "text": "Space exploration advances human knowledge."},
    ]
    breaks = detect_topic_breaks(sentences)
    assert len(breaks) >= 1
    # Break should be near the topic transition (around sentence 5)
    assert any(4 <= b["sentenceIndex"] <= 6 for b in breaks)


def test_no_breaks_for_single_topic():
    sentences = [
        {"byteStart": 0, "byteEnd": 30, "text": "The cat sat on the mat."},
        {"byteStart": 31, "byteEnd": 60, "text": "The cat was very happy."},
        {"byteStart": 61, "byteEnd": 90, "text": "It purred loudly all day."},
    ]
    breaks = detect_topic_breaks(sentences, min_segment_sentences=2)
    # Might have 0 breaks or very few — should not over-segment
    assert len(breaks) <= 1


def test_empty_input():
    assert detect_topic_breaks([]) == []


def test_too_few_sentences():
    sentences = [{"byteStart": 0, "byteEnd": 10, "text": "Hello."}]
    assert detect_topic_breaks(sentences) == []
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/test_topics.py -v
```

- [ ] **Step 3: Implement topics.py**

Create `pipeline/nlp/topics.py`:

```python
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

    # Compute cosine similarity between adjacent windows
    similarities = []
    for i in range(window_size, len(sentences) - window_size + 1):
        left = np.mean(embeddings[i - window_size:i], axis=0)
        right = np.mean(embeddings[i:i + window_size], axis=0)
        cos_sim = np.dot(left, right) / (np.linalg.norm(left) * np.linalg.norm(right))
        similarities.append((i, float(cos_sim)))

    # Find drops below threshold, respecting minimum segment length
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/test_topics.py -v
```

Note: the first run will download the `all-MiniLM-L6-v2` model (~80MB).

- [ ] **Step 5: Commit**

```bash
git add pipeline/nlp/topics.py pipeline/tests/test_topics.py
git commit -m "feat: topic segmentation via sentence-transformer embeddings"
```

---

## Chunk 4: Update pipeline orchestrator

### Task 7: Extend run.py with NER and topic passes

**Files:**
- Modify: `pipeline/nlp/run.py`
- Modify: `pipeline/tests/test_run.py`

- [ ] **Step 1: Update the integration test**

Add to `pipeline/tests/test_run.py`:

```python
def test_process_transcript_with_enrichment():
    """Full pipeline with entity and topic passes."""
    transcript = {
        "text": "Matt Akamatsu is presenting. The AT Protocol is decentralized. Now we discuss a completely different topic about cooking recipes and baking.",
        "startMs": 0,
        "timings": [100, 100, 100, 100, 100, 100, 100, 100, 100, -3000, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
    }
    speaker_rows = [("Matt Akamatsu", "matsulab.com", "did:plc:matt123")]
    concept_rows = [{"name": "AT Protocol", "uri": "at://did/concept/atp", "aliases": "[]"}]

    result = process_transcript(
        transcript, talk_rkey="test",
        speaker_rows=speaker_rows,
        concept_rows=concept_rows,
    )

    assert "entities" in result
    assert "topicBreaks" in result
    assert len(result["entities"]) >= 1
    # At least one resolved entity
    resolved = [e for e in result["entities"] if e.get("speakerDid") or e.get("conceptUri")]
    assert len(resolved) >= 1
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/test_run.py -v
```

- [ ] **Step 3: Update process_transcript in run.py**

Add imports at top:
```python
from nlp.entities import detect_entities
from nlp.speaker_lookup import build_speaker_lookup
from nlp.topics import detect_topic_breaks
```

Update `process_transcript` signature to accept optional speaker/concept data:
```python
def process_transcript(
    transcript: dict,
    talk_rkey: str,
    pause_threshold_ms: int = 2000,
    proximity_words: int = 5,
    speaker_rows: list[tuple] | None = None,
    concept_rows: list[dict] | None = None,
) -> dict:
```

Add after the paragraph detection:
```python
    # Pass 3: NER + entity linking
    speaker_lookup = build_speaker_lookup(speaker_rows) if speaker_rows else None
    entities = detect_entities(text, speaker_lookup=speaker_lookup, concept_rows=concept_rows)

    # Pass 4: Topic segmentation
    # Enrich sentences with text for embedding
    sentences_with_text = []
    for s in sentences:
        sent_text = text.encode("utf-8")[s["byteStart"]:s["byteEnd"]].decode("utf-8")
        sentences_with_text.append({**s, "text": sent_text})
    topic_breaks = detect_topic_breaks(sentences_with_text)
```

Update the return dict to include:
```python
    return {
        "talkRkey": talk_rkey,
        "sentences": sentences,
        "paragraphs": paragraphs,
        "entities": entities,
        "topicBreaks": [{"byteStart": tb["byteStart"]} for tb in topic_breaks],
        "metadata": { ... },
    }
```

- [ ] **Step 4: Update main() to load speaker/concept data from SQLite**

Add to the `main()` function, before the transcript loop:

```python
    import sqlite3
    db_path = Path(__file__).resolve().parent.parent.parent / "apps" / "data" / "ionosphere.sqlite"
    speaker_rows = []
    concept_rows = []
    if db_path.exists():
        conn = sqlite3.connect(str(db_path))
        speaker_rows = conn.execute(
            "SELECT name, handle, speaker_did FROM speakers"
        ).fetchall()
        concept_rows = [
            {"name": r[0], "uri": r[1], "aliases": r[2] or "[]"}
            for r in conn.execute("SELECT name, uri, aliases FROM concepts").fetchall()
        ]
        conn.close()
        print(f"Loaded {len(speaker_rows)} speakers, {len(concept_rows)} concepts from DB")
    else:
        print(f"Warning: database not found at {db_path}, entity linking disabled")
```

Pass these to `process_transcript`:
```python
        result = process_transcript(
            compact, talk_rkey=talk_rkey,
            speaker_rows=speaker_rows,
            concept_rows=concept_rows,
        )
```

Update the log line:
```python
        entity_count = len(result.get("entities", []))
        topic_count = len(result.get("topicBreaks", []))
        print(f"  {talk_rkey}: {len(result['sentences'])} sentences, {len(result['paragraphs'])} paragraphs, {entity_count} entities, {topic_count} topics")
```

- [ ] **Step 5: Run ALL tests**

```bash
cd pipeline && source .venv/bin/activate && pytest tests/ -v
```

- [ ] **Step 6: Commit**

```bash
git add pipeline/nlp/run.py pipeline/tests/test_run.py
git commit -m "feat: extend pipeline with NER, entity linking, and topic segmentation"
```

---

## Chunk 5: Renderer — entities and topic dividers

### Task 8: Extend extractData for entities and topic breaks

**Files:**
- Modify: `apps/ionosphere/src/lib/transcript.ts`
- Modify: `apps/ionosphere/src/lib/transcript.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `apps/ionosphere/src/lib/transcript.test.ts`:

```typescript
describe("extractData — entities and topic breaks", () => {
  it("extracts entity spans from facets", () => {
    const doc = makeDoc([
      { text: "Matt", startNs: 1000, endNs: 2000 },
      { text: "presented.", startNs: 2000, endNs: 3000 },
    ]);
    const encoder = new TextEncoder();
    // Add a speaker-ref entity facet
    doc.facets.push({
      index: { byteStart: 0, byteEnd: encoder.encode("Matt").length },
      features: [{
        $type: "tv.ionosphere.facet#speaker-ref",
        speakerDid: "did:plc:matt123",
        label: "Matt",
      }],
    });

    const result = extractData(doc);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].speakerDid).toBe("did:plc:matt123");
    expect(result.entities[0].byteStart).toBe(0);
  });

  it("extracts topic breaks as paragraph indices", () => {
    const doc = makeDoc([
      { text: "A.", startNs: 1000, endNs: 2000 },
      { text: "B.", startNs: 3000, endNs: 4000 },
    ]);
    const encoder = new TextEncoder();
    const text = "A. B.";
    const s1End = encoder.encode("A.").length;
    const s2Start = encoder.encode("A. ").length;
    const s2End = encoder.encode(text).length;

    // Two paragraphs
    doc.facets.push({ index: { byteStart: 0, byteEnd: s1End }, features: [{ $type: "tv.ionosphere.facet#paragraph" }] });
    doc.facets.push({ index: { byteStart: s2Start, byteEnd: s2End }, features: [{ $type: "tv.ionosphere.facet#paragraph" }] });
    // Topic break at second paragraph
    doc.facets.push({ index: { byteStart: s2Start, byteEnd: s2Start }, features: [{ $type: "tv.ionosphere.facet#topic-break" }] });
    // Sentences
    doc.facets.push({ index: { byteStart: 0, byteEnd: s1End }, features: [{ $type: "tv.ionosphere.facet#sentence" }] });
    doc.facets.push({ index: { byteStart: s2Start, byteEnd: s2End }, features: [{ $type: "tv.ionosphere.facet#sentence" }] });

    const result = extractData(doc);
    expect(result.topicBreaks.has(1)).toBe(true);  // second paragraph
    expect(result.topicBreaks.has(0)).toBe(false);  // first paragraph
  });

  it("returns empty entities and topicBreaks when no such facets exist", () => {
    const doc = makeDoc([
      { text: "Hello", startNs: 1000, endNs: 2000 },
    ]);
    const result = extractData(doc);
    expect(result.entities).toHaveLength(0);
    expect(result.topicBreaks.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/ionosphere && npx vitest run src/lib/transcript.test.ts
```

- [ ] **Step 3: Add EntitySpan type and update extractData**

Add to `apps/ionosphere/src/lib/transcript.ts`:

```typescript
export interface EntitySpan {
  byteStart: number;
  byteEnd: number;
  label: string;
  nerType?: string;
  speakerDid?: string;
  conceptUri?: string;
  conceptName?: string;
}
```

In `extractData`, add extraction of entity facets (speaker-ref, concept-ref, entity) and topic-break facets. Map topic breaks to paragraph indices by finding which paragraph contains each break's byte position.

Return `entities: EntitySpan[]` and `topicBreaks: Set<number>` alongside existing fields.

- [ ] **Step 4: Run tests to verify all pass**

```bash
cd apps/ionosphere && npx vitest run src/lib/transcript.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere/src/lib/transcript.ts apps/ionosphere/src/lib/transcript.test.ts
git commit -m "feat: extract entities and topic breaks from facets"
```

### Task 9: Update TranscriptView for entity rendering and topic dividers

**Files:**
- Modify: `apps/ionosphere/src/app/components/TranscriptView.tsx`

- [ ] **Step 1: Extract entities and topicBreaks from extractData**

In the `useMemo` that calls `extractData`, also destructure `entities` and `topicBreaks`.

- [ ] **Step 2: Build word-to-entity lookup**

```typescript
const wordEntities = useMemo(() => {
  const map = new Map<number, EntitySpan>();
  for (const entity of entities) {
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.byteStart >= entity.byteStart && w.byteEnd <= entity.byteEnd) {
        // First word of entity gets the entity data (for rendering the link)
        if (!map.has(i)) map.set(i, entity);
      }
    }
  }
  return map;
}, [words, entities]);
```

- [ ] **Step 3: Add entity link styling to WordSpanComponent or a wrapper**

For words that are part of an entity, add visual treatment:
- `speaker-ref`: blue underline, link to `/speakers/{rkey}` or Bluesky profile
- `concept-ref`: amber underline (matching existing concept style)
- `entity` (unresolved): dotted underline, no link

The simplest approach: check `wordEntities.get(globalIdx)` when rendering each word, and wrap entity-start words in an `<a>` or styled `<span>`.

- [ ] **Step 4: Add topic dividers between paragraphs**

In the paragraph rendering loop, check `topicBreaks.has(paragraphIndex)` and insert an `<hr>` before that paragraph:

```tsx
{paragraphs.map((para, pi) => (
  <>
    {topicBreaks.has(pi) && (
      <hr key={`topic-${pi}`} className="border-neutral-800 my-6" />
    )}
    <div key={pi} className="mb-4">
      {/* sentences... */}
    </div>
  </>
))}
```

- [ ] **Step 5: Verify in browser**

Load a talk page. Verify:
- Entity names have visible styling (underlines)
- Resolved entities are clickable
- Topic dividers appear as subtle horizontal rules
- Existing functionality (scroll, brightness, comments) unchanged

- [ ] **Step 6: Commit**

```bash
git add apps/ionosphere/src/app/components/TranscriptView.tsx
git commit -m "feat: render entity links and topic dividers in transcript"
```

---

## Chunk 6: End-to-end integration

### Task 10: Run the full enriched pipeline

- [ ] **Step 1: Run the pipeline on all transcripts**

```bash
cd pipeline && source .venv/bin/activate && python -m nlp.run
```

Verify output includes entity and topic data. Spot-check 3-5 output files.

- [ ] **Step 2: Inject documents into local database**

Use the same inject pattern as Phase 1 — create a temporary script that reads NLP output + transcripts, calls `decodeToDocumentWithStructure`, and updates the talks table.

- [ ] **Step 3: Verify in browser**

Load several talk pages. Check:
- Entity links point to correct profiles/concepts
- Topic dividers land at natural transitions
- Talks without diarization still work (entities just don't have speaker context)
- All existing features (paragraphs, sentences, timing, comments) unchanged

- [ ] **Step 4: Run all tests**

```bash
# Python
cd pipeline && source .venv/bin/activate && pytest -v

# TypeScript
cd formats/tv.ionosphere && npx vitest run
cd ../../apps/ionosphere && npx vitest run src/lib/transcript.test.ts
```

- [ ] **Step 5: Commit any integration fixes**

```bash
git add -A && git commit -m "fix: integration fixes from end-to-end verification"
```

### Task 11: Update publish.ts for enriched annotations

**Files:**
- Modify: `apps/ionosphere-appview/src/publish.ts`

- [ ] **Step 1: Update the NLP data reading to include new fields**

The publish.ts code that reads NLP JSON and passes it to `decodeToDocumentWithStructure` needs to include the new fields (entities, speakerSegments, topicBreaks) from the NLP output. Since `NlpAnnotations` now has these as optional fields, this is just passing them through:

```typescript
const doc = decodeToDocumentWithStructure(compact, {
  sentences: nlpData.sentences,
  paragraphs: nlpData.paragraphs,
  entities: nlpData.entities,
  topicBreaks: nlpData.topicBreaks,
  // speakerSegments will come when diarization is integrated
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere-appview/src/publish.ts
git commit -m "feat: pass entity and topic data through publish pipeline"
```
