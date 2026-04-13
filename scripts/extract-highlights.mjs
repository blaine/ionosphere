#!/usr/bin/env node
/**
 * extract-highlights.mjs
 *
 * Analyzes Bluesky mentions data to identify the best moments from
 * ATmosphereConf talks. Clusters mentions by minute, scores by engagement,
 * fuzzy-matches quoted text against transcripts for precise timestamps,
 * and writes a highlights.json file.
 */

import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const require = createRequire(
  new URL('../apps/ionosphere-appview/package.json', import.meta.url).pathname
);
const Database = require('better-sqlite3');

const DB_PATH = resolve(__dirname, '../apps/data/ionosphere.sqlite');
const OUTPUT_PATH = resolve(__dirname, '../apps/data/highlights.json');

const MAX_HIGHLIGHTS = 20;
const MAX_PER_TALK = 3;
const CLIP_PRE_MS = 10_000;   // 10s before peak
const CLIP_POST_MS = 50_000;  // 50s after peak
const CLIP_DURATION_MS = 60_000;
const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH, { readonly: true });

// ---------------------------------------------------------------------------
// 1. Load talks that have during_talk mentions
// ---------------------------------------------------------------------------

const talks = db.prepare(`
  SELECT t.uri, t.rkey, t.title, t.video_uri, t.video_offset_ns, t.starts_at, t.ends_at, t.duration,
         GROUP_CONCAT(DISTINCT s.name) as speakers
  FROM talks t
  LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
  LEFT JOIN speakers s ON ts.speaker_uri = s.uri
  WHERE t.rkey IN (
    SELECT DISTINCT talk_rkey FROM mentions
    WHERE talk_rkey IS NOT NULL AND mention_type = 'during_talk'
  )
  GROUP BY t.uri
`).all();

console.log(`Found ${talks.length} talks with during_talk mentions`);

// ---------------------------------------------------------------------------
// 2. Load all during_talk mentions with profile info
// ---------------------------------------------------------------------------

const allMentions = db.prepare(`
  SELECT m.uri, m.talk_rkey, m.text, m.likes, m.reposts, m.replies,
         m.talk_offset_ms, m.author_did, m.author_handle, m.mention_type,
         p.display_name as author_display_name, p.avatar_url as author_avatar_url,
         m.image_url
  FROM mentions m
  LEFT JOIN profiles p ON m.author_did = p.did
  WHERE m.talk_rkey IS NOT NULL
    AND m.mention_type = 'during_talk'
    AND m.talk_offset_ms IS NOT NULL
  ORDER BY m.likes DESC
`).all();

console.log(`Found ${allMentions.length} during_talk mentions with offsets`);

// ---------------------------------------------------------------------------
// 3. Load transcripts indexed by talk_uri
// ---------------------------------------------------------------------------

const transcriptRows = db.prepare(`
  SELECT talk_uri, text, start_ms, timings FROM transcripts
`).all();

const transcriptsByTalkUri = new Map();
for (const row of transcriptRows) {
  if (!transcriptsByTalkUri.has(row.talk_uri)) {
    transcriptsByTalkUri.set(row.talk_uri, []);
  }
  transcriptsByTalkUri.get(row.talk_uri).push({
    text: row.text,
    startMs: row.start_ms,
    timings: JSON.parse(row.timings),
  });
}

// ---------------------------------------------------------------------------
// Transcript utilities
// ---------------------------------------------------------------------------

/**
 * Build a word-to-timestamp index from transcript timings.
 * Returns array of { word, startMs } for each word.
 */
function buildWordIndex(transcript) {
  const words = transcript.text.split(/\s+/);
  const timings = transcript.timings;
  const result = [];
  let cursor = transcript.startMs;
  let timingIdx = 0;

  for (let i = 0; i < words.length; i++) {
    result.push({ word: words[i], startMs: cursor });

    // Advance cursor: consume the word's duration (positive timing)
    if (timingIdx < timings.length && timings[timingIdx] >= 0) {
      cursor += timings[timingIdx];
      timingIdx++;
    }

    // Consume any silence gaps (negative timings) after this word
    while (timingIdx < timings.length && timings[timingIdx] < 0) {
      cursor += Math.abs(timings[timingIdx]);
      timingIdx++;
    }
  }

  return result;
}

/**
 * Get a transcript snippet (first ~100 words) starting near a given offset (ms).
 */
