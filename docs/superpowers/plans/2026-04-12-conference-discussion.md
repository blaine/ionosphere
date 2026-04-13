# Conference Discussion Page Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a curated multi-column "Conference Discussion" page showing top Bluesky posts, blog recaps, and VOD site links from ATmosphereConf, with talk deep-links and filterable sections.

**Architecture:** Extend the mentions table with `content_type`, `external_url`, and `og_title` columns. A new fetch phase searches 20+ VOD domains and blog/recap queries, classifies content, and fetches OG metadata. A new XRPC endpoint serves discussion data grouped by type. The frontend uses the concordance `IndexContent.tsx` greedy-column pattern with section-based flow items and a filter bar.

**Tech Stack:** SQLite (schema), Node.js (fetch scripts), Hono (API), React/Next.js with greedy column-fill layout

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/ionosphere-appview/src/db.ts` | Modify | Add 3 columns to mentions table |
| `scripts/fetch-discussion.mjs` | Create | Wider search: VOD domains, blog recaps, OG metadata, talk matching |
| `apps/ionosphere-appview/src/routes.ts` | Modify | Add `getDiscussion` endpoint |
| `apps/ionosphere/src/lib/api.ts` | Modify | Add `getDiscussion()` client |
| `apps/ionosphere/src/app/discussion/page.tsx` | Create | Route + SSR data fetch |
| `apps/ionosphere/src/app/discussion/DiscussionContent.tsx` | Create | Multi-column layout with filter, section nav, click-to-play |
| `apps/ionosphere/src/app/components/NavHeader.tsx` | Modify | Add "Discussion" nav item |

---

## Task 1: Schema Migration — Add Columns

**Files:**
- Modify: `apps/ionosphere-appview/src/db.ts:167-187`

- [ ] **Step 1: Add columns to schema and run migration**

In `db.ts`, add after the mentions table CREATE statement (inside the same `db.exec` block):

```sql
-- Add columns if they don't exist (idempotent via try/catch in migration)
```

Since SQLite doesn't support `ADD COLUMN IF NOT EXISTS`, add a migration block after the main `db.exec`. Find the existing migration section and add:

```typescript
// Mentions table extensions
try { db.exec("ALTER TABLE mentions ADD COLUMN content_type TEXT DEFAULT 'post'"); } catch {}
try { db.exec("ALTER TABLE mentions ADD COLUMN external_url TEXT"); } catch {}
try { db.exec("ALTER TABLE mentions ADD COLUMN og_title TEXT"); } catch {}
try { db.exec("ALTER TABLE mentions ADD COLUMN talk_rkey TEXT"); } catch {}
```

Also run these directly on the SQLite database:

```bash
sqlite3 apps/data/ionosphere.sqlite "ALTER TABLE mentions ADD COLUMN content_type TEXT DEFAULT 'post';" 2>/dev/null
sqlite3 apps/data/ionosphere.sqlite "ALTER TABLE mentions ADD COLUMN external_url TEXT;" 2>/dev/null
sqlite3 apps/data/ionosphere.sqlite "ALTER TABLE mentions ADD COLUMN og_title TEXT;" 2>/dev/null
sqlite3 apps/data/ionosphere.sqlite "ALTER TABLE mentions ADD COLUMN talk_rkey TEXT;" 2>/dev/null
```

- [ ] **Step 2: Verify columns**

```bash
sqlite3 apps/data/ionosphere.sqlite "PRAGMA table_info(mentions);" | grep -E "content_type|external_url|og_title|talk_rkey"
```

Expected: 4 new columns listed.

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/db.ts
git commit -m "feat: add content_type, external_url, og_title, talk_rkey to mentions"
```

---

## Task 2: Discussion Fetch Script

**Files:**
- Create: `scripts/fetch-discussion.mjs`

This script runs as a separate batch job (does not modify `fetch-mentions.mjs`). It:
1. Searches for blog/recap posts via multiple keyword queries
2. Searches for VOD site links via `domain:` queries across 20+ domains
3. Classifies each post as `blog`, `video`, or `post`
4. Extracts external URLs from facets
5. Fetches OG titles for blog posts
6. Matches posts to talks via ionosphere.tv URL parsing or speaker @-mention cross-referencing
7. Upserts into the mentions table with the new columns populated
8. Backfills profiles for any new authors

- [ ] **Step 1: Create the fetch script**

