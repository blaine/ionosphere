"""Pass 5: LLM-based concept detection using Claude.

Sends transcript chunks to Claude to identify domain concepts that
text matching and NER miss — paraphrases, abbreviations, implicit
references, and potential new concepts.
"""

import json
import os
import re
import anthropic

# Use Haiku for speed and cost efficiency
MODEL = "claude-haiku-4-5-20251001"

SYSTEM_PROMPT = """You are analyzing a transcript from ATmosphereConf, a conference about the AT Protocol ecosystem (Bluesky, decentralized social media, open protocols).

Your job: identify technical concepts, projects, protocols, organizations, and domain-specific terms mentioned in this transcript chunk.

For each concept you find, return:
- "text": the exact text as it appears in the transcript (verbatim, for byte-range matching)
- "label": the canonical name of the concept (e.g., "AT Protocol" even if the text says "the protocol")
- "isNew": true if this seems like a concept not in the provided known concepts list

Focus on domain-specific terms. Skip common English words, generic phrases, and obvious things. Be precise about the exact text spans.

Return valid JSON array only, no other text."""


def detect_llm_concepts(
    text: str,
    known_concept_names: list[str],
    chunk_size: int = 8000,
) -> list[dict]:
    """Use Claude to identify concepts in transcript text.

    Args:
        text: full transcript text
        known_concept_names: list of known concept names for context
        chunk_size: characters per chunk (to stay within context limits)

    Returns:
        list of dicts with text, label, isNew
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("  Warning: ANTHROPIC_API_KEY not set, skipping LLM concept pass")
        return []

    client = anthropic.Anthropic(api_key=api_key)

    # Build a concise concept list (top 200 by name length — shorter names are more common)
    sorted_concepts = sorted(known_concept_names, key=len)[:200]
    concept_list = ", ".join(sorted_concepts)

    # Split text into chunks at sentence boundaries
    chunks = _split_into_chunks(text, chunk_size)
    all_concepts = []

    for i, chunk in enumerate(chunks):
        user_prompt = f"""Known concepts (subset): {concept_list}

Transcript chunk ({i + 1}/{len(chunks)}):
\"\"\"
{chunk}
\"\"\"

Identify all technical concepts, projects, protocols, and domain terms in this chunk. Return a JSON array."""

        try:
            response = client.messages.create(
                model=MODEL,
                max_tokens=2000,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_prompt}],
            )

            # Parse JSON from response
            response_text = response.content[0].text.strip()
            # Handle markdown code blocks
            if response_text.startswith("```"):
                response_text = re.sub(r"^```(?:json)?\n?", "", response_text)
                response_text = re.sub(r"\n?```$", "", response_text)

            concepts = json.loads(response_text)
            if isinstance(concepts, list):
                all_concepts.extend(concepts)
        except (json.JSONDecodeError, anthropic.APIError, IndexError) as e:
            print(f"  Warning: LLM chunk {i + 1} failed: {e}")
            continue

    return all_concepts


def resolve_llm_concepts(
    text: str,
    llm_concepts: list[dict],
    concept_lookup: dict[str, str],
    occupied_ranges: set[tuple[int, int]],
) -> list[dict]:
    """Resolve LLM-detected concepts to known concept URIs and compute byte ranges.

    Args:
        text: full transcript text
        llm_concepts: output from detect_llm_concepts
        concept_lookup: lowercase name → URI mapping
        occupied_ranges: byte ranges already occupied by other entities

    Returns:
        list of entity dicts ready to merge into the entities list
    """
    entities = []
    text_lower = text.lower()

    # Build set of occupied character ranges for dedup
    matched_chars: set[int] = set()
    for byte_start, byte_end in occupied_ranges:
        prefix_len = len(text.encode("utf-8")[:byte_start].decode("utf-8", errors="ignore"))
        suffix_len = len(text.encode("utf-8")[:byte_end].decode("utf-8", errors="ignore"))
        for i in range(prefix_len, suffix_len):
            matched_chars.add(i)

    for concept in llm_concepts:
        search_text = concept.get("text", "").strip()
        label = concept.get("label", search_text)
        is_new = concept.get("isNew", False)

        if not search_text or len(search_text) < 3:
            continue

        # Find the exact text in the transcript
        search_lower = search_text.lower()
        start = 0
        while True:
            idx = text_lower.find(search_lower, start)
            if idx == -1:
                break

            end_idx = idx + len(search_text)

            # Skip if overlaps with existing entities
            if any(i in matched_chars for i in range(idx, end_idx)):
                start = end_idx
                continue

            byte_start = len(text[:idx].encode("utf-8"))
            byte_end = len(text[:end_idx].encode("utf-8"))

            # Try to resolve to a known concept
            uri = concept_lookup.get(label.lower()) or concept_lookup.get(search_lower)

            entity = {
                "byteStart": byte_start,
                "byteEnd": byte_end,
                "label": text[idx:end_idx],
                "nerType": "CONCEPT",
            }
            if uri:
                entity["conceptUri"] = uri
            # Skip if it's a "new" concept with no URI — we only emit linked concepts
            # (new concept discovery is for Phase 4 manual curation)
            elif is_new:
                start = end_idx
                continue

            entities.append(entity)

            # Mark as occupied
            for i in range(idx, end_idx):
                matched_chars.add(i)

            # Only match first occurrence per chunk to avoid over-annotation
            break

    return entities


def _split_into_chunks(text: str, chunk_size: int) -> list[str]:
    """Split text into chunks at sentence boundaries."""
    if len(text) <= chunk_size:
        return [text]

    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        if end >= len(text):
            chunks.append(text[start:])
            break

        # Find the last sentence boundary before the chunk limit
        last_period = text.rfind(". ", start, end)
        last_question = text.rfind("? ", start, end)
        last_exclaim = text.rfind("! ", start, end)
        boundary = max(last_period, last_question, last_exclaim)

        if boundary > start:
            chunks.append(text[start : boundary + 1])
            start = boundary + 2
        else:
            # No sentence boundary found — split at chunk_size
            chunks.append(text[start:end])
            start = end

    return chunks
