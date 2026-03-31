/**
 * Transcribe a single talk for testing.
 * Usage: tsx src/transcribe-one.ts <rkey>
 */
import "./env.js";
import { openaiWhisperProvider } from "./providers/openai-whisper.js";
import { transcribeTalk } from "./transcribe.js";
import { openDb } from "./db.js";
import { assembleDocument } from "@ionosphere/format/assemble";

const rkey = process.argv[2];
if (!rkey) {
  console.error("Usage: tsx src/transcribe-one.ts <rkey>");
  process.exit(1);
}

const db = openDb();
const talk = db
  .prepare("SELECT * FROM talks WHERE rkey = ?")
  .get(rkey) as any;

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
console.log(`First 200 chars: ${transcript.text.slice(0, 200)}...`);
console.log(`\nFirst 5 words with timestamps:`);
for (const w of transcript.words.slice(0, 5)) {
  console.log(`  "${w.word}" ${w.start.toFixed(2)}s - ${w.end.toFixed(2)}s`);
}

// Assemble into RelationalText document
const doc = assembleDocument(transcript);
console.log(`\nDocument: ${doc.facets.length} facets`);

// Store document on talk record
db.prepare("UPDATE talks SET document = ? WHERE rkey = ?").run(
  JSON.stringify(doc),
  rkey
);

// Update pipeline status
db.prepare(
  `UPDATE pipeline_status SET transcribed = 1, assembled = 1, updated_at = CURRENT_TIMESTAMP
   WHERE talk_uri = ?`
).run(talk.uri);

console.log(`\nStored document on talk record. Check http://localhost:9401/talks/${rkey}`);
db.close();
