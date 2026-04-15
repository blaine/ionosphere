import type Database from "better-sqlite3";
import { JetstreamClient } from "./jetstream.js";
import { processEvent, type JetstreamEvent } from "./indexer.js";

const PUBLIC_JETSTREAM_URL = process.env.PUBLIC_JETSTREAM_URL ?? "wss://jetstream1.us-east.bsky.network";

export function startPublicJetstream(db: Database.Database): JetstreamClient {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _public_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cursor_us INTEGER
    );
    INSERT OR IGNORE INTO _public_cursor (id, cursor_us) VALUES (1, NULL);
  `);

  const getCursor = (): number | null => {
    const row = db.prepare("SELECT cursor_us FROM _public_cursor WHERE id = 1").get() as any;
    const cursor = row?.cursor_us ?? null;

    // The public Jetstream is filtered to tv.ionosphere.* collections only,
    // so volume is tiny — safe to replay up to 72h (Jetstream retention limit).
    // Only skip if cursor is older than that.
    if (cursor !== null) {
      const nowUs = Date.now() * 1000;
      const behindS = (nowUs - cursor) / 1e6;
      if (behindS > 72 * 3600) {
        console.log(`[Public Jetstream] Cursor ${(behindS / 3600).toFixed(0)}h behind (>72h), skipping to now`);
        return null;
      }
      console.log(`[Public Jetstream] Replaying from ${(behindS / 60).toFixed(0)}min ago`);
    }

    return cursor;
  };

  const setCursor = (cursor: number): void => {
    db.prepare("UPDATE _public_cursor SET cursor_us = ? WHERE id = 1").run(cursor);
  };

  const client = new JetstreamClient({
    url: PUBLIC_JETSTREAM_URL,
    // Subscribe to ALL ionosphere collections from any DID — discovers
    // commenters, reactions, and any future record types automatically
    wantedCollections: [
      "tv.ionosphere.comment",
      "tv.ionosphere.event",
      "tv.ionosphere.talk",
      "tv.ionosphere.speaker",
      "tv.ionosphere.concept",
      "tv.ionosphere.transcript",
      "tv.ionosphere.stream",
      "tv.ionosphere.streamTranscript",
      "tv.ionosphere.diarization",
    ],
    getCursor,
    setCursor,
    onEvent: (event) => {
      try {
        processEvent(db, event);
      } catch (err) {
        console.error("Public Jetstream indexer error:", err);
      }
    },
    onError: (err) => console.error("Public Jetstream error:", err),
  });

  // Backfill comments from known authors on startup
  backfillComments(db).catch((err) =>
    console.error("[Public Jetstream] Backfill error:", err)
  );

  return client;
}

/**
 * Backfill comments from known authors + any DIDs already in the DB.
 * Fetches their tv.ionosphere.comment records directly from their PDS
 * to catch anything the Jetstream missed.
 *
 * Seed DIDs ensure comments are recovered even after a fresh DB.
 */
const SEED_COMMENT_AUTHORS = [
  "did:plc:2zmxikig2sj7gqaezl5gntae",
  "did:plc:3vdrgzr2zybocs45yfhcr6ur",
];

async function backfillComments(db: Database.Database): Promise<void> {
  const dbAuthors = db
    .prepare("SELECT DISTINCT author_did FROM comments")
    .all() as { author_did: string }[];

  const authorSet = new Set([
    ...SEED_COMMENT_AUTHORS,
    ...dbAuthors.map((a) => a.author_did),
  ]);
  const authors = [...authorSet].map((did) => ({ author_did: did }));

  if (authors.length === 0) return;

  for (const { author_did } of authors) {
    try {
      // Resolve DID to PDS endpoint
      const didDoc = await fetch(
        `https://plc.directory/${author_did}`
      ).then((r) => r.json());

      const pdsEndpoint = didDoc?.service?.find(
        (s: any) => s.type === "AtprotoPersonalDataServer"
      )?.serviceEndpoint;

      if (!pdsEndpoint) continue;

      // Fetch all comments from this author's PDS
      let cursor: string | undefined;
      let total = 0;
      do {
        const params = new URLSearchParams({
          repo: author_did,
          collection: "tv.ionosphere.comment",
          limit: "100",
        });
        if (cursor) params.set("cursor", cursor);

        const res = await fetch(
          `${pdsEndpoint}/xrpc/com.atproto.repo.listRecords?${params}`
        );
        if (!res.ok) break;
        const data = await res.json();

        for (const record of data.records || []) {
          const rkey = record.uri.split("/").pop()!;
          const event: JetstreamEvent = {
            did: author_did,
            kind: "commit",
            commit: {
              operation: "create",
              collection: "tv.ionosphere.comment",
              rkey,
              record: record.value,
              cid: record.cid || "",
              rev: "",
            },
            time_us: Date.now() * 1000,
          };
          try {
            processEvent(db, event);
            total++;
          } catch {}
        }

        cursor = data.cursor;
      } while (cursor);

      if (total > 0) {
        console.log(`[Public Jetstream] Backfilled ${total} comments from ${author_did.slice(0, 24)}...`);
      }
    } catch {}
  }
}
