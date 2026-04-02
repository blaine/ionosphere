import type Database from "better-sqlite3";
import { ensureProfile } from "./profiles.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JetstreamEvent {
  did: string;
  kind: "commit" | "identity" | "account";
  commit?: {
    operation: "create" | "update" | "delete";
    collection: string;
    rkey: string;
    record?: Record<string, unknown>;
    cid: string;
    rev: string;
  };
  time_us: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const IONOSPHERE_COLLECTIONS = [
  "tv.ionosphere.event",
  "tv.ionosphere.talk",
  "tv.ionosphere.speaker",
  "tv.ionosphere.concept",
  "tv.ionosphere.transcript",
  "tv.ionosphere.annotation",
  "tv.ionosphere.comment",
  "org.relationaltext.lens",
];

const COLLECTIONS_SET = new Set(IONOSPHERE_COLLECTIONS);

// ─── Event processor ──────────────────────────────────────────────────────────

export function processEvent(db: Database.Database, event: JetstreamEvent): void {
  if (event.kind !== "commit" || !event.commit) return;

  const { operation, collection, rkey, record } = event.commit;
  if (!COLLECTIONS_SET.has(collection)) return;

  const uri = `at://${event.did}/${collection}/${rkey}`;

  // ── Deletes ───────────────────────────────────────────────────────────────

  if (operation === "delete") {
    switch (collection) {
      case "tv.ionosphere.event":
        db.prepare("DELETE FROM events WHERE uri = ?").run(uri);
        break;
      case "tv.ionosphere.talk":
        db.prepare("DELETE FROM talk_speakers WHERE talk_uri = ?").run(uri);
        db.prepare("DELETE FROM talk_concepts WHERE talk_uri = ?").run(uri);
        db.prepare("DELETE FROM talk_crossrefs WHERE from_talk_uri = ? OR to_talk_uri = ?").run(uri, uri);
        db.prepare("DELETE FROM talks WHERE uri = ?").run(uri);
        break;
      case "tv.ionosphere.speaker":
        db.prepare("DELETE FROM talk_speakers WHERE speaker_uri = ?").run(uri);
        db.prepare("DELETE FROM speakers WHERE uri = ?").run(uri);
        break;
      case "tv.ionosphere.concept":
        db.prepare("DELETE FROM talk_concepts WHERE concept_uri = ?").run(uri);
        db.prepare("DELETE FROM concepts WHERE uri = ?").run(uri);
        break;
      case "tv.ionosphere.transcript":
        db.prepare("DELETE FROM transcripts WHERE uri = ?").run(uri);
        break;
      case "tv.ionosphere.annotation":
        db.prepare("DELETE FROM annotations WHERE uri = ?").run(uri);
        // Recompute talk_concepts for affected talk
        rebuildTalkConcepts(db, uri);
        break;
      case "tv.ionosphere.comment":
        db.prepare("DELETE FROM comments WHERE uri = ?").run(uri);
        break;
      case "org.relationaltext.lens":
        db.prepare("DELETE FROM lenses WHERE uri = ?").run(uri);
        break;
    }
    return;
  }

  // ── Creates / Updates ─────────────────────────────────────────────────────

  if (!record) return;

  switch (collection) {
    case "tv.ionosphere.event":
      indexEvent(db, event.did, rkey, uri, record);
      break;
    case "tv.ionosphere.talk":
      indexTalk(db, event.did, rkey, uri, record);
      break;
    case "tv.ionosphere.speaker":
      indexSpeaker(db, event.did, rkey, uri, record);
      break;
    case "tv.ionosphere.concept":
      indexConcept(db, event.did, rkey, uri, record);
      break;
    case "tv.ionosphere.transcript":
      indexTranscript(db, event.did, rkey, uri, record);
      break;
    case "tv.ionosphere.annotation":
      indexAnnotation(db, event.did, rkey, uri, record);
      break;
    case "tv.ionosphere.comment":
      indexUserComment(db, event.did, rkey, uri, record);
      break;
    case "org.relationaltext.lens":
      indexLens(db, event.did, rkey, uri, record);
      break;
  }
}

// ─── Individual indexers ──────────────────────────────────────────────────────

