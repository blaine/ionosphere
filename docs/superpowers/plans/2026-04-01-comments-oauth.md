# Comments & OAuth Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to post inline comments and emoji reactions on talk transcripts via AT Protocol OAuth, with comments discoverable via public Jetstream.

**Architecture:** Browser-side OAuth via `@atproto/oauth-client-browser` writes `tv.ionosphere.comment` records to user's PDS. A public Jetstream subscription delivers those records to the appview, which indexes them in SQLite and serves them via API. The frontend renders inline highlights on transcripts and a comment panel.

**Tech Stack:** `@atproto/oauth-client-browser`, `@atproto/api`, Jetstream, Hono, Next.js, SQLite

**Spec:** `docs/superpowers/specs/2026-04-01-comments-oauth-design.md`

---

## File Map

### New files
- `lexicons/tv/ionosphere/comment.json` — comment lexicon definition
- `apps/ionosphere/public/client-metadata.json` — OAuth client metadata
- `apps/ionosphere/src/lib/auth.tsx` — OAuth client setup, React context, hooks
- `apps/ionosphere/src/app/components/AuthButton.tsx` — sign in/out in nav
- `apps/ionosphere/src/app/components/CommentHighlights.tsx` — inline highlights on transcript spans
- `apps/ionosphere/src/app/components/CommentPanel.tsx` — comment thread sidebar/overlay
- `apps/ionosphere/src/app/components/TextSelector.tsx` — text selection → comment/react
- `apps/ionosphere/src/app/auth/callback/page.tsx` — OAuth callback page
- `apps/ionosphere-appview/src/public-jetstream.ts` — public Jetstream subscription

### Modified files
- `apps/ionosphere-appview/src/db.ts` — add comments table + profiles cache table
- `apps/ionosphere-appview/src/indexer.ts` — handle tv.ionosphere.comment events
- `apps/ionosphere-appview/src/routes.ts` — add comment API endpoints
- `apps/ionosphere-appview/src/appview.ts` — start public Jetstream connection
- `apps/ionosphere/src/app/components/NavHeader.tsx` — add auth button
- `apps/ionosphere/src/app/components/TranscriptView.tsx` — integrate comment highlights
- `apps/ionosphere/src/app/layout.tsx` — wrap with auth provider
- `apps/ionosphere/package.json` — add @atproto/oauth-client-browser, @atproto/api

---

## Chunk 1: Comment Lexicon + Appview Indexing

Backend infrastructure — define the lexicon, add DB table, index comments, serve API.

### Task 1: Comment lexicon definition

**Files:**
- Create: `lexicons/tv/ionosphere/comment.json`

- [ ] **Step 1: Create the lexicon file**

```json
{
  "lexicon": 1,
  "$type": "com.atproto.lexicon.schema",
  "id": "tv.ionosphere.comment",
  "revision": 1,
  "description": "A comment or reaction on a transcript, talk, or another comment.",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["subject", "text", "createdAt"],
        "properties": {
          "subject": {
            "type": "string",
            "format": "at-uri",
            "description": "AT URI of the transcript, talk, or parent comment."
          },
          "text": {
            "type": "string",
            "maxLength": 10000,
            "description": "Comment body or single emoji reaction."
          },
          "facets": {
            "type": "array",
            "items": { "type": "ref", "ref": "app.bsky.richtext.facet" },
            "description": "Rich text facets (mentions, links) in the comment."
          },
          "anchor": {
            "type": "ref",
            "ref": "#byteRange",
            "description": "Optional byte range on the subject's text."
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    },
    "byteRange": {
      "type": "object",
      "required": ["byteStart", "byteEnd"],
      "properties": {
        "byteStart": { "type": "integer" },
        "byteEnd": { "type": "integer" }
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add lexicons/tv/ionosphere/comment.json
git commit -m "feat: tv.ionosphere.comment lexicon definition"
```

### Task 2: Comments table + indexer

**Files:**
- Modify: `apps/ionosphere-appview/src/db.ts`
- Modify: `apps/ionosphere-appview/src/indexer.ts`

