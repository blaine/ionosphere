import type Database from "better-sqlite3";
import { ensureProfile } from "./profiles.js";
import {
  indexExpression,
  indexSegmentation,
  indexAnnotationLayer,
  deleteExpression,
  deleteSegmentation,
  deleteAnnotationLayer,
  rebuildDocument,
} from "./layers-indexer.js";

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

// ─── Bot DID filter ──────────────────────────────────────────────────────────

let _botDid = "";

/** Set the bot DID for filtering layers.pub records. Called from appview.ts. */
export function setBotDid(did: string): void {
  _botDid = did;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const IONOSPHERE_COLLECTIONS = [
  "tv.ionosphere.event",
  "tv.ionosphere.talk",
  "tv.ionosphere.speaker",
  "tv.ionosphere.concept",
  "tv.ionosphere.transcript",
  "tv.ionosphere.comment",
  "tv.ionosphere.stream",
  "tv.ionosphere.streamTranscript",
  "tv.ionosphere.diarization",
  "org.relationaltext.lens",
  "pub.layers.expression.expression",
  "pub.layers.segmentation.segmentation",
  "pub.layers.annotation.annotationLayer",
];

const COLLECTIONS_SET = new Set(IONOSPHERE_COLLECTIONS);

const LAYERS_PUB_COLLECTIONS = new Set([
  "pub.layers.expression.expression",
  "pub.layers.segmentation.segmentation",
  "pub.layers.annotation.annotationLayer",
]);

// ─── Event processor ──────────────────────────────────────────────────────────

export function processEvent(db: Database.Database, event: JetstreamEvent): void {
  if (event.kind !== "commit" || !event.commit) return;

  const { operation, collection, rkey, record } = event.commit;
  if (!COLLECTIONS_SET.has(collection)) return;

  const uri = `at://${event.did}/${collection}/${rkey}`;

  // Only process layers.pub records from the bot DID
  if (LAYERS_PUB_COLLECTIONS.has(collection) && _botDid && event.did !== _botDid) {
    return;
  }

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
      case "tv.ionosphere.comment":
        db.prepare("DELETE FROM comments WHERE uri = ?").run(uri);
        break;
      case "tv.ionosphere.stream":
        db.prepare("DELETE FROM streams WHERE uri = ?").run(uri);
        break;
      case "tv.ionosphere.streamTranscript":
        db.prepare("DELETE FROM stream_transcripts WHERE uri = ?").run(uri);
        break;
      case "tv.ionosphere.diarization":
        db.prepare("DELETE FROM stream_diarizations WHERE uri = ?").run(uri);
        break;
      case "org.relationaltext.lens":
        db.prepare("DELETE FROM lenses WHERE uri = ?").run(uri);
        break;
      case "pub.layers.expression.expression":
        deleteExpression(db, uri);
        break;
      case "pub.layers.segmentation.segmentation":
        deleteSegmentation(db, uri);
        break;
      case "pub.layers.annotation.annotationLayer":
        deleteAnnotationLayer(db, uri);
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
    case "tv.ionosphere.comment":
      indexUserComment(db, event.did, rkey, uri, record);
      break;
    case "tv.ionosphere.stream":
      indexStream(db, event.did, rkey, uri, record);
      break;
    case "tv.ionosphere.streamTranscript":
      indexStreamTranscript(db, event.did, rkey, uri, record);
      break;
    case "tv.ionosphere.diarization":
      indexDiarization(db, event.did, rkey, uri, record);
      break;
    case "org.relationaltext.lens":
      indexLens(db, event.did, rkey, uri, record);
      break;
    case "pub.layers.expression.expression":
      indexExpression(db, event.did, rkey, uri, record);
      rebuildDocument(db, uri).catch((err) =>
        console.error("rebuildDocument error:", err),
      );
      break;
    case "pub.layers.segmentation.segmentation":
      indexSegmentation(db, event.did, rkey, uri, record);
      rebuildDocument(db, (record.expression as string) || "").catch((err) =>
        console.error("rebuildDocument error:", err),
      );
      break;
    case "pub.layers.annotation.annotationLayer":
      indexAnnotationLayer(db, event.did, rkey, uri, record);
      rebuildDocument(db, (record.expression as string) || "").catch((err) =>
        console.error("rebuildDocument error:", err),
      );
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
  const videoSegments = record.videoSegments
    ? JSON.stringify(record.videoSegments)
    : null;

  db.prepare(
    `INSERT OR REPLACE INTO talks
     (uri, did, rkey, title, description, video_uri, video_offset_ns, video_segments, schedule_uri, event_uri, room, category, talk_type, starts_at, ends_at, duration, document)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri,
    did,
    rkey,
    record.title as string,
    (record.description as string) || null,
    (record.videoUri as string) || null,
    (record.videoOffsetNs as number) || 0,
    videoSegments,
    (record.scheduleUri as string) || null,
    (record.eventUri as string) || null,
    (record.room as string) || null,
    (record.category as string) || null,
    (record.talkType as string) || null,
    (record.startsAt as string) || null,
    (record.endsAt as string) || null,
    (record.duration as number) || 0,
    (record.document as string) ? JSON.stringify(record.document) : null
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

function indexStream(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  db.prepare(
    `INSERT OR REPLACE INTO streams
     (uri, did, rkey, name, slug, room, day_label, stream_video_uri, duration_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri, did, rkey,
    record.name as string,
    record.slug as string,
    record.room as string,
    record.dayLabel as string,
    record.streamVideoUri as string,
    record.durationSeconds as number,
  );
}

function indexStreamTranscript(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  db.prepare(
    `INSERT OR REPLACE INTO stream_transcripts
     (uri, did, rkey, stream_uri, chunk_index, text, start_ms, timings)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri, did, rkey,
    record.streamUri as string,
    (record.chunkIndex as number) ?? 0,
    record.text as string,
    record.startMs as number,
    JSON.stringify(record.timings),
  );
}

function indexDiarization(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  db.prepare(
    `INSERT OR REPLACE INTO stream_diarizations
     (uri, did, rkey, stream_uri, chunk_index, segments, speaker_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri, did, rkey,
    record.streamUri as string,
    (record.chunkIndex as number) ?? 0,
    JSON.stringify(record.segments),
    record.speakerCount as number,
  );
}

