# Conference Mentions Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface time-aligned Bluesky mentions of speakers in the ionosphere.tv talk detail sidebar, with paginated fetching, thread following, and post-conference mentions.

**Architecture:** A batch fetch script pulls mentions from the Bluesky search API, computes byte positions from transcript timings, and stores them in SQLite. A new XRPC endpoint serves mentions per talk. The frontend adds a "Mentions" tab to the right sidebar with scroll-synced mention cards using pretext spacers for vertical alignment.

**Tech Stack:** Node.js (fetch script), SQLite (storage), Hono (API), React/Next.js (frontend), `@atproto/api` (Bluesky SDK)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/ionosphere-appview/src/db.ts` | Modify | Add `mentions` table schema |
| `apps/ionosphere-appview/src/routes.ts` | Modify | Add `getMentions` endpoint |
| `apps/ionosphere/src/lib/api.ts` | Modify | Add `getMentions()` client function |
| `apps/ionosphere/src/app/talks/[rkey]/page.tsx` | Modify | Fetch mentions server-side, pass to TalkContent |
| `apps/ionosphere/src/app/talks/[rkey]/TalkContent.tsx` | Modify | Add tab system, render MentionsSidebar |
| `apps/ionosphere/src/app/components/MentionsSidebar.tsx` | Create | Scroll-synced mention cards with thread expansion |
| `scripts/fetch-mentions.mjs` | Create | Paginated fetch, thread following, byte mapping |

---

## Task 1: Database Schema

**Files:**
- Modify: `apps/ionosphere-appview/src/db.ts:167` (after comments table, before profiles table)

- [ ] **Step 1: Add mentions table to schema**

In `db.ts`, add after the comments index (line 166) and before the profiles table (line 168):

```sql
CREATE TABLE IF NOT EXISTS mentions (
  uri TEXT PRIMARY KEY,
  talk_uri TEXT,
  author_did TEXT NOT NULL,
  author_handle TEXT,
  text TEXT,
  created_at TEXT NOT NULL,
  talk_offset_ms INTEGER,
  byte_position INTEGER,
  likes INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  parent_uri TEXT,
  mention_type TEXT DEFAULT 'during_talk',
  indexed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mentions_talk ON mentions(talk_uri, talk_offset_ms);
CREATE INDEX IF NOT EXISTS idx_mentions_parent ON mentions(parent_uri);
```

- [ ] **Step 2: Verify schema applies**

Run: `cd apps/ionosphere-appview && npx tsx src/db.ts 2>&1 || echo "Check if db module exports migrate"`

If `db.ts` doesn't have a standalone entry point, verify by checking the appview starts:
```bash
sqlite3 apps/data/ionosphere.sqlite ".tables" | tr ' ' '\n' | sort
```

The `mentions` table should appear. If not, start the appview briefly or run the migrate function directly.

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/db.ts
git commit -m "feat: add mentions table to SQLite schema"
```

---

## Task 2: Fetch Script with Pagination and Threads

**Files:**
- Create: `scripts/fetch-mentions.mjs`

This replaces the prototype scripts. Key improvements: cursor pagination, thread fetching, byte-position mapping, SQLite storage.

- [ ] **Step 1: Write the fetch script**

Create `scripts/fetch-mentions.mjs`:

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

const CONF_SINCE = '2026-03-25T00:00:00Z';
const CONF_UNTIL = '2026-03-31T00:00:00Z';
const PRE_BUFFER_MS = 5 * 60 * 1000;
const POST_BUFFER_MS = 30 * 60 * 1000;

const agent = new BskyAgent({ service: 'https://bsky.social' });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Byte position mapping ──────────────────────────────────────────

function mapOffsetToBytePosition(talkOffsetMs, compactTranscript) {
  if (!compactTranscript) return null;
  const { text, startMs, timings } = compactTranscript;
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const encoder = new TextEncoder();

  let cursorMs = startMs;
  let wordIndex = 0;
  let searchFrom = 0;
  let lastBytePos = 0;

  for (const value of timings) {
    if (value < 0) {
      cursorMs += Math.abs(value);
    } else {
      if (wordIndex < words.length) {
        const word = words[wordIndex];
        const idx = text.indexOf(word, searchFrom);
        if (idx !== -1) {
          const bytePos = encoder.encode(text.slice(0, idx)).length;
          if (cursorMs >= talkOffsetMs) return bytePos;
          lastBytePos = bytePos;
          searchFrom = idx + word.length;
        }
        cursorMs += value;
        wordIndex++;
      }
    }
  }
  return lastBytePos;
}

// ── Search with pagination ─────────────────────────────────────────

async function searchAllMentions(handle, since, until) {
  const allPosts = [];
  let cursor = undefined;

  for (let page = 0; page < 10; page++) {
    try {
      const params = { q: '*', mentions: handle, since, until, sort: 'latest', limit: 100 };
      if (cursor) params.cursor = cursor;

      const res = await agent.app.bsky.feed.searchPosts(params);
      const posts = res.data?.posts || [];
      allPosts.push(...posts);

      cursor = res.data?.cursor;
      if (!cursor || posts.length < 100) break;
      await sleep(200);
    } catch (e) {
      // Fallback without wildcard
      try {
        const params = { q: 'atmosphere OR atproto', mentions: handle, since, until, sort: 'latest', limit: 100 };
        if (cursor) params.cursor = cursor;
        const res = await agent.app.bsky.feed.searchPosts(params);
        allPosts.push(...(res.data?.posts || []));
        break;
      } catch { break; }
    }
  }
  return allPosts;
}

// ── Thread fetching ────────────────────────────────────────────────

async function fetchThread(uri) {
  try {
    const res = await agent.app.bsky.feed.getPostThread({ uri, depth: 2 });
    const thread = res.data?.thread;
    if (!thread?.replies) return [];

    return thread.replies
      .filter(r => r.$type === 'app.bsky.feed.defs#threadViewPost')
      .map(r => ({
        uri: r.post.uri,
        author: r.post.author,
        text: r.post.record?.text,
        createdAt: r.post.record?.createdAt,
        likes: r.post.likeCount || 0,
        reposts: r.post.repostCount || 0,
        replies: r.post.replyCount || 0,
      }));
  } catch {
    return [];
  }
}

// ── Post-conference mentions ───────────────────────────────────────

async function searchPostConference(handle) {
  const allPosts = [];
  for (const q of ['atmosphere OR atmosphereconf', 'ionosphere.tv']) {
    try {
      const res = await agent.app.bsky.feed.searchPosts({
        q, mentions: handle, since: '2026-03-30T00:00:00Z', sort: 'latest', limit: 100
      });
      for (const p of (res.data?.posts || [])) allPosts.push(p);
      await sleep(200);
    } catch { /* skip */ }
  }
  // Also search by domain
  try {
    const res = await agent.app.bsky.feed.searchPosts({
      q: '*', since: '2026-03-30T00:00:00Z', domain: 'ionosphere.tv', sort: 'latest', limit: 100
    });
    for (const p of (res.data?.posts || [])) allPosts.push(p);
  } catch { /* skip */ }

  // Deduplicate
  const seen = new Set();
  return allPosts.filter(p => { if (seen.has(p.uri)) return false; seen.add(p.uri); return true; });
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('=== Fetch Mentions → SQLite ===\n');

  await agent.login({
    identifier: 'ionosphere.tv',
    password: process.env.BOT_PASSWORD,
  });
  console.log('Authenticated\n');

  const db = new Database(DB_PATH);

  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS mentions (
      uri TEXT PRIMARY KEY,
      talk_uri TEXT,
      author_did TEXT NOT NULL,
      author_handle TEXT,
      text TEXT,
      created_at TEXT NOT NULL,
      talk_offset_ms INTEGER,
      byte_position INTEGER,
      likes INTEGER DEFAULT 0,
      reposts INTEGER DEFAULT 0,
      replies INTEGER DEFAULT 0,
      parent_uri TEXT,
      mention_type TEXT DEFAULT 'during_talk',
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_talk ON mentions(talk_uri, talk_offset_ms);
    CREATE INDEX IF NOT EXISTS idx_mentions_parent ON mentions(parent_uri);
  `);

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO mentions
    (uri, talk_uri, author_did, author_handle, text, created_at,
     talk_offset_ms, byte_position, likes, reposts, replies,
     parent_uri, mention_type, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Load talks with speakers and transcripts
  const talks = db.prepare(`
    SELECT DISTINCT t.uri, t.rkey, t.title, t.starts_at, t.ends_at, t.room,
           s.name as speaker_name, s.handle as speaker_handle
    FROM talks t
    JOIN talk_speakers ts ON ts.talk_uri = t.uri
    JOIN speakers s ON s.uri = ts.speaker_uri
    WHERE t.starts_at IS NOT NULL AND t.ends_at IS NOT NULL
    ORDER BY t.starts_at
  `).all();

  // Group by talk
  const talkMap = new Map();
  for (const row of talks) {
    if (!talkMap.has(row.uri)) {
      talkMap.set(row.uri, { ...row, speakers: [] });
    }
    const t = talkMap.get(row.uri);
    if (!t.speakers.find(s => s.handle === row.speaker_handle)) {
      t.speakers.push({ name: row.speaker_name, handle: row.speaker_handle });
    }
  }

  // Load transcripts for byte mapping
  const transcriptStmt = db.prepare(`
    SELECT document FROM transcripts WHERE talk_uri = ? LIMIT 1
  `);

  let totalMentions = 0;
  let totalThreadReplies = 0;
  const talkList = [...talkMap.values()];

  for (let i = 0; i < talkList.length; i++) {
    const talk = talkList[i];
    const talkStart = new Date(talk.starts_at);
    const talkEnd = new Date(talk.ends_at);
    const since = new Date(talkStart.getTime() - PRE_BUFFER_MS).toISOString();
    const until = new Date(talkEnd.getTime() + POST_BUFFER_MS).toISOString();

    // Get transcript for byte mapping
    const transcriptRow = transcriptStmt.get(talk.uri);
    let compact = null;
    if (transcriptRow?.document) {
      try { compact = JSON.parse(transcriptRow.document); } catch {}
    }

    const allPosts = new Map();

    // During-talk mentions per speaker
    for (const speaker of talk.speakers) {
      if (!speaker.handle) continue;
      const posts = await searchAllMentions(speaker.handle, since, until);
      for (const p of posts) {
        if (!allPosts.has(p.uri)) allPosts.set(p.uri, p);
      }
      await sleep(150);
    }

    // Process and store
    const insertMany = db.transaction((posts) => {
      for (const p of posts) {
        const createdAt = new Date(p.record?.createdAt);
        const offsetMs = createdAt.getTime() - talkStart.getTime();
        const bytePos = compact ? mapOffsetToBytePosition(offsetMs, compact) : null;

        upsert.run(
          p.uri, talk.uri, p.author.did, p.author.handle,
          p.record?.text, p.record?.createdAt,
          offsetMs, bytePos,
          p.likeCount || 0, p.repostCount || 0, p.replyCount || 0,
          null, 'during_talk', new Date().toISOString()
        );
      }
    });

    const posts = [...allPosts.values()];
    if (posts.length > 0) insertMany(posts);
    totalMentions += posts.length;

    // Fetch threads for posts with replies
    const postsWithReplies = posts.filter(p => (p.replyCount || 0) > 0);
    for (const p of postsWithReplies) {
      const replies = await fetchThread(p.uri);
      for (const reply of replies) {
        const parentCreatedAt = new Date(p.record?.createdAt);
        const parentOffsetMs = parentCreatedAt.getTime() - talkStart.getTime();
        const parentBytePos = compact ? mapOffsetToBytePosition(parentOffsetMs, compact) : null;

        upsert.run(
          reply.uri, talk.uri, reply.author.did, reply.author.handle,
          reply.text, reply.createdAt,
          parentOffsetMs, parentBytePos,
          reply.likes, reply.reposts, reply.replies,
          p.uri, 'during_talk', new Date().toISOString()
        );
        totalThreadReplies++;
      }
      await sleep(200);
    }

    if (posts.length > 0) {
      console.log(`[${i + 1}/${talkList.length}] "${talk.title}" — ${posts.length} mentions, ${postsWithReplies.length} threads`);
    } else {
      console.log(`[${i + 1}/${talkList.length}] "${talk.title}" — no mentions`);
    }
  }

  // Post-conference mentions
  console.log('\n--- Post-conference mentions ---');
  const speakerHandles = [...new Set(talkList.flatMap(t => t.speakers.map(s => s.handle)).filter(Boolean))];
  let postConfCount = 0;

  // Domain search for ionosphere.tv links
  try {
    const res = await agent.app.bsky.feed.searchPosts({
      q: '*', domain: 'ionosphere.tv', since: '2026-03-30T00:00:00Z', sort: 'latest', limit: 100
    });
    const posts = res.data?.posts || [];
    const insertPostConf = db.transaction((posts) => {
      for (const p of posts) {
        upsert.run(
          p.uri, null, p.author.did, p.author.handle,
          p.record?.text, p.record?.createdAt,
          null, null,
          p.likeCount || 0, p.repostCount || 0, p.replyCount || 0,
          null, 'post_conference', new Date().toISOString()
        );
      }
    });
    insertPostConf(posts);
    postConfCount += posts.length;
    console.log(`  ionosphere.tv domain: ${posts.length} posts`);
  } catch (e) {
    console.error(`  ionosphere.tv domain search failed: ${e.message}`);
  }

  // stream.place domain
  try {
    const res = await agent.app.bsky.feed.searchPosts({
      q: 'atmosphere', domain: 'stream.place', since: '2026-03-30T00:00:00Z', sort: 'latest', limit: 100
    });
    const posts = res.data?.posts || [];
    for (const p of posts) {
      upsert.run(
        p.uri, null, p.author.did, p.author.handle,
        p.record?.text, p.record?.createdAt,
        null, null,
        p.likeCount || 0, p.repostCount || 0, p.replyCount || 0,
        null, 'post_conference', new Date().toISOString()
      );
    }
    postConfCount += posts.length;
    console.log(`  stream.place domain: ${posts.length} posts`);
  } catch (e) {
    console.error(`  stream.place domain search failed: ${e.message}`);
  }

  await sleep(200);

  console.log(`\n=== DONE ===`);
  console.log(`During-talk mentions: ${totalMentions}`);
  console.log(`Thread replies: ${totalThreadReplies}`);
  console.log(`Post-conference: ${postConfCount}`);
  console.log(`Total stored: ${db.prepare('SELECT COUNT(*) as c FROM mentions').get().c}`);

  db.close();
}

main().catch(console.error);
```

- [ ] **Step 2: Run the fetch script**

```bash
source apps/ionosphere-appview/.env && BOT_PASSWORD="$BOT_PASSWORD" node scripts/fetch-mentions.mjs
```

Expected: Iterates through ~120 talks, stores mentions with byte positions into SQLite. Should take 5-10 minutes due to API rate limiting.

- [ ] **Step 3: Verify data**

```bash
sqlite3 apps/data/ionosphere.sqlite "SELECT COUNT(*) FROM mentions;"
sqlite3 apps/data/ionosphere.sqlite "SELECT mention_type, COUNT(*) FROM mentions GROUP BY mention_type;"
sqlite3 apps/data/ionosphere.sqlite "SELECT m.talk_offset_ms, m.byte_position, m.text FROM mentions m WHERE m.talk_uri IS NOT NULL AND m.byte_position IS NOT NULL LIMIT 5;"
```

Expected: 2000+ rows, mix of during_talk and post_conference, byte_position populated for during-talk mentions.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-mentions.mjs
git commit -m "feat: paginated mention fetcher with threads and byte mapping"
```

---

## Task 3: API Endpoint

**Files:**
- Modify: `apps/ionosphere-appview/src/routes.ts:273` (after getComments, before getConceptClusters)

- [ ] **Step 1: Add getMentions route**

Insert after line 272 (end of getComments handler) in `routes.ts`:

```typescript
app.get("/xrpc/tv.ionosphere.getMentions", (c) => {
  const talkRkey = c.req.query("talkRkey");
  if (!talkRkey) return c.json({ mentions: [], total: 0 });

  const talk = db.prepare("SELECT uri FROM talks WHERE rkey = ?").get(talkRkey) as any;
  if (!talk) return c.json({ mentions: [], total: 0 });

  // Fetch top-level mentions (parent_uri IS NULL)
  const topLevel = db.prepare(
    `SELECT m.*, p.handle as author_handle, p.display_name as author_display_name, p.avatar_url as author_avatar_url
     FROM mentions m
     LEFT JOIN profiles p ON m.author_did = p.did
     WHERE m.talk_uri = ? AND m.parent_uri IS NULL
     ORDER BY
       CASE m.mention_type WHEN 'during_talk' THEN 0 ELSE 1 END,
       m.talk_offset_ms ASC,
       m.created_at ASC`
  ).all(talk.uri);

  // Fetch thread replies for each top-level mention
  const replyStmt = db.prepare(
    `SELECT m.*, p.handle as author_handle, p.display_name as author_display_name, p.avatar_url as author_avatar_url
     FROM mentions m
     LEFT JOIN profiles p ON m.author_did = p.did
     WHERE m.parent_uri = ?
     ORDER BY m.created_at ASC`
  );

  const mentions = topLevel.map((m: any) => ({
    ...m,
    thread: replyStmt.all(m.uri),
  }));

  return c.json({ mentions, total: mentions.length });
});
```

- [ ] **Step 2: Test the endpoint**

Start the appview and curl:
```bash
curl -s 'http://localhost:3001/xrpc/tv.ionosphere.getMentions?talkRkey=landslide' | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log('total:',j.total);j.mentions.slice(0,3).forEach(m=>console.log(m.author_handle,m.talk_offset_ms,m.text?.slice(0,60)))})"
```

Expected: Returns mentions array sorted by talk_offset_ms with nested thread replies.

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/routes.ts
git commit -m "feat: add getMentions XRPC endpoint"
```

---

## Task 4: Frontend API Client and Data Fetching

**Files:**
- Modify: `apps/ionosphere/src/lib/api.ts:31` (after getConcept)
- Modify: `apps/ionosphere/src/app/talks/[rkey]/page.tsx:36` (add mentions fetch)

- [ ] **Step 1: Add getMentions to api.ts**

Add after `getConcept` (line 31):

```typescript
export async function getMentions(talkRkey: string) {
  return fetchApi<{ mentions: any[]; total: number }>(`/xrpc/tv.ionosphere.getMentions?talkRkey=${encodeURIComponent(talkRkey)}`);
}
```

- [ ] **Step 2: Fetch mentions in page.tsx**

Update `page.tsx` to fetch mentions server-side and pass to TalkContent:

```typescript
import { getTalk, getTalks, getMentions } from "@/lib/api";
```

Update the `TalkPage` component (line 34-38):

```typescript
export default async function TalkPage({ params }: { params: Promise<{ rkey: string }> }) {
  const { rkey } = await params;
  const [{ talk, speakers, concepts }, { mentions }] = await Promise.all([
    getTalk(rkey),
    getMentions(rkey),
  ]);

  return <TalkContent talk={talk} speakers={speakers} concepts={concepts} mentions={mentions} />;
}
```

- [ ] **Step 3: Update TalkContent props**

In `TalkContent.tsx`, update the interface (line 10-13):

```typescript
interface TalkContentProps {
  talk: any;
  speakers: any[];
  concepts: any[];
  mentions: any[];
}
```

Update the destructuring (line 24):

```typescript
export default function TalkContent({ talk, speakers, concepts, mentions }: TalkContentProps) {
```

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere/src/lib/api.ts apps/ionosphere/src/app/talks/[rkey]/page.tsx apps/ionosphere/src/app/talks/[rkey]/TalkContent.tsx
git commit -m "feat: wire mentions data from API to talk page"
```

---

## Task 5: MentionsSidebar Component

**Files:**
- Create: `apps/ionosphere/src/app/components/MentionsSidebar.tsx`

- [ ] **Step 1: Create the MentionsSidebar component**

```tsx
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useTimestamp } from "@/app/components/TimestampProvider";

