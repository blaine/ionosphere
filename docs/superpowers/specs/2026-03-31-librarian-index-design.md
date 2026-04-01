# Librarian-Grade Word Index

## Overview

Transform the raw concordance into a professional back-of-book index with lemmatization, multi-word terms, subentries, cross-references, proper noun handling, and inverted entries. Chicago Manual of Style chapter 16 as the reference standard.

## Data Pipeline

Four preprocessing stages run in the concordance builder before word→talk aggregation.

### Stage 1: Multi-word term detection

- **Concept-sourced terms:** Mark transcript spans matching concept names and aliases (760+ terms from LLM enrichment). These become single index entries.
- **Statistical bigrams:** Extract word pairs with PMI (pointwise mutual information) above threshold, appearing in 2+ talks. Filter pairs where either word is a stopword. These catch terms the LLM missed.
- Multi-word terms are single index entries. Constituent words also appear standalone with "see also" pointing to the multi-word term.

### Stage 2: Lemmatization

Using `compromise` NLP library:

- Collapse plurals (protocols→protocol), verb conjugations (building→build), -ing/-ed/-tion forms
- Normalize British/American spelling (normalise→normalize, colour→color)
- Merge abbreviations with expansions using concept aliases (API filed under "application programming interface" with "see" from API)
- Index entry shows the lemma. All inflected forms' occurrences merge under it.
- `compromise` provides POS tagging — prefer noun forms as the lemma.

### Stage 3: Concept enrichment

- For each lemmatized word, look up co-occurring concepts (via concept annotations on the same transcript)
- **Subentries** when a word appears in 3+ talks: group references by the co-occurring concept. "protocol" → subentry "AT Protocol (3)", subentry "governance (2)"
- **See also** from concept co-occurrence: words that frequently share concepts get cross-referenced
- **See** for synonyms: concept aliases generate redirects ("decentralised → see decentralized")

### Stage 4: Proper noun detection

- Words capitalized in >80% of transcript occurrences → proper noun
- Rendered with original capitalization in the index
- Multi-word proper nouns get inverted entries: "AT Protocol" also appears as "Protocol, AT → see AT Protocol"

## API Response Shape

```typescript
interface IndexEntry {
  term: string;              // lemmatized display form
  proper: boolean;           // render with original capitalization
  talks: TalkRef[];          // direct references (not covered by subentries)
  subentries: Subentry[];    // grouped by concept context
  see: string[];             // redirects to canonical form
  seeAlso: string[];         // cross-references to related terms
  totalCount: number;
}

interface Subentry {
  label: string;             // concept name or context label
  talks: TalkRef[];
}

interface TalkRef {
  rkey: string;
  title: string;
  count: number;
  firstTimestampNs: number;
}
```

## Rendering

Entry with subentries:
```
protocol — Opening Remarks (1)
  — AT Protocol, Building with AT Protocol (3), Protocol Governance (2)
  — design, Decentralized Identity (2)
  — governance, Protocol Governance (5), Keynote (1)
  see also: decentralization, federation, lexicon
```

Simple entry:
```
zurich — Research Synthesis (1)
```

See redirect:
```
decentralised — see decentralized
```

Proper noun with inversion:
```
AT Protocol — Building with AT Protocol (3), Protocol Governance (2)
Protocol, AT — see AT Protocol
```

## Dependencies

- `compromise` — NLP: lemmatization, POS tagging, proper noun detection. Zero dependencies, runs in Node.
- Statistical bigram extraction — pure math on word co-occurrence, no dependency.
- Existing: concept data from appview SQLite (annotations + concepts tables).

## Files

### Modified
- `apps/ionosphere-appview/src/concordance.ts` — add preprocessing pipeline stages
- `apps/ionosphere-appview/src/routes.ts` — `/index` endpoint returns enriched entries
- `apps/ionosphere/src/app/concordance/IndexContent.tsx` — render subentries, see/see also, proper nouns

### New
- `apps/ionosphere-appview/src/lemmatize.ts` — compromise wrapper for lemmatization + POS
- `apps/ionosphere-appview/src/bigrams.ts` — PMI-based bigram extraction
- `apps/ionosphere-appview/src/index-enrichment.ts` — concept-based subentries, cross-refs, see/see also
