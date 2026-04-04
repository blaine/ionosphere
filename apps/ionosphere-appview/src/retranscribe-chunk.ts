/**
 * Re-transcribe a specific chunk with prompt hints.
 *
 * Usage: npx tsx src/retranscribe-chunk.ts <chunk.mp3> <output.json> [prompt]
 */
import "./env.js";
import OpenAI from "openai";
import { createReadStream } from "node:fs";
import { writeFileSync } from "node:fs";

const client = new OpenAI();

async function main() {
  const mp3Path = process.argv[2];
  const outPath = process.argv[3];
  const prompt = process.argv[4] || "ATmosphereConf 2026 conference talk.";

  if (!mp3Path || !outPath) {
    console.error("Usage: npx tsx src/retranscribe-chunk.ts <chunk.mp3> <output.json> [prompt]");
    process.exit(1);
  }

  console.log(`Transcribing: ${mp3Path}`);
  console.log(`Prompt: ${prompt}`);

  const response = await client.audio.transcriptions.create({
    model: "whisper-1",
    file: createReadStream(mp3Path),
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
    language: "en",
    prompt,
  });

  const words = (response.words ?? []).map((w) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    confidence: 1.0,
  }));

  writeFileSync(outPath, JSON.stringify({ text: response.text, words }));
  console.log(`${words.length} words → ${outPath}`);
}

main().catch(console.error);
