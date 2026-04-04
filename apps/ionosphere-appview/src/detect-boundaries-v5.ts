/**
 * Hybrid boundary detection — heuristic scoring + dynamic programming.
 *
 * No LLM calls. Uses silence gaps, speaker names, talk titles, and
 * transition phrases to score candidate boundaries, then uses DP to
 * find the optimal assignment of N-1 transitions to N talks.
 *
 * Usage: npx tsx src/detect-boundaries-v5.ts <transcript.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { openDb } from "./db.js";

interface Word { word: string; start: number; end: number; }
interface Talk {
  rkey: string;
  title: string;
  starts_at: string;
  ends_at: string;
  speaker_names: string;
  scheduledDuration: number;
}

function fmt(ts: number): string {
  const h = Math.floor(ts / 3600);
  const m = Math.floor((ts % 3600) / 60);
  const s = Math.floor(ts % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// --- Pass 1: Find all candidate gaps ---

interface CandidateGap {
  timestamp: number;       // start of the gap (end of silence)
  gapDuration: number;     // seconds of silence
  wordsBefore: string[];   // 20 words before
  wordsAfter: string[];    // 30 words after
  score: number;           // composite score (filled in pass 2)
  signals: string[];       // what scored (for debugging)
}

function findCandidateGaps(words: Word[], minGap: number = 3): CandidateGap[] {
  const gaps: CandidateGap[] = [];
  for (let i = 1; i < words.length; i++) {
    const gapDuration = words[i].start - words[i - 1].end;
    if (gapDuration < minGap) continue;

    const before = words.slice(Math.max(0, i - 20), i).map((w) => w.word);
    const after = words.slice(i, Math.min(words.length, i + 30)).map((w) => w.word);

    gaps.push({
      timestamp: words[i].start,
      gapDuration,
      wordsBefore: before,
      wordsAfter: after,
      score: 0,
      signals: [],
    });
  }
  return gaps;
}

// --- Pass 2: Score gaps with text signals ---

const TRANSITION_BEFORE = [
  { pattern: /thank\s*you/i, weight: 3, label: "thank-you" },
  { pattern: /round\s*of\s*applause/i, weight: 4, label: "applause" },
  { pattern: /that'?s\s*(my|our)\s*time/i, weight: 4, label: "time-up" },
  { pattern: /any\s*questions/i, weight: 2, label: "q&a" },
];

const TRANSITION_AFTER = [
  { pattern: /hello|hi\s+everyone|hi\s+there|hey\s+everyone/i, weight: 4, label: "greeting" },
  { pattern: /my\s*name\s*is/i, weight: 5, label: "self-intro" },
  { pattern: /i'?m\s+going\s+to\s+(talk|present|show)/i, weight: 4, label: "talk-about" },
  { pattern: /please\s*welcome/i, weight: 5, label: "mc-welcome" },
  { pattern: /next\s*(up|speaker|talk|presentation)/i, weight: 4, label: "mc-next" },
  { pattern: /our\s*next/i, weight: 3, label: "mc-our-next" },
  { pattern: /come\s*on\s*(down|up)/i, weight: 4, label: "mc-come" },
];

/**
 * Score a gap generically (transition signals only, no speaker/title matching).
 * Speaker/title matching happens during DP when we know which talk comes next.
 */
function scoreGapGeneric(gap: CandidateGap): void {
  const beforeText = gap.wordsBefore.join(" ");
  const afterText = gap.wordsAfter.join(" ");

  gap.score = 0;
  gap.signals = [];

  // Gap duration score
  gap.score += Math.min(12, Math.log2(gap.gapDuration + 1) * 3);
  if (gap.gapDuration >= 8) gap.signals.push(`gap-${gap.gapDuration.toFixed(0)}s`);

  // Transition phrases before the gap
  for (const { pattern, weight, label } of TRANSITION_BEFORE) {
    if (pattern.test(beforeText)) {
      gap.score += weight;
      gap.signals.push(`before:${label}`);
    }
  }

  // Transition phrases after the gap
  for (const { pattern, weight, label } of TRANSITION_AFTER) {
    if (pattern.test(afterText)) {
      gap.score += weight;
      gap.signals.push(`after:${label}`);
    }
  }
}

/**
 * Score a gap specifically for a given talk (the talk that STARTS after this gap).
 * Checks for speaker name and title keywords in the surrounding text.
 */
