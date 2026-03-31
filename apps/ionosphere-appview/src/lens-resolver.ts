import type Database from "better-sqlite3";

const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.test";

interface ResolvedLens {
  chainJson: string;
  source: string;
  target: string;
}

/**
 * Resolve a lens by source and target NSID.
 *
 * Resolution order:
 * 1. Appview SQLite index (fast, local)
 * 2. PDS direct fetch (always available after publish)
 * 3. null (not found)
 */
export async function resolveLensRecord(
  source: string,
  target: string,
  db?: Database.Database
): Promise<ResolvedLens | null> {
  // 1. Try appview index first (if db handle provided)
  if (db) {
    const row = db
      .prepare(
        "SELECT source_nsid, target_nsid, chain_json FROM lenses WHERE source_nsid = ? AND target_nsid = ? LIMIT 1"
      )
      .get(source, target) as any;
    if (row?.chain_json) {
      return {
        chainJson: row.chain_json,
        source: row.source_nsid,
        target: row.target_nsid,
      };
    }
  }

  // 2. Fall back to PDS direct fetch
  try {
    const handleRes = await fetch(
      `${PDS_URL}/xrpc/com.atproto.identity.resolveHandle?handle=${BOT_HANDLE}`
    );
    if (!handleRes.ok) return null;
    const { did } = (await handleRes.json()) as { did: string };

    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({
        repo: did,
        collection: "org.relationaltext.lens",
        limit: "100",
      });
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(
        `${PDS_URL}/xrpc/com.atproto.repo.listRecords?${params}`
      );
      if (!res.ok) return null;
      const data = await res.json();

      for (const record of data.records || []) {
        const v = record.value;
        if (v.source === source && v.target === target) {
          return {
            chainJson: v.specJson ?? v.chainJson,
            source: v.source,
            target: v.target,
          };
        }
      }

      cursor = data.cursor;
    } while (cursor);
  } catch {
    // PDS not available
  }

  return null;
}
