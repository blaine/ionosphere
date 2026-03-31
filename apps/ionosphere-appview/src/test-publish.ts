/**
 * Quick test: publish a record to PDS and verify the appview indexes it via Jetstream.
 */
import { PdsClient } from "./pds-client.js";

const pds = new PdsClient("http://localhost:2690");
await pds.login("ionosphere.test", "ionosphere-dev-password");
console.log("DID:", pds.getDid());

// Write a test speaker
const uri = await pds.putRecord("tv.ionosphere.speaker", "test-speaker", {
  $type: "tv.ionosphere.speaker",
  name: "Test Speaker",
  handle: "test.bsky.social",
});
console.log("Published speaker:", uri);

// Write a test event
const eventUri = await pds.putRecord("tv.ionosphere.event", "test-event", {
  $type: "tv.ionosphere.event",
  name: "Test Conference",
  startsAt: "2026-03-28T00:00:00Z",
  endsAt: "2026-03-29T23:59:59Z",
});
console.log("Published event:", eventUri);

// Write a test concept
const conceptUri = await pds.putRecord("tv.ionosphere.concept", "test-concept", {
  $type: "tv.ionosphere.concept",
  name: "Test Concept",
  description: "A test concept for verifying Jetstream indexing.",
});
console.log("Published concept:", conceptUri);

console.log("\nWaiting 2s for Jetstream to deliver...");
await new Promise((r) => setTimeout(r, 2000));

// Check if appview indexed it
const res = await fetch("http://localhost:9401/speakers");
const data = await res.json();
console.log(`\nAppview speakers: ${data.speakers.length}`);
for (const s of data.speakers) {
  console.log(`  ${s.name} (@${s.handle})`);
}

const cRes = await fetch("http://localhost:9401/concepts");
const cData = await cRes.json();
console.log(`Appview concepts: ${cData.concepts.length}`);
for (const c of cData.concepts) {
  console.log(`  ${c.name}: ${c.description}`);
}
