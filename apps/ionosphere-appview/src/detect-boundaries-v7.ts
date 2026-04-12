/**
 * v7 boundary detection pipeline — CLI entry point.
 *
 * Runs the four-stage pipeline:
 *   Stage 0: Hallucination detector
 *   Stage 1: Diarization segmenter
 *   Stage 2: Transcript matcher
 *   Stage 3: Schedule reconciler
 *
 * Usage:
 *   npx tsx src/detect-boundaries-v7.ts <transcript.json> \
 *     --diarization <diarization.json> \
 *     --stream-slug <slug>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { openDb } from './db.js';
import { detectHallucinationZones } from './v7/hallucination-detector.js';
import { segmentDiarization } from './v7/diarization-segmenter.js';
import { matchAllSegments } from './v7/transcript-matcher.js';
import { reconcileSchedule } from './v7/schedule-reconciler.js';
import type {
  DiarizationInput,
  ScheduleTalk,
  TranscriptInput,
} from './v7/types.js';

// ─── Stream metadata ──────────────────────────────────────────────────────────

const STREAM_MATCH: Record<string, { rooms?: string[]; rkeyPrefix?: string }> = {
  'great-hall-day-1': { rooms: ['Great Hall South'] },
  'great-hall-day-2': { rooms: ['Great Hall South'] },
  'room-2301-day-1': { rooms: ['Room 2301'] },
  'room-2301-day-2': { rooms: ['Room 2301'] },
  'performance-theatre-day-1': { rooms: ['Performance Theatre'] },
  'performance-theatre-day-2': { rooms: ['Performance Theatre'] },
  atscience: { rkeyPrefix: 'ats26-' },
};

const DAY_DATES: Record<string, string> = {
  Friday: '2026-03-27',
  Saturday: '2026-03-28',
  Sunday: '2026-03-29',
};

const SLUG_DAYS: Record<string, string> = {
  'great-hall-day-1': 'Saturday',
  'great-hall-day-2': 'Sunday',
  'room-2301-day-1': 'Saturday',
  'room-2301-day-2': 'Sunday',
  'performance-theatre-day-1': 'Saturday',
  'performance-theatre-day-2': 'Sunday',
  atscience: 'Friday',
};

/** Duration (seconds) from the hardcoded STREAMS config */
const SLUG_DURATIONS: Record<string, number> = {
  'great-hall-day-1': 28433,
  'great-hall-day-2': 28433,
  'room-2301-day-1': 27400,
  'room-2301-day-2': 27000,
  'performance-theatre-day-1': 24500,
  'performance-theatre-day-2': 27300,
  atscience: 29675,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function loadScheduleFromDb(slug: string): ScheduleTalk[] {
  const db = openDb();
  try {
    const match = STREAM_MATCH[slug];
    if (!match) {
      console.error(`Unknown stream slug: ${slug}`);
      return [];
    }

    if (match.rkeyPrefix) {
      // ATScience: match by rkey prefix
      return db
        .prepare(
          `SELECT t.rkey, t.title, t.starts_at, t.ends_at, t.duration,
                  GROUP_CONCAT(s.name) as speaker_names
           FROM talks t
           LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
           LEFT JOIN speakers s ON ts.speaker_uri = s.uri
           WHERE t.rkey LIKE ?
           GROUP BY t.rkey
           ORDER BY t.starts_at ASC`,
        )
        .all(`${match.rkeyPrefix}%`) as ScheduleTalk[];
    }

    // Other streams: match by room + date
    const dayLabel = SLUG_DAYS[slug];
    const date = dayLabel ? DAY_DATES[dayLabel] : undefined;
    if (!date || !match.rooms?.length) return [];

    const placeholders = match.rooms.map(() => '?').join(',');
    return db
      .prepare(
        `SELECT t.rkey, t.title, t.starts_at, t.ends_at, t.duration,
                GROUP_CONCAT(s.name) as speaker_names
         FROM talks t
         LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
         LEFT JOIN speakers s ON ts.speaker_uri = s.uri
         WHERE t.room IN (${placeholders}) AND t.starts_at LIKE ?
         GROUP BY t.rkey
         ORDER BY t.starts_at ASC`,
      )
      .all(...match.rooms, `${date}%`) as ScheduleTalk[];
  } finally {
    db.close();
  }
}

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);

  const transcriptPath = args[0];
  if (!transcriptPath || transcriptPath.startsWith('--')) {
    console.error(
      'Usage: npx tsx src/detect-boundaries-v7.ts <transcript.json>\n' +
        '         --diarization <diarization.json>\n' +
        '         --stream-slug <slug>',
    );
    process.exit(1);
  }

  const diarizationIdx = args.indexOf('--diarization');
  const diarizationPath = diarizationIdx >= 0 ? args[diarizationIdx + 1] : null;
  if (!diarizationPath) {
    console.error('Error: --diarization <path> is required');
    process.exit(1);
  }

  const slugIdx = args.indexOf('--stream-slug');
  const streamSlug = slugIdx >= 0 ? args[slugIdx + 1] : null;
  if (!streamSlug) {
    console.error('Error: --stream-slug <slug> is required');
    process.exit(1);
  }

  return { transcriptPath, diarizationPath, streamSlug };
}

