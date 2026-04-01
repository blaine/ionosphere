/**
 * Assign unassigned concepts to existing clusters (or create new ones).
 * Run after cluster-concepts.ts to fill gaps.
 *
 * Usage: npx tsx src/cluster-assign-remaining.ts
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
  const conceptList = conceptRecords.map((r) => ({
    rkey: r.uri.split("/").pop()!,
    name: r.value.name,
    description: r.value.description || "",
  }));

  const clustersPath = path.resolve(import.meta.dirname, "../data/concept-clusters.json");
  const clusters = JSON.parse(readFileSync(clustersPath, "utf-8"));
  const assigned = new Set<string>();
  for (const c of clusters.clusters) {
    for (const rkey of c.conceptRkeys) assigned.add(rkey);
  }

  const unassigned = conceptList.filter((c) => !assigned.has(c.rkey));
  console.log(`${unassigned.length} unassigned concepts`);
  if (unassigned.length === 0) return;

  const existingLabels = clusters.clusters
    .map((c: any) => `${c.id}: ${c.label}`)
    .join("\n");
  const unassignedText = unassigned
    .map((c) => `${c.rkey}: ${c.name}${c.description ? " — " + c.description : ""}`)
    .join("\n");

  const llm = new OpenAI({ apiKey: loadApiKey() });
  const response = await llm.chat.completions.create({
    model: "gpt-5-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Assign each unassigned concept to the best-fitting existing cluster. If no existing cluster fits, create a new one. Every concept must be assigned.

Return JSON:
{
  "assignments": { "concept-rkey": "cluster-id", ... },
  "newClusters": [{ "id": "slug", "label": "Label", "description": "...", "conceptRkeys": ["rkey1", ...] }]
}`,
      },
      {
        role: "user",
        content: `Existing clusters:\n${existingLabels}\n\nUnassigned concepts:\n${unassignedText}`,
      },
    ],
  });

  const result = JSON.parse(response.choices[0]!.message.content!);

  const clusterMap = new Map(clusters.clusters.map((c: any) => [c.id, c]));
  let assignedCount = 0;
  for (const [rkey, clusterId] of Object.entries(result.assignments || {})) {
    const cluster = clusterMap.get(clusterId as string);
    if (cluster) {
      (cluster as any).conceptRkeys.push(rkey);
      assignedCount++;
    }
  }

  if (result.newClusters) {
    for (const nc of result.newClusters) {
      clusters.clusters.push(nc);
    }
    console.log(`${result.newClusters.length} new clusters created`);
  }

  console.log(`${assignedCount} assigned to existing clusters`);

  // Verify
  const allAssigned = new Set<string>();
  for (const c of clusters.clusters) {
    for (const rkey of c.conceptRkeys) allAssigned.add(rkey);
  }
  const stillMissing = conceptList.filter((c) => !allAssigned.has(c.rkey));
  console.log(`${stillMissing.length} still unassigned`);

  writeFileSync(clustersPath, JSON.stringify(clusters, null, 2));
  console.log("Updated concept-clusters.json");
}

main().catch(console.error);
