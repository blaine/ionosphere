/**
 * Align Bluesky mentions to specific talks by time window.
 *
 * For each talk, finds posts that:
 * 1. @-mention one of the talk's speakers
 * 2. Were posted during the talk or within a buffer window after
 *
 * Also searches for posts mentioning the talk title/topic during the window.
 */

import { createRequire } from 'module';
const require = createRequire(
  new URL('../apps/ionosphere-appview/package.json', import.meta.url).pathname
);
const { BskyAgent } = require('@atproto/api');
const Database = require('better-sqlite3');

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'apps', 'data', 'ionosphere.sqlite');

// Buffer: include posts up to 30 min after talk ends (people post after)
const POST_BUFFER_MS = 30 * 60 * 1000;
// Also include posts starting 5 min before (anticipation)
const PRE_BUFFER_MS = 5 * 60 * 1000;

const agent = new BskyAgent({ service: 'https://bsky.social' });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchMentions(handle, since, until) {
  try {
    const data = await agent.app.bsky.feed.searchPosts({
      q: '*',
      mentions: handle,
      since,
      until,
      sort: 'latest',
      limit: 100,
    });
    return data.data?.posts || [];
  } catch (e) {
    // Fallback: broader query
    try {
      const data = await agent.app.bsky.feed.searchPosts({
        q: 'atmosphere OR atproto',
        mentions: handle,
        since,
        until,
        sort: 'latest',
        limit: 100,
      });
      return data.data?.posts || [];
    } catch {
      return [];
    }
  }
}

function getTalksWithSpeakers() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT DISTINCT t.uri, t.title, t.starts_at, t.ends_at, t.room,
           s.name as speaker_name, s.handle as speaker_handle
    FROM talks t
    JOIN talk_speakers ts ON ts.talk_uri = t.uri
    JOIN speakers s ON s.uri = ts.speaker_uri
    WHERE t.starts_at IS NOT NULL AND t.ends_at IS NOT NULL
    ORDER BY t.starts_at
  `).all();
  db.close();

  // Group by talk
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
    if (!t.speakers.find(s => s.handle === r.speaker_handle)) {
      t.speakers.push({ name: r.speaker_name, handle: r.speaker_handle });
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

async function main() {
  console.log('=== Aligning Mentions to Talks ===\n');

  await agent.login({
    identifier: 'ionosphere.tv',
    password: process.env.BOT_PASSWORD,
  });
  console.log('Authenticated\n');

  const talks = getTalksWithSpeakers();
  console.log(`${talks.length} talks with scheduled times\n`);

  const results = [];

  for (let i = 0; i < talks.length; i++) {
    const talk = talks[i];
    const talkStart = new Date(talk.starts_at);
    const talkEnd = new Date(talk.ends_at);

    // Search window: 5min before to 30min after
    const since = new Date(talkStart.getTime() - PRE_BUFFER_MS).toISOString();
    const until = new Date(talkEnd.getTime() + POST_BUFFER_MS).toISOString();

    const allPosts = new Map();

    // Search mentions for each speaker
    for (const speaker of talk.speakers) {
      if (!speaker.handle) continue;
      const posts = await searchMentions(speaker.handle, since, until);
      for (const p of posts) {
        allPosts.set(p.uri, {
          uri: p.uri,
          author: p.author.handle,
          authorName: p.author.displayName,
          text: p.record?.text,
          createdAt: p.record?.createdAt,
          likes: p.likeCount || 0,
          reposts: p.repostCount || 0,
          replies: p.replyCount || 0,
          mentionedSpeaker: speaker.handle,
        });
      }
      await sleep(150);
    }

    const posts = [...allPosts.values()].sort((a, b) =>
      new Date(a.createdAt) - new Date(b.createdAt)
    );

    const entry = {
      title: talk.title,
      room: talk.room,
      starts_at: talk.starts_at,
      ends_at: talk.ends_at,
      speakers: talk.speakers.map(s => `${s.name} (@${s.handle})`),
      mentionCount: posts.length,
      posts,
    };
    results.push(entry);

    if (posts.length > 0) {
      console.log(`[${i + 1}/${talks.length}] "${talk.title}" — ${posts.length} mentions during talk`);
      // Show top post
      const top = posts.sort((a, b) => b.likes - a.likes)[0];
      if (top) {
        const snippet = top.text?.substring(0, 100).replace(/\n/g, ' ');
        console.log(`    Top: @${top.author} (${top.likes} likes): ${snippet}`);
      }
    } else {
      console.log(`[${i + 1}/${talks.length}] "${talk.title}" — no mentions`);
    }
  }

  // Summary
  const withMentions = results.filter(r => r.mentionCount > 0);
  console.log('\n=== SUMMARY ===');
  console.log(`Talks with mentions during their timeslot: ${withMentions.length}/${results.length}`);
  console.log(`Total aligned mentions: ${results.reduce((s, r) => s + r.mentionCount, 0)}`);

  console.log('\n--- Most Buzzed Talks ---');
  results
    .filter(r => r.mentionCount > 0)
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, 25)
    .forEach(r => {
      console.log(`  ${r.mentionCount.toString().padStart(3)} mentions: "${r.title}" (${r.speakers.join(', ')})`);
    });

  // Save
  const outPath = join(__dirname, '..', 'apps', 'data', 'talk-aligned-mentions.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nData saved to ${outPath}`);
}

main().catch(console.error);
