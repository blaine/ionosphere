#!/usr/bin/env node
/**
 * Self-contained full-day stream transcription for sprites.
 *
 * Usage: OPENAI_API_KEY=... node transcribe-sprite.mjs <stream-uri> <stream-name>
 *
 * Extracts audio in 20-min chunks, transcribes via Whisper, stitches results.
 * Output: ./transcript.json
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, createReadStream } from "node:fs";
import OpenAI from "openai";

const client = new OpenAI();
const VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";
const CHUNK_SECONDS = 20 * 60;

const streamUri = process.argv[2];
const streamName = process.argv[3] || "stream";

if (!streamUri) {
  console.error("Usage: node transcribe-sprite.mjs <stream-uri> <stream-name>");
  process.exit(1);
}

const playlistUrl = `${VOD_ENDPOINT}?uri=${encodeURIComponent(streamUri)}`;
const workDir = "./chunks";
mkdirSync(workDir, { recursive: true });

function getStreamDuration() {
  try {
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${playlistUrl}"`,
      { timeout: 120_000 }
    ).toString().trim();
    return parseFloat(out) || 0;
  } catch {
    return 0;
  }
}

function extractChunk(startSec, durationSec, outputPath) {
  if (existsSync(outputPath) && statSize(outputPath) > 1000) return;
  console.log(`  Extracting: ${startSec}s - ${startSec + durationSec}s`);
  try {
    execSync(
      `ffmpeg -ss ${startSec} -i "${playlistUrl}" -t ${durationSec} -vn -acodec libmp3lame -ar 16000 -ac 1 -b:a 32k "${outputPath}" -y`,
      { stdio: "pipe", timeout: 600_000 }
    );
  } catch (err) {
    console.log(`  Extraction failed: ${err.message?.slice(0, 80)}`);
    writeFileSync(outputPath, ""); // mark as attempted
  }
}

function statSize(path) {
  try { return require("fs").statSync(path).size; } catch { return 0; }
}

async function transcribeChunk(audioPath) {
  const response = await client.audio.transcriptions.create({
    model: "whisper-1",
    file: createReadStream(audioPath),
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  });
  return {
    text: response.text,
    words: (response.words ?? []).map(w => ({ word: w.word, start: w.start, end: w.end })),
  };
}

async function main() {
  console.log(`Transcribing: ${streamName}`);
  console.log(`Playlist: ${playlistUrl}`);

  const duration = getStreamDuration();
  if (duration <= 0) { console.error("Could not get stream duration"); process.exit(1); }
  console.log(`Duration: ${(duration / 3600).toFixed(1)} hours (${Math.round(duration)}s)`);

  const numChunks = Math.ceil(duration / CHUNK_SECONDS);
  console.log(`Chunks: ${numChunks}`);

  const allWords = [];
  let fullText = "";

  for (let i = 0; i < numChunks; i++) {
    const startSec = i * CHUNK_SECONDS;
    const chunkDuration = Math.min(CHUNK_SECONDS, duration - startSec);
    const chunkPath = `${workDir}/chunk-${String(i).padStart(3, "0")}.mp3`;
    const cachePath = `${workDir}/chunk-${String(i).padStart(3, "0")}.json`;

    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
      if (cached.words?.length > 0) {
        console.log(`  Chunk ${i + 1}/${numChunks}: cached (${cached.words.length} words)`);
        allWords.push(...cached.words);
        fullText += (fullText ? " " : "") + cached.text;
        continue;
      }
    }

    extractChunk(startSec, chunkDuration, chunkPath);
    if (!existsSync(chunkPath) || statSize(chunkPath) < 1000) {
      console.log(`  Chunk ${i + 1}/${numChunks}: SKIPPED (no audio)`);
      writeFileSync(cachePath, JSON.stringify({ text: "", words: [] }));
      continue;
    }

    try {
      console.log(`  Chunk ${i + 1}/${numChunks}: transcribing...`);
      const result = await transcribeChunk(chunkPath);
      const offsetWords = result.words.map(w => ({
        ...w, start: w.start + startSec, end: w.end + startSec,
      }));
      writeFileSync(cachePath, JSON.stringify({ text: result.text, words: offsetWords }));
      allWords.push(...offsetWords);
      fullText += (fullText ? " " : "") + result.text;
      console.log(`  Chunk ${i + 1}/${numChunks}: ${result.words.length} words`);
    } catch (err) {
      console.log(`  Chunk ${i + 1}/${numChunks}: FAILED (${err.message?.slice(0, 80)})`);
      writeFileSync(cachePath, JSON.stringify({ text: "", words: [] }));
    }
  }

  const output = {
    stream: streamName,
    durationSeconds: duration,
    words: allWords,
    totalWords: allWords.length,
  };
  writeFileSync("transcript.json", JSON.stringify(output, null, 2));
  console.log(`\nDONE: ${allWords.length} words → transcript.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
