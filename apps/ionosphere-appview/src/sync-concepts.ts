/**
 * Sync concept records from PDS to SQLite appview.
 * Temporary bridge until the appview indexes from Jetstream.
 */
import { openDb, migrate } from "./db.js";

const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const DID = process.argv[2];

if (!DID) {
  // Try to get DID from the database
  const db = openDb();
  const talk = db.prepare("SELECT did FROM talks LIMIT 1").get() as any;
  if (talk) {
    console.log(`Using DID from database: ${talk.did}`);
    await run(talk.did);
  } else {
    console.error("Usage: npx tsx src/sync-concepts.ts <did>");
    process.exit(1);
  }
  db.close();
} else {
  await run(DID);
}

async function run(did: string) {
  const res = await fetch(
    `${PDS_URL}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=tv.ionosphere.concept&limit=100`
  );
  const data = await res.json();

  const db = openDb();
  migrate(db);

  const insert = db.prepare(
    "INSERT OR REPLACE INTO concepts (uri, did, rkey, name, aliases, description, wikidata_id, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  // Get all talk URIs for this DID to create join table entries
  const talks = db
    .prepare("SELECT uri, rkey FROM talks WHERE did = ?")
    .all(did) as Array<{ uri: string; rkey: string }>;

  // For now, link concepts to talks that have transcripts
  // (only enriched talks should have concept links)
  const transcribedTalks = db
    .prepare(
      "SELECT t.uri FROM talks t JOIN transcripts tr ON tr.talk_uri = t.uri"
    )
    .all() as Array<{ uri: string }>;

  const insertTc = db.prepare(
    "INSERT OR IGNORE INTO talk_concepts (talk_uri, concept_uri, mention_count) VALUES (?, ?, 1)"
  );

  for (const r of data.records) {
    const v = r.value;
    const rkey = r.uri.split("/").pop()!;
    insert.run(
      r.uri,
      did,
      rkey,
      v.name,
      JSON.stringify(v.aliases || []),
      v.description || null,
      v.wikidataId || null,
      v.url || null
    );

    // Link to all transcribed talks (rough — proper linking needs per-talk enrichment)
    for (const t of transcribedTalks) {
      insertTc.run(t.uri, r.uri);
    }

    console.log(`  + ${v.name}`);
  }

  console.log(`\nSynced ${data.records.length} concepts from PDS to SQLite`);
  db.close();
}
