# Conference Discussion Page

A curated, high-density overview of what people said about ATmosphereConf 2026 — top posts, recaps & blog posts, follow-up videos, and VOD sites. Displayed in tight responsive columns matching the concordance index style.

## Layout

Multi-column greedy-fill layout (same as `IndexContent.tsx`). Content flows across columns naturally. Sections act as dividers within the flow.

**Left nav**: Section shortcuts (T/R/V) for quick jumping, like the letter nav on the concordance.

**Filter bar**: At the top, filter pills to show all or just one medium:
- All (default)
- Top Posts
- Recaps & Blog Posts
- Videos & VOD Sites

Plus a text filter input for searching within visible items.

**Right panel**: Click any post that has an associated talk → opens the talk video + transcript in a slide-out panel (same pattern as concordance click-to-play).

## Sections

### Top Posts

All conference mentions sorted by likes (descending). Each item:
- 14px avatar + handle + like count (inline)
- Post text (1-2 lines, truncated)
- Talk link → (if matched to a talk) + "View on Bluesky ↗"

### Recaps & Blog Posts

Posts containing links to blog/article domains, identified by facet URIs. Each item:
- Avatar + handle + like count
- Post text or OG title (prefer OG title when available)
- Domain link ↗ (green accent)
- Talk link → (if matched by speaker mentions)

OG metadata (title, description) fetched at index time and stored. No images — just title + domain to keep it tight.

### Videos & VOD Sites

Posts linking to video platforms. Each item:
- Avatar + handle + like count
- Post text
- Video link ↗ (purple accent)
- Talk link → (if matched)

Plus a compact pill directory of all VOD JAM sites as clickable external links.

### Stats Card

Aggregate numbers: total posts, blog recaps, VOD sites, unique people.

## Data

### Wider search (fetch script extension)

Extend `fetch-mentions.mjs` with a new phase that searches for:

**Blog/recap posts:**
- `q: "atmosphereconf recap"`, `q: "atmosphereconf wrote"`, `q: "atmosphereconf takeaway"`, `q: "atmosphereconf writeup"`
- `q: "atmosphere"` with `author:` for known community writers

**VOD/video posts:**
- `domain:` searches for each known VOD site:
  - stream.place, vods.sky.boo, vod.atverkackt.de, ionosphere.tv, atmosphereconf-vods.wisp.place, rpg.actor, vod.j4ck.xyz, atmosphere-vods.j4ck.xyz, atmosphereconf-tv.btao.org, stream-bsky.pages.dev, sites.wisp.place, vods.ajbird.net, streamhut.wisp.place, conf-vods.wisp.place, aetheros.computer, atmo.rsvp, atmosphereconf.org, youtube.com (with atmosphere keywords)

**ionosphere.tv links:**
- `domain: ionosphere.tv` — already done, can extract talk rkey from URL

### New fields in mentions table

Add `content_type` column: `post` | `blog` | `video` | `vod_site`

Add `external_url` column: the primary external link from facets (blog URL, VOD URL).

Add `og_title` column: OG metadata title fetched from external URL (nullable).

### Talk matching

1. **Direct URL match**: If post links to `ionosphere.tv/talks/RKEY`, match directly
2. **Speaker mention match**: If post @-mentions a speaker, match to their talks (prefer talks during the post's time window)
3. **Keyword match**: If post text contains a talk title (fuzzy), match to that talk

Store matched `talk_uri` on the mention row.

### OG metadata fetching

For blog/recap posts with external URLs, fetch the page and extract `<meta property="og:title">` and `<meta property="og:description">`. Store in `og_title` column. Skip if fetch fails — text from the Bluesky post is the fallback.

## API

### `tv.ionosphere.getDiscussion`

Returns all discussion items grouped by content_type, sorted by likes within each group.

```
GET /xrpc/tv.ionosphere.getDiscussion
```

Response:
```json
{
  "posts": [...],       // content_type = 'post', sorted by likes desc
  "blogs": [...],       // content_type = 'blog'
  "videos": [...],      // content_type = 'video' or 'vod_site'
  "vodSites": [...],    // unique VOD site domains as strings
  "stats": { "totalPosts": N, "blogCount": N, "vodSiteCount": N, "uniqueAuthors": N }
}
```

Each item includes: uri, author_handle, author_display_name, author_avatar_url, text, likes, reposts, external_url, og_title, talk_rkey, talk_title, content_type.

## Frontend

### Route: `/discussion`

New Next.js page at `apps/ionosphere/src/app/discussion/page.tsx`.

### Component: `DiscussionContent.tsx`

Based on the concordance `IndexContent.tsx` pattern:
- Greedy column-fill with section headers as flow items
- Filter bar (medium pills + text search)
- Section nav sidebar
- Click-to-play right panel for talk associations
- Mobile: single column with progressive rendering

### Nav update

Add "Discussion" link to the site nav in `layout.tsx`.

## Not in scope

- Real-time updates
- Editing/curating items manually
- Full OG card with images (just title + domain)
- Comment/reply threading on the discussion page (that's on the talk page)
