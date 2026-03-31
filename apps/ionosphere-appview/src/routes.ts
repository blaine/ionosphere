import { Hono } from "hono";
import type Database from "better-sqlite3";

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

    return c.json({ talk, speakers, concepts });
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
