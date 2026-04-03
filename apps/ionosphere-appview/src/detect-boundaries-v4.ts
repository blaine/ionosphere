/**
 * Anchored boundary detection — work forward from the start and
 * backward from the end, using expected talk durations to search
 * for transitions near predicted timestamps.
 *
 * Usage: npx tsx src/detect-boundaries-v4.ts <transcript.json>
 */
import "./env.js";
import { readFileSync, writeFileSync } from "node:fs";
import OpenAI from "openai";
import { openDb } from "./db.js";

const client = new OpenAI();

interface Word { word: string; start: number; end: number; }
interface Talk { rkey: string; title: string; starts_at: string; ends_at: string; speaker_names: string; scheduledDuration: number; }

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
    if (w.start - lastMarker >= 15) {
      result += `\n[${fmt(w.start)} = ${Math.round(w.start)}s] `;
      lastMarker = w.start;
    }
    result += w.word + " ";
  }
  return result.trim();
}

/**
 * Find the silence gaps in a window of the transcript.
 */
function findGapsInWindow(words: Word[], startSec: number, endSec: number, minGap: number = 5): Array<{ timestamp: number; duration: number }> {
  const gaps: Array<{ timestamp: number; duration: number }> = [];
  for (let i = 1; i < words.length; i++) {
    if (words[i].start < startSec || words[i - 1].end > endSec) continue;
    const gap = words[i].start - words[i - 1].end;
    if (gap >= minGap) {
      gaps.push({ timestamp: words[i].start, duration: gap });
    }
  }
  return gaps;
}

/**
 * Ask LLM to find the talk transition nearest to the expected time.
 * Gives it a narrow window of transcript + the gaps in that window.
 */
async function findTransitionNear(
  words: Word[],
  expectedTimestamp: number,
  previousTalkTitle: string,
  nextTalkTitle: string,
  nextSpeaker: string,
  searchRadius: number = 300, // ±5 minutes
): Promise<{ timestamp: number; confidence: string } | null> {
  const windowStart = Math.max(0, expectedTimestamp - searchRadius);
  const windowEnd = expectedTimestamp + searchRadius;

  const segmentText = extractSegment(words, windowStart, windowEnd);
  if (!segmentText.trim()) return null;

  const gaps = findGapsInWindow(words, windowStart, windowEnd, 5);
  const gapList = gaps.map((g) => `  ${fmt(g.timestamp)} = ${Math.round(g.timestamp)}s (${g.duration.toFixed(0)}s silence)`).join("\n");

  const response = await client.chat.completions.create({
    model: "gpt-5.4-mini",
    messages: [
      {
        role: "system",
        content: `You are finding the exact transition point between two conference talks in a live stream transcript.

The previous talk was: "${previousTalkTitle}"
The next talk is: "${nextTalkTitle}" by ${nextSpeaker}

I expect the transition near ${fmt(expectedTimestamp)} (= ${Math.round(expectedTimestamp)} seconds from stream start).

Here are the silence gaps in the search window:
${gapList}

Look at the transcript and identify which gap corresponds to the transition between these two talks. The transition is where the previous speaker finishes and the next speaker (or MC introducing them) begins.

IMPORTANT: Return the timestamp as SECONDS from stream start (the number after "=" in the time markers). Do NOT return minutes or H:MM:SS format.

Return a JSON object: {"timestamp": <seconds from stream start>, "confidence": "high"|"medium"|"low"}
- "high" = clear transition (thank you + new speaker introduction)
- "medium" = likely transition (topic shift, gap near expected time)
- "low" = best guess (no clear signal, picking closest gap)

If there is truly no transition in this window, return {"timestamp": null, "confidence": "none"}.
Output ONLY the JSON object.`,
      },
      {
        role: "user",
        content: `Transcript (${fmt(windowStart)} - ${fmt(windowEnd)}):\n${segmentText}`,
      },
    ],
    max_completion_tokens: 200,
  });

  const content = response.choices[0]?.message?.content?.trim() || "{}";
  try {
    const cleaned = content.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(cleaned);
    if (parsed.timestamp === null) return null;
    return { timestamp: parsed.timestamp, confidence: parsed.confidence || "unknown" };
  } catch {
    return null;
  }
}

