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
            self._by_first_name[first] = None  # ambiguous
        else:
            self._by_first_name[first] = entry

    def resolve(self, name: str) -> dict | None:
        key = name.lower().strip()
        if key in self._by_full_name:
            return self._by_full_name[key]
        if key in self._by_handle:
            return self._by_handle[key]
        if key in self._by_first_name:
            return self._by_first_name[key]
        return None


def build_speaker_lookup(rows: list[tuple]) -> SpeakerLookup:
    lookup = SpeakerLookup()
    for name, handle, did in rows:
        lookup.add(name, handle, did)
    return lookup
