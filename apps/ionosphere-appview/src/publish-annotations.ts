/**
 * Publish only annotations to the PDS. Use when other records are
 * already published but annotations hit a rate limit.
 */
import { PdsClient } from "./pds-client.js";
import { openDb } from "./db.js";

const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.test";
const BOT_PASSWORD = process.env.BOT_PASSWORD ?? "ionosphere-dev-password";

async function main() {
  const pds = new PdsClient(PDS_URL);
  await pds.login(BOT_HANDLE, BOT_PASSWORD);
  const did = pds.getDid();
  const db = openDb();

  const annotations = db.prepare("SELECT * FROM annotations").all() as any[];
  console.log(`Publishing ${annotations.length} annotations...`);
  let count = 0;
  for (const ann of annotations) {
    const talkUri = ann.talk_uri
      ? ann.talk_uri.replace(/^at:\/\/[^/]+/, `at://${did}`)
      : null;
    const transcriptUri = ann.transcript_uri.replace(/^at:\/\/[^/]+/, `at://${did}`);
    const conceptUri = ann.concept_uri.replace(/^at:\/\/[^/]+/, `at://${did}`);
    await pds.putRecord("tv.ionosphere.annotation", ann.rkey, {
      $type: "tv.ionosphere.annotation",
      transcriptUri,
      ...(talkUri && { talkUri }),
      conceptUri,
      byteStart: ann.byte_start,
      byteEnd: ann.byte_end,
      ...(ann.text && { text: ann.text }),
    });
    count++;
    if (count % 100 === 0) console.log(`  ${count}/${annotations.length}`);
  }
  console.log(`Done: ${count} annotations published`);
  db.close();
}

main().catch(console.error);
