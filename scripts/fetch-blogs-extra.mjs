/**
 * Fetch additional blog posts from leaflet, pckt, myhub, and other sources.
 * Also fetches OG titles for new blog entries.
 */
import { createRequire } from 'module';
const require = createRequire(
  new URL('../apps/ionosphere-appview/package.json', import.meta.url).pathname
);
const { BskyAgent } = require('@atproto/api');
const Database = require('better-sqlite3');
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'apps', 'data', 'ionosphere.sqlite');

const agent = new BskyAgent({ service: 'https://bsky.social' });
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchOgTitle(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await globalThis.fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ionosphere.tv/1.0' },
      redirect: 'follow',
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();
    const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (ogMatch) return ogMatch[1];
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : null;
  } catch { return null; }
}

async function main() {
  console.log('=== Fetch Extra Blog Posts ===\n');
  await agent.login({ identifier: 'ionosphere.tv', password: process.env.BOT_PASSWORD });

  const db = new Database(DB_PATH);
  const now = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO mentions (uri, talk_uri, author_did, author_handle, text, created_at,
      talk_offset_ms, byte_position, likes, reposts, replies, parent_uri,
      mention_type, indexed_at, content_type, external_url, og_title, talk_rkey)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uri) DO UPDATE SET
      likes=excluded.likes, reposts=excluded.reposts,
      content_type=CASE WHEN excluded.content_type = 'blog' THEN 'blog' ELSE mentions.content_type END,
      external_url=COALESCE(excluded.external_url, mentions.external_url),
      og_title=COALESCE(excluded.og_title, mentions.og_title),
      indexed_at=excluded.indexed_at
  `);

  const queries = [
    { q: 'atmosphere', domain: 'leaflet.pub' },
    { q: 'atmosphereconf', domain: 'leaflet.pub' },
    { q: 'atmosphere', domain: 'pckt.blog' },
    { q: 'atmosphereconf', domain: 'pckt.blog' },
    { q: 'atmosphere', domain: 'brookie.pckt.blog' },
    { q: 'atmosphere', domain: 'experiments.myhub.ai' },
    { q: 'atmosphere', domain: 'connectedplaces.online' },
    { q: 'atmosphere', domain: 'masnick.com' },
    { q: 'atmosphere', domain: 'cassidyjames.com' },
    { q: 'atmosphere', domain: 'brittanyellich.com' },
    { q: 'atmosphere', domain: 'gui.do' },
    { q: 'atmosphere', domain: 'sooraj.dev' },
    // General blog searches
    { q: 'atmosphereconf wrote blog' },
    { q: 'atmosphereconf wrote about' },
    { q: 'atmosphereconf blog post' },
    { q: 'atmosphereconf reflection' },
    { q: 'atmosphereconf experience wrote' },
  ];

  let count = 0;
  for (const bq of queries) {
    try {
      const params = { q: bq.q, since: '2026-03-25T00:00:00Z', sort: 'top', limit: 50 };
      if (bq.domain) params.domain = bq.domain;
      const res = await agent.app.bsky.feed.searchPosts(params);
      const posts = res.data?.posts || [];
      if (posts.length > 0) console.log(`  "${bq.q}"${bq.domain ? ' domain:' + bq.domain : ''}: ${posts.length}`);

      for (const p of posts) {
        let externalUrl = p.embed?.external?.uri || null;
        if (!externalUrl) {
          const links = (p.record?.facets || []).flatMap(f => f.features || []).filter(f => f.uri).map(f => f.uri);
          externalUrl = links.find(l => !l.includes('bsky.app')) || null;
        }

        upsert.run(
          p.uri, null, p.author.did, p.author.handle,
          p.record?.text, p.record?.createdAt,
          null, null, p.likeCount || 0, p.repostCount || 0, p.replyCount || 0,
          null, 'discussion', now, 'blog', externalUrl, null, null
        );
        count++;
      }
    } catch (e) {
      console.error(`  Error: ${e.message}`);
    }
    await sleep(200);
  }
  console.log(`\nUpserted ${count} blog rows`);

  // Fetch OG titles
  console.log('\n--- OG titles ---');
  const needOg = db.prepare(
    "SELECT uri, external_url FROM mentions WHERE content_type = 'blog' AND external_url IS NOT NULL AND og_title IS NULL"
  ).all();
  const updateOg = db.prepare('UPDATE mentions SET og_title = ? WHERE uri = ?');
  let ogCount = 0;
  for (const row of needOg) {
    const title = await fetchOgTitle(row.external_url);
    if (title) { updateOg.run(title, row.uri); ogCount++; console.log(`  ${row.external_url} → ${title}`); }
    await sleep(100);
  }
  console.log(`Fetched ${ogCount}/${needOg.length} OG titles`);

  // Profile backfill
  const missing = db.prepare('SELECT DISTINCT m.author_did FROM mentions m LEFT JOIN profiles p ON m.author_did = p.did WHERE p.did IS NULL').all();
  const profileUpsert = db.prepare('INSERT OR REPLACE INTO profiles (did, handle, display_name, avatar_url, fetched_at) VALUES (?, ?, ?, ?, ?)');
  let pCount = 0;
  for (const { author_did: did } of missing) {
    try {
      const r = await globalThis.fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`);
      if (r.ok) { const d = await r.json(); profileUpsert.run(did, d.handle || null, d.displayName || null, d.avatar || null, now); pCount++; }
    } catch {}
    await sleep(50);
  }
  if (pCount) console.log(`New profiles: ${pCount}`);

  console.log('\nBlogs total:', db.prepare("SELECT COUNT(*) as c FROM mentions WHERE content_type = 'blog'").get().c);
  db.close();
}

main().catch(console.error);
