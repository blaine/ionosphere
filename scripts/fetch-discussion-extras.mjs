/**
 * Fetch additional discussion content: YouTube talks, more blogs, photo posts.
 * Run after fetch-discussion.mjs for supplementary content.
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

function extractLinks(post) {
  return (post.record?.facets || [])
    .flatMap(f => f.features || [])
    .filter(f => f.uri)
    .map(f => f.uri);
}

function hasImages(post) {
  return !!(post.embed?.images?.length || post.embed?.$type?.includes('image'));
}

async function fetchOgTitle(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'ionosphere.tv/1.0' }, redirect: 'follow' });
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
  console.log('=== Fetch Discussion Extras ===\n');
  await agent.login({ identifier: 'ionosphere.tv', password: process.env.BOT_PASSWORD });

  const db = new Database(DB_PATH);
  try { db.exec("ALTER TABLE mentions ADD COLUMN has_images INTEGER DEFAULT 0"); } catch {}

  const upsert = db.prepare(`
    INSERT INTO mentions (uri, talk_uri, author_did, author_handle, text, created_at,
      talk_offset_ms, byte_position, likes, reposts, replies, parent_uri,
      mention_type, indexed_at, content_type, external_url, og_title, talk_rkey, has_images)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uri) DO UPDATE SET
      likes=excluded.likes, reposts=excluded.reposts, replies=excluded.replies,
      content_type=CASE WHEN excluded.content_type != 'post' THEN excluded.content_type ELSE mentions.content_type END,
      external_url=COALESCE(excluded.external_url, mentions.external_url),
      og_title=COALESCE(excluded.og_title, mentions.og_title),
      talk_rkey=COALESCE(excluded.talk_rkey, mentions.talk_rkey),
      has_images=CASE WHEN excluded.has_images = 1 THEN 1 ELSE mentions.has_images END,
      indexed_at=excluded.indexed_at
  `);

  // Load talks for matching
  const talks = db.prepare("SELECT DISTINCT rkey, title, uri FROM talks WHERE starts_at IS NOT NULL").all();
  const talksByRkey = new Map(talks.map(t => [t.rkey, t]));
  const speakerTalks = db.prepare(`
    SELECT s.handle, t.rkey FROM speakers s
    JOIN talk_speakers ts ON ts.speaker_uri = s.uri
    JOIN talks t ON t.uri = ts.talk_uri WHERE s.handle IS NOT NULL
  `).all();
  const speakerToTalks = new Map();
  for (const { handle, rkey } of speakerTalks) {
    if (!speakerToTalks.has(handle)) speakerToTalks.set(handle, []);
    speakerToTalks.get(handle).push(rkey);
  }

  function matchTalk(post, externalUrl) {
    if (externalUrl) {
      const m = externalUrl.match(/ionosphere\.tv\/talks\/([^/?#]+)/);
      if (m && talksByRkey.has(m[1])) return m[1];
      // YouTube — can't match by URL, try speakers
    }
    const text = post.record?.text || '';
    const handles = text.match(/@([\w.-]+)/g) || [];
    for (const h of handles) {
      const clean = h.replace('@', '');
      const t = speakerToTalks.get(clean);
      if (t?.length === 1) return t[0];
    }
    return null;
  }

  const allPosts = new Map();
  const now = new Date().toISOString();

  // ── YouTube talks ────────────────────────────────────────────────
  console.log('--- YouTube talks ---');
  for (const q of [
    { q: 'atmosphereconf', domain: 'youtube.com' },
    { q: 'atmosphereconf', domain: 'youtu.be' },
    { q: 'atmosphere talk', domain: 'youtube.com' },
    { q: 'atmosphere conference talk', domain: 'youtu.be' },
  ]) {
    try {
      const res = await agent.app.bsky.feed.searchPosts({
        q: q.q, domain: q.domain, since: '2026-03-25T00:00:00Z', sort: 'top', limit: 50
      });
      for (const p of (res.data?.posts || [])) {
        if (!allPosts.has(p.uri)) allPosts.set(p.uri, { post: p, type: 'video' });
      }
    } catch {}
    await sleep(200);
  }
  console.log(`  Found ${allPosts.size} YouTube-linked posts`);

  // ── More blog searches ───────────────────────────────────────────
  console.log('\n--- More blog posts ---');
  const blogQueries = [
    { q: 'atmosphere', author: 'masnick.com', since: '2026-03-30T00:00:00Z' },
    { q: 'atmosphere', author: 'mmccue.bsky.social', since: '2026-03-29T00:00:00Z' },
    { q: 'atmosphere', author: 'cassidyjames.com', since: '2026-03-29T00:00:00Z' },
    { q: 'atmosphere', author: 'katexcellence.io', since: '2026-03-29T00:00:00Z' },
    { q: 'atmosphere', author: 'sooraj.dev', since: '2026-03-29T00:00:00Z' },
    { q: 'atmosphere', author: 'werd.io', since: '2026-03-29T00:00:00Z' },
    { q: 'atmosphere', author: 'bmann.ca', since: '2026-03-29T00:00:00Z' },
    { q: 'atmosphere OR atmosphereconf', domain: 'pckt.blog', since: '2026-03-25T00:00:00Z' },
    { q: 'atmosphere OR atmosphereconf', domain: 'brookie.pckt.blog', since: '2026-03-25T00:00:00Z' },
    { q: 'atmosphere OR atmosphereconf', domain: 'connectedplaces.online', since: '2026-03-25T00:00:00Z' },
    { q: 'atmosphereconf wrote', since: '2026-03-29T00:00:00Z' },
    { q: 'atmosphereconf blog post', since: '2026-03-29T00:00:00Z' },
    { q: 'atmosphere conference wrote about', since: '2026-03-29T00:00:00Z' },
  ];
  const beforeBlogs = allPosts.size;
  for (const bq of blogQueries) {
    try {
      const params = { q: bq.q, since: bq.since, sort: 'top', limit: 50 };
      if (bq.author) params.author = bq.author;
      if (bq.domain) params.domain = bq.domain;
      const res = await agent.app.bsky.feed.searchPosts(params);
      for (const p of (res.data?.posts || [])) {
        if (!allPosts.has(p.uri)) {
          const links = extractLinks(p);
          const hasExternalLink = links.some(l => !l.includes('bsky.app'));
          allPosts.set(p.uri, { post: p, type: hasExternalLink ? 'blog' : 'post' });
        }
      }
    } catch {}
    await sleep(200);
  }
  console.log(`  Found ${allPosts.size - beforeBlogs} new blog-related posts`);

  // ── Photo posts ──────────────────────────────────────────────────
  console.log('\n--- Photo posts ---');
  const photoQueries = [
    '#atmosphereconf', 'atmosphereconf photo', 'atmosphereconf pic',
    'atmosphereconf selfie', 'atmosphereconf group', 'atmosphere conf',
  ];
  const beforePhotos = allPosts.size;
  for (const q of photoQueries) {
    try {
      const res = await agent.app.bsky.feed.searchPosts({
        q, since: '2026-03-25T00:00:00Z', sort: 'top', limit: 100,
      });
      for (const p of (res.data?.posts || [])) {
        if (!allPosts.has(p.uri) && hasImages(p)) {
          allPosts.set(p.uri, { post: p, type: 'photo' });
        }
      }
    } catch {}
    await sleep(200);
  }
  console.log(`  Found ${allPosts.size - beforePhotos} photo posts`);

  // ── Process all ──────────────────────────────────────────────────
  console.log(`\n--- Processing ${allPosts.size} total posts ---`);
  let counts = { blog: 0, video: 0, photo: 0, post: 0 };

  const rows = [];
  for (const [uri, { post: p, type }] of allPosts) {
    const links = extractLinks(p);
    const externalUrl = links.find(l => !l.includes('bsky.app')) || null;
    const talkRkey = matchTalk(p, externalUrl);
    const talkUri = talkRkey ? (talksByRkey.get(talkRkey)?.uri || null) : null;
    const isPhoto = hasImages(p);

    // Refine type
    let contentType = type;
    if (contentType === 'post' && isPhoto) contentType = 'photo';

    counts[contentType] = (counts[contentType] || 0) + 1;

    rows.push([
      p.uri, talkUri, p.author.did, p.author.handle,
      p.record?.text, p.record?.createdAt,
      null, null, p.likeCount || 0, p.repostCount || 0, p.replyCount || 0,
      null, 'discussion', now, contentType, externalUrl, null, talkRkey,
      isPhoto ? 1 : 0,
    ]);
  }

  const batchInsert = db.transaction((items) => { for (const r of items) upsert.run(...r); });
  batchInsert(rows);
  console.log(`  Inserted: blog=${counts.blog}, video=${counts.video}, photo=${counts.photo}, post=${counts.post}`);

  // ── OG titles for new blogs ──────────────────────────────────────
  console.log('\n--- Fetching OG titles ---');
  const needOg = db.prepare(
    "SELECT uri, external_url FROM mentions WHERE content_type = 'blog' AND external_url IS NOT NULL AND og_title IS NULL"
  ).all();
  let ogCount = 0;
  const updateOg = db.prepare("UPDATE mentions SET og_title = ? WHERE uri = ?");
  for (const row of needOg) {
    const title = await fetchOgTitle(row.external_url);
    if (title) { updateOg.run(title, row.uri); ogCount++; console.log(`  ${row.external_url} → ${title}`); }
    await sleep(100);
  }
  console.log(`  Fetched ${ogCount}/${needOg.length} OG titles`);

  // ── Profile backfill ─────────────────────────────────────────────
  console.log('\n--- Profile backfill ---');
  const missing = db.prepare(`
    SELECT DISTINCT m.author_did FROM mentions m
    LEFT JOIN profiles p ON m.author_did = p.did WHERE p.did IS NULL
  `).all();
  const profileUpsert = db.prepare(
    "INSERT OR REPLACE INTO profiles (did, handle, display_name, avatar_url, fetched_at) VALUES (?, ?, ?, ?, ?)"
  );
  let pCount = 0;
  for (const { author_did: did } of missing) {
    try {
      const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`);
      if (res.ok) { const d = await res.json(); profileUpsert.run(did, d.handle || null, d.displayName || null, d.avatar || null, now); pCount++; }
    } catch {}
    await sleep(50);
  }
  console.log(`  New profiles: ${pCount}`);

  // ── Mark existing image posts ────────────────────────────────────
  // We can't retroactively check images for existing posts without re-fetching,
  // but we've tagged all new ones.

  // Summary
  const stats = db.prepare("SELECT content_type, COUNT(*) as c FROM mentions GROUP BY content_type").all();
  console.log('\n=== DONE ===');
  for (const s of stats) console.log(`  ${s.content_type}: ${s.c}`);
  console.log(`  Total: ${db.prepare('SELECT COUNT(*) as c FROM mentions').get().c}`);
  db.close();
}

main().catch(console.error);
