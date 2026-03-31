# Lens Layer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom lens runtime with panproto, making all schema boundaries declarative and forwards-compatible.

**Architecture:** `@panproto/core` provides the lens runtime via WASM. Source lexicons (calendar events, VOD records, Whisper output) are stored alongside ionosphere lexicons. Panproto auto-generates lenses from lexicon pairs. Serialized protolens chains are stored as AT Protocol records on the PDS, indexed by the appview, and resolved at runtime by pipeline scripts.

**Tech Stack:** `@panproto/core` (WASM, TypeScript SDK), AT Protocol lexicons, `@ionosphere/format` (workspace package), Vitest.

**Spec:** `docs/superpowers/specs/2026-03-31-lens-layer-design.md`

---

## File Map

### New files
- `lexicons/community/lexicon/calendar/event.json` — source lexicon for ATmosphereConf schedule events
- `lexicons/place/stream/video.json` — source lexicon for Streamplace VOD records
- `lexicons/openai/whisper/verbose_json.json` — source lexicon for Whisper API output
- `formats/tv.ionosphere/ts/panproto.ts` — thin panproto wrapper (init, loadSchema, convert, resolve)
- `formats/tv.ionosphere/ts/panproto.test.ts` — lens law + conversion tests
- `apps/ionosphere-appview/src/lens-resolver.ts` — pipeline-side lens resolution (appview index → PDS fetch)

### Modified files
- `formats/tv.ionosphere/package.json` — add `@panproto/core` dependency
- `formats/tv.ionosphere/ts/lenses.ts` — delete contents, re-export from panproto.ts
- `formats/tv.ionosphere/ts/lenses.test.ts` — delete old tests
- `apps/ionosphere-appview/package.json` — add `@panproto/core` dependency
- `apps/ionosphere-appview/src/db.ts` — add `lenses` table to migration
- `apps/ionosphere-appview/src/indexer.ts` — add `org.relationaltext.lens` collection handling
- Note: `backfill.ts` imports `IONOSPHERE_COLLECTIONS` from `indexer.ts` — no direct modification needed
- `apps/ionosphere-appview/src/publish.ts` — add step 0: publish lens records
- `apps/ionosphere-appview/src/ingest.ts` — replace `loadLens`/`applyLens` with panproto convert
- `apps/ionosphere-appview/src/providers/openai-whisper.ts` — replace ad-hoc mapping with lens

### Deleted (contents replaced)
- `formats/tv.ionosphere/lenses/*.lens.json` — replaced by source lexicons + auto-generation

---

## Chunk 1: Panproto Foundation

Install `@panproto/core`, create the thin wrapper, verify it works with ATProto lexicons.

### Task 1: Install @panproto/core

**Files:**
- Modify: `formats/tv.ionosphere/package.json`
- Modify: `apps/ionosphere-appview/package.json`

- [ ] **Step 1: Add dependency to format package**

```bash
cd formats/tv.ionosphere && pnpm add @panproto/core
```

- [ ] **Step 2: Add dependency to appview package**

```bash
cd apps/ionosphere-appview && pnpm add @panproto/core
```

- [ ] **Step 3: Verify install**

```bash
cd /Users/blainecook/Code/skeetv && pnpm install
```

Expected: Clean install, no errors.

- [ ] **Step 4: Commit**

```bash
git add formats/tv.ionosphere/package.json apps/ionosphere-appview/package.json pnpm-lock.yaml
git commit -m "chore: add @panproto/core dependency"
```

### Task 2: Add source lexicons

We need the lexicon JSON for the schemas we don't own — the source side of each lens. These are authored based on the actual record shapes from the source PDSes.

**Files:**
- Create: `lexicons/community/lexicon/calendar/event.json`
- Create: `lexicons/place/stream/video.json`
- Create: `lexicons/openai/whisper/verbose_json.json`

- [ ] **Step 1: Fetch a sample calendar event record to verify field names**

