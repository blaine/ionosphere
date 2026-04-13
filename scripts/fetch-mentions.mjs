/**
 * Fetch Bluesky mentions for all talks and upsert into SQLite.
 *
 * For each talk:
 *   1. Searches @-mentions of each speaker handle during the talk window
 *      (starts_at - 5min to ends_at + 30min)
 *   2. Paginates with cursors (up to 10 pages per query)
 *   3. Computes talk_offset_ms and maps to transcript byte_position
 *   4. Fetches threads (depth 2) for posts with replies
 *   5. Searches post-conference domain mentions (ionosphere.tv, stream.place)
 *   6. Upserts everything into the `mentions` SQLite table
 *
 * Usage:
 *   BOT_PASSWORD=xxx node scripts/fetch-mentions.mjs
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

const PRE_BUFFER_MS = 5 * 60 * 1000;   // 5 min before talk
const POST_BUFFER_MS = 30 * 60 * 1000;  // 30 min after talk
const MAX_PAGES = 10;
const PAGE_LIMIT = 100;

const agent = new BskyAgent({ service: 'https://bsky.social' });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomDelay() { return 150 + Math.random() * 50; } // 150–200ms

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

function getTalksWithSpeakers(db) {
  const rows = db.prepare(`
    SELECT DISTINCT t.uri, t.title, t.starts_at, t.ends_at, t.room,
           s.name AS speaker_name, s.handle AS speaker_handle,
           s.did AS speaker_did
    FROM talks t
    JOIN talk_speakers ts ON ts.talk_uri = t.uri
    JOIN speakers s ON s.uri = ts.speaker_uri
    WHERE t.starts_at IS NOT NULL AND t.ends_at IS NOT NULL
    ORDER BY t.starts_at
  `).all();

  const talks = new Map();
  for (const r of rows) {
    if (!talks.has(r.uri)) {
      talks.set(r.uri, {
        uri: r.uri,
        title: r.title,
        starts_at: r.starts_at,
        ends_at: r.ends_at,
        room: r.room,
        speakers: [],
      });
    }
    const t = talks.get(r.uri);
    if (r.speaker_handle && !t.speakers.find(s => s.handle === r.speaker_handle)) {
      t.speakers.push({
        name: r.speaker_name,
        handle: r.speaker_handle,
        did: r.speaker_did,
      });
    }
  }

  // Deduplicate by title + start time
  const seen = new Set();
  return [...talks.values()].filter(t => {
    const key = `${t.title}|${t.starts_at}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getTranscriptForTalk(db, talkUri) {
  return db.prepare(`
    SELECT text, start_ms, timings FROM transcripts WHERE talk_uri = ?
  `).get(talkUri);
}

// ---------------------------------------------------------------------------
// Transcript byte-position mapping
// ---------------------------------------------------------------------------

/**
 * Given a transcript (text, startMs, timings array) and a target offset in ms
 * (relative to the talk start), return the byte position in the transcript text.
 *
 * Walk the timings array: positive = word duration ms, negative = silence gap ms.
 * Track cursor in ms (starting at startMs) and a word index. When cursor crosses
 * the target, return the byte position of that word.
 */
function offsetToBytePosition(text, startMs, timings, targetOffsetMs) {
  if (!text || !timings || timings.length === 0) return null;

  const encoder = new TextEncoder();
  // Split text on whitespace and find byte offset of each word
  const words = text.split(/\s+/);
  const wordByteOffsets = [];
  let searchFrom = 0;
  for (const word of words) {
    const idx = text.indexOf(word, searchFrom);
    if (idx === -1) {
      wordByteOffsets.push(encoder.encode(text.substring(0, searchFrom)).length);
    } else {
      wordByteOffsets.push(encoder.encode(text.substring(0, idx)).length);
      searchFrom = idx + word.length;
    }
  }

  // Walk timings to find which word corresponds to the target offset
  let cursorMs = startMs;
  let wordIdx = 0;

  for (const val of timings) {
    if (val < 0) {
      // Silence gap
      cursorMs += Math.abs(val);
    } else {
      // Word duration
      if (cursorMs + val >= targetOffsetMs) {
        // This word spans the target offset
        return wordIdx < wordByteOffsets.length ? wordByteOffsets[wordIdx] : null;
      }
      cursorMs += val;
      wordIdx++;
    }
  }

  // Past the end — return last word position
  return wordIdx > 0 && wordIdx - 1 < wordByteOffsets.length
    ? wordByteOffsets[wordIdx - 1]
    : null;
}

