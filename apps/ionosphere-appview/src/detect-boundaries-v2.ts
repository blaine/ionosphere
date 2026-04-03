/**
 * Binary-search talk boundary detection.
 *
 * Splits the transcript into segments, asks the LLM which talks
 * are in each segment, and recurses until boundaries are narrowed
 * to ~2 minute windows. Then does a final precision pass.
 *
 * Usage: npx tsx src/detect-boundaries-v2.ts <transcript.json>
 */
import "./env.js";
import { readFileSync, writeFileSync } from "node:fs";
import OpenAI from "openai";
import { openDb } from "./db.js";

const client = new OpenAI();

interface Word {
  word: string;
  start: number;
  end: number;
}

interface Talk {
  rkey: string;
  title: string;
  starts_at: string;
  speaker_names: string;
}

interface BoundaryResult {
  rkey: string;
  title: string;
  startTimestamp: number;
  endTimestamp: number | null;
  confidence: string;
}

function fmt(ts: number): string {
  const h = Math.floor(ts / 3600);
  const m = Math.floor((ts % 3600) / 60);
  const s = Math.floor(ts % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Extract a segment of text from words between startSec and endSec.
 * Returns condensed text with timestamps every ~60 seconds.
 */
function extractSegment(words: Word[], startSec: number, endSec: number): string {
  let result = "";
  let lastMarker = -999;
  for (const w of words) {
    if (w.start < startSec || w.start > endSec) continue;
    // Insert a time marker every 60 seconds
    if (w.start - lastMarker >= 60) {
      result += `\n[${fmt(w.start)}] `;
      lastMarker = w.start;
    }
    result += w.word + " ";
  }
  return result.trim();
}

/**
 * Ask LLM which talks from a candidate list appear in a transcript segment.
 */
async function findTalksInSegment(
  segmentText: string,
  candidateTalks: Talk[],
  startSec: number,
  endSec: number
): Promise<string[]> {
  const talkList = candidateTalks
    .map((t) => `- ${t.rkey}: "${t.title}" (${t.speaker_names || "unknown"})`)
    .join("\n");

  const response = await client.chat.completions.create({
    model: "gpt-5.4-mini",
    messages: [
      {
        role: "system",
        content: `You are identifying which conference talks appear in a transcript segment.

You'll receive a transcript excerpt from a live stream (${fmt(startSec)} to ${fmt(endSec)}) with time markers, and a list of candidate talks.

For each talk that STARTS in this segment, return its rkey. A talk "starts" when the speaker begins their presentation (not when the MC mentions it coming up later).

Look for:
- Speaker introductions ("please welcome", "our next speaker")
- Talk title mentions
- Self-introductions ("Hi I'm X and I'll be talking about Y")
- Topic shifts that match a talk's subject

Return a JSON array of rkeys. If no talks start in this segment, return [].
Output ONLY the JSON array.`,
      },
      {
        role: "user",
        content: `## Candidate talks:\n${talkList}\n\n## Transcript (${fmt(startSec)} - ${fmt(endSec)}):\n${segmentText}`,
      },
    ],
    max_completion_tokens: 1000,
  });

  const content = response.choices[0]?.message?.content?.trim() || "[]";
  try {
    const cleaned = content.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    return JSON.parse(cleaned);
  } catch {
    return [];
  }
}

/**
 * Ask LLM to find the precise start timestamp of a talk within a narrow window.
 */
async function findPreciseStart(
  segmentText: string,
  talk: Talk,
  startSec: number,
  endSec: number
): Promise<number | null> {
  const response = await client.chat.completions.create({
    model: "gpt-5.4-mini",
    messages: [
      {
        role: "system",
        content: `You are finding the exact moment a conference talk begins in a transcript.

The talk is: "${talk.title}" by ${talk.speaker_names || "unknown speaker"} (rkey: ${talk.rkey})

Look at the transcript with time markers and find where this talk actually starts. The start is when the speaker begins their talk (their first substantive words), NOT when the MC introduces them.

Return ONLY a JSON object: {"timestamp": <seconds from stream start>}
Use the [H:MM:SS] time markers to determine the seconds value.`,
      },
      {
        role: "user",
        content: `## Transcript (${fmt(startSec)} - ${fmt(endSec)}):\n${segmentText}`,
      },
    ],
    max_completion_tokens: 200,
  });

  const content = response.choices[0]?.message?.content?.trim() || "{}";
  try {
    const cleaned = content.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(cleaned);
    return parsed.timestamp ?? null;
  } catch {
    return null;
  }
}

/**
 * Binary search: recursively narrow down where each talk starts.
 */
async function binarySearch(
  words: Word[],
  candidateTalks: Talk[],
  startSec: number,
  endSec: number,
  depth: number,
  results: Map<string, { narrowStart: number; narrowEnd: number }>
): Promise<void> {
  if (candidateTalks.length === 0) return;

  const duration = endSec - startSec;
  const indent = "  ".repeat(depth);

  // Base case: narrow enough for precision pass (~3 minutes)
  if (duration <= 180) {
    for (const talk of candidateTalks) {
      results.set(talk.rkey, { narrowStart: startSec, narrowEnd: endSec });
    }
    return;
  }

  const midSec = startSec + duration / 2;

  // Extract text for each half
  const leftText = extractSegment(words, startSec, midSec);
  const rightText = extractSegment(words, midSec, endSec);

  console.log(`${indent}Searching ${fmt(startSec)}-${fmt(endSec)} (${candidateTalks.length} talks, depth ${depth})`);

  // Ask which talks are in the left half
  const leftRkeys = await findTalksInSegment(leftText, candidateTalks, startSec, midSec);
  const leftTalks = candidateTalks.filter((t) => leftRkeys.includes(t.rkey));
  const rightTalks = candidateTalks.filter((t) => !leftRkeys.includes(t.rkey));

  console.log(`${indent}  Left (${fmt(startSec)}-${fmt(midSec)}): ${leftTalks.length} talks [${leftTalks.map(t => t.rkey).join(", ")}]`);
  console.log(`${indent}  Right (${fmt(midSec)}-${fmt(endSec)}): ${rightTalks.length} talks [${rightTalks.map(t => t.rkey).join(", ")}]`);

  // Recurse on both halves
  await binarySearch(words, leftTalks, startSec, midSec, depth + 1, results);
  await binarySearch(words, rightTalks, midSec, endSec, depth + 1, results);
}

async function main() {
  const transcriptPath = process.argv[2];
  if (!transcriptPath) {
    console.error("Usage: npx tsx src/detect-boundaries-v2.ts <transcript.json>");
    process.exit(1);
  }

  const transcript = JSON.parse(readFileSync(transcriptPath, "utf-8"));
  const words: Word[] = transcript.words;

  console.log(`Stream: ${transcript.stream}`);
  console.log(`Duration: ${fmt(transcript.durationSeconds)} (${(transcript.durationSeconds / 3600).toFixed(1)}h)`);
  console.log(`Words: ${words.length}\n`);

  // Get scheduled talks — filter by room AND day
  const db = openDb();
  const roomPatterns = [transcript.room];
  if (transcript.room === "ATScience") {
    roomPatterns.push("Performance Theatre", "Bukhman Lounge");
  }
  // Map day number to conference date (PDT)
  const dayDates: Record<number, string[]> = {
    1: ["2026-03-27", "2026-03-28"], // ATScience is March 27, Day 1 for main conf is March 28
    2: ["2026-03-29", "2026-03-30"],
  };
  const dates = dayDates[transcript.day] || [];

  const placeholders = roomPatterns.map(() => "?").join(",");
  const datePlaceholders = dates.map(() => "?").join(",");
  const talks = db
    .prepare(
      `SELECT t.rkey, t.title, t.starts_at,
              GROUP_CONCAT(s.name) as speaker_names
       FROM talks t
       LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
       LEFT JOIN speakers s ON ts.speaker_uri = s.uri
       WHERE t.room IN (${placeholders})
       ${dates.length > 0 ? `AND substr(t.starts_at, 1, 10) IN (${datePlaceholders})` : ""}
       GROUP BY t.uri
       ORDER BY t.starts_at ASC`
    )
    .all(...roomPatterns, ...dates) as Talk[];

  console.log(`Scheduled talks: ${talks.length}\n`);
  console.log("=== Phase 1: Binary search ===\n");

  // Phase 1: Binary search to narrow each talk to a ~3 min window
  const narrowResults = new Map<string, { narrowStart: number; narrowEnd: number }>();
  await binarySearch(words, talks, 0, transcript.durationSeconds, 0, narrowResults);

  console.log(`\n=== Phase 2: Precision pass ===\n`);

  // Phase 2: For each narrowed window, find the precise start
  const boundaries: BoundaryResult[] = [];
  for (const talk of talks) {
    const narrow = narrowResults.get(talk.rkey);
    if (!narrow) {
      console.log(`  ${talk.rkey}: not found in transcript`);
      boundaries.push({ rkey: talk.rkey, title: talk.title, startTimestamp: -1, endTimestamp: null, confidence: "not_found" });
      continue;
    }

    console.log(`  ${talk.rkey}: searching ${fmt(narrow.narrowStart)}-${fmt(narrow.narrowEnd)}...`);
    const segmentText = extractSegment(words, narrow.narrowStart, narrow.narrowEnd);
    const precise = await findPreciseStart(segmentText, talk, narrow.narrowStart, narrow.narrowEnd);

    if (precise !== null) {
      console.log(`    → ${fmt(precise)}`);
      boundaries.push({ rkey: talk.rkey, title: talk.title, startTimestamp: precise, endTimestamp: null, confidence: "high" });
    } else {
      // Fall back to the start of the narrow window
      console.log(`    → ${fmt(narrow.narrowStart)} (fallback)`);
      boundaries.push({ rkey: talk.rkey, title: talk.title, startTimestamp: narrow.narrowStart, endTimestamp: null, confidence: "low" });
    }
  }

  // Sort by start time and fill in end timestamps
  boundaries.sort((a, b) => a.startTimestamp - b.startTimestamp);
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (boundaries[i].startTimestamp >= 0) {
      boundaries[i].endTimestamp = boundaries[i + 1].startTimestamp;
    }
  }

  console.log(`\n=== Results ===\n`);
  for (const b of boundaries) {
    if (b.startTimestamp < 0) {
      console.log(`  NOT FOUND  ${b.title} (${b.rkey})`);
      continue;
    }
    const end = b.endTimestamp ? fmt(b.endTimestamp) : "???";
    console.log(`  ${fmt(b.startTimestamp)} - ${end}  ${b.title} (${b.rkey})`);
  }

  // Save
  const outputPath = transcriptPath.replace(".json", "-boundaries-v2.json");
  writeFileSync(outputPath, JSON.stringify({ stream: transcript.stream, boundaries }, null, 2));
  console.log(`\nSaved to ${outputPath}`);

  db.close();
}

main().catch(console.error);
