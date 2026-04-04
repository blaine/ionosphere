/**
 * Enhanced boundary detection — v5 + speaker diarization + segment confidence.
 *
 * Consumes enriched transcript JSON (with optional speaker labels and
 * segment-level confidence). Falls back gracefully to plain transcripts.
 *
 * New signals over v5:
 *   - speaker_change: dominant speaker differs across gap
 *   - speaker_set_change: set of active speakers changes
 *   - confidence_drop: low avg_logprob near gap (garbled audio)
 *   - no_speech_zone: high no_speech_prob segments
 *
 * Usage: npx tsx src/detect-boundaries-v6.ts <transcript.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { openDb } from "./db.js";
import { phoneticSearch } from "./phonetic.js";

// --- Interfaces ---

interface Word {
  word: string;
  start: number;
  end: number;
  speaker?: string;
}

interface Segment {
  start: number;
  end: number;
  text?: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
}

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

// --- Speaker change scoring (exported for testing) ---

interface ScoredSignal {
  score: number;
  signal: string;
}

/**
 * Find the dominant speaker in a word list (most frequent speaker label).
 */
function dominantSpeaker(words: Word[]): string | null {
  const counts = new Map<string, number>();
  for (const w of words) {
    if (w.speaker) {
      counts.set(w.speaker, (counts.get(w.speaker) || 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let best = "";
  let bestCount = 0;
  for (const [spk, count] of counts) {
    if (count > bestCount) {
      best = spk;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Get the set of speakers active in a word list.
 */
function speakerSet(words: Word[]): Set<string> {
  const s = new Set<string>();
  for (const w of words) {
    if (w.speaker) s.add(w.speaker);
  }
  return s;
}

/**
 * Score speaker change across a gap.
 * Returns high score if dominant speaker changes, medium if speaker set changes.
 */
export function scoreSpeakerChange(
  wordsBefore: Word[],
  wordsAfter: Word[],
): ScoredSignal {
  const before = dominantSpeaker(wordsBefore);
  const after = dominantSpeaker(wordsAfter);

  if (!before || !after) return { score: 0, signal: "" };

  // Dominant speaker change — strong signal
  if (before !== after) {
    // Also check if the speaker sets are completely different
    const setBefore = speakerSet(wordsBefore);
    const setAfter = speakerSet(wordsAfter);
    const overlap = [...setBefore].filter((s) => setAfter.has(s));

    if (overlap.length === 0) {
      return { score: 15, signal: `speaker_change(${before}→${after})+set_change` };
    }
    return { score: 12, signal: `speaker_change(${before}→${after})` };
  }

  // Same dominant speaker but set changed (e.g. panel transitions)
  const setBefore = speakerSet(wordsBefore);
  const setAfter = speakerSet(wordsAfter);
  if (setBefore.size > 0 && setAfter.size > 0) {
    const overlap = [...setBefore].filter((s) => setAfter.has(s));
    if (overlap.length < Math.min(setBefore.size, setAfter.size) * 0.5) {
      return { score: 8, signal: "speaker_set_change" };
    }
  }

  return { score: 0, signal: "" };
}

// --- Confidence scoring (exported for testing) ---

/**
 * Score confidence drop near a gap timestamp.
 * Low avg_logprob or high no_speech_prob indicates garbled/music/applause.
 */
export function scoreConfidenceDrop(
  segments: Segment[],
  gapTimestamp: number,
  windowSec: number = 30,
): ScoredSignal {
  const nearby = segments.filter(
    (s) => s.start >= gapTimestamp - windowSec && s.end <= gapTimestamp + windowSec,
  );
  if (nearby.length === 0) return { score: 0, signal: "" };

  let score = 0;
  const signals: string[] = [];

  // Low confidence segments near the gap
  const lowConf = nearby.filter((s) => s.avg_logprob !== undefined && s.avg_logprob < -1.0);
  if (lowConf.length > 0) {
    const avgLogprob = lowConf.reduce((s, seg) => s + (seg.avg_logprob || 0), 0) / lowConf.length;
    score += Math.min(6, lowConf.length * 2);
    signals.push(`confidence_drop(${avgLogprob.toFixed(1)})`);
  }

  // High no-speech segments
  const noSpeech = nearby.filter((s) => s.no_speech_prob !== undefined && s.no_speech_prob > 0.5);
  if (noSpeech.length > 0) {
    score += Math.min(4, noSpeech.length);
    signals.push(`no_speech(${noSpeech.length})`);
  }

  return { score, signal: signals.join("+") };
}

/**
 * Find contiguous zones of low-confidence segments.
 * Replaces the word-repetition garbled zone detection from v5.
 */
export function findLowConfidenceZones(
  segments: Segment[],
  logprobThreshold: number = -1.0,
  noSpeechThreshold: number = 0.5,
): Array<{ start: number; end: number }> {
  const zones: Array<{ start: number; end: number }> = [];
  let zoneStart: number | null = null;
  let zoneEnd = 0;

  for (const seg of segments) {
    const isLow =
      (seg.avg_logprob !== undefined && seg.avg_logprob < logprobThreshold) ||
      (seg.no_speech_prob !== undefined && seg.no_speech_prob > noSpeechThreshold);

    if (isLow) {
      if (zoneStart === null) zoneStart = seg.start;
      zoneEnd = seg.end;
    } else {
      if (zoneStart !== null && zoneEnd - zoneStart > 30) {
        zones.push({ start: zoneStart, end: zoneEnd });
      }
      zoneStart = null;
    }
  }

  if (zoneStart !== null && zoneEnd - zoneStart > 30) {
    zones.push({ start: zoneStart, end: zoneEnd });
  }

  return zones;
}

// --- Pass 1: Find all candidate gaps (same as v5) ---

interface CandidateGap {
  timestamp: number;
  gapDuration: number;
  wordsBefore: Word[];
  wordsAfter: Word[];
  score: number;
  signals: string[];
}

function findCandidateGaps(words: Word[], minGap: number = 3): CandidateGap[] {
  const gaps: CandidateGap[] = [];
  for (let i = 1; i < words.length; i++) {
    const gapDuration = words[i].start - words[i - 1].end;
    if (gapDuration < minGap) continue;

    const before = words.slice(Math.max(0, i - 20), i);
    const after = words.slice(i, Math.min(words.length, i + 30));

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

// --- Pass 2: Score gaps ---

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

function scoreGapGeneric(gap: CandidateGap, segments: Segment[]): void {
  const beforeText = gap.wordsBefore.map((w) => w.word).join(" ");
  const afterText = gap.wordsAfter.map((w) => w.word).join(" ");

  gap.score = 0;
  gap.signals = [];

  // Gap duration score (same as v5)
  if (gap.gapDuration >= 60) {
    gap.score += 25;
  } else if (gap.gapDuration >= 30) {
    gap.score += 15 + (gap.gapDuration - 30) / 3;
  } else {
    gap.score += Math.min(15, gap.gapDuration * 0.5);
  }
  if (gap.gapDuration >= 5) gap.signals.push(`gap-${gap.gapDuration.toFixed(0)}s`);

  // Transition phrases before/after
  for (const { pattern, weight, label } of TRANSITION_BEFORE) {
    if (pattern.test(beforeText)) {
      gap.score += weight;
      gap.signals.push(`before:${label}`);
    }
  }
  for (const { pattern, weight, label } of TRANSITION_AFTER) {
    if (pattern.test(afterText)) {
      gap.score += weight;
      gap.signals.push(`after:${label}`);
    }
  }

  // NEW: Speaker change scoring
  const speakerResult = scoreSpeakerChange(gap.wordsBefore, gap.wordsAfter);
  if (speakerResult.score > 0) {
    gap.score += speakerResult.score;
    gap.signals.push(speakerResult.signal);
  }

  // NEW: Confidence scoring
  if (segments.length > 0) {
    const confResult = scoreConfidenceDrop(segments, gap.timestamp);
    if (confResult.score > 0) {
      gap.score += confResult.score;
      gap.signals.push(confResult.signal);
    }
  }
}

/**
 * Score a gap specifically for a given talk (same as v5).
 */
function scoreGapForTalk(gap: CandidateGap, talk: Talk): number {
  const beforeText = gap.wordsBefore.map((w) => w.word).join(" ").toLowerCase();
  const afterText = gap.wordsAfter.map((w) => w.word).join(" ").toLowerCase();
  const surroundingText = beforeText + " " + afterText;
  let bonus = 0;

  if (talk.speaker_names) {
    const surroundingWords = gap.wordsBefore.concat(gap.wordsAfter).map((w) => w.word.toLowerCase());
    const names = talk.speaker_names.split(",").map((n) => n.trim());
    for (const name of names) {
      if (phoneticSearch(name, surroundingWords)) {
        bonus += 10;
        break;
      }
    }
  }

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
  }

  return bonus;
}

// --- Pass 3: DP transition selection (same as v5 with speaker bonus) ---

interface DPResult {
  assignments: Array<{ talkIndex: number; gapIndex: number; timestamp: number }>;
  totalScore: number;
}

function selectTransitionsDP(
  gaps: CandidateGap[],
  talks: Talk[],
  firstTalkStart: number,
): DPResult {
  const N = talks.length;
  if (N <= 1) return { assignments: [{ talkIndex: 0, gapIndex: -1, timestamp: firstTalkStart }], totalScore: 0 };

  const expectedStarts: number[] = [firstTalkStart];
  for (let i = 1; i < N; i++) {
    const prevDur = talks[i - 1].scheduledDuration;
    const buffer = prevDur <= 600 ? 60 : 180;
    expectedStarts.push(expectedStarts[i - 1] + prevDur + buffer);
  }

  const assignments: Array<{ talkIndex: number; gapIndex: number; timestamp: number; score: number }> = [];
  let drift = 0;

  for (let t = 1; t < N; t++) {
    const expected = expectedStarts[t] + drift;
    const tolerance = Math.max(talks[t - 1].scheduledDuration * 0.6, 600);
    const windowStart = expected - tolerance;
    const windowEnd = expected + tolerance;

    let bestGap = -1;
    let bestScore = -1;

    const nextTalk = talks[t];
    for (let g = 0; g < gaps.length; g++) {
      const gap = gaps[g];
      if (gap.timestamp < windowStart || gap.timestamp > windowEnd) continue;

      const proximity = 1 - Math.abs(gap.timestamp - expected) / tolerance;
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

      const actualDuration = actualTime - (assignments.length >= 2 ? assignments[assignments.length - 2].timestamp : firstTalkStart);
      const expectedDuration = talks[t - 1].scheduledDuration + 180;
      drift += (actualDuration - expectedDuration) * 0.5;
    } else {
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

// --- Garbled zone detection (enhanced with confidence) ---

function findUsableTranscriptStart(words: Word[], segments: Segment[]): number {
  // If we have segment confidence, use it
  if (segments.length > 0) {
    const zones = findLowConfidenceZones(segments);
    if (zones.length > 0 && zones[0].start < 600) {
      // Garbled zone at start of stream
      return zones[0].end;
    }
  }

  // Fallback: word-repetition detection (v5 method)
  const windowSize = 20;
  for (let i = 0; i < words.length - windowSize; i++) {
    const window = words.slice(i, i + windowSize);
    const unique = new Set(window.map((w) => w.word.toLowerCase()));
    if (unique.size >= 12) {
      return words[i].start;
    }
  }
  return 0;
}

// --- Pass 4: Find first talk start ---

function findFirstTalkStart(gaps: CandidateGap[], talks: Talk[], words: Word[], segments: Segment[]): number {
  const usableStart = findUsableTranscriptStart(words, segments);

  const candidates = gaps.filter((g) => g.timestamp >= usableStart && g.timestamp < usableStart + 2700);

  let best = 0;
  let bestScore = 0;
  for (const g of candidates) {
    if (g.score > bestScore) {
      bestScore = g.score;
      best = g.timestamp;
    }
  }

  if (talks.length > 0 && talks[0].speaker_names) {
    for (const g of candidates) {
      const speakerBonus = scoreGapForTalk(g, talks[0]);
      if (speakerBonus > 0 && g.score + speakerBonus > bestScore) {
        bestScore = g.score + speakerBonus;
        best = g.timestamp;
      }
    }
  }

  if (bestScore < 5) {
    console.log(`  Garbled zone ends at: ${fmt(usableStart)}`);
    console.log(`  No strong transition found — estimating first talk start`);
    return Math.max(0, usableStart - 180);
  }

  return best;
}

// --- Pass 5: Forward-scan refinement (same as v5) ---

const TALK_START_PATTERNS = [
  { pattern: /^(hello|hi)\s+(everyone|there|folks)/i, weight: 8, label: "greeting" },
  { pattern: /my\s+name\s+is/i, weight: 10, label: "self-intro" },
  { pattern: /i'?m\s+(going\s+to|gonna)\s+(talk|present|show|discuss)/i, weight: 8, label: "talk-about" },
  { pattern: /so\s+(today|this\s+talk|i\s+want\s+to)/i, weight: 5, label: "so-today" },
  { pattern: /thank\s+you.*\s+(so|for)\s+(having|inviting|the\s+intro)/i, weight: 6, label: "thanks-for-intro" },
];

function refineTalkStart(
  words: Word[],
  gapTimestamp: number,
  talk: Talk,
  maxForwardSec: number = 900,
): { timestamp: number; signal: string } {
  let bestTimestamp = gapTimestamp;
  let bestScore = 0;
  let bestSignal = "";

  const endWindow = gapTimestamp + maxForwardSec;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.start < gapTimestamp || w.start > endWindow) continue;

    if (i > 0) {
      const gap = w.start - words[i - 1].end;
      if (gap >= 5) {
        const afterText = words.slice(i, Math.min(words.length, i + 15)).map((ww) => ww.word).join(" ");

        let score = 0;
        let signal = "";

        if (talk.speaker_names) {
          const afterWords = words.slice(i, Math.min(words.length, i + 20)).map((ww) => ww.word);
          if (phoneticSearch(talk.speaker_names, afterWords)) {
            score += 12;
            signal = "speaker-after-gap";
          }
        }

        for (const { pattern, weight, label } of TALK_START_PATTERNS) {
          if (pattern.test(afterText)) {
            score += weight;
            signal = signal ? `${signal}+${label}` : label;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestTimestamp = w.start;
          bestSignal = signal;
        }
      }
    }

    if (talk.speaker_names && i % 5 === 0) {
      const window = words.slice(i, Math.min(words.length, i + 10)).map((ww) => ww.word);
      const windowText = window.join(" ");

      for (const { pattern, weight, label } of TALK_START_PATTERNS) {
        if (pattern.test(windowText)) {
          if (phoneticSearch(talk.speaker_names, window)) {
            const score = weight + 8;
            if (score > bestScore) {
              bestScore = score;
              bestTimestamp = w.start;
              bestSignal = `${label}+speaker`;
            }
          }
        }
      }
    }
  }

  if (bestScore >= 8 && bestTimestamp > gapTimestamp) {
    return { timestamp: bestTimestamp, signal: bestSignal };
  }

  return { timestamp: gapTimestamp, signal: "" };
}

// --- Main ---

async function main() {
  const transcriptPath = process.argv[2];
  if (!transcriptPath) {
    console.error("Usage: npx tsx src/detect-boundaries-v6.ts <transcript.json>");
    process.exit(1);
  }

  const transcript = JSON.parse(readFileSync(transcriptPath, "utf-8"));
  const words: Word[] = transcript.words;
  const segments: Segment[] = transcript.segments || [];
  const duration = transcript.durationSeconds || transcript.duration_seconds;

  const hasSpeakers = words.some((w) => w.speaker);
  const hasSegments = segments.length > 0;

  console.log(`Stream: ${transcript.stream}`);
  console.log(`Duration: ${fmt(duration)} (${(duration / 3600).toFixed(1)}h)`);
  console.log(`Words: ${words.length}`);
  console.log(`Enrichment: speakers=${hasSpeakers}, segments=${hasSegments} (${segments.length})\n`);

  // Get talks from DB
  const db = openDb();
  const roomMap: Record<string, { rooms: string[]; dates: string[] }> = {
    "ATScience": { rooms: ["Performance Theatre", "Bukhman Lounge"], dates: ["2026-03-27"] },
    "Great Hall South": { rooms: ["Great Hall South"], dates: [] },
    "Room 2301": { rooms: ["Room 2301", "2301 Classroom"], dates: [] },
    "Performance Theatre": { rooms: ["Performance Theatre"], dates: [] },
  };
  const room = transcript.room || "Great Hall South";
  const config = roomMap[room] || { rooms: [room], dates: [] };
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
     ORDER BY t.starts_at ASC`,
  ).all(...config.rooms, ...config.dates).map((t: any) => ({
    ...t,
    scheduledDuration: Math.max(300, (new Date(t.ends_at).getTime() - new Date(t.starts_at).getTime()) / 1000),
  })) as Talk[];

  console.log(`Talks (${talks.length}):`);
  for (const t of talks) {
    const speakerShort = t.speaker_names?.split(",")[0]?.trim() || "?";
    console.log(`  ${t.starts_at?.slice(11, 16)} (${(t.scheduledDuration / 60).toFixed(0)}m) ${t.title.slice(0, 45)} — ${speakerShort}`);
  }

  // Pass 1: Find candidate gaps
  console.log(`\n=== Pass 1: Finding candidate gaps ===\n`);
  const gaps = findCandidateGaps(words, 3);
  console.log(`  Found ${gaps.length} gaps (>3s)`);

  // Pass 2: Score each gap
  console.log(`\n=== Pass 2: Scoring gaps ===\n`);
  for (const gap of gaps) {
    scoreGapGeneric(gap, segments);
  }

  const topGaps = [...gaps].sort((a, b) => b.score - a.score).slice(0, 30);
  console.log(`  Top 30 scored gaps:`);
  for (const g of topGaps) {
    console.log(`    ${fmt(g.timestamp)} score=${g.score.toFixed(1)} [${g.signals.join(", ")}]`);
    const after = g.wordsAfter.slice(0, 12).map((w) => w.word).join(" ");
    console.log(`      → "${after}..."`);
  }

  // Pass 3: DP
  console.log(`\n=== Pass 3: Selecting ${talks.length - 1} transitions ===\n`);
  const firstStart = findFirstTalkStart(gaps, talks, words, segments);
  console.log(`  First talk starts at: ${fmt(firstStart)}`);

  const dpResult = selectTransitionsDP(gaps, talks, firstStart);

  // Pass 5: Forward-scan refinement
  console.log(`\n=== Pass 5: Refining transitions ===\n`);
  for (let i = 1; i < dpResult.assignments.length; i++) {
    const a = dpResult.assignments[i];
    const talk = talks[a.talkIndex];
    const refined = refineTalkStart(words, a.timestamp, talk);
    if (refined.timestamp !== a.timestamp) {
      const delta = ((refined.timestamp - a.timestamp) / 60).toFixed(1);
      console.log(`  ${talk.title.slice(0, 40).padEnd(42)} ${fmt(a.timestamp)} → ${fmt(refined.timestamp)} (+${delta}m) [${refined.signal}]`);
      a.timestamp = refined.timestamp;
    }
  }

  // Show low-confidence zones if available
  if (hasSegments) {
    const zones = findLowConfidenceZones(segments);
    if (zones.length > 0) {
      console.log(`\n=== Low-confidence zones ===\n`);
      for (const z of zones) {
        console.log(`  ${fmt(z.start)} - ${fmt(z.end)} (${((z.end - z.start) / 60).toFixed(1)}m)`);
      }
    }
  }

  // Results
  console.log(`\n=== Results (total score: ${dpResult.totalScore.toFixed(1)}) ===\n`);
  console.log(`  ${"Start".padEnd(10)} ${"Dur".padEnd(8)} ${"Score".padEnd(6)} ${"Signals".padEnd(50)} Title`);
  console.log(`  ${"-".repeat(120)}`);

  for (let i = 0; i < dpResult.assignments.length; i++) {
    const a = dpResult.assignments[i];
    const talk = talks[a.talkIndex];
    const nextA = dpResult.assignments[i + 1];
    const dur = nextA ? `${((nextA.timestamp - a.timestamp) / 60).toFixed(1)}m` : "→ end";
    const gap = a.gapIndex >= 0 ? gaps[a.gapIndex] : null;
    const signals = gap ? gap.signals.join(", ") : (a.gapIndex === -1 && i > 0 ? "extrapolated" : "stream-start");
    const score = gap ? gap.score.toFixed(1) : "-";

    console.log(`  ${fmt(a.timestamp).padEnd(10)} ${dur.padEnd(8)} ${score.padEnd(6)} ${signals.slice(0, 49).padEnd(50)} ${talk.title.slice(0, 50)} (${talk.rkey})`);
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

  const outputPath = transcriptPath.replace(".json", "-boundaries-v6.json");
  writeFileSync(outputPath, JSON.stringify({ stream: transcript.stream, results }, null, 2));
  console.log(`\nSaved to ${outputPath}`);

  db.close();
}

main().catch(console.error);