function indexEvent(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  db.prepare(
    `INSERT OR REPLACE INTO events
     (uri, did, rkey, name, description, location, starts_at, ends_at, tracks, schedule_repo, vod_repo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri,
    did,
    rkey,
    record.name as string,
    (record.description as string) || null,
    (record.location as string) || null,
    record.startsAt as string,
    record.endsAt as string,
    record.tracks ? JSON.stringify(record.tracks) : null,
    (record.scheduleRepo as string) || null,
    (record.vodRepo as string) || null
  );
}

function indexTalk(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  db.prepare(
    `INSERT OR REPLACE INTO talks
     (uri, did, rkey, title, description, video_uri, video_offset_ns, schedule_uri, event_uri, room, category, talk_type, starts_at, ends_at, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri,
    did,
    rkey,
    record.title as string,
    (record.description as string) || null,
    (record.videoUri as string) || null,
    (record.videoOffsetNs as number) || 0,
    (record.scheduleUri as string) || null,
    (record.eventUri as string) || null,
    (record.room as string) || null,
    (record.category as string) || null,
    (record.talkType as string) || null,
    (record.startsAt as string) || null,
    (record.endsAt as string) || null,
    (record.duration as number) || 0
  );

  // Update speaker join table
  const speakerUris = record.speakerUris as string[] | undefined;
  if (speakerUris) {
    db.prepare("DELETE FROM talk_speakers WHERE talk_uri = ?").run(uri);
    const insertTs = db.prepare(
      "INSERT OR IGNORE INTO talk_speakers (talk_uri, speaker_uri) VALUES (?, ?)"
    );
    for (const speakerUri of speakerUris) {
      insertTs.run(uri, speakerUri);
    }
  }
}

function indexSpeaker(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  db.prepare(
    `INSERT OR REPLACE INTO speakers
     (uri, did, rkey, name, handle, speaker_did, bio, affiliations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri,
    did,
    rkey,
    record.name as string,
    (record.handle as string) || null,
    (record.did as string) || null,
    (record.bio as string) || null,
    record.affiliations ? JSON.stringify(record.affiliations) : null
  );
}

function indexConcept(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  db.prepare(
    `INSERT OR REPLACE INTO concepts
     (uri, did, rkey, name, aliases, description, wikidata_id, url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri,
    did,
    rkey,
    record.name as string,
    record.aliases ? JSON.stringify(record.aliases) : null,
    (record.description as string) || null,
    (record.wikidataId as string) || null,
    (record.url as string) || null
  );
}

function indexTranscript(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  db.prepare(
    `INSERT OR REPLACE INTO transcripts
     (uri, did, rkey, talk_uri, text, start_ms, timings)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri,
    did,
    rkey,
    record.talkUri as string,
    record.text as string,
    record.startMs as number,
    JSON.stringify(record.timings)
  );
}

function indexAnnotation(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  const talkUri = (record.talkUri as string) || null;
  const transcriptUri = record.transcriptUri as string;
  const conceptUri = record.conceptUri as string;

  db.prepare(
    `INSERT OR REPLACE INTO annotations
     (uri, did, rkey, transcript_uri, talk_uri, concept_uri, byte_start, byte_end, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri,
    did,
    rkey,
    transcriptUri,
    talkUri,
    conceptUri,
    record.byteStart as number,
    record.byteEnd as number,
    (record.text as string) || null
  );

  // Maintain talk_concepts join: if this annotation links a concept to a talk,
  // ensure there's a row in talk_concepts
  if (talkUri && conceptUri) {
    db.prepare(
      `INSERT OR IGNORE INTO talk_concepts (talk_uri, concept_uri, mention_count)
       VALUES (?, ?, 1)`
    ).run(talkUri, conceptUri);

    // Update mention count
    db.prepare(
      `UPDATE talk_concepts SET mention_count = (
        SELECT COUNT(*) FROM annotations
        WHERE talk_uri = ? AND concept_uri = ?
      ) WHERE talk_uri = ? AND concept_uri = ?`
    ).run(talkUri, conceptUri, talkUri, conceptUri);
  }
}

function indexLens(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  db.prepare(
    `INSERT OR REPLACE INTO lenses
     (uri, did, rkey, source_nsid, target_nsid, version, chain_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri,
    did,
    rkey,
    (record.source as string) || null,
    (record.target as string) || null,
    (record.version as number) || 1,
    (record.specJson as string) ?? (record.chainJson ? JSON.stringify(record.chainJson) : null)
  );
}

function indexUserComment(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  const anchor = record.anchor as { byteStart: number; byteEnd: number } | undefined;
  db.prepare(
    `INSERT OR REPLACE INTO comments
     (uri, author_did, rkey, subject_uri, text, facets, byte_start, byte_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri,
    did,
    rkey,
    record.subject as string,
    record.text as string,
    record.facets ? JSON.stringify(record.facets) : null,
    anchor?.byteStart ?? null,
    anchor?.byteEnd ?? null,
    record.createdAt as string
  );

  ensureProfile(db, did);
}

function rebuildTalkConcepts(db: Database.Database, _deletedUri: string): void {
  // Full rebuild — simple and correct for now
  db.prepare("DELETE FROM talk_concepts").run();
  db.prepare(
    `INSERT INTO talk_concepts (talk_uri, concept_uri, mention_count)
     SELECT talk_uri, concept_uri, COUNT(*) FROM annotations
     WHERE talk_uri IS NOT NULL
     GROUP BY talk_uri, concept_uri`
  ).run();
}
