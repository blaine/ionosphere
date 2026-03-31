# Ionosphere Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build ionosphere.tv — a semantically enriched AT Protocol conference video archive for ATmosphereConf 2026 VODs.

**Architecture:** Pannacotta-pattern pipeline: ingest source AT Protocol records (Streamplace VODs + ATmosphereConf schedule) → correlate → transcribe → assemble RelationalText documents → LLM enrichment → SQLite appview → Next.js SSG frontend with synchronized video+transcript playback.

**Tech Stack:** TypeScript, pnpm workspaces, Next.js 15, React 18, Tailwind CSS, Hono, better-sqlite3, relational-text, @atproto/api, vitest.

**Spec:** `docs/superpowers/specs/2026-03-30-ionosphere-design.md`

---

## Chunk 1: Project Scaffold & Lexicons

Sets up the monorepo workspace, defines all AT Protocol lexicons, and creates the format-lexicon with facet type definitions. After this chunk, the project structure exists and the data model is formalized.

### Task 1: Initialize pnpm workspace

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `.gitignore`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "ionosphere-workspace",
  "private": true,
  "scripts": {
    "dev": "pnpm --filter ionosphere dev",
    "build": "pnpm --filter ionosphere build",
    "appview": "pnpm --filter ionosphere-appview appview"
  },
  "devDependencies": {}
}
```

- [ ] **Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - 'apps/*'
  - 'formats/*'
```

- [ ] **Step 3: Create tsconfig.json**

Base TypeScript config for the workspace. ESM, strict, Node 20+ target.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist"
  },
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
.next/
data/audio/
data/transcripts/
*.sqlite
*.sqlite-journal
*.sqlite-wal
.env
.env.local
```

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.json .gitignore
git commit -m "chore: initialize pnpm workspace"
```

### Task 2: Define AT Protocol lexicons

**Files:**
- Create: `lexicons/tv/ionosphere/talk.json`
- Create: `lexicons/tv/ionosphere/speaker.json`
- Create: `lexicons/tv/ionosphere/concept.json`
- Create: `lexicons/tv/ionosphere/event.json`

- [ ] **Step 1: Create talk lexicon**

