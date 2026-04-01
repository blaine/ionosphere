import { Hono } from "hono";
import { buildConcordance } from "./concordance.js";
import type Database from "better-sqlite3";
import {
  decodeToDocument,
  type Document,
  type DocumentFacet,
} from "@ionosphere/format/transcript-encoding";

/**
 * Overlay concept-ref facets onto a document from annotation records.
 * Reads pre-computed annotations from the DB — no text matching at serve time.
 */
function overlayAnnotations(
  doc: Document,
  annotations: Array<{
    concept_uri: string;
    byte_start: number;
    byte_end: number;
    text: string | null;
    concept_name: string;
    concept_rkey: string;
  }>
): Document {
  const facets: DocumentFacet[] = annotations.map((a) => {
    // Find nearest timestamp facet for temporal position
    let nearestTime = 0;
    for (const f of doc.facets) {
      const ts = f.features.find(
        (feat) => feat.$type === "tv.ionosphere.facet#timestamp"
      );
      if (ts && Math.abs(f.index.byteStart - a.byte_start) < 50) {
        nearestTime = ts.startTime;
        break;
      }
    }

    return {
      index: { byteStart: a.byte_start, byteEnd: a.byte_end },
      features: [
        {
          $type: "tv.ionosphere.facet#concept-ref",
          conceptUri: a.concept_uri,
          conceptRkey: a.concept_rkey,
          conceptName: a.concept_name,
          startTime: nearestTime,
        },
      ],
    };
  });

  return {
    text: doc.text,
    facets: [...doc.facets, ...facets],
  };
}

export function createRoutes(db: Database.Database): Hono {
  const app = new Hono();

  // CORS for client-side fetches from the Next.js frontend
  app.use("*", async (c, next) => {
    await next();
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type");
  });
  app.options("*", (c) => c.text("", 204));

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/talks", (c) => {
    const talks = db
      .prepare(
        `SELECT t.*, GROUP_CONCAT(s.name) as speaker_names
         FROM talks t
         LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
         LEFT JOIN speakers s ON ts.speaker_uri = s.uri
         GROUP BY t.uri
         ORDER BY t.starts_at ASC`
      )
      .all();
    return c.json({ talks });
  });

  app.get("/talks/:rkey", (c) => {
    const { rkey } = c.req.param();
    const talk = db
      .prepare("SELECT * FROM talks WHERE rkey = ?")
      .get(rkey);
    if (!talk) return c.json({ error: "not found" }, 404);

    const speakers = db
      .prepare(
        `SELECT s.* FROM speakers s
         JOIN talk_speakers ts ON s.uri = ts.speaker_uri
         WHERE ts.talk_uri = ?`
      )
      .all((talk as any).uri);

    // Get concepts linked to this talk via annotations
    const concepts = db
      .prepare(
        `SELECT DISTINCT c.* FROM concepts c
         JOIN talk_concepts tc ON c.uri = tc.concept_uri
         WHERE tc.talk_uri = ?
         ORDER BY c.name ASC`
      )
      .all((talk as any).uri);

    // Decode compact transcript into full document
    const transcript = db
      .prepare("SELECT * FROM transcripts WHERE talk_uri = ?")
      .get((talk as any).uri) as any;

    let document = null;
    if (transcript) {
      const compact = {
        text: transcript.text,
        startMs: transcript.start_ms,
        timings: JSON.parse(transcript.timings),
      };
      let doc = decodeToDocument(compact);

      // Overlay concept annotations from the DB
      const annotations = db
        .prepare(
          `SELECT a.*, c.name as concept_name, c.rkey as concept_rkey
           FROM annotations a
           JOIN concepts c ON c.uri = a.concept_uri
           WHERE a.transcript_uri = ?`
        )
        .all(transcript.uri) as any[];

      if (annotations.length > 0) {
        doc = overlayAnnotations(doc, annotations);
      }

      document = doc;
    }

    return c.json({
      talk: {
        ...(talk as any),
        document: document ? JSON.stringify(document) : null,
      },
      speakers,
      concepts,
    });
  });

  app.get("/speakers", (c) => {
    const speakers = db
      .prepare("SELECT * FROM speakers ORDER BY name ASC")
      .all();
    return c.json({ speakers });
  });

  app.get("/speakers/:rkey", (c) => {
    const { rkey } = c.req.param();
    const speaker = db
      .prepare("SELECT * FROM speakers WHERE rkey = ?")
      .get(rkey);
    if (!speaker) return c.json({ error: "not found" }, 404);

    const talks = db
      .prepare(
        `SELECT t.* FROM talks t
         JOIN talk_speakers ts ON t.uri = ts.talk_uri
         WHERE ts.speaker_uri = ?
         ORDER BY t.starts_at ASC`
      )
      .all((speaker as any).uri);

    return c.json({ speaker, talks });
  });

  app.get("/concepts", (c) => {
    const concepts = db
      .prepare("SELECT * FROM concepts ORDER BY name ASC")
      .all();
    return c.json({ concepts });
  });

  app.get("/concepts/:rkey", (c) => {
    const { rkey } = c.req.param();
    const concept = db
      .prepare("SELECT * FROM concepts WHERE rkey = ?")
      .get(rkey);
    if (!concept) return c.json({ error: "not found" }, 404);

    const talks = db
      .prepare(
        `SELECT t.* FROM talks t
         JOIN talk_concepts tc ON t.uri = tc.talk_uri
         WHERE tc.concept_uri = ?
         ORDER BY t.starts_at ASC`
      )
      .all((concept as any).uri);

    return c.json({ concept, talks });
  });

  app.get("/index", (c) => {
    const rows = db
      .prepare(
        `SELECT tr.text, tr.start_ms, tr.timings, t.rkey as talk_rkey, t.title as talk_title
         FROM transcripts tr
         JOIN talks t ON tr.talk_uri = t.uri
         ORDER BY t.starts_at ASC`
      )
      .all() as any[];

    const transcripts = rows.map((r: any) => ({
      talkRkey: r.talk_rkey,
      talkTitle: r.talk_title,
      text: r.text,
      startMs: r.start_ms,
      timings: JSON.parse(r.timings),
    }));

    const entries = buildConcordance(transcripts);
    return c.json({ entries });
  });

  return app;
}
