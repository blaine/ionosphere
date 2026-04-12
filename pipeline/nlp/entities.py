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

        if ent.label_ == "PERSON" and speaker_lookup:
            match = speaker_lookup.resolve(ent.text)
            if match and match.get("did"):
                entity["speakerDid"] = match["did"]

        # Concept linking applies across all entity types
        uri = concept_lookup.get(ent.text.lower())
        if uri:
            entity["conceptUri"] = uri

        entities.append(entity)

    return entities
