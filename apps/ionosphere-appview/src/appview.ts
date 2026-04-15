import { serve } from "@hono/node-server";
import { openDb, migrate, getCursor, setCursor } from "./db.js";
import { createRoutes } from "./routes.js";
import { processEvent, setBotDid } from "./indexer.js";
import { JetstreamClient } from "./jetstream.js";
import { backfill } from "./backfill.js";
import { startPublicJetstream } from "./public-jetstream.js";

const PORT = Number(process.env.PORT ?? 3001);
const JETSTREAM_URL = process.env.JETSTREAM_URL ?? "ws://localhost:2580";
const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.test";
const BOT_DID = process.env.BOT_DID ?? "";

// ── Database ──────────────────────────────────────────────────────────────────

const db = openDb();
migrate(db);

// ── Backfill from PDS ─────────────────────────────────────────────────────────

async function init() {
  // Resolve the DID for the bot account
  let did = BOT_DID;
  if (!did) {
    try {
      const res = await fetch(
        `${PDS_URL}/xrpc/com.atproto.identity.resolveHandle?handle=${BOT_HANDLE}`
      );
      if (res.ok) {
        const data = await res.json();
        did = data.did;
      } else {
        console.warn(`Could not resolve handle ${BOT_HANDLE}: ${res.status}`);
      }
    } catch (err) {
      console.warn("Handle resolution failed:", (err as Error).message);
    }
  }

  if (did) {
    setBotDid(did);
    console.log(`Backfilling from ${did}`);
    try {
      await backfill(db, PDS_URL, did);
    } catch (err) {
      console.warn("Backfill failed:", (err as Error).message);
    }
  } else {
    console.warn("No DID resolved, skipping backfill");
  }

  // Pre-warm the concordance cache in the background
  console.log("[init] Pre-warming concordance cache...");
  fetch(`http://localhost:${PORT}/xrpc/tv.ionosphere.getConcordance`)
    .then(() => console.log("[init] Concordance cache warm"))
    .catch(() => console.warn("[init] Concordance pre-warm failed (will build on first request)"));

  // ── Jetstream for live updates ──────────────────────────────────────────────

  const jetstream = new JetstreamClient({
    url: JETSTREAM_URL,
    getCursor: () => getCursor(db),
    setCursor: (cursor) => setCursor(db, cursor),
    onEvent: (event) => {
      try {
        processEvent(db, event);
      } catch (err) {
        console.error("Indexer error:", err);
      }
    },
    onError: (err) => console.error("Jetstream error:", err),
  });

  jetstream.start();

  const publicJetstream = startPublicJetstream(db);
  publicJetstream.start();
  console.log("Public Jetstream: listening for tv.ionosphere.* from all DIDs");
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const app = createRoutes(db);

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`Ionosphere appview running on http://localhost:${info.port}`);
  console.log(`PDS: ${PDS_URL} | Jetstream: ${JETSTREAM_URL}`);
});

// Run init async (backfill + jetstream) after server starts
init().catch((err) => console.error("Init failed:", err));
