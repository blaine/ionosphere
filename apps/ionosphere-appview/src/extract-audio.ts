import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";
const AUDIO_DIR = path.resolve(import.meta.dirname, "../../data/audio");

export function buildPlaylistUrl(videoUri: string): string {
  return `${VOD_ENDPOINT}?uri=${encodeURIComponent(videoUri)}`;
}

export function extractAudio(videoUri: string, talkRkey: string): string {
  mkdirSync(AUDIO_DIR, { recursive: true });

  const outputPath = path.join(AUDIO_DIR, `${talkRkey}.wav`);
  if (existsSync(outputPath)) {
    console.log(`  Audio already exists: ${talkRkey}.wav`);
    return outputPath;
  }

  const playlistUrl = buildPlaylistUrl(videoUri);
  console.log(`  Extracting audio for ${talkRkey}...`);

  execSync(
    `ffmpeg -i "${playlistUrl}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`,
    { stdio: "inherit", timeout: 600_000 }
  );

  return outputPath;
}
