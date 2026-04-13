"""Cluster and deduplicate concepts using name similarity + LLM merge.

Three-pass approach:
1. Normalize names: strip parentheticals, punctuation, case
2. Stem + merge: Porter stemming catches singular/plural (Lexicon/Lexicons)
3. LLM merge: Claude identifies remaining semantic duplicates (PDS/Personal Data Server)
"""

import json
import os
import re
import sqlite3
from collections import defaultdict
from pathlib import Path

import nltk
nltk.download("punkt_tab", quiet=True)
from nltk.stem import PorterStemmer

_stemmer = PorterStemmer()


def load_concepts(db_path: str) -> list[dict]:
    """Load all concepts from the database."""
    conn = sqlite3.connect(db_path)
    rows = conn.execute("SELECT uri, rkey, name, aliases, description FROM concepts").fetchall()
    conn.close()
    return [
        {"uri": r[0], "rkey": r[1], "name": r[2], "aliases": r[3] or "[]", "description": r[4] or ""}
        for r in rows
    ]


def normalize_name(name: str) -> str:
    """Strip parenthetical qualifiers, punctuation, normalize case/whitespace."""
    name = re.sub(r"\s*\([^)]*\)\s*", " ", name)
    parts = name.split("/")
    name = parts[0]
    name = name.lower().strip()
    name = re.sub(r"\s+", " ", name)
    name = name.strip(" .,;:-")
    return name


def stem_form(name: str) -> str:
    """Normalize + stem each word + remove spaces/hyphens.

    'Lexicons' → 'lexicon'
    'Blue Sky' → 'bluesky' (after space removal)
    'Custom feeds' → 'customfeed'
    """
    n = normalize_name(name)
    words = n.split()
    stemmed = [_stemmer.stem(w) for w in words]
    return "".join(stemmed)


def cluster_by_name(concepts: list[dict]) -> list[list[int]]:
    """Cluster concepts by stemmed name form."""
    stem_groups: dict[str, list[int]] = defaultdict(list)
    for i, c in enumerate(concepts):
        sf = stem_form(c["name"])
        if sf:
            stem_groups[sf].append(i)

    # Also try without spaces/hyphens on the normalized form (catches Blue Sky / BlueSky)
    base_groups: dict[str, set[str]] = defaultdict(set)
    for sf in stem_groups:
        base = re.sub(r"[\s\-_]", "", sf)
        base_groups[base].add(sf)

    # Merge stem groups that share a base form
    visited: set[str] = set()
    clusters: list[list[int]] = []
    for base, stems in base_groups.items():
        if not base:
            continue
        indices = []
        for sf in stems:
            if sf not in visited:
                visited.add(sf)
                indices.extend(stem_groups[sf])
        if indices:
            clusters.append(indices)

    # Add unclustered
    all_clustered = set()
    for cluster in clusters:
        all_clustered.update(cluster)
    for i in range(len(concepts)):
        if i not in all_clustered:
            clusters.append([i])

    return clusters


def llm_merge_pass(
    cluster_groups: list[dict],
    batch_size: int = 100,
) -> list[list[int]]:
    """Use Claude to identify remaining semantic duplicates across clusters.

    Takes the cluster canonicals and asks the LLM which ones should be merged.
    Returns a list of merge groups (indices into cluster_groups).
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("  No ANTHROPIC_API_KEY — skipping LLM merge pass")
        return []

    import anthropic
    client = anthropic.Anthropic(api_key=api_key, timeout=30.0)

    # Only send cluster canonicals (not all 2000+ members)
    names = [g["canonical"] for g in cluster_groups]

    all_merges: list[list[int]] = []

    # Process in batches
    for batch_start in range(0, len(names), batch_size):
        batch = names[batch_start : batch_start + batch_size]
        batch_indices = list(range(batch_start, min(batch_start + batch_size, len(names))))

        prompt = f"""Here is a list of concept names from a conference about the AT Protocol / Bluesky ecosystem. Many are duplicates or near-duplicates that should be merged.

For each group of duplicates, return the indices (0-based within this batch) that should be merged.

Only merge concepts that are genuinely THE SAME THING with different names. Do NOT merge concepts that are merely related (e.g., "Bluesky" and "AT Protocol" are different things).

Examples of valid merges:
- "PDS" and "Personal Data Server" (same thing, abbreviation)
- "DID" and "Decentralized Identifier" (same thing)
- "i18n" and "internationalization" (same thing)

Examples of INVALID merges:
- "Bluesky" and "AT Protocol" (different things)
- "Ozone" and "Labelers" (related but different)

Concepts:
{json.dumps([{"idx": i, "name": n} for i, n in enumerate(batch)], indent=1)}

