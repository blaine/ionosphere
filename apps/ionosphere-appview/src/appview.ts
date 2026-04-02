import { serve } from "@hono/node-server";
import { openDb, migrate, getCursor, setCursor } from "./db.js";
import { createRoutes } from "./routes.js";
import { processEvent } from "./indexer.js";
import { JetstreamClient } from "./jetstream.js";
import { backfill } from "./backfill.js";
import { startPublicJetstream } from "./public-jetstream.js";

const PORT = Number(process.env.PORT ?? 3001);
const JETSTREAM_URL = process.env.JETSTREAM_URL ?? "ws://localhost:2580";
const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.test";

// ── Database ──────────────────────────────────────────────────────────────────

const db = openDb();
migrate(db);

// ── Backfill from PDS ─────────────────────────────────────────────────────────

async function init() {
  // Resolve the DID for the bot account
  try {
    const res = await fetch(
      `${PDS_URL}/xrpc/com.atproto.identity.resolveHandle?handle=${BOT_HANDLE}`
    );
    if (res.ok) {
      const data = await res.json();
      const did = data.did;
      console.log(`Resolved ${BOT_HANDLE} → ${did}`);
      await backfill(db, PDS_URL, did);
    } else {
      console.warn(`Could not resolve handle ${BOT_HANDLE}: ${res.status}`);
    }
  } catch (err) {
    console.warn("Backfill skipped:", (err as Error).message);
  }

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
  console.log("Public Jetstream: listening for tv.ionosphere.comment");
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const app = createRoutes(db);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Ionosphere appview running on http://localhost:${info.port}`);
  console.log(`PDS: ${PDS_URL} | Jetstream: ${JETSTREAM_URL}`);
});

// Run init async (backfill + jetstream) after server starts
init().catch((err) => console.error("Init failed:", err));
