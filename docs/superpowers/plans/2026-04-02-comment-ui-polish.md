# Comment UI Polish Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the comment system with author identity resolution, discoverability hints, a whole-talk reaction bar, and comment count badges on talk listings.

**Architecture:** Four independent features layered on the existing comment pipeline (OAuth → PDS → Jetstream → appview → frontend). The backend adds a `profiles` table and enriches API responses; the frontend adds new UI components and updates existing ones to use profile data.

**Tech Stack:** SQLite (better-sqlite3), Hono, Next.js/React, AT Protocol public API, localStorage

**Spec:** `docs/superpowers/specs/2026-04-02-comment-ui-polish-design.md`

---

## File Map

### Backend (apps/ionosphere-appview/src/)
| File | Action | Responsibility |
|------|--------|---------------|
| `profiles.ts` | Create | Profile resolution + caching (fetch from public API, read/write profiles table) |
| `db.ts` | Modify | Add `profiles` table to migration |
| `routes.ts` | Modify | Join profile data on comment endpoints; add reaction summary to `/talks` |
| `indexer.ts` | Modify | Trigger profile resolution when indexing a new comment |

### Frontend (apps/ionosphere/src/)
| File | Action | Responsibility |
|------|--------|---------------|
| `lib/comments.ts` | Modify | Update `CommentData` type with profile fields |
| `app/components/ReactionBar.tsx` | Create | Whole-talk reaction bar (emoji buttons + comment input + counts) |
| `app/components/TranscriptView.tsx` | Modify | Render author handle/avatar in popover; add discoverability hint |
| `app/talks/[rkey]/TalkContent.tsx` | Modify | Wire ReactionBar between video and transcript |
| `app/talks/TalksListContent.tsx` | Modify | Render comment badges; remove header reaction display |

---

## Chunk 1: Backend — Profile Resolution + API Enrichment

### Task 1: Create profiles table and resolution module

**Files:**
- Modify: `apps/ionosphere-appview/src/db.ts:152` (after comments table)
- Create: `apps/ionosphere-appview/src/profiles.ts`

- [ ] **Step 1: Add profiles table to DB migration**

In `db.ts`, add after the `comments` table and its indexes (around line 165):

```sql
CREATE TABLE IF NOT EXISTS profiles (
  did TEXT PRIMARY KEY,
  handle TEXT,
  display_name TEXT,
  avatar_url TEXT,
  fetched_at TEXT
);
```

- [ ] **Step 2: Create profiles.ts with resolveProfile function**

