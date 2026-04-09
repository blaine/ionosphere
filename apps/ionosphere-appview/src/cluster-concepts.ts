/**
 * Cluster concepts into thematic groups using an LLM.
 *
 * Sends all concept names + descriptions to GPT-5-mini and asks it to
 * produce ~50-80 thematic clusters with labels. Writes the result to
 * a JSON file that the appview serves.
 *
 * Usage: npx tsx src/cluster-concepts.ts
 */
import "./env.js";
import OpenAI from "openai";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.test";

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
  throw new Error("OPENAI_API_KEY not found");
}

const llm = new OpenAI({ apiKey: loadApiKey() });

async function listAll(collection: string, repo: string): Promise<any[]> {
  const records: any[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ repo, collection, limit: "100" });
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

async function main() {
  // Resolve DID
  const handleRes = await fetch(
    `${PDS_URL}/xrpc/com.atproto.identity.resolveHandle?handle=${BOT_HANDLE}`
  );
  const { did } = (await handleRes.json()) as { did: string };
  console.log(`Resolved ${BOT_HANDLE} → ${did}`);

  // Fetch all concepts
  const conceptRecords = await listAll("tv.ionosphere.concept", did);
  console.log(`${conceptRecords.length} concepts`);

  // Build the concept list for the prompt
  const conceptList = conceptRecords.map((r) => {
    const v = r.value;
    const rkey = r.uri.split("/").pop();
    return {
      rkey,
      name: v.name,
      description: v.description || "",
      aliases: v.aliases || [],
    };
  });

  const conceptText = conceptList
    .map((c) => `${c.rkey}: ${c.name}${c.description ? ` — ${c.description}` : ""}`)
    .join("\n");

  console.log(`Sending ${conceptText.length} chars to LLM...`);

  const response = await llm.chat.completions.create({
    model: "gpt-5.4-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a research librarian organizing a conference knowledge base. You are given a list of concepts extracted from conference talk transcripts (ATmosphereConf 2026, a conference about the AT Protocol and decentralized social networking).

Your task: group these concepts into thematic clusters. Each cluster should have:
- A clear, concise label (1-3 words, like a library subject heading)
- A one-sentence description of what the cluster covers
- A list of concept rkeys that belong to this cluster

Guidelines:
- You MUST produce between 60 and 80 clusters. This is a hard requirement — not fewer than 60, not more than 80.
- Every concept must belong to exactly one cluster
- Clusters should be meaningful and useful for browsing — not too broad ("Technology") or too narrow ("Bluesky's Follow Button")
- Prefer clusters of 15-35 concepts. Very small clusters (1-3) should be merged. Very large clusters (50+) MUST be split.
- Include thematic clusters for: protocol design, identity/authentication, content moderation, social graph, media/video, developer tools, research/academia, governance/policy, specific projects/apps, community/culture, data/storage, federation/decentralization, privacy/security, UI/UX, natural metaphors/ecology, journalism/media, books/authors/scholarship, geographic/places, etc.

Return JSON:
{
  "clusters": [
    {
      "id": "slug-id",
      "label": "Cluster Label",
      "description": "One sentence describing this theme.",
      "conceptRkeys": ["concept-rkey-1", "concept-rkey-2", ...]
    }
  ]
}`,
      },
      {
        role: "user",
        content: conceptText,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("No response from LLM");

  const result = JSON.parse(content);
  const clusters = result.clusters;

  console.log(`\n${clusters.length} clusters generated:`);
  for (const c of clusters) {
    console.log(`  ${c.label} (${c.conceptRkeys.length} concepts)`);
  }

  // Validate: every concept assigned?
  const assignedRkeys = new Set<string>();
  for (const c of clusters) {
    for (const rkey of c.conceptRkeys) assignedRkeys.add(rkey);
  }
  const allRkeys = new Set(conceptList.map((c) => c.rkey));
  const unassigned = [...allRkeys].filter((r) => !assignedRkeys.has(r));
  if (unassigned.length > 0) {
    console.warn(`\n${unassigned.length} concepts not assigned to any cluster`);
  }

  // Write output
  const outputPath = path.resolve(import.meta.dirname, "../data/concept-clusters.json");
  writeFileSync(outputPath, JSON.stringify({ clusters, generatedAt: new Date().toISOString() }, null, 2));
  console.log(`\nWritten to ${outputPath}`);
}

main().catch(console.error);
