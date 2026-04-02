# Comment UI Polish — Design Spec

**Date:** 2026-04-02
**Status:** Approved

## Context

Comments and reactions are working end-to-end (AT Protocol OAuth → user PDS → Jetstream → appview → frontend with optimistic rendering). This spec covers the next round of polish: author identity, discoverability, whole-talk reactions, and comment count badges.

## 1. Author Identity Resolution

**Problem:** Comments display truncated DIDs (`did:plc:abc123...`) instead of human-readable identities.

**Solution:** Appview-side profile cache.

- Add a `profiles` table to the appview SQLite DB:
  ```sql
  CREATE TABLE IF NOT EXISTS profiles (
    did TEXT PRIMARY KEY,
    handle TEXT,
    display_name TEXT,
    avatar_url TEXT,
    fetched_at TEXT
  );
  ```
- When the appview encounters a comment from an unknown DID, resolve via `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=<did>`.
- Cache in DB. Refresh if `fetched_at` is older than 24 hours.
- The `/talks/:rkey/comments` endpoint joins profile data onto each comment in its response.
- Frontend renders handle + avatar wherever comments appear:
  - TranscriptView expanded popover (replaces `c.author_did.slice(8, 24)...`)
  - CommentPanel author line
  - Any future comment surfaces

## 2. Discoverability Hint

**Problem:** No indication that text selection enables reactions. Users don't discover the feature.

**Solution:** Persistent hint that dismisses after first use.

- Small, subtle text below the transcript panel: "Select text to add a reaction"
- Neutral color (e.g. `text-neutral-600`), doesn't compete with transcript content.
- Visibility controlled by localStorage key `has_commented`.
- Once the user publishes any comment or reaction (anchored or whole-talk), set the flag and hide the hint.
- On subsequent visits, the hint never appears.

## 3. Whole-Talk Reaction Bar

**Problem:** Users can only react to specific text selections. There's no way to react to or comment on a talk as a whole (CommentPanel exists but isn't wired in).

**Solution:** Compact reaction bar below the video player, above the transcript.

- Row of 6 quick-reaction emoji buttons (same set as TextSelector: fire, clap, bulb, question, 100, heart).
- A "Comment" button at the end.
- Click emoji → publish unanchored comment (no byte range) with just the emoji as text. Optimistic rendering.
- Click Comment → expand an inline text input. Post on Enter, collapse on Escape or after posting.
- Display current whole-talk reaction counts inline in the bar (emoji + count pills, same style as existing player header reactions).
- Remove the existing whole-talk reaction display from the TalksListContent player header title bar (it moves here).
- When no reactions exist yet, just show the emoji buttons — no empty state clutter.

## 4. Comment Count Badges on Talk Listings

**Problem:** Talk listings show no indication of comment/reaction activity.

**Solution:** Add reaction summary to talk metadata lines.

- Add a query to the `/talks` endpoint that returns `comment_count` and `reaction_summary` per talk.
- `reaction_summary`: top 3 emoji types with counts, as a JSON array (e.g. `[["fire",2],["clap",1]]`).
- `comment_count`: count of text comments (non-emoji).
- Frontend renders in the existing metadata line pattern:
  ```
  Speaker · Room · 10:30 AM · 🔥2 👏1 💬3
  ```
- Max 3 emoji types shown. The 💬N counter only appears if there are text-only comments.
- If no comments/reactions exist for a talk, nothing is shown (no empty badge).

## Files Affected

### Appview (backend)
- `apps/ionosphere-appview/src/db.ts` — add `profiles` table to migration
- `apps/ionosphere-appview/src/routes.ts` — join profiles on comment endpoints, add reaction summary to `/talks`
- `apps/ionosphere-appview/src/indexer.ts` or new `src/profiles.ts` — profile resolution + caching logic
- `apps/ionosphere-appview/src/public-jetstream.ts` — trigger profile resolution on new comment DIDs

### Frontend
- `apps/ionosphere/src/app/components/TranscriptView.tsx` — render author handle/avatar in popover, add discoverability hint
- `apps/ionosphere/src/app/talks/[rkey]/TalkContent.tsx` — add whole-talk reaction bar between video and transcript
- `apps/ionosphere/src/app/talks/TalksListContent.tsx` — render comment count badges, remove header reaction display
- `apps/ionosphere/src/lib/comments.ts` — update CommentData type to include profile fields
- New component: reaction bar (could be inline in TalkContent or extracted)

## Non-Goals

- Threaded comment replies (future work)
- Comment moderation / reporting
- Real-time comment updates via WebSocket to the frontend (currently polls on publish)
- Comment editing or deletion