Return a JSON array of merge groups. Each group is an array of indices that should be merged.
Return ONLY the JSON array, no other text."""

        try:
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=2000,
                messages=[{"role": "user", "content": prompt}],
            )

            text = response.content[0].text.strip()
            if text.startswith("```"):
                text = re.sub(r"^```(?:json)?\n?", "", text)
                text = re.sub(r"\n?```$", "", text)

            merges = json.loads(text)
            if isinstance(merges, list):
                for group in merges:
                    if isinstance(group, list) and len(group) > 1:
                        # Convert batch-local indices to global indices
                        global_indices = [batch_indices[i] for i in group if i < len(batch)]
                        all_merges.append(global_indices)

        except Exception as e:
            print(f"  LLM merge batch {batch_start} failed: {e}")
            continue

    return all_merges


def apply_merges(
    cluster_groups: list[dict],
    merges: list[list[int]],
    concepts: list[dict],
) -> list[dict]:
    """Apply LLM-suggested merges to the cluster groups."""
    if not merges:
        return cluster_groups

    # Build a union-find for merge groups
    parent = list(range(len(cluster_groups)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for group in merges:
        for i in range(1, len(group)):
            union(group[0], group[i])

    # Rebuild clusters
    merged: dict[int, list[int]] = defaultdict(list)
    for i in range(len(cluster_groups)):
        root = find(i)
        merged[root].append(i)

    results = []
    for root, group_indices in merged.items():
        if len(group_indices) == 1:
            results.append(cluster_groups[group_indices[0]])
        else:
            # Merge all member concepts
            all_member_indices = []
            for gi in group_indices:
                # Find original concept indices for this cluster group
                g = cluster_groups[gi]
                for m_name in g["members"]:
                    for ci, c in enumerate(concepts):
                        if c["name"] == m_name:
                            all_member_indices.append(ci)
                            break
            results.append(pick_canonical(concepts, all_member_indices))

    return results


def pick_canonical(concepts: list[dict], indices: list[int]) -> dict:
    """Pick the canonical concept from a cluster."""
    candidates = [(concepts[i], i) for i in indices]
    candidates.sort(key=lambda x: (not bool(x[0]["description"]), len(x[0]["name"])))
    canonical = candidates[0][0]

    all_names = set()
    for i in indices:
        all_names.add(concepts[i]["name"])
        try:
            aliases = json.loads(concepts[i]["aliases"])
            if isinstance(aliases, list):
                all_names.update(a for a in aliases if a)
        except (json.JSONDecodeError, TypeError):
            pass
    all_names.discard(canonical["name"])

    return {
        "canonical": canonical["name"],
        "uri": canonical["uri"],
        "rkey": canonical["rkey"],
        "description": canonical["description"],
        "aliases": sorted(all_names),
        "memberCount": len(indices),
        "members": [concepts[i]["name"] for i in indices],
    }


def cluster_concepts(db_path: str) -> list[dict]:
    """Full pipeline: load, stem-cluster, LLM-merge, pick canonicals."""
    concepts = load_concepts(db_path)
    print(f"Loaded {len(concepts)} concepts")

    # Pass 1+2: Name normalization + stemming
    clusters = cluster_by_name(concepts)
    print(f"After stemming: {len(clusters)} clusters")

    # Build initial groups
    groups = []
    multi = 0
    for indices in clusters:
        g = pick_canonical(concepts, indices)
        groups.append(g)
        if len(indices) > 1:
            multi += 1
    print(f"  {multi} clusters with multiple members")

    # Pass 3: LLM merge
    print("Running LLM merge pass...")
    merges = llm_merge_pass(groups)
    if merges:
        print(f"  LLM suggested {len(merges)} additional merges")
        groups = apply_merges(groups, merges, concepts)
        print(f"After LLM merge: {len(groups)} clusters")

    groups.sort(key=lambda g: g["memberCount"], reverse=True)
    return groups


def main():
    db_path = str(Path(__file__).resolve().parent.parent.parent / "apps" / "data" / "ionosphere.sqlite")
    output_path = Path(__file__).resolve().parent.parent / "data" / "concept-clusters.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    results = cluster_concepts(db_path)

    output_path.write_text(json.dumps(results, indent=2))
    print(f"\nWrote {len(results)} clusters to {output_path}")

    print("\nTop clusters by member count:")
    for g in results[:25]:
        if g["memberCount"] > 1:
            print(f"  {g['canonical']} ({g['memberCount']} members)")
            for m in g["members"][:8]:
                print(f"    - {m}")
            if len(g["members"]) > 8:
                print(f"    ... and {len(g['members']) - 8} more")


if __name__ == "__main__":
    main()
