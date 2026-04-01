# Word Index Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a book-style word concordance at `/index` with Pretext multi-column layout and a fixed player column that shows video + transcript for any clicked word.

**Architecture:** New appview endpoint builds the concordance from transcripts in SQLite. Frontend page uses Pretext for multi-column typesetting, reuses VideoPlayer + TranscriptView in a fixed side panel.

**Tech Stack:** `@chenglou/pretext`, Next.js, existing VideoPlayer/TranscriptView components, Hono API

**Spec:** `docs/superpowers/specs/2026-03-31-word-index-design.md`

---

## File Map

### New files
- `apps/ionosphere-appview/src/stopwords.ts` — stopword list
- `apps/ionosphere-appview/src/concordance.ts` — builds word concordance from transcripts
- `apps/ionosphere-appview/src/concordance.test.ts` — tests
- `apps/ionosphere/src/app/index/page.tsx` — index page (server component, data fetching)
- `apps/ionosphere/src/app/index/IndexContent.tsx` — client component with Pretext layout + player

### Modified files
- `apps/ionosphere-appview/src/routes.ts` — add `GET /index` endpoint
- `apps/ionosphere/src/lib/api.ts` — add `getIndex()` function
- `apps/ionosphere/src/app/layout.tsx` — add "Index" nav link

---

## Chunk 1: Appview Concordance Endpoint

### Task 1: Stopword list

**Files:**
- Create: `apps/ionosphere-appview/src/stopwords.ts`

- [ ] **Step 1: Create stopword module**

```typescript
// apps/ionosphere-appview/src/stopwords.ts

// Standard English stopwords + filler words.
// Intentionally minimal — extend as needed.
const STOPWORDS = new Set([
  // Articles, pronouns, prepositions
  "a", "an", "the", "i", "me", "my", "we", "our", "you", "your",
  "he", "she", "it", "they", "them", "his", "her", "its", "their",
  "this", "that", "these", "those", "who", "whom", "which", "what",
  "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would",
  "shall", "should", "may", "might", "must", "can", "could",
  "not", "no", "nor", "and", "but", "or", "so", "if", "then",
  "than", "too", "very", "just", "also", "only",
  "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "up", "about", "into", "through", "during", "before", "after",
  "above", "below", "between", "out", "off", "over", "under",
  "again", "further", "once", "here", "there", "when", "where",
  "why", "how", "all", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "any", "own", "same",
  "as", "until", "while", "because", "although", "since",
  // Common verbs
  "get", "got", "go", "going", "gone", "come", "came",
  "make", "made", "take", "took", "know", "knew", "think",
  "thought", "see", "saw", "want", "look", "use", "find",
  "give", "tell", "say", "said", "let", "put", "try",
  "need", "keep", "start", "show", "hear", "play", "run",
  "move", "like", "live", "believe", "hold", "bring",
  "happen", "write", "provide", "sit", "stand", "lose",
  "pay", "meet", "include", "continue", "set", "learn",
  "change", "lead", "understand", "watch", "follow", "stop",
  "create", "speak", "read", "allow", "add", "spend", "grow",
  // Filler words
  "um", "uh", "like", "okay", "ok", "well", "right", "yeah",
  "yes", "no", "oh", "ah", "so", "actually", "basically",
  "really", "kind", "sort", "thing", "things", "stuff",
  "gonna", "gotta", "wanna",
  // Pronouns and determiners
  "something", "anything", "everything", "nothing",
  "someone", "anyone", "everyone", "one", "ones",
  // Numbers and common words
  "first", "two", "new", "way", "even", "much", "still",
  "back", "now", "long", "great", "little", "world",
  "good", "big", "old", "different", "lot", "able",
  "don", "doesn", "didn", "won", "wouldn", "couldn",
  "shouldn", "isn", "aren", "wasn", "weren", "hasn",
  "haven", "hadn", "don't", "doesn't", "didn't", "won't",
  "it's", "that's", "there's", "what's", "let's",
  "i'm", "i've", "i'll", "i'd", "we're", "we've", "we'll",
  "you're", "you've", "you'll", "you'd", "they're", "they've",
  "he's", "she's", "we'd", "they'll", "they'd",
]);

export function isStopword(word: string): boolean {
  return STOPWORDS.has(word) || word.length <= 1;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere-appview/src/stopwords.ts
git commit -m "feat: stopword list for concordance index"
```

### Task 2: Concordance builder with tests

