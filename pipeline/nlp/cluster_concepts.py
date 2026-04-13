"""Cluster and deduplicate concepts using name similarity.

Two-pass approach:
1. Exact dedup: normalize names and merge exact matches
2. Fuzzy dedup: use string similarity (not semantic) to merge near-duplicates
   like "Bluesky (social network)" and "BlueSky (platform)"

Semantic similarity (embeddings) is too aggressive — it merges related-but-distinct
concepts like "AT Protocol" and "Nostr" because they're both protocols.
"""

import json
import re
import sqlite3
from collections import defaultdict
from pathlib import Path


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
    """Normalize a concept name for comparison.

    Strips parenthetical qualifiers, punctuation, and normalizes case/whitespace.
    'Bluesky (social network)' → 'bluesky'
    'AT Protocol (ATProto / AT Proto)' → 'at protocol'
    'BlueSky / Bluesky' → 'bluesky'
    """
    # Remove parenthetical suffixes
    name = re.sub(r"\s*\([^)]*\)\s*", " ", name)
    # Split on / and take the first part (often the canonical form)
    parts = name.split("/")
    name = parts[0]
    # Lowercase, strip, collapse whitespace
    name = name.lower().strip()
    name = re.sub(r"\s+", " ", name)
    # Remove trailing punctuation
    name = name.strip(" .,;:-")
    return name


def base_form(name: str) -> str:
    """Extract the core base form, more aggressively normalized.

    'BlueSky' → 'bluesky'
    'Blue Sky' → 'bluesky'  (remove spaces)
    'at-proto' → 'atproto'
    """
    n = normalize_name(name)
    # Remove all spaces, hyphens, underscores for comparison
    return re.sub(r"[\s\-_]", "", n)


def cluster_concepts(db_path: str) -> list[dict]:
    """Full pipeline: load, normalize, cluster, pick canonicals."""
    concepts = load_concepts(db_path)
    print(f"Loaded {len(concepts)} concepts")

    # Pass 1: Group by normalized name
    norm_groups: dict[str, list[int]] = defaultdict(list)
    for i, c in enumerate(concepts):
        norm = normalize_name(c["name"])
        norm_groups[norm].append(i)

    # Pass 2: Merge groups that share a base form
    base_to_norms: dict[str, set[str]] = defaultdict(set)
    for norm in norm_groups:
        bf = base_form(norm) if norm else norm
        base_to_norms[bf].add(norm)

    # Build final clusters by merging all norm groups that share a base form
    visited_norms: set[str] = set()
    clusters: list[list[int]] = []

    for bf, norms in base_to_norms.items():
        if not bf:
            continue
        indices = []
        for norm in norms:
            if norm not in visited_norms:
                visited_norms.add(norm)
                indices.extend(norm_groups[norm])
        if indices:
            clusters.append(indices)

    # Add any remaining unclustered concepts
    all_clustered = set()
    for cluster in clusters:
        all_clustered.update(cluster)
    for i in range(len(concepts)):
        if i not in all_clustered:
            clusters.append([i])

    print(f"Found {len(clusters)} clusters (from {len(concepts)} concepts)")

    # Build results
    results = []
    multi_member = 0
    for indices in clusters:
        group = pick_canonical(concepts, indices)
        results.append(group)
        if len(indices) > 1:
            multi_member += 1

    results.sort(key=lambda g: g["memberCount"], reverse=True)
    print(f"{multi_member} clusters have multiple members (duplicates merged)")

    return results


def pick_canonical(concepts: list[dict], indices: list[int]) -> dict:
    """Pick the canonical concept from a cluster.

    Prefer shorter names (less noisy), with description if available.
    """
    candidates = [(concepts[i], i) for i in indices]
    # Sort by: has description (prefer), then shortest name
    candidates.sort(key=lambda x: (not bool(x[0]["description"]), len(x[0]["name"])))
    canonical = candidates[0][0]

    # Collect all names as aliases
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


def main():
    db_path = str(Path(__file__).resolve().parent.parent.parent / "apps" / "data" / "ionosphere.sqlite")
    output_path = Path(__file__).resolve().parent.parent / "data" / "concept-clusters.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    results = cluster_concepts(db_path)

    output_path.write_text(json.dumps(results, indent=2))
    print(f"\nWrote {len(results)} clusters to {output_path}")

    # Print top clusters
    print("\nTop clusters by member count:")
    for g in results[:30]:
        if g["memberCount"] > 1:
            print(f"  {g['canonical']} ({g['memberCount']} members)")
            for m in g["members"]:
                print(f"    - {m}")


if __name__ == "__main__":
    main()
