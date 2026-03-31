import { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  decodeToDocument,
  type Document,
  type DocumentFacet,
} from "@ionosphere/format/transcript-encoding";

/**
 * Overlay concept-ref facets onto a document by finding concept names
 * and aliases in the transcript text. Each match gets a facet with
 * byte range and concept URI, plus the timestamp from the nearest
 * word-level timestamp facet.
 */
function overlayConceptFacets(
  doc: Document,
  concepts: Array<{ uri: string; rkey: string; name: string; aliases: string | null }>
): Document {
  if (concepts.length === 0) return doc;

  const encoder = new TextEncoder();
  const textLower = doc.text.toLowerCase();
  const conceptFacets: DocumentFacet[] = [];

  for (const concept of concepts) {
    // Build search terms: name + aliases
    const terms = [concept.name];
    if (concept.aliases) {
      try {
        const parsed = JSON.parse(concept.aliases);
        if (Array.isArray(parsed)) terms.push(...parsed);
      } catch {}
    }

    for (const term of terms) {
      const termLower = term.toLowerCase();
      let searchFrom = 0;

      while (true) {
        const idx = textLower.indexOf(termLower, searchFrom);
        if (idx === -1) break;

        // Verify word boundary (don't match "AT" inside "THAT")
        const before = idx > 0 ? doc.text[idx - 1] : " ";
        const after =
          idx + term.length < doc.text.length
            ? doc.text[idx + term.length]
            : " ";
        if (/\w/.test(before) || /\w/.test(after)) {
          searchFrom = idx + 1;
          continue;
        }

        const byteStart = encoder.encode(doc.text.slice(0, idx)).length;
        const byteEnd = encoder.encode(
          doc.text.slice(0, idx + term.length)
        ).length;

        // Find the timestamp of the nearest word facet to get temporal position
        let nearestTime = 0;
        for (const f of doc.facets) {
          const ts = f.features.find(
            (feat) => feat.$type === "tv.ionosphere.facet#timestamp"
          );
          if (ts && Math.abs(f.index.byteStart - byteStart) < 50) {
            nearestTime = ts.startTime;
            break;
          }
        }

        conceptFacets.push({
          index: { byteStart, byteEnd },
          features: [
            {
              $type: "tv.ionosphere.facet#concept-ref",
              conceptUri: concept.uri,
              conceptRkey: concept.rkey,
              conceptName: concept.name,
              startTime: nearestTime,
            },
          ],
        });

        searchFrom = idx + term.length;
      }
    }
  }

  return {
    text: doc.text,
    facets: [...doc.facets, ...conceptFacets],
  };
}

export function createRoutes(db: Database.Database): Hono {
  const app = new Hono();

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

    const concepts = db
      .prepare(
        `SELECT c.* FROM concepts c
         JOIN talk_concepts tc ON c.uri = tc.concept_uri
         WHERE tc.talk_uri = ?`
      )
      .all((talk as any).uri);

    // Decode compact transcript into full RelationalText document
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

      // Overlay concept-ref facets
      if (concepts.length > 0) {
        doc = overlayConceptFacets(doc, concepts as any[]);
      }

      document = doc;
    }

    return c.json({ talk: { ...(talk as any), document: document ? JSON.stringify(document) : null }, speakers, concepts });
  });

  app.get("/speakers", (c) => {
    const speakers = db.prepare("SELECT * FROM speakers ORDER BY name ASC").all();
    return c.json({ speakers });
  });

  app.get("/speakers/:rkey", (c) => {
    const { rkey } = c.req.param();
    const speaker = db.prepare("SELECT * FROM speakers WHERE rkey = ?").get(rkey);
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
    const concept = db.prepare("SELECT * FROM concepts WHERE rkey = ?").get(rkey);
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

  return app;
}