```bash
curl -s "https://bsky.social/xrpc/com.atproto.repo.listRecords?repo=did:plc:3xewinw4wtimo2lqfy5fm5sw&collection=community.lexicon.calendar.event&limit=1" | python3 -m json.tool | head -50
```

Use the output to verify the lexicon fields match the actual record shape.

- [ ] **Step 2: Write `lexicons/community/lexicon/calendar/event.json`**

Create the lexicon based on the actual ATmosphereConf schedule event record shape. Must include: `name`, `description`, `startsAt`, `endsAt`, `status`, `additionalData` (object with `room`, `category`, `type`, `speakers`, `isAtmosphereconf`).

- [ ] **Step 3: Fetch a sample VOD record to verify field names**

```bash
curl -s "https://iameli.com/xrpc/com.atproto.repo.listRecords?repo=did:plc:rbvrr34edl5ddpuwcubjiost&collection=place.stream.video&limit=1" | python3 -m json.tool | head -50
```

- [ ] **Step 4: Write `lexicons/place/stream/video.json`**

Based on actual Streamplace VOD record shape. Must include: `title`, `duration`, `creator`, `createdAt`.

- [ ] **Step 5: Write `lexicons/openai/whisper/verbose_json.json`**

Based on the OpenAI Whisper verbose_json response format. Must include: `text`, `words` (array of `{ word, start, end }`).

Note: OpenAI's Whisper output is not an ATProto record. Create the lexicon as a schema description of its shape so panproto can parse it. If `parseLexicon` doesn't accept non-ATProto schemas for this case, use `panproto.protocol('json-schema')` instead and adjust accordingly.

- [ ] **Step 6: Commit**

```bash
git add lexicons/community/ lexicons/place/ lexicons/openai/
git commit -m "feat: add source lexicons for calendar events, VOD records, and Whisper output"
```

### Task 3: Create panproto wrapper

**Files:**
- Create: `formats/tv.ionosphere/ts/panproto.ts`
- Create: `formats/tv.ionosphere/ts/panproto.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// formats/tv.ionosphere/ts/panproto.test.ts
import { describe, it, expect } from "vitest";
import { init, loadSchema, convert } from "./panproto.js";
import { readFileSync } from "node:fs";
import path from "node:path";

const LEXICON_DIR = path.resolve(import.meta.dirname, "../../../lexicons");

function readLexicon(relativePath: string): object {
  return JSON.parse(
    readFileSync(path.join(LEXICON_DIR, relativePath), "utf-8")
  );
}

describe("panproto wrapper", () => {
  it("initializes panproto", async () => {
    const pp = await init();
    expect(pp).toBeDefined();
    // ATProto should be a built-in protocol
    expect(pp.listProtocols()).toContain("atproto");
  });

  it("parses an ionosphere lexicon", async () => {
    const schema = await loadSchema(
      readLexicon("tv/ionosphere/talk.json")
    );
    expect(schema).toBeDefined();
    expect(schema.data).toBeDefined();
  });

  it("converts a calendar event to a talk", async () => {
    const calendarSchema = await loadSchema(
      readLexicon("community/lexicon/calendar/event.json")
    );
    const talkSchema = await loadSchema(
      readLexicon("tv/ionosphere/talk.json")
    );

    const event = {
      name: "Building with AT Protocol",
      description: "A talk about building apps",
      startsAt: "2026-03-27T10:00:00Z",
      endsAt: "2026-03-27T10:30:00Z",
      additionalData: {
        room: "Great Hall South",
        category: "developer",
        type: "presentation",
        speakers: [{ id: "alice.bsky.social", name: "Alice" }],
        isAtmosphereconf: true,
      },
    };

    const result = await convert(event, calendarSchema, talkSchema, {
      eventUri: "",
    });

    expect(result).toBeDefined();
    // Verify key fields were mapped
    expect((result as any).title).toBe("Building with AT Protocol");
    expect((result as any).room).toBe("Great Hall South");
    expect((result as any).startsAt).toBe("2026-03-27T10:00:00Z");
  });

  it("verifies lens laws for calendar→talk lens", async () => {
    const calendarSchema = await loadSchema(
      readLexicon("community/lexicon/calendar/event.json")
    );
    const talkSchema = await loadSchema(
      readLexicon("tv/ionosphere/talk.json")
    );

    const pp = await init();
    const lens = pp.lens(calendarSchema, talkSchema);
    expect(lens).toBeDefined();

    // Verify GetPut and PutGet laws hold on a sample record
    const { encode } = await import("@msgpack/msgpack");
    const sampleEvent = encode({
      name: "Test Talk",
      description: "A test",
      startsAt: "2026-03-27T10:00:00Z",
      endsAt: "2026-03-27T10:30:00Z",
      additionalData: {
        room: "Room A",
        category: "dev",
        type: "presentation",
        speakers: [],
        isAtmosphereconf: true,
      },
    });
    const laws = lens.checkLaws(sampleEvent);
    expect(laws.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd formats/tv.ionosphere && pnpm test -- panproto.test
```

