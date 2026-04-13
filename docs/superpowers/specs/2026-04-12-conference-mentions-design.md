# Conference Mentions Integration

Surface Bluesky mentions of speakers during (and after) their talks, time-aligned with the transcript in the ionosphere.tv UI.

## Data Model

### `mentions` table (SQLite)

```sql
CREATE TABLE mentions (
  uri TEXT PRIMARY KEY,           -- at:// URI of the Bluesky post
  talk_uri TEXT,                  -- talk this aligns to (null for unaligned buzz)
  author_did TEXT NOT NULL,
  author_handle TEXT,
  text TEXT,
  created_at TEXT NOT NULL,
  talk_offset_ms INTEGER,         -- ms into the talk when posted
  byte_position INTEGER,          -- transcript byte position (from offset)
  likes INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  parent_uri TEXT,                -- non-null for thread replies
  mention_type TEXT DEFAULT 'during_talk',  -- 'during_talk' | 'post_conference'
  indexed_at TEXT NOT NULL
);

CREATE INDEX idx_mentions_talk ON mentions(talk_uri, talk_offset_ms);
CREATE INDEX idx_mentions_parent ON mentions(parent_uri);
```

Thread replies share the parent's `talk_uri` and `byte_position`.

Author profiles reuse the existing `profiles` table (already caches handle, display_name, avatar_url from the Bluesky public API).

## Fetch Script: `scripts/fetch-mentions.mjs`

Enhanced version of the exploration scripts already built. Runs as a batch job, not a live service.

### During-talk mentions

For each talk with a schedule (`starts_at`, `ends_at`):
1. Search `app.bsky.feed.searchPosts` with `mentions=<speaker_handle>`, `since=starts_at - 5min`, `until=ends_at + 30min`
2. Paginate with cursors until exhausted (current scripts cap at 100)
3. Compute `talk_offset_ms = mention.createdAt - talk.starts_at`
4. Map offset to `byte_position` using transcript word-level timings
5. For each mention with replies, fetch thread via `app.bsky.feed.getPostThread` (depth 1-2)
6. Upsert into `mentions` table

### Post-conference mentions

Wider searches with no `until` bound:
- `domain=ionosphere.tv` — posts linking to talk pages
- `domain=stream.place` — posts linking to VODs
- `mentions=<speaker_handle>` + `q=atmosphere OR atmosphereconf` with `since=2026-03-30`

These get `mention_type='post_conference'` and align to a talk by matching the speaker.

### Byte position mapping

The transcript stores word-level timings as a compact array (positive = word duration ms, negative = silence gap ms). To map a `talk_offset_ms` to a byte position:

1. Walk the timings array, accumulating elapsed time
2. When elapsed >= talk_offset_ms, return the current byte offset
3. If the mention falls outside transcript range, use the nearest boundary

This is done at fetch time and stored, not computed on every request.

## API Endpoint

### `tv.ionosphere.getMentions`

```
GET /xrpc/tv.ionosphere.getMentions?talkRkey=<rkey>
```

Response:
```json
{
  "mentions": [
    {
      "uri": "at://did:plc:.../app.bsky.feed.post/...",
      "author_did": "did:plc:...",
      "author_handle": "faineg.bsky.social",
      "author_display_name": "Faine G",
      "author_avatar_url": "https://...",
      "text": "as @kissane notes...",
      "created_at": "2026-03-28T21:32:15.000Z",
      "talk_offset_ms": 872000,
      "byte_position": 4521,
      "likes": 137,
      "reposts": 12,
      "replies": 3,
      "parent_uri": null,
      "mention_type": "during_talk",
      "thread": [
        {
          "uri": "at://...",
          "author_handle": "...",
          "author_display_name": "...",
          "author_avatar_url": "...",
          "text": "reply text...",
          "created_at": "...",
          "likes": 5
        }
      ]
    }
  ],
  "total": 51
}
```

Backend query joins `mentions` with `profiles` for author enrichment. Thread replies are nested under their parent. Sorted by `talk_offset_ms` (during-talk first, post-conference after).

## Frontend

### Right sidebar tabs

Add a "Mentions" tab alongside existing "Concepts" tab in `TalkContent.tsx`:

```
[Concepts] [Mentions (51)]
```

Tab count comes from the API response `total`.

### `MentionsSidebar` component

Renders mention cards in a scrollable column with pretext spacers for vertical alignment with the transcript.

**Scroll sync:** Listens to `TimestampProvider` context. Uses the same scroll-position logic as `TranscriptView` — maps current playback nanoseconds to a byte position, then scrolls to keep the matching mention near the viewport center.

**Pretext spacers:** Each mention card is positioned using top-padding calculated from its `byte_position` relative to the previous mention's position. When a thread is expanded/collapsed, spacers below are recalculated to maintain alignment.

**Mention card contents:**
- Author avatar (18px circle) + handle + like count
- Post text (truncated to ~120 chars, expandable)
- "↳ N replies" link for threads
- Click anywhere on card → seek video to `talk_offset_ms`

**Thread expansion:**
- Clicking "↳ N replies" expands replies inline below the parent card
- Reply cards are indented and slightly smaller
- Spacers below recalculate on expand/collapse
- Each reply is also clickable to open the full post on Bluesky (external link)

**Post-conference section:**
- After all during-talk mentions, a divider: "After the conference"
- Post-conference mentions listed chronologically, no time alignment
- These don't scroll-sync with playback

### Mobile

Right sidebar is hidden on mobile (existing behavior). Mentions accessible via a tab/accordion below the transcript, same as concepts.

## Not in scope

- Real-time mention streaming or webhooks
- Composing/replying to mentions from within ionosphere
- Full-text search within mentions
- Mentions of non-speaker topics (conference hashtags without speaker tags)