```typescript
import type Database from "better-sqlite3";

const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const PUBLIC_API = "https://public.api.bsky.app";

export interface Profile {
  did: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

/**
 * Get a cached profile or fetch from public API.
 * Returns null only on fetch failure for unknown DIDs.
 */
export async function resolveProfile(
  db: Database.Database,
  did: string
): Promise<Profile | null> {
  const cached = db
    .prepare("SELECT * FROM profiles WHERE did = ?")
    .get(did) as any;

  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < PROFILE_MAX_AGE_MS) {
      return {
        did: cached.did,
        handle: cached.handle,
        display_name: cached.display_name,
        avatar_url: cached.avatar_url,
      };
    }
  }

  // Fetch from public API
  try {
    const res = await fetch(
      `${PUBLIC_API}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
    );
    if (!res.ok) return cached || null;
    const data = await res.json();

    const profile: Profile = {
      did,
      handle: data.handle || null,
      display_name: data.displayName || null,
      avatar_url: data.avatar || null,
    };

    db.prepare(
      `INSERT OR REPLACE INTO profiles (did, handle, display_name, avatar_url, fetched_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(did, profile.handle, profile.display_name, profile.avatar_url, new Date().toISOString());

    return profile;
  } catch {
    return cached || null;
  }
}

/**
 * Fire-and-forget profile resolution. Call when indexing a comment
 * from a DID we haven't seen. Does not block the caller.
 */
export function ensureProfile(db: Database.Database, did: string): void {
  const exists = db
    .prepare("SELECT 1 FROM profiles WHERE did = ?")
    .get(did);
  if (!exists) {
    resolveProfile(db, did).catch(() => {});
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/db.ts apps/ionosphere-appview/src/profiles.ts
git commit -m "feat: add profiles table and DID-to-profile resolution"
```

### Task 2: Trigger profile resolution on comment indexing

**Files:**
- Modify: `apps/ionosphere-appview/src/indexer.ts:320-343`

- [ ] **Step 1: Import ensureProfile in indexer.ts**

Add at top of file:

```typescript
import { ensureProfile } from "./profiles.js";
```

- [ ] **Step 2: Call ensureProfile in indexUserComment**

Add at the end of the `indexUserComment` function (after the INSERT):

```typescript
  ensureProfile(db, did);
```

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/indexer.ts
git commit -m "feat: resolve author profiles when indexing comments"
```

### Task 3: Enrich comment API responses with profile data

**Files:**
- Modify: `apps/ionosphere-appview/src/routes.ts:187-214`

- [ ] **Step 1: Update /talks/:rkey/comments to join profiles**

Replace the comments query (around line 198-200) with a LEFT JOIN:

```typescript
    const comments = db.prepare(
      `SELECT c.*, p.handle as author_handle, p.display_name as author_display_name, p.avatar_url as author_avatar_url
       FROM comments c
       LEFT JOIN profiles p ON c.author_did = p.did
       WHERE c.subject_uri IN (${placeholders})
       ORDER BY c.created_at ASC`
    ).all(...subjectUris);
```

- [ ] **Step 2: Update /comments endpoint similarly**

Replace the comments query (around line 209-211):

```typescript
    const comments = db.prepare(
      `SELECT c.*, p.handle as author_handle, p.display_name as author_display_name, p.avatar_url as author_avatar_url
       FROM comments c
       LEFT JOIN profiles p ON c.author_did = p.did
       WHERE c.subject_uri = ?
       ORDER BY c.created_at ASC`
    ).all(subject);
```

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere-appview/src/routes.ts
git commit -m "feat: include author profile data in comment API responses"
```

### Task 4: Add reaction summary to /talks endpoint

**Files:**
- Modify: `apps/ionosphere-appview/src/routes.ts:74-86`

- [ ] **Step 1: Add comment stats subquery to /talks**

After the existing talks query (line 74-85), add a second query to get comment stats per talk, and merge them:

```typescript
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
      .all() as any[];

    // Build comment stats per talk (talk URI or transcript URI as subject)
    const commentStats = db
      .prepare(
        `SELECT
           COALESCE(t.uri, c.subject_uri) as talk_uri,
           c.text
         FROM comments c
         LEFT JOIN transcripts tr ON c.subject_uri = tr.uri
         LEFT JOIN talks t ON t.uri = c.subject_uri OR t.uri = tr.talk_uri`
      )
      .all() as any[];

    // Aggregate per talk
    const statsMap = new Map<string, { emojis: Map<string, number>; textCount: number }>();
    for (const row of commentStats) {
      if (!row.talk_uri) continue;
      if (!statsMap.has(row.talk_uri)) {
        statsMap.set(row.talk_uri, { emojis: new Map(), textCount: 0 });
      }
      const stats = statsMap.get(row.talk_uri)!;
      const isEmoji = row.text.length <= 2 && !/[a-zA-Z]/.test(row.text);
      if (isEmoji) {
        stats.emojis.set(row.text, (stats.emojis.get(row.text) || 0) + 1);
      } else {
        stats.textCount++;
      }
    }

    const enriched = talks.map((talk: any) => {
      const stats = statsMap.get(talk.uri);
      if (!stats) return talk;
      // Top 3 emojis by count
      const topEmojis = [...stats.emojis.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      return {
        ...talk,
        reaction_summary: topEmojis.length > 0 ? JSON.stringify(topEmojis) : null,
        comment_count: stats.textCount,
      };
    });

    return c.json({ talks: enriched });
  });
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere-appview/src/routes.ts
git commit -m "feat: add reaction summary and comment count to /talks endpoint"
```

---

## Chunk 2: Frontend — Profile Display, Reaction Bar, Badges

### Task 5: Update CommentData type with profile fields

**Files:**
- Modify: `apps/ionosphere/src/lib/comments.ts:28-38`

- [ ] **Step 1: Add profile fields to CommentData interface**

```typescript
export interface CommentData {
  uri: string;
  author_did: string;
  author_handle?: string | null;
  author_display_name?: string | null;
  author_avatar_url?: string | null;
  rkey: string;
  subject_uri: string;
  text: string;
  facets: string | null;
  byte_start: number | null;
  byte_end: number | null;
  created_at: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere/src/lib/comments.ts
git commit -m "feat: add profile fields to CommentData type"
```

### Task 6: Render author identity in TranscriptView popover

**Files:**
- Modify: `apps/ionosphere/src/app/components/TranscriptView.tsx:550-556`

- [ ] **Step 1: Update the comment text rendering in the expanded popover**

Replace the comment rendering block (around line 550-556):

```tsx
                {group.texts.map((c) => (
                  <div key={c.uri} className="text-[12px] text-neutral-300 border-t border-neutral-700 pt-1 mt-1">
                    <span className="text-neutral-500 flex items-center gap-1">
                      {c.author_avatar_url && (
                        <img src={c.author_avatar_url} alt="" className="w-3.5 h-3.5 rounded-full" />
                      )}
                      {c.author_display_name || c.author_handle || c.author_did.slice(8, 24) + "..."}
                    </span>
                    <p>{c.text}</p>
                  </div>
                ))}
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere/src/app/components/TranscriptView.tsx
git commit -m "feat: show author handle and avatar in comment popovers"
```

### Task 7: Add discoverability hint to TranscriptView

**Files:**
- Modify: `apps/ionosphere/src/app/components/TranscriptView.tsx`

- [ ] **Step 1: Add state for hint visibility**

At the top of the `TranscriptView` component (after existing useState calls), add:

```typescript
  const [showHint, setShowHint] = useState(() => {
    if (typeof window === "undefined") return false;
    return !localStorage.getItem("has_commented");
  });
```

- [ ] **Step 2: Dismiss hint on comment publish**

In the `handlePublish` callback, after the optimistic comment is added, add:

```typescript
    if (showHint) {
      localStorage.setItem("has_commented", "1");
      setShowHint(false);
    }
```

- [ ] **Step 3: Render hint at bottom of transcript container**

Add just before the bottom spacer `<div style={{ height: "calc(67% + 1rem)" }} />`:

```tsx
      {showHint && (
        <p className="text-center text-xs text-neutral-600 mt-4 select-none">
          Select text to add a reaction
        </p>
      )}
```

- [ ] **Step 4: Commit**

```bash
git add apps/ionosphere/src/app/components/TranscriptView.tsx
git commit -m "feat: add discoverability hint for text-selection reactions"
```

### Task 8: Create ReactionBar component

**Files:**
- Create: `apps/ionosphere/src/app/components/ReactionBar.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { useState, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { publishComment, type CommentData } from "@/lib/comments";

const QUICK_EMOJI = ["\u{1F525}", "\u{1F44F}", "\u{1F4A1}", "\u2753", "\u{1F4AF}", "\u2764\uFE0F"];

interface ReactionBarProps {
  subjectUri: string;
  comments: CommentData[];
  onCommentPublished?: () => void;
}

export default function ReactionBar({ subjectUri, comments, onCommentPublished }: ReactionBarProps) {
  const { agent, did } = useAuth();
  const [showInput, setShowInput] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);

  // Whole-talk reactions (unanchored emojis)
  const reactionCounts = new Map<string, number>();
  for (const c of comments) {
    if (c.byte_start === null && c.text.length <= 2 && !/[a-zA-Z]/.test(c.text)) {
      reactionCounts.set(c.text, (reactionCounts.get(c.text) || 0) + 1);
    }
  }

  const handleEmoji = useCallback(async (emoji: string) => {
    if (!agent) return;
    try {
      await publishComment(agent, subjectUri, emoji);
      onCommentPublished?.();
    } catch (err) {
      console.error("Failed to post reaction:", err);
    }
    // Dismiss hint
    localStorage.setItem("has_commented", "1");
  }, [agent, subjectUri, onCommentPublished]);

  const handleSubmit = useCallback(async () => {
    if (!agent || !commentText.trim()) return;
    setPosting(true);
    try {
      await publishComment(agent, subjectUri, commentText.trim());
      setCommentText("");
      setShowInput(false);
      onCommentPublished?.();
    } catch (err) {
      console.error("Failed to post comment:", err);
    } finally {
      setPosting(false);
    }
    localStorage.setItem("has_commented", "1");
  }, [agent, subjectUri, commentText, onCommentPublished]);

  return (
    <div className="flex items-center gap-1 px-4 py-1.5 border-b border-neutral-800 bg-neutral-950/50">
      {/* Existing reaction counts */}
      {[...reactionCounts.entries()].map(([emoji, count]) => (
        <span key={emoji} className="text-xs bg-neutral-800 rounded-full px-1.5 py-0.5 border border-neutral-700">
          {emoji}{count > 1 && <span className="text-neutral-500 ml-0.5">{count}</span>}
        </span>
      ))}

      {/* Divider if there are existing reactions */}
      {reactionCounts.size > 0 && <div className="w-px h-4 bg-neutral-800 mx-1" />}

      {/* Quick emoji buttons (only shown when logged in) */}
      {did && (
        <>
          {QUICK_EMOJI.map((emoji) => (
            <button
              key={emoji}
              onClick={() => handleEmoji(emoji)}
              className="w-6 h-6 flex items-center justify-center hover:bg-neutral-800 rounded text-sm transition-colors"
            >{emoji}</button>
          ))}
          <div className="w-px h-4 bg-neutral-800 mx-1" />
          {!showInput ? (
            <button
              onClick={() => setShowInput(true)}
              className="text-xs text-neutral-500 hover:text-neutral-300 px-1.5 py-0.5 hover:bg-neutral-800 rounded transition-colors"
            >Comment</button>
          ) : (
            <form
              onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}
              className="flex items-center gap-1 flex-1 min-w-0"
            >
              <input
                type="text"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setShowInput(false); setCommentText(""); } }}
                placeholder="Add a comment..."
                className="flex-1 min-w-0 bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
                autoFocus
                disabled={posting}
              />
              <button
                type="submit"
                disabled={posting || !commentText.trim()}
                className="text-xs text-neutral-400 hover:text-neutral-200 px-1 disabled:opacity-50"
              >{posting ? "..." : "Post"}</button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/ionosphere/src/app/components/ReactionBar.tsx
git commit -m "feat: create whole-talk ReactionBar component"
```

### Task 9: Wire ReactionBar into TalkContent

**Files:**
- Modify: `apps/ionosphere/src/app/talks/[rkey]/TalkContent.tsx:120-139`

- [ ] **Step 1: Import ReactionBar**

Add import at top:

```typescript
import ReactionBar from "@/app/components/ReactionBar";
```

- [ ] **Step 2: Add ReactionBar between video and transcript**

After the video section (around line 125) and before the transcript section (line 128), add:

```tsx
          {/* Whole-talk reaction bar */}
          <ReactionBar
            subjectUri={talk.uri}
            comments={comments}
            onCommentPublished={handleCommentPublished}
          />
```

- [ ] **Step 3: Commit**

```bash
git add apps/ionosphere/src/app/talks/[rkey]/TalkContent.tsx
git commit -m "feat: add whole-talk reaction bar to talk detail page"
```

### Task 10: Wire ReactionBar into TalksListContent and add comment badges

**Files:**
- Modify: `apps/ionosphere/src/app/talks/TalksListContent.tsx`

- [ ] **Step 1: Import ReactionBar**

Add import at top:

```typescript
import ReactionBar from "@/app/components/ReactionBar";
```

- [ ] **Step 2: Add ReactionBar to sidebar player**

Replace the existing whole-talk reactions in the player header (lines 275-289) and add ReactionBar after the video player (around line 296):

Remove the whole-talk reaction IIFE (the `{(() => { ... })()}` block in the header bar, lines 274-289). Then after the `<VideoPlayer>` closing div (around line 296), add:

```tsx
            <ReactionBar
              subjectUri={selectedTalk.talkUri}
              comments={comments}
              onCommentPublished={() => fetchComments(selectedTalk.rkey).then(setComments)}
            />
```

- [ ] **Step 3: Add Talk type fields for reaction data**

Update the `Talk` interface to include:

```typescript
  reaction_summary?: string | null; // JSON: [["emoji", count], ...]
  comment_count?: number;
```

- [ ] **Step 4: Render comment badges in talk listing entries**

In the talk metadata line (around line 238), after the existing time display, add:

```tsx
                        {(() => {
                          const emojis: [string, number][] = talk.reaction_summary ? JSON.parse(talk.reaction_summary) : [];
                          const count = talk.comment_count || 0;
                          if (emojis.length === 0 && count === 0) return null;
                          return (
                            <>
                              {" \u00b7 "}
                              {emojis.map(([emoji, n]) => (
                                <span key={emoji}>{emoji}{n > 1 ? n : ""}</span>
                              ))}
                              {count > 0 && <span>{emojis.length > 0 ? " " : ""}{"\uD83D\uDCAC"}{count}</span>}
                            </>
                          );
                        })()}
```

- [ ] **Step 5: Commit**

```bash
git add apps/ionosphere/src/app/talks/TalksListContent.tsx
git commit -m "feat: add reaction bar to sidebar player and comment badges to talk listings"
```

---

## Chunk 3: Integration and Cleanup

### Task 11: Remove unused CommentPanel (or keep for future use)

**Files:**
- Evaluate: `apps/ionosphere/src/app/components/CommentPanel.tsx`

- [ ] **Step 1: Check if CommentPanel is imported anywhere**

Run: `grep -r "CommentPanel" apps/ionosphere/src/`

If it's not imported anywhere (it wasn't wired in), leave it for now — it may be useful for a future sidebar comment view. No action needed.