Expected: FAIL — `./panproto.js` not found.

- [ ] **Step 3: Write the panproto wrapper**

```typescript
// formats/tv.ionosphere/ts/panproto.ts
import { Panproto, type LensHandle, type BuiltSchema } from "@panproto/core";

let _panproto: Panproto | null = null;

/**
 * Initialize the panproto runtime (lazy singleton).
 * WASM is loaded once and reused across all calls.
 */
export async function init(): Promise<Panproto> {
  if (!_panproto) _panproto = await Panproto.init();
  return _panproto;
}

/**
 * Parse an ATProto lexicon JSON into a panproto schema.
 */
export async function loadSchema(
  lexiconJson: object | string
): Promise<BuiltSchema> {
  const pp = await init();
  return pp.parseLexicon(lexiconJson);
}

/**
 * Create a lens between two schemas.
 */
export async function createLens(
  from: BuiltSchema,
  to: BuiltSchema
): Promise<LensHandle> {
  const pp = await init();
  return pp.lens(from, to);
}

/**
 * Convert a record from one schema to another using an auto-generated lens.
 * Plain JS objects in, plain JS objects out.
 */
export async function convert(
  data: object,
  from: BuiltSchema,
  to: BuiltSchema,
  defaults?: Record<string, unknown>
): Promise<unknown> {
  const pp = await init();
  return pp.convert(data, { from, to, defaults });
}

/**
 * Generate and serialize a protolens chain between two schemas.
 * Used by publish.ts to create lens records for the PDS.
 */
export async function serializeChain(
  from: BuiltSchema,
  to: BuiltSchema
): Promise<string> {
  const pp = await init();
  const chain = pp.protolensChain(from, to);
  return chain.toJson();
}

// Re-export types that pipeline scripts need
export type { LensHandle, BuiltSchema, Panproto };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd formats/tv.ionosphere && pnpm test -- panproto.test
```

Expected: All 4 tests pass. If `parseLexicon` doesn't handle a source lexicon (Whisper is not ATProto), note the issue and adjust the test — we may need `protocol('json-schema')` for that one.

- [ ] **Step 5: Commit**

```bash
git add formats/tv.ionosphere/ts/panproto.ts formats/tv.ionosphere/ts/panproto.test.ts
git commit -m "feat: panproto wrapper for lens operations"
```

### Task 4: Add panproto export path

**Files:**
- Modify: `formats/tv.ionosphere/package.json` (exports)

- [ ] **Step 1: Update package.json exports**

Add panproto export path to `formats/tv.ionosphere/package.json`:

```json
"exports": {
  ".": "./ts/index.ts",
  "./assemble": "./ts/assemble.ts",
  "./lenses": "./ts/lenses.ts",
  "./panproto": "./ts/panproto.ts",
  "./transcript-encoding": "./ts/transcript-encoding.ts"
}
```

