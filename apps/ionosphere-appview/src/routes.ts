import { Hono } from "hono";
import { buildConcordance } from "./concordance.js";
import { getTracksIndex, getTrackData, STREAMS } from "./tracks.js";
import type Database from "better-sqlite3";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
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
    c.header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type");
  });
  app.options("*", (c) => c.text("", 204));

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/xrpc/tv.ionosphere.getTalks", (c) => {
    const talks = db
      .prepare(
        `SELECT t.*, GROUP_CONCAT(s.name) as speaker_names
         FROM talks t
         LEFT JOIN talk_speakers ts ON t.uri = ts.talk_uri
         LEFT JOIN speakers s ON ts.speaker_uri = s.uri
         GROUP BY t.uri
         ORDER BY t.starts_at ASC`
      )
      .all() as any[];

    // Batch-fetch comment stats for all talks
    const commentRows = db.prepare(
      `SELECT
         COALESCE(t.uri, c.subject_uri) as talk_uri,
         c.text
       FROM comments c
       LEFT JOIN transcripts tr ON c.subject_uri = tr.uri
       LEFT JOIN talks t ON t.uri = c.subject_uri OR t.uri = tr.talk_uri`
    ).all() as any[];

    // Aggregate per talk: classify emoji vs text comments
    const statsMap = new Map<string, { emojis: Map<string, number>; textCount: number }>();
    for (const row of commentRows) {
      if (!row.talk_uri) continue;
      let stats = statsMap.get(row.talk_uri);
      if (!stats) {
        stats = { emojis: new Map(), textCount: 0 };
        statsMap.set(row.talk_uri, stats);
      }
      const text = (row.text as string).trim();
      if (text.length <= 2 && !/[a-zA-Z]/.test(text)) {
        stats.emojis.set(text, (stats.emojis.get(text) || 0) + 1);
      } else {
        stats.textCount++;
      }
    }

    // Enrich talks with reaction_summary and comment_count
    const enriched = talks.map((talk) => {
      const stats = statsMap.get(talk.uri);
      if (!stats) {
        return { ...talk, reaction_summary: [], comment_count: 0 };
      }
      const topEmojis = [...stats.emojis.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      return {
        ...talk,
        reaction_summary: topEmojis,
        comment_count: stats.textCount,
      };
    });

    return c.json({ talks: enriched });
  });

  app.get("/xrpc/tv.ionosphere.getTalk", (c) => {
    const rkey = c.req.query("rkey");
    if (!rkey) return c.json({ error: "missing rkey" }, 400);
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

  app.get("/xrpc/tv.ionosphere.getSpeakers", (c) => {
    const speakers = db
      .prepare("SELECT * FROM speakers ORDER BY name ASC")
      .all();
    return c.json({ speakers });
  });

  app.get("/xrpc/tv.ionosphere.getSpeaker", (c) => {
    const rkey = c.req.query("rkey");
    if (!rkey) return c.json({ error: "missing rkey" }, 400);
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

  app.get("/xrpc/tv.ionosphere.getConcepts", (c) => {
    const concepts = db
      .prepare("SELECT * FROM concepts ORDER BY name ASC")
      .all();
    return c.json({ concepts });
  });

  app.get("/xrpc/tv.ionosphere.getComments", (c) => {
    const talkRkey = c.req.query("talkRkey");
    const subject = c.req.query("subject");

    if (talkRkey) {
      const talk = db.prepare("SELECT uri FROM talks WHERE rkey = ?").get(talkRkey) as any;
      if (!talk) return c.json({ comments: [] });

      const transcript = db.prepare("SELECT uri FROM transcripts WHERE talk_uri = ?").get(talk.uri) as any;

      const subjectUris = [talk.uri];
      if (transcript) subjectUris.push(transcript.uri);

      const placeholders = subjectUris.map(() => "?").join(",");
      const comments = db.prepare(
        `SELECT c.*, p.handle as author_handle, p.display_name as author_display_name, p.avatar_url as author_avatar_url
         FROM comments c
         LEFT JOIN profiles p ON c.author_did = p.did
         WHERE c.subject_uri IN (${placeholders})
         ORDER BY c.created_at ASC`
      ).all(...subjectUris);

      return c.json({ comments });
    }

    if (subject) {
      const comments = db.prepare(
        `SELECT c.*, p.handle as author_handle, p.display_name as author_display_name, p.avatar_url as author_avatar_url
         FROM comments c
         LEFT JOIN profiles p ON c.author_did = p.did
         WHERE c.subject_uri = ?
         ORDER BY c.created_at ASC`
      ).all(subject);

      return c.json({ comments });
    }

    return c.json({ comments: [] });
  });

  app.get("/xrpc/tv.ionosphere.getMentions", (c) => {
    const talkRkey = c.req.query("talkRkey");
    if (!talkRkey) return c.json({ mentions: [], total: 0 });

    // Get all talk URIs for this rkey (may be multiple DIDs)
    const talkRows = db.prepare("SELECT uri FROM talks WHERE rkey = ?").all(talkRkey) as any[];
    if (!talkRows.length) return c.json({ mentions: [], total: 0 });
    const talkUris = talkRows.map((r: any) => r.uri);
    const talkPlaceholders = talkUris.map(() => "?").join(",");

    const topLevel = db.prepare(
      `SELECT m.uri, m.talk_uri, m.author_did, m.text, m.created_at,
              m.talk_offset_ms, m.byte_position, m.likes, m.reposts, m.replies,
              m.parent_uri, m.mention_type, m.indexed_at,
              COALESCE(p.handle, m.author_handle) as author_handle,
              p.display_name as author_display_name,
              p.avatar_url as author_avatar_url
       FROM mentions m
       LEFT JOIN profiles p ON m.author_did = p.did
       WHERE m.talk_uri IN (${talkPlaceholders}) AND m.parent_uri IS NULL
       ORDER BY
         CASE m.mention_type WHEN 'during_talk' THEN 0 ELSE 1 END,
         m.talk_offset_ms ASC,
         m.created_at ASC`
    ).all(...talkUris);

    const replyStmt = db.prepare(
      `SELECT m.uri, m.talk_uri, m.author_did, m.text, m.created_at,
              m.talk_offset_ms, m.byte_position, m.likes, m.reposts, m.replies,
              m.parent_uri, m.mention_type, m.indexed_at,
              COALESCE(p.handle, m.author_handle) as author_handle,
              p.display_name as author_display_name,
              p.avatar_url as author_avatar_url
       FROM mentions m
       LEFT JOIN profiles p ON m.author_did = p.did
       WHERE m.parent_uri = ?
       ORDER BY m.created_at ASC`
    );

    const mentions = topLevel.map((m: any) => ({
      ...m,
      thread: replyStmt.all(m.uri),
    }));

    return c.json({ mentions, total: mentions.length });
  });

  app.get("/xrpc/tv.ionosphere.getDiscussion", (c) => {
    // Posts: content_type = 'post' or NULL, top-level only, sorted by likes DESC
    const posts = db.prepare(
      `SELECT m.uri, m.author_did, m.text, m.created_at, m.likes, m.reposts, m.replies,
              m.content_type, m.external_url, m.og_title, m.talk_rkey, m.mention_type, m.image_url,
              COALESCE(p.handle, m.author_handle) as author_handle,
              p.display_name as author_display_name,
              p.avatar_url as author_avatar_url,
              (SELECT t.title FROM talks t WHERE t.rkey = m.talk_rkey LIMIT 1) as talk_title
       FROM mentions m
       LEFT JOIN profiles p ON m.author_did = p.did
       WHERE (m.content_type IS NULL OR m.content_type = 'post') AND m.parent_uri IS NULL
       ORDER BY m.likes DESC
       LIMIT 200`
    ).all();

    // Blogs: content_type = 'blog', top-level only
    const blogs = db.prepare(
      `SELECT m.uri, m.author_did, m.text, m.created_at, m.likes, m.reposts, m.replies,
              m.content_type, m.external_url, m.og_title, m.talk_rkey, m.mention_type, m.image_url,
              COALESCE(p.handle, m.author_handle) as author_handle,
              p.display_name as author_display_name,
              p.avatar_url as author_avatar_url,
              (SELECT t.title FROM talks t WHERE t.rkey = m.talk_rkey LIMIT 1) as talk_title
       FROM mentions m
       LEFT JOIN profiles p ON m.author_did = p.did
       WHERE m.content_type = 'blog' AND m.parent_uri IS NULL
       ORDER BY m.likes DESC`
    ).all();

    // Videos: content_type = 'video', top-level only
    const videos = db.prepare(
      `SELECT m.uri, m.author_did, m.text, m.created_at, m.likes, m.reposts, m.replies,
              m.content_type, m.external_url, m.og_title, m.talk_rkey, m.mention_type, m.image_url,
              COALESCE(p.handle, m.author_handle) as author_handle,
              p.display_name as author_display_name,
              p.avatar_url as author_avatar_url,
              (SELECT t.title FROM talks t WHERE t.rkey = m.talk_rkey LIMIT 1) as talk_title
       FROM mentions m
       LEFT JOIN profiles p ON m.author_did = p.did
       WHERE m.content_type = 'video' AND m.parent_uri IS NULL
       ORDER BY m.likes DESC`
    ).all();

    // Photos: posts with images
    const photos = db.prepare(
      `SELECT m.uri, m.author_did, m.text, m.created_at, m.likes, m.reposts, m.replies,
              m.content_type, m.external_url, m.og_title, m.talk_rkey, m.mention_type, m.image_url,
              COALESCE(p.handle, m.author_handle) as author_handle,
              p.display_name as author_display_name,
              p.avatar_url as author_avatar_url,
              (SELECT t.title FROM talks t WHERE t.rkey = m.talk_rkey LIMIT 1) as talk_title
       FROM mentions m
       LEFT JOIN profiles p ON m.author_did = p.did
       WHERE m.content_type = 'photo' AND m.parent_uri IS NULL
       ORDER BY m.likes DESC`
    ).all();

    // VOD sites: unique domains from video external_urls
    const vodRows = db.prepare(
      `SELECT DISTINCT m.external_url FROM mentions m
       WHERE m.content_type = 'video' AND m.external_url IS NOT NULL AND m.parent_uri IS NULL`
    ).all() as any[];
    const vodSites = [...new Set(
      vodRows.map((r: any) => {
        try { return new URL(r.external_url).hostname; } catch { return null; }
      }).filter(Boolean)
    )] as string[];

    // Stats
    const statsRow = db.prepare(
      `SELECT
         COUNT(*) as totalPosts,
         COUNT(CASE WHEN content_type = 'blog' THEN 1 END) as blogCount,
         COUNT(DISTINCT author_did) as uniqueAuthors
       FROM mentions
       WHERE parent_uri IS NULL`
    ).get() as any;

    return c.json({
      posts,
      blogs,
      videos,
      photos,
      vodSites,
      stats: {
        totalPosts: statsRow?.totalPosts || 0,
        blogCount: blogs.length,
        videoCount: videos.length,
        photoCount: photos.length,
        vodSiteCount: vodSites.length,
        uniqueAuthors: statsRow?.uniqueAuthors || 0,
      },
    });
  });

  app.get("/xrpc/tv.ionosphere.getConceptClusters", (c) => {
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

  app.get("/xrpc/tv.ionosphere.getConcept", (c) => {
    const rkey = c.req.query("rkey");
    if (!rkey) return c.json({ error: "missing rkey" }, 400);
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

  // Strip timestampsNs from concordance entries for the main response (fetched on demand)
  function stripTimestamps(entries: any[]): any[] {
    return entries.map((e: any) => ({
      ...e,
      talks: e.talks.map((t: any) => {
        const { timestampsNs, ...rest } = t;
        return rest;
      }),
      subentries: e.subentries?.map((s: any) => ({
        ...s,
        talks: s.talks.map((t: any) => {
          const { timestampsNs, ...rest } = t;
          return rest;
        }),
      })),
    }));
  }

  // Cache the concordance — NLP pipeline takes ~2.5 min, data is static
  let indexCache: { entries: any[]; builtAt: number } | null = null;

  app.get("/xrpc/tv.ionosphere.getConcordance", (c) => {
    // Serve from cache if available
    if (indexCache) {
      return c.json({ entries: stripTimestamps(indexCache.entries) });
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

    return c.json({ entries: stripTimestamps(entries) });
  });

  // On-demand timecodes for a specific term + talk
  app.get("/xrpc/tv.ionosphere.getTimecodes", (c) => {
    const term = c.req.query("term");
    const rkey = c.req.query("rkey");
    if (!term || !rkey) return c.json({ error: "missing term or rkey" }, 400);
    if (!indexCache) return c.json({ timestamps: [] });

    // Search entries and subentries for the matching term + talk
    for (const entry of indexCache.entries) {
      if (entry.term.toLowerCase() === term.toLowerCase()) {
        for (const talk of entry.talks) {
          if (talk.rkey === rkey && talk.timestampsNs) {
            return c.json({ timestamps: talk.timestampsNs });
          }
        }
        for (const sub of entry.subentries || []) {
          for (const talk of sub.talks) {
            if (talk.rkey === rkey && talk.timestampsNs) {
              return c.json({ timestamps: talk.timestampsNs });
            }
          }
        }
      }
    }
    return c.json({ timestamps: [] });
  });

  // Invalidate all caches (call after data changes)
  app.post("/xrpc/tv.ionosphere.invalidate", (c) => {
    indexCache = null;

    // Trigger frontend ISR revalidation
    const frontendUrl = process.env.FRONTEND_URL;
    const revalidateSecret = process.env.REVALIDATE_SECRET;
    if (frontendUrl) {
      const qs = revalidateSecret ? `?secret=${encodeURIComponent(revalidateSecret)}` : "";
      fetch(`${frontendUrl}/api/revalidate${qs}`, { method: "POST" }).catch(() => {});
    }

    return c.json({ ok: true });
  });

  // --- Tracks (full-day streams) ---

  app.get("/xrpc/tv.ionosphere.getTracks", (c) => {
    return c.json({ tracks: getTracksIndex(db) });
  });

  app.get("/xrpc/tv.ionosphere.getTrack", (c) => {
    const stream = c.req.query("stream");
    if (!stream) return c.json({ error: "missing stream parameter" }, 400);
    const data = getTrackData(db, stream);
    if (!data) return c.json({ error: "stream not found" }, 404);
    return c.json(data);
  });

  // --- Corrections sidecar ---

  const validSlugs = new Set(STREAMS.map((s) => s.slug));

  app.get("/xrpc/tv.ionosphere.getCorrections", (c) => {
    const stream = c.req.query("stream");
    if (!stream) return c.json({ error: "missing stream parameter" }, 400);
    if (!validSlugs.has(stream)) return c.json({ error: "invalid stream" }, 400);

    const correctionsPath = path.resolve(
      import.meta.dirname,
      `../data/corrections/corrections-${stream}.json`,
    );
    if (!existsSync(correctionsPath)) {
      return c.json({ corrections: [] });
    }
    const data = JSON.parse(readFileSync(correctionsPath, "utf-8"));
    return c.json({ corrections: data });
  });

  app.put("/xrpc/tv.ionosphere.putCorrections", async (c) => {
    const body = await c.req.json();
    const stream = body.stream;
    const corrections = body.corrections;
    if (!stream || !Array.isArray(corrections)) {
      return c.json({ error: "missing stream or corrections" }, 400);
    }
    if (!validSlugs.has(stream)) {
      return c.json({ error: "invalid stream" }, 400);
    }

    const dir = path.resolve(import.meta.dirname, "../data/corrections");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const correctionsPath = path.resolve(dir, `corrections-${stream}.json`);
    writeFileSync(correctionsPath, JSON.stringify(corrections, null, 2));
    return c.json({ ok: true, count: corrections.length });
  });

  return app;
}
