import type Database from "better-sqlite3";
import { JetstreamClient } from "./jetstream.js";
import { processEvent } from "./indexer.js";

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
    return row?.cursor_us ?? null;
  };

  const setCursor = (cursor: number): void => {
    db.prepare("UPDATE _public_cursor SET cursor_us = ? WHERE id = 1").run(cursor);
  };

  const client = new JetstreamClient({
    url: PUBLIC_JETSTREAM_URL,
    wantedCollections: ["tv.ionosphere.comment"],
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

  return client;
}
