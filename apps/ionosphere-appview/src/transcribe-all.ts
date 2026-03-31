/**
 * Bulk transcription of all talks.
 *
 * For each talk with a video_uri:
 * 1. Extract audio via ffmpeg (cached to data/audio/)
 * 2. Transcribe via OpenAI Whisper (cached to data/transcripts/)
 * 3. Encode to compact format and store in transcripts table
 *
 * Resumable — checks cache before each step.
 *
 * Usage: npx tsx src/transcribe-all.ts [--limit N]
 */
import "./env.js";
import { openaiWhisperProvider } from "./providers/openai-whisper.js";
import { transcribeTalk } from "./transcribe.js";
import { openDb, migrate } from "./db.js";
import { encode } from "@ionosphere/format/transcript-encoding";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

const db = openDb();
migrate(db);

// Get all talks with video that don't have a transcript yet
const allTalks = db
  .prepare(
    `SELECT t.rkey, t.title, t.video_uri, t.uri, t.did, t.duration
     FROM talks t
     LEFT JOIN transcripts tr ON tr.talk_uri = t.uri
     WHERE t.video_uri IS NOT NULL AND tr.uri IS NULL
     ORDER BY t.starts_at ASC`
  )
  .all() as Array<{
    rkey: string;
    title: string;
    video_uri: string;
    uri: string;
    did: string;
    duration: number;
  }>;

const talks = allTalks.slice(0, limit);
const totalMinutes = talks.reduce(
  (sum, t) => sum + (t.duration ? t.duration / 1e9 / 60 : 30),
  0
);

console.log(`Transcription batch:`);
console.log(`  ${talks.length} talks to transcribe (${allTalks.length} total remaining)`);
console.log(`  Estimated duration: ~${totalMinutes.toFixed(0)} minutes of audio`);
console.log(`  Estimated cost: ~$${(totalMinutes * 0.006).toFixed(2)}`);
console.log();

let completed = 0;
let failed = 0;
const startTime = Date.now();

for (const talk of talks) {
  const durMin = talk.duration ? (talk.duration / 1e9 / 60).toFixed(1) : "?";
  console.log(
    `[${completed + failed + 1}/${talks.length}] ${talk.title} (${durMin} min)`
  );

  try {
    // Transcribe (extracts audio if needed, uses cache for both)
    const transcript = await transcribeTalk(
      talk.rkey,
      talk.video_uri,
      openaiWhisperProvider
    );

    // Encode to compact format
    const compact = encode(transcript);
    const gaps = compact.timings.filter((v) => v < 0).length;
    console.log(
      `  ✓ ${transcript.words.length} words, ${compact.timings.length} timings (${gaps} gaps), ${JSON.stringify(compact.timings).length} bytes`
    );

    // Store in transcripts table
    const transcriptRkey = `${talk.rkey}-transcript`;
    const transcriptUri = talk.uri.replace(
      "/tv.ionosphere.talk/",
      "/tv.ionosphere.transcript/"
    );

    db.prepare(
      `INSERT OR REPLACE INTO transcripts (uri, did, rkey, talk_uri, text, start_ms, timings)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      transcriptUri,
      talk.did,
      transcriptRkey,
      talk.uri,
      compact.text,
      compact.startMs,
      JSON.stringify(compact.timings)
    );

    completed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ FAILED: ${msg}`);
    failed++;
  }

  // Progress estimate
  const elapsed = (Date.now() - startTime) / 1000;
  const avgPerTalk = elapsed / (completed + failed);
  const remaining = (talks.length - completed - failed) * avgPerTalk;
  if (completed + failed > 1) {
    console.log(
      `  (${elapsed.toFixed(0)}s elapsed, ~${(remaining / 60).toFixed(1)} min remaining)`
    );
  }
}

const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
console.log(`\nDone: ${completed} transcribed, ${failed} failed in ${totalElapsed} min`);

// Count total transcripts in DB
const totalTranscripts = (
  db.prepare("SELECT COUNT(*) as count FROM transcripts").get() as any
).count;
console.log(`Total transcripts in database: ${totalTranscripts}`);

db.close();