interface Mention {
  uri: string;
  author_did: string;
  author_handle: string;
  author_display_name: string;
  author_avatar_url: string;
  text: string;
  created_at: string;
  talk_offset_ms: number;
  byte_position: number;
  likes: number;
  reposts: number;
  replies: number;
  mention_type: string;
  thread: Mention[];
}

interface MentionsSidebarProps {
  mentions: Mention[];
  words: Array<{ byteStart: number; startTime: number }>;
}

export default function MentionsSidebar({ mentions, words }: MentionsSidebarProps) {
  const { currentTimeNs } = useTimestamp();
  const containerRef = useRef<HTMLDivElement>(null);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());

  const duringTalk = mentions.filter(m => m.mention_type === "during_talk");
  const postConference = mentions.filter(m => m.mention_type === "post_conference");

  // Find the mention closest to current playback time
  const currentOffsetMs = Number(currentTimeNs) / 1_000_000;
  const activeMentionIdx = duringTalk.findIndex((m, i) => {
    const next = duringTalk[i + 1];
    return !next || next.talk_offset_ms > currentOffsetMs;
  });

  // Auto-scroll to active mention
  useEffect(() => {
    if (activeMentionIdx < 0) return;
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-mention-idx="${activeMentionIdx}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activeMentionIdx]);

  const toggleThread = useCallback((uri: string) => {
    setExpandedThreads(prev => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  }, []);

  const { seekTo } = useTimestamp();

  const handleMentionClick = useCallback((offsetMs: number) => {
    if (offsetMs != null && seekTo) {
      seekTo(BigInt(offsetMs) * 1_000_000n);
    }
  }, [seekTo]);

  return (
    <div ref={containerRef} className="flex flex-col gap-1 overflow-y-auto h-full">
      {duringTalk.length === 0 && postConference.length === 0 && (
        <p className="text-neutral-500 text-xs">No mentions found for this talk.</p>
      )}

      {duringTalk.map((m, idx) => (
        <MentionCard
          key={m.uri}
          mention={m}
          idx={idx}
          isActive={idx === activeMentionIdx}
          isThreadExpanded={expandedThreads.has(m.uri)}
          onToggleThread={() => toggleThread(m.uri)}
          onClick={() => handleMentionClick(m.talk_offset_ms)}
        />
      ))}

      {postConference.length > 0 && (
        <>
          <div className="border-t border-neutral-700 my-3 pt-2">
            <h3 className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wide">
              After the conference
            </h3>
          </div>
          {postConference.map((m) => (
            <MentionCard
              key={m.uri}
              mention={m}
              idx={-1}
              isActive={false}
              isThreadExpanded={expandedThreads.has(m.uri)}
              onToggleThread={() => toggleThread(m.uri)}
              onClick={() => {}}
            />
          ))}
        </>
      )}
    </div>
  );
}

function MentionCard({
  mention: m,
  idx,
  isActive,
  isThreadExpanded,
  onToggleThread,
  onClick,
}: {
  mention: Mention;
  idx: number;
  isActive: boolean;
  isThreadExpanded: boolean;
  onToggleThread: () => void;
  onClick: () => void;
}) {
  const offsetMin = m.talk_offset_ms != null ? Math.floor(m.talk_offset_ms / 60000) : null;
  const offsetSec = m.talk_offset_ms != null ? Math.floor((m.talk_offset_ms % 60000) / 1000) : null;
  const timeLabel = offsetMin != null ? `${offsetMin}:${String(offsetSec).padStart(2, "0")}` : null;

  return (
    <div data-mention-idx={idx}>
      <div
        onClick={onClick}
        className={`p-2 rounded-md border-l-2 cursor-pointer transition-colors ${
          isActive
            ? "bg-blue-500/10 border-blue-400"
            : "bg-neutral-900/50 border-neutral-700 hover:bg-neutral-800/50 hover:border-blue-500/50"
        }`}
      >
        <div className="flex items-center gap-1.5 mb-1">
          {m.author_avatar_url ? (
            <img src={m.author_avatar_url} alt="" className="w-4 h-4 rounded-full" />
          ) : (
            <div className="w-4 h-4 rounded-full bg-neutral-700 shrink-0" />
          )}
          <span className="text-blue-400 text-[11px] font-medium truncate">
            @{m.author_handle || "unknown"}
          </span>
          {timeLabel && (
            <span className="text-neutral-600 text-[10px] ml-auto shrink-0">{timeLabel}</span>
          )}
        </div>
        <p className="text-neutral-300 text-[11px] leading-relaxed line-clamp-3">{m.text}</p>
        <div className="flex items-center gap-3 mt-1 text-[10px] text-neutral-500">
          {m.likes > 0 && <span>{m.likes} ♡</span>}
          {m.reposts > 0 && <span>{m.reposts} ⟳</span>}
          {m.thread?.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleThread(); }}
              className="text-blue-400/70 hover:text-blue-300"
            >
              {isThreadExpanded ? "▾" : "▸"} {m.thread.length} {m.thread.length === 1 ? "reply" : "replies"}
            </button>
          )}
        </div>
      </div>

      {isThreadExpanded && m.thread?.length > 0 && (
        <div className="ml-3 mt-0.5 flex flex-col gap-0.5">
          {m.thread.map((reply) => (
            <div key={reply.uri} className="p-1.5 rounded bg-neutral-900/30 border-l border-neutral-700">
              <div className="flex items-center gap-1.5 mb-0.5">
                {reply.author_avatar_url ? (
                  <img src={reply.author_avatar_url} alt="" className="w-3 h-3 rounded-full" />
                ) : (
                  <div className="w-3 h-3 rounded-full bg-neutral-700 shrink-0" />
                )}
                <span className="text-blue-400/70 text-[10px]">@{reply.author_handle}</span>
                {reply.likes > 0 && <span className="text-neutral-600 text-[10px] ml-auto">{reply.likes} ♡</span>}
              </div>
              <p className="text-neutral-400 text-[10px] leading-relaxed line-clamp-3">{reply.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify component compiles**

```bash
cd apps/ionosphere && npx next build 2>&1 | tail -20
```

Expected: No TypeScript errors for MentionsSidebar. (Full build may fail if other parts have issues, but the component itself should be clean.)

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere/src/app/components/MentionsSidebar.tsx
git commit -m "feat: MentionsSidebar component with scroll sync and thread expansion"
```

---

## Task 6: Tab System and Integration

**Files:**
- Modify: `apps/ionosphere/src/app/talks/[rkey]/TalkContent.tsx:195-223`

- [ ] **Step 1: Add imports and state**

At the top of TalkContent.tsx, add the MentionsSidebar import (after line 8):

```typescript
import MentionsSidebar from "@/app/components/MentionsSidebar";
```

Inside the component function, add tab state (after the `comments` state on line 25):

```typescript
const [sidebarTab, setSidebarTab] = useState<"concepts" | "mentions">(
  mentions.length > 0 ? "mentions" : "concepts"
);
```

- [ ] **Step 2: Replace the right sidebar**

Replace lines 195-223 (the entire `<aside>` block) with:

```tsx
{/* Right sidebar — concepts + mentions (hidden on mobile, scrollable on desktop) */}
<aside className="hidden lg:flex lg:flex-col lg:w-56 xl:w-64 shrink-0 border-l border-neutral-800 overflow-y-auto">
  {/* Tab switcher */}
  <div className="flex border-b border-neutral-800 shrink-0">
    <button
      onClick={() => setSidebarTab("concepts")}
      className={`flex-1 text-[11px] font-semibold px-3 py-2.5 transition-colors ${
        sidebarTab === "concepts"
          ? "text-amber-300 border-b-2 border-amber-300"
          : "text-neutral-500 hover:text-neutral-300"
      }`}
    >
      Concepts{concepts.length > 0 ? ` (${concepts.length})` : ""}
    </button>
    <button
      onClick={() => setSidebarTab("mentions")}
      className={`flex-1 text-[11px] font-semibold px-3 py-2.5 transition-colors ${
        sidebarTab === "mentions"
          ? "text-blue-300 border-b-2 border-blue-300"
          : "text-neutral-500 hover:text-neutral-300"
      }`}
    >
      Mentions{mentions.length > 0 ? ` (${mentions.length})` : ""}
    </button>
  </div>

  {/* Tab content */}
  <div className="flex-1 min-h-0 overflow-y-auto p-4">
    {sidebarTab === "concepts" && (
      <>
        {concepts.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-2">Concepts</h2>
            <div className="flex flex-wrap gap-1.5">
              {concepts.map((c: any) => (
                <a
                  key={c.rkey}
                  href={`/concepts/${c.rkey}`}
                  className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300/80 hover:bg-amber-500/20 hover:text-amber-200 transition-colors"
                >
                  {c.name}
                </a>
              ))}
            </div>
          </section>
        )}
      </>
    )}

    {sidebarTab === "mentions" && (
      <MentionsSidebar mentions={mentions} words={[]} />
    )}
  </div>

  {/* Mobile speakers (shown below transcript on small screens) */}
  <section className="lg:hidden p-4">
    <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-1">Speakers</h2>
    {speakers.map((s: any) => (
      <a key={s.rkey} href={`/speakers/${s.rkey}`} className="block text-sm text-neutral-200 hover:text-white">
        {s.name}
      </a>
    ))}
  </section>
</aside>
```

- [ ] **Step 3: Verify build**

```bash
cd apps/ionosphere && npx next build 2>&1 | tail -20
```

Expected: Clean build with mentions tab rendered in sidebar.

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere/src/app/talks/[rkey]/TalkContent.tsx
git commit -m "feat: tabbed sidebar with mentions alongside concepts"
```

---

## Task 7: End-to-End Verification

- [ ] **Step 1: Run fetch script if not already done**

```bash
source apps/ionosphere-appview/.env && BOT_PASSWORD="$BOT_PASSWORD" node scripts/fetch-mentions.mjs
```

- [ ] **Step 2: Start appview**

```bash
cd apps/ionosphere-appview && npm run dev &
```

- [ ] **Step 3: Verify API returns data**

```bash
curl -s 'http://localhost:3001/xrpc/tv.ionosphere.getMentions?talkRkey=landslide' | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.total,'mentions');if(j.mentions[0])console.log('first:',j.mentions[0].author_handle,j.mentions[0].text?.slice(0,80))})"
```

- [ ] **Step 4: Start frontend and verify UI**

```bash
cd apps/ionosphere && npm run dev
```

Open a talk page with known mentions (e.g., "Landslide" by Erin Kissane). Verify:
- Tab switcher shows "Concepts (N)" and "Mentions (N)"
- Clicking Mentions tab shows mention cards with author, text, likes
- Cards show time offset (e.g., "14:32")
- Clicking a card seeks the video
- Thread replies expand inline

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: conference mentions integration — time-aligned Bluesky mentions in talk sidebar"
```
