/**
 * Gap-finding talk boundary detection.
 *
 * Scans the transcript in overlapping windows, asking the LLM to
 * identify talk transitions (not specific talks). Transitions are
 * then mapped to the schedule in order.
 *
 * Usage: npx tsx src/detect-boundaries-v3.ts <transcript.json>
 */
import "./env.js";
import { readFileSync, writeFileSync } from "node:fs";
import OpenAI from "openai";
import { openDb } from "./db.js";

const client = new OpenAI();

interface Word { word: string; start: number; end: number; }
interface Talk { rkey: string; title: string; starts_at: string; speaker_names: string; }

function fmt(ts: number): string {
  const h = Math.floor(ts / 3600);
  const m = Math.floor((ts % 3600) / 60);
  const s = Math.floor(ts % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function extractSegment(words: Word[], startSec: number, endSec: number): string {
  let result = "";
  let lastMarker = -999;
  for (const w of words) {
    if (w.start < startSec || w.start > endSec) continue;
    if (w.start - lastMarker >= 20) {
      result += `\n[${fmt(w.start)}] `;
      lastMarker = w.start;
    }
    result += w.word + " ";
  }
  return result.trim();
}

/**
 * Ask the LLM if there's a talk transition in this segment.
 * Returns timestamps of detected transitions.
 */
async function findTransitions(
  segmentText: string,
  windowStart: number,
  windowEnd: number,
): Promise<Array<{ timestamp: number; description: string }>> {
  if (!segmentText.trim()) return [];

  const response = await client.chat.completions.create({
    model: "gpt-5.4-mini",
    messages: [
      {
        role: "system",
        content: `You identify talk transitions in a conference live stream transcript.

A "talk transition" is when one presentation ends and another begins. Signs:
- Speaker says "thank you" and there's applause or a pause
- MC/host introduces the next speaker or talk
- A new speaker starts with a self-introduction
- Clear topic shift with a gap in speech

You are NOT looking for:
- Q&A within a talk
- Brief pauses or audio glitches
- Topic changes within the same presentation
- Panel discussions switching speakers

For each transition you find, return the timestamp where the NEW talk begins (the first words of the new speaker/introduction, not the "thank you" of the previous speaker).

Use the [H:MM:SS] markers to determine timestamps. Convert to seconds: H*3600 + M*60 + S.

Return a JSON array: [{"timestamp": <seconds>, "description": "<brief description of what happens>"}]
If no transitions, return [].
Output ONLY the JSON array.`,
      },
      {
        role: "user",
        content: `Transcript segment (${fmt(windowStart)} - ${fmt(windowEnd)}):\n\n${segmentText}`,
      },
    ],
    max_completion_tokens: 500,
  });

  const content = response.choices[0]?.message?.content?.trim() || "[]";
  try {
    const cleaned = content.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    return JSON.parse(cleaned);
  } catch {
    return [];
  }
}

async function main() {
  const transcriptPath = process.argv[2];
  if (!transcriptPath) {
    console.error("Usage: npx tsx src/detect-boundaries-v3.ts <transcript.json>");
    process.exit(1);
  }

  const transcript = JSON.parse(readFileSync(transcriptPath, "utf-8"));
  const words: Word[] = transcript.words;
  const duration = transcript.durationSeconds;

  console.log(`Stream: ${transcript.stream}`);
  console.log(`Duration: ${fmt(duration)} (${(duration / 3600).toFixed(1)}h)`);
  console.log(`Words: ${words.length}\n`);

  // Get talks for this stream
  const db = openDb();
  const roomMap: Record<string, { rooms: string[]; dates: string[] }> = {
    "ATScience": { rooms: ["Performance Theatre", "Bukhman Lounge"], dates: ["2026-03-27"] },
    "Great Hall South": { rooms: ["Great Hall South"], dates: [] },
    "Room 2301": { rooms: ["Room 2301", "2301 Classroom"], dates: [] },
    "Performance Theatre": { rooms: ["Performance Theatre"], dates: [] },
  };

  const config = roomMap[transcript.room] || { rooms: [transcript.room], dates: [] };
  if (config.dates.length === 0) {
    const dayMap: Record<number, string> = { 1: "2026-03-28", 2: "2026-03-29" };
    if (dayMap[transcript.day]) config.dates = [dayMap[transcript.day]];
  }

  const rp = config.rooms.map(() => "?").join(",");
  const dp = config.dates.map(() => "?").join(",");
  const dateFilter = config.dates.length > 0 ? `AND substr(t.starts_at, 1, 10) IN (${dp})` : "";

  const talks = db.prepare(
    `SELECT t.rkey, t.title, t.starts_at,
            GROUP_CONCAT(s.name) as speaker_names
     FROM talks t
     LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
     LEFT JOIN speakers s ON ts.speaker_uri = s.uri
     WHERE t.room IN (${rp}) ${dateFilter}
     GROUP BY t.uri
     ORDER BY t.starts_at ASC`
  ).all(...config.rooms, ...config.dates) as Talk[];

  console.log(`Talks in schedule order (${talks.length}):`);
  for (const t of talks) {
    console.log(`  ${t.starts_at?.slice(11, 16) || "??:??"} ${t.title}`);
  }

  // Phase 1: Find silence gaps in the transcript
  console.log(`\n=== Phase 1: Finding silence gaps ===\n`);

  const gaps: Array<{ timestamp: number; duration: number; contextBefore: string; contextAfter: string }> = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= 8) {
      const before = words.slice(Math.max(0, i - 12), i).map((w) => w.word).join(" ");
      const after = words.slice(i, Math.min(words.length, i + 12)).map((w) => w.word).join(" ");
      gaps.push({ timestamp: words[i].start, duration: gap, contextBefore: before.slice(-80), contextAfter: after.slice(0, 80) });
    }
  }
  console.log(`  Found ${gaps.length} silence gaps (>8s)`);

  // Phase 2: Classify gaps in batches — ask LLM which are talk transitions
  console.log(`\n=== Phase 2: Classifying gaps ===\n`);

  const BATCH_SIZE = 20;
  const allTransitions: Array<{ timestamp: number; description: string }> = [];

  for (let batchStart = 0; batchStart < gaps.length; batchStart += BATCH_SIZE) {
    const batch = gaps.slice(batchStart, batchStart + BATCH_SIZE);
    const batchDesc = batch.map((g, i) =>
      `Gap ${batchStart + i + 1} at ${fmt(g.timestamp)} (${g.duration.toFixed(0)}s silence)\n  Before: "...${g.contextBefore}"\n  After: "${g.contextAfter}..."`
    ).join("\n\n");

    process.stdout.write(`  Batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(gaps.length / BATCH_SIZE)} (gaps ${batchStart + 1}-${batchStart + batch.length})...`);

    const response = await client.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "system",
          content: `You classify silence gaps in a conference live stream transcript.

For each gap, determine if it's a TALK TRANSITION (one presentation ending and another beginning) or something else (Q&A pause, audio glitch, break, applause within a talk, etc).

Signs of a talk transition:
- "Thank you" or applause followed by a new speaker introduction
- MC introducing next speaker/talk
- Long gap (>20s) between different topics
- Self-introduction by new speaker after a gap

Signs it's NOT a transition:
- Question from audience followed by same speaker answering
- Brief pause within ongoing discussion
- Same speaker continuing after applause
- Panel discussion switching between panelists

Return a JSON array of gap numbers (1-indexed) that ARE talk transitions.
Example: [3, 7, 15]
If none are transitions, return [].
Output ONLY the JSON array.`,
        },
        { role: "user", content: batchDesc },
      ],
      max_completion_tokens: 200,
    });

    const content = response.choices[0]?.message?.content?.trim() || "[]";
    let transitionIndices: number[] = [];
    try {
      const cleaned = content.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
      transitionIndices = JSON.parse(cleaned);
    } catch {}

    const hits = transitionIndices
      .map((idx) => batch[idx - batchStart - 1])
      .filter(Boolean);

    if (hits.length > 0) {
      for (const g of hits) {
        allTransitions.push({ timestamp: g.timestamp, description: `${g.duration.toFixed(0)}s gap — "${g.contextAfter.slice(0, 50)}..."` });
        process.stdout.write(` ✓ ${fmt(g.timestamp)}`);
      }
      console.log();
    } else {
      console.log(" (none)");
    }
  }

  allTransitions.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`\n=== Phase 2: Mapping ${allTransitions.length} transitions to ${talks.length} talks ===\n`);

  console.log("Detected transitions:");
  for (let i = 0; i < allTransitions.length; i++) {
    const t = allTransitions[i];
    const talkLabel = i < talks.length ? `→ ${talks[i].title}` : "(extra)";
    console.log(`  ${i + 1}. ${fmt(t.timestamp)} — ${t.description} ${talkLabel}`);
  }

  // Map: transition i = start of talk i (in schedule order)
  const results = talks.map((talk, i) => ({
    rkey: talk.rkey,
    title: talk.title,
    startTimestamp: i < allTransitions.length ? allTransitions[i].timestamp : -1,
    endTimestamp: i + 1 < allTransitions.length ? allTransitions[i + 1].timestamp : null,
    transitionDescription: i < allTransitions.length ? allTransitions[i].description : null,
    confidence: i < allTransitions.length ? "detected" : "not_found",
  }));

  console.log(`\n=== Final Results ===\n`);
  for (const r of results) {
    if (r.startTimestamp < 0) {
      console.log(`  NOT FOUND  ${r.title} (${r.rkey})`);
      continue;
    }
    const end = r.endTimestamp ? fmt(r.endTimestamp) : "→ end";
    console.log(`  ${fmt(r.startTimestamp)} - ${end}  ${r.title} (${r.rkey})`);
  }

  // Save
  const outputPath = transcriptPath.replace(".json", "-boundaries-v3.json");
  writeFileSync(outputPath, JSON.stringify({
    stream: transcript.stream,
    transitions: allTransitions,
    results,
  }, null, 2));
  console.log(`\nSaved to ${outputPath}`);

  db.close();
}

main().catch(console.error);
