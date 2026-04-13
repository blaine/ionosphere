/**
 * Fetch wider conference discussion content from Bluesky and store in SQLite.
 *
 * Phases:
 *   1. VOD domain searches — ~18 domains with conference-related queries
 *   2. Blog/recap queries — keyword searches for writeups and reflections
 *   3. Top conference posts — high-engagement posts sorted by top
 *   4. Classify and enrich — blog/video/post classification, URL extraction, talk matching
 *   5. OG titles — fetch og:title for blog posts with external URLs
 *   6. Profile backfill — fetch profiles for new author DIDs
 *   7. Backfill talk_rkey — update existing mentions that have talk_uri but no talk_rkey
 *
 * Usage:
 *   BOT_PASSWORD=xxx node scripts/fetch-discussion.mjs
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

// ── VOD domains ────────────────────────────────────────────────────

const VOD_DOMAINS = [
  'stream.place', 'vods.sky.boo', 'vod.atverkackt.de', 'ionosphere.tv',
  'atmosphereconf-vods.wisp.place', 'rpg.actor', 'vod.j4ck.xyz',
  'atmosphere-vods.j4ck.xyz', 'atmosphereconf-tv.btao.org',
  'stream-bsky.pages.dev', 'sites.wisp.place', 'vods.ajbird.net',
  'streamhut.wisp.place', 'conf-vods.wisp.place', 'aetheros.computer',
  'atmo.rsvp', 'atmosphereconf.org', 'youtube.com',
];

// ── Blog/recap queries ─────────────────────────────────────────────

const BLOG_QUERIES = [
  'atmosphereconf recap',
  'atmosphereconf wrote',
  'atmosphereconf writeup',
  'atmosphereconf takeaway',
  'atmosphereconf reflection',
  'atmosphereconf blog',
  'atmosphere conference wrote',
  'atmosphere conference recap',
];

// ── Helpers ─────────────────────────────────────────────────────────

function extractLinks(post) {
  return (post.record?.facets || [])
    .flatMap(f => f.features || [])
    .filter(f => f.uri)
    .map(f => f.uri);
}

function classifyPost(post, searchDomain) {
  const links = extractLinks(post);
  const text = (post.record?.text || '').toLowerCase();

  // If searched by a VOD domain, it's a video
  if (searchDomain && VOD_DOMAINS.includes(searchDomain)) return 'video';

  // Check links for known VOD patterns
  for (const link of links) {
    try {
      const url = new URL(link);
      if (VOD_DOMAINS.some(d => url.hostname.endsWith(d))) return 'video';
    } catch {}
  }

  // Blog indicators
  if (text.includes('wrote') || text.includes('recap') || text.includes('writeup') ||
      text.includes('blog') || text.includes('reflection')) {
    if (links.some(l => !VOD_DOMAINS.some(d => l.includes(d)))) return 'blog';
  }

  return 'post';
}

function extractPrimaryUrl(post, contentType) {
  const links = extractLinks(post);
  if (contentType === 'video') {
    return links.find(l => VOD_DOMAINS.some(d => l.includes(d))) || links[0] || null;
  }
  if (contentType === 'blog') {
    return links.find(l => !VOD_DOMAINS.some(d => l.includes(d)) && !l.includes('bsky.app')) || links[0] || null;
  }
  return links[0] || null;
}

function matchTalkByUrl(url, talksByRkey) {
  if (!url) return null;
  const match = url.match(/ionosphere\.tv\/talks\/([^/?#]+)/);
  if (match && talksByRkey.has(match[1])) return match[1];
  return null;
}

function matchTalkBySpeaker(post, speakerHandleToTalks) {
  // Also check text for @handle patterns
  const text = post.record?.text || '';
  const handleMatches = text.match(/@([\w.-]+)/g) || [];

  for (const handle of handleMatches) {
    const clean = handle.replace('@', '');
    const talks = speakerHandleToTalks.get(clean);
    if (talks?.length === 1) return talks[0]; // unambiguous match
  }
  return null;
}

async function fetchOgTitle(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ionosphere.tv/1.0' },
      redirect: 'follow',
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();
    // Extract og:title
    const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (ogMatch) return ogMatch[1];
    // Fallback to <title>
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return titleMatch ? titleMatch[1].trim() : null;
  } catch {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('=== Fetch Discussion Content ===\n');

  await agent.login({
    identifier: 'ionosphere.tv',
    password: process.env.BOT_PASSWORD,
  });
  console.log('Authenticated\n');

  const db = new Database(DB_PATH);

  // Ensure new columns exist (idempotent)
  try { db.exec("ALTER TABLE mentions ADD COLUMN content_type TEXT DEFAULT 'post'"); } catch {}
  try { db.exec("ALTER TABLE mentions ADD COLUMN external_url TEXT"); } catch {}
  try { db.exec("ALTER TABLE mentions ADD COLUMN og_title TEXT"); } catch {}
  try { db.exec("ALTER TABLE mentions ADD COLUMN talk_rkey TEXT"); } catch {}

  const upsert = db.prepare(`
    INSERT INTO mentions (uri, talk_uri, author_did, author_handle, text, created_at,
      talk_offset_ms, byte_position, likes, reposts, replies, parent_uri,
      mention_type, indexed_at, content_type, external_url, og_title, talk_rkey)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uri) DO UPDATE SET
      likes=excluded.likes, reposts=excluded.reposts, replies=excluded.replies,
      content_type=excluded.content_type, external_url=excluded.external_url,
      og_title=excluded.og_title, talk_rkey=excluded.talk_rkey, indexed_at=excluded.indexed_at
  `);

  // Load talk data for matching
  const talks = db.prepare("SELECT DISTINCT rkey, title, uri FROM talks WHERE starts_at IS NOT NULL").all();
  const talksByRkey = new Map(talks.map(t => [t.rkey, t]));

  const speakerTalks = db.prepare(`
    SELECT s.handle, t.rkey
    FROM speakers s
    JOIN talk_speakers ts ON ts.speaker_uri = s.uri
    JOIN talks t ON t.uri = ts.talk_uri
    WHERE s.handle IS NOT NULL
  `).all();
  const speakerHandleToTalks = new Map();
  for (const { handle, rkey } of speakerTalks) {
    if (!speakerHandleToTalks.has(handle)) speakerHandleToTalks.set(handle, []);
    speakerHandleToTalks.get(handle).push(rkey);
  }

  const allPosts = new Map();

  // Phase 1: VOD domain searches
  console.log('--- Phase 1: VOD domains ---');
  for (const domain of VOD_DOMAINS) {
    try {
      const res = await agent.app.bsky.feed.searchPosts({
        q: 'atmosphere OR atmosphereconf',
        domain,
        since: '2026-03-25T00:00:00Z',
        sort: 'top',
        limit: 100,
      });
      const posts = res.data?.posts || [];
      for (const p of posts) {
        if (!allPosts.has(p.uri)) allPosts.set(p.uri, { post: p, searchDomain: domain });
      }
      if (posts.length > 0) console.log(`  ${domain}: ${posts.length} posts`);
      await sleep(200);
    } catch (e) {
      // Some domains may not return results
    }
  }

  // Phase 2: Blog/recap queries
  console.log('\n--- Phase 2: Blog/recap queries ---');
  for (const q of BLOG_QUERIES) {
    try {
      const res = await agent.app.bsky.feed.searchPosts({
        q,
        since: '2026-03-25T00:00:00Z',
        sort: 'top',
        limit: 50,
      });
      const posts = res.data?.posts || [];
      for (const p of posts) {
        if (!allPosts.has(p.uri)) allPosts.set(p.uri, { post: p, searchDomain: null });
      }
      if (posts.length > 0) console.log(`  "${q}": ${posts.length} posts`);
      await sleep(200);
    } catch {}
  }

  // Phase 3: Top conference posts (sorted by engagement)
  console.log('\n--- Phase 3: Top conference posts ---');
  for (const q of ['atmosphereconf', 'atmosphere conf', '#atmosphereconf', '#ATmosphere']) {
    try {
      const res = await agent.app.bsky.feed.searchPosts({
        q,
        since: '2026-03-25T00:00:00Z',
        sort: 'top',
        limit: 100,
      });
      const posts = res.data?.posts || [];
      for (const p of posts) {
        if (!allPosts.has(p.uri)) allPosts.set(p.uri, { post: p, searchDomain: null });
      }
      if (posts.length > 0) console.log(`  "${q}": ${posts.length} posts`);
      await sleep(200);
    } catch {}
  }

  console.log(`\nTotal unique posts: ${allPosts.size}`);

  // Phase 4: Classify, extract URLs, match talks
  console.log('\n--- Phase 4: Classify and enrich ---');
  let blogCount = 0, videoCount = 0, postCount = 0;
  const now = new Date().toISOString();

  const batchInsert = db.transaction((items) => {
    for (const item of items) {
      upsert.run(...item);
    }
  });

  const rows = [];
  for (const [uri, { post: p, searchDomain }] of allPosts) {
    const contentType = classifyPost(p, searchDomain);
    const externalUrl = extractPrimaryUrl(p, contentType);
    let talkRkey = matchTalkByUrl(externalUrl, talksByRkey);
    if (!talkRkey) talkRkey = matchTalkBySpeaker(p, speakerHandleToTalks);

    const talkUri = talkRkey ? (talksByRkey.get(talkRkey)?.uri || null) : null;

    if (contentType === 'blog') blogCount++;
    else if (contentType === 'video') videoCount++;
    else postCount++;

    rows.push([
      p.uri, talkUri, p.author.did, p.author.handle,
      p.record?.text, p.record?.createdAt,
      null, null, // talk_offset_ms, byte_position
      p.likeCount || 0, p.repostCount || 0, p.replyCount || 0,
      null, // parent_uri
      'discussion', now,
      contentType, externalUrl, null, talkRkey,
    ]);
  }

  batchInsert(rows);
  console.log(`  Posts: ${postCount}, Blog posts: ${blogCount}, Videos: ${videoCount}`);

  // Phase 5: Fetch OG titles for blog posts
  console.log('\n--- Phase 5: OG titles ---');
  const blogRows = db.prepare(
    "SELECT uri, external_url FROM mentions WHERE content_type = 'blog' AND external_url IS NOT NULL AND og_title IS NULL"
  ).all();

  let ogFetched = 0;
  const updateOg = db.prepare("UPDATE mentions SET og_title = ? WHERE uri = ?");
  for (const row of blogRows) {
    const title = await fetchOgTitle(row.external_url);
    if (title) {
      updateOg.run(title, row.uri);
      ogFetched++;
      console.log(`  ${row.external_url} → ${title}`);
    }
    await sleep(100);
  }
  console.log(`  OG titles fetched: ${ogFetched}/${blogRows.length}`);

  // Phase 6: Backfill profiles
  console.log('\n--- Phase 6: Profile backfill ---');
  const missing = db.prepare(`
    SELECT DISTINCT m.author_did FROM mentions m
    LEFT JOIN profiles p ON m.author_did = p.did WHERE p.did IS NULL
  `).all();

  const profileUpsert = db.prepare(
    "INSERT OR REPLACE INTO profiles (did, handle, display_name, avatar_url, fetched_at) VALUES (?, ?, ?, ?, ?)"
  );
  let profilesFetched = 0;
  for (const { author_did: did } of missing) {
    try {
      const res = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
      );
      if (res.ok) {
        const data = await res.json();
        profileUpsert.run(did, data.handle || null, data.displayName || null, data.avatar || null, now);
        profilesFetched++;
      }
    } catch {}
    await sleep(50);
  }
  console.log(`  New profiles: ${profilesFetched}`);

  // Phase 7: Backfill talk_rkey on existing mentions
  console.log('\n--- Phase 7: Backfill talk_rkey on existing mentions ---');
  const updated = db.prepare(`
    UPDATE mentions SET talk_rkey = (
      SELECT t.rkey FROM talks t WHERE t.uri = mentions.talk_uri LIMIT 1
    ) WHERE talk_uri IS NOT NULL AND talk_rkey IS NULL
  `).run();
  console.log(`  Updated ${updated.changes} existing mentions with talk_rkey`);

  // Summary
  const stats = db.prepare(`
    SELECT content_type, COUNT(*) as c FROM mentions
    WHERE content_type IS NOT NULL GROUP BY content_type
  `).all();
  console.log('\n=== DONE ===');
  for (const s of stats) console.log(`  ${s.content_type}: ${s.c}`);
  console.log(`  Total: ${db.prepare('SELECT COUNT(*) as c FROM mentions').get().c}`);

  db.close();
}

main().catch(console.error);
