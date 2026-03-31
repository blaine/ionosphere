/**
 * Backfill the appview from the PDS via XRPC listRecords.
 *
 * Reads all ionosphere records from the PDS and processes them
 * through the same indexer that handles Jetstream events.
 * This is the initial sync — Jetstream handles live updates after.
 */
import type Database from "better-sqlite3";
import { IONOSPHERE_COLLECTIONS, processEvent } from "./indexer.js";
import type { JetstreamEvent } from "./indexer.js";

export async function backfill(
  db: Database.Database,
  pdsUrl: string,
  did: string
): Promise<void> {
  console.log(`Backfilling from ${pdsUrl} (${did})...`);

  let totalRecords = 0;

  for (const collection of IONOSPHERE_COLLECTIONS) {
    let cursor: string | undefined;
    let collectionCount = 0;

    do {
      const params = new URLSearchParams({
        repo: did,
        collection,
        limit: "100",
      });
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(
        `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`
      );
      if (!res.ok) {
        console.warn(`  Failed to fetch ${collection}: ${res.status}`);
        break;
      }

      const data = await res.json();
      const records = data.records || [];

      for (const record of records) {
        const rkey = record.uri.split("/").pop()!;

        // Synthesize a Jetstream-like event for the indexer
        const event: JetstreamEvent = {
          did,
          kind: "commit",
          commit: {
            operation: "create",
            collection,
            rkey,
            record: record.value,
            cid: record.cid,
            rev: "",
          },
          time_us: Date.now() * 1000,
        };

        try {
          processEvent(db, event);
          collectionCount++;
        } catch (err) {
          console.warn(
            `  Failed to index ${collection}/${rkey}:`,
            (err as Error).message
          );
        }
      }

      cursor = data.cursor;
    } while (cursor);

    if (collectionCount > 0) {
      console.log(`  ${collection}: ${collectionCount} records`);
    }
    totalRecords += collectionCount;
  }

  console.log(`Backfill complete: ${totalRecords} records indexed`);
}
