import { isStopword } from "./stopwords.js";

export interface Bigram {
  term: string;       // "content moderation", "open source", etc.
  words: [string, string];
  pmi: number;        // pointwise mutual information score
  talkCount: number;  // number of talks containing this bigram
}

/**
 * Tokenize text into lowercased words, keeping only alphabetic tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);
}

/**
 * Extract statistically significant bigrams from transcript texts.
 *
 * @param texts - Array of { text, talkRkey } from transcripts
 * @param knownTerms - Set of known multi-word terms from concepts (to boost)
 * @param minTalks - Minimum number of talks a bigram must appear in (default 2)
 * @param minPmi - Minimum PMI score (default 3.0)
 */
export function extractBigrams(
  texts: Array<{ text: string; talkRkey: string }>,
  knownTerms: Set<string>,
  minTalks = 2,
  minPmi = 3.0,
): Bigram[] {
  if (texts.length === 0) return [];

  // Normalise known terms to lowercase for matching
  const knownLower = new Set<string>();
  for (const t of knownTerms) knownLower.add(t.toLowerCase());

  // Count unigram and bigram frequencies across the whole corpus,
  // plus per-talk presence for bigrams.
  const unigramCount = new Map<string, number>();
  const bigramCount = new Map<string, number>();
  const bigramTalks = new Map<string, Set<string>>();
  let totalUnigrams = 0;
  let totalBigrams = 0;

  for (const { text, talkRkey } of texts) {
    const words = tokenize(text);
    // Filter stopwords for bigram extraction
    const filtered = words.filter((w) => !isStopword(w));

    // Unigram counts (non-stopwords only, matching bigram vocabulary)
    for (const w of filtered) {
      unigramCount.set(w, (unigramCount.get(w) ?? 0) + 1);
      totalUnigrams++;
    }

    // Bigram counts from the filtered stream
    const seenInTalk = new Set<string>();
    for (let i = 0; i < filtered.length - 1; i++) {
      const key = `${filtered[i]} ${filtered[i + 1]}`;
      bigramCount.set(key, (bigramCount.get(key) ?? 0) + 1);
      totalBigrams++;
      if (!seenInTalk.has(key)) {
        seenInTalk.add(key);
        if (!bigramTalks.has(key)) bigramTalks.set(key, new Set());
        bigramTalks.get(key)!.add(talkRkey);
      }
    }
  }

  if (totalBigrams === 0) return [];

  // Compute PMI for each bigram and filter
  const results: Bigram[] = [];

  for (const [key, count] of bigramCount) {
    const [w1, w2] = key.split(" ") as [string, string];
    const talkCount = bigramTalks.get(key)?.size ?? 0;

    const pBigram = count / totalBigrams;
    const pW1 = (unigramCount.get(w1) ?? 0) / totalUnigrams;
    const pW2 = (unigramCount.get(w2) ?? 0) / totalUnigrams;

    if (pW1 === 0 || pW2 === 0) continue;

    const pmi = Math.log2(pBigram / (pW1 * pW2));

    const isKnown = knownLower.has(key);
    const pmiThreshold = isKnown ? 0 : minPmi;
    const talkThreshold = isKnown ? 1 : minTalks;

    if (pmi >= pmiThreshold && talkCount >= talkThreshold) {
      results.push({ term: key, words: [w1, w2], pmi, talkCount });
    }
  }

  // Sort by PMI descending
  results.sort((a, b) => b.pmi - a.pmi);
  return results;
}