async function main() {
  const transcriptPath = process.argv[2];
  if (!transcriptPath) {
    console.error("Usage: npx tsx src/detect-boundaries-v4.ts <transcript.json>");
    process.exit(1);
  }

  const transcript = JSON.parse(readFileSync(transcriptPath, "utf-8"));
  const words: Word[] = transcript.words;
  const duration = transcript.durationSeconds;

  console.log(`Stream: ${transcript.stream}`);
  console.log(`Duration: ${fmt(duration)} (${(duration / 3600).toFixed(1)}h)`);
  console.log(`Words: ${words.length}\n`);

  // Get talks
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
  // Use PDT (UTC-7) dates for filtering — the conference was in Pacific Time
  const dateFilter = config.dates.length > 0 ? `AND substr(datetime(t.starts_at, '-7 hours'), 1, 10) IN (${dp})` : "";

  const talks = db.prepare(
    `SELECT t.rkey, t.title, t.starts_at, t.ends_at,
            GROUP_CONCAT(s.name) as speaker_names
     FROM talks t
     LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
     LEFT JOIN speakers s ON ts.speaker_uri = s.uri
     WHERE t.room IN (${rp}) ${dateFilter}
     GROUP BY t.uri
     ORDER BY t.starts_at ASC`
  ).all(...config.rooms, ...config.dates).map((t: any) => {
    const startMs = new Date(t.starts_at).getTime();
    const endMs = new Date(t.ends_at).getTime();
    return { ...t, scheduledDuration: Math.max(300, (endMs - startMs) / 1000) }; // min 5 min
  }) as Talk[];

  console.log(`Talks (${talks.length}):`);
  for (const t of talks) {
    console.log(`  ${t.starts_at?.slice(11, 16)} (${(t.scheduledDuration / 60).toFixed(0)}min) ${t.title}`);
  }

  // First, find the very first transition — where does the stream actually start?
  // Search the first 45 minutes for the first talk beginning
  console.log(`\n=== Finding stream start ===\n`);

  const firstGaps = findGapsInWindow(words, 0, 2700, 8); // first 45 min
  console.log(`  Gaps in first 45min: ${firstGaps.length}`);

  const firstTransition = await findTransitionNear(
    words,
    300, // expect first talk ~5 min in
    "(stream setup / dead air)",
    talks[0].title,
    talks[0].speaker_names || "unknown",
    1500, // wide search: first 25 min
  );

  const firstTalkStart = firstTransition?.timestamp ?? 0;
  console.log(`  First talk starts at: ${fmt(firstTalkStart)} (${firstTransition?.confidence || "guess"})`);

  // Forward pass: from the first talk, predict each transition
  console.log(`\n=== Forward pass ===\n`);

  const boundaries = new Map<string, { timestamp: number; confidence: string }>();
  boundaries.set(talks[0].rkey, { timestamp: firstTalkStart, confidence: firstTransition?.confidence || "low" });

  let cursor = firstTalkStart;
  for (let i = 0; i < talks.length - 1; i++) {
    const currentTalk = talks[i];
    const nextTalk = talks[i + 1];

    // Expected end of current talk = cursor + scheduled duration
    const expectedTransition = cursor + currentTalk.scheduledDuration;

    process.stdout.write(`  ${currentTalk.title.slice(0, 40).padEnd(42)} → `);

    const result = await findTransitionNear(
      words,
      expectedTransition,
      currentTalk.title,
      nextTalk.title,
      nextTalk.speaker_names || "unknown",
      420, // ±7 minutes — talks often run over
    );

    if (result) {
      boundaries.set(nextTalk.rkey, result);
      cursor = result.timestamp;
      console.log(`${fmt(result.timestamp)} (${result.confidence})`);
    } else {
      // No transition found — use expected time and continue
      cursor = expectedTransition;
      boundaries.set(nextTalk.rkey, { timestamp: expectedTransition, confidence: "extrapolated" });
      console.log(`${fmt(expectedTransition)} (extrapolated)`);
    }
  }

  // Build results
  const results = talks.map((talk, i) => {
    const boundary = boundaries.get(talk.rkey);
    const nextBoundary = i + 1 < talks.length ? boundaries.get(talks[i + 1].rkey) : null;
    return {
      rkey: talk.rkey,
      title: talk.title,
      startTimestamp: boundary?.timestamp ?? -1,
      endTimestamp: nextBoundary?.timestamp ?? null,
      confidence: boundary?.confidence ?? "not_found",
      duration: nextBoundary ? ((nextBoundary.timestamp - (boundary?.timestamp ?? 0)) / 60).toFixed(1) + "min" : "→ end",
    };
  });

  console.log(`\n=== Results ===\n`);
  console.log(`${"Start".padEnd(10)} ${"End".padEnd(10)} ${"Dur".padEnd(10)} ${"Conf".padEnd(13)} Talk`);
  console.log("-".repeat(100));
  for (const r of results) {
    const start = r.startTimestamp >= 0 ? fmt(r.startTimestamp) : "???";
    const end = r.endTimestamp ? fmt(r.endTimestamp) : "→ end";
    console.log(`${start.padEnd(10)} ${end.padEnd(10)} ${r.duration.padEnd(10)} ${r.confidence.padEnd(13)} ${r.title} (${r.rkey})`);
  }

  // Save
  const outputPath = transcriptPath.replace(".json", "-boundaries-v4.json");
  writeFileSync(outputPath, JSON.stringify({ stream: transcript.stream, results }, null, 2));
  console.log(`\nSaved to ${outputPath}`);

  db.close();
}

main().catch(console.error);
