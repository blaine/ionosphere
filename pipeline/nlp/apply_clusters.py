"""Apply concept clusters to the database.

For each cluster with multiple members:
1. Keep the canonical concept record
2. Update its aliases to include all member names
3. Rewire talk_concepts references from merged concepts to the canonical
4. Delete the merged (non-canonical) concept records
"""

import json
import sqlite3
from pathlib import Path


def apply_clusters(db_path: str, clusters_path: str, dry_run: bool = False):
    clusters = json.loads(Path(clusters_path).read_text())

    multi = [c for c in clusters if c["memberCount"] > 1]
    print(f"Applying {len(multi)} multi-member clusters to database")

    conn = sqlite3.connect(db_path)

    # Build a map of concept name → URI for all concepts
    name_to_uri = {}
    for row in conn.execute("SELECT name, uri FROM concepts"):
        name_to_uri[row[0]] = row[1]

    merged_count = 0
    deleted_count = 0
    rewired_count = 0

    for cluster in multi:
        canonical_name = cluster["canonical"]
        canonical_uri = name_to_uri.get(canonical_name)
        if not canonical_uri:
            # Try to find by rkey
            row = conn.execute("SELECT uri FROM concepts WHERE rkey = ?", (cluster["rkey"],)).fetchone()
            if row:
                canonical_uri = row[0]
            else:
                print(f"  Warning: canonical '{canonical_name}' not found in DB, skipping")
                continue

        # Collect all merged aliases
        all_aliases = set(cluster["aliases"])

        # Find URIs of non-canonical members to merge
        member_uris = []
        for member_name in cluster["members"]:
            if member_name == canonical_name:
                continue
            uri = name_to_uri.get(member_name)
            if uri and uri != canonical_uri:
                member_uris.append(uri)

        if not member_uris:
            continue

        if not dry_run:
            # Update canonical concept's aliases
            alias_json = json.dumps(sorted(all_aliases))
            conn.execute(
                "UPDATE concepts SET aliases = ? WHERE uri = ?",
                (alias_json, canonical_uri),
            )

            # Rewire talk_concepts from merged → canonical
            for old_uri in member_uris:
                # Check if canonical already has a link to this talk
                rows = conn.execute(
                    "SELECT talk_uri FROM talk_concepts WHERE concept_uri = ?",
                    (old_uri,),
                ).fetchall()
                for (talk_uri,) in rows:
                    existing = conn.execute(
                        "SELECT 1 FROM talk_concepts WHERE talk_uri = ? AND concept_uri = ?",
                        (talk_uri, canonical_uri),
                    ).fetchone()
                    if existing:
                        # Already linked — just delete the old one
                        conn.execute(
                            "DELETE FROM talk_concepts WHERE talk_uri = ? AND concept_uri = ?",
                            (talk_uri, old_uri),
                        )
                    else:
                        # Rewire
                        conn.execute(
                            "UPDATE talk_concepts SET concept_uri = ? WHERE talk_uri = ? AND concept_uri = ?",
                            (canonical_uri, talk_uri, old_uri),
                        )
                        rewired_count += 1

                # Delete the merged concept
                conn.execute("DELETE FROM concepts WHERE uri = ?", (old_uri,))
                deleted_count += 1

            merged_count += 1

        else:
            print(f"  Would merge {len(member_uris)} concepts into '{canonical_name}'")

    if not dry_run:
        conn.commit()

    conn.close()

    print(f"\nResults:")
    print(f"  Clusters applied: {merged_count}")
    print(f"  Concepts deleted: {deleted_count}")
    print(f"  talk_concepts rewired: {rewired_count}")
    print(f"  Remaining concepts: check with SELECT COUNT(*) FROM concepts")


def main():
    db_path = str(Path(__file__).resolve().parent.parent.parent / "apps" / "data" / "ionosphere.sqlite")
    clusters_path = str(Path(__file__).resolve().parent.parent / "data" / "concept-clusters.json")

    # Show what we'd do first
    print("=== DRY RUN ===")
    apply_clusters(db_path, clusters_path, dry_run=True)

    print("\n=== APPLYING ===")
    apply_clusters(db_path, clusters_path, dry_run=False)

    # Verify
    conn = sqlite3.connect(db_path)
    count = conn.execute("SELECT COUNT(*) FROM concepts").fetchone()[0]
    print(f"\nFinal concept count: {count}")
    conn.close()


if __name__ == "__main__":
    main()
