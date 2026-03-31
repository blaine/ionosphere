import OpenAI from "openai";
import { createReadStream } from "node:fs";
import type { TranscriptResult, WordTimestamp } from "@ionosphere/format";

const client = new OpenAI();

/**
 * Transcribe audio using OpenAI's Whisper API.
 * Returns word-level timestamps in ionosphere's transcript format.
 *
 * Requires OPENAI_API_KEY environment variable.
 */
export async function openaiWhisperProvider(
  audioPath: string
): Promise<TranscriptResult> {
  const response = await client.audio.transcriptions.create({
    model: "whisper-1",
    file: createReadStream(audioPath),
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  });

  // Lens: OpenAI's word format → ionosphere WordTimestamp
  // OpenAI returns { word, start, end } — we add confidence (not provided, default 1.0)
  const words: WordTimestamp[] = (response.words ?? []).map((w) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    confidence: 1.0,
  }));

  return {
    text: response.text,
    words,
  };
}
