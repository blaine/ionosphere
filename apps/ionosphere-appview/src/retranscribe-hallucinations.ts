/**
 * Re-transcribe hallucination zones in conference full-day streams.
 *
 * Extracts audio for each hallucination zone, re-transcribes with Whisper
 * using diarization-aligned chunking, and splices results back into the
 * existing transcript-enriched.json.
 *
 * Usage:
 *   npx tsx src/retranscribe-hallucinations.ts \
 *     --stream-slug <slug> \
 *     --boundaries <path-to-v7-boundaries.json> \
 *     --diarization <path-to-diarization.json>
 *
 * Environment: OPENAI_API_KEY
 */
import "./env.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import OpenAI from "openai";
import type { HallucinationZone, DiarizationInput, TranscriptInput } from "./v7/types.js";

// ─── Stream config ────────────────────────────────────────────────────────────

const STREAMS: Record<string, { uri: string; dirName: string }> = {
  "great-hall-day-1": { uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadw52j22", dirName: "Great_Hall___Day_1" },
  "great-hall-day-2": { uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miighlz53o22", dirName: "Great_Hall___Day_2" },
  "room-2301-day-1": { uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadx2dj22", dirName: "Room_2301___Day_1" },
  "room-2301-day-2": { uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadxeqn22", dirName: "Room_2301___Day_2" },
  "performance-theatre-day-1": { uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwgvz22", dirName: "Performance_Theater___Day_1" },
  "performance-theatre-day-2": { uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwqgy22", dirName: "Performance_Theater___Day_2" },
  "atscience": { uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadvruo22", dirName: "ATScience" },
};

const VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";
const DATA_DIR = path.resolve(import.meta.dirname, "../data/fullday");

const MAX_CHUNK_SECS = 20 * 60; // 20 minutes
const SPEECH_GAP_THRESHOLD = 5; // seconds — gap between speech segments before we consider splitting

// ─── Audio extraction ─────────────────────────────────────────────────────────

function extractChunk(playlistUrl: string, startSec: number, durationSec: number, outputPath: string): void {
  console.log(`    Extracting: ${(startSec / 60).toFixed(1)}m - ${((startSec + durationSec) / 60).toFixed(1)}m`);
  execSync(
    `ffmpeg -ss ${startSec} -i "${playlistUrl}" -t ${durationSec} -vn -acodec libmp3lame -ar 16000 -ac 1 -b:a 32k "${outputPath}" -y`,
    { stdio: "pipe", timeout: 600_000 }
  );
}

// ─── Whisper transcription ────────────────────────────────────────────────────

async function transcribeChunk(audioPath: string): Promise<{ word: string; start: number; end: number }[]> {
  const client = new OpenAI();
  const response = await client.audio.transcriptions.create({
    model: "whisper-1",
    file: createReadStream(audioPath),
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
    language: "en",
    prompt: "ATmosphereConf 2026 conference talk.",
  });
  return (response.words ?? []).map(w => ({ word: w.word, start: w.start, end: w.end }));
}

// ─── Diarization-aligned chunking ────────────────────────────────────────────

interface TimeRange {
  startS: number;
  endS: number;
}

/**
 * Given a hallucination zone and diarization segments, compute the audio
 * chunks to extract and transcribe.
 *
 * - Finds diarization speech within the zone
 * - Groups into blocks (gap < SPEECH_GAP_THRESHOLD collapses to one block)
 * - Splits at gaps if total speech would exceed MAX_CHUNK_SECS
 */
function computeChunksForZone(zone: HallucinationZone, diarization: DiarizationInput): TimeRange[] {
  // Find all diarization segments that overlap with the zone
  const inZone = diarization.segments.filter(
    seg => seg.start < zone.endS && seg.end > zone.startS
  );

  if (inZone.length === 0) return [];

  // Clamp to zone boundaries
  const clamped = inZone.map(seg => ({
    startS: Math.max(seg.start, zone.startS),
    endS: Math.min(seg.end, zone.endS),
  }));

  // Group contiguous speech (gap < threshold) into blocks
  const blocks: TimeRange[] = [];
  let currentBlock: TimeRange = { ...clamped[0] };
  for (let i = 1; i < clamped.length; i++) {
    const gap = clamped[i].startS - currentBlock.endS;
    if (gap < SPEECH_GAP_THRESHOLD) {
      currentBlock.endS = clamped[i].endS;
    } else {
      blocks.push(currentBlock);
      currentBlock = { ...clamped[i] };
    }
  }
  blocks.push(currentBlock);

  // If total range fits in one chunk, return one range
  const totalDuration = blocks[blocks.length - 1].endS - blocks[0].startS;
  if (totalDuration <= MAX_CHUNK_SECS) {
    return [{ startS: blocks[0].startS, endS: blocks[blocks.length - 1].endS }];
  }

  // Otherwise, bin blocks into chunks of up to MAX_CHUNK_SECS
  const chunks: TimeRange[] = [];
  let chunkStart = blocks[0].startS;
  let chunkEnd = blocks[0].endS;

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.endS - chunkStart <= MAX_CHUNK_SECS) {
      chunkEnd = block.endS;
    } else {
      chunks.push({ startS: chunkStart, endS: chunkEnd });
      chunkStart = block.startS;
      chunkEnd = block.endS;
    }
  }
  chunks.push({ startS: chunkStart, endS: chunkEnd });
  return chunks;
}

// ─── Transcript splicing ──────────────────────────────────────────────────────

type TranscriptWord = { word: string; start: number; end: number; speaker?: string; confidence?: number };

interface EnrichedTranscript {
  stream: string;
  duration_seconds: number;
  words: TranscriptWord[];
  segments?: unknown[];
  total_words: number;
  total_segments?: number;
  [key: string]: unknown;
}

function spliceTranscript(
  transcriptPath: string,
  zones: HallucinationZone[],
  newWordsByZone: Map<number, TranscriptWord[]>
): { removedCount: number; addedCount: number } {
  const transcript: EnrichedTranscript = JSON.parse(readFileSync(transcriptPath, "utf-8"));

  // Back up if not already backed up
  const bakPath = transcriptPath + ".bak";
  if (!existsSync(bakPath)) {
    writeFileSync(bakPath, JSON.stringify(transcript, null, 2));
  }

  let removedCount = 0;
  let addedCount = 0;

  // Filter out hallucinated words and insert new ones, zone by zone
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const newWords = newWordsByZone.get(i) ?? [];

    const before = transcript.words.filter(w => w.end <= zone.startS);
    const after = transcript.words.filter(w => w.start >= zone.endS);
    const removed = transcript.words.filter(w => w.start < zone.endS && w.end > zone.startS);

    removedCount += removed.length;
    addedCount += newWords.length;

    transcript.words = [...before, ...newWords, ...after];
  }

  // Re-sort by start time (in case zones overlapped or new words are out of order)
  transcript.words.sort((a, b) => a.start - b.start);
  transcript.total_words = transcript.words.length;

  writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
  return { removedCount, addedCount };
}

// ─── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(): { streamSlug: string; boundariesPath: string; diarizationPath: string } {
  const args = process.argv.slice(2);
  let streamSlug = "";
  let boundariesPath = "";
  let diarizationPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream-slug" && args[i + 1]) {
      streamSlug = args[++i];
    } else if (args[i] === "--boundaries" && args[i + 1]) {
      boundariesPath = args[++i];
    } else if (args[i] === "--diarization" && args[i + 1]) {
      diarizationPath = args[++i];
    }
  }

  if (!streamSlug || !boundariesPath || !diarizationPath) {
    console.error(
      "Usage: npx tsx src/retranscribe-hallucinations.ts \\\n" +
      "  --stream-slug <slug> \\\n" +
      "  --boundaries <path-to-v7-boundaries.json> \\\n" +
      "  --diarization <path-to-diarization.json>"
    );
    process.exit(1);
  }

  return { streamSlug, boundariesPath, diarizationPath };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { streamSlug, boundariesPath, diarizationPath } = parseArgs();

  if (!process.env.OPENAI_API_KEY) {
    console.error("ERROR: OPENAI_API_KEY is not set");
    process.exit(1);
  }

  // Resolve stream config
  const streamConfig = STREAMS[streamSlug];
  if (!streamConfig) {
    console.error(`ERROR: Unknown stream slug "${streamSlug}". Known slugs: ${Object.keys(STREAMS).join(", ")}`);
    process.exit(1);
  }

  console.log(`=== Re-transcribing hallucination zones for ${streamSlug} ===`);

  // Load boundaries JSON
  const boundaries = JSON.parse(readFileSync(boundariesPath, "utf-8"));
  const hallucinationZones: HallucinationZone[] = boundaries.hallucinationZones ?? [];
  console.log(`  Loaded ${hallucinationZones.length} hallucination zones`);

  if (hallucinationZones.length === 0) {
    console.log("  No hallucination zones found. Nothing to do.");
    return;
  }

  // Load diarization
  const diarization: DiarizationInput = JSON.parse(readFileSync(diarizationPath, "utf-8"));

  // Resolve paths
  const streamDir = path.join(DATA_DIR, streamConfig.dirName);
  const transcriptPath = path.join(streamDir, "transcript-enriched.json");

  if (!existsSync(transcriptPath)) {
    console.error(`ERROR: transcript-enriched.json not found at ${transcriptPath}`);
    process.exit(1);
  }

  // Build playlist URL
  const playlistUrl = `${VOD_ENDPOINT}?uri=${encodeURIComponent(streamConfig.uri)}`;

  // Create temp chunk dir
  const chunkDir = path.join(streamDir, "retranscribe-chunks");
  mkdirSync(chunkDir, { recursive: true });

  // Process each hallucination zone
  const newWordsByZone = new Map<number, TranscriptWord[]>();
  let totalNewWords = 0;

  for (let zoneIdx = 0; zoneIdx < hallucinationZones.length; zoneIdx++) {
    const zone = hallucinationZones[zoneIdx];
    const zoneDurationMin = ((zone.endS - zone.startS) / 60).toFixed(1);
    console.log(
      `  Zone ${zoneIdx + 1}: ${(zone.startS / 60).toFixed(1)}m - ${(zone.endS / 60).toFixed(1)}m (${zoneDurationMin}m)`
    );

    // Compute diarization-aligned chunks
    const chunks = computeChunksForZone(zone, diarization);

    if (chunks.length === 0) {
      console.log(`    No speech in zone, skipping`);
      newWordsByZone.set(zoneIdx, []);
      continue;
    }

    // Report speech coverage
    const speechSegs = diarization.segments.filter(
      seg => seg.start < zone.endS && seg.end > zone.startS
    );
    const totalSpeechMin = (
      speechSegs.reduce((acc, seg) => acc + Math.min(seg.end, zone.endS) - Math.max(seg.start, zone.startS), 0) / 60
    ).toFixed(1);
    console.log(`    Diarization speech: ${speechSegs.length} segments, ${totalSpeechMin}m total`);
    console.log(
      `    Chunks: ${chunks.length} (${chunks.map(c => ((c.endS - c.startS) / 60).toFixed(1) + "m").join(", ")})`
    );

    // Extract and transcribe each chunk
    const zoneWords: TranscriptWord[] = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];
      const chunkDuration = chunk.endS - chunk.startS;
      const chunkPath = path.join(
        chunkDir,
        `zone-${String(zoneIdx + 1).padStart(2, "0")}-chunk-${String(chunkIdx + 1).padStart(2, "0")}.mp3`
      );

      // Extract audio
      console.log(`    Extracting audio...`);
      try {
        extractChunk(playlistUrl, chunk.startS, chunkDuration, chunkPath);
        console.log(`    done`);
      } catch (err) {
        console.log(`    FAILED to extract audio: ${(err as Error).message?.slice(0, 80)}`);
        continue;
      }

      // Transcribe
      console.log(`    Transcribing chunk ${chunkIdx + 1}/${chunks.length}...`);
      try {
        const words = await transcribeChunk(chunkPath);

        // Offset timestamps to absolute position in stream
        const absoluteWords: TranscriptWord[] = words.map(w => ({
          word: w.word,
          start: w.start + chunk.startS,
          end: w.end + chunk.startS,
        }));

        zoneWords.push(...absoluteWords);
        console.log(`    ${words.length} words`);
      } catch (err) {
        console.log(`    FAILED to transcribe: ${(err as Error).message?.slice(0, 80)}`);
      }
    }

    newWordsByZone.set(zoneIdx, zoneWords);
    totalNewWords += zoneWords.length;
  }

  // Splice into transcript
  console.log(`  Splicing ${totalNewWords.toLocaleString()} new words into transcript`);
  const { removedCount, addedCount } = spliceTranscript(transcriptPath, hallucinationZones, newWordsByZone);

  console.log(`  Removed ${removedCount.toLocaleString()} hallucinated words`);
  console.log(`  Wrote transcript-enriched.json (backup: .bak)`);
}

main().catch(console.error);
