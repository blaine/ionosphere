from nlp.speaker_lookup import build_speaker_lookup


def test_build_lookup_from_rows():
    rows = [
        ("Matt Akamatsu", "matsulab.com", "did:plc:matt123"),
        ("Rowan Cockett", "row1.ca", "did:plc:rowan456"),
        ("Jay Graber", "jay.bsky.team", "did:plc:jay789"),
    ]
    lookup = build_speaker_lookup(rows)

    assert lookup.resolve("Matt Akamatsu") is not None
    assert lookup.resolve("Matt Akamatsu")["did"] == "did:plc:matt123"
    assert lookup.resolve("matt akamatsu")["did"] == "did:plc:matt123"
    assert lookup.resolve("Matt") is not None
    assert lookup.resolve("Matt")["did"] == "did:plc:matt123"
    assert lookup.resolve("row1.ca") is not None
    assert lookup.resolve("row1.ca")["did"] == "did:plc:rowan456"
    assert lookup.resolve("Unknown Person") is None


def test_first_name_collision_returns_none():
    rows = [
        ("Matt Akamatsu", "matsulab.com", "did:plc:matt1"),
        ("Matt Jones", "mattj.com", "did:plc:matt2"),
    ]
    lookup = build_speaker_lookup(rows)

    assert lookup.resolve("Matt Akamatsu")["did"] == "did:plc:matt1"
    assert lookup.resolve("Matt") is None


def test_empty_speakers():
    lookup = build_speaker_lookup([])
    assert lookup.resolve("Anyone") is None
