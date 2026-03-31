/**
 * Transcribe a single talk and store as a compact transcript record.
 * Usage: npx tsx src/transcribe-one.ts <rkey>
 */
import "./env.js";
import { openaiWhisperProvider } from "./providers/openai-whisper.js";
import { transcribeTalk } from "./transcribe.js";
import { openDb, migrate } from "./db.js";
import { encode } from "@ionosphere/format/transcript-encoding";

const rkey = process.argv[2];
if (!rkey) {
  console.error("Usage: npx tsx src/transcribe-one.ts <rkey>");
  process.exit(1);
}

const db = openDb();
migrate(db); // ensure transcripts table exists

const talk = db.prepare("SELECT * FROM talks WHERE rkey = ?").get(rkey) as any;

if (!talk) {
  console.error(`Talk not found: ${rkey}`);
  process.exit(1);
}
if (!talk.video_uri) {
  console.error(`Talk has no video: ${rkey}`);
  process.exit(1);
}

console.log(`Transcribing: ${talk.title}`);
console.log(`  Video: ${talk.video_uri}`);

const transcript = await transcribeTalk(
  talk.rkey,
  talk.video_uri,
  openaiWhisperProvider
);

console.log(`\nTranscript: ${transcript.text.length} chars, ${transcript.words.length} words`);

// Encode to compact format
const compact = encode(transcript);
const gaps = compact.timings.filter((v) => v < 0).length;
console.log(`Compact: ${compact.timings.length} timings (${compact.timings.length - gaps} durations, ${gaps} gaps)`);
console.log(`  Size: ${JSON.stringify(compact.timings).length} bytes`);

// Store in transcripts table
const transcriptRkey = `${rkey}-transcript`;
const transcriptUri = `${talk.uri.replace("/tv.ionosphere.talk/", "/tv.ionosphere.transcript/")}`;

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

// Clear old document column (no longer used)
db.prepare("UPDATE talks SET document = NULL WHERE rkey = ?").run(rkey);

// Update pipeline status
db.prepare(
  `UPDATE pipeline_status SET transcribed = 1, assembled = 1, updated_at = CURRENT_TIMESTAMP
   WHERE talk_uri = ?`
).run(talk.uri);

console.log(`\nStored compact transcript record: ${transcriptUri}`);
db.close();
