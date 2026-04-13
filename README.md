# Ionosphere

**A semantically enriched conference video archive for [ATmosphereConf 2026](https://atmosphereconf.org).**

[ionosphere.tv](https://ionosphere.tv)

Ionosphere turns conference recordings into a browsable, searchable, interconnected archive. Every talk is transcribed with word-level timestamps, enriched with extracted concepts and topics, and linked to the social conversation that happened around it on Bluesky.

Built as an entry for the [Streamplace](https://stream.place) VOD JAM.

## What's here

**Talks & Transcripts** — 95+ talks with synchronized video playback and word-level transcripts. Click any word to jump to that moment. Leave comments and reactions anchored to specific passages.

**Concordance Index** — A multi-column concordance of every significant term across all talks, with cross-references and timecode links. Scroll horizontally through the index and click any entry to watch the relevant moment.

**Community** — A curated overview of what people said about the conference on Bluesky: top posts, blog recaps with OG previews, conference photos, YouTube talk uploads, 20+ VOD JAM sites, and 80+ projects featured at the conference. Built by pulling ~2,000 posts from the Bluesky search API, extracting links and images, matching posts to talks by speaker mentions and timestamps.

**Mentions** — On each talk page, a sidebar shows Bluesky posts that mentioned the speaker during their talk, time-aligned with the transcript. Thread replies expand inline. Click a mention to seek the video to that moment.

**Speakers & Concepts** — Browse talks by speaker or by extracted concept. The NLP pipeline identifies named entities, topics, and relationships across talks, linking them into a navigable web.

## Architecture

Ionosphere is built on [AT Protocol](https://atproto.com). Talks, speakers, transcripts, and concepts are published as AT Protocol records on a PDS, making the entire archive addressable and interoperable with the atmosphere ecosystem.

- **Appview** — A Hono server that indexes records from Jetstream, serves XRPC endpoints, and manages a SQLite database. Enrichment pipelines handle transcription (Whisper), sentence/paragraph segmentation, named entity recognition, concept extraction, and speaker diarization.
- **Frontend** — A Next.js app with synchronized video playback (HLS.js), scroll-synced transcript rendering, OAuth-based commenting, and multi-column layouts using greedy column-fill algorithms.
- **Data** — Conference schedule ingested from the ATmosphereConf calendar, VOD recordings from Streamplace, transcripts aligned to talk boundaries using diarization-based chunking.

## Development

```bash
# Start local PDS + Jetstream
cd apps/ionosphere-appview
docker compose up -d

# Start appview
PORT=3001 npx tsx src/appview.ts

# Start frontend (use 127.0.0.1 for OAuth)
cd apps/ionosphere
NEXT_PUBLIC_API_URL=http://localhost:3001 npx next dev
```

## Deployment

Deployed on [Fly.io](https://fly.io) with persistent SQLite storage.

```bash
flyctl deploy --config fly.appview.toml --remote-only
flyctl deploy --config fly.web.toml --remote-only
curl -X POST https://api.ionosphere.tv/xrpc/tv.ionosphere.invalidate
```

## Author

Built by [Blaine Cook](https://bsky.app/profile/blaine.bsky.social).

## License

MIT