```json
{
  "lexicon": 1,
  "$type": "com.atproto.lexicon.schema",
  "id": "tv.ionosphere.talk",
  "revision": 1,
  "description": "A conference talk with video reference and enriched transcript document.",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "record": {
        "type": "object",
        "required": ["title", "eventUri"],
        "properties": {
          "title": {
            "type": "string",
            "description": "Talk title."
          },
          "document": {
            "type": "ref",
            "ref": "org.relationaltext.richtext.document",
            "description": "Enriched transcript document with temporal and semantic facets."
          },
          "speakerUris": {
            "type": "array",
            "items": { "type": "string", "format": "at-uri" },
            "description": "AT URIs of tv.ionosphere.speaker records."
          },
          "videoUri": {
            "type": "string",
            "format": "at-uri",
            "description": "AT URI to place.stream.video record."
          },
          "scheduleUri": {
            "type": "string",
            "format": "at-uri",
            "description": "AT URI to source community.lexicon.calendar.event record."
          },
          "eventUri": {
            "type": "string",
            "format": "at-uri",
            "description": "AT URI to tv.ionosphere.event record."
          },
          "room": {
            "type": "string",
            "description": "Room or track name."
          },
          "category": {
            "type": "string",
            "description": "Talk category from schedule."
          },
          "talkType": {
            "type": "string",
            "description": "Type: presentation, lightning-talk, panel, workshop, etc."
          },
          "startsAt": {
            "type": "string",
            "format": "datetime",
            "description": "Scheduled start time (ISO 8601)."
          },
          "endsAt": {
            "type": "string",
            "format": "datetime",
            "description": "Scheduled end time (ISO 8601)."
          },
          "duration": {
            "type": "integer",
            "description": "Video duration in nanoseconds (from VOD record)."
          },
          "description": {
            "type": "string",
            "description": "Talk description/abstract from schedule."
          }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Create speaker lexicon**

```json
{
  "lexicon": 1,
  "$type": "com.atproto.lexicon.schema",
  "id": "tv.ionosphere.speaker",
  "revision": 1,
  "description": "A conference speaker.",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "record": {
        "type": "object",
        "required": ["name"],
        "properties": {
          "name": {
            "type": "string",
            "description": "Speaker display name."
          },
          "handle": {
            "type": "string",
            "description": "AT Protocol handle (e.g., 'signez.fr')."
          },
          "did": {
            "type": "string",
            "format": "did",
            "description": "Speaker's DID, if known."
          },
          "bio": {
            "type": "string",
            "description": "Speaker bio."
          },
          "affiliations": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Organizations, projects, or affiliations."
          }
        }
      }
    }
  }
}
```

- [ ] **Step 3: Create concept lexicon**

```json
{
  "lexicon": 1,
  "$type": "com.atproto.lexicon.schema",
  "id": "tv.ionosphere.concept",
  "revision": 1,
  "description": "A knowledge entity referenced in talk transcripts.",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "record": {
        "type": "object",
        "required": ["name"],
        "properties": {
          "name": {
            "type": "string",
            "description": "Canonical concept name."
          },
          "aliases": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Alternative names for matching."
          },
          "description": {
            "type": "string",
            "description": "Brief description of the concept."
          },
          "wikidataId": {
            "type": "string",
            "description": "Wikidata Q-identifier (e.g., 'Q123456')."
          },
          "url": {
            "type": "string",
            "format": "uri",
            "description": "Canonical external URL for the concept."
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Create event lexicon**

```json
{
  "lexicon": 1,
  "$type": "com.atproto.lexicon.schema",
  "id": "tv.ionosphere.event",
  "revision": 1,
  "description": "A conference or event whose talks are archived.",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "record": {
        "type": "object",
        "required": ["name", "startsAt", "endsAt"],
        "properties": {
          "name": {
            "type": "string",
            "description": "Event name."
          },
          "description": {
            "type": "string",
            "description": "Event description."
          },
          "location": {
            "type": "string",
            "description": "Venue and city."
          },
          "startsAt": {
            "type": "string",
            "format": "datetime",
            "description": "Event start date (ISO 8601)."
          },
          "endsAt": {
            "type": "string",
            "format": "datetime",
            "description": "Event end date (ISO 8601)."
          },
          "tracks": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Room/track names."
          },
          "scheduleRepo": {
            "type": "string",
            "format": "did",
            "description": "DID of the repo containing schedule records."
          },
          "vodRepo": {
            "type": "string",
            "format": "did",
            "description": "DID of the repo containing VOD records."
          }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add lexicons/
git commit -m "feat: define AT Protocol lexicons for talk, speaker, concept, event"
```

### Task 3: Create format-lexicon and facet type definitions

**Files:**
- Create: `formats/tv.ionosphere/package.json`
- Create: `formats/tv.ionosphere/tsconfig.json`
- Create: `formats/tv.ionosphere/ionosphere.lexicon.json`

- [ ] **Step 1: Create format package.json**

```json
{
  "name": "@ionosphere/format",
  "version": "0.1.0",
  "type": "module",
  "main": "ts/index.ts",
  "exports": {
    ".": "./ts/index.ts",
    "./assemble": "./ts/assemble.ts"
  },
  "dependencies": {
    "relational-text": "^0.1.1"
  },
  "devDependencies": {
    "typescript": "^5",
    "vitest": "^3.0.0"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create format tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "ts",
    "outDir": "dist"
  },
  "include": ["ts"]
}
```

- [ ] **Step 3: Create ionosphere.lexicon.json**

This defines the RelationalText facet types, not AT Protocol record types.

Follows pannacotta's `$type: "org.relationaltext.format-lexicon"` schema exactly.

```json
{
  "$type": "org.relationaltext.format-lexicon",
  "id": "tv.ionosphere.facet",
  "name": "Ionosphere Talk Annotations",
  "description": "Semantic annotations for conference talk transcripts: timestamps, speakers, concepts, cross-references",
  "features": [
    {
      "typeId": "tv.ionosphere.facet#speaker-segment",
      "featureClass": "block",
      "expandStart": false,
      "expandEnd": false
    },
    {
      "typeId": "tv.ionosphere.facet#concept-ref",
      "featureClass": "inline",
      "expandStart": false,
      "expandEnd": false
    },
    {
      "typeId": "tv.ionosphere.facet#speaker-ref",
      "featureClass": "inline",
      "expandStart": false,
      "expandEnd": false
    },
    {
      "typeId": "tv.ionosphere.facet#talk-xref",
      "featureClass": "inline",
      "expandStart": false,
      "expandEnd": false
    },
    {
      "typeId": "tv.ionosphere.facet#link",
      "featureClass": "inline",
      "expandStart": false,
      "expandEnd": false
    },
    {
      "typeId": "tv.ionosphere.facet#timestamp",
      "featureClass": "meta",
      "expandStart": false,
      "expandEnd": false
    }
  ]
}
```

Feature property schemas (speakerUri, conceptUri, startTime/endTime, etc.) are defined in TypeScript code, not in the format-lexicon JSON — matching pannacotta's pattern.

- [ ] **Step 4: Create format entry point**

Create `formats/tv.ionosphere/ts/index.ts`:

```typescript
export const NAMESPACE = "tv.ionosphere";

// Shared types used across packages
export interface WordTimestamp {
  word: string;
  start: number; // seconds
  end: number; // seconds
  confidence: number;
}

export interface TranscriptResult {
  text: string;
  words: WordTimestamp[];
}
```

Canonical location for shared types. The appview's `transcribe.ts` imports these rather than defining its own.

- [ ] **Step 5: Run pnpm install**

```bash
pnpm install
```

- [ ] **Step 6: Commit**

```bash
git add formats/
git commit -m "feat: create format-lexicon with facet type definitions"
```

---

### Deferred from Chunk 1

- **Lens files** (`schedule-to-talk.lens.json`, `transcript-to-document.lens.json`): The lens transformation logic is currently implemented procedurally in `ingest.ts` and `assemble.ts`. Declarative lens JSON specs will be formalized once the transformation rules are stable. This matches pannacotta's development pattern where lenses were extracted from working code.
- **panproto**: Schema versioning will be integrated once lexicons stabilize past their initial revision.
- **Pretext**: Transcript layout integration depends on evaluating Pretext's available API surface area, which is currently undocumented. The plan uses a custom `TranscriptView` component that can be swapped for Pretext later.

---

## Chunk 2: Appview Scaffold & Data Ingest

Creates the appview app, sets up SQLite schema, and implements ingestion of source data from Streamplace VODs and ATmosphereConf schedule records.

### Task 4: Scaffold the appview app

**Files:**
- Create: `apps/ionosphere-appview/package.json`
- Create: `apps/ionosphere-appview/tsconfig.json`
- Create: `apps/ionosphere-appview/src/appview.ts`
- Create: `apps/ionosphere-appview/src/db.ts`
- Create: `apps/ionosphere-appview/src/routes.ts`

- [ ] **Step 1: Create appview package.json**

```json
{
  "name": "ionosphere-appview",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@atproto/api": "^0.15.0",
    "@hono/node-server": "^1.13.0",
    "@ionosphere/format": "workspace:*",
    "better-sqlite3": "^12.8.0",
    "hono": "^4.7.0",
    "relational-text": "^0.1.1",
    "tsx": "^4.19.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "scripts": {
    "appview": "tsx src/appview.ts",
    "ingest": "tsx src/ingest.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create appview tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create db.ts with SQLite schema**

```typescript
import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = path.resolve(
  import.meta.dirname,
  "../../data/ionosphere.sqlite"
);

export function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      location TEXT,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      tracks TEXT, -- JSON array
      schedule_repo TEXT,
      vod_repo TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS speakers (
      uri TEXT PRIMARY KEY,
      did TEXT,
      rkey TEXT NOT NULL,
      name TEXT NOT NULL,
      handle TEXT,
      speaker_did TEXT,
      bio TEXT,
      affiliations TEXT, -- JSON array
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS talks (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      document TEXT, -- JSON: RelationalText document
      video_uri TEXT,
      schedule_uri TEXT,
      event_uri TEXT NOT NULL,
      room TEXT,
      category TEXT,
      talk_type TEXT,
      starts_at TEXT,
      ends_at TEXT,
      duration INTEGER, -- nanoseconds
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_uri) REFERENCES events(uri) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS talk_speakers (
      talk_uri TEXT NOT NULL,
      speaker_uri TEXT NOT NULL,
      PRIMARY KEY (talk_uri, speaker_uri),
      FOREIGN KEY (talk_uri) REFERENCES talks(uri) ON DELETE CASCADE,
      FOREIGN KEY (speaker_uri) REFERENCES speakers(uri) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS concepts (
      uri TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases TEXT, -- JSON array
      description TEXT,
      wikidata_id TEXT,
      url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS talk_concepts (
      talk_uri TEXT NOT NULL,
      concept_uri TEXT NOT NULL,
      mention_count INTEGER DEFAULT 1,
      PRIMARY KEY (talk_uri, concept_uri),
      FOREIGN KEY (talk_uri) REFERENCES talks(uri) ON DELETE CASCADE,
      FOREIGN KEY (concept_uri) REFERENCES concepts(uri) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS talk_crossrefs (
      from_talk_uri TEXT NOT NULL,
      to_talk_uri TEXT NOT NULL,
      PRIMARY KEY (from_talk_uri, to_talk_uri),
      FOREIGN KEY (from_talk_uri) REFERENCES talks(uri) ON DELETE CASCADE,
      FOREIGN KEY (to_talk_uri) REFERENCES talks(uri) ON DELETE CASCADE
    );

    -- Track pipeline status per talk
    CREATE TABLE IF NOT EXISTS pipeline_status (
      talk_uri TEXT PRIMARY KEY,
      ingested INTEGER DEFAULT 0,
      transcribed INTEGER DEFAULT 0,
      assembled INTEGER DEFAULT 0,
      enriched INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (talk_uri) REFERENCES talks(uri) ON DELETE CASCADE
    );
  `);
}
```

- [ ] **Step 4: Create routes.ts with basic API**

```typescript
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
```

- [ ] **Step 5: Create appview.ts entry point**

```typescript
import { serve } from "@hono/node-server";
import { openDb, migrate } from "./db.js";
import { createRoutes } from "./routes.js";

const db = openDb();
migrate(db);

const app = createRoutes(db);

const port = parseInt(process.env.PORT || "3001", 10);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Ionosphere appview running on http://localhost:${info.port}`);
});
```

- [ ] **Step 6: Run pnpm install and verify**

```bash
pnpm install
```

- [ ] **Step 7: Commit**

```bash
git add apps/ionosphere-appview/
git commit -m "feat: scaffold appview with SQLite schema and REST API"
```

### Task 5: Implement data ingest from AT Protocol

**Files:**
- Create: `apps/ionosphere-appview/src/ingest.ts`
- Create: `apps/ionosphere-appview/src/correlate.ts`

- [ ] **Step 1: Write test for correlation logic**

Create `apps/ionosphere-appview/src/correlate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { correlate, type ScheduleEvent, type VodRecord } from "./correlate.js";

describe("correlate", () => {
  const schedule: ScheduleEvent[] = [
    {
      uri: "at://did:plc:test/community.lexicon.calendar.event/abc",
      name: "Building Cirrus: a single-user, serverless PDS",
      startsAt: "2026-03-28T16:15:00.000Z",
      endsAt: "2026-03-28T16:45:00.000Z",
      type: "presentation",
      room: "Great Hall South",
      category: "Development and Protocol",
      speakers: [{ id: "test.bsky.social", name: "Test Speaker" }],
      description: "A test talk.",
    },
  ];

  const vods: VodRecord[] = [
    {
      uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/123",
      title: "Building Cirrus: a single-user, serverless PDS",
      creator: "did:plc:7tattzlorncahxgtdiuci7x7",
      duration: 2238000000000,
      createdAt: "2026-03-28T16:50:00Z",
    },
    {
      uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/456",
      title: "lunch",
      creator: "did:plc:7tattzlorncahxgtdiuci7x7",
      duration: 4308000000000,
      createdAt: "2026-03-28T19:30:00Z",
    },
  ];

  it("matches VODs to schedule events by title", () => {
    const matches = correlate(schedule, vods);
    expect(matches).toHaveLength(1);
    expect(matches[0].schedule.name).toBe(
      "Building Cirrus: a single-user, serverless PDS"
    );
    expect(matches[0].vod.uri).toContain("123");
  });

  it("filters out noise titles", () => {
    const matches = correlate(schedule, vods);
    expect(matches.every((m) => m.vod.title !== "lunch")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ionosphere-appview && pnpm test`
Expected: FAIL — correlate module doesn't exist yet.

- [ ] **Step 3: Implement correlate.ts**

```typescript
export interface ScheduleEvent {
  uri: string;
  name: string;
  startsAt: string;
  endsAt: string;
  type: string;
  room: string;
  category: string;
  speakers: Array<{ id: string; name: string }>;
  description: string;
}

export interface VodRecord {
  uri: string;
  title: string;
  creator: string;
  duration: number; // nanoseconds
  createdAt: string;
}

export interface Match {
  schedule: ScheduleEvent;
  vod: VodRecord;
  confidence: number; // 0-1
}

const NOISE_TITLES = new Set([
  "lunch",
  "lunch break",
  "break",
  "doors open",
  "starting soon",
  "join us tomorrow",
  "lunch day",
  "breakfast",
  "coffee break",
  "irl only",
  "no stream",
]);

function isNoise(title: string): boolean {
  const lower = title.toLowerCase().trim();
  if (NOISE_TITLES.has(lower)) return true;
  if (lower.startsWith("lunch")) return true;
  if (lower.startsWith("doors open")) return true;
  if (lower.startsWith("atmoshereconf starting")) return true;
  if (lower.startsWith("atmosphereconf starting")) return true;
  if (lower.startsWith("join us")) return true;
  if (lower.startsWith("please join")) return true;
  if (lower.startsWith("follow @")) return true;
  if (lower.includes("starting soon")) return true;
  return false;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;

  const wordsA = new Set(na.split(" "));
  const wordsB = new Set(nb.split(" "));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}

export function correlate(
  schedule: ScheduleEvent[],
  vods: VodRecord[]
): Match[] {
  const matches: Match[] = [];
  const usedVods = new Set<string>();

  // Filter noise VODs
  const realVods = vods.filter((v) => !isNoise(v.title));

  for (const event of schedule) {
    let bestMatch: VodRecord | null = null;
    let bestScore = 0;

    for (const vod of realVods) {
      if (usedVods.has(vod.uri)) continue;
      const score = titleSimilarity(event.name, vod.title);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = vod;
      }
    }

    if (bestMatch && bestScore >= 0.5) {
      matches.push({
        schedule: event,
        vod: bestMatch,
        confidence: bestScore,
      });
      usedVods.add(bestMatch.uri);
    }
  }

  return matches.sort(
    (a, b) =>
      new Date(a.schedule.startsAt).getTime() -
      new Date(b.schedule.startsAt).getTime()
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ionosphere-appview && pnpm test`
Expected: PASS

- [ ] **Step 5: Implement ingest.ts**

This fetches source records from AT Protocol and writes correlated talks + speakers to SQLite.

```typescript
import { openDb, migrate } from "./db.js";
import { correlate, type ScheduleEvent, type VodRecord } from "./correlate.js";

const SCHEDULE_DID = "did:plc:3xewinw4wtimo2lqfy5fm5sw";
const SCHEDULE_COLLECTION = "community.lexicon.calendar.event";
const VOD_DID = "did:plc:rbvrr34edl5ddpuwcubjiost";
const VOD_COLLECTION = "place.stream.video";
const VOD_PDS = "https://iameli.com";
const BSKY_API = "https://bsky.social";

// ionosphere.tv's own DID — placeholder until the real DID is created.
// All ionosphere domain records use this as their repo DID.
const IONOSPHERE_DID = "did:plc:ionosphere-placeholder";

const EVENT_URI = `at://${IONOSPHERE_DID}/tv.ionosphere.event/atmosphereconf-2026`;

async function fetchAllRecords(
  baseUrl: string,
  repo: string,
  collection: string
): Promise<any[]> {
  const records: any[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      repo,
      collection,
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(
      `${baseUrl}/xrpc/com.atproto.repo.listRecords?${params}`
    );
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
    const data = await res.json();
    records.push(...data.records);
    cursor = data.cursor;
  } while (cursor);

  return records;
}

function parseScheduleEvent(record: any): ScheduleEvent | null {
  const v = record.value;
  const ad = v.additionalData;
  if (!ad?.isAtmosphereconf) return null;
  if (v.status === "community.lexicon.calendar.event#cancelled") return null;
  // Skip non-talk types
  const type = ad?.type || "";
  if (["info", "food"].includes(type)) return null;

  return {
    uri: record.uri,
    name: v.name,
    startsAt: v.startsAt,
    endsAt: v.endsAt,
    type,
    room: ad?.room || "",
    category: ad?.category || "",
    speakers: ad?.speakers || [],
    description: v.description || "",
  };
}

function parseVodRecord(record: any): VodRecord {
  return {
    uri: record.uri,
    title: record.value.title,
    creator: record.value.creator,
    duration: record.value.duration,
    createdAt: record.value.createdAt,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function main() {
  console.log("Fetching schedule events...");
  const scheduleRaw = await fetchAllRecords(
    BSKY_API,
    SCHEDULE_DID,
    SCHEDULE_COLLECTION
  );
  const schedule = scheduleRaw
    .map(parseScheduleEvent)
    .filter((e): e is ScheduleEvent => e !== null);
  console.log(`  ${schedule.length} schedule events (filtered from ${scheduleRaw.length})`);

  console.log("Fetching VOD records...");
  const vodRaw = await fetchAllRecords(VOD_PDS, VOD_DID, VOD_COLLECTION);
  const vods = vodRaw.map(parseVodRecord);
  console.log(`  ${vods.length} VOD records`);

  console.log("Correlating...");
  const matches = correlate(schedule, vods);
  console.log(`  ${matches.length} matches`);

  const db = openDb();
  migrate(db);

  // Insert event
  db.prepare(
    `INSERT OR REPLACE INTO events (uri, did, rkey, name, description, location, starts_at, ends_at, tracks, schedule_repo, vod_repo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    EVENT_URI,
    SCHEDULE_DID,
    "atmosphereconf-2026",
    "ATmosphereConf 2026",
    "The global gathering for the AT Protocol community.",
    "AMS Student Nest, UBC, Vancouver, BC, Canada",
    "2026-03-26T00:00:00Z",
    "2026-03-29T23:59:59Z",
    JSON.stringify(["Great Hall South", "Performance Theatre", "Room 2301"]),
    SCHEDULE_DID,
    VOD_DID
  );

  // Collect unique speakers, insert them
  const speakerMap = new Map<string, { name: string; handle: string }>();
  for (const m of matches) {
    for (const s of m.schedule.speakers) {
      if (!speakerMap.has(s.id)) {
        speakerMap.set(s.id, { name: s.name, handle: s.id });
      }
    }
  }

  const insertSpeaker = db.prepare(
    `INSERT OR REPLACE INTO speakers (uri, did, rkey, name, handle)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const [handle, speaker] of speakerMap) {
    const rkey = slugify(handle);
    const uri = `at://${IONOSPHERE_DID}/tv.ionosphere.speaker/${rkey}`;
    insertSpeaker.run(uri, IONOSPHERE_DID, rkey, speaker.name, speaker.handle);
  }
  console.log(`  ${speakerMap.size} speakers`);

  // Insert talks
  const insertTalk = db.prepare(
    `INSERT OR REPLACE INTO talks (uri, did, rkey, title, description, video_uri, schedule_uri, event_uri, room, category, talk_type, starts_at, ends_at, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertTalkSpeaker = db.prepare(
    `INSERT OR REPLACE INTO talk_speakers (talk_uri, speaker_uri)
     VALUES (?, ?)`
  );
  const insertPipelineStatus = db.prepare(
    `INSERT OR REPLACE INTO pipeline_status (talk_uri, ingested)
     VALUES (?, 1)`
  );

  for (const m of matches) {
    const rkey = m.schedule.uri.split("/").pop()!;
    const talkUri = `at://${IONOSPHERE_DID}/tv.ionosphere.talk/${rkey}`;

    insertTalk.run(
      talkUri,
      IONOSPHERE_DID,
      rkey,
      m.schedule.name,
      m.schedule.description,
      m.vod.uri,
      m.schedule.uri,
      EVENT_URI,
      m.schedule.room,
      m.schedule.category,
      m.schedule.type,
      m.schedule.startsAt,
      m.schedule.endsAt,
      m.vod.duration
    );

    for (const s of m.schedule.speakers) {
      const speakerRkey = slugify(s.id);
      const speakerUri = `at://ionosphere.tv/tv.ionosphere.speaker/${speakerRkey}`;
      insertTalkSpeaker.run(talkUri, speakerUri);
    }

    insertPipelineStatus.run(talkUri);
  }

  console.log(`\nIngested ${matches.length} talks into database.`);

  // Report unmatched
  const unmatchedSchedule = schedule.filter(
    (s) => !matches.some((m) => m.schedule.uri === s.uri)
  );
  if (unmatchedSchedule.length > 0) {
    console.log(`\nUnmatched schedule events (${unmatchedSchedule.length}):`);
    for (const s of unmatchedSchedule) {
      console.log(`  - ${s.name} (${s.type})`);
    }
  }

  db.close();
}

main().catch(console.error);
```

- [ ] **Step 6: Run ingest and verify**

```bash
mkdir -p data
cd apps/ionosphere-appview && pnpm ingest
```

Verify output shows correlated talks, speakers, and any unmatched events.

- [ ] **Step 7: Start appview and test API**

```bash
cd apps/ionosphere-appview && pnpm appview &
curl http://localhost:3001/health
curl http://localhost:3001/talks | python3 -m json.tool | head -30
curl http://localhost:3001/speakers | python3 -m json.tool | head -20
```

- [ ] **Step 8: Commit**

```bash
git add apps/ionosphere-appview/src/ingest.ts apps/ionosphere-appview/src/correlate.ts apps/ionosphere-appview/src/correlate.test.ts data/
git commit -m "feat: ingest VOD and schedule data, correlate talks to videos"
```

---

## Chunk 3: Next.js Frontend Scaffold

Sets up the Next.js SSG frontend with basic page routes and a working video player. After this chunk, you can browse talks and watch videos.

### Task 6: Scaffold Next.js app

**Files:**
- Create: `apps/ionosphere/package.json`
- Create: `apps/ionosphere/tsconfig.json`
- Create: `apps/ionosphere/next.config.ts`
- Create: `apps/ionosphere/tailwind.config.ts`
- Create: `apps/ionosphere/postcss.config.mjs`
- Create: `apps/ionosphere/src/app/layout.tsx`
- Create: `apps/ionosphere/src/app/page.tsx`
- Create: `apps/ionosphere/src/lib/api.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "ionosphere",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@ionosphere/format": "workspace:*",
    "next": "^15",
    "react": "^18",
    "react-dom": "^18",
    "relational-text": "^0.1.1"
  },
  "devDependencies": {
    "@tailwindcss/typography": "^0.5.19",
    "@types/node": "^22",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.19",
    "typescript": "^5"
  },
  "scripts": {
    "dev": "next dev --port 3002",
    "build": "next build",
    "start": "next start"
  }
}
```

- [ ] **Step 2: Create next.config.ts**

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
```

- [ ] **Step 3: Create tailwind.config.ts**

```typescript
import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [typography],
};

export default config;
```

- [ ] **Step 4: Create postcss.config.mjs**

```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 5: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 6: Create src/lib/api.ts**

API client that reads from the appview (at build time for SSG, at runtime for dev).

```typescript
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { next: { revalidate: false } });
  if (!res.ok) throw new Error(`API error: ${res.status} ${path}`);
  return res.json();
}

export async function getTalks() {
  return fetchApi<{ talks: any[] }>("/talks");
}

export async function getTalk(rkey: string) {
  return fetchApi<{ talk: any; speakers: any[]; concepts: any[] }>(
    `/talks/${rkey}`
  );
}

export async function getSpeakers() {
  return fetchApi<{ speakers: any[] }>("/speakers");
}

export async function getSpeaker(rkey: string) {
  return fetchApi<{ speaker: any; talks: any[] }>(`/speakers/${rkey}`);
}

export async function getConcepts() {
  return fetchApi<{ concepts: any[] }>("/concepts");
}

export async function getConcept(rkey: string) {
  return fetchApi<{ concept: any; talks: any[] }>(`/concepts/${rkey}`);
}
```

- [ ] **Step 7: Create src/app/globals.css**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 8: Create layout.tsx**

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ionosphere",
  description:
    "Semantically enriched conference video archive for ATmosphereConf 2026",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 min-h-screen">
        <header className="border-b border-neutral-800 px-6 py-4">
          <nav className="max-w-6xl mx-auto flex items-center gap-6">
            <a href="/" className="text-xl font-bold tracking-tight">
              Ionosphere
            </a>
            <a href="/talks" className="text-neutral-400 hover:text-neutral-100">
              Talks
            </a>
            <a
              href="/speakers"
              className="text-neutral-400 hover:text-neutral-100"
            >
              Speakers
            </a>
            <a
              href="/concepts"
              className="text-neutral-400 hover:text-neutral-100"
            >
              Concepts
            </a>
          </nav>
        </header>
        <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
```

- [ ] **Step 9: Create page.tsx (home)**

```tsx
import { getTalks } from "@/lib/api";

export default async function Home() {
  const { talks } = await getTalks();

  return (
    <div>
      <h1 className="text-4xl font-bold mb-2">ATmosphereConf 2026</h1>
      <p className="text-neutral-400 mb-8">
        Semantically enriched conference archive. {talks.length} talks.
      </p>
      <div className="grid gap-4">
        {talks.slice(0, 20).map((talk: any) => (
          <a
            key={talk.rkey}
            href={`/talks/${talk.rkey}`}
            className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors"
          >
            <h2 className="font-semibold">{talk.title}</h2>
            <div className="text-sm text-neutral-400 mt-1">
              {talk.speaker_names} &middot; {talk.room} &middot; {talk.talk_type}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 10: Install and verify**

```bash
pnpm install
cd apps/ionosphere && pnpm dev
```

Visit http://localhost:3002 — should show talk list (requires appview running on 3001).

- [ ] **Step 11: Commit**

```bash
git add apps/ionosphere/
git commit -m "feat: scaffold Next.js frontend with talk listing"
```

### Task 7: Talk page with video player

**Files:**
- Create: `apps/ionosphere/src/app/talks/page.tsx`
- Create: `apps/ionosphere/src/app/talks/[rkey]/page.tsx`
- Create: `apps/ionosphere/src/app/components/VideoPlayer.tsx`

- [ ] **Step 1: Create talks index page**

`apps/ionosphere/src/app/talks/page.tsx`:

```tsx
import { getTalks } from "@/lib/api";

export default async function TalksPage() {
  const { talks } = await getTalks();

  // Group by day
  const byDay = new Map<string, any[]>();
  for (const talk of talks) {
    const day = talk.starts_at?.slice(0, 10) || "unknown";
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(talk);
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">All Talks</h1>
      {[...byDay.entries()].map(([day, dayTalks]) => (
        <section key={day} className="mb-8">
          <h2 className="text-xl font-semibold text-neutral-300 mb-4">
            {new Date(day + "T00:00:00Z").toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </h2>
          <div className="grid gap-3">
            {dayTalks.map((talk: any) => (
              <a
                key={talk.rkey}
                href={`/talks/${talk.rkey}`}
                className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors"
              >
                <h3 className="font-semibold">{talk.title}</h3>
                <div className="text-sm text-neutral-400 mt-1">
                  {talk.speaker_names} &middot; {talk.room} &middot;{" "}
                  {talk.talk_type}
                </div>
              </a>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create VideoPlayer component**

`apps/ionosphere/src/app/components/VideoPlayer.tsx`:

```tsx
"use client";

import { useRef, useEffect } from "react";

interface VideoPlayerProps {
  videoUri: string;
  onTimeUpdate?: (timeNs: number) => void;
}

const VOD_ENDPOINT = "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";

export default function VideoPlayer({ videoUri, onTimeUpdate }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const playlistUrl = `${VOD_ENDPOINT}?uri=${encodeURIComponent(videoUri)}`;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // HLS.js for browsers that don't support HLS natively
    let hls: any;

    async function setupHls() {
      if (video!.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari supports HLS natively
        video!.src = playlistUrl;
      } else {
        const { default: Hls } = await import("hls.js");
        if (Hls.isSupported()) {
          hls = new Hls();
          hls.loadSource(playlistUrl);
          hls.attachMedia(video!);
        }
      }
    }

    setupHls();

    return () => {
      if (hls) hls.destroy();
    };
  }, [playlistUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !onTimeUpdate) return;

    const handler = () => {
      // Convert seconds to nanoseconds for consistency with VOD duration format
      onTimeUpdate(video.currentTime * 1e9);
    };

    video.addEventListener("timeupdate", handler);
    return () => video.removeEventListener("timeupdate", handler);
  }, [onTimeUpdate]);

  return (
    <video
      ref={videoRef}
      controls
      className="w-full rounded-lg bg-black aspect-video"
    />
  );
}
```

- [ ] **Step 3: Create talk detail page**

`apps/ionosphere/src/app/talks/[rkey]/page.tsx`:

```tsx
import { getTalk, getTalks } from "@/lib/api";
import VideoPlayer from "@/app/components/VideoPlayer";

export async function generateStaticParams() {
  const { talks } = await getTalks();
  return talks.map((t: any) => ({ rkey: t.rkey }));
}

export default async function TalkPage({
  params,
}: {
  params: Promise<{ rkey: string }>;
}) {
  const { rkey } = await params;
  const { talk, speakers, concepts } = await getTalk(rkey);

  const durationMin = talk.duration ? (talk.duration / 1e9 / 60).toFixed(0) : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-2">
        {talk.video_uri && <VideoPlayer videoUri={talk.video_uri} />}
        <h1 className="text-2xl font-bold mt-4">{talk.title}</h1>
        <div className="text-neutral-400 mt-1">
          {speakers.map((s: any) => s.name).join(", ")}
          {durationMin && <> &middot; {durationMin} min</>}
          {talk.room && <> &middot; {talk.room}</>}
        </div>
        {talk.description && (
          <p className="text-neutral-300 mt-4 leading-relaxed">
            {talk.description}
          </p>
        )}
        {/* Transcript will go here in a later task */}
        <div className="mt-8 p-6 rounded-lg border border-neutral-800 text-neutral-500 text-sm">
          Transcript not yet available.
        </div>
      </div>
      <aside className="space-y-6">
        <section>
          <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wide mb-2">
            Speakers
          </h2>
          {speakers.map((s: any) => (
            <a
              key={s.rkey}
              href={`/speakers/${s.rkey}`}
              className="block text-neutral-200 hover:text-white"
            >
              {s.name}
              {s.handle && (
                <span className="text-neutral-500 ml-1">@{s.handle}</span>
              )}
            </a>
          ))}
        </section>
        {talk.category && (
          <section>
            <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wide mb-2">
              Category
            </h2>
            <span className="text-neutral-300">{talk.category}</span>
          </section>
        )}
        {talk.talk_type && (
          <section>
            <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wide mb-2">
              Type
            </h2>
            <span className="text-neutral-300">{talk.talk_type}</span>
          </section>
        )}
      </aside>
    </div>
  );
}
```

- [ ] **Step 4: Add hls.js dependency**

```bash
cd apps/ionosphere && pnpm add hls.js
```

- [ ] **Step 5: Verify talk page with video playback**

With appview running on :3001 and frontend on :3002, navigate to a talk page and verify the video loads and plays from Streamplace.

- [ ] **Step 6: Commit**

```bash
git add apps/ionosphere/src/app/talks/ apps/ionosphere/src/app/components/VideoPlayer.tsx
git commit -m "feat: talk pages with HLS video player"
```

### Task 8: Speaker and concept pages

**Files:**
- Create: `apps/ionosphere/src/app/speakers/page.tsx`
- Create: `apps/ionosphere/src/app/speakers/[rkey]/page.tsx`
- Create: `apps/ionosphere/src/app/concepts/page.tsx`
- Create: `apps/ionosphere/src/app/concepts/[rkey]/page.tsx`

- [ ] **Step 1: Create speakers index page**

```tsx
import { getSpeakers } from "@/lib/api";

export default async function SpeakersPage() {
  const { speakers } = await getSpeakers();

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Speakers</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {speakers.map((s: any) => (
          <a
            key={s.rkey}
            href={`/speakers/${s.rkey}`}
            className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors"
          >
            <div className="font-semibold">{s.name}</div>
            {s.handle && (
              <div className="text-sm text-neutral-400">@{s.handle}</div>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create speaker detail page**

```tsx
import { getSpeaker, getSpeakers } from "@/lib/api";

export async function generateStaticParams() {
  const { speakers } = await getSpeakers();
  return speakers.map((s: any) => ({ rkey: s.rkey }));
}

export default async function SpeakerPage({
  params,
}: {
  params: Promise<{ rkey: string }>;
}) {
  const { rkey } = await params;
  const { speaker, talks } = await getSpeaker(rkey);

  return (
    <div>
      <h1 className="text-3xl font-bold">{speaker.name}</h1>
      {speaker.handle && (
        <div className="text-neutral-400 mt-1">@{speaker.handle}</div>
      )}
      {speaker.bio && (
        <p className="text-neutral-300 mt-4">{speaker.bio}</p>
      )}
      <h2 className="text-xl font-semibold mt-8 mb-4">Talks</h2>
      <div className="grid gap-3">
        {talks.map((t: any) => (
          <a
            key={t.rkey}
            href={`/talks/${t.rkey}`}
            className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors"
          >
            <div className="font-semibold">{t.title}</div>
            <div className="text-sm text-neutral-400 mt-1">
              {t.room} &middot; {t.talk_type}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create concepts index page**

```tsx
import { getConcepts } from "@/lib/api";

export default async function ConceptsPage() {
  const { concepts } = await getConcepts();

  if (concepts.length === 0) {
    return (
      <div>
        <h1 className="text-3xl font-bold mb-6">Concepts</h1>
        <p className="text-neutral-400">
          Concepts will appear here after transcript enrichment.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Concepts</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {concepts.map((c: any) => (
          <a
            key={c.rkey}
            href={`/concepts/${c.rkey}`}
            className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors"
          >
            <div className="font-semibold">{c.name}</div>
            {c.description && (
              <div className="text-sm text-neutral-400 mt-1 line-clamp-2">
                {c.description}
              </div>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create concept detail page**

```tsx
import { getConcept, getConcepts } from "@/lib/api";

export async function generateStaticParams() {
  const { concepts } = await getConcepts();
  return concepts.map((c: any) => ({ rkey: c.rkey }));
}

export default async function ConceptPage({
  params,
}: {
  params: Promise<{ rkey: string }>;
}) {
  const { rkey } = await params;
  const { concept, talks } = await getConcept(rkey);

  return (
    <div>
      <h1 className="text-3xl font-bold">{concept.name}</h1>
      {concept.description && (
        <p className="text-neutral-300 mt-4">{concept.description}</p>
      )}
      {concept.wikidata_id && (
        <a
          href={`https://www.wikidata.org/wiki/${concept.wikidata_id}`}
          className="text-blue-400 hover:underline text-sm mt-2 inline-block"
          target="_blank"
          rel="noopener"
        >
          Wikidata
        </a>
      )}
      <h2 className="text-xl font-semibold mt-8 mb-4">
        Mentioned in {talks.length} talk{talks.length !== 1 ? "s" : ""}
      </h2>
      <div className="grid gap-3">
        {talks.map((t: any) => (
          <a
            key={t.rkey}
            href={`/talks/${t.rkey}`}
            className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors"
          >
            <div className="font-semibold">{t.title}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Verify all pages**

Navigate to /speakers, /speakers/:rkey, /concepts, verify rendering.

- [ ] **Step 6: Commit**

```bash
git add apps/ionosphere/src/app/speakers/ apps/ionosphere/src/app/concepts/
git commit -m "feat: speaker and concept pages"
```

---

## Chunk 4: Transcription Pipeline

Implements audio extraction from HLS streams and transcription with word-level timestamps. After this chunk, talks have transcripts stored in the database.

### Task 9: Audio extraction from HLS

**Files:**
- Create: `apps/ionosphere-appview/src/extract-audio.ts`

- [ ] **Step 1: Write test for audio extraction**

Create `apps/ionosphere-appview/src/extract-audio.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildPlaylistUrl } from "./extract-audio.js";

describe("extract-audio", () => {
  it("builds correct playlist URL from video URI", () => {
    const uri =
      "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/3mi5stzyxji2e";
    const url = buildPlaylistUrl(uri);
    expect(url).toBe(
      "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist?uri=at%3A%2F%2Fdid%3Aplc%3Arbvrr34edl5ddpuwcubjiost%2Fplace.stream.video%2F3mi5stzyxji2e"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ionosphere-appview && pnpm test`

- [ ] **Step 3: Implement extract-audio.ts**

Uses ffmpeg to extract audio from the HLS stream. ffmpeg must be installed on the system.

```typescript
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const VOD_ENDPOINT =
  "https://vod-beta.stream.place/xrpc/place.stream.playback.getVideoPlaylist";
const AUDIO_DIR = path.resolve(import.meta.dirname, "../../data/audio");

export function buildPlaylistUrl(videoUri: string): string {
  return `${VOD_ENDPOINT}?uri=${encodeURIComponent(videoUri)}`;
}

export function extractAudio(
  videoUri: string,
  talkRkey: string
): string {
  mkdirSync(AUDIO_DIR, { recursive: true });

  const outputPath = path.join(AUDIO_DIR, `${talkRkey}.wav`);
  if (existsSync(outputPath)) {
    console.log(`  Audio already exists: ${talkRkey}.wav`);
    return outputPath;
  }

  const playlistUrl = buildPlaylistUrl(videoUri);
  console.log(`  Extracting audio for ${talkRkey}...`);

  execSync(
    `ffmpeg -i "${playlistUrl}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`,
    { stdio: "inherit", timeout: 600_000 }
  );

  return outputPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ionosphere-appview && pnpm test`

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere-appview/src/extract-audio.ts apps/ionosphere-appview/src/extract-audio.test.ts
git commit -m "feat: audio extraction from HLS streams via ffmpeg"
```

### Task 10: Transcription integration

**Files:**
- Create: `apps/ionosphere-appview/src/transcribe.ts`

This task is a skeleton — the actual transcription provider is pluggable. Start with a file-based interface that can wrap any provider.

- [ ] **Step 1: Define transcription types and interface**

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { extractAudio } from "./extract-audio.js";
import { openDb } from "./db.js";

const TRANSCRIPT_DIR = path.resolve(
  import.meta.dirname,
  "../../data/transcripts"
);

export interface WordTimestamp {
  word: string;
  start: number; // seconds
  end: number; // seconds
  confidence: number;
}

export interface TranscriptResult {
  text: string;
  words: WordTimestamp[];
}

export type TranscriptionProvider = (
  audioPath: string
) => Promise<TranscriptResult>;

// Placeholder provider — replace with real implementation
async function placeholderProvider(
  audioPath: string
): Promise<TranscriptResult> {
  throw new Error(
    `No transcription provider configured. Audio file: ${audioPath}`
  );
}

export async function transcribeTalk(
  talkRkey: string,
  videoUri: string,
  provider: TranscriptionProvider = placeholderProvider
): Promise<TranscriptResult> {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });

  const cachedPath = path.join(TRANSCRIPT_DIR, `${talkRkey}.json`);

  // Check cache
  if (existsSync(cachedPath)) {
    console.log(`  Transcript cached: ${talkRkey}`);
    return JSON.parse(readFileSync(cachedPath, "utf-8"));
  }

  // Extract audio
  const audioPath = extractAudio(videoUri, talkRkey);

  // Transcribe
  console.log(`  Transcribing ${talkRkey}...`);
  const result = await provider(audioPath);

  // Cache result
  writeFileSync(cachedPath, JSON.stringify(result, null, 2));
  console.log(`  Saved transcript: ${cachedPath}`);

  return result;
}

// CLI entry point: transcribe all talks that have a video but no transcript
async function main() {
  const db = openDb();
  const talks = db
    .prepare(
      `SELECT t.rkey, t.video_uri FROM talks t
       JOIN pipeline_status ps ON t.uri = ps.talk_uri
       WHERE t.video_uri IS NOT NULL AND ps.transcribed = 0
       LIMIT 5`
    )
    .all() as Array<{ rkey: string; video_uri: string }>;

  console.log(`${talks.length} talks to transcribe`);

  for (const talk of talks) {
    try {
      await transcribeTalk(talk.rkey, talk.video_uri);
      db.prepare(
        `UPDATE pipeline_status SET transcribed = 1, updated_at = CURRENT_TIMESTAMP
         WHERE talk_uri = (SELECT uri FROM talks WHERE rkey = ?)`
      ).run(talk.rkey);
    } catch (err) {
      console.error(`  Failed: ${talk.rkey}:`, (err as Error).message);
    }
  }

  db.close();
}

// Only run main when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
```

- [ ] **Step 2: Add transcribe script to appview package.json**

Add to scripts:
```json
"transcribe": "tsx src/transcribe.ts"
```

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/transcribe.ts
git commit -m "feat: transcription pipeline skeleton with provider interface and caching"
```

---

## Chunk 5: Document Assembly & Timestamp Provider

Converts raw transcripts into RelationalText documents with timestamp facets, and implements the frontend timestamp sync.

### Task 11: Document assembly — transcript to RelationalText

**Files:**
- Create: `formats/tv.ionosphere/ts/assemble.ts`
- Create: `formats/tv.ionosphere/ts/assemble.test.ts`

- [ ] **Step 1: Write test for document assembly**

```typescript
import { describe, it, expect } from "vitest";
import { assembleDocument, type TranscriptInput } from "./assemble.js";

describe("assembleDocument", () => {
  const transcript: TranscriptInput = {
    text: "Hello world this is a test",
    words: [
      { word: "Hello", start: 0.0, end: 0.5, confidence: 0.99 },
      { word: "world", start: 0.5, end: 1.0, confidence: 0.98 },
      { word: "this", start: 1.0, end: 1.3, confidence: 0.97 },
      { word: "is", start: 1.3, end: 1.5, confidence: 0.99 },
      { word: "a", start: 1.5, end: 1.6, confidence: 0.99 },
      { word: "test", start: 1.6, end: 2.0, confidence: 0.95 },
    ],
  };

  it("creates a document with text matching the transcript", () => {
    const doc = assembleDocument(transcript);
    expect(doc.text).toBe("Hello world this is a test");
  });

  it("creates timestamp facets for each word", () => {
    const doc = assembleDocument(transcript);
    const timestampFacets = doc.facets.filter((f: any) =>
      f.features.some((feat: any) => feat.$type === "tv.ionosphere.facet#timestamp")
    );
    expect(timestampFacets).toHaveLength(6);
  });

  it("timestamp facets have correct byte ranges", () => {
    const doc = assembleDocument(transcript);
    const first = doc.facets.find((f: any) =>
      f.features.some(
        (feat: any) =>
          feat.$type === "tv.ionosphere.facet#timestamp" &&
          feat.startTime === 0
      )
    );
    expect(first).toBeDefined();
    expect(first!.index.byteStart).toBe(0);
    expect(first!.index.byteEnd).toBe(5); // "Hello" = 5 bytes
  });

  it("timestamp times are in nanoseconds", () => {
    const doc = assembleDocument(transcript);
    const first = doc.facets[0];
    const ts = first.features.find(
      (f: any) => f.$type === "tv.ionosphere.facet#timestamp"
    );
    expect(ts.startTime).toBe(0);
    expect(ts.endTime).toBe(500_000_000); // 0.5s in ns
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd formats/tv.ionosphere && pnpm test`

- [ ] **Step 3: Implement assemble.ts**

```typescript
export interface WordTimestamp {
  word: string;
  start: number; // seconds
  end: number; // seconds
  confidence: number;
}

export interface TranscriptInput {
  text: string;
  words: WordTimestamp[];
}

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, any>>;
}

export interface Document {
  text: string;
  facets: Facet[];
}

function secondsToNs(s: number): number {
  return Math.round(s * 1e9);
}

export function assembleDocument(transcript: TranscriptInput): Document {
  const encoder = new TextEncoder();
  const facets: Facet[] = [];

  // Build byte offset map by finding each word in the text
  let searchFrom = 0;
  for (const word of transcript.words) {
    const idx = transcript.text.indexOf(word.word, searchFrom);
    if (idx === -1) continue;

    const byteStart = encoder.encode(transcript.text.slice(0, idx)).length;
    const byteEnd =
      encoder.encode(transcript.text.slice(0, idx + word.word.length)).length;

    facets.push({
      index: { byteStart, byteEnd },
      features: [
        {
          $type: "tv.ionosphere.facet#timestamp",
          startTime: secondsToNs(word.start),
          endTime: secondsToNs(word.end),
        },
      ],
    });

    searchFrom = idx + word.word.length;
  }

  return { text: transcript.text, facets };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd formats/tv.ionosphere && pnpm test`

- [ ] **Step 5: Commit**

```bash
git add formats/tv.ionosphere/ts/assemble.ts formats/tv.ionosphere/ts/assemble.test.ts
git commit -m "feat: assemble RelationalText documents from transcripts with timestamp facets"
```

### Task 12: Timestamp provider and transcript sync in frontend

**Files:**
- Create: `apps/ionosphere/src/app/components/TimestampProvider.tsx`
- Create: `apps/ionosphere/src/app/components/TranscriptView.tsx`

- [ ] **Step 1: Create TimestampProvider**

```tsx
"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";

interface TimestampContextValue {
  currentTimeNs: number;
  setCurrentTimeNs: (ns: number) => void;
  seekTo: (ns: number) => void;
  onSeek: (handler: (ns: number) => void) => () => void;
}

const TimestampContext = createContext<TimestampContextValue | null>(null);

export function useTimestamp() {
  const ctx = useContext(TimestampContext);
  if (!ctx) throw new Error("useTimestamp must be used within TimestampProvider");
  return ctx;
}

export function TimestampProvider({ children }: { children: ReactNode }) {
  const [currentTimeNs, setCurrentTimeNs] = useState(0);
  const [seekHandlers] = useState<Set<(ns: number) => void>>(new Set());

  const seekTo = useCallback(
    (ns: number) => {
      for (const handler of seekHandlers) {
        handler(ns);
      }
    },
    [seekHandlers]
  );

  const onSeek = useCallback(
    (handler: (ns: number) => void) => {
      seekHandlers.add(handler);
      return () => seekHandlers.delete(handler);
    },
    [seekHandlers]
  );

  return (
    <TimestampContext.Provider
      value={{ currentTimeNs, setCurrentTimeNs, seekTo, onSeek }}
    >
      {children}
    </TimestampContext.Provider>
  );
}
```

- [ ] **Step 2: Create TranscriptView**

```tsx
"use client";

import { useTimestamp } from "./TimestampProvider";
import { useRef, useEffect } from "react";

interface TranscriptFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{
    $type: string;
    startTime?: number;
    endTime?: number;
    [key: string]: any;
  }>;
}

interface TranscriptDocument {
  text: string;
  facets: TranscriptFacet[];
}

interface TranscriptViewProps {
  document: TranscriptDocument;
}

interface WordSpan {
  text: string;
  startTime: number;
  endTime: number;
  byteStart: number;
  byteEnd: number;
}

function extractWordSpans(doc: TranscriptDocument): WordSpan[] {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(doc.text);
  const decoder = new TextDecoder();

  return doc.facets
    .filter((f) =>
      f.features.some((feat) => feat.$type === "tv.ionosphere.facet#timestamp")
    )
    .map((f) => {
      const ts = f.features.find(
        (feat) => feat.$type === "tv.ionosphere.facet#timestamp"
      )!;
      return {
        text: decoder.decode(textBytes.slice(f.index.byteStart, f.index.byteEnd)),
        startTime: ts.startTime!,
        endTime: ts.endTime!,
        byteStart: f.index.byteStart,
        byteEnd: f.index.byteEnd,
      };
    })
    .sort((a, b) => a.byteStart - b.byteStart);
}

export default function TranscriptView({ document }: TranscriptViewProps) {
  const { currentTimeNs, seekTo } = useTimestamp();
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLSpanElement>(null);

  const words = extractWordSpans(document);

  // Auto-scroll to active word
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [currentTimeNs]);

  return (
    <div
      ref={containerRef}
      className="mt-8 p-6 rounded-lg border border-neutral-800 max-h-96 overflow-y-auto leading-relaxed"
    >
      {words.map((word, i) => {
        const isActive =
          currentTimeNs >= word.startTime && currentTimeNs < word.endTime;

        return (
          <span
            key={i}
            ref={isActive ? activeRef : undefined}
            onClick={() => seekTo(word.startTime)}
            className={`cursor-pointer transition-colors ${
              isActive
                ? "bg-blue-500/30 text-white rounded px-0.5"
                : "text-neutral-300 hover:text-white"
            }`}
          >
            {word.text}{" "}
          </span>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Update VideoPlayer to integrate with TimestampProvider**

Update `apps/ionosphere/src/app/components/VideoPlayer.tsx` to use the timestamp context:

Add to the component, after existing imports:
```tsx
import { useTimestamp } from "./TimestampProvider";
```

Replace the `onTimeUpdate` prop pattern with context-based time broadcasting and seek listening. The component should call `setCurrentTimeNs` on video timeupdate events, and listen for `onSeek` calls to seek the video element.

- [ ] **Step 4: Update talk page to use TimestampProvider and TranscriptView**

Wrap the talk page content in `<TimestampProvider>` and conditionally render `<TranscriptView>` when a document is available.

- [ ] **Step 5: Verify end-to-end**

With a talk that has a transcript in the database, verify:
1. Video plays
2. Transcript words highlight as video plays
3. Clicking a word seeks the video

- [ ] **Step 6: Commit**

```bash
git add apps/ionosphere/src/app/components/
git commit -m "feat: timestamp provider and synchronized transcript view"
```

---

## Chunk 6: LLM Enrichment Pipeline (Future)

This chunk covers LLM-assisted semantic enrichment of transcripts. It is deferred until transcription is working and validated on the corpus. The implementation will:

1. Pass transcript text + talk context to an LLM
2. Extract concept mentions, speaker references, talk cross-references, and links
3. Create `tv.ionosphere.concept` records and annotation layers
4. Store enrichment results as `pub.layers.annotation` layers on the document
5. Update the appview index with concept/speaker/crossref join tables

This is documented but not planned in detail yet — the exact approach depends on transcript quality and cost evaluation.

---

## Summary

| Chunk | Tasks | What it delivers |
|-------|-------|------------------|
| 1: Scaffold & Lexicons | 1-3 | Workspace, lexicons, format-lexicon |
| 2: Appview & Ingest | 4-5 | SQLite schema, REST API, data ingest pipeline |
| 3: Frontend | 6-8 | Next.js SSG, talk/speaker/concept pages, video player |
| 4: Transcription | 9-10 | Audio extraction, transcription pipeline skeleton |
| 5: Document Assembly | 11-12 | RelationalText documents, timestamp sync, transcript view |
| 6: Enrichment | (future) | LLM annotation, concept extraction, knowledge graph |
