/**
 * Use LLM to extract projects from talk transcripts and speaker bios.
 * Reads the first ~500 words and last ~200 words of each transcript
 * plus speaker bio, asks the LLM to identify projects with URLs.
 */

import { createRequire } from 'module';
const require = createRequire(
  new URL('../apps/ionosphere-appview/package.json', import.meta.url).pathname
);
const Database = require('better-sqlite3');

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'apps', 'data', 'ionosphere.sqlite');
const OUTPUT_PATH = join(__dirname, '..', 'apps', 'data', 'atmosphere-projects.json');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function askLLM(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 1000,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.choices[0]?.message?.content || '';
}

async function main() {
  console.log('=== Extract Projects from Talks via LLM ===\n');

  const db = new Database(DB_PATH, { readonly: true });

  // Get all talks with transcripts and speaker info
  const talks = db.prepare(`
    SELECT DISTINCT t.rkey, t.title, t.talk_type, t.category,
           GROUP_CONCAT(DISTINCT s.name) as speakers,
           GROUP_CONCAT(DISTINCT s.handle) as handles,
           GROUP_CONCAT(DISTINCT s.bio) as bios
    FROM talks t
    JOIN talk_speakers ts ON ts.talk_uri = t.uri
    JOIN speakers s ON s.uri = ts.speaker_uri
    WHERE t.starts_at IS NOT NULL
    GROUP BY t.rkey
    ORDER BY t.starts_at
  `).all();

  const transcriptStmt = db.prepare(`
    SELECT text FROM transcripts WHERE talk_uri = (
      SELECT uri FROM talks WHERE rkey = ? LIMIT 1
    ) LIMIT 1
  `);

  console.log(`${talks.length} talks to analyze\n`);

  const allProjects = [];
  let processed = 0;

  // Process in batches of 5 talks per LLM call to save tokens
  for (let i = 0; i < talks.length; i += 5) {
    const batch = talks.slice(i, i + 5);
    const talkDescriptions = [];

    for (const talk of batch) {
      const transcript = transcriptStmt.get(talk.rkey);
      let intro = '';
      let outro = '';
      if (transcript?.text) {
        const words = transcript.text.split(/\s+/);
        intro = words.slice(0, 400).join(' ');
        outro = words.slice(-150).join(' ');
      }

      talkDescriptions.push(`
TALK: "${talk.title}"
TYPE: ${talk.talk_type || 'presentation'}
SPEAKERS: ${talk.speakers}
HANDLES: ${talk.handles}
BIOS: ${talk.bios || 'N/A'}
TRANSCRIPT INTRO: ${intro || 'N/A'}
TRANSCRIPT OUTRO: ${outro || 'N/A'}
---`);
    }

    const prompt = `You are extracting ATProto/Atmosphere ecosystem projects from conference talks.

For each talk below, identify the SPECIFIC PROJECTS, TOOLS, APPS, or ORGANIZATIONS that the speaker is presenting or has built. NOT general technologies (React, SQLite, etc.) — only specific named projects in the ATProto/Bluesky ecosystem or related.

For each project found, provide:
- name: The project name
- url: The project URL if mentioned or inferable (e.g., if handle is "semble.so", url is likely "https://semble.so"). Use null if unknown.
- talkRkey: The talk's rkey (provided below)
- speakers: The speaker(s) presenting it

Return ONLY a JSON array. If a talk has no specific project, skip it entirely. If a talk features multiple projects, include each separately.

${talkDescriptions.join('\n')}

Return ONLY valid JSON array, no markdown fences, no explanation:`;

    try {
      const response = await askLLM(prompt);
      // Parse JSON from response
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      try {
        const projects = JSON.parse(cleaned);
        if (Array.isArray(projects)) {
          allProjects.push(...projects);
          processed += batch.length;
          const names = projects.map(p => p.name).join(', ');
          console.log(`[${processed}/${talks.length}] Found ${projects.length}: ${names}`);
        }
      } catch (parseErr) {
        console.error(`  Parse error for batch starting "${batch[0].title}": ${parseErr.message}`);
        console.error(`  Response: ${cleaned.slice(0, 200)}`);
        processed += batch.length;
      }
    } catch (err) {
      console.error(`  API error: ${err.message}`);
      processed += batch.length;
    }

    await sleep(500); // rate limit
  }

  // Deduplicate by name (keep the one with a URL, or first seen)
  const seen = new Map();
  for (const proj of allProjects) {
    const key = proj.name?.toLowerCase();
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing || (!existing.url && proj.url)) {
      seen.set(key, proj);
    }
  }

  const deduplicated = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));

  console.log(`\n=== DONE ===`);
  console.log(`Total projects found: ${allProjects.length}`);
  console.log(`After dedup: ${deduplicated.length}`);

  // Write output
  writeFileSync(OUTPUT_PATH, JSON.stringify(deduplicated, null, 2));
  console.log(`Saved to ${OUTPUT_PATH}`);

  db.close();
}

main().catch(console.error);