**Files:**
- Create: `apps/ionosphere-appview/src/concordance.ts`
- Create: `apps/ionosphere-appview/src/concordance.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// apps/ionosphere-appview/src/concordance.test.ts
import { describe, it, expect } from "vitest";
import { buildConcordance, type ConcordanceEntry } from "./concordance.js";

describe("buildConcordance", () => {
  const transcripts = [
    {
      talkRkey: "talk-1",
      talkTitle: "Building with AT Protocol",
      text: "AT Protocol is a decentralized protocol for social networking",
      startMs: 0,
      timings: [300, 300, -50, 200, 400, 300, -50, 200, 300, 400],
    },
    {
      talkRkey: "talk-2",
      talkTitle: "Decentralized Identity",
      text: "Protocol design for decentralized identity systems",
      startMs: 0,
      timings: [400, 300, -50, 200, 500, 300, 400],
    },
  ];

  it("builds entries sorted alphabetically", () => {
    const entries = buildConcordance(transcripts);
    const words = entries.map((e) => e.word);
    expect(words).toEqual([...words].sort());
  });

  it("excludes stopwords", () => {
    const entries = buildConcordance(transcripts);
    const words = entries.map((e) => e.word);
    expect(words).not.toContain("is");
    expect(words).not.toContain("a");
    expect(words).not.toContain("for");
  });

  it("aggregates across talks with counts", () => {
    const entries = buildConcordance(transcripts);
    const protocol = entries.find((e) => e.word === "protocol");
    expect(protocol).toBeDefined();
    expect(protocol!.talks).toHaveLength(2);
    expect(protocol!.talks[0].count).toBeGreaterThanOrEqual(1);
  });

  it("includes first timestamp for each talk occurrence", () => {
    const entries = buildConcordance(transcripts);
    const protocol = entries.find((e) => e.word === "protocol");
    expect(protocol).toBeDefined();
    for (const talk of protocol!.talks) {
      expect(talk.firstTimestampNs).toBeGreaterThanOrEqual(0);
    }
  });

  it("lowercases all words", () => {
    const entries = buildConcordance(transcripts);
    for (const entry of entries) {
      expect(entry.word).toBe(entry.word.toLowerCase());
    }
  });

  it("handles empty input", () => {
    expect(buildConcordance([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/ionosphere-appview && pnpm test -- concordance.test
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the concordance builder**

```typescript
// apps/ionosphere-appview/src/concordance.ts
import { decode } from "@ionosphere/format/transcript-encoding";
import { isStopword } from "./stopwords.js";

export interface ConcordanceTalkRef {
  rkey: string;
  title: string;
  count: number;
  firstTimestampNs: number;
}

export interface ConcordanceEntry {
  word: string;
  talks: ConcordanceTalkRef[];
  totalCount: number;
}

interface TranscriptInput {
  talkRkey: string;
  talkTitle: string;
  text: string;
  startMs: number;
  timings: number[];
}

/**
 * Build a concordance from a set of transcripts.
 * Returns alphabetized entries with talk references and timestamps.
 */
