# Comments & Reactions with AT Protocol OAuth

## Overview

Users can comment on and react to conference talk transcripts. Comments are AT Protocol records published to the user's own PDS, discovered via Jetstream firehose, and indexed by the ionosphere appview. A single `tv.ionosphere.comment` lexicon handles comments, emoji reactions, and threaded replies.

## Lexicon

One record type: `tv.ionosphere.comment`

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

**Use cases:**
- Emoji on a passage: `{ subject: transcriptUri, text: "🔥", anchor: { byteStart: 100, byteEnd: 150 } }`
- Comment on a passage: `{ subject: transcriptUri, text: "Great point about federation", anchor: { byteStart: 100, byteEnd: 150 } }`
- Reply to a comment: `{ subject: commentUri, text: "Agreed!" }` — no anchor
- Emoji on a whole talk: `{ subject: talkUri, text: "👏" }` — no anchor

## AT Protocol OAuth

**Library:** `@atproto/oauth-client-browser` — handles DPOP, PAR, token refresh, IndexedDB storage.

**Scope:** `atproto` (minimal — read/write to user's own repo).

**Client metadata:** Published at `https://ionosphere.tv/client-metadata.json` (localhost variant for dev). Defines app name, redirect URI, scope.

**Token storage:** Browser IndexedDB only. The appview is stateless — never sees tokens.

**Flow:**
1. User clicks "Sign in"
2. OAuth redirect to user's PDS authorization endpoint
3. User authorizes ionosphere with `atproto` scope
4. Redirect back with authorization code
5. Browser exchanges code for tokens (DPOP-bound)
6. `@atproto/api` Agent created with authenticated session
7. Agent writes `tv.ionosphere.comment` directly to user's PDS
8. Jetstream picks it up → appview indexes → visible to everyone

**Writing comments:** The frontend uses `agent.com.atproto.repo.createRecord` to write comments to the user's PDS. The user's PDS must accept the `tv.ionosphere.comment` collection — this works on any standard AT Protocol PDS.

## Comment Indexing

**Jetstream subscription:** The appview subscribes to a public Jetstream instance with `wantedCollections=tv.ionosphere.comment`. This delivers every `tv.ionosphere.comment` from any user on the network.

Separate from the existing local PDS Jetstream subscription. The appview runs two Jetstream connections: one for local PDS (ionosphere data), one for public network (user comments).

**Database:**

```sql
CREATE TABLE comments (
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

CREATE INDEX idx_comments_subject ON comments(subject_uri);
CREATE INDEX idx_comments_author ON comments(author_did);
```

**API endpoints:**
- `GET /talks/:rkey/comments` — all comments on a talk's transcript (anchored + unanchored)
- `GET /comments?subject=<at-uri>` — comments on any subject URI
- Replies: query where `subject_uri` matches a comment URI

**Author resolution:** Lazy-fetch DID → handle/display name from the network. Cache in a `profiles` table.

## Comment UI

**Inline transcript annotations:**
- Comments anchored to byte ranges render as highlights on the transcript word spans
- Visual treatment: subtle background tint (different from concept amber glow)
- Small emoji clusters displayed near highlighted spans
- Click a highlighted span → opens comment thread in sidebar

**Comment composition:**
- Quick reaction: select text → emoji palette → click → published
- Full comment: select text → comment input → type → submit
- Both require OAuth sign-in

**Signed-out experience:**
- All comments/reactions visible (read from appview)
- "Sign in" prompt when attempting to react or comment

**Threading:**
- Reply to a comment: creates a new comment with `subject` pointing to parent comment URI
- Displayed as indented thread under parent

**Aggregation:**
- Talk listing shows comment count badges
- Transcript highlights show reaction counts per span

## Architecture

```
User (browser)
  ↓ OAuth sign-in → user's PDS authorization
  ↓ Write tv.ionosphere.comment → user's PDS
  ↓
Public Jetstream (filtered: tv.ionosphere.comment)
  ↓
Ionosphere Appview → index into SQLite → serve via API
  ↓
All users see comments (no auth required to read)
```

## Files

### New
- `lexicons/tv/ionosphere/comment.json` — comment lexicon
- `apps/ionosphere/src/lib/auth.ts` — OAuth client setup, sign-in/out, session state
- `apps/ionosphere/src/app/components/AuthButton.tsx` — sign in/out button in nav
- `apps/ionosphere/src/app/components/CommentOverlay.tsx` — inline comment highlights on transcript
- `apps/ionosphere/src/app/components/CommentPanel.tsx` — comment thread sidebar
- `apps/ionosphere/src/app/components/EmojiPicker.tsx` — quick reaction palette
- `apps/ionosphere/src/app/components/TextSelection.tsx` — handles text selection → comment/react
- `apps/ionosphere-appview/src/public-jetstream.ts` — Jetstream subscription for public network

### Modified
- `apps/ionosphere-appview/src/db.ts` — add comments table
- `apps/ionosphere-appview/src/indexer.ts` — handle tv.ionosphere.comment events
- `apps/ionosphere-appview/src/routes.ts` — add comment endpoints
- `apps/ionosphere-appview/src/appview.ts` — start public Jetstream connection
- `apps/ionosphere/src/app/components/NavHeader.tsx` — add auth button
- `apps/ionosphere/src/app/components/TranscriptView.tsx` — render comment highlights
- `apps/ionosphere/src/app/layout.tsx` — OAuth provider wrapper
- `apps/ionosphere/public/client-metadata.json` — OAuth client metadata
