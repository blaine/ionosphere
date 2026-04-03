/**
 * Detect talk boundaries in a full-day transcript using silence gaps,
 * keyword matching, and LLM analysis.
 *
 * Takes a full-day transcript JSON and the list of scheduled talks,
 * and outputs detected start/end timestamps for each talk.
 *
 * Usage: npx tsx src/detect-boundaries.ts <transcript.json>
 */
import "./env.js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { openDb } from "./db.js";

const client = new OpenAI();

interface WordTimestamp {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

interface FullDayTranscript {
  stream: string;
  room: string;
  day: number;
  uri: string;
  durationSeconds: number;
  text: string;
  words: WordTimestamp[];
  totalWords: number;
}

interface Gap {
  timestamp: number;
  duration: number;
  contextBefore: string;
  contextAfter: string;
}

interface Talk {
  rkey: string;
  title: string;
  room: string;
  starts_at: string;
  ends_at: string;
  speaker_names: string;
}

function fmt(ts: number): string {
  const h = Math.floor(ts / 3600);
  const m = Math.floor((ts % 3600) / 60);
  const s = Math.floor(ts % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Find significant gaps (silence) in the transcript.
 * These are likely talk transitions.
 */
function findGaps(words: WordTimestamp[], minGapSec: number = 8): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= minGapSec) {
      const before = words
        .slice(Math.max(0, i - 15), i)
        .map((w) => w.word)
        .join(" ");
      const after = words
        .slice(i, Math.min(words.length, i + 15))
        .map((w) => w.word)
        .join(" ");
      gaps.push({
        timestamp: words[i].start,
        duration: gap,
        contextBefore: before.slice(-100),
        contextAfter: after.slice(0, 100),
      });
    }
  }
  return gaps;
}

/**
 * Build a summary of the transcript around significant gaps
 * for the LLM to analyze.
 */
function buildLlmContext(
  gaps: Gap[],
  talks: Talk[],
  streamName: string,
  durationSec: number
): string {
  let ctx = `# Full-Day Stream: ${streamName}\n`;
  ctx += `Duration: ${fmt(durationSec)} (${(durationSec / 3600).toFixed(1)} hours)\n\n`;

  ctx += `## Scheduled Talks (times are approximate UTC schedule, not stream offsets)\n`;
  for (const t of talks) {
    const start = t.starts_at.slice(11, 16);
    const end = t.ends_at.slice(11, 16);
    ctx += `- ${start}-${end}: "${t.title}" (${t.speaker_names || "unknown speaker"})\n`;
  }

  ctx += `\n## Significant Gaps (silence > 8 seconds)\n`;
  ctx += `These gaps likely correspond to transitions between talks.\n\n`;
  for (const g of gaps) {
    ctx += `### Gap at ${fmt(g.timestamp)} (${g.duration.toFixed(0)}s silence)\n`;
    ctx += `Before: "...${g.contextBefore}"\n`;
    ctx += `After: "${g.contextAfter}..."\n\n`;
  }

  return ctx;
}