Note: `lenses.ts` keeps its current exports for now — `ingest.ts` still imports from it. We'll replace it in Chunk 4 after the pipeline is rewired.

- [ ] **Step 2: Run all format tests**

```bash
cd formats/tv.ionosphere && pnpm test
```

Expected: All tests pass (lenses, panproto, transcript-encoding, assemble).

- [ ] **Step 3: Commit**

```bash
git add formats/tv.ionosphere/package.json
git commit -m "chore: add panproto export path to format package"
```

---

## Chunk 2: Appview Lens Indexing

Add lens records to the appview's indexer, database, and backfill so lenses are discoverable.

### Task 5: Add lenses table to database

**Files:**
- Modify: `apps/ionosphere-appview/src/db.ts:19-147` (inside `migrate` function)

- [ ] **Step 1: Add the lenses table to the migration**

Add this SQL to the `migrate` function in `db.ts`, after the `annotations` table and before the `_cursor` table:

```sql
CREATE TABLE IF NOT EXISTS lenses (
  uri TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  rkey TEXT NOT NULL,
  source_nsid TEXT,
  target_nsid TEXT,
  version INTEGER DEFAULT 1,
  chain_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 2: Verify the appview starts cleanly**

```bash
cd apps/ionosphere-appview && PORT=9401 npx tsx src/appview.ts &
sleep 3 && curl -s http://localhost:9401/health | python3 -m json.tool
kill %1
```

Expected: `{"status": "ok"}`. The new table is created alongside existing tables.

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/db.ts
git commit -m "feat: add lenses table to appview schema"
```

### Task 6: Index lens records

**Files:**
- Modify: `apps/ionosphere-appview/src/indexer.ts`

- [ ] **Step 1: Add `org.relationaltext.lens` to IONOSPHERE_COLLECTIONS**

In `indexer.ts`, add to the `IONOSPHERE_COLLECTIONS` array:

```typescript
export const IONOSPHERE_COLLECTIONS = [
  "tv.ionosphere.event",
  "tv.ionosphere.talk",
  "tv.ionosphere.speaker",
  "tv.ionosphere.concept",
  "tv.ionosphere.transcript",
  "tv.ionosphere.annotation",
  "org.relationaltext.lens",
];
```

- [ ] **Step 2: Add delete handler for lenses**

In the `processEvent` function's delete switch statement, add:

```typescript
case "org.relationaltext.lens":
  db.prepare("DELETE FROM lenses WHERE uri = ?").run(uri);
  break;
```

- [ ] **Step 3: Add create/update handler for lenses**

Add a new case in the create/update switch and the indexer function:

```typescript
case "org.relationaltext.lens":
  indexLens(db, event.did, rkey, uri, record);
  break;
```

```typescript
function indexLens(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  db.prepare(
    `INSERT OR REPLACE INTO lenses
     (uri, did, rkey, source_nsid, target_nsid, version, chain_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri,
    did,
    rkey,
    (record.source as string) || null,
    (record.target as string) || null,
    (record.version as number) || 1,
    record.chainJson ? JSON.stringify(record.chainJson) : null
  );
}
```

- [ ] **Step 4: Run existing tests**

```bash
cd apps/ionosphere-appview && pnpm test
```

Expected: Existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere-appview/src/indexer.ts
git commit -m "feat: index org.relationaltext.lens records in appview"
```

### Task 7: Create lens resolver

The lens resolver is used by pipeline scripts to find the right lens for a source→target pair. It checks the appview index first, then falls back to fetching directly from the PDS.

**Files:**
- Create: `apps/ionosphere-appview/src/lens-resolver.ts`

- [ ] **Step 1: Write the lens resolver**

