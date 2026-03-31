/**
 * Batch enrichment of all transcribed talks.
 *
 * Finds all talks with transcripts but no annotations, then runs
 * enrichment for each one sequentially.
 *
 * Usage: npx tsx src/enrich-all.ts [--limit N] [--dry-run]
 */
import "./env.js";
import { execFileSync } from "node:child_process";
import path from "node:path";

const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.test";

const limitArg = process.argv.indexOf("--limit");
const limit =
  limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;
const dryRun = process.argv.includes("--dry-run");

async function listAll(collection: string, repo: string): Promise<any[]> {
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

async function main() {
  // Resolve DID
  const handleRes = await fetch(
    `${PDS_URL}/xrpc/com.atproto.identity.resolveHandle?handle=${BOT_HANDLE}`
  );
  if (!handleRes.ok) throw new Error("Failed to resolve handle");
  const { did } = (await handleRes.json()) as { did: string };
  console.log(`Resolved ${BOT_HANDLE} → ${did}`);

  // Get transcript rkeys
  const transcripts = await listAll("tv.ionosphere.transcript", did);
  const transcriptTalkRkeys = new Set(
    transcripts.map((r) => r.uri.split("/").pop()!.replace("-transcript", ""))
  );

  // Get already-enriched talk rkeys from annotations
  const annotations = await listAll("tv.ionosphere.annotation", did);
  const enrichedRkeys = new Set<string>();
  for (const a of annotations) {
    const talkUri = a.value?.talkUri;
    if (talkUri) enrichedRkeys.add(talkUri.split("/").pop()!);
  }

  const unenriched = [...transcriptTalkRkeys]
    .filter((rkey) => !enrichedRkeys.has(rkey))
    .sort();
  const batch = unenriched.slice(0, limit);

  console.log(`\nBatch enrichment:`);
  console.log(`  ${transcriptTalkRkeys.size} talks with transcripts`);
  console.log(`  ${enrichedRkeys.size} already enriched`);
  console.log(`  ${unenriched.length} need enrichment`);
  console.log(`  ${batch.length} in this batch`);

  if (dryRun) {
    console.log(`\nDry run — would enrich:`);
    for (const rkey of batch) console.log(`  ${rkey}`);
    return;
  }

  const enrichScript = path.resolve(import.meta.dirname, "enrich.ts");
  let completed = 0;
  let failed = 0;

  for (const rkey of batch) {
    const idx = completed + failed + 1;
    console.log(`\n[${idx}/${batch.length}] Enriching ${rkey}...`);
    try {
      execFileSync("npx", ["tsx", enrichScript, rkey], {
        cwd: path.resolve(import.meta.dirname, ".."),
        stdio: "inherit",
        timeout: 120_000, // 2 min per talk
      });
      completed++;
      console.log(`  ✓ ${rkey} (${completed} done, ${failed} failed)`);
    } catch (err: any) {
      failed++;
      console.error(`  ✗ ${rkey} failed: ${err.message}`);
    }
  }

  console.log(`\n--- Batch complete ---`);
  console.log(`  ${completed} enriched, ${failed} failed`);
}

main().catch(console.error);