function getTranscriptSnippet(talkUri, offsetMs, maxWords = 100) {
  const transcripts = transcriptsByTalkUri.get(talkUri);
  if (!transcripts || transcripts.length === 0) return null;

  for (const transcript of transcripts) {
    const wordIndex = buildWordIndex(transcript);
    // Find the word closest to offsetMs
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < wordIndex.length; i++) {
      const diff = Math.abs(wordIndex[i].startMs - offsetMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }

    // Start a few words before
    const startIdx = Math.max(0, bestIdx - 3);
    const endIdx = Math.min(wordIndex.length, startIdx + maxWords);
    const snippet = wordIndex.slice(startIdx, endIdx).map(w => w.word).join(' ');
    if (snippet.length > 0) {
      return '...' + snippet + '...';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. Fuzzy-match quoted text against transcripts
// ---------------------------------------------------------------------------

/**
 * Extract quoted phrases from mention text.
 * Looks for text between quotation marks (straight or smart) or after "says".
 */
function extractQuotes(text) {
  const quotes = [];
  if (!text) return quotes;

  // Smart quotes: \u201c...\u201d
  const smartQuoteRe = /\u201c([^"\u201d]{8,})\u201d/g;
  let m;
  while ((m = smartQuoteRe.exec(text)) !== null) {
    quotes.push(m[1].trim());
  }

  // Straight quotes: "..."
  const straightQuoteRe = /"([^"]{8,})"/g;
  while ((m = straightQuoteRe.exec(text)) !== null) {
    quotes.push(m[1].trim());
  }

  // After "says" — grab the rest of the sentence
  const saysRe = /\bsays?\b[,:]?\s+[""\u201c]?([^"""\u201d\n]{8,})/gi;
  while ((m = saysRe.exec(text)) !== null) {
    quotes.push(m[1].trim().replace(/["""\u201d]+$/, ''));
  }

  return quotes;
}

/**
 * Simple fuzzy substring match.
 * Normalizes both strings and looks for the best matching window.
 * Returns { score, position } where score is 0-1 (1 = perfect match).
 */
function fuzzySubstringMatch(needle, haystack) {
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const nNorm = normalize(needle);
  const hNorm = normalize(haystack);

  if (nNorm.length < 5) return { score: 0, position: -1 };

  // Try exact substring first
  const exactIdx = hNorm.indexOf(nNorm);
  if (exactIdx >= 0) {
    return { score: 1.0, position: exactIdx };
  }

  // Sliding window: compare n-grams
  const needleWords = nNorm.split(' ');
  const haystackWords = hNorm.split(' ');

  if (needleWords.length < 3 || haystackWords.length < needleWords.length) {
    return { score: 0, position: -1 };
  }

  let bestScore = 0;
  let bestPos = -1;
  const windowSize = needleWords.length;

  for (let i = 0; i <= haystackWords.length - windowSize; i++) {
    const window = haystackWords.slice(i, i + windowSize);
    let matches = 0;
    for (let j = 0; j < windowSize; j++) {
      if (window[j] === needleWords[j]) matches++;
    }
    const score = matches / windowSize;
    if (score > bestScore) {
      bestScore = score;
      bestPos = i;
    }
  }

  return { score: bestScore, position: bestPos };
}

/**
 * Try to find a precise timestamp for a quoted phrase in the talk's transcript.
 * Returns offsetMs if found with sufficient confidence, otherwise null.
 */
function findQuoteTimestamp(talkUri, quotedText) {
  const transcripts = transcriptsByTalkUri.get(talkUri);
  if (!transcripts || transcripts.length === 0) return null;

  for (const transcript of transcripts) {
    const wordIndex = buildWordIndex(transcript);
    const fullText = wordIndex.map(w => w.word).join(' ');

    const match = fuzzySubstringMatch(quotedText, fullText);

    if (match.score >= 0.6 && match.position >= 0) {
      // match.position is a word index into the fullText words
      const words = fullText.split(' ');
      // Find the character position of the matched word to map back to wordIndex
      if (match.position < wordIndex.length) {
        return wordIndex[match.position].startMs;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. Cluster mentions by minute per talk, score each minute
// ---------------------------------------------------------------------------

/** Group mentions by talk_rkey */
const mentionsByTalk = new Map();
for (const m of allMentions) {
  if (!mentionsByTalk.has(m.talk_rkey)) {
    mentionsByTalk.set(m.talk_rkey, []);
  }
  mentionsByTalk.get(m.talk_rkey).push(m);
}

const talkMap = new Map(talks.map(t => [t.rkey, t]));

/**
 * For each talk, cluster mentions into minute buckets and score.
 * Returns array of { talk, minute, score, mentions, peakOffsetMs, topMention }
 */
function clusterAndScore() {
  const clusters = [];

  for (const [talkRkey, mentions] of mentionsByTalk) {
    const talk = talkMap.get(talkRkey);
    if (!talk) continue;

    // Bucket by minute
    const buckets = new Map();
    for (const m of mentions) {
      const minute = Math.floor(m.talk_offset_ms / MINUTE_MS);
      if (!buckets.has(minute)) {
        buckets.set(minute, []);
      }
      buckets.get(minute).push(m);
    }

    for (const [minute, bucketMentions] of buckets) {
      // Score = sum of likes in this minute bucket
      const score = bucketMentions.reduce((sum, m) => sum + (m.likes || 0), 0);
      // Top mention by likes
      const topMention = bucketMentions.reduce((best, m) =>
        (m.likes || 0) > (best.likes || 0) ? m : best
      , bucketMentions[0]);

      // Try to refine the peak offset using quote matching
      let peakOffsetMs = topMention.talk_offset_ms;
      const quotes = extractQuotes(topMention.text);
      if (quotes.length > 0) {
        for (const quote of quotes) {
          const ts = findQuoteTimestamp(talk.uri, quote);
          if (ts !== null) {
            console.log(`  Quote match: "${quote.substring(0, 50)}..." -> ${ts}ms (was ${peakOffsetMs}ms)`);
            peakOffsetMs = ts;
            break;
          }
        }
      }

      clusters.push({
        talk,
        minute,
        score,
        mentionCount: bucketMentions.length,
        peakOffsetMs,
        topMention,
      });
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// 6. Select top highlights with diversity
// ---------------------------------------------------------------------------

function selectHighlights(clusters) {
  // Sort by score descending
  clusters.sort((a, b) => b.score - a.score);

  const selected = [];
  const talkCounts = new Map();

  for (const cluster of clusters) {
    const rkey = cluster.talk.rkey;
    const count = talkCounts.get(rkey) || 0;

    if (count >= MAX_PER_TALK) continue;
    if (selected.length >= MAX_HIGHLIGHTS) break;

    // Ensure no overlapping clips (within same talk)
    const existingForTalk = selected.filter(s => s.talk.rkey === rkey);
    const clipStart = cluster.peakOffsetMs - CLIP_PRE_MS;
    const clipEnd = cluster.peakOffsetMs + CLIP_POST_MS;
    const overlaps = existingForTalk.some(s => {
      const sStart = s.peakOffsetMs - CLIP_PRE_MS;
      const sEnd = s.peakOffsetMs + CLIP_POST_MS;
      return clipStart < sEnd && clipEnd > sStart;
    });
    if (overlaps) continue;

    selected.push(cluster);
    talkCounts.set(rkey, count + 1);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// 7. Build output
// ---------------------------------------------------------------------------

function buildOutput(highlights) {
  return highlights.map((h, i) => {
    const clipStartMs = Math.max(0, h.peakOffsetMs - CLIP_PRE_MS);
    const clipEndMs = clipStartMs + CLIP_DURATION_MS;

    const snippet = getTranscriptSnippet(h.talk.uri, h.peakOffsetMs);

    return {
      rank: i + 1,
      talkRkey: h.talk.rkey,
      talkTitle: h.talk.title,
      speakers: h.talk.speakers || '',
      videoUri: h.talk.video_uri,
      videoOffsetNs: h.talk.video_offset_ns || 0,
      clipStartMs,
      clipEndMs,
      clipDurationMs: CLIP_DURATION_MS,
      peakOffsetMs: h.peakOffsetMs,
      score: h.score,
      topMention: {
        text: h.topMention.text,
        authorHandle: h.topMention.author_handle,
        authorDisplayName: h.topMention.author_display_name || h.topMention.author_handle,
        authorAvatarUrl: h.topMention.author_avatar_url || null,
        likes: h.topMention.likes || 0,
      },
      mentionCount: h.mentionCount,
      transcriptSnippet: snippet,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('\nClustering mentions by minute...');
const clusters = clusterAndScore();
console.log(`Found ${clusters.length} minute-clusters across ${mentionsByTalk.size} talks`);

console.log('\nSelecting top highlights...');
const highlights = selectHighlights(clusters);
console.log(`Selected ${highlights.length} highlights`);

const output = buildOutput(highlights);

writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
console.log(`\nWrote ${output.length} highlights to ${OUTPUT_PATH}`);

// Print summary
console.log('\n=== HIGHLIGHTS SUMMARY ===');
for (const h of output) {
  console.log(`#${h.rank} [score=${h.score}] ${h.talkTitle.substring(0, 50)}`);
  console.log(`   ${h.speakers}`);
  console.log(`   ${h.topMention.authorHandle}: ${h.topMention.text.substring(0, 80)}...`);
  console.log(`   clip: ${(h.clipStartMs / 1000).toFixed(0)}s - ${(h.clipEndMs / 1000).toFixed(0)}s (peak at ${(h.peakOffsetMs / 1000).toFixed(0)}s)`);
  console.log();
}
