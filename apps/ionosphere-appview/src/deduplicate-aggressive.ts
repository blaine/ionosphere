/**
 * Aggressive concept deduplication. Sends the enriched cluster data
 * to GPT-5-mini and asks it to be ruthless about merging duplicates
 * and cleaning up names.
 *
 * Usage: npx tsx src/deduplicate-aggressive.ts
 */
import "./env.js";
import OpenAI from "openai";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function loadApiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const envContent = readFileSync(path.resolve(import.meta.dirname, "../.env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^OPENAI_API_KEY=(.+)$/);
    if (match) return match[1].trim();
  }
  throw new Error("No key");
}

async function main() {
  const clustersPath = path.resolve(import.meta.dirname, "../data/concept-clusters.json");
  const data = JSON.parse(readFileSync(clustersPath, "utf-8"));

  // Get current enriched data from appview
  const res = await fetch("http://localhost:9401/concepts/clusters");
  const current = await res.json();

  const totalBefore = current.clusters.reduce(
    (s: number, c: any) => s + c.concepts.length, 0
  );
  console.log(`${current.clusters.length} clusters, ${totalBefore} concepts before`);

  // Build cluster text
  const clusterText = current.clusters
    .map((c: any) => {
      const names = c.concepts.map((n: any) => n.name).join("; ");
      return `[${c.id}] ${c.label}: ${names}`;
    })
    .join("\n\n");

  const llm = new OpenAI({ apiKey: loadApiKey() });
  const response = await llm.chat.completions.create({
    model: "gpt-5-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are aggressively deduplicating a concept index for a conference sensemaking tool. The overall gestalt matters more than corner cases.

For EACH cluster, return a cleaned list of concept names. Rules:
- If two concepts are clearly the same thing, KEEP ONLY ONE with the cleanest, shortest name
- Strip unnecessary parentheticals. "Ozone (moderation infrastructure)" → "Ozone"
- "Custom feeds" and "Custom feeds (custom feed ecosystem)" → "Custom feeds"
- "AT Protocol (ATProto)" and "AT Protocol (a proto)" → "AT Protocol"
- Be AGGRESSIVE. When in doubt, merge.
- Also merge clusters that overlap significantly. Two clusters about very similar topics should become one.
- Target: ~40-50 clusters with ~400-500 total concepts (roughly half the current count)

Return JSON:
{
  "clusters": [
    {
      "id": "cluster-id",
      "label": "Clean Cluster Label",
      "description": "One sentence.",
      "keepNames": ["Clean Name 1", "Clean Name 2", ...]
    }
  ]
}

Only include KEPT names. Everything not listed is dropped.`,
      },
      {
        role: "user",
        content: clusterText,
      },
    ],
  });

  const result = JSON.parse(response.choices[0]!.message.content!);
  const totalKept = result.clusters.reduce(
    (s: number, c: any) => s + c.keepNames.length, 0
  );
  console.log(`LLM returned: ${result.clusters.length} clusters, ${totalKept} concepts kept`);

  // Map keepNames back to rkeys
  const nameToRkey = new Map<string, string>();
  for (const cluster of current.clusters) {
    for (const concept of cluster.concepts) {
      nameToRkey.set(concept.name.toLowerCase(), concept.rkey);
      const short = concept.name.split("(")[0].trim().toLowerCase();
      if (!nameToRkey.has(short)) nameToRkey.set(short, concept.rkey);
      // Also try without leading "the "
      const noThe = short.replace(/^the\s+/, "");
      if (!nameToRkey.has(noThe)) nameToRkey.set(noThe, concept.rkey);
    }
  }

  const newClusters = [];
  const newCanonicalNames: Record<string, string> = {};
  let unmappedCount = 0;

  for (const rc of result.clusters) {
    const rkeys: string[] = [];
    for (const name of rc.keepNames) {
      const rkey =
        nameToRkey.get(name.toLowerCase()) ||
        nameToRkey.get(name.split("(")[0].trim().toLowerCase());
      if (rkey) {
        rkeys.push(rkey);
        newCanonicalNames[rkey] = name;
      } else {
        unmappedCount++;
      }
    }
    if (rkeys.length > 0) {
      newClusters.push({
        id: rc.id,
        label: rc.label,
        description: rc.description,
        conceptRkeys: rkeys,
      });
    }
  }

  console.log(`${unmappedCount} concept names couldn't be mapped to rkeys`);
  console.log(`Final: ${newClusters.length} clusters, ${newClusters.reduce((s, c) => s + c.conceptRkeys.length, 0)} concepts`);

  data.clusters = newClusters;
  data.canonicalNames = newCanonicalNames;

  writeFileSync(clustersPath, JSON.stringify(data, null, 2));
  console.log(`Written to ${clustersPath}`);
}

main().catch(console.error);
