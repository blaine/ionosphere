#!/usr/bin/env node
/**
 * Transcribe individual talk VODs. Takes a JSON array of {rkey, video_uri} on stdin.
 * Outputs transcript results to ./results/<rkey>.json
 *
 * Usage: echo '[{"rkey":"abc","video_uri":"at://..."}]' | OPENAI_API_KEY=... node transcribe-vods-worker.mjs
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, createReadStream, statSync } from "node:fs";
import OpenAI from "openai";

const client = new OpenAI();
const VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";

mkdirSync("./audio", { recursive: true });
mkdirSync("./results", { recursive: true });

function playlistUrl(videoUri) {
  return `${VOD_ENDPOINT}?uri=${encodeURIComponent(videoUri)}`;
}

const MAX_SIZE = 24 * 1024 * 1024; // 24MB — leave margin below Whisper's 25MB limit

function extractAudio(videoUri, rkey) {
  const outputPath = `./audio/${rkey}.mp3`;
  if (existsSync(outputPath) && statSync(outputPath).size > 1000) {
    // Re-extract if over limit
    if (statSync(outputPath).size <= MAX_SIZE) return outputPath;
    console.log(`  Re-extracting at lower bitrate (over 24MB)...`);
  }

  const url = playlistUrl(videoUri);
  // Try 32kbps first, fall back to 16kbps if too large
  for (const bitrate of ["32k", "16k"]) {
    try {
      execSync(
        `ffmpeg -i "${url}" -vn -acodec libmp3lame -ar 16000 -ac 1 -b:a ${bitrate} "${outputPath}" -y 2>/dev/null`,
        { stdio: ["pipe", "pipe", "pipe"], timeout: 600_000, maxBuffer: 50 * 1024 * 1024 }
      );
      if (existsSync(outputPath) && statSync(outputPath).size <= MAX_SIZE) return outputPath;
      if (bitrate === "32k") console.log(`  32k too large (${(statSync(outputPath).size/1024/1024).toFixed(1)}MB), trying 16k...`);
    } catch (err) {
      console.log(`  Extract failed at ${bitrate}: ${err.message?.slice(0, 60)}`);
    }
  }

  return existsSync(outputPath) && statSync(outputPath).size > 100 && statSync(outputPath).size <= MAX_SIZE
    ? outputPath : null;
}

async function transcribe(audioPath) {
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

// Read talk list from stdin
const input = readFileSync("/dev/stdin", "utf-8");
const talks = JSON.parse(input);

console.log(`Worker starting: ${talks.length} talks`);
let done = 0, failed = 0;

for (const talk of talks) {
  const resultPath = `./results/${talk.rkey}.json`;
  if (existsSync(resultPath)) {
    console.log(`[${done + failed + 1}/${talks.length}] ${talk.rkey}: cached`);
    done++;
    continue;
  }

  console.log(`[${done + failed + 1}/${talks.length}] ${talk.rkey}: extracting...`);
  const audioPath = extractAudio(talk.video_uri, talk.rkey);
  if (!audioPath) {
    console.log(`  SKIPPED (no audio)`);
    failed++;
    continue;
  }

  try {
    console.log(`  transcribing...`);
    const result = await transcribe(audioPath);
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
    console.log(`  ${result.words.length} words`);
    done++;
  } catch (err) {
    console.log(`  FAILED: ${err.message?.slice(0, 80)}`);
    failed++;
  }
}

console.log(`\nDONE: ${done} transcribed, ${failed} failed`);
