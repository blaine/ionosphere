/**
 * Publish full-day stream records to the PDS.
 *
 * Publishes three record types per stream:
 * - tv.ionosphere.stream — stream metadata (room, day, VOD URI, duration)
 * - tv.ionosphere.streamTranscript — compact encoded transcript (text + timings)
 * - tv.ionosphere.diarization — speaker diarization segments
 *
 * Usage: BOT_PASSWORD=... npx tsx src/publish-streams.ts
 */
import { PdsClient } from "./pds-client.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const PDS_URL = process.env.PDS_URL ?? "https://jellybaby.us-east.host.bsky.network";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.tv";
const BOT_PASSWORD = process.env.BOT_PASSWORD;

if (!BOT_PASSWORD) {
  console.error("Need BOT_PASSWORD env var");
  process.exit(1);
}

const DATA_DIR = path.resolve(import.meta.dirname, "../data/fullday");

const STREAMS = [
  { slug: "great-hall-day-1", name: "Great Hall - Saturday", room: "Great Hall South", dayLabel: "Saturday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadw52j22", dirName: "Great_Hall___Day_1", durationSeconds: 28433 },
  { slug: "great-hall-day-2", name: "Great Hall - Sunday", room: "Great Hall South", dayLabel: "Sunday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miighlz53o22", dirName: "Great_Hall___Day_2", durationSeconds: 28433 },
  { slug: "room-2301-day-1", name: "Room 2301 - Saturday", room: "Room 2301", dayLabel: "Saturday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadx2dj22", dirName: "Room_2301___Day_1", durationSeconds: 27400 },
  { slug: "room-2301-day-2", name: "Room 2301 - Sunday", room: "Room 2301", dayLabel: "Sunday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadxeqn22", dirName: "Room_2301___Day_2", durationSeconds: 27000 },
  { slug: "performance-theatre-day-1", name: "Performance Theatre - Saturday", room: "Performance Theatre", dayLabel: "Saturday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwgvz22", dirName: "Performance_Theater___Day_1", durationSeconds: 24500 },
  { slug: "performance-theatre-day-2", name: "Performance Theatre - Sunday", room: "Performance Theatre", dayLabel: "Sunday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadwqgy22", dirName: "Performance_Theater___Day_2", durationSeconds: 27300 },
  { slug: "atscience", name: "ATScience - Friday", room: "ATScience", dayLabel: "Friday", uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3miieadvruo22", dirName: "ATScience", durationSeconds: 29675 },
];

function compactEncode(words: Array<{ word: string; start: number; end: number }>): { text: string; startMs: number; timings: number[] } {
  if (words.length === 0) return { text: "", startMs: 0, timings: [] };

  const text = words.map(w => w.word).join(" ");
  const startMs = Math.round(words[0].start * 1000);
  const timings: number[] = [];
  let prevEnd = 0;

  for (const w of words) {
    const wStartMs = Math.round(w.start * 1000);
    const wEndMs = Math.round(w.end * 1000);
    timings.push(wStartMs - prevEnd); // gap before word
    timings.push(wEndMs - wStartMs);  // word duration
    prevEnd = wEndMs;
  }

  return { text, startMs, timings };
}

async function main() {
  const pds = new PdsClient(PDS_URL);
  await pds.login(BOT_HANDLE, BOT_PASSWORD);
  const did = pds.getDid();
  console.log(`Logged in as ${did}\n`);

  for (const stream of STREAMS) {
    console.log(`=== ${stream.name} ===`);
    const streamUri = `at://${did}/tv.ionosphere.stream/${stream.slug}`;

    // 1. Publish stream record
    await pds.putRecord("tv.ionosphere.stream", stream.slug, {
      $type: "tv.ionosphere.stream",
      name: stream.name,
      slug: stream.slug,
      room: stream.room,
      dayLabel: stream.dayLabel,
      streamVideoUri: stream.uri,
      durationSeconds: stream.durationSeconds,
    });
    console.log(`  stream: ${stream.slug}`);

    // 2. Publish transcript in chunks (AT Protocol has ~500KB request body limit)
    const txPath = path.join(DATA_DIR, stream.dirName, "transcript-enriched.json");
    if (existsSync(txPath)) {
      const data = JSON.parse(readFileSync(txPath, "utf-8"));
      const words = data.words || [];

      // Split into ~15-minute chunks to stay well under the limit
      const CHUNK_SECONDS = 15 * 60;
      let chunkStart = 0;
      let chunkIdx = 0;

      while (chunkStart < words.length) {
        const chunkStartTime = words[chunkStart].start;
        const chunkEndTime = chunkStartTime + CHUNK_SECONDS;
        let chunkEnd = chunkStart;
        while (chunkEnd < words.length && words[chunkEnd].start < chunkEndTime) chunkEnd++;

        const chunkWords = words.slice(chunkStart, chunkEnd);
        const compact = compactEncode(chunkWords);
        const rkey = `${stream.slug}-transcript-${String(chunkIdx).padStart(3, "0")}`;

        await pds.putRecord("tv.ionosphere.streamTranscript", rkey, {
          $type: "tv.ionosphere.streamTranscript",
          streamUri,
          chunkIndex: chunkIdx,
          text: compact.text,
          startMs: compact.startMs,
          timings: compact.timings,
        });

        chunkIdx++;
        chunkStart = chunkEnd;
      }
      console.log(`  transcript: ${words.length} words in ${chunkIdx} chunks`);
    } else {
      console.log(`  transcript: MISSING`);
    }

    // 3. Publish diarization (chunked to stay under record size limit)
    const diaPath = path.join(DATA_DIR, stream.dirName, "diarization.json");
    if (existsSync(diaPath)) {
      const data = JSON.parse(readFileSync(diaPath, "utf-8"));
      const segments = data.segments || [];
      const speakers = data.speakers || [];
      const CHUNK_SIZE = 1000;
      let chunkIdx = 0;

      try {
        for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
          const chunk = segments.slice(i, i + CHUNK_SIZE);
          // Convert float seconds to integer milliseconds (AT Protocol rejects floats)
          const intChunk = chunk.map((s: any) => ({
            startMs: Math.round(s.start * 1000),
            endMs: Math.round(s.end * 1000),
            speaker: s.speaker,
          }));
          const rkey = `${stream.slug}-diarization-${String(chunkIdx).padStart(3, "0")}`;
          await pds.putRecord("tv.ionosphere.diarization", rkey, {
            $type: "tv.ionosphere.diarization",
            streamUri,
            chunkIndex: chunkIdx,
            segments: intChunk,
            speakerCount: speakers.length,
          });
          chunkIdx++;
        }
        console.log(`  diarization: ${segments.length} segments in ${chunkIdx} chunks, ${speakers.length} speakers`);
      } catch (err: any) {
        console.log(`  diarization: FAILED (${err.error || err.message})`);
      }
    } else {
      console.log(`  diarization: MISSING`);
    }

    console.log();
  }

  console.log("Done — all streams published.");
}

main().catch(console.error);
