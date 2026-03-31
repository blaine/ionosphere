import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { extractAudio } from "./extract-audio.js";
import { openDb } from "./db.js";
import type { WordTimestamp, TranscriptResult } from "@ionosphere/format";

export type TranscriptionProvider = (audioPath: string) => Promise<TranscriptResult>;

async function placeholderProvider(audioPath: string): Promise<TranscriptResult> {
  throw new Error(`No transcription provider configured. Audio file: ${audioPath}`);
}

const TRANSCRIPT_DIR = path.resolve(import.meta.dirname, "../../data/transcripts");

export async function transcribeTalk(
  talkRkey: string,
  videoUri: string,
  provider: TranscriptionProvider = placeholderProvider
): Promise<TranscriptResult> {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });

  const cachedPath = path.join(TRANSCRIPT_DIR, `${talkRkey}.json`);

  if (existsSync(cachedPath)) {
    console.log(`  Transcript cached: ${talkRkey}`);
    return JSON.parse(readFileSync(cachedPath, "utf-8"));
  }

  const audioPath = extractAudio(videoUri, talkRkey);

  console.log(`  Transcribing ${talkRkey}...`);
  const result = await provider(audioPath);

  writeFileSync(cachedPath, JSON.stringify(result, null, 2));
  console.log(`  Saved transcript: ${cachedPath}`);

  return result;
}

async function main() {
  const db = openDb();
  const talks = db
    .prepare(
      `SELECT t.rkey, t.video_uri FROM talks t
       JOIN pipeline_status ps ON t.uri = ps.talk_uri
       WHERE t.video_uri IS NOT NULL AND ps.transcribed = 0
       LIMIT 5`
    )
    .all() as Array<{ rkey: string; video_uri: string }>;

  console.log(`${talks.length} talks to transcribe`);

  for (const talk of talks) {
    try {
      await transcribeTalk(talk.rkey, talk.video_uri);
      db.prepare(
        `UPDATE pipeline_status SET transcribed = 1, updated_at = CURRENT_TIMESTAMP
         WHERE talk_uri = (SELECT uri FROM talks WHERE rkey = ?)`
      ).run(talk.rkey);
    } catch (err) {
      console.error(`  Failed: ${talk.rkey}:`, (err as Error).message);
    }
  }

  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
