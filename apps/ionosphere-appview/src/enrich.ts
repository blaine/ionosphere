/**
 * LLM-assisted semantic enrichment of talk transcripts.
 *
 * Extracts: concepts, speaker mentions, talk cross-references, external links.
 * Outputs annotation data that gets stored as concept records and facets on the document.
 *
 * Usage: OPENAI_API_KEY=... npx tsx src/enrich.ts <rkey>
 */
import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { openDb } from "./db.js";

// Read API key from .env file if present
import path from "node:path";
const envPath = path.resolve(import.meta.dirname, "../.env");
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^=]+)=(.+)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
} catch {}

const client = new OpenAI();

interface ConceptMention {
  name: string;
  aliases?: string[];
  description?: string;
  wikidataId?: string;
  url?: string;
  mentions: Array<{ text: string; context: string }>;
}

interface SpeakerMention {
  name: string;
  handle?: string;
  mentions: Array<{ text: string; context: string }>;
}

interface TalkCrossRef {
  targetRkey: string;
  targetTitle: string;
  context: string;
}

interface LinkMention {
  url: string;
  title?: string;
  context: string;
}

interface EnrichmentResult {
  concepts: ConceptMention[];
  speakerMentions: SpeakerMention[];
  crossRefs: TalkCrossRef[];
  links: LinkMention[];
}

function buildTalkIndex(): string {
  const db = openDb();
  const talks = db
    .prepare("SELECT rkey, title FROM talks ORDER BY starts_at ASC")
    .all() as Array<{ rkey: string; title: string }>;
  db.close();
  return talks.map((t) => `${t.rkey}: ${t.title}`).join("\n");
}

function buildSpeakerIndex(): string {
  const db = openDb();
  const speakers = db
    .prepare("SELECT rkey, name, handle FROM speakers ORDER BY name ASC")
    .all() as Array<{ rkey: string; name: string; handle: string | null }>;
  db.close();
  return speakers
    .map((s) => `${s.name}${s.handle ? ` (@${s.handle})` : ""}`)
    .join("\n");
}

async function enrichTranscript(
  title: string,
  speaker: string,
  transcript: string,
  talkIndex: string,
  speakerIndex: string
): Promise<EnrichmentResult> {
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.1,
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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function main() {
  const rkey = process.argv[2];
  if (!rkey) {
    console.error("Usage: OPENAI_API_KEY=... npx tsx src/enrich.ts <rkey>");
    process.exit(1);
  }

  const db = openDb();
  const talk = db.prepare("SELECT * FROM talks WHERE rkey = ?").get(rkey) as any;
  if (!talk) {
    console.error(`Talk not found: ${rkey}`);
    process.exit(1);
  }

  // Get transcript text
  let transcript: string;
  if (talk.document) {
    const doc = JSON.parse(talk.document);
    transcript = doc.text;
  } else {
    console.error(`Talk has no transcript: ${rkey}`);
    process.exit(1);
  }

  const speakers = db
    .prepare(
      `SELECT s.name FROM speakers s
       JOIN talk_speakers ts ON s.uri = ts.speaker_uri
       WHERE ts.talk_uri = ?`
    )
    .all(talk.uri) as Array<{ name: string }>;
  const speakerNames = speakers.map((s) => s.name).join(", ");

  console.log(`Enriching: ${talk.title} (${speakerNames})`);
  console.log(`  Transcript: ${transcript.length} chars`);

  const talkIndex = buildTalkIndex();
  const speakerIndex = buildSpeakerIndex();

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

  // Store concepts
  const IONOSPHERE_DID = "did:plc:ionosphere-placeholder";
  const insertConcept = db.prepare(
    `INSERT OR IGNORE INTO concepts (uri, did, rkey, name, aliases, description, wikidata_id, url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertTalkConcept = db.prepare(
    `INSERT OR REPLACE INTO talk_concepts (talk_uri, concept_uri, mention_count)
     VALUES (?, ?, ?)`
  );

  for (const concept of result.concepts) {
    const conceptRkey = slugify(concept.name);
    const conceptUri = `at://${IONOSPHERE_DID}/tv.ionosphere.concept/${conceptRkey}`;

    insertConcept.run(
      conceptUri,
      IONOSPHERE_DID,
      conceptRkey,
      concept.name,
      JSON.stringify(concept.aliases || []),
      concept.description || null,
      concept.wikidataId || null,
      concept.url || null
    );

    insertTalkConcept.run(talk.uri, conceptUri, concept.mentions.length);

    console.log(`  + concept: ${concept.name} (${concept.mentions.length} mentions)`);
  }

  // Store cross-references
  const insertCrossRef = db.prepare(
    `INSERT OR IGNORE INTO talk_crossrefs (from_talk_uri, to_talk_uri)
     VALUES (?, ?)`
  );
  for (const xref of result.crossRefs) {
    const targetTalk = db
      .prepare("SELECT uri FROM talks WHERE rkey = ?")
      .get(xref.targetRkey) as any;
    if (targetTalk) {
      insertCrossRef.run(talk.uri, targetTalk.uri);
      console.log(`  + cross-ref: → ${xref.targetTitle}`);
    }
  }

  // Update pipeline status
  db.prepare(
    `UPDATE pipeline_status SET enriched = 1, updated_at = CURRENT_TIMESTAMP
     WHERE talk_uri = ?`
  ).run(talk.uri);

  // Print full results for review
  console.log("\n--- Full enrichment output ---");
  console.log(JSON.stringify(result, null, 2));

  db.close();
}

main().catch(console.error);
