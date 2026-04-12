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
