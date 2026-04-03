/**
 * Apply detected talk boundaries to the database.
 *
 * Reads staging-boundaries.json and updates each talk's video_segments
 * with the full-day stream source. Also sets video_uri for talks that
 * don't have one yet (the 32 missing talks).
 *
 * Usage: npx tsx src/apply-boundaries.ts [--dry-run]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { openDb } from "./db.js";

interface StagingBoundary {
  rkey: string;
  title: string;
  startTimestamp: number;
  endTimestamp: number | null;
  confidence: string;
  streamUri: string;
  stream: string;
  playbackUrl: string;
  playbackOffsetSeconds: number;
  ionosphereUrl: string;
  talkAtUri: string;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const boundariesPath = path.resolve(import.meta.dirname, "../../data/staging-boundaries.json");
  const boundaries: StagingBoundary[] = JSON.parse(readFileSync(boundariesPath, "utf-8"));

  const db = openDb();

  let updated = 0;
  let newVideo = 0;
  let skipped = 0;

  for (const b of boundaries) {
    if (b.startTimestamp < 0) {
      skipped++;
      continue;
    }

    const talk = db.prepare("SELECT video_uri, video_offset_ns, video_segments FROM talks WHERE rkey = ?").get(b.rkey) as any;
    if (!talk) {
      console.log(`  SKIP: ${b.rkey} — not in database`);
      skipped++;
      continue;
    }

    // Build video sources array
    const existingSources: any[] = talk.video_segments ? JSON.parse(talk.video_segments) : [];

    // Add or update the fullday source
    const fulldaySource = {
      uri: b.streamUri,
      offsetNs: Math.round(b.startTimestamp * 1e9),
      type: "fullday",
      stream: b.stream,
      confidence: b.confidence,
      endOffsetNs: b.endTimestamp ? Math.round(b.endTimestamp * 1e9) : null,
    };

    // Replace existing fullday source for this stream, or add new
    const filtered = existingSources.filter(
      (s: any) => !(s.type === "fullday" && s.uri === b.streamUri)
    );
    filtered.push(fulldaySource);

    // If talk has an existing individual video, add it as a source too
    if (talk.video_uri && !filtered.some((s: any) => s.type === "individual")) {
      filtered.unshift({
        uri: talk.video_uri,
        offsetNs: talk.video_offset_ns || 0,
        type: "individual",
      });
    }

    const sourcesJson = JSON.stringify(filtered);

    // If the talk has NO video_uri at all, use the fullday stream as primary
    const needsPrimaryVideo = !talk.video_uri;

    if (dryRun) {
      console.log(`  ${b.rkey}: ${b.title.slice(0, 50)}`);
      console.log(`    sources: ${filtered.length} (${filtered.map((s: any) => s.type).join(", ")})`);
      if (needsPrimaryVideo) console.log(`    NEW PRIMARY: ${b.streamUri} @ ${b.startTimestamp}s`);
    } else {
      db.prepare("UPDATE talks SET video_segments = ? WHERE rkey = ?").run(sourcesJson, b.rkey);

      if (needsPrimaryVideo) {
        db.prepare("UPDATE talks SET video_uri = ?, video_offset_ns = ? WHERE rkey = ?")
          .run(b.streamUri, Math.round(b.startTimestamp * 1e9), b.rkey);
        newVideo++;
      }
    }

    updated++;
  }

  console.log(`\n${dryRun ? "DRY RUN — " : ""}Results:`);
  console.log(`  Updated: ${updated}`);
  console.log(`  New primary video: ${newVideo}`);
  console.log(`  Skipped: ${skipped}`);

  db.close();
}

main().catch(console.error);
