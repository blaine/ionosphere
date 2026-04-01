/**
 * Deduplicate concepts and merge small clusters using LLM.
 *
 * Sends the full concept list to GPT-5-mini asking it to:
 * 1. Identify duplicate/near-duplicate concepts and pick a canonical name
 * 2. Merge clusters with <4 concepts into their nearest neighbor
 *
 * Updates concept-clusters.json with the merged result.
 *
 * Usage: npx tsx src/deduplicate-concepts.ts
 */
import "./env.js";
import OpenAI from "openai";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.test";

function loadApiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const envContent = readFileSync(path.resolve(import.meta.dirname, "../.env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^OPENAI_API_KEY=(.+)$/);
    if (match) return match[1].trim();
  }
  throw new Error("No key");
}

async function listAll(collection: string, repo: string): Promise<any[]> {
  const records: any[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ repo, collection, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.listRecords?${params}`);
    const data = await res.json();
    records.push(...data.records);
    cursor = data.cursor;
  } while (cursor);
  return records;
}

async function main() {
  const handleRes = await fetch(
    `${PDS_URL}/xrpc/com.atproto.identity.resolveHandle?handle=${BOT_HANDLE}`
  );
  const { did } = (await handleRes.json()) as { did: string };

  const conceptRecords = await listAll("tv.ionosphere.concept", did);
  const concepts = conceptRecords.map((r) => ({
    rkey: r.uri.split("/").pop()!,
    name: r.value.name,
    description: r.value.description || "",
  }));

  const clustersPath = path.resolve(import.meta.dirname, "../data/concept-clusters.json");
  const clustersData = JSON.parse(readFileSync(clustersPath, "utf-8"));

  // Build concept list with cluster membership
  const rkeyToCluster = new Map<string, string>();
  for (const cluster of clustersData.clusters) {
    for (const rkey of cluster.conceptRkeys) {
      rkeyToCluster.set(rkey, cluster.id);
    }
  }

  const conceptText = concepts
    .map((c) => `${c.rkey} [cluster: ${rkeyToCluster.get(c.rkey) || "none"}]: ${c.name}${c.description ? " — " + c.description : ""}`)
    .join("\n");

  const clusterText = clustersData.clusters
    .map((c: any) => `${c.id}: ${c.label} (${c.conceptRkeys.length} concepts)`)
    .join("\n");

  console.log(`${concepts.length} concepts, ${clustersData.clusters.length} clusters`);
  console.log("Sending to LLM for deduplication...");

  const llm = new OpenAI({ apiKey: loadApiKey() });
  const response = await llm.chat.completions.create({
    model: "gpt-5-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are deduplicating a concept index for a conference knowledge base (ATmosphereConf 2026).

Tasks:
1. **Deduplicate concepts**: Many concepts are near-duplicates (e.g., "AT Protocol", "AT Protocol (ATProto)", "AT Protocol (atproto / App Proto network / Atmosphere)" are all the same thing). For each group of duplicates, pick the best canonical name and list which rkeys should be merged into it (the canonical rkey absorbs the others).

2. **Merge small clusters**: Any cluster with fewer than 4 concepts after deduplication should be merged into the most thematically related larger cluster.

Return JSON:
{
  "merges": [
    {
      "canonicalRkey": "the-rkey-to-keep",
      "canonicalName": "Best Name For This Concept",
      "absorbedRkeys": ["duplicate-rkey-1", "duplicate-rkey-2", ...]
    }
  ],
  "clusterMerges": [
    {
      "fromClusterId": "small-cluster-id",
      "intoClusterId": "larger-cluster-id"
    }
  ]
}

Be aggressive with deduplication — if two concepts clearly refer to the same thing, merge them. The parenthetical variations are almost always duplicates.`,
      },
      {
        role: "user",
        content: `Concepts:\n${conceptText}\n\nClusters:\n${clusterText}`,
      },
    ],
  });

  const result = JSON.parse(response.choices[0]!.message.content!);

  // Apply concept merges to clusters
  const absorbedToCanonical = new Map<string, string>();
  for (const merge of result.merges || []) {
    for (const absorbed of merge.absorbedRkeys) {
      absorbedToCanonical.set(absorbed, merge.canonicalRkey);
    }
  }

  // Update cluster concept lists: replace absorbed rkeys with canonical, deduplicate
  for (const cluster of clustersData.clusters) {
    const updatedRkeys = new Set<string>();
    for (const rkey of cluster.conceptRkeys) {
      const canonical = absorbedToCanonical.get(rkey) || rkey;
      updatedRkeys.add(canonical);
    }
    cluster.conceptRkeys = [...updatedRkeys];
  }

  // Apply cluster merges
  for (const merge of result.clusterMerges || []) {
    const fromCluster = clustersData.clusters.find((c: any) => c.id === merge.fromClusterId);
    const intoCluster = clustersData.clusters.find((c: any) => c.id === merge.intoClusterId);
    if (fromCluster && intoCluster) {
      const existing = new Set(intoCluster.conceptRkeys);
      for (const rkey of fromCluster.conceptRkeys) {
        if (!existing.has(rkey)) {
          intoCluster.conceptRkeys.push(rkey);
          existing.add(rkey);
        }
      }
      fromCluster.conceptRkeys = []; // mark for removal
    }
  }

  // Remove empty clusters
  clustersData.clusters = clustersData.clusters.filter(
    (c: any) => c.conceptRkeys.length > 0
  );

  // Store the canonical name mappings for the appview to use
  const nameMappings: Record<string, string> = {};
  for (const merge of result.merges || []) {
    nameMappings[merge.canonicalRkey] = merge.canonicalName;
  }
  clustersData.canonicalNames = nameMappings;

  const totalConcepts = clustersData.clusters.reduce(
    (sum: number, c: any) => sum + c.conceptRkeys.length, 0
  );
  console.log(`\nAfter deduplication:`);
  console.log(`  ${clustersData.clusters.length} clusters (was ${clustersData.clusters.length + (result.clusterMerges?.length || 0)})`);
  console.log(`  ${totalConcepts} unique concept slots`);
  console.log(`  ${(result.merges || []).length} merge groups`);
  console.log(`  ${(result.clusterMerges || []).length} cluster merges`);

  writeFileSync(clustersPath, JSON.stringify(clustersData, null, 2));
  console.log(`\nWritten to ${clustersPath}`);
}

main().catch(console.error);