- [ ] **Step 1: Add comments table to db.ts migrate function**

Add after the `lenses` table:

```sql
CREATE TABLE IF NOT EXISTS comments (
  uri TEXT PRIMARY KEY,
  author_did TEXT NOT NULL,
  rkey TEXT NOT NULL,
  subject_uri TEXT NOT NULL,
  text TEXT NOT NULL,
  facets TEXT,
  byte_start INTEGER,
  byte_end INTEGER,
  created_at TEXT NOT NULL,
  indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comments_subject ON comments(subject_uri);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_did);
```

- [ ] **Step 2: Add tv.ionosphere.comment to IONOSPHERE_COLLECTIONS in indexer.ts**

Add `"tv.ionosphere.comment"` to the `IONOSPHERE_COLLECTIONS` array. This also makes the backfill pick it up.

- [ ] **Step 3: Add delete handler**

In the `processEvent` delete switch:
```typescript
case "tv.ionosphere.comment":
  db.prepare("DELETE FROM comments WHERE uri = ?").run(uri);
  break;
```

- [ ] **Step 4: Add create/update handler**

New case in the create/update switch:
```typescript
case "tv.ionosphere.comment":
  indexComment(db, event.did, rkey, uri, record);
  break;
```

New function:
```typescript
function indexComment(
  db: Database.Database,
  did: string,
  rkey: string,
  uri: string,
  record: Record<string, unknown>
): void {
  const anchor = record.anchor as { byteStart: number; byteEnd: number } | undefined;
  db.prepare(
    `INSERT OR REPLACE INTO comments
     (uri, author_did, rkey, subject_uri, text, facets, byte_start, byte_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uri,
    did,
    rkey,
    record.subject as string,
    record.text as string,
    record.facets ? JSON.stringify(record.facets) : null,
    anchor?.byteStart ?? null,
    anchor?.byteEnd ?? null,
    record.createdAt as string
  );
}
```

- [ ] **Step 5: Run tests**

```bash
cd apps/ionosphere-appview && pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add apps/ionosphere-appview/src/db.ts apps/ionosphere-appview/src/indexer.ts
git commit -m "feat: comments table and indexer for tv.ionosphere.comment"
```

### Task 3: Comment API endpoints

**Files:**
- Modify: `apps/ionosphere-appview/src/routes.ts`

- [ ] **Step 1: Add comment endpoints**

Add before the concordance cache section:

```typescript
// --- Comments ---

