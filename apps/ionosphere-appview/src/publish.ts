/**
 * Publish ionosphere records to the PDS.
 *
 * Reads from a staging source (SQLite from ingest, or cached transcripts)
 * and writes AT Protocol records to the PDS. Does NOT touch the appview
 * database — the appview indexes from Jetstream.
 *
 * Usage: npx tsx src/publish.ts
 */
import { PdsClient, slugToRkey } from "./pds-client.js";
import { openDb } from "./db.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { encode, decodeToDocumentWithStructure, type NlpAnnotations } from "@ionosphere/format/transcript-encoding";
import { transcriptToLayersPub, nlpToAnnotationLayers } from "@ionosphere/format/layers-pub";

const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.test";
const BOT_PASSWORD = process.env.BOT_PASSWORD ?? "ionosphere-dev-password";

async function main() {
  const pds = new PdsClient(PDS_URL);
  await pds.login(BOT_HANDLE, BOT_PASSWORD);
  const did = pds.getDid();
  console.log(`Logged in as ${did}`);

  // 0. Publish lens records
  console.log("Publishing lens records...");
  const lensDir = path.resolve(import.meta.dirname, "../../../formats/tv.ionosphere/lenses");
  for (const file of ["schedule-to-talk.lens.json", "vod-to-talk.lens.json", "openai-whisper-to-transcript.lens.json", "transcript-to-document.lens.json", "transcript-to-expression.lens.json", "nlp-to-annotation-layers.lens.json", "layers-to-document.lens.json"]) {
    const lensPath = path.join(lensDir, file);
    if (!existsSync(lensPath)) continue;
    const spec = JSON.parse(readFileSync(lensPath, "utf-8"));
    const rkey = file.replace(".lens.json", "");
    await pds.putRecord("org.relationaltext.lens", rkey, {
      $type: "org.relationaltext.lens",
      source: spec.source,
      target: spec.target,
      version: 1,
      specJson: JSON.stringify(spec),
    });
    console.log("  Lens: " + spec.source + " -> " + spec.target);
  }

  // Read from the staging database (populated by ingest.ts)
  const db = openDb();

  // 1. Publish event
  const event = db.prepare("SELECT * FROM events LIMIT 1").get() as any;
  if (event) {
    await pds.putRecord("tv.ionosphere.event", event.rkey, {
      $type: "tv.ionosphere.event",
      name: event.name,
      description: event.description,
      location: event.location,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      tracks: JSON.parse(event.tracks || "[]"),
      scheduleRepo: event.schedule_repo,
      vodRepo: event.vod_repo,
    });
    console.log(`Event: ${event.name}`);
  }

  // 2. Publish speakers
  const speakers = db.prepare("SELECT * FROM speakers").all() as any[];
  console.log(`\nPublishing ${speakers.length} speakers...`);
  for (const speaker of speakers) {
    await pds.putRecord("tv.ionosphere.speaker", speaker.rkey, {
      $type: "tv.ionosphere.speaker",
      name: speaker.name,
      ...(speaker.handle && { handle: speaker.handle }),
      ...(speaker.speaker_did && { did: speaker.speaker_did }),
      ...(speaker.bio && { bio: speaker.bio }),
      ...(speaker.affiliations && {
        affiliations: JSON.parse(speaker.affiliations),
      }),
    });
  }
  console.log(`  Done.`);

  // 3. Publish talks
  const talks = db.prepare("SELECT * FROM talks").all() as any[];
  console.log(`\nPublishing ${talks.length} talks...`);

  const eventUri = event
    ? `at://${did}/tv.ionosphere.event/${event.rkey}`
    : undefined;

  const transcriptsDir = path.resolve(import.meta.dirname, "../../data/transcripts");
  const nlpDir = path.resolve(import.meta.dirname, "../../../pipeline/data/nlp");
  let docCount = 0;

  for (const talk of talks) {
    const speakerRkeys = db
      .prepare(
        `SELECT s.rkey FROM speakers s
         JOIN talk_speakers ts ON s.uri = ts.speaker_uri
         WHERE ts.talk_uri = ?`
      )
      .all(talk.uri) as any[];
    const speakerUris = speakerRkeys.map(
      (s: any) => `at://${did}/tv.ionosphere.speaker/${s.rkey}`
    );

    // Try to assemble a document with NLP structural annotations
    let document = undefined;
    const nlpPath = path.join(nlpDir, `${talk.rkey}.json`);
    const transcriptPath = path.join(transcriptsDir, `${talk.rkey}.json`);

    if (existsSync(nlpPath) && existsSync(transcriptPath)) {
      const nlpData = JSON.parse(readFileSync(nlpPath, "utf-8")) as {
        sentences: NlpAnnotations["sentences"];
        paragraphs: NlpAnnotations["paragraphs"];
        entities: NlpAnnotations["entities"];
        topicBreaks: NlpAnnotations["topicBreaks"];
      };
      const transcriptData = JSON.parse(readFileSync(transcriptPath, "utf-8"));
      const compact = encode(transcriptData);
      document = decodeToDocumentWithStructure(compact, {
        sentences: nlpData.sentences,
        paragraphs: nlpData.paragraphs,
        entities: nlpData.entities,
        topicBreaks: nlpData.topicBreaks,
      });
      docCount++;
    }

    await pds.putRecord("tv.ionosphere.talk", talk.rkey, {
      $type: "tv.ionosphere.talk",
      title: talk.title,
      ...(document && { document }),
      ...(eventUri && { eventUri }),
      ...(speakerUris.length > 0 && { speakerUris }),
      ...(talk.video_uri && { videoUri: talk.video_uri }),
      ...(talk.video_offset_ns && { videoOffsetNs: talk.video_offset_ns }),
      ...(talk.schedule_uri && { scheduleUri: talk.schedule_uri }),
      ...(talk.room && { room: talk.room }),
      ...(talk.category && { category: talk.category }),
      ...(talk.talk_type && { talkType: talk.talk_type }),
      ...(talk.starts_at && { startsAt: talk.starts_at }),
      ...(talk.ends_at && { endsAt: talk.ends_at }),
      ...(talk.duration && { duration: talk.duration }),
      ...(talk.description && { description: talk.description }),
    });
  }
  console.log(`  ${docCount} talks with assembled documents.`);
  console.log(`  Done.`);

  // 4. Publish transcripts from cached files
  let transcriptCount = 0;

  for (const talk of talks) {
    const cachedPath = path.join(transcriptsDir, `${talk.rkey}.json`);
    if (!existsSync(cachedPath)) continue;

    const transcript = JSON.parse(readFileSync(cachedPath, "utf-8"));
    const compact = encode(transcript);
    const talkUri = `at://${did}/tv.ionosphere.talk/${talk.rkey}`;

    await pds.putRecord("tv.ionosphere.transcript", `${talk.rkey}-transcript`, {
      $type: "tv.ionosphere.transcript",
      talkUri,
      text: compact.text,
      startMs: compact.startMs,
      timings: compact.timings,
    });
    transcriptCount++;
  }
  console.log(`\nPublished ${transcriptCount} transcripts.`);

  // 5. Publish layers.pub records
  console.log("\n=== Stage 6: layers.pub records ===");
  let layersCount = 0;

  for (const talk of talks) {
    const transcriptPath = path.join(transcriptsDir, `${talk.rkey}.json`);
    const nlpPath = path.join(nlpDir, `${talk.rkey}.json`);
    if (!existsSync(transcriptPath) || !existsSync(nlpPath)) continue;

    const transcriptData = JSON.parse(readFileSync(transcriptPath, "utf-8"));
    const nlpData = JSON.parse(readFileSync(nlpPath, "utf-8"));
    const compact = encode(transcriptData);

    const transcriptRecord = {
      $type: "tv.ionosphere.transcript" as const,
      text: compact.text,
      startMs: compact.startMs,
      timings: compact.timings,
      talkUri: `at://${did}/tv.ionosphere.talk/${talk.rkey}`,
    };

    const { expression, segmentation } = await transcriptToLayersPub(transcriptRecord, did, talk.rkey);
    const expressionUri = `at://${did}/pub.layers.expression.expression/${talk.rkey}-expression`;
    const layers = await nlpToAnnotationLayers(nlpData, did, talk.rkey, expressionUri);

    await Promise.all([
      pds.putRecord("pub.layers.expression.expression", `${talk.rkey}-expression`, expression),
      pds.putRecord("pub.layers.segmentation.segmentation", `${talk.rkey}-segmentation`, segmentation),
      pds.putRecord("pub.layers.annotation.annotationLayer", `${talk.rkey}-sentences`, layers.sentences),
      pds.putRecord("pub.layers.annotation.annotationLayer", `${talk.rkey}-paragraphs`, layers.paragraphs),
      pds.putRecord("pub.layers.annotation.annotationLayer", `${talk.rkey}-entities`, layers.entities),
      pds.putRecord("pub.layers.annotation.annotationLayer", `${talk.rkey}-topics`, layers.topics),
    ]);

    console.log(`  layers.pub: ${talk.rkey} (6 records)`);
    layersCount++;
  }
  console.log(`Published layers.pub records for ${layersCount} talks.`);

  console.log(`\nAll records published to ${PDS_URL}`);
  console.log(`DID: ${did}`);

  db.close();
}

main().catch(console.error);
