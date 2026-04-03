/**
 * Transcribe full-day conference streams.
 *
 * Downloads the full HLS stream, extracts audio in 20-minute chunks,
 * transcribes each chunk via Whisper, and stitches word-level timestamps
 * back into one continuous transcript per stream.
 *
 * Usage: npx tsx src/transcribe-fullday.ts
 *
 * Environment: OPENAI_API_KEY
 */
import "./env.js";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { WordTimestamp } from "@ionosphere/format";

const client = new OpenAI();

const VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";
const DATA_DIR = path.resolve(import.meta.dirname, "../../data");
const FULLDAY_DIR = path.join(DATA_DIR, "fullday");
const CHUNK_SECONDS = 20 * 60; // 20-minute chunks for Whisper's 25MB limit

// Full-day stream records
const FULLDAY_STREAMS: Array<{
  name: string;
  room: string;
  day: number; // 1 or 2
  uri: string;
}> = [
  { name: "Great Hall - Day 1", room: "Great Hall South", day: 1, uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadw52j22" },
  { name: "Great Hall - Day 2", room: "Great Hall South", day: 2, uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miighlz53o22" },
  { name: "Room 2301 - Day 1", room: "Room 2301", day: 1, uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadx2dj22" },
  { name: "Room 2301 - Day 2", room: "Room 2301", day: 2, uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadxeqn22" },
  { name: "Performance Theater - Day 1", room: "Performance Theatre", day: 1, uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwgvz22" },
  { name: "Performance Theater - Day 2", room: "Performance Theatre", day: 2, uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwqgy22" },
  { name: "ATScience - Full Day", room: "ATScience", day: 1, uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadvruo22" },
];

function buildPlaylistUrl(videoUri: string): string {
  return `${VOD_ENDPOINT}?uri=${encodeURIComponent(videoUri)}`;
}

/**
 * Get the duration of an HLS stream in seconds using ffprobe.
 */
function getStreamDuration(playlistUrl: string): number {
  try {
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${playlistUrl}"`,
      { timeout: 60_000 }
    ).toString().trim();
    return parseFloat(out) || 0;
  } catch {
    return 0;
  }
}

/**
 * Extract a chunk of audio from an HLS stream.
 */
function extractChunk(
  playlistUrl: string,
  startSec: number,
  durationSec: number,
  outputPath: string
): void {
  if (existsSync(outputPath)) return;
  console.log(`    Extracting chunk: ${startSec}s - ${startSec + durationSec}s`);
  execSync(
    `ffmpeg -i "${playlistUrl}" -ss ${startSec} -t ${durationSec} -vn -acodec libmp3lame -ar 16000 -ac 1 -b:a 32k "${outputPath}" -y`,
    { stdio: "pipe", timeout: 600_000 }
  );
}

/**
 * Transcribe a single audio chunk via Whisper.
 */
async function transcribeChunk(audioPath: string): Promise<{ text: string; words: WordTimestamp[] }> {
  const { createReadStream } = await import("node:fs");
  const response = await client.audio.transcriptions.create({
    model: "whisper-1",
    file: createReadStream(audioPath),
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  });

  const words: WordTimestamp[] = (response.words ?? []).map((w) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    confidence: 1.0,
  }));

  return { text: response.text, words };
}

/**
 * Process one full-day stream: chunk, transcribe, stitch.
 */
async function processStream(stream: typeof FULLDAY_STREAMS[0]): Promise<void> {
  const streamDir = path.join(FULLDAY_DIR, stream.name.replace(/[^a-zA-Z0-9-]/g, "_"));
  mkdirSync(streamDir, { recursive: true });

  const resultPath = path.join(streamDir, "transcript.json");
  if (existsSync(resultPath)) {
    console.log(`  Already transcribed: ${stream.name}`);
    return;
  }

  const playlistUrl = buildPlaylistUrl(stream.uri);
  console.log(`\nProcessing: ${stream.name}`);
  console.log(`  Playlist: ${playlistUrl}`);

  // Get stream duration
  const duration = getStreamDuration(playlistUrl);
  if (duration <= 0) {
    console.log(`  ERROR: Could not determine stream duration`);
    return;
  }
  console.log(`  Duration: ${(duration / 3600).toFixed(1)} hours (${Math.round(duration)}s)`);

  // Extract and transcribe chunks
  const numChunks = Math.ceil(duration / CHUNK_SECONDS);
  console.log(`  Chunks: ${numChunks} x ${CHUNK_SECONDS / 60}min`);

  const allWords: WordTimestamp[] = [];
  let fullText = "";

  for (let i = 0; i < numChunks; i++) {
    const startSec = i * CHUNK_SECONDS;
    const chunkDuration = Math.min(CHUNK_SECONDS, duration - startSec);
    const chunkPath = path.join(streamDir, `chunk-${String(i).padStart(3, "0")}.mp3`);
    const chunkTranscriptPath = path.join(streamDir, `chunk-${String(i).padStart(3, "0")}.json`);

    // Check if chunk transcript already exists
    if (existsSync(chunkTranscriptPath)) {
      console.log(`    Chunk ${i + 1}/${numChunks}: cached`);
      const cached = JSON.parse(readFileSync(chunkTranscriptPath, "utf-8"));
      allWords.push(...cached.words);
      fullText += (fullText ? " " : "") + cached.text;
      continue;
    }

    // Extract audio chunk
    try {
      extractChunk(playlistUrl, startSec, chunkDuration, chunkPath);
    } catch (err) {
      console.log(`    Chunk ${i + 1}/${numChunks}: SKIPPED (ffmpeg extraction failed)`);
      continue;
    }

    // Transcribe
    console.log(`    Chunk ${i + 1}/${numChunks}: transcribing...`);
    try {
      const result = await transcribeChunk(chunkPath);

      // Offset timestamps to absolute position in the stream
      const offsetWords = result.words.map((w) => ({
        ...w,
        start: w.start + startSec,
        end: w.end + startSec,
      }));

      // Cache chunk transcript
      writeFileSync(chunkTranscriptPath, JSON.stringify({ text: result.text, words: offsetWords }));

      allWords.push(...offsetWords);
      fullText += (fullText ? " " : "") + result.text;
    } catch (err) {
      console.log(`    Chunk ${i + 1}/${numChunks}: SKIPPED (transcription failed: ${(err as Error).message?.slice(0, 80)})`);
      // Cache empty chunk so we don't retry
      writeFileSync(chunkTranscriptPath, JSON.stringify({ text: "", words: [] }));
      continue;
    }

    console.log(`    Chunk ${i + 1}/${numChunks}: ${result.words.length} words`);
  }

  // Save stitched transcript
  const stitched = {
    stream: stream.name,
    room: stream.room,
    day: stream.day,
    uri: stream.uri,
    durationSeconds: duration,
    text: fullText,
    words: allWords,
    totalWords: allWords.length,
  };

  writeFileSync(resultPath, JSON.stringify(stitched, null, 2));
  console.log(`  DONE: ${stream.name} — ${allWords.length} words, saved to ${resultPath}`);
}

// --- Main ---

async function main() {
  mkdirSync(FULLDAY_DIR, { recursive: true });

  const target = process.argv[2]; // optional: filter by stream name
  const streams = target
    ? FULLDAY_STREAMS.filter((s) => s.name.toLowerCase().includes(target.toLowerCase()))
    : FULLDAY_STREAMS;

  console.log(`Processing ${streams.length} full-day stream(s)`);

  for (const stream of streams) {
    await processStream(stream);
  }

  console.log("\nAll streams processed.");
}

main().catch(console.error);