```typescript
// apps/ionosphere-appview/src/lens-resolver.ts
import type Database from "better-sqlite3";

const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.test";

interface ResolvedLens {
  chainJson: string;
  source: string;
  target: string;
}

/**
 * Resolve a lens by source and target NSID.
 *
 * Resolution order:
 * 1. Appview SQLite index (fast, local)
 * 2. PDS direct fetch (always available after publish)
 * 3. null (not found)
 */
export async function resolveLensRecord(
  source: string,
  target: string,
  db?: Database.Database
): Promise<ResolvedLens | null> {
  // 1. Try appview index first (if db handle provided)
  if (db) {
    const row = db
      .prepare(
        "SELECT source_nsid, target_nsid, chain_json FROM lenses WHERE source_nsid = ? AND target_nsid = ? LIMIT 1"
      )
      .get(source, target) as any;
    if (row?.chain_json) {
      return {
        chainJson: row.chain_json,
        source: row.source_nsid,
        target: row.target_nsid,
      };
    }
  }

  // 2. Fall back to PDS direct fetch
  try {
    const handleRes = await fetch(
      `${PDS_URL}/xrpc/com.atproto.identity.resolveHandle?handle=${BOT_HANDLE}`
    );
    if (!handleRes.ok) return null;
    const { did } = (await handleRes.json()) as { did: string };

    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({
        repo: did,
        collection: "org.relationaltext.lens",
        limit: "100",
      });
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(
        `${PDS_URL}/xrpc/com.atproto.repo.listRecords?${params}`
      );
      if (!res.ok) return null;
      const data = await res.json();

      for (const record of data.records || []) {
        const v = record.value;
        if (v.source === source && v.target === target) {
          return {
            chainJson: v.chainJson,
            source: v.source,
            target: v.target,
          };
        }
      }

      cursor = data.cursor;
    } while (cursor);
  } catch {
    // PDS not available
  }

  return null;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere-appview/src/lens-resolver.ts
git commit -m "feat: lens resolver with PDS fetch fallback"
```

---

## Chunk 3: Pipeline Integration

Wire panproto lenses into the actual pipeline scripts: publish, ingest, transcribe.

### Task 8: Publish lens records

**Files:**
- Modify: `apps/ionosphere-appview/src/publish.ts`

- [ ] **Step 1: Add lens publishing as step 0**

Add at the top of the `main()` function in `publish.ts`, before publishing events. This reads the source and target lexicons, auto-generates a protolens chain, serializes it, and writes a lens record to the PDS.

```typescript
// 0. Publish lens records
console.log("Publishing lens records...");
const { loadSchema, serializeChain } = await import("@ionosphere/format/panproto");
const lexiconDir = path.resolve(import.meta.dirname, "../../../lexicons");

async function publishLens(
  sourceLexiconPath: string,
  targetLexiconPath: string,
  rkey: string
) {
  const sourceLexicon = JSON.parse(
    readFileSync(path.join(lexiconDir, sourceLexiconPath), "utf-8")
  );
  const targetLexicon = JSON.parse(
    readFileSync(path.join(lexiconDir, targetLexiconPath), "utf-8")
  );

  const sourceSchema = await loadSchema(sourceLexicon);
  const targetSchema = await loadSchema(targetLexicon);
  const chainJson = await serializeChain(sourceSchema, targetSchema);

  const sourceNsid = sourceLexicon.id;
  const targetNsid = targetLexicon.id;

  await pds.putRecord("org.relationaltext.lens", rkey, {
    $type: "org.relationaltext.lens",
    source: sourceNsid,
    target: targetNsid,
    version: 1,
    chainJson,
  });

  console.log(`  Lens: ${sourceNsid} → ${targetNsid}`);
}

await publishLens(
  "community/lexicon/calendar/event.json",
  "tv/ionosphere/talk.json",
  "calendar-event-to-talk-v1"
);
await publishLens(
  "place/stream/video.json",
  "tv/ionosphere/talk.json",
  "vod-to-talk-v1"
);
// Whisper lens only if the lexicon works with parseLexicon
// (may need json-schema protocol instead — test in Task 3)
```

