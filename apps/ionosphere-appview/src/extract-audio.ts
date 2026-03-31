import { execSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const VOD_ENDPOINT =
  "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";
const AUDIO_DIR = path.resolve(import.meta.dirname, "../../data/audio");

// Whisper API limit is 25MB. Use mp3 at 64kbps mono for ~480KB/min.
// A 60-minute talk = ~29MB in mp3 — still over limit for very long talks.
// For talks > 20 min, use 32kbps (speech doesn't need more) = ~240KB/min.
// 60 min @ 32kbps = ~14MB, 150 min @ 32kbps = ~36MB (needs splitting).
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB

export function buildPlaylistUrl(videoUri: string): string {
  return `${VOD_ENDPOINT}?uri=${encodeURIComponent(videoUri)}`;
}

export function extractAudio(videoUri: string, talkRkey: string): string {
  mkdirSync(AUDIO_DIR, { recursive: true });

  const outputPath = path.join(AUDIO_DIR, `${talkRkey}.mp3`);
  if (existsSync(outputPath)) {
    console.log(`  Audio already exists: ${talkRkey}.mp3`);
    return outputPath;
  }

  // Also check for old .wav files from previous runs
  const wavPath = path.join(AUDIO_DIR, `${talkRkey}.wav`);
  if (existsSync(wavPath)) {
    // Convert existing wav to mp3
    console.log(`  Converting existing WAV to MP3: ${talkRkey}...`);
    execSync(
      `ffmpeg -i "${wavPath}" -acodec libmp3lame -ar 16000 -ac 1 -b:a 32k "${outputPath}"`,
      { stdio: "inherit", timeout: 120_000 }
    );
    return outputPath;
  }

  const playlistUrl = buildPlaylistUrl(videoUri);
  console.log(`  Extracting audio for ${talkRkey}...`);

  // Extract as mono mp3 at 32kbps — good enough for speech, small files
  execSync(
    `ffmpeg -i "${playlistUrl}" -vn -acodec libmp3lame -ar 16000 -ac 1 -b:a 32k "${outputPath}"`,
    { stdio: "inherit", timeout: 600_000 }
  );

  // Check file size
  const size = statSync(outputPath).size;
  if (size > MAX_UPLOAD_BYTES) {
    console.log(
      `  WARNING: ${talkRkey}.mp3 is ${(size / 1024 / 1024).toFixed(1)}MB (over 25MB limit). Will need splitting for Whisper.`
    );
  }

  return outputPath;
}