async function detectBoundariesWithLlm(
  gaps: Gap[],
  talks: Talk[],
  streamName: string,
  durationSec: number
): Promise<Array<{ rkey: string; title: string; startTimestamp: number; endTimestamp: number }>> {
  const context = buildLlmContext(gaps, talks, streamName, durationSec);

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are analyzing a conference live stream transcript to find where each talk actually starts and ends.

You will be given:
1. A list of scheduled talks with their rkeys and approximate UTC times
2. Significant silence gaps in the transcript with surrounding context

The gaps have timestamps in seconds from the START of the stream (not UTC). Each gap shows the text before and after the silence.

Your job: for each scheduled talk, find the gap that corresponds to it starting. Use ONLY the gap timestamps provided — do not invent timestamps.

How to identify talk starts:
- "Thank you" + long gap = end of previous talk, start of transition
- The "after" text of a gap often has the MC introducing the next speaker
- Speaker names, talk title keywords in the "after" context confirm the match
- Some gaps are just audio glitches — ignore those (usually short, no context change)
- Breaks/lunch show as very long gaps (>120s)

Output a JSON array where each object has:
- "rkey": the exact rkey from the scheduled talks list
- "title": the talk title
- "startTimestamp": the gap timestamp (in seconds) where this talk begins
- "endTimestamp": the gap timestamp where the NEXT talk begins, or null for the last talk

Use ONLY gap timestamps from the list. Do not interpolate or guess.
Output ONLY the JSON array, no markdown fences or explanation.`,
      },
      {
        role: "user",
        content: context,
      },
    ],
    temperature: 0.1,
    max_tokens: 4000,
  });

  const content = response.choices[0]?.message?.content?.trim() || "[]";
  try {
    // Strip markdown fences if present
    const cleaned = content.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("Failed to parse LLM response:", content.slice(0, 200));
    return [];
  }
}

async function main() {
  const transcriptPath = process.argv[2];
  if (!transcriptPath) {
    console.error("Usage: npx tsx src/detect-boundaries.ts <transcript.json>");
    process.exit(1);
  }

  const transcript: FullDayTranscript = JSON.parse(
    readFileSync(transcriptPath, "utf-8")
  );

  console.log(`Stream: ${transcript.stream}`);
  console.log(`Room: ${transcript.room}, Day: ${transcript.day}`);
  console.log(`Duration: ${fmt(transcript.durationSeconds)}`);
  console.log(`Words: ${transcript.words.length}`);

  // Get scheduled talks for this room from the DB
  const db = openDb();
  const roomPatterns = [transcript.room];
  // Add room name variations
  if (transcript.room === "ATScience") {
    roomPatterns.push("Performance Theatre", "Bukhman Lounge");
  }

  const placeholders = roomPatterns.map(() => "?").join(",");
  const talks = db
    .prepare(
      `SELECT t.rkey, t.title, t.room, t.starts_at, t.ends_at,
              GROUP_CONCAT(s.name) as speaker_names
       FROM talks t
       LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
       LEFT JOIN speakers s ON ts.speaker_uri = s.uri
       WHERE t.room IN (${placeholders})
       GROUP BY t.uri
       ORDER BY t.starts_at ASC`
    )
    .all(...roomPatterns) as Talk[];

  console.log(`\nScheduled talks in ${transcript.room}: ${talks.length}`);

  // Find gaps
  const gaps = findGaps(transcript.words, 8);
  console.log(`Significant gaps (>8s): ${gaps.length}`);

  // Filter to major gaps (>20s) for LLM analysis to keep context manageable
  const majorGaps = gaps.filter((g) => g.duration >= 20);
  console.log(`Major gaps (>20s): ${majorGaps.length}`);

  // Use LLM to match gaps to talks
  console.log("\nAsking LLM to match gaps to talks...");
  const boundaries = await detectBoundariesWithLlm(
    majorGaps,
    talks,
    transcript.stream,
    transcript.durationSeconds
  );

  console.log(`\nDetected ${boundaries.length} talk boundaries:\n`);
  for (const b of boundaries) {
    const end = b.endTimestamp ? fmt(b.endTimestamp) : "???";
    console.log(`  ${fmt(b.startTimestamp)} - ${end}  ${b.title} (${b.rkey})`);
  }

  // Save results
  const outputPath = transcriptPath.replace(".json", "-boundaries.json");
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        stream: transcript.stream,
        room: transcript.room,
        day: transcript.day,
        uri: transcript.uri,
        durationSeconds: transcript.durationSeconds,
        boundaries,
        gaps: majorGaps.map((g) => ({
          timestamp: g.timestamp,
          duration: g.duration,
        })),
      },
      null,
      2
    )
  );
  console.log(`\nSaved to ${outputPath}`);

  db.close();
}

main().catch(console.error);