- [ ] **Step 2: Test publish**

```bash
cd apps/ionosphere-appview && npx tsx src/publish.ts
```

Expected: "Publishing lens records..." followed by lens creation messages, then the normal event/speaker/talk/transcript publishing.

- [ ] **Step 3: Verify lens records on PDS**

```bash
DID=$(curl -s "http://localhost:2690/xrpc/com.atproto.identity.resolveHandle?handle=ionosphere.test" | python3 -c "import sys,json; print(json.load(sys.stdin)['did'])")
curl -s "http://localhost:2690/xrpc/com.atproto.repo.listRecords?repo=$DID&collection=org.relationaltext.lens&limit=10" | python3 -m json.tool
```

Expected: Lens records visible on PDS.

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere-appview/src/publish.ts
git commit -m "feat: publish lens records to PDS"
```

### Task 9: Wire panproto into ingest.ts

**Files:**
- Modify: `apps/ionosphere-appview/src/ingest.ts`

- [ ] **Step 1: Replace loadLens/applyLens with panproto convert**

In `ingest.ts`:

1. Remove the imports of `loadLens` and `applyLens` from `@ionosphere/format/lenses`
2. Add panproto imports
3. Replace `parseScheduleEvent` to use panproto convert
4. Replace `parseVodRecord` to use panproto convert (currently ad-hoc)

The key change in `parseScheduleEvent`:

```typescript
// Before:
const mapped = applyLens(scheduleLens, v);

// After:
const mapped = await convert(v, calendarSchema, talkSchema, {
  eventUri: "",
});
```

Note: `ingest.ts` currently does filtering logic (skip cancelled, skip info/food types) before applying the lens. This filtering stays as TypeScript — it's not a schema transform, it's business logic.

Also note: `ingest.ts` writes to a local staging SQLite, not the PDS. The lens is used to normalize source field names, not to produce final PDS records.

- [ ] **Step 2: Initialize panproto and load schemas at top of main()**

```typescript
import { init as initPanproto, loadSchema, convert } from "@ionosphere/format/panproto";
// ... at top of main():
const pp = await initPanproto();

const calendarLexicon = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, "../../../lexicons/community/lexicon/calendar/event.json"),
    "utf-8"
  )
);
const talkLexicon = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, "../../../lexicons/tv/ionosphere/talk.json"),
    "utf-8"
  )
);
const calendarSchema = pp.parseLexicon(calendarLexicon);
const talkSchema = pp.parseLexicon(talkLexicon);
```

- [ ] **Step 3: Test ingest still works**

```bash
cd apps/ionosphere-appview && npx tsx src/ingest.ts
```

Expected: Same output as before — schedule events fetched, VODs fetched, correlated, ingested. The lens is applied transparently.

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere-appview/src/ingest.ts
git commit -m "refactor: use panproto lenses in ingest pipeline"
```

### Task 10: Wire panproto into Whisper provider

**Files:**
- Modify: `apps/ionosphere-appview/src/providers/openai-whisper.ts`

- [ ] **Step 1: Evaluate Whisper lens feasibility**

The Whisper provider currently does a simple mapping: `{ word, start, end }` → `{ word, start, end, confidence: 1.0 }`. This is ad-hoc in `openai-whisper.ts:25-30`.

Check whether `parseLexicon` works with the Whisper lexicon we created. If the Whisper output isn't an ATProto record, we may need `pp.protocol('json-schema')` to create the schema.

If panproto can't handle this boundary (Whisper output isn't really a lexicon), **keep the ad-hoc mapping** and add a comment noting it as a future graduation candidate. The calendar→talk and VOD→talk lenses are the high-value boundaries.

- [ ] **Step 2: If feasible, replace the ad-hoc mapping with lens convert**

Replace lines 25-30 in `openai-whisper.ts` with a panproto convert call. If not feasible, add a comment:

