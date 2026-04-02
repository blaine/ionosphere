import { decode } from "@ionosphere/format/transcript-encoding";
import { isStopword } from "./stopwords.js";
import { lemmatize, isProperNoun } from "./lemmatize.js";
import { extractBigrams } from "./bigrams.js";
import { enrichIndex, type ConceptData, type EnrichedEntry, type TalkRef } from "./index-enrichment.js";
import englishWords from "an-array-of-english-words";

export type { EnrichedEntry, ConceptData, TalkRef };

const DICTIONARY = new Set(englishWords.map((w: string) => w.toLowerCase()));

interface TranscriptInput {
  talkRkey: string;
  talkTitle: string;
  text: string;
  startMs: number;
  timings: number[];
}

export function buildConcordance(
  transcripts: TranscriptInput[],
  concepts?: ConceptData[]
): EnrichedEntry[] {
  const conceptList = concepts ?? [];

  // Stage 1: Extract bigrams using concept names as known terms
  const knownTerms = new Set<string>();
  for (const c of conceptList) {
    knownTerms.add(c.name);
    for (const alias of c.aliases) knownTerms.add(alias);
  }

  const bigramTexts = transcripts.map((t) => ({ text: t.text, talkRkey: t.talkRkey }));
  const bigrams = extractBigrams(bigramTexts, knownTerms);
  const bigramTermSet = new Set(bigrams.map((b) => b.term));

  // Stage 2: Lemmatize words, track proper nouns, aggregate into entries
  // Track: lemma -> { properCount, lowerCount, originalCapitalized (most common casing), talkMap }
  const index = new Map<string, {
    properCount: number;
    lowerCount: number;
    originalCapitalized: string;
    talkMap: Map<string, { title: string; count: number; firstTimestampNs: number; timestampsNs: number[] }>;
  }>();

  for (const t of transcripts) {
    const decoded = decode({ text: t.text, startMs: t.startMs, timings: t.timings });
    const words = t.text.split(/\s+/).filter((w) => w.length > 0);

    for (let i = 0; i < words.length; i++) {
      const originalCasing = words[i];
      let raw = originalCasing.toLowerCase().replace(/[^a-z0-9'-]/g, "");
      // Strip possessives
      raw = raw.replace(/'s$/, "").replace(/\u2019s$/, "");
      // Strip leading/trailing punctuation remnants
      raw = raw.replace(/^['-]+/, "").replace(/['-]+$/, "");
      if (!raw || isStopword(raw) || !/^[a-z]/.test(raw)) continue;

      // Lemmatize after stopword check
      const lemma = lemmatize(raw);
      if (!lemma || isStopword(lemma)) continue;

      const proper = isProperNoun(raw, originalCasing);
      const timestampNs = i < decoded.words.length ? Math.round(decoded.words[i].start * 1e9) : 0;

      if (!index.has(lemma)) {
        index.set(lemma, {
          properCount: 0,
          lowerCount: 0,
          originalCapitalized: proper ? originalCasing.replace(/[^a-zA-Z0-9'-]/g, "") : lemma,
          talkMap: new Map(),
        });
      }

      const entry = index.get(lemma)!;
      if (proper) {
        entry.properCount++;
        // Update original casing to the most common capitalized form
        entry.originalCapitalized = originalCasing.replace(/[^a-zA-Z0-9'-]/g, "");
      } else {
        entry.lowerCount++;
      }

      if (!entry.talkMap.has(t.talkRkey)) {
        entry.talkMap.set(t.talkRkey, { title: t.talkTitle, count: 1, firstTimestampNs: timestampNs, timestampsNs: [timestampNs] });
      } else {
        const ref = entry.talkMap.get(t.talkRkey)!;
        ref.count++;
        ref.timestampsNs.push(timestampNs);
        if (timestampNs < ref.firstTimestampNs) ref.firstTimestampNs = timestampNs;
      }
    }
  }

  // Build raw entries from lemmatized index
  const rawEntries: Array<{ word: string; proper: boolean; talks: TalkRef[] }> = [];

  for (const [lemma, data] of index) {
    const talks: TalkRef[] = [];
    for (const [rkey, ref] of data.talkMap) {
      const timestamps = ref.timestampsNs.sort((a, b) => a - b);
      talks.push({ rkey, title: ref.title, count: ref.count, firstTimestampNs: ref.firstTimestampNs, timestampsNs: timestamps });
    }
    talks.sort((a, b) => b.count - a.count);

    const isProper = data.properCount > data.lowerCount;
    const displayTerm = isProper ? data.originalCapitalized : lemma;

    // Filter: keep dictionary words, keep non-dictionary if 2+ talks reference
    if (!DICTIONARY.has(lemma) && talks.length < 2) continue;

    rawEntries.push({ word: displayTerm, proper: isProper, talks });
  }

  // Stage 2b: Add bigram terms as entries
  // For each significant bigram, aggregate talk references
  const bigramIndex = new Map<string, Map<string, { title: string; count: number; firstTimestampNs: number; timestampsNs: number[] }>>();

  for (const t of transcripts) {
    const decoded = decode({ text: t.text, startMs: t.startMs, timings: t.timings });
    const words = t.text.split(/\s+/).filter((w) => w.length > 0);
    const lowerWords = words.map((w) => w.toLowerCase().replace(/[^a-z0-9'-]/g, "").replace(/^['-]+/, "").replace(/['-]+$/, ""));

    for (let i = 0; i < lowerWords.length - 1; i++) {
      const w1 = lowerWords[i];
      const w2 = lowerWords[i + 1];
      if (!w1 || !w2) continue;
      const pair = `${w1} ${w2}`;
      if (!bigramTermSet.has(pair)) continue;

      const timestampNs = i < decoded.words.length ? Math.round(decoded.words[i].start * 1e9) : 0;

      if (!bigramIndex.has(pair)) bigramIndex.set(pair, new Map());
      const talkMap = bigramIndex.get(pair)!;

      if (!talkMap.has(t.talkRkey)) {
        talkMap.set(t.talkRkey, { title: t.talkTitle, count: 1, firstTimestampNs: timestampNs, timestampsNs: [timestampNs] });
      } else {
        const ref = talkMap.get(t.talkRkey)!;
        ref.count++;
        ref.timestampsNs.push(timestampNs);
        if (timestampNs < ref.firstTimestampNs) ref.firstTimestampNs = timestampNs;
      }
    }
  }

  for (const [term, talkMap] of bigramIndex) {
    const talks: TalkRef[] = [];
    for (const [rkey, ref] of talkMap) {
      const timestamps = ref.timestampsNs.sort((a, b) => a - b);
      talks.push({ rkey, title: ref.title, count: ref.count, firstTimestampNs: ref.firstTimestampNs, timestampsNs: timestamps });
    }
    talks.sort((a, b) => b.count - a.count);

    // Check if any word in the bigram appears capitalized often (proper noun bigram)
    const bigramWords = term.split(" ");
    const isProper = bigramWords.some((w) => {
      const entry = index.get(lemmatize(w));
      return entry ? entry.properCount > entry.lowerCount : false;
    });

    rawEntries.push({ word: term, proper: isProper, talks });
  }

  rawEntries.sort((a, b) => a.word.localeCompare(b.word));

  // Stages 3 & 4: Enrich with concept data (subentries, see, seeAlso)
  const enriched = enrichIndex(rawEntries, conceptList);

  // Deduplicate: if a multi-word entry is already a subentry label
  // under one of its constituent words, suppress the standalone entry
  const subentryLabels = new Set<string>();
  for (const e of enriched) {
    for (const sub of e.subentries) {
      subentryLabels.add(sub.label.toLowerCase());
    }
  }
  const deduped = enriched.filter(
    (e) => !e.term.includes(" ") || !subentryLabels.has(e.term.toLowerCase())
  );

  deduped.sort((a, b) => a.term.localeCompare(b.term));
  return deduped;
}
