import { Hono } from "hono";
import { buildConcordance } from "./concordance.js";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
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

  app.get("/talks/:rkey/comments", (c) => {
    const { rkey } = c.req.param();
    const talk = db.prepare("SELECT uri FROM talks WHERE rkey = ?").get(rkey) as any;
    if (!talk) return c.json({ comments: [] });

    const transcript = db.prepare("SELECT uri FROM transcripts WHERE talk_uri = ?").get(talk.uri) as any;

    const subjectUris = [talk.uri];
    if (transcript) subjectUris.push(transcript.uri);

    const placeholders = subjectUris.map(() => "?").join(",");
    const comments = db.prepare(
      `SELECT * FROM comments WHERE subject_uri IN (${placeholders}) ORDER BY created_at ASC`
    ).all(...subjectUris);

    return c.json({ comments });
  });

  app.get("/comments", (c) => {
    const subject = c.req.query("subject");
    if (!subject) return c.json({ comments: [] });

    const comments = db.prepare(
      "SELECT * FROM comments WHERE subject_uri = ? ORDER BY created_at ASC"
    ).all(subject);

    return c.json({ comments });
  });

  app.get("/concepts/clusters", (c) => {
    try {
      const clustersPath = path.resolve(import.meta.dirname, "../data/concept-clusters.json");
      const data = JSON.parse(readFileSync(clustersPath, "utf-8"));

      // Load merge data for accurate cross-talk counts
      let mergeData: any = {};
      try {
        mergeData = JSON.parse(
          readFileSync(path.resolve(import.meta.dirname, "../data/concept-merges.json"), "utf-8")
        );
      } catch {}

      const rkeyToCanonical = mergeData.rkeyToCanonical || {};
      const mergedNames = mergeData.canonicalNames || {};
      const mergedTalkCounts = mergeData.mergedTalkCounts || {};
      const clusterCanonicalNames = data.canonicalNames || {};

      const enriched = data.clusters.map((cluster: any) => {
        const seen = new Set<string>();
        const concepts = cluster.conceptRkeys.map((rkey: string) => {
          // Resolve to canonical rkey if this was merged
          const canonicalRkey = rkeyToCanonical[rkey] || rkey;

          const concept = db
            .prepare("SELECT * FROM concepts WHERE rkey = ?")
            .get(canonicalRkey) as any;
          if (!concept) return null;

          // Use merged canonical name > cluster canonical name > raw name
          const displayName =
            mergedNames[canonicalRkey] ||
            clusterCanonicalNames[canonicalRkey] ||
            concept.name;

          // Deduplicate by canonical rkey within a cluster
          if (seen.has(canonicalRkey)) return null;
          seen.add(canonicalRkey);

          // Count distinct talks across all merged concept rkeys
          const allMergedRkeys = [canonicalRkey];
          for (const [srcRkey, canon] of Object.entries(rkeyToCanonical)) {
            if (canon === canonicalRkey) allMergedRkeys.push(srcRkey);
          }
          const mergedUris: string[] = [];
          for (const r of allMergedRkeys) {
            const row = db.prepare("SELECT uri FROM concepts WHERE rkey = ?").get(r) as any;
            if (row) mergedUris.push(row.uri);
          }
          const ph = mergedUris.map(() => "?").join(",");
          const talkCount = mergedUris.length > 0
            ? (db.prepare(`SELECT COUNT(DISTINCT talk_uri) as count FROM talk_concepts WHERE concept_uri IN (${ph})`).get(...mergedUris) as any)?.count ?? 0
            : 0;

          return {
            rkey: canonicalRkey,
            name: displayName,
            description: concept.description,
            talkCount,
          };
        }).filter(Boolean);

        // Sort concepts by talk count descending within each cluster
        concepts.sort((a: any, b: any) => b.talkCount - a.talkCount);

        return { id: cluster.id, label: cluster.label, description: cluster.description, concepts };
      });

      // Filter out empty clusters and sort by total talk coverage
      const nonEmpty = enriched.filter((c: any) => c.concepts.length > 0);
      nonEmpty.sort((a: any, b: any) => {
        const aTotal = a.concepts.reduce((s: number, c: any) => s + c.talkCount, 0);
        const bTotal = b.concepts.reduce((s: number, c: any) => s + c.talkCount, 0);
        return bTotal - aTotal;
      });

      return c.json({ clusters: nonEmpty });
    } catch {
      return c.json({ clusters: [] });
    }
  });

  app.get("/concepts/:rkey", (c) => {
    const { rkey } = c.req.param();
    const concept = db
      .prepare("SELECT * FROM concepts WHERE rkey = ?")
      .get(rkey);
    if (!concept) return c.json({ error: "not found" }, 404);

    // Find all rkeys that were merged into this canonical concept
    let mergeData: any = {};
    try {
      mergeData = JSON.parse(
        readFileSync(path.resolve(import.meta.dirname, "../data/concept-merges.json"), "utf-8")
      );
    } catch {}

    const rkeyToCanonical = mergeData.rkeyToCanonical || {};
    // Collect all rkeys that map to this canonical (including itself)
    const allRkeys = [rkey];
    for (const [srcRkey, canonical] of Object.entries(rkeyToCanonical)) {
      if (canonical === rkey) allRkeys.push(srcRkey);
    }

    // Get all concept URIs for these rkeys
    const conceptUris: string[] = [];
    for (const r of allRkeys) {
      const row = db.prepare("SELECT uri FROM concepts WHERE rkey = ?").get(r) as any;
      if (row) conceptUris.push(row.uri);
    }

    // Get talks for all merged concept URIs
    const placeholders = conceptUris.map(() => "?").join(",");
    const talks = conceptUris.length > 0
      ? db
          .prepare(
            `SELECT DISTINCT t.* FROM talks t
             JOIN talk_concepts tc ON t.uri = tc.talk_uri
             WHERE tc.concept_uri IN (${placeholders})
             ORDER BY t.starts_at ASC`
          )
          .all(...conceptUris)
      : [];

    return c.json({ concept, talks });
  });

  // Cache the concordance — NLP pipeline takes ~2.5 min, data is static
  let indexCache: { entries: any[]; builtAt: number } | null = null;

  app.get("/index", (c) => {
    // Serve from cache if available
    if (indexCache) {
      return c.json({ entries: indexCache.entries });
    }

    console.log("[index] Building concordance (this takes a couple minutes the first time)...");
    const start = Date.now();

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

    const conceptRows = db
      .prepare(
        `SELECT c.name, c.rkey, c.aliases,
                GROUP_CONCAT(DISTINCT tc.talk_uri) as talk_uris
         FROM concepts c
         LEFT JOIN talk_concepts tc ON c.uri = tc.concept_uri
         GROUP BY c.uri`
      )
      .all() as any[];

    const concepts = conceptRows.map((r: any) => ({
      name: r.name,
      rkey: r.rkey,
      aliases: r.aliases ? JSON.parse(r.aliases) : [],
      talkRkeys: r.talk_uris
        ? r.talk_uris.split(",").map((uri: string) => uri.split("/").pop())
        : [],
    }));

    const entries = buildConcordance(transcripts, concepts);
    indexCache = { entries, builtAt: Date.now() };
    console.log(`[index] Concordance built: ${entries.length} entries in ${((Date.now() - start) / 1000).toFixed(1)}s`);

    return c.json({ entries });
  });

  // Invalidate cache (call after data changes)
  app.post("/index/invalidate", (c) => {
    indexCache = null;
    return c.json({ ok: true });
  });

  return app;
}