```javascript
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

  // Check links for known blog patterns
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
  const mentions = (post.record?.facets || [])
    .flatMap(f => f.features || [])
    .filter(f => f.$type === 'app.bsky.richtext.facet#mention')
    .map(f => f.did);

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

  // Ensure new columns exist
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

  // Phase 4: Classify, extract URLs, match talks, fetch OG titles
  console.log('\n--- Phase 4: Classify and enrich ---');
  let blogCount = 0, videoCount = 0, postCount = 0, ogFetched = 0;
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

  // Also backfill talk_rkey for existing during_talk mentions
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
```

- [ ] **Step 2: Run the script**

```bash
source apps/ionosphere-appview/.env && BOT_PASSWORD="$BOT_PASSWORD" node scripts/fetch-discussion.mjs
```

Expected: Finds posts across VOD domains and blog queries, classifies them, fetches OG titles, and backfills existing mentions with `talk_rkey`.

- [ ] **Step 3: Verify**

```bash
sqlite3 apps/data/ionosphere.sqlite "SELECT content_type, COUNT(*) FROM mentions WHERE content_type IS NOT NULL GROUP BY content_type;"
sqlite3 apps/data/ionosphere.sqlite "SELECT og_title, external_url FROM mentions WHERE og_title IS NOT NULL LIMIT 5;"
sqlite3 apps/data/ionosphere.sqlite "SELECT COUNT(*) FROM mentions WHERE talk_rkey IS NOT NULL;"
```

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-discussion.mjs
git commit -m "feat: wider search for discussion content — VOD sites, blogs, OG metadata"
```

---

## Task 3: API Endpoint — getDiscussion

**Files:**
- Modify: `apps/ionosphere-appview/src/routes.ts` (after getMentions, ~line 310)
- Modify: `apps/ionosphere/src/lib/api.ts`

- [ ] **Step 1: Add getDiscussion route**

Add after the getMentions handler:

```typescript
app.get("/xrpc/tv.ionosphere.getDiscussion", (c) => {
  const profileJoin = `
    LEFT JOIN profiles p ON m.author_did = p.did
  `;
  const selectCols = `
    m.uri, m.author_did, m.text, m.created_at, m.likes, m.reposts, m.replies,
    m.content_type, m.external_url, m.og_title, m.talk_rkey, m.mention_type,
    COALESCE(p.handle, m.author_handle) as author_handle,
    p.display_name as author_display_name,
    p.avatar_url as author_avatar_url
  `;

  // Top posts: highest engagement, exclude thread replies
  const posts = db.prepare(`
    SELECT ${selectCols},
      (SELECT t.title FROM talks t WHERE t.rkey = m.talk_rkey LIMIT 1) as talk_title
    FROM mentions m ${profileJoin}
    WHERE m.parent_uri IS NULL
      AND (m.content_type IS NULL OR m.content_type = 'post')
    ORDER BY m.likes DESC
    LIMIT 200
  `).all();

  // Blog posts
  const blogs = db.prepare(`
    SELECT ${selectCols},
      (SELECT t.title FROM talks t WHERE t.rkey = m.talk_rkey LIMIT 1) as talk_title
    FROM mentions m ${profileJoin}
    WHERE m.content_type = 'blog' AND m.parent_uri IS NULL
    ORDER BY m.likes DESC
  `).all();

  // Videos
  const videos = db.prepare(`
    SELECT ${selectCols},
      (SELECT t.title FROM talks t WHERE t.rkey = m.talk_rkey LIMIT 1) as talk_title
    FROM mentions m ${profileJoin}
    WHERE m.content_type = 'video' AND m.parent_uri IS NULL
    ORDER BY m.likes DESC
  `).all();

  // VOD site domains
  const vodSites = db.prepare(`
    SELECT DISTINCT
      REPLACE(REPLACE(REPLACE(external_url, 'https://', ''), 'http://', ''), SUBSTR(REPLACE(REPLACE(external_url, 'https://', ''), 'http://', ''), INSTR(REPLACE(REPLACE(external_url, 'https://', ''), 'http://', ''), '/')), '') as domain
    FROM mentions
    WHERE content_type = 'video' AND external_url IS NOT NULL
  `).all().map((r: any) => r.domain).filter(Boolean);

  // Stats
  const stats = {
    totalPosts: db.prepare("SELECT COUNT(*) as c FROM mentions WHERE parent_uri IS NULL").get() as any,
    blogCount: blogs.length,
    vodSiteCount: new Set(vodSites).size,
    uniqueAuthors: db.prepare("SELECT COUNT(DISTINCT author_did) as c FROM mentions").get() as any,
  };

  return c.json({
    posts,
    blogs,
    videos,
    vodSites: [...new Set(vodSites)],
    stats: {
      totalPosts: stats.totalPosts.c,
      blogCount: stats.blogCount,
      vodSiteCount: stats.vodSiteCount,
      uniqueAuthors: stats.uniqueAuthors.c,
    },
  });
});
```

- [ ] **Step 2: Add frontend API client**

In `apps/ionosphere/src/lib/api.ts`, add:

```typescript
export async function getDiscussion() {
  return fetchApi<{
    posts: any[]; blogs: any[]; videos: any[];
    vodSites: string[];
    stats: { totalPosts: number; blogCount: number; vodSiteCount: number; uniqueAuthors: number };
  }>("/xrpc/tv.ionosphere.getDiscussion");
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/routes.ts apps/ionosphere/src/lib/api.ts
git commit -m "feat: add getDiscussion XRPC endpoint"
```

---

## Task 4: Discussion Page and Content Component

**Files:**
- Create: `apps/ionosphere/src/app/discussion/page.tsx`
- Create: `apps/ionosphere/src/app/discussion/DiscussionContent.tsx`

- [ ] **Step 1: Create the page route**

`apps/ionosphere/src/app/discussion/page.tsx`:

```tsx
import DiscussionContent from "./DiscussionContent";
import { getDiscussion } from "@/lib/api";

export default async function DiscussionPage() {
  const data = await getDiscussion().catch(() => ({
    posts: [], blogs: [], videos: [], vodSites: [],
    stats: { totalPosts: 0, blogCount: 0, vodSiteCount: 0, uniqueAuthors: 0 },
  }));

  return <DiscussionContent data={data} />;
}
```

- [ ] **Step 2: Create the DiscussionContent component**

This is the main component. It follows `IndexContent.tsx` patterns: greedy column-fill, section nav, filter bar, click-to-play panel. The file will be ~400 lines.

Create `apps/ionosphere/src/app/discussion/DiscussionContent.tsx`:

The component should implement:

1. **Data types**: `DiscussionItem` with uri, author_handle, author_display_name, author_avatar_url, text, likes, reposts, content_type, external_url, og_title, talk_rkey, talk_title
2. **Flow items**: `{ type: "heading", label: string }` or `{ type: "item", item: DiscussionItem }` or `{ type: "vodDirectory", sites: string[] }` or `{ type: "stats", stats: Stats }`
3. **Filter state**: `"all" | "posts" | "blogs" | "videos"` — filters which sections appear in the flow
4. **Column layout**: Reuse the greedy-fill pattern from IndexContent: measure container, compute columns, fill greedily with height estimation
5. **Section nav**: T (Top Posts) / R (Recaps) / V (Videos) sidebar buttons
6. **Item rendering**: Each item is a compact block:
   - Line 1: 14px avatar + handle (blue) + like count (muted)
   - Line 2: Post text (neutral-400, 1-2 lines truncated) or og_title for blogs
   - Line 3 (optional): Talk link → (neutral-500) + external link ↗ (green for blogs, purple for videos)
7. **Click handler**: Click on a talk link → opens right panel with talk video + transcript (same as concordance)
8. **Mobile**: Single-column progressive rendering (same as concordance MobileConcordance)

Key measurements for column fill:
- `ITEM_HEIGHT = 58` (3 lines × ~19px + 4px margin)
- `HEADING_HEIGHT = 28`
- `STATS_HEIGHT = 60`
- `VOD_DIRECTORY_HEIGHT = 80`

Filter bar at top: pill buttons styled like:
```tsx
<button className={`text-xs px-3 py-1 rounded-full transition-colors ${
  active ? "bg-blue-500/20 text-blue-300" : "text-neutral-500 hover:text-neutral-300"
}`}>All</button>
```

Section headings in the flow:
```tsx
<h3 className="text-[11px] font-bold text-neutral-500 uppercase tracking-wide border-b border-neutral-800 pb-1 mb-1 mt-2 first:mt-0">
  {label}
</h3>
```

Item rendering:
```tsx
<div className="mb-1.5 text-[12px] leading-[1.5]">
  <div className="flex items-baseline gap-1">
    {item.author_avatar_url ? (
      <img src={item.author_avatar_url} className="w-3.5 h-3.5 rounded-full shrink-0 relative top-[2px]" />
    ) : (
      <div className="w-3.5 h-3.5 rounded-full bg-neutral-700 shrink-0 relative top-[2px]" />
    )}
    <span className="text-blue-400 text-[11px] truncate">{item.author_handle}</span>
    <span className="text-neutral-600 text-[10px] ml-auto shrink-0">{item.likes}♡</span>
  </div>
  <div className="text-neutral-400 pl-[18px] line-clamp-2 -mt-px">
    {item.og_title || item.text}
  </div>
  {(item.talk_rkey || item.external_url) && (
    <div className="pl-[18px] mt-0.5 flex gap-2">
      {item.talk_rkey && (
        <button onClick={() => handleSelect(item.talk_rkey)} className="text-neutral-500 text-[10px] hover:text-neutral-300">
          {item.talk_title || 'Talk'} →
        </button>
      )}
      {item.external_url && (
        <a href={item.external_url} target="_blank" rel="noopener" className={`text-[10px] ${
          item.content_type === 'blog' ? 'text-emerald-500' : item.content_type === 'video' ? 'text-purple-400' : 'text-neutral-500'
        }`}>
          {new URL(item.external_url).hostname} ↗
        </a>
      )}
    </div>
  )}
</div>
```

VOD directory:
```tsx
<div className="p-2 bg-neutral-900 rounded mb-2">
  <div className="text-neutral-600 text-[10px] font-semibold mb-1">VOD JAM SITES</div>
  <div className="flex flex-wrap gap-1">
    {sites.map(s => (
      <a key={s} href={`https://${s}`} target="_blank" rel="noopener"
        className="text-purple-400 text-[10px] bg-purple-500/10 px-1.5 py-0.5 rounded">{s}</a>
    ))}
  </div>
</div>
```

Stats card:
```tsx
<div className="p-2 bg-neutral-900 rounded mb-2 flex gap-4 justify-center text-center">
  <div><div className="text-blue-400 text-lg font-bold">{stats.totalPosts}</div><div className="text-neutral-600 text-[9px]">posts</div></div>
  <div><div className="text-emerald-400 text-lg font-bold">{stats.blogCount}</div><div className="text-neutral-600 text-[9px]">recaps</div></div>
  <div><div className="text-purple-400 text-lg font-bold">{stats.vodSiteCount}</div><div className="text-neutral-600 text-[9px]">VOD sites</div></div>
  <div><div className="text-amber-400 text-lg font-bold">{stats.uniqueAuthors}</div><div className="text-neutral-600 text-[9px]">people</div></div>
</div>
```

The right panel for click-to-play reuses the exact same pattern as IndexContent: fetch talk data, open `<TimestampProvider>` with `<VideoPlayer>` and `<TranscriptView>`.

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere/src/app/discussion/
git commit -m "feat: conference discussion page with multi-column layout"
```

---

## Task 5: Nav Update and Verification

**Files:**
- Modify: `apps/ionosphere/src/app/components/NavHeader.tsx:7-13`

- [ ] **Step 1: Add Discussion to nav**

In NavHeader.tsx, update the NAV_ITEMS array (line 7-13):

```typescript
const NAV_ITEMS = [
  { href: "/talks", label: "Talks" },
  { href: "/tracks", label: "Tracks" },
  { href: "/speakers", label: "Speakers" },
  { href: "/concepts", label: "Concepts" },
  { href: "/concordance", label: "Index" },
  { href: "/discussion", label: "Discussion" },
];
```

- [ ] **Step 2: Restart appview and frontend**

Restart both servers (kill existing, re-launch on ports 3010 and 3011).

- [ ] **Step 3: Verify**

1. Check API: `curl -s http://localhost:3010/xrpc/tv.ionosphere.getDiscussion | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log('Posts:',j.posts.length,'Blogs:',j.blogs.length,'Videos:',j.videos.length,'VOD sites:',j.vodSites.length)})"`
2. Open http://localhost:3011/discussion — verify multi-column layout, section headers, filter bar, clickable items
3. Click a post with a talk link → verify right panel opens with video + transcript
4. Test filter pills: "Blog Posts" should show only blog section, "Videos" only video section

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere/src/app/components/NavHeader.tsx
git commit -m "feat: add Discussion to site navigation"
```