```typescript
// Lens candidate: Whisper output → ionosphere transcript format.
// Currently ad-hoc because Whisper output is not an ATProto record.
// Migrate when panproto's json-schema protocol supports this shape.
```

- [ ] **Step 3: Test transcription still works**

```bash
cd apps/ionosphere-appview && npx tsx src/transcribe.ts
```

Expected: Provider still returns correctly formatted transcript data.

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere-appview/src/providers/openai-whisper.ts
git commit -m "refactor: evaluate and document Whisper lens boundary"
```

---

## Chunk 4: Cleanup and Verification

Remove old lens code and files, run full test suite, verify end-to-end.

### Task 11: Replace old lens implementation

Now that the pipeline is wired to panproto, replace the old `lenses.ts` with re-exports.

**Files:**
- Modify: `formats/tv.ionosphere/ts/lenses.ts`
- Modify: `formats/tv.ionosphere/ts/lenses.test.ts`

- [ ] **Step 1: Update lenses.ts to re-export from panproto**

Replace the entire contents of `formats/tv.ionosphere/ts/lenses.ts` with:

```typescript
// Legacy export path — re-exports from panproto wrapper.
// Pipeline code should import from "./panproto.js" directly.
export { init, loadSchema, createLens, convert, serializeChain } from "./panproto.js";
export type { LensHandle, BuiltSchema, Panproto } from "./panproto.js";
```

- [ ] **Step 2: Update lenses.test.ts**

Replace with a single smoke test that verifies the re-export works:

```typescript
import { describe, it, expect } from "vitest";
import { init } from "./lenses.js";

describe("lenses re-export", () => {
  it("re-exports init from panproto", async () => {
    const pp = await init();
    expect(pp).toBeDefined();
  });
});
```

- [ ] **Step 3: Run all format tests**

```bash
cd formats/tv.ionosphere && pnpm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add formats/tv.ionosphere/ts/lenses.ts formats/tv.ionosphere/ts/lenses.test.ts
git commit -m "refactor: replace custom lens runtime with panproto re-export"
```

### Task 12: Remove old lens JSON files

**Files:**
- Delete contents of: `formats/tv.ionosphere/lenses/` directory

- [ ] **Step 1: Remove old lens spec files**

The `lenses/` directory contained our custom lens JSON specs. These are superseded by the source lexicons + panproto auto-generation.

```bash
rm formats/tv.ionosphere/lenses/*.lens.json
```

- [ ] **Step 2: Add a README to the lenses directory**

Create `formats/tv.ionosphere/lenses/README.md`:

```markdown
# Lenses

Lens generation is now handled by panproto from source and target lexicon pairs.
See `lexicons/` for source schemas and `docs/superpowers/specs/2026-03-31-lens-layer-design.md` for details.
```

- [ ] **Step 3: Commit**

```bash
git add formats/tv.ionosphere/lenses/
git commit -m "chore: remove old custom lens specs, replaced by panproto"
```

### Task 13: Full verification

- [ ] **Step 1: Run format package tests**

```bash
cd formats/tv.ionosphere && pnpm test
```

Expected: All tests pass.

- [ ] **Step 2: Run appview tests**

```bash
cd apps/ionosphere-appview && pnpm test
```

Expected: All tests pass.

- [ ] **Step 3: Run typecheck across workspace**

```bash
cd /Users/blainecook/Code/skeetv && pnpm -r typecheck
```

Expected: No type errors.

- [ ] **Step 4: End-to-end verification**

Start the PDS (already running), run publish, start appview, verify lens records are indexed:

```bash
cd apps/ionosphere-appview
npx tsx src/publish.ts
PORT=9401 npx tsx src/appview.ts &
sleep 5
# Verify lenses are in the appview DB
sqlite3 data/ionosphere.sqlite "SELECT source_nsid, target_nsid, version FROM lenses"
kill %1
```

Expected: Lens records visible in the SQLite database.

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A && git status
# Only commit if there are changes
git commit -m "fix: final verification fixes for lens layer"
```