app.get("/talks/:rkey/comments", (c) => {
  const { rkey } = c.req.param();
  const talk = db.prepare("SELECT uri FROM talks WHERE rkey = ?").get(rkey) as any;
  if (!talk) return c.json({ comments: [] });

  // Get transcript URI for this talk
  const transcript = db.prepare("SELECT uri FROM transcripts WHERE talk_uri = ?").get(talk.uri) as any;

  // Get comments on the talk URI or its transcript URI
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
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere-appview/src/routes.ts
git commit -m "feat: comment API endpoints"
```

### Task 4: Public Jetstream subscription

**Files:**
- Create: `apps/ionosphere-appview/src/public-jetstream.ts`
- Modify: `apps/ionosphere-appview/src/appview.ts`

- [ ] **Step 1: Create public-jetstream.ts**

A thin wrapper that creates a second JetstreamClient for the public network:

```typescript
import type Database from "better-sqlite3";
import { JetstreamClient } from "./jetstream.js";
import { processEvent } from "./indexer.js";

const PUBLIC_JETSTREAM_URL = process.env.PUBLIC_JETSTREAM_URL ?? "wss://jetstream1.us-east.bsky.network";

export function startPublicJetstream(db: Database.Database): JetstreamClient {
  // Separate cursor for the public firehose
  db.exec(`
    CREATE TABLE IF NOT EXISTS _public_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cursor_us INTEGER
    );
    INSERT OR IGNORE INTO _public_cursor (id, cursor_us) VALUES (1, NULL);
  `);

  const getCursor = (): number | null => {
    const row = db.prepare("SELECT cursor_us FROM _public_cursor WHERE id = 1").get() as any;
    return row?.cursor_us ?? null;
  };

  const setCursor = (cursor: number): void => {
    db.prepare("UPDATE _public_cursor SET cursor_us = ? WHERE id = 1").run(cursor);
  };

  const client = new JetstreamClient({
    url: PUBLIC_JETSTREAM_URL,
    wantedCollections: ["tv.ionosphere.comment"],
    getCursor,
    setCursor,
    onEvent: (event) => {
      try {
        processEvent(db, event);
      } catch (err) {
        console.error("Public Jetstream indexer error:", err);
      }
    },
    onError: (err) => console.error("Public Jetstream error:", err),
  });

  return client;
}
```

- [ ] **Step 2: Add to appview.ts**

In the `init()` function, after the local Jetstream setup:

```typescript
import { startPublicJetstream } from "./public-jetstream.js";

// In init():
const publicJetstream = startPublicJetstream(db);
publicJetstream.start();
console.log("Public Jetstream: listening for tv.ionosphere.comment");
```

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/public-jetstream.ts apps/ionosphere-appview/src/appview.ts
git commit -m "feat: public Jetstream subscription for user comments"
```

---

## Chunk 2: AT Protocol OAuth

Frontend authentication — OAuth flow, session management, auth UI.

### Task 5: Install OAuth dependencies

**Files:**
- Modify: `apps/ionosphere/package.json`

- [ ] **Step 1: Install packages**

```bash
cd apps/ionosphere && pnpm add @atproto/oauth-client-browser @atproto/api
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere/package.json pnpm-lock.yaml
git commit -m "chore: add @atproto/oauth-client-browser and @atproto/api"
```

### Task 6: OAuth client metadata

**Files:**
- Create: `apps/ionosphere/public/client-metadata.json`

- [ ] **Step 1: Create client metadata**

```json
{
  "client_id": "http://localhost:9402/client-metadata.json",
  "client_name": "Ionosphere",
  "client_uri": "http://localhost:9402",
  "redirect_uris": ["http://localhost:9402/auth/callback"],
  "scope": "atproto",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "web",
  "dpop_bound_access_tokens": true
}
```

Note: For production, `client_id` changes to `https://ionosphere.tv/client-metadata.json` and redirect URI updates accordingly.

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere/public/client-metadata.json
git commit -m "feat: OAuth client metadata for AT Protocol auth"
```

### Task 7: Auth library and React context

**Files:**
- Create: `apps/ionosphere/src/lib/auth.tsx`
- Create: `apps/ionosphere/src/app/auth/callback/page.tsx`

- [ ] **Step 1: Create auth.tsx**

This provides the OAuth client, React context, and hooks:

```typescript
"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import { Agent } from "@atproto/api";

interface AuthState {
  agent: Agent | null;
  did: string | null;
  handle: string | null;
  loading: boolean;
  signIn: (handle: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

let _oauthClient: BrowserOAuthClient | null = null;

function getOAuthClient(): BrowserOAuthClient {
  if (!_oauthClient) {
    _oauthClient = new BrowserOAuthClient({
      clientMetadata: `${window.location.origin}/client-metadata.json`,
      handleResolver: "https://bsky.social",
    });
  }
  return _oauthClient;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [did, setDid] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session on mount
  useEffect(() => {
    async function restore() {
      try {
        const client = getOAuthClient();
        const result = await client.init();
        if (result?.session) {
          const newAgent = new Agent(result.session);
          setAgent(newAgent);
          setDid(result.session.did);
          // Resolve handle
          try {
            const profile = await newAgent.getProfile({ actor: result.session.did });
            setHandle(profile.data.handle);
          } catch {}
        }
      } catch (err) {
        console.error("Auth restore error:", err);
      } finally {
        setLoading(false);
      }
    }
    restore();
  }, []);

  const signIn = useCallback(async (userHandle: string) => {
    const client = getOAuthClient();
    await client.signIn(userHandle, {
      scope: "atproto",
    });
    // This redirects — the callback page handles the rest
  }, []);

  const signOut = useCallback(async () => {
    try {
      const client = getOAuthClient();
      if (did) {
        const session = await client.restore(did);
        if (session) {
          // Revoke session
        }
      }
    } catch {}
    setAgent(null);
    setDid(null);
    setHandle(null);
  }, [did]);

  return (
    <AuthContext.Provider value={{ agent, did, handle, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
```

- [ ] **Step 2: Create OAuth callback page**

`apps/ionosphere/src/app/auth/callback/page.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AuthCallback() {
  const router = useRouter();

  useEffect(() => {
    // The BrowserOAuthClient.init() in AuthProvider handles the callback
    // automatically when it detects the authorization code in the URL.
    // Just redirect back to where the user came from.
    const returnTo = sessionStorage.getItem("auth_return_to") || "/talks";
    router.replace(returnTo);
  }, [router]);

  return (
    <div className="h-full flex items-center justify-center text-neutral-400">
      Signing in...
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere/src/lib/auth.tsx apps/ionosphere/src/app/auth/callback/page.tsx
git commit -m "feat: AT Protocol OAuth client with React context"
```

### Task 8: Auth button + layout integration

**Files:**
- Create: `apps/ionosphere/src/app/components/AuthButton.tsx`
- Modify: `apps/ionosphere/src/app/components/NavHeader.tsx`
- Modify: `apps/ionosphere/src/app/layout.tsx`

- [ ] **Step 1: Create AuthButton**

```tsx
"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth";

export default function AuthButton() {
  const { did, handle, loading, signIn, signOut } = useAuth();
  const [inputHandle, setInputHandle] = useState("");
  const [showInput, setShowInput] = useState(false);

  if (loading) return null;

  if (did) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-400 hidden sm:inline">
          {handle || did.slice(0, 20) + "..."}
        </span>
        <button
          onClick={signOut}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          Sign out
        </button>
      </div>
    );
  }

  if (showInput) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (inputHandle) {
            sessionStorage.setItem("auth_return_to", window.location.pathname);
            signIn(inputHandle);
          }
        }}
        className="flex items-center gap-1"
      >
        <input
          type="text"
          value={inputHandle}
          onChange={(e) => setInputHandle(e.target.value)}
          placeholder="handle.bsky.social"
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-200 w-40 focus:outline-none focus:border-neutral-500"
          autoFocus
        />
        <button type="submit" className="text-xs text-neutral-400 hover:text-neutral-200">
          Go
        </button>
        <button type="button" onClick={() => setShowInput(false)} className="text-xs text-neutral-600">
          ✕
        </button>
      </form>
    );
  }

  return (
    <button
      onClick={() => setShowInput(true)}
      className="text-xs text-neutral-500 hover:text-neutral-300"
    >
      Sign in
    </button>
  );
}
```

- [ ] **Step 2: Add AuthButton to NavHeader**

In `NavHeader.tsx`, add AuthButton to the right side of the nav:

```tsx
import AuthButton from "./AuthButton";

// Inside the nav, after the desktop nav links:
<div className="ml-auto hidden md:block">
  <AuthButton />
</div>
```

- [ ] **Step 3: Wrap layout with AuthProvider**

In `layout.tsx`, wrap the body content with AuthProvider. Since AuthProvider is a client component, it needs to wrap the children:

```tsx
import { AuthProvider } from "@/lib/auth";

// In the body:
<AuthProvider>
  <NavHeader />
  <main className="flex-1 min-h-0">{children}</main>
</AuthProvider>
```

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere/src/app/components/AuthButton.tsx apps/ionosphere/src/app/components/NavHeader.tsx apps/ionosphere/src/app/layout.tsx
git commit -m "feat: sign in/out button with AT Protocol OAuth"
```

---

## Chunk 3: Comment UI

Frontend comment rendering and composition.

### Task 9: Comment composition (text selection → comment/react)

**Files:**
- Create: `apps/ionosphere/src/app/components/TextSelector.tsx`

- [ ] **Step 1: Create TextSelector**

A component that detects text selection in the transcript and shows a floating toolbar with emoji reactions and a comment button:

```tsx
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth";

interface TextSelectorProps {
  containerRef: React.RefObject<HTMLDivElement>;
  onComment: (byteStart: number, byteEnd: number, text: string) => void;
  getByteRange: (selection: Selection) => { byteStart: number; byteEnd: number } | null;
}

const QUICK_EMOJI = ["🔥", "👏", "💡", "❓", "💯", "❤️"];

export default function TextSelector({ containerRef, onComment, getByteRange }: TextSelectorProps) {
  const { agent, did } = useAuth();
  const [selection, setSelection] = useState<{ byteStart: number; byteEnd: number; rect: DOMRect } | null>(null);
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [commentText, setCommentText] = useState("");
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelection(null);
        return;
      }

      // Check if selection is within our container
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }

      const byteRange = getByteRange(sel);
      if (!byteRange) { setSelection(null); return; }

      const rect = range.getBoundingClientRect();
      setSelection({ ...byteRange, rect });
      setShowCommentInput(false);
      setCommentText("");
    };

    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, [containerRef, getByteRange]);

  const handleEmoji = useCallback((emoji: string) => {
    if (!selection) return;
    onComment(selection.byteStart, selection.byteEnd, emoji);
    setSelection(null);
  }, [selection, onComment]);

  const handleSubmitComment = useCallback(() => {
    if (!selection || !commentText.trim()) return;
    onComment(selection.byteStart, selection.byteEnd, commentText.trim());
    setSelection(null);
    setShowCommentInput(false);
    setCommentText("");
  }, [selection, commentText, onComment]);

  if (!selection || !did) return null;

  const containerRect = containerRef.current?.getBoundingClientRect();
  if (!containerRect) return null;

  const top = selection.rect.top - containerRect.top - 40;
  const left = selection.rect.left - containerRect.left + selection.rect.width / 2;

  return (
    <div
      ref={toolbarRef}
      className="absolute z-50 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl p-1 flex items-center gap-1"
      style={{ top, left, transform: "translateX(-50%)" }}
    >
      {!showCommentInput ? (
        <>
          {QUICK_EMOJI.map((emoji) => (
            <button
              key={emoji}
              onClick={() => handleEmoji(emoji)}
              className="w-8 h-8 flex items-center justify-center hover:bg-neutral-700 rounded text-base"
            >
              {emoji}
            </button>
          ))}
          <div className="w-px h-6 bg-neutral-700" />
          <button
            onClick={() => setShowCommentInput(true)}
            className="px-2 h-8 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 rounded"
          >
            Comment
          </button>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); handleSubmitComment(); }} className="flex items-center gap-1">
          <input
            type="text"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Add a comment..."
            className="bg-neutral-900 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-200 w-48 focus:outline-none"
            autoFocus
          />
          <button type="submit" className="text-xs text-neutral-400 hover:text-neutral-200 px-1">
            Post
          </button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere/src/app/components/TextSelector.tsx
git commit -m "feat: text selection toolbar for comments and emoji reactions"
```

### Task 10: Comment publishing logic

**Files:**
- Create: `apps/ionosphere/src/lib/comments.ts`

- [ ] **Step 1: Create comments.ts**

Functions for publishing and fetching comments:

```typescript
import type { Agent } from "@atproto/api";

const API_BASE = typeof window !== "undefined"
  ? (process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401")
  : "";

export async function publishComment(
  agent: Agent,
  subject: string,
  text: string,
  anchor?: { byteStart: number; byteEnd: number }
): Promise<string> {
  const record: Record<string, unknown> = {
    $type: "tv.ionosphere.comment",
    subject,
    text,
    createdAt: new Date().toISOString(),
  };
  if (anchor) {
    record.anchor = anchor;
  }

  const result = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: "tv.ionosphere.comment",
    record,
  });

  return result.data.uri;
}

export async function fetchComments(talkRkey: string): Promise<any[]> {
  const res = await fetch(`${API_BASE}/talks/${talkRkey}/comments`);
  if (!res.ok) return [];
  const { comments } = await res.json();
  return comments;
}

export async function fetchReplies(commentUri: string): Promise<any[]> {
  const res = await fetch(`${API_BASE}/comments?subject=${encodeURIComponent(commentUri)}`);
  if (!res.ok) return [];
  const { comments } = await res.json();
  return comments;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere/src/lib/comments.ts
git commit -m "feat: comment publishing and fetching library"
```

### Task 11: Integrate comments into TranscriptView

**Files:**
- Modify: `apps/ionosphere/src/app/components/TranscriptView.tsx`

- [ ] **Step 1: Add comment highlights to transcript rendering**

This is the integration point. The TranscriptView already renders word spans with byte ranges. Add:

1. A prop for comments data
2. Highlight styling on spans that have comments/reactions
3. Click handler to open comment thread
4. The TextSelector component for creating new comments

The exact integration depends on the TranscriptView structure (which renders word spans in a loop). The key changes:

- Accept `comments` prop and `onPublishComment` callback
- For each word span, check if any comment's byte range overlaps
- If so, add a subtle highlight style (e.g., dotted underline, background tint)
- Show small emoji clusters near highlighted spans
- Include `<TextSelector>` component inside the transcript container

The `getByteRange` callback for TextSelector needs to map a DOM Selection back to byte offsets — use the word spans' `byteStart`/`byteEnd` data to determine the range.

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere/src/app/components/TranscriptView.tsx
git commit -m "feat: inline comment highlights on transcript"
```

### Task 12: Comment panel

**Files:**
- Create: `apps/ionosphere/src/app/components/CommentPanel.tsx`

- [ ] **Step 1: Create CommentPanel**

A panel that shows comments for a selected transcript span. Can be integrated into the player sidebar or as an overlay:

```tsx
"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { fetchReplies, publishComment } from "@/lib/comments";

interface Comment {
  uri: string;
  author_did: string;
  text: string;
  byte_start: number | null;
  byte_end: number | null;
  created_at: string;
}

interface CommentPanelProps {
  comments: Comment[];
  subjectUri: string;
  selectedRange?: { byteStart: number; byteEnd: number };
}

export default function CommentPanel({ comments, subjectUri, selectedRange }: CommentPanelProps) {
  const { agent, did } = useAuth();

  // Filter to comments on the selected range (or all if no range selected)
  const visible = selectedRange
    ? comments.filter((c) =>
        c.byte_start !== null &&
        c.byte_end !== null &&
        c.byte_start < selectedRange.byteEnd &&
        c.byte_end > selectedRange.byteStart
      )
    : comments;

  // Group emoji reactions
  const reactions = visible.filter((c) => c.text.length <= 2);
  const textComments = visible.filter((c) => c.text.length > 2);

  // Emoji counts
  const emojiCounts = new Map<string, number>();
  for (const r of reactions) {
    emojiCounts.set(r.text, (emojiCounts.get(r.text) || 0) + 1);
  }

  return (
    <div className="p-3 text-sm">
      {emojiCounts.size > 0 && (
        <div className="flex gap-2 mb-3 flex-wrap">
          {[...emojiCounts.entries()].map(([emoji, count]) => (
            <span key={emoji} className="bg-neutral-800 rounded-full px-2 py-0.5 text-xs">
              {emoji} {count > 1 && count}
            </span>
          ))}
        </div>
      )}
      {textComments.map((comment) => (
        <div key={comment.uri} className="mb-3 border-l-2 border-neutral-800 pl-3">
          <div className="text-xs text-neutral-500 mb-0.5">
            {comment.author_did.slice(0, 24)}...
          </div>
          <div className="text-neutral-300">{comment.text}</div>
          <div className="text-xs text-neutral-600 mt-0.5">
            {new Date(comment.created_at).toLocaleDateString()}
          </div>
        </div>
      ))}
      {visible.length === 0 && (
        <div className="text-neutral-600 text-xs">No comments on this selection</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere/src/app/components/CommentPanel.tsx
git commit -m "feat: comment panel with emoji counts and threaded display"
```
