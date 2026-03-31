/**
 * LLM-assisted semantic enrichment of talk transcripts.
 *
 * Reads talk and transcript records from the PDS, extracts concepts
 * and cross-references via LLM, and writes concept records back to the PDS.
 *
 * Usage: npx tsx src/enrich.ts <rkey>
 */
import "./env.js";
import OpenAI from "openai";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PdsClient, slugToRkey } from "./pds-client.js";

const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.test";
const BOT_PASSWORD = process.env.BOT_PASSWORD ?? "ionosphere-dev-password";

function loadApiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const envContent = readFileSync(
      path.resolve(import.meta.dirname, "../.env"),
      "utf-8"
    );
    for (const line of envContent.split("\n")) {
      const match = line.match(/^OPENAI_API_KEY=(.+)$/);
      if (match) return match[1].trim();
    }
  } catch {}
  throw new Error("OPENAI_API_KEY not found in environment or .env file");
}

const llm = new OpenAI({ apiKey: loadApiKey() });

// --- XRPC helpers ---

async function listRecords(
  collection: string,
  repo: string
): Promise<any[]> {
  const records: any[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      repo,
      collection,
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(
      `${PDS_URL}/xrpc/com.atproto.repo.listRecords?${params}`
    );
    if (!res.ok) throw new Error(`listRecords failed: ${res.status}`);
    const data = await res.json();
    records.push(...data.records);
    cursor = data.cursor;
  } while (cursor);

  return records;
}

async function getRecord(
  collection: string,
  repo: string,
  rkey: string
): Promise<any> {
  const params = new URLSearchParams({ repo, collection, rkey });
  const res = await fetch(
    `${PDS_URL}/xrpc/com.atproto.repo.getRecord?${params}`
  );
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`getRecord failed: ${res.status}`);
  }
  return res.json();
}

// --- Types ---

interface EnrichmentResult {
  concepts: Array<{
    name: string;
    aliases?: string[];
    description?: string;
    wikidataId?: string;
    url?: string;
    mentions: Array<{ text: string; context: string }>;
  }>;
  speakerMentions: Array<{
    name: string;
    handle?: string;
    mentions: Array<{ text: string; context: string }>;
  }>;
  crossRefs: Array<{
    targetRkey: string;
    targetTitle: string;
    context: string;
  }>;
  links: Array<{
    url: string;
    title?: string;
    context: string;
  }>;
}

// --- LLM ---

