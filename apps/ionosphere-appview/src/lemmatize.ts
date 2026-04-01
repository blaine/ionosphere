import nlp from "compromise";

/**
 * British → American spelling patterns.
 * Each entry: [British regex, American replacement]
 */
const BRITISH_TO_AMERICAN: [RegExp, string][] = [
  [/ise$/,  "ize"],
  [/ised$/, "ized"],
  [/ising$/, "izing"],
  [/isation$/, "ization"],
  [/our$/, "or"],
  [/ours$/, "ors"],
  [/ogue$/, "og"],
  [/yse$/, "yze"],
  [/ysed$/, "yzed"],
  [/ysing$/, "yzing"],
  [/ence$/, "ense"],  // defence → defense
  [/lled$/, "led"],   // travelled → traveled
  [/lling$/, "ling"], // travelling → traveling
];

function americanize(word: string): string {
  for (const [pattern, replacement] of BRITISH_TO_AMERICAN) {
    if (pattern.test(word)) {
      return word.replace(pattern, replacement);
    }
  }
  return word;
}

/**
 * Lemmatize a word to its dictionary base form using compromise NLP.
 * - Plurals: protocols → protocol
 * - Verb forms: building → build, decentralized → decentralize
 * - British/American: normalise → normalize, colour → color
 * Returns the lemma in lowercase.
 */
export function lemmatize(word: string): string {
  const lower = word.toLowerCase().trim();
  if (!lower) return lower;

  // Try British → American first so compromise works on American forms
  const americanized = americanize(lower);

  const doc = nlp(americanized);

  // Try verb → infinitive
  const verbResult = doc.verbs().toInfinitive().out("text");
  if (verbResult && verbResult.trim()) {
    return verbResult.trim().toLowerCase();
  }

  // Try noun → singular
  const nounResult = doc.nouns().toSingular().out("text");
  if (nounResult && nounResult.trim()) {
    return nounResult.trim().toLowerCase();
  }

  // Fallback: strip common verb suffixes that compromise misses
  // (e.g., "decentralized" tagged as adjective, not verb)
  if (americanized.endsWith("ized")) {
    return americanized.slice(0, -1); // decentralized → decentralize
  }
  if (americanized.endsWith("ised")) {
    return americanized.slice(0, -4) + "ize"; // organised → organize
  }

  // Fall back to americanized lowercase
  return americanized;
}

/**
 * Check if a word is a proper noun based on its original casing.
 * A word is "proper" if it was capitalized in the original text.
 */
export function isProperNoun(word: string, originalCasing: string): boolean {
  if (!originalCasing || originalCasing.length === 0) return false;
  const first = originalCasing[0];
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

/**
 * Normalize abbreviation/expansion pairs.
 * Given a word and a set of known aliases (from concept data),
 * return the canonical expansion if this is an abbreviation.
 * E.g., "api" with alias mapping {"api": "application programming interface"}
 * returns "application programming interface".
 * Returns null if not an abbreviation.
 */
export function expandAbbreviation(
  word: string,
  aliasMap: Map<string, string>
): string | null {
  const lower = word.toLowerCase().trim();
  return aliasMap.get(lower) ?? null;
}
