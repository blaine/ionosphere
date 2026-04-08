import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = process.env.DB_PATH || path.resolve(
  import.meta.dirname,
  "../../data/ionosphere.sqlite"
);

export function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  // FK checks disabled — records arrive via Jetstream in arbitrary order.
  // An eventually-consistent indexer can't enforce referential integrity
  // at write time. The data is correct once all records are indexed.
  db.pragma("foreign_keys = OFF");
  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      location TEXT,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      tracks TEXT,
      schedule_repo TEXT,
      vod_repo TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS speakers (
      uri TEXT PRIMARY KEY,
      did TEXT,
      rkey TEXT NOT NULL,
      name TEXT NOT NULL,
      handle TEXT,
      speaker_did TEXT,
      bio TEXT,
      affiliations TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS talks (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      document TEXT,
      video_uri TEXT,
      video_offset_ns INTEGER DEFAULT 0,
      video_segments TEXT,
      schedule_uri TEXT,
      event_uri TEXT,
      room TEXT,
      category TEXT,
      talk_type TEXT,
      starts_at TEXT,
      ends_at TEXT,
      duration INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS talk_speakers (
      talk_uri TEXT NOT NULL,
      speaker_uri TEXT NOT NULL,
      PRIMARY KEY (talk_uri, speaker_uri),
      FOREIGN KEY (talk_uri) REFERENCES talks(uri) ON DELETE CASCADE,
      FOREIGN KEY (speaker_uri) REFERENCES speakers(uri) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS concepts (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases TEXT,
      description TEXT,
      wikidata_id TEXT,
      url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS talk_concepts (
      talk_uri TEXT NOT NULL,
      concept_uri TEXT NOT NULL,
      mention_count INTEGER DEFAULT 1,
      PRIMARY KEY (talk_uri, concept_uri),
      FOREIGN KEY (talk_uri) REFERENCES talks(uri) ON DELETE CASCADE,
      FOREIGN KEY (concept_uri) REFERENCES concepts(uri) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS talk_crossrefs (
      from_talk_uri TEXT NOT NULL,
      to_talk_uri TEXT NOT NULL,
      PRIMARY KEY (from_talk_uri, to_talk_uri),
      FOREIGN KEY (from_talk_uri) REFERENCES talks(uri) ON DELETE CASCADE,
      FOREIGN KEY (to_talk_uri) REFERENCES talks(uri) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      talk_uri TEXT NOT NULL,
      text TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      timings TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (talk_uri) REFERENCES talks(uri) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pipeline_status (
      talk_uri TEXT PRIMARY KEY,
      ingested INTEGER DEFAULT 0,
      transcribed INTEGER DEFAULT 0,
      assembled INTEGER DEFAULT 0,
      enriched INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (talk_uri) REFERENCES talks(uri) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS annotations (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      transcript_uri TEXT NOT NULL,
      talk_uri TEXT,
      concept_uri TEXT NOT NULL,
      byte_start INTEGER NOT NULL,
      byte_end INTEGER NOT NULL,
      text TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lenses (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      source_nsid TEXT,
      target_nsid TEXT,
      version INTEGER DEFAULT 1,
      chain_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS comments (
      uri TEXT PRIMARY KEY,
      author_did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      subject_uri TEXT NOT NULL,
      text TEXT NOT NULL,
      facets TEXT,
      byte_start INTEGER,
      byte_end INTEGER,
      created_at TEXT NOT NULL,
      indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_comments_subject ON comments(subject_uri);
    CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_did);

    CREATE TABLE IF NOT EXISTS profiles (
      did TEXT PRIMARY KEY,
      handle TEXT,
      display_name TEXT,
      avatar_url TEXT,
      fetched_at TEXT
    );

    CREATE TABLE IF NOT EXISTS streams (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      room TEXT NOT NULL,
      day_label TEXT NOT NULL,
      stream_video_uri TEXT NOT NULL,
      duration_seconds REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stream_transcripts (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      stream_uri TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      timings TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stream_diarizations (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      stream_uri TEXT NOT NULL,
      segments TEXT NOT NULL,
      speaker_count INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Jetstream cursor for resumable indexing
    CREATE TABLE IF NOT EXISTS _cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cursor_us INTEGER
    );
    INSERT OR IGNORE INTO _cursor (id, cursor_us) VALUES (1, NULL);
  `);
}

export function getCursor(db: Database.Database): number | null {
  const row = db.prepare("SELECT cursor_us FROM _cursor WHERE id = 1").get() as any;
  return row?.cursor_us ?? null;
}

export function setCursor(db: Database.Database, cursor: number): void {
  db.prepare("UPDATE _cursor SET cursor_us = ? WHERE id = 1").run(cursor);
}