async function enrichTranscript(
  title: string,
  speaker: string,
  transcript: string,
  talkIndex: string,
  speakerIndex: string
): Promise<EnrichmentResult> {
  const response = await llm.chat.completions.create({
    model: "gpt-5-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a research librarian and knowledge graph curator. You analyze conference talk transcripts and extract structured semantic annotations.

You will be given:
1. A talk title and speaker
2. The transcript text
3. An index of all talks at the conference
4. An index of all speakers at the conference

Extract the following, returning JSON:

{
  "concepts": [
    {
      "name": "canonical name for this concept",
      "aliases": ["alternative names used in the transcript"],
      "description": "one-sentence description",
      "wikidataId": "Q-identifier if you're confident (e.g. Q80071 for AT Protocol)",
      "url": "canonical URL if applicable (project homepage, spec URL, etc)",
      "mentions": [{"text": "exact quote from transcript", "context": "surrounding sentence for context"}]
    }
  ],
  "speakerMentions": [
    {
      "name": "person's name as mentioned",
      "handle": "AT Protocol handle if known from the speaker index",
      "mentions": [{"text": "exact quote", "context": "surrounding sentence"}]
    }
  ],
  "crossRefs": [
    {
      "targetRkey": "rkey from the talk index",
      "targetTitle": "title of the referenced talk",
      "context": "sentence where the cross-reference occurs"
    }
  ],
  "links": [
    {
      "url": "URL mentioned verbally",
      "title": "description of what it links to",
      "context": "sentence where mentioned"
    }
  ]
}

Guidelines:
- For concepts: focus on technical concepts, protocols, projects, organizations, standards, and tools. Not generic words.
- Include AT Protocol ecosystem concepts (PDS, DID, Jetstream, lexicons, etc.) when mentioned.
- For speaker mentions: only people actually named in the transcript, matched to the speaker index when possible.
- For cross-refs: only when the speaker explicitly references another talk or topic that matches a talk in the index.
- For links: URLs spoken aloud or clearly referenced (e.g., "check out our website at example.com").
- Be precise with quotes — use the exact text from the transcript.
- Be conservative — only include things you're confident about.`,
      },
      {
        role: "user",
        content: `# Talk: ${title}
# Speaker: ${speaker}

## Transcript
${transcript}

## All Conference Talks
${talkIndex}

## All Conference Speakers
${speakerIndex}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("No response from LLM");

  return JSON.parse(content);
}

// --- Main ---

async function main() {
  const rkey = process.argv[2];
  if (!rkey) {
    console.error("Usage: npx tsx src/enrich.ts <rkey>");
    process.exit(1);
  }

  // Connect to PDS
  const pds = new PdsClient(PDS_URL);
  await pds.login(BOT_HANDLE, BOT_PASSWORD);
  const did = pds.getDid();
  console.log(`Connected to PDS as ${did}`);

  // 1. Read talk record from PDS
  const talkRecord = await getRecord("tv.ionosphere.talk", did, rkey);
  if (!talkRecord) {
    console.error(`Talk not found on PDS: ${rkey}`);
    process.exit(1);
  }
  const talk = talkRecord.value;

  // 2. Read transcript record from PDS
  const transcriptRkey = `${rkey}-transcript`;
  const transcriptRecord = await getRecord(
    "tv.ionosphere.transcript",
    did,
    transcriptRkey
  );
  if (!transcriptRecord) {
    console.error(`Transcript not found on PDS: ${transcriptRkey}`);
    process.exit(1);
  }
  const transcript = transcriptRecord.value.text;

  // 3. Build context indexes from PDS records
  console.log("Building talk and speaker indexes from PDS...");
  const allTalks = await listRecords("tv.ionosphere.talk", did);
  const talkIndex = allTalks
    .map((r: any) => {
      const tRkey = r.uri.split("/").pop();
      return `${tRkey}: ${r.value.title}`;
    })
    .join("\n");

  const allSpeakers = await listRecords("tv.ionosphere.speaker", did);
  const speakerIndex = allSpeakers
    .map((r: any) => {
      const s = r.value;
      return `${s.name}${s.handle ? ` (@${s.handle})` : ""}`;
    })
    .join("\n");

  // Get speaker names for this talk
  const speakerNames = (talk.speakerUris || [])
    .map((uri: string) => {
      const sRkey = uri.split("/").pop();
      const speaker = allSpeakers.find(
        (r: any) => r.uri.split("/").pop() === sRkey
      );
      return speaker?.value.name || sRkey;
    })
    .join(", ");

  console.log(`Enriching: ${talk.title} (${speakerNames})`);
  console.log(`  Transcript: ${transcript.length} chars`);
  console.log(`  Context: ${allTalks.length} talks, ${allSpeakers.length} speakers`);

  // 4. Call LLM
  console.log("  Calling LLM...");
  const result = await enrichTranscript(
    talk.title,
    speakerNames,
    transcript,
    talkIndex,
    speakerIndex
  );

  console.log(`\nResults:`);
  console.log(`  Concepts: ${result.concepts.length}`);
  console.log(`  Speaker mentions: ${result.speakerMentions.length}`);
  console.log(`  Cross-refs: ${result.crossRefs.length}`);
  console.log(`  Links: ${result.links.length}`);

  // 5. Write concept records to PDS
  for (const concept of result.concepts) {
    const conceptRkey = slugToRkey(concept.name);
    await pds.putRecord("tv.ionosphere.concept", conceptRkey, {
      $type: "tv.ionosphere.concept",
      name: concept.name,
      ...(concept.aliases?.length && { aliases: concept.aliases }),
      ...(concept.description && { description: concept.description }),
      ...(concept.wikidataId && { wikidataId: concept.wikidataId }),
      ...(concept.url && { url: concept.url }),
    });
    console.log(`  + concept: ${concept.name} → at://${did}/tv.ionosphere.concept/${conceptRkey}`);
  }

  // Print full results for review
  console.log("\n--- Full enrichment output ---");
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
