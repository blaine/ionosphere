/**
 * Diagnose alignment issues between VODs, schedule, and transcripts.
 */
import { openDb } from "./db.js";

const db = openDb();

interface TalkRow {
  rkey: string;
  title: string;
  duration: number;
  starts_at: string;
  ends_at: string;
  room: string;
  has_transcript: number;
  start_ms: number | null;
  transcript_words: number | null;
}

const talks = db
  .prepare(
    `SELECT
      t.rkey, t.title, t.duration, t.starts_at, t.ends_at, t.room,
      CASE WHEN tr.talk_uri IS NOT NULL THEN 1 ELSE 0 END as has_transcript,
      tr.start_ms,
      (length(tr.timings) - length(replace(tr.timings, ',', ''))) as transcript_words
    FROM talks t
    LEFT JOIN transcripts tr ON tr.talk_uri = t.uri
    ORDER BY t.starts_at`
  )
  .all() as TalkRow[];

console.log("=== ALIGNMENT DIAGNOSTIC ===\n");

const problems: Array<{
  rkey: string;
  title: string;
  vidMin: number;
  schedMin: number;
  ratio: number;
  offsetS: number;
  flags: string[];
}> = [];

for (const t of talks) {
  const vidMin = t.duration / 1e9 / 60;
  const schedStart = new Date(t.starts_at).getTime();
  const schedEnd = new Date(t.ends_at).getTime();
  const schedMin = (schedEnd - schedStart) / 1000 / 60;
  const ratio = schedMin > 0 ? vidMin / schedMin : 0;
  const offsetS = t.start_ms ? t.start_ms / 1000 : 0;

  const flags: string[] = [];
  if (ratio < 0.3) flags.push("WRONG_VOD");
  else if (ratio < 0.7) flags.push("SHORT");
  else if (ratio > 2.0) flags.push("MULTI_TALK");
  if (offsetS > 120) flags.push("BIG_OFFSET");

  if (flags.length > 0) {
    problems.push({
      rkey: t.rkey,
      title: t.title,
      vidMin,
      schedMin,
      ratio,
      offsetS,
      flags,
    });
  }
}

// Print problems
const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
console.log(
  `${pad("rkey", 25)} ${pad("title", 50)} ${"vid".padStart(6)} ${"sch".padStart(6)} ${"ratio".padStart(6)} ${"off".padStart(6)} flags`
);
console.log("-".repeat(110));

for (const p of problems) {
  console.log(
    `${pad(p.rkey, 25)} ${pad(p.title, 50)} ${p.vidMin.toFixed(1).padStart(6)} ${p.schedMin.toFixed(1).padStart(6)} ${p.ratio.toFixed(2).padStart(6)} ${p.offsetS.toFixed(0).padStart(6)} ${p.flags.join(",")}`
  );
}

// Summary
console.log();
const flagCounts: Record<string, number> = {};
for (const p of problems) {
  for (const f of p.flags) {
    flagCounts[f] = (flagCounts[f] || 0) + 1;
  }
}
for (const [flag, count] of Object.entries(flagCounts)) {
  console.log(`  ${flag}: ${count} talks`);
}
console.log(`\n  ${problems.length} flagged / ${talks.length} total`);
console.log(`  ${talks.filter((t) => t.has_transcript).length} with transcripts`);

// Also show talks that might be room-length recordings containing other talks
console.log("\n=== POSSIBLE ROOM-LENGTH VODS ===\n");
for (const t of talks) {
  const vidMin = t.duration / 1e9 / 60;
  if (vidMin > 60) {
    console.log(`  ${t.rkey}: ${t.title} (${vidMin.toFixed(0)} min) — ${t.room}`);
  }
}

db.close();