// ─── Summary table ────────────────────────────────────────────────────────────

function printSummary(output: Awaited<ReturnType<typeof reconcileSchedule>>) {
  const { stream, results, hallucinationZones, unmatchedSegments, unmatchedSchedule } = output;

  console.log(`\n${'='.repeat(100)}`);
  console.log(`Stream: ${stream}`);
  console.log(`Results: ${results.length} talks`);
  console.log(`Hallucination zones: ${hallucinationZones.length}`);
  console.log(`Unmatched segments: ${unmatchedSegments.length}`);
  console.log(`Unmatched schedule: ${unmatchedSchedule.length}`);
  console.log(`${'='.repeat(100)}\n`);

  const col = (s: string, w: number) => s.slice(0, w).padEnd(w);

  console.log(
    `  ${col('Start', 9)} ${col('End', 9)} ${col('Conf', 13)} ${col('Signals', 40)} Title`,
  );
  console.log(`  ${'-'.repeat(100)}`);

  for (const r of results) {
    const start = fmt(r.startTimestamp);
    const end = r.endTimestamp !== null ? fmt(r.endTimestamp) : '    -';
    const conf = r.confidence.padEnd(13);
    const signals = r.signals.join(', ').slice(0, 40).padEnd(40);
    const title = r.title.slice(0, 50);
    console.log(`  ${start.padEnd(9)} ${end.padEnd(9)} ${conf} ${signals} ${title}`);
  }

  if (unmatchedSchedule.length > 0) {
    console.log(`\nUnmatched schedule rkeys: ${unmatchedSchedule.join(', ')}`);
  }

  if (unmatchedSegments.length > 0) {
    console.log(`\nUnmatched segments:`);
    for (const seg of unmatchedSegments) {
      console.log(`  ${fmt(seg.startS)} - ${fmt(seg.endS)} (${seg.type})`);
    }
  }

  if (hallucinationZones.length > 0) {
    console.log(`\nHallucination zones:`);
    for (const z of hallucinationZones) {
      console.log(`  ${fmt(z.startS)} - ${fmt(z.endS)} [${z.pattern}]`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { transcriptPath, diarizationPath, streamSlug } = parseArgs();

  console.log(`\nLoading transcript: ${transcriptPath}`);
  const transcript = JSON.parse(readFileSync(transcriptPath, 'utf-8')) as TranscriptInput;

  console.log(`Loading diarization: ${diarizationPath}`);
  const diarization = JSON.parse(readFileSync(diarizationPath, 'utf-8')) as DiarizationInput;

  console.log(`Loading schedule for stream: ${streamSlug}`);
  const schedule = loadScheduleFromDb(streamSlug);
  console.log(`  Found ${schedule.length} scheduled talks`);

  // Determine stream duration
  const streamDurationS =
    transcript.duration_seconds ||
    SLUG_DURATIONS[streamSlug] ||
    0;

  console.log(
    `  Stream: ${transcript.stream ?? streamSlug}, duration: ${fmt(streamDurationS)} (${(streamDurationS / 3600).toFixed(1)}h)`,
  );
  console.log(`  Transcript words: ${transcript.words.length}`);
  console.log(`  Diarization segments: ${diarization.segments.length}, speakers: ${diarization.speakers.join(', ')}`);

  // ── Stage 0: Hallucination detection ──
  console.log(`\n=== Stage 0: Detecting hallucination zones ===`);
  const hallucinationZones = detectHallucinationZones(transcript, diarization);
  console.log(`  Found ${hallucinationZones.length} hallucination zone(s)`);

  // ── Stage 1: Diarization segmentation ──
  console.log(`\n=== Stage 1: Segmenting diarization ===`);
  const segments = segmentDiarization(diarization, hallucinationZones);
  console.log(`  Found ${segments.length} talk segment(s)`);

  // ── Stage 2: Transcript matching ──
  console.log(`\n=== Stage 2: Matching segments to schedule ===`);
  const matches = matchAllSegments(segments, transcript, schedule, hallucinationZones);
  console.log(`  Produced ${matches.length} match(es)`);

  // ── Stage 3: Schedule reconciliation ──
  console.log(`\n=== Stage 3: Reconciling schedule ===`);
  const streamName = transcript.stream ?? streamSlug;
  const output = reconcileSchedule(
    matches,
    segments,
    schedule,
    hallucinationZones,
    streamDurationS,
    streamName,
    // No wall-clock start available from transcript, skip zone-based unverifiable check
  );

  // Print summary table
  printSummary(output);

  // Write output
  const outputPath = transcriptPath.replace(/\.json$/, '') + '-boundaries-v7.json';
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
