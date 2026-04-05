/**
 * Just backfill the DB from production PDS and exit cleanly.
 * Usage: npx tsx src/backfill-only.ts
 */
import { openDb, migrate } from "./db.js";
import { backfill } from "./backfill.js";

const PDS_URL = process.env.PDS_URL || "https://jellybaby.us-east.host.bsky.network";
const DID = "did:plc:lkeq4oghyhnztbu4dxr3joff";

const db = openDb();
// Force DELETE journal mode so the DB file is self-contained (no WAL)
db.pragma("journal_mode = DELETE");
migrate(db);
console.log("Tables created, DB:", db.name);

await backfill(db, PDS_URL, DID);

const count = db.prepare("SELECT COUNT(*) as c FROM talks").get() as { c: number };
console.log(`Talks: ${count.c}`);

db.pragma("wal_checkpoint(TRUNCATE)");
db.close();
console.log("DB closed cleanly");