export function buildConcordance(
  transcripts: TranscriptInput[]
): ConcordanceEntry[] {
  // word → { talk rkey → { count, firstTimestampNs, title } }
  const index = new Map<
    string,
    Map<string, { title: string; count: number; firstTimestampNs: number }>
  >();

  for (const t of transcripts) {
    // Decode compact timings to get word-level timestamps
    const decoded = decode({ text: t.text, startMs: t.startMs, timings: t.timings });
    const words = t.text.split(/\s+/).filter((w) => w.length > 0);

    for (let i = 0; i < words.length; i++) {
      const raw = words[i].toLowerCase().replace(/[^a-z0-9'-]/g, "");
      if (!raw || isStopword(raw)) continue;

      const timestampNs =
        i < decoded.words.length
          ? Math.round(decoded.words[i].start * 1e9)
          : 0;

      if (!index.has(raw)) index.set(raw, new Map());
      const talkMap = index.get(raw)!;

      if (!talkMap.has(t.talkRkey)) {
        talkMap.set(t.talkRkey, {
          title: t.talkTitle,
          count: 1,
          firstTimestampNs: timestampNs,
        });
      } else {
        const ref = talkMap.get(t.talkRkey)!;
        ref.count++;
        if (timestampNs < ref.firstTimestampNs) {
          ref.firstTimestampNs = timestampNs;
        }
      }
    }
  }

  // Convert to sorted array
  const entries: ConcordanceEntry[] = [];
  for (const [word, talkMap] of index) {
    const talks: ConcordanceTalkRef[] = [];
    let totalCount = 0;
    for (const [rkey, ref] of talkMap) {
      talks.push({ rkey, title: ref.title, count: ref.count, firstTimestampNs: ref.firstTimestampNs });
      totalCount += ref.count;
    }
    // Sort talks by count descending
    talks.sort((a, b) => b.count - a.count);
    entries.push({ word, talks, totalCount });
  }

  entries.sort((a, b) => a.word.localeCompare(b.word));
  return entries;
}
```

- [ ] **Step 4: Run tests**

```bash
cd apps/ionosphere-appview && pnpm test -- concordance.test
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere-appview/src/concordance.ts apps/ionosphere-appview/src/concordance.test.ts
git commit -m "feat: concordance builder with tests"
```

### Task 3: Add /index endpoint to appview

**Files:**
- Modify: `apps/ionosphere-appview/src/routes.ts`

- [ ] **Step 1: Add the endpoint**

Read `routes.ts` first, then add a new route before the final `return app`:

```typescript
app.get("/index", (c) => {
  // Get all transcripts with their talk info
  const rows = db
    .prepare(
      `SELECT tr.text, tr.start_ms, tr.timings, t.rkey as talk_rkey, t.title as talk_title
       FROM transcripts tr
       JOIN talks t ON tr.talk_uri = t.uri
       ORDER BY t.starts_at ASC`
    )
    .all() as any[];

  const transcripts = rows.map((r) => ({
    talkRkey: r.talk_rkey,
    talkTitle: r.talk_title,
    text: r.text,
    startMs: r.start_ms,
    timings: JSON.parse(r.timings),
  }));

  const { buildConcordance } = require("./concordance.js");
  const entries = buildConcordance(transcripts);

  return c.json({ entries });
});
```

Note: Use a static import at the top of routes.ts instead of `require` — add `import { buildConcordance } from "./concordance.js";` at the top.

- [ ] **Step 2: Test the endpoint**

```bash
curl -s http://localhost:9401/index | python3 -c "
import sys, json
d = json.load(sys.stdin)
entries = d['entries']
print(f'{len(entries)} words in concordance')
if entries:
    print(f'First: {entries[0][\"word\"]} ({entries[0][\"totalCount\"]} occurrences)')
    print(f'Last: {entries[-1][\"word\"]} ({entries[-1][\"totalCount\"]} occurrences)')
"
```

Note: The appview needs a restart to pick up the new route. Kill and restart it:
```bash
pkill -f "appview.ts"; sleep 2
cd apps/ionosphere-appview && PORT=9401 nohup npx tsx src/appview.ts > /tmp/appview.log 2>&1 &
sleep 5
```

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/routes.ts
git commit -m "feat: add /index concordance endpoint to appview"
```

---

## Chunk 2: Frontend Index Page

### Task 4: Install Pretext and add API function

**Files:**
- Modify: `apps/ionosphere/package.json`
- Modify: `apps/ionosphere/src/lib/api.ts`

- [ ] **Step 1: Install pretext**

```bash
cd apps/ionosphere && pnpm add @chenglou/pretext
```

- [ ] **Step 2: Add getIndex() to api.ts**

Add to `apps/ionosphere/src/lib/api.ts`:

```typescript
export async function getIndex() {
  return fetchApi<{ entries: any[] }>("/index");
}
```

- [ ] **Step 3: Add Index nav link**

In `apps/ionosphere/src/app/layout.tsx`, add after the Concepts nav link:

```tsx
<a href="/index" className="text-sm text-neutral-400 hover:text-neutral-100">Index</a>
```

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere/package.json apps/ionosphere/src/lib/api.ts apps/ionosphere/src/app/layout.tsx pnpm-lock.yaml
git commit -m "feat: install pretext, add index API function and nav link"
```

### Task 5: Index page server component

**Files:**
- Create: `apps/ionosphere/src/app/index/page.tsx`

- [ ] **Step 1: Create the page**

```tsx
// apps/ionosphere/src/app/index/page.tsx
import { getIndex } from "@/lib/api";
import IndexContent from "./IndexContent";

export default async function IndexPage() {
  const { entries } = await getIndex();
  return <IndexContent entries={entries} />;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere/src/app/index/page.tsx
git commit -m "feat: index page server component"
```

### Task 6: IndexContent client component

**Files:**
- Create: `apps/ionosphere/src/app/index/IndexContent.tsx`

This is the main component. It has two panels:
- Left: multi-column word index (Pretext-rendered)
- Right: fixed player column (VideoPlayer + TranscriptView)

- [ ] **Step 1: Create IndexContent**

Read the existing TalkContent.tsx for patterns (TimestampProvider wrapping, VideoPlayer/TranscriptView usage).

The component should:

1. Take `entries` as props (from server component)
2. Maintain state: `selectedTalk` (rkey, title, videoUri, offsetNs, document) and `selectedTimestampNs`
3. When a talk ref is clicked:
   - Fetch the full talk data via `/talks/:rkey`
   - Set the selected talk + timestamp
   - Player column loads the video and transcript
4. Render the word list in multi-column layout using Pretext's `prepareWithSegments` + `layoutWithLines` for balanced columns
5. Group entries by first letter with letter headings

The layout:
```tsx
<div className="h-full flex">
  {/* Left: scrollable index */}
  <div className="flex-1 overflow-y-auto p-6">
    {/* Pretext-rendered multi-column concordance */}
  </div>

  {/* Right: fixed player column */}
  <div className="w-[400px] shrink-0 border-l border-neutral-800 flex flex-col">
    <TimestampProvider>
      {selectedTalk && (
        <>
          <div className="shrink-0">
            <VideoPlayer videoUri={selectedTalk.videoUri} offsetNs={selectedTalk.offsetNs} />
          </div>
          {selectedTalk.document && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <TranscriptView document={selectedTalk.document} />
            </div>
          )}
        </>
      )}
    </TimestampProvider>
  </div>
</div>
```

For the initial implementation, use CSS `column-count` for the multi-column layout (get it working first), then replace with Pretext in a follow-up step.

The word list rendering:
```tsx
{letterGroups.map(([letter, words]) => (
  <div key={letter} className="break-inside-avoid mb-4">
    <h2 className="text-lg font-bold text-neutral-400 mb-1">{letter.toUpperCase()}</h2>
    {words.map((entry) => (
      <div key={entry.word} className="text-sm leading-relaxed">
        <span className="font-medium">{entry.word}</span>
        {" — "}
        {entry.talks.map((talk, i) => (
          <span key={talk.rkey}>
            {i > 0 && ", "}
            <button
              onClick={() => handleSelectTalk(talk.rkey, entry.word, talk.firstTimestampNs)}
              className="text-neutral-400 hover:text-neutral-100 underline underline-offset-2"
            >
              {talk.title}
            </button>
            {talk.count > 1 && <span className="text-neutral-600"> ({talk.count})</span>}
          </span>
        ))}
      </div>
    ))}
  </div>
))}
```

- [ ] **Step 2: Implement `handleSelectTalk`**

When clicked, fetch the talk data and update state:
```typescript
async function handleSelectTalk(rkey: string, word: string, timestampNs: number) {
  const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  const res = await fetch(`${API_BASE}/talks/${rkey}`);
  const { talk } = await res.json();

  const document = talk.document ? JSON.parse(talk.document) : null;

  setSelectedTalk({
    rkey,
    title: talk.title,
    videoUri: talk.video_uri,
    offsetNs: talk.video_offset_ns || 0,
    document: document?.facets?.length > 0 ? document : null,
  });
  setSelectedTimestampNs(timestampNs);
}
```

- [ ] **Step 3: Verify it renders**

Navigate to http://localhost:9402/index in the browser. The word list should appear in multi-column layout. Clicking a talk reference should load the video and transcript in the right panel.

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere/src/app/index/IndexContent.tsx
git commit -m "feat: word index page with multi-column layout and player panel"
```

### Task 7: Pretext column layout (upgrade from CSS columns)

**Files:**
- Modify: `apps/ionosphere/src/app/index/IndexContent.tsx`

- [ ] **Step 1: Replace CSS column-count with Pretext**

Use Pretext's `prepareWithSegments` and `layoutWithLines` to measure and flow the index entries into balanced columns. This gives proper column balancing and enables virtualization for the full concordance.

Pretext works with a canvas for text measurement, so this needs to be a client-side effect. The approach:

1. Prepare all entry texts with Pretext
2. Layout into lines at the available width
3. Split lines into N balanced columns by total height
4. Render each column as positioned elements

This step may require experimentation with Pretext's API. If Pretext's API proves too complex for the initial ship, keep CSS `column-count` and note the Pretext upgrade as a follow-up.

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere/src/app/index/IndexContent.tsx
git commit -m "feat: upgrade index layout to Pretext balanced columns"
```