function scoreGapForTalk(gap: CandidateGap, talk: Talk): number {
  const beforeText = gap.wordsBefore.join(" ").toLowerCase();
  const afterText = gap.wordsAfter.join(" ").toLowerCase();
  const surroundingText = beforeText + " " + afterText;
  let bonus = 0;
  const signals: string[] = [];

  // Speaker name in surrounding text (MC introduces before gap, speaker greets after)
  if (talk.speaker_names) {
    const names = talk.speaker_names.split(",").map((n) => n.trim().toLowerCase());
    for (const name of names) {
      const parts = name.split(" ");
      const lastName = parts[parts.length - 1];
      const firstName = parts[0];
      if (lastName.length >= 3 && surroundingText.includes(lastName)) {
        bonus += 10;
        signals.push(`speaker:${lastName}`);
        break;
      }
      if (firstName.length >= 4 && surroundingText.includes(firstName)) {
        bonus += 6;
        signals.push(`speaker:${firstName}`);
        break;
      }
    }
  }

  // Title keywords in surrounding text
  const titleWords = talk.title
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4 && !["about", "their", "these", "those", "where", "which", "would", "could", "should"].includes(w));
  let titleMatches = 0;
  for (const tw of titleWords) {
    if (surroundingText.includes(tw)) titleMatches++;
  }
  if (titleMatches >= 2) {
    bonus += titleMatches * 3;
    signals.push(`title-kw:${titleMatches}`);
  }

  return bonus;
}

// --- Pass 3: Dynamic programming to select optimal transitions ---

interface DPResult {
  assignments: Array<{ talkIndex: number; gapIndex: number; timestamp: number }>;
  totalScore: number;
}

function selectTransitionsDP(
  gaps: CandidateGap[],
  talks: Talk[],
  firstTalkStart: number
): DPResult {
  const N = talks.length;
  if (N <= 1) return { assignments: [{ talkIndex: 0, gapIndex: -1, timestamp: firstTalkStart }], totalScore: 0 };

  // We need N-1 transition points (between consecutive talks)
  // The first talk starts at firstTalkStart (known)
  // For each subsequent talk, we pick a gap

  // Build expected cumulative times with drift tolerance
  const expectedStarts: number[] = [firstTalkStart];
  for (let i = 1; i < N; i++) {
    // Expected start of talk i = previous talk start + previous talk duration + ~5min buffer
    const prevDur = talks[i - 1].scheduledDuration;
    // Short talks (lightning) have minimal buffer, longer talks have Q&A + intro
    const buffer = prevDur <= 600 ? 60 : 180;
    expectedStarts.push(expectedStarts[i - 1] + prevDur + buffer);
  }

  // For each talk transition (1..N-1), find candidate gaps within a time window
  // Window: expectedStart ± max(scheduledDuration * 0.6, 600)
  const assignments: Array<{ talkIndex: number; gapIndex: number; timestamp: number; score: number }> = [];

  let drift = 0; // cumulative drift from schedule

  for (let t = 1; t < N; t++) {
    const expected = expectedStarts[t] + drift;
    const tolerance = Math.max(talks[t - 1].scheduledDuration * 0.6, 600);
    const windowStart = expected - tolerance;
    const windowEnd = expected + tolerance;

    // Find the best gap in this window
    let bestGap = -1;
    let bestScore = -1;

    const nextTalk = talks[t]; // the talk that STARTS after this transition
    for (let g = 0; g < gaps.length; g++) {
      const gap = gaps[g];
      if (gap.timestamp < windowStart || gap.timestamp > windowEnd) continue;

      // Proximity bonus: prefer gaps closer to expected time
      const proximity = 1 - Math.abs(gap.timestamp - expected) / tolerance;
      // Talk-specific bonus: speaker name / title keywords for the NEXT talk
      const talkBonus = scoreGapForTalk(gap, nextTalk);
      const totalScore = gap.score + proximity * 5 + talkBonus;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestGap = g;
      }
    }

    if (bestGap >= 0) {
      const actualTime = gaps[bestGap].timestamp;
      assignments.push({ talkIndex: t, gapIndex: bestGap, timestamp: actualTime, score: bestScore });

      // Update drift
      const actualDuration = actualTime - (assignments.length >= 2 ? assignments[assignments.length - 2].timestamp : firstTalkStart);
      const expectedDuration = talks[t - 1].scheduledDuration + 180;
      drift += (actualDuration - expectedDuration) * 0.5; // smooth drift update
    } else {
      // No gap found — extrapolate
      const extrapolated = expected;
      assignments.push({ talkIndex: t, gapIndex: -1, timestamp: extrapolated, score: 0 });
    }
  }

  return {
    assignments: [
      { talkIndex: 0, gapIndex: -1, timestamp: firstTalkStart },
      ...assignments,
    ],
    totalScore: assignments.reduce((s, a) => s + a.score, 0),
  };
}

// --- Pass 4: Find first talk start ---

function findFirstTalkStart(gaps: CandidateGap[], talks: Talk[]): number {
  // The first significant gap with a greeting or introduction after it
  // Search the first 45 minutes
  const early = gaps.filter((g) => g.timestamp < 2700 && g.gapDuration >= 5);

  let best = 0;
  let bestScore = 0;
  for (const g of early) {
    if (g.score > bestScore) {
      bestScore = g.score;
      best = g.timestamp;
    }
  }

  return best || 300; // default: 5 min in
}

// --- Main ---

