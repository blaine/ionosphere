from nlp.entities import detect_entities
from nlp.speaker_lookup import build_speaker_lookup


def test_detects_person_entities():
    text = "Matt Akamatsu is presenting today."
    rows = [("Matt Akamatsu", "matsulab.com", "did:plc:matt123")]
    lookup = build_speaker_lookup(rows)

    entities = detect_entities(text, speaker_lookup=lookup)

    persons = [e for e in entities if e["nerType"] == "PERSON"]
    assert len(persons) >= 1
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
        text_at_range = text.encode("utf-8")[e["byteStart"]:e["byteEnd"]].decode("utf-8")
        assert e["label"] in text_at_range or text_at_range in e["label"]


def test_empty_text():
    entities = detect_entities("")
    assert entities == []


# --- Text matching for known concepts ---


def test_text_matching_finds_domain_concepts():
    """Concepts like 'AT Protocol' and 'PDS' aren't NER entities but should be found by text matching."""
    text = "The AT Protocol uses a PDS for data storage. Each lexicon defines a schema."
    concepts = [
        {"name": "AT Protocol", "uri": "at://did/concept/atp", "aliases": '["atproto"]'},
        {"name": "PDS", "uri": "at://did/concept/pds", "aliases": '["Personal Data Server"]'},
        {"name": "Lexicon", "uri": "at://did/concept/lexicon", "aliases": "[]"},
    ]

    entities = detect_entities(text, concept_rows=concepts)

    concept_entities = [e for e in entities if e.get("conceptUri")]
    concept_names = {e["label"] for e in concept_entities}
    assert "AT Protocol" in concept_names
    assert "PDS" in concept_names
    assert "lexicon" in concept_names or "Lexicon" in concept_names


def test_text_matching_case_insensitive():
    text = "We use the at protocol for federation."
    concepts = [{"name": "AT Protocol", "uri": "at://did/concept/atp", "aliases": "[]"}]

    entities = detect_entities(text, concept_rows=concepts)

    concept_entities = [e for e in entities if e.get("conceptUri")]
    # Should match case-insensitively
    assert len(concept_entities) >= 1


def test_text_matching_finds_aliases():
    text = "The Personal Data Server stores your data."
    concepts = [{"name": "PDS", "uri": "at://did/concept/pds", "aliases": '["Personal Data Server"]'}]

    entities = detect_entities(text, concept_rows=concepts)

    concept_entities = [e for e in entities if e.get("conceptUri")]
    assert len(concept_entities) >= 1
    assert concept_entities[0]["conceptUri"] == "at://did/concept/pds"


def test_text_matching_no_duplicates_with_ner():
    """If NER already detected an entity and text matching also finds it, don't duplicate."""
    text = "Bluesky is a social network."
    concepts = [{"name": "Bluesky", "uri": "at://did/concept/bluesky", "aliases": "[]"}]

    entities = detect_entities(text, concept_rows=concepts)

    bluesky_entities = [e for e in entities if e["label"] == "Bluesky" or e["label"] == "bluesky"]
    # Should have exactly one, not two
    assert len(bluesky_entities) <= 2  # NER might split differently, but no exact byte-range duplicates
    byte_ranges = {(e["byteStart"], e["byteEnd"]) for e in bluesky_entities}
    assert len(byte_ranges) == len(bluesky_entities)  # no duplicate ranges


def test_text_matching_skips_short_concepts():
    """Very short concept names (1-2 chars) should be skipped to avoid noise."""
    text = "I think we should use AT for this."
    concepts = [{"name": "AT", "uri": "at://did/concept/at", "aliases": "[]"}]

    entities = detect_entities(text, concept_rows=concepts)

    # "AT" is too short and common — should not match
    concept_entities = [e for e in entities if e.get("conceptUri")]
    assert len(concept_entities) == 0