// ---------------------------------------------------------------------------
// Bluesky API helpers
// ---------------------------------------------------------------------------

async function searchPostsPaginated(params) {
  const allPosts = [];
  let cursor = undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await agent.app.bsky.feed.searchPosts({
      ...params,
      limit: PAGE_LIMIT,
      cursor,
    });
    const posts = res.data?.posts || [];
    allPosts.push(...posts);

    cursor = res.data?.cursor;
    if (!cursor || posts.length < PAGE_LIMIT) break;

    await sleep(randomDelay());
  }

  return allPosts;
}

async function searchMentionsOf(handle, since, until) {
  try {
    return await searchPostsPaginated({
      q: '*',
      mentions: handle,
      since,
      until,
      sort: 'latest',
    });
  } catch {
    // Fallback with broader query
    try {
      return await searchPostsPaginated({
        q: 'atmosphere OR atproto',
        mentions: handle,
        since,
        until,
        sort: 'latest',
      });
    } catch {
      return [];
    }
  }
}

async function fetchThread(uri) {
  try {
    const res = await agent.app.bsky.feed.getPostThread({ uri, depth: 2 });
    return res.data?.thread;
  } catch {
    return null;
  }
}

/**
 * Extract reply posts from a thread tree (depth-first).
 */
function extractReplies(thread, maxDepth = 2, depth = 0) {
  const replies = [];
  if (!thread?.replies || depth >= maxDepth) return replies;
  for (const reply of thread.replies) {
    if (reply?.post) {
      replies.push(reply.post);
    }
    replies.push(...extractReplies(reply, maxDepth, depth + 1));
  }
  return replies;
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

function buildUpsertStmt(db) {
  return db.prepare(`
    INSERT INTO mentions (
      uri, talk_uri, author_did, author_handle, text, created_at,
      talk_offset_ms, byte_position, likes, reposts, replies,
      parent_uri, mention_type, indexed_at
    ) VALUES (
      @uri, @talk_uri, @author_did, @author_handle, @text, @created_at,
      @talk_offset_ms, @byte_position, @likes, @reposts, @replies,
      @parent_uri, @mention_type, @indexed_at
    ) ON CONFLICT(uri) DO UPDATE SET
      talk_uri = @talk_uri,
      author_did = @author_did,
      author_handle = @author_handle,
      text = @text,
      talk_offset_ms = @talk_offset_ms,
      byte_position = @byte_position,
      likes = @likes,
      reposts = @reposts,
      replies = @replies,
      parent_uri = @parent_uri,
      mention_type = @mention_type,
      indexed_at = @indexed_at
  `);
}

function postToRow(post, talkUri, talkStartMs, transcript, mentionType, parentUri) {
  const createdAt = post.record?.createdAt || post.indexedAt;
  const postMs = new Date(createdAt).getTime();
  const talkOffsetMs = talkStartMs ? postMs - talkStartMs : null;

  let bytePosition = null;
  if (transcript && talkOffsetMs != null) {
    const timings = typeof transcript.timings === 'string'
      ? JSON.parse(transcript.timings)
      : transcript.timings;
    bytePosition = offsetToBytePosition(
      transcript.text, transcript.start_ms, timings, talkOffsetMs
    );
  }

  return {
    uri: post.uri,
    talk_uri: talkUri,
    author_did: post.author.did,
    author_handle: post.author.handle || null,
    text: post.record?.text || null,
    created_at: createdAt,
    talk_offset_ms: talkOffsetMs,
    byte_position: bytePosition,
    likes: post.likeCount || 0,
    reposts: post.repostCount || 0,
    replies: post.replyCount || 0,
    parent_uri: parentUri || null,
    mention_type: mentionType,
    indexed_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.BOT_PASSWORD) {
    console.error('BOT_PASSWORD env var required');
    process.exit(1);
  }

  console.log('=== Fetch Mentions ===\n');

  await agent.login({
    identifier: 'ionosphere.tv',
    password: process.env.BOT_PASSWORD,
  });
  console.log('Authenticated as ionosphere.tv\n');

  const db = new Database(DB_PATH);
  const upsert = buildUpsertStmt(db);
  const talks = getTalksWithSpeakers(db);
  console.log(`${talks.length} talks with scheduled times\n`);

  let totalUpserted = 0;

  // ---- Phase 1: Talk-aligned speaker mentions ----
  console.log('--- Phase 1: Talk-aligned speaker mentions ---\n');

  for (let i = 0; i < talks.length; i++) {
    const talk = talks[i];
    const talkStart = new Date(talk.starts_at);
    const talkEnd = new Date(talk.ends_at);
    const talkStartMs = talkStart.getTime();

    const since = new Date(talkStart.getTime() - PRE_BUFFER_MS).toISOString();
    const until = new Date(talkEnd.getTime() + POST_BUFFER_MS).toISOString();

    const transcript = getTranscriptForTalk(db, talk.uri);

    const allPosts = new Map();

    for (const speaker of talk.speakers) {
      if (!speaker.handle) continue;
      const posts = await searchMentionsOf(speaker.handle, since, until);
      for (const p of posts) {
        if (!allPosts.has(p.uri)) allPosts.set(p.uri, p);
      }
      await sleep(randomDelay());
    }

    // Upsert main posts
    let talkCount = 0;
    const postsWithReplies = [];

    for (const post of allPosts.values()) {
      const row = postToRow(post, talk.uri, talkStartMs, transcript, 'during_talk', null);
      upsert.run(row);
      talkCount++;
      if ((post.replyCount || 0) > 0) {
        postsWithReplies.push(post);
      }
    }

    // Fetch threads for posts with replies
    for (const post of postsWithReplies) {
      const thread = await fetchThread(post.uri);
      if (!thread) continue;

      const replies = extractReplies(thread);
      for (const reply of replies) {
        const row = postToRow(
          reply, talk.uri, talkStartMs, transcript, 'reply', post.uri
        );
        upsert.run(row);
        talkCount++;
      }
      await sleep(randomDelay());
    }

    totalUpserted += talkCount;
    if (talkCount > 0) {
      console.log(`[${i + 1}/${talks.length}] "${talk.title}" -- ${talkCount} mentions`);
    } else {
      console.log(`[${i + 1}/${talks.length}] "${talk.title}" -- no mentions`);
    }
  }

  // ---- Phase 2: Post-conference domain mentions ----
  console.log('\n--- Phase 2: Post-conference domain mentions ---\n');

  const domainQueries = [
    { q: 'ionosphere.tv', label: 'ionosphere.tv' },
    { q: 'stream.place', label: 'stream.place' },
  ];

  // Search across wider conference window
  const confSince = '2026-03-25T00:00:00Z';
  const confUntil = '2026-04-30T00:00:00Z';

  for (const { q, label } of domainQueries) {
    const posts = await searchPostsPaginated({
      q,
      since: confSince,
      until: confUntil,
      sort: 'latest',
    });

    let count = 0;
    for (const post of posts) {
      // Try to match to a talk by finding the closest talk time
      const createdAt = post.record?.createdAt || post.indexedAt;
      const postMs = new Date(createdAt).getTime();
      let bestTalk = null;
      let bestDist = Infinity;

      for (const talk of talks) {
        const talkStartMs = new Date(talk.starts_at).getTime();
        const talkEndMs = new Date(talk.ends_at).getTime();
        // Only match if post is within the talk's extended window
        if (postMs >= talkStartMs - PRE_BUFFER_MS && postMs <= talkEndMs + POST_BUFFER_MS) {
          const dist = Math.abs(postMs - talkStartMs);
          if (dist < bestDist) {
            bestDist = dist;
            bestTalk = talk;
          }
        }
      }

      const talkUri = bestTalk?.uri || null;
      const talkStartMs = bestTalk ? new Date(bestTalk.starts_at).getTime() : null;
      const transcript = bestTalk ? getTranscriptForTalk(db, bestTalk.uri) : null;

      const row = postToRow(
        post, talkUri, talkStartMs, transcript, 'domain_mention', null
      );
      upsert.run(row);
      count++;
    }

    // Fetch threads for domain mention posts that have replies
    for (const post of posts) {
      if ((post.replyCount || 0) === 0) continue;
      const thread = await fetchThread(post.uri);
      if (!thread) continue;

      const replies = extractReplies(thread);
      for (const reply of replies) {
        // Domain mention replies don't map to a specific talk
        const row = postToRow(reply, null, null, null, 'domain_reply', post.uri);
        upsert.run(row);
        count++;
      }
      await sleep(randomDelay());
    }

    totalUpserted += count;
    console.log(`"${label}": ${posts.length} posts, ${count} total rows (with replies)`);
    await sleep(randomDelay());
  }

  db.close();

  console.log(`\n=== Done: ${totalUpserted} rows upserted ===`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