async function main() {
  const transcriptPath = process.argv[2];
  if (!transcriptPath) {
    console.error("Usage: npx tsx src/detect-boundaries-v5.ts <transcript.json>");
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
  ).all(...config.rooms, ...config.dates).map((t: any) => ({
    ...t,
    scheduledDuration: Math.max(300, (new Date(t.ends_at).getTime() - new Date(t.starts_at).getTime()) / 1000),
  })) as Talk[];

  console.log(`Talks (${talks.length}):`);
  for (const t of talks) {
    const speakerShort = t.speaker_names?.split(",")[0]?.trim() || "?";
    console.log(`  ${t.starts_at?.slice(11, 16)} (${(t.scheduledDuration / 60).toFixed(0)}m) ${t.title.slice(0, 45)} — ${speakerShort}`);
  }

  // Pass 1: Find all candidate gaps
  console.log(`\n=== Pass 1: Finding candidate gaps ===\n`);
  const gaps = findCandidateGaps(words, 3);
  console.log(`  Found ${gaps.length} gaps (>3s)`);

  // Pass 2: Score each gap
  console.log(`\n=== Pass 2: Scoring gaps ===\n`);
  for (const gap of gaps) {
    scoreGapGeneric(gap);
  }

  // Show top 30 scored gaps
  const topGaps = [...gaps].sort((a, b) => b.score - a.score).slice(0, 30);
  console.log(`  Top 30 scored gaps:`);
  for (const g of topGaps) {
    console.log(`    ${fmt(g.timestamp)} score=${g.score.toFixed(1)} [${g.signals.join(", ")}]`);
    const after = g.wordsAfter.slice(0, 12).join(" ");
    console.log(`      → "${after}..."`);
  }

  // Pass 3: Find first talk and select transitions with DP
  console.log(`\n=== Pass 3: Selecting ${talks.length - 1} transitions ===\n`);
  const firstStart = findFirstTalkStart(gaps, talks);
  console.log(`  First talk starts at: ${fmt(firstStart)}`);

  const dpResult = selectTransitionsDP(gaps, talks, firstStart);

  // Build results
  console.log(`\n=== Results (total score: ${dpResult.totalScore.toFixed(1)}) ===\n`);
  console.log(`  ${"Start".padEnd(10)} ${"Dur".padEnd(8)} ${"Score".padEnd(6)} ${"Signals".padEnd(40)} Title`);
  console.log(`  ${"-".repeat(100)}`);

  for (let i = 0; i < dpResult.assignments.length; i++) {
    const a = dpResult.assignments[i];
    const talk = talks[a.talkIndex];
    const nextA = dpResult.assignments[i + 1];
    const dur = nextA ? `${((nextA.timestamp - a.timestamp) / 60).toFixed(1)}m` : "→ end";
    const gap = a.gapIndex >= 0 ? gaps[a.gapIndex] : null;
    const signals = gap ? gap.signals.join(", ") : (a.gapIndex === -1 && i > 0 ? "extrapolated" : "stream-start");
    const score = gap ? gap.score.toFixed(1) : "-";

    console.log(`  ${fmt(a.timestamp).padEnd(10)} ${dur.padEnd(8)} ${score.padEnd(6)} ${signals.slice(0, 39).padEnd(40)} ${talk.title.slice(0, 50)} (${talk.rkey})`);
  }

  // Characterize inter-talk gaps
  console.log(`\n=== Inter-talk analysis ===\n`);
  for (let i = 0; i < dpResult.assignments.length - 1; i++) {
    const current = dpResult.assignments[i];
    const next = dpResult.assignments[i + 1];
    const actualDur = (next.timestamp - current.timestamp) / 60;
    const scheduledDur = talks[current.talkIndex].scheduledDuration / 60;
    const talkContent = scheduledDur;
    const interTalk = actualDur - talkContent;

    if (Math.abs(interTalk) > 2) {
      const label = interTalk > 0 ? `+${interTalk.toFixed(0)}m buffer` : `${interTalk.toFixed(0)}m (ran short)`;
      console.log(`  ${talks[current.talkIndex].title.slice(0, 40).padEnd(42)} ${actualDur.toFixed(0)}m actual vs ${scheduledDur.toFixed(0)}m scheduled (${label})`);
    }
  }

  // Save
  const results = dpResult.assignments.map((a, i) => {
    const nextA = dpResult.assignments[i + 1];
    const gap = a.gapIndex >= 0 ? gaps[a.gapIndex] : null;
    return {
      rkey: talks[a.talkIndex].rkey,
      title: talks[a.talkIndex].title,
      startTimestamp: a.timestamp,
      endTimestamp: nextA?.timestamp ?? null,
      confidence: gap ? (gap.score >= 15 ? "high" : gap.score >= 8 ? "medium" : "low") : (i === 0 ? "high" : "extrapolated"),
      score: gap?.score ?? 0,
      signals: gap?.signals ?? [],
    };
  });

  const outputPath = transcriptPath.replace(".json", "-boundaries-v5.json");
  writeFileSync(outputPath, JSON.stringify({ stream: transcript.stream, results }, null, 2));
  console.log(`\nSaved to ${outputPath}`);

  db.close();
}

main().catch(console.error);
