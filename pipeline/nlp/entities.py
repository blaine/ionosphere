"""Pass 3: Named entity recognition + entity linking + concept text matching."""

import json
import re
import spacy

_nlp = None

# Minimum concept name length to match — avoids noise from short terms
MIN_CONCEPT_LENGTH = 3


def _get_nlp():
    global _nlp
    if _nlp is None:
        _nlp = spacy.load("en_core_web_sm")
    return _nlp


def _build_concept_lookup(concept_rows: list[dict] | None) -> dict[str, str]:
    """Build a lowercase name/alias → URI lookup from concept records."""
    lookup: dict[str, str] = {}
    if not concept_rows:
        return lookup
    for c in concept_rows:
        lookup[c["name"].lower()] = c["uri"]
        aliases = c.get("aliases", "[]")
        if isinstance(aliases, str):
            try:
                aliases = json.loads(aliases)
            except (json.JSONDecodeError, TypeError):
                aliases = []
        for alias in aliases:
            if alias:
                lookup[alias.lower()] = c["uri"]
    return lookup


def _build_concept_names(concept_rows: list[dict] | None) -> list[tuple[str, str, str]]:
    """Build a list of (search_term, display_name, uri) for text matching.

    Returns terms sorted longest-first so longer matches take priority.
    Skips terms shorter than MIN_CONCEPT_LENGTH.
    """
    terms: list[tuple[str, str, str]] = []
    if not concept_rows:
        return terms
    for c in concept_rows:
        name = c["name"]
        uri = c["uri"]
        if len(name) >= MIN_CONCEPT_LENGTH:
            terms.append((name, name, uri))
        aliases = c.get("aliases", "[]")
        if isinstance(aliases, str):
            try:
                aliases = json.loads(aliases)
            except (json.JSONDecodeError, TypeError):
                aliases = []
        for alias in aliases:
            if alias and len(alias) >= MIN_CONCEPT_LENGTH:
                terms.append((alias, name, uri))
    # Sort longest first so "AT Protocol" matches before "AT"
    terms.sort(key=lambda t: len(t[0]), reverse=True)
    return terms


def _scan_concepts(
    text: str,
    concept_terms: list[tuple[str, str, str]],
    occupied_ranges: set[tuple[int, int]],
) -> list[dict]:
    """Scan transcript text for known concept names/aliases.

    Returns concept entities with byte ranges. Skips ranges already
    occupied by NER-detected entities to avoid duplicates.
    """
    entities = []
    text_lower = text.lower()
    # Track which character ranges we've already matched (avoid overlapping matches)
    matched_chars: set[int] = set()
    # Also add NER-occupied char ranges
    for byte_start, byte_end in occupied_ranges:
        # Convert byte ranges to approximate char ranges
        prefix_len = len(text.encode("utf-8")[:byte_start].decode("utf-8", errors="ignore"))
        suffix_len = len(text.encode("utf-8")[:byte_end].decode("utf-8", errors="ignore"))
        for i in range(prefix_len, suffix_len):
            matched_chars.add(i)

    for search_term, display_name, uri in concept_terms:
        pattern = re.compile(re.escape(search_term.lower()), re.IGNORECASE)
        for match in pattern.finditer(text_lower):
            start_char = match.start()
            end_char = match.end()

            # Skip if any character in this range is already matched
            if any(i in matched_chars for i in range(start_char, end_char)):
                continue

            # Word boundary check — don't match "PDServer" when looking for "PDS"
            if start_char > 0 and text[start_char - 1].isalnum():
                continue
            if end_char < len(text) and text[end_char].isalnum():
                continue

            byte_start = len(text[:start_char].encode("utf-8"))
            byte_end = len(text[:end_char].encode("utf-8"))

            entities.append({
                "byteStart": byte_start,
                "byteEnd": byte_end,
                "label": text[start_char:end_char],
                "nerType": "CONCEPT",
                "conceptUri": uri,
            })

            # Mark these characters as matched
            for i in range(start_char, end_char):
                matched_chars.add(i)

    return entities


def detect_entities(
    text: str,
    speaker_lookup=None,
    concept_rows: list[dict] | None = None,
) -> list[dict]:
    """Detect named entities and concepts in transcript text.

    Two-pass approach:
    1. spaCy NER for people, organizations, etc.
    2. Direct text matching for known concept names/aliases

    Returns a list of entity dicts with:
        byteStart, byteEnd: UTF-8 byte offsets
        label: entity text
        nerType: spaCy entity type or "CONCEPT"
        speakerDid: (optional) resolved speaker DID
        conceptUri: (optional) resolved concept URI
    """
    if not text.strip():
        return []

    nlp = _get_nlp()
    doc = nlp(text)

    concept_lookup = _build_concept_lookup(concept_rows)
    concept_terms = _build_concept_names(concept_rows)

    entities = []
    occupied_ranges: set[tuple[int, int]] = set()

    # Pass 1: NER entities
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

        if ent.label_ == "PERSON" and speaker_lookup:
            match = speaker_lookup.resolve(ent.text)
            if match and match.get("did"):
                entity["speakerDid"] = match["did"]

        # Concept linking applies across all entity types
        # Try exact match, then strip common prefixes ("The", "A", "An")
        ent_lower = ent.text.lower()
        uri = concept_lookup.get(ent_lower)
        if not uri:
            for prefix in ("the ", "a ", "an "):
                if ent_lower.startswith(prefix):
                    uri = concept_lookup.get(ent_lower[len(prefix):])
                    if uri:
                        break
        if uri:
            entity["conceptUri"] = uri

        entities.append(entity)
        occupied_ranges.add((byte_start, byte_end))

    # Pass 2: Direct text matching for known concepts
    concept_entities = _scan_concepts(text, concept_terms, occupied_ranges)
    entities.extend(concept_entities)

    return entities