- [ ] **Step 2: Commit (if changes made)**

### Task 12: Manual integration test

- [ ] **Step 1: Start dev environment**

```bash
cd apps/ionosphere-appview
docker compose up -d
PORT=9401 npx tsx src/appview.ts &
cd ../ionosphere
NEXT_PUBLIC_API_URL=http://localhost:9401 npx next dev --port 9402
```

Open `http://127.0.0.1:9402/talks`

- [ ] **Step 2: Verify profile resolution**

Pick a talk with existing comments. Verify that comment popovers show handles/avatars instead of truncated DIDs.

- [ ] **Step 3: Verify discoverability hint**

Clear localStorage (`localStorage.removeItem("has_commented")`). Reload. Verify "Select text to add a reaction" appears below transcript. Select text and post a reaction. Verify hint disappears and doesn't return on reload.

- [ ] **Step 4: Verify reaction bar**

On a talk detail page, verify the reaction bar appears between video and transcript. Click an emoji — verify it posts. Click Comment — verify input expands, post works, input collapses.

- [ ] **Step 5: Verify comment badges**

On the talks list page, verify talks with reactions show emoji + count in the metadata line.

- [ ] **Step 6: Verify sidebar player**

Click a talk in the list. Verify the ReactionBar appears in the sidebar player and the old header reaction display is gone.
