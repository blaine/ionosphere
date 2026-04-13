/**
 * Backfill profiles for all DIDs found in the mentions table
 * that are not yet cached in the profiles table.
 */

import { createRequire } from 'module';
const require = createRequire(
  new URL('../apps/ionosphere-appview/package.json', import.meta.url).pathname
);
const Database = require('better-sqlite3');

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'apps', 'data', 'ionosphere.sqlite');
const PUBLIC_API = 'https://public.api.bsky.app';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const db = new Database(DB_PATH);

  const missing = db.prepare(`
    SELECT DISTINCT m.author_did
    FROM mentions m
    LEFT JOIN profiles p ON m.author_did = p.did
    WHERE p.did IS NULL
  `).all();

  console.log(`${missing.length} profiles to fetch\n`);

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO profiles (did, handle, display_name, avatar_url, fetched_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  let fetched = 0;
  let failed = 0;

  for (const { author_did: did } of missing) {
    try {
      const res = await fetch(
        `${PUBLIC_API}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
      );
      if (res.ok) {
        const data = await res.json();
        upsert.run(
          did,
          data.handle || null,
          data.displayName || null,
          data.avatar || null,
          new Date().toISOString()
        );
        fetched++;
        if (fetched % 50 === 0) {
          console.log(`  ${fetched}/${missing.length} fetched...`);
        }
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    await sleep(100);
  }

  console.log(`\nDone: ${fetched} profiles cached, ${failed} failed`);

  // Verify
  const still = db.prepare(`
    SELECT COUNT(DISTINCT m.author_did) as c
    FROM mentions m
    LEFT JOIN profiles p ON m.author_did = p.did
    WHERE p.did IS NULL
  `).get();
  console.log(`Remaining uncached: ${still.c}`);

  db.close();
}

main().catch(console.error);
