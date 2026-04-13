/**
 * Prototype: Explore Bluesky mentions of ATmosphereConf speakers
 *
 * Searches for:
 * 1. @mentions of each speaker during the conference (March 26-29, 2026)
 * 2. Conference-related hashtags and keywords
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

const CONF_SINCE = '2026-03-25T00:00:00Z'; // day before for travel chatter
const CONF_UNTIL = '2026-03-31T00:00:00Z'; // day after for wrap-up

const agent = new BskyAgent({ service: 'https://bsky.social' });

// Rate limit helper
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchPosts(params) {
  const res = await agent.app.bsky.feed.searchPosts(params);
  return res.data;
}

// Get speakers from DB
function getSpeakers() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT DISTINCT name, handle FROM speakers
    WHERE handle IS NOT NULL AND handle != '' AND name != 'Test Speaker'
    ORDER BY name
  `).all();
  db.close();
  return rows;
}

// Search for mentions of a specific speaker handle
async function searchMentionsOf(handle) {
  try {
    const data = await searchPosts({
      q: '*',
      mentions: handle,
      since: CONF_SINCE,
      until: CONF_UNTIL,
      sort: 'latest',
      limit: 100,
    });
    return data.posts || [];
  } catch (e) {
    // Try without wildcard
    try {
      const data = await searchPosts({
        q: 'atmosphere OR atproto OR bluesky',
        mentions: handle,
        since: CONF_SINCE,
        until: CONF_UNTIL,
        sort: 'latest',
        limit: 100,
      });
      return data.posts || [];
    } catch (e2) {
      console.error(`  Error searching mentions of ${handle}: ${e2.message}`);
      return [];
    }
  }
}

// Search for general conference buzz
async function searchConferenceBuzz() {
  const queries = [
    { q: 'atmosphere conf', label: '"atmosphere conf"' },
    { q: 'atmosphereconf', label: '"atmosphereconf"' },
    { q: '#atmosphere', label: '#atmosphere hashtag' },
    { q: 'ATmosphere', label: '"ATmosphere"' },
    { q: 'ionosphere.tv', label: '"ionosphere.tv"' },
  ];

  const results = {};
  for (const { q, label } of queries) {
    try {
      const data = await searchPosts({
        q,
        since: CONF_SINCE,
        until: CONF_UNTIL,
        sort: 'latest',
        limit: 100,
      });
      results[label] = data.posts || [];
      console.log(`  "${label}": ${results[label].length} posts (hitsTotal: ${data.hitsTotal || '?'})`);
      await sleep(200);
    } catch (e) {
      console.error(`  Error searching "${label}": ${e.message}`);
      results[label] = [];
    }
  }
  return results;
}

async function main() {
  console.log('=== ATmosphereConf Bluesky Mentions Explorer ===\n');
  console.log(`Conference window: ${CONF_SINCE} to ${CONF_UNTIL}\n`);

  // Authenticate
  console.log('Logging in...');
  await agent.login({
    identifier: 'ionosphere.tv',
    password: process.env.BOT_PASSWORD,
  });
  console.log('Authenticated as ionosphere.tv\n');

  // Phase 1: General conference buzz
  console.log('--- Phase 1: Conference Buzz ---');
  const buzz = await searchConferenceBuzz();

  // Collect unique posts from buzz
  const buzzPosts = new Map();
  for (const posts of Object.values(buzz)) {
    for (const post of posts) {
      buzzPosts.set(post.uri, post);
    }
  }
  console.log(`\nTotal unique conference buzz posts: ${buzzPosts.size}\n`);

  // Show top buzz posts
  if (buzzPosts.size > 0) {
    console.log('--- Sample Conference Posts ---');
    const sorted = [...buzzPosts.values()]
      .sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))
      .slice(0, 20);
    for (const post of sorted) {
      const text = post.record?.text?.substring(0, 120).replace(/\n/g, ' ');
      console.log(`  @${post.author.handle} (${post.likeCount || 0} likes): ${text}`);
    }
    console.log();
  }

  // Phase 2: Speaker mentions
  console.log('--- Phase 2: Speaker Mentions ---');
  const speakers = getSpeakers();
  console.log(`Searching mentions for ${speakers.length} speakers...\n`);

  const speakerMentions = [];
  let searched = 0;

  for (const speaker of speakers) {
    const posts = await searchMentionsOf(speaker.handle);
    if (posts.length > 0) {
      speakerMentions.push({ ...speaker, posts, count: posts.length });
      console.log(`  ✓ ${speaker.name} (@${speaker.handle}): ${posts.length} mentions`);
    }
    searched++;
    if (searched % 20 === 0) {
      console.log(`  ... searched ${searched}/${speakers.length} speakers`);
    }
    await sleep(150); // be nice to the API
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`Conference buzz posts: ${buzzPosts.size}`);
  console.log(`Speakers with mentions: ${speakerMentions.length}/${speakers.length}`);
  console.log(`Total speaker mention posts: ${speakerMentions.reduce((s, m) => s + m.count, 0)}`);

  if (speakerMentions.length > 0) {
    console.log('\n--- Most Mentioned Speakers ---');
    speakerMentions
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .forEach(s => console.log(`  ${s.count.toString().padStart(3)} mentions: ${s.name} (@${s.handle})`));
  }

  // Collect all unique posts across everything
  const allPosts = new Map(buzzPosts);
  for (const s of speakerMentions) {
    for (const p of s.posts) {
      allPosts.set(p.uri, p);
    }
  }
  console.log(`\nTotal unique posts found: ${allPosts.size}`);

  // Save raw data for further analysis
  const output = {
    searchWindow: { since: CONF_SINCE, until: CONF_UNTIL },
    buzzQueries: Object.fromEntries(
      Object.entries(buzz).map(([k, posts]) => [k, posts.length])
    ),
    speakerMentions: speakerMentions.map(s => ({
      name: s.name,
      handle: s.handle,
      mentionCount: s.count,
      posts: s.posts.map(p => ({
        uri: p.uri,
        author: p.author.handle,
        text: p.record?.text,
        createdAt: p.record?.createdAt,
        likes: p.likeCount || 0,
        reposts: p.repostCount || 0,
        replies: p.replyCount || 0,
      })),
    })),
    buzzPosts: [...buzzPosts.values()].map(p => ({
      uri: p.uri,
      author: p.author.handle,
      text: p.record?.text,
      createdAt: p.record?.createdAt,
      likes: p.likeCount || 0,
      reposts: p.repostCount || 0,
      replies: p.replyCount || 0,
    })),
    totalUniquePosts: allPosts.size,
  };

  const fs = await import('fs');
  const outPath = join(__dirname, '..', 'apps', 'data', 'conference-mentions.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nRaw data saved to ${outPath}`);
}

main().catch(console.error);
