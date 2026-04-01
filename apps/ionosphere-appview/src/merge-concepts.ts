/**
 * Post-hoc concept merge: aggressively deduplicate the 815 raw concepts
 * at the annotation level, then rebuild clusters with accurate cross-talk
 * overlap counts.
 *
 * 1. Send all 815 concept names to LLM → get merge groups with canonical names
 * 2. Build a rkey→canonical mapping
 * 3. Recount talk associations using merged identities
 * 4. Rebuild clusters with the merged concepts
 *
 * Usage: npx tsx src/merge-concepts.ts
 */
import "./env.js";
import OpenAI from "openai";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb } from "./db.js";

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
  const db = openDb();

  // Get all raw concepts with their talk associations
  const concepts = db
    .prepare(
      `SELECT c.rkey, c.name, c.description,
              GROUP_CONCAT(DISTINCT t.rkey) as talk_rkeys
       FROM concepts c
       LEFT JOIN talk_concepts tc ON c.uri = tc.concept_uri
       LEFT JOIN talks t ON tc.talk_uri = t.uri
       GROUP BY c.uri
       ORDER BY c.name`
    )
    .all() as any[];

  console.log(`${concepts.length} raw concepts`);

  // Build the concept text for LLM
  const conceptText = concepts
    .map((c) => `${c.rkey}: ${c.name}${c.description ? " — " + c.description : ""}`)
    .join("\n");

  console.log(`Sending ${conceptText.length} chars to LLM for merge analysis...`);

  const llm = new OpenAI({ apiKey: loadApiKey() });
  const response = await llm.chat.completions.create({
    model: "gpt-5-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are merging duplicate concepts from a conference knowledge base. These concepts were extracted independently from ~90 talk transcripts, so the same real-world concept often appears with different names.

Your task: group ALL concepts that refer to the same thing, and pick one clean canonical name per group.

Rules:
- "AT Protocol", "AT Protocol (ATProto)", "AT Protocol (atproto / App Proto network / Atmosphere)" → ONE group, canonical name "AT Protocol"
- "App View", "App View (AppView)", "AppView", "AppView (application view)" → ONE group, canonical name "AppView"
- "Bluesky", "BlueSky", "Blue Sky", "Bluesky (social network)" → ONE group, canonical name "Bluesky"
- "Custom feeds", "Custom feeds (custom feed ecosystem)", "Custom feeds / feed algorithms" → ONE group
- Even if descriptions differ slightly, if they're clearly the same concept, MERGE
- Be AGGRESSIVE. This is a sensemaking tool. False merges are better than missed merges.
- Concepts that are truly unique (only one name) don't need to be in the output

Return JSON:
{
  "merges": [
    {
      "canonicalName": "AT Protocol",
      "rkeys": ["at-protocol", "at-protocol-atproto", "at-protocol-atproto-app-proto-network-atmosphere", ...]
    }
  ]
}

Only include groups with 2+ concepts. Singletons are fine as-is.`,
      },
      {
        role: "user",
        content: conceptText,
      },
    ],
  });

  const result = JSON.parse(response.choices[0]!.message.content!);
  const merges = result.merges || [];

  console.log(`${merges.length} merge groups`);
  const totalMerged = merges.reduce((s: number, m: any) => s + m.rkeys.length, 0);
  console.log(`${totalMerged} concepts being merged`);

  // Build rkey→canonical rkey mapping (first rkey in each group is canonical)
  const rkeyToCanonical = new Map<string, string>();
  const canonicalNames = new Map<string, string>();

  for (const merge of merges) {
    const canonicalRkey = merge.rkeys[0]; // first rkey is the canonical
    canonicalNames.set(canonicalRkey, merge.canonicalName);
    for (const rkey of merge.rkeys) {
      rkeyToCanonical.set(rkey, canonicalRkey);
    }
  }

  // Recount talk associations using merged identities
  // canonical rkey → set of talk rkeys
  const mergedTalkMap = new Map<string, Set<string>>();

  for (const concept of concepts) {
    const canonical = rkeyToCanonical.get(concept.rkey) || concept.rkey;
    if (!mergedTalkMap.has(canonical)) mergedTalkMap.set(canonical, new Set());
    const talks = (concept.talk_rkeys || "").split(",").filter(Boolean);
    for (const t of talks) mergedTalkMap.get(canonical)!.add(t);
  }

  // Count unique concepts after merge
  const uniqueCanonicals = new Set<string>();
  for (const concept of concepts) {
    uniqueCanonicals.add(rkeyToCanonical.get(concept.rkey) || concept.rkey);
  }

  console.log(`\n${uniqueCanonicals.size} unique concepts after merge (was ${concepts.length})`);

  // Show distribution of talk counts
  const talkCounts: number[] = [];
  for (const [rkey, talks] of mergedTalkMap) {
    if (uniqueCanonicals.has(rkey)) {
      talkCounts.push(talks.size);
    }
  }
  talkCounts.sort((a, b) => b - a);
  console.log(`Talk count distribution after merge:`);
  console.log(`  1 talk: ${talkCounts.filter((c) => c === 1).length}`);
  console.log(`  2-3 talks: ${talkCounts.filter((c) => c >= 2 && c <= 3).length}`);
  console.log(`  4-10 talks: ${talkCounts.filter((c) => c >= 4 && c <= 10).length}`);
  console.log(`  10+ talks: ${talkCounts.filter((c) => c > 10).length}`);

  console.log(`\nTop concepts by talk count:`);
  const ranked: Array<{ rkey: string; name: string; talks: number }> = [];
  for (const [rkey, talks] of mergedTalkMap) {
    if (uniqueCanonicals.has(rkey)) {
      ranked.push({
        rkey,
        name: canonicalNames.get(rkey) || concepts.find((c) => c.rkey === rkey)?.name || rkey,
        talks: talks.size,
      });
    }
  }
  ranked.sort((a, b) => b.talks - a.talks);
  for (const r of ranked.slice(0, 25)) {
    console.log(`  ${r.talks.toString().padStart(3)} talks: ${r.name}`);
  }

  // Save the merge mapping for use by the cluster rebuild
  const outputPath = path.resolve(import.meta.dirname, "../data/concept-merges.json");
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        merges,
        rkeyToCanonical: Object.fromEntries(rkeyToCanonical),
        canonicalNames: Object.fromEntries(canonicalNames),
        mergedTalkCounts: Object.fromEntries(
          [...mergedTalkMap].map(([rkey, talks]) => [rkey, talks.size])
        ),
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log(`\nMerge data written to ${outputPath}`);

  db.close();
}

main().catch(console.error);
