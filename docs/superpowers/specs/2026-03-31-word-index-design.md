# Word Index: Conference Concordance

## Overview

A book-style concordance page at `/index`. Every non-stopword from every transcript, alphabetized, multi-column typeset layout. Each word links to its occurrences across talks. Clicking an occurrence loads the video and transcript in a fixed side panel, scrolled to and highlighting the target word.

## Layout

- **Left ~75%:** Pretext-rendered multi-column word index, scrollable
- **Right ~25%:** Fixed player column — VideoPlayer on top, TranscriptView below, persists as you browse

## Word Index (left panel)

**Data source:** Raw transcript text from all talks. Split on whitespace, lowercase, filter stopwords, aggregate across talks.

**Stopwords:** Standard English stopword list plus filler words (um, uh, like, you know). Hardcoded, small, refinable later.

**Entry format:**
```
atproto — Building with AT Protocol (3), Protocol Governance (2), ...
```

Each talk reference is clickable. Number is occurrence count in that talk.

**Letter headings:** Bold section breaks (A, B, C...) grouped with their entries.

**Typesetting:** Pretext (`chenglou/pretext`) handles multi-column layout.
- `prepare()` all index entries once
- `layoutWithLines()` to flow into balanced columns
- Proper column balancing (not CSS fill-left-then-right)
- Height measurement for virtualization (concordance could be thousands of entries)
- Letter headings kept grouped with first entries

## Player Column (right panel)

**On click:** Clicking a talk reference in the index:
1. Loads the video in the VideoPlayer (same component, with offset support)
2. Shows the full TranscriptView below the video
3. Scrolls the transcript to the target word
4. Highlights the index term in the transcript

**Reuse:** VideoPlayer and TranscriptView are existing components. The brightness wave, scroll-scrub, and concept highlighting all come for free. The player column is essentially a mini talk viewer.

**Persistence:** The player stays fixed as you scroll the index. Clicking a different word/talk swaps the content.

## API

New appview endpoint: `GET /index`

Returns the concordance built from transcripts + compact timings in SQLite:
```json
{
  "words": [
    {
      "word": "atproto",
      "talks": [
        {
          "rkey": "ats26-keynote",
          "title": "Keynote: Towards Modular Open Science",
          "count": 3,
          "firstTimestampNs": 1234567890
        }
      ]
    }
  ]
}
```

Built at serve time: decode compact transcripts, split text, filter stopwords, aggregate by word across talks. Cacheable — transcripts don't change at runtime.

## Dependencies

- `pretext` — text measurement and multi-column layout
- Existing: `VideoPlayer`, `TranscriptView`, `TimestampProvider`
