/**
 * LLM refinement pass for talk boundaries.
 *
 * Takes v6 boundary results + enriched transcript, extracts ~2 min windows
 * around each detected start, and asks gpt-5.4-mini to pinpoint the exact
 * moment the talk begins.
 *
 * For garbled zones (Whisper hallucinations), the LLM detects the garble
 * and we fall back to diarization-based speaker transition detection.
 *
 * Usage: npx tsx src/refine-boundaries-llm.ts <boundaries.json> <transcript.json> [diarization.json]
 */
import "./env.js";
import { readFileSync, writeFileSync } from "node:fs";
import OpenAI from "openai";

interface Word {
  word: string;
  start: number;
  end: number;
  speaker?: string;
}

interface DiarizationSegment {
  start: number;
  end: number;
  speaker: string;
}

function fmt(ts: number): string {
  const h = Math.floor(ts / 3600);
  const m = Math.floor((ts % 3600) / 60);
  const s = Math.floor(ts % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function extractWindow(
  words: Word[],
  centerSec: number,
  windowSec: number = 60,
): { text: string; words: Word[] } {
  const windowWords = words.filter(
    (w) => w.start >= centerSec - windowSec && w.start <= centerSec + windowSec,
  );

  const lines: string[] = [];
  for (let i = 0; i < windowWords.length; i++) {
    if (i % 10 === 0) {
      const ts = windowWords[i].start;
      const speaker = windowWords[i].speaker ? ` ${windowWords[i].speaker}` : "";
      lines.push(`\n[t=${Math.round(ts)}s ${fmt(ts)}${speaker}]`);
    }
    lines.push(windowWords[i].word);
  }

  return { text: lines.join(" ").trim(), words: windowWords };
}

/**
 * Ask the LLM to assess transcript quality and find the talk start.
 * Returns garbled=true if the transcript is unintelligible.
 */
async function assessAndRefine(
  client: OpenAI,
  talkTitle: string,
  speakerName: string,
  windowText: string,
  detectedTimestamp: number,
): Promise<{ timestamp: number; reasoning: string; garbled: boolean }> {
  const prompt = `You are analyzing a conference stream transcript to find the exact moment a talk begins.

TALK: "${talkTitle}" by ${speakerName}

The talk is estimated to start around t=${Math.round(detectedTimestamp)}s (${fmt(detectedTimestamp)}). Below is the transcript from about 1 minute before to 1 minute after that point.

Timestamps appear as [t=XXXs H:MM:SS SPEAKER_XX]. The t=XXXs value is seconds from the start of the stream — use this for your answer.

TRANSCRIPT:
${windowText}

FIRST: Assess the transcript quality. This is from an English-language conference, transcribed by Whisper. Whisper hallucinates on non-speech audio (music, ambient noise, applause). Common hallucination patterns:
- Same word or phrase repeated many times ("Thanks Thanks Thanks", "This is a test This is a test")
- Text in a non-English language (Welsh, German, etc.) appearing in an English conference
- Generic filler on loop ("Thank you for watching", "Please subscribe")

If the transcript is mostly hallucinated/garbled, set "garbled": true and do not attempt to find a talk start.

IF THE TEXT IS INTELLIGIBLE: Find the exact timestamp where this talk BEGINS. Look for:
- The speaker's first words (greeting, self-introduction, "thank you for the intro")
- NOT the MC introducing them (that's before the talk)
- NOT applause or transition chatter
Your answer MUST be a t= value from the transcript above. Do NOT invent timestamps.

Respond with ONLY a JSON object:
{"garbled": <boolean>, "timestamp_seconds": <integer from transcript or null if garbled>, "reasoning": "<brief explanation>"}`;

  const response = await client.chat.completions.create({
    model: "gpt-5.4-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0].message.content || "{}";
  const parsed = JSON.parse(content);
  return {
    timestamp: parsed.timestamp_seconds ?? detectedTimestamp,
    reasoning: parsed.reasoning ?? "",
    garbled: parsed.garbled ?? false,
  };
}

/**
 * Find the first sustained new speaker in diarization data after a timestamp.
 * "Sustained" means the speaker has multiple segments or long duration
 * within a short window, indicating they're actually presenting, not just
 * a brief interjection.
 */
function findSpeakerTransitionFromDiarization(
  diaSegments: DiarizationSegment[],
  afterTimestamp: number,
  searchWindowSec: number = 600,
): { timestamp: number; speaker: string; reasoning: string } | null {
  const endWindow = afterTimestamp + searchWindowSec;

  // Find speakers active before the timestamp (last 2 min)
  const recentSpeakers = new Set<string>();
  for (const seg of diaSegments) {
    if (seg.start >= afterTimestamp - 120 && seg.end <= afterTimestamp) {
      recentSpeakers.add(seg.speaker);
    }
  }

  // Scan forward for a new sustained speaker
  const candidates = diaSegments.filter(
    (s) => s.start >= afterTimestamp && s.start <= endWindow,
  );

  // Group consecutive segments by speaker, look for sustained runs
  for (let i = 0; i < candidates.length; i++) {
    const seg = candidates[i];

    // Look for a speaker with sustained presence (>30s total in next 2 min)
    const speakerSegs = candidates.filter(
      (s) => s.speaker === seg.speaker && s.start >= seg.start && s.start <= seg.start + 120,
    );
    const totalDur = speakerSegs.reduce((sum, s) => sum + (s.end - s.start), 0);

    if (totalDur >= 30 && !recentSpeakers.has(seg.speaker)) {
      return {
        timestamp: seg.start,
        speaker: seg.speaker,
        reasoning: `diarization: new sustained speaker ${seg.speaker} (${totalDur.toFixed(0)}s in 2min window)`,
      };
    }
  }

  return null;
}

/**
 * Verify that a detected talk start actually looks like a talk opening.
 * If not, scan forward in wider windows until we find one.
 */
async function verifyAndCorrectStart(
  client: OpenAI,
  talkTitle: string,
  speakerName: string,
  words: Word[],
  timestamp: number,
): Promise<{ timestamp: number; reasoning: string; adjusted: boolean }> {
  // Try increasingly wider windows forward from the detected point
  for (const forwardSec of [0, 60, 120, 180]) {
    const scanStart = timestamp + forwardSec;
    const windowWords = words.filter(
      (w) => w.start >= scanStart && w.start <= scanStart + 45,
    );
    if (windowWords.length < 5) continue;

    const lines: string[] = [];
    for (let i = 0; i < windowWords.length; i++) {
      if (i % 10 === 0) {
        const ts = windowWords[i].start;
        const speaker = windowWords[i].speaker ? ` ${windowWords[i].speaker}` : "";
        lines.push(`\n[t=${Math.round(ts)}s ${fmt(ts)}${speaker}]`);
      }
      lines.push(windowWords[i].word);
    }
    const text = lines.join(" ").trim();

    const prompt = `Is this speaker presenting to an audience, or is this casual/backstage conversation?

CONTEXT: We're looking for the start of a conference talk titled "${talkTitle}" by ${speakerName}.

TRANSCRIPT:
${text}

A speaker PRESENTING to an audience could start in many ways: a formal greeting, diving straight into their topic, telling a story, sharing background, saying "okay here we go" — the key is they're addressing the room, not having a private conversation.

Things that are NOT a talk starting:
- Backstage chatter ("is the audio working?", "good to see you", "I have to leave in the morning")
- MC banter between talks
- Tech setup / sound check
- Audience milling around

Is the speaker presenting to the audience in this excerpt?

Respond with ONLY a JSON object:
{"is_talk_opening": <boolean>, "talk_start_seconds": <t= value where presenting begins, or null>, "reasoning": "<brief explanation>"}`;

    const response = await client.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(response.choices[0].message.content || "{}");

    if (parsed.is_talk_opening) {
      const actualStart = parsed.talk_start_seconds ?? scanStart;
      return {
        timestamp: actualStart,
        reasoning: parsed.reasoning ?? "",
        adjusted: forwardSec > 0 || actualStart !== timestamp,
      };
    }
  }

  // None of the windows looked like a talk opening — keep original
  return { timestamp, reasoning: "no clear talk opening found in forward scan", adjusted: false };
}

async function main() {
  const boundariesPath = process.argv[2];
  const transcriptPath = process.argv[3];
  const diarizationPath = process.argv[4];

  if (!boundariesPath || !transcriptPath) {
    console.error("Usage: npx tsx src/refine-boundaries-llm.ts <boundaries.json> <transcript.json> [diarization.json]");
    process.exit(1);
  }

  const boundaries = JSON.parse(readFileSync(boundariesPath, "utf-8"));
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf-8"));
  const words: Word[] = transcript.words;

  let diaSegments: DiarizationSegment[] = [];
  if (diarizationPath) {
    const dia = JSON.parse(readFileSync(diarizationPath, "utf-8"));
    diaSegments = dia.segments;
    console.log(`Diarization loaded: ${diaSegments.length} segments\n`);
  }

  const client = new OpenAI();

  console.log(`Refining ${boundaries.results.length} boundaries with gpt-5.4-mini\n`);

  const refined = [];

  for (const result of boundaries.results) {
    const { title, startTimestamp, rkey } = result;
    const speakerName = result.speakerName || title;

    // Extract ~2 min window around detected start
    const window = extractWindow(words, startTimestamp, 60);

    if (window.words.length < 10) {
      console.log(`  ${title.slice(0, 45).padEnd(47)} ${fmt(startTimestamp)} → SKIP (too few words)`);
      refined.push(result);
      continue;
    }

    const { timestamp, reasoning, garbled } = await assessAndRefine(
      client,
      title,
      speakerName,
      window.text,
      startTimestamp,
    );

    if (garbled && diaSegments.length > 0) {
      // Garbled zone — fall back to diarization
      const diaResult = findSpeakerTransitionFromDiarization(diaSegments, startTimestamp);
      if (diaResult) {
        const delta = diaResult.timestamp - startTimestamp;
        console.log(`  ${title.slice(0, 45).padEnd(47)} ${fmt(startTimestamp)} → ${fmt(diaResult.timestamp)} (${delta >= 0 ? "+" : ""}${delta.toFixed(0)}s) GARBLED → ${diaResult.reasoning.slice(0, 40)}`);
        refined.push({
          ...result,
          startTimestamp: diaResult.timestamp,
          preRefinementTimestamp: startTimestamp,
          refinementMethod: "diarization-fallback",
          refinementReasoning: `LLM detected garbled text: ${reasoning}. ${diaResult.reasoning}`,
        });
      } else {
        console.log(`  ${title.slice(0, 45).padEnd(47)} ${fmt(startTimestamp)} → KEEP (garbled, no diarization match)`);
        refined.push({
          ...result,
          refinementMethod: "garbled-no-fallback",
          refinementReasoning: `LLM detected garbled text: ${reasoning}. No sustained new speaker found in diarization.`,
        });
      }
    } else if (garbled) {
      console.log(`  ${title.slice(0, 45).padEnd(47)} ${fmt(startTimestamp)} → KEEP (garbled, no diarization data)`);
      refined.push(result);
    } else {
      // LLM found a timestamp — now verify it looks like a talk opening
      const verified = await verifyAndCorrectStart(client, title, speakerName, words, timestamp);
      const finalTimestamp = verified.timestamp;
      const delta = finalTimestamp - startTimestamp;

      if (verified.adjusted) {
        console.log(`  ${title.slice(0, 45).padEnd(47)} ${fmt(startTimestamp)} → ${fmt(timestamp)} → ${fmt(finalTimestamp)} (${delta >= 0 ? "+" : ""}${delta.toFixed(0)}s) verified: ${verified.reasoning.slice(0, 40)}`);
      } else {
        console.log(`  ${title.slice(0, 45).padEnd(47)} ${fmt(startTimestamp)} → ${fmt(finalTimestamp)} (${delta >= 0 ? "+" : ""}${delta.toFixed(0)}s) ${reasoning.slice(0, 50)}`);
      }

      refined.push({
        ...result,
        startTimestamp: finalTimestamp,
        preRefinementTimestamp: startTimestamp,
        refinementMethod: verified.adjusted ? "llm+verified" : "llm",
        refinementReasoning: verified.adjusted
          ? `Initial: ${reasoning}. Verified: ${verified.reasoning}`
          : reasoning,
      });
    }
  }

  const outputPath = boundariesPath.replace(".json", "-refined.json");
  writeFileSync(
    outputPath,
    JSON.stringify({ stream: boundaries.stream, results: refined }, null, 2),
  );
  console.log(`\nSaved to ${outputPath}`);
}

main().catch(console.error);
