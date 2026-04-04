/**
 * Simple double-metaphone-inspired phonetic encoding.
 * Good enough for matching speaker names across Whisper transcription errors.
 *
 * Not a full double-metaphone implementation — simplified for English names.
 */

const VOWELS = new Set("aeiou");

/**
 * Generate a phonetic code for a word.
 * Returns a 4-character code that groups similar-sounding words.
 */
export function phoneticCode(word: string): string {
  if (!word) return "";
  let s = word.toLowerCase().trim();
  if (s.length === 0) return "";

  // Drop non-alpha
  s = s.replace(/[^a-z]/g, "");
  if (s.length === 0) return "";

  // Common prefix transforms
  if (s.startsWith("kn") || s.startsWith("gn") || s.startsWith("pn") || s.startsWith("wr") || s.startsWith("ae")) {
    s = s.slice(1);
  }
  if (s.startsWith("wh")) s = "w" + s.slice(2);
  if (s.startsWith("x")) s = "s" + s.slice(1);

  let code = s[0].toUpperCase();
  let prev = s[0];

  for (let i = 1; i < s.length && code.length < 6; i++) {
    const c = s[i];
    const next = s[i + 1] || "";

    // Skip vowels (except as first char)
    if (VOWELS.has(c)) { prev = c; continue; }

    let mapped = "";
    switch (c) {
      case "b": mapped = (prev === "m" && !next) ? "" : "B"; break;
      case "c":
        if (next === "h") { mapped = "X"; i++; }
        else if ("eiy".includes(next)) mapped = "S";
        else mapped = "K";
        break;
      case "d":
        if (next === "g" && "eiy".includes(s[i + 2] || "")) { mapped = "J"; i++; }
        else mapped = "T";
        break;
      case "f": mapped = "F"; break;
      case "g":
        if ("eiy".includes(next)) mapped = "J";
        else if (next === "h" && !VOWELS.has(s[i + 2] || "a")) { mapped = ""; i++; }
        else mapped = "K";
        break;
      case "h": mapped = VOWELS.has(prev) ? "" : "H"; break;
      case "j": mapped = "J"; break;
      case "k": mapped = prev === "c" ? "" : "K"; break;
      case "l": mapped = "L"; break;
      case "m": mapped = "M"; break;
      case "n": mapped = "N"; break;
      case "p": mapped = next === "h" ? "F" : "P"; break;
      case "q": mapped = "K"; break;
      case "r": mapped = "R"; break;
      case "s":
        if (next === "h" || (next === "i" && "ao".includes(s[i + 2] || ""))) { mapped = "X"; i++; }
        else mapped = "S";
        break;
      case "t":
        if (next === "h") { mapped = "0"; i++; } // 0 = th sound
        else if (next === "i" && "ao".includes(s[i + 2] || "")) { mapped = "X"; i++; }
        else mapped = "T";
        break;
      case "v": mapped = "F"; break;
      case "w": mapped = VOWELS.has(next) ? "W" : ""; break;
      case "x": mapped = "KS"; break;
      case "y": mapped = VOWELS.has(next) ? "Y" : ""; break;
      case "z": mapped = "S"; break;
      default: mapped = "";
    }

    // Skip duplicates
    if (mapped && mapped !== code[code.length - 1]) {
      code += mapped;
    }
    prev = c;
  }

  return code.slice(0, 6);
}

/**
 * Check if two words sound similar based on phonetic codes.
 */
export function soundsLike(a: string, b: string): boolean {
  if (a.length < 3 || b.length < 3) return false;
  const codeA = phoneticCode(a);
  const codeB = phoneticCode(b);
  if (!codeA || !codeB) return false;

  // Exact phonetic match
  if (codeA === codeB) return true;

  // Prefix match (at least 3 chars)
  const minLen = Math.min(codeA.length, codeB.length);
  if (minLen >= 3 && codeA.slice(0, 3) === codeB.slice(0, 3)) return true;

  // Vowel-initial tolerance: if codes differ only in first char and
  // both start with vowels, they likely sound similar (Erin/Aaron)
  if (codeA.length >= 2 && codeB.length >= 2 &&
      codeA.slice(1) === codeB.slice(1) &&
      "AEIOU".includes(codeA[0]) && "AEIOU".includes(codeB[0])) return true;

  return false;
}

/**
 * Build a phonetic index for an array of words.
 * Returns a map from phonetic code → array of { index, word }.
 */
export function buildPhoneticIndex(words: string[]): Map<string, Array<{ index: number; word: string }>> {
  const index = new Map<string, Array<{ index: number; word: string }>>();
  for (let i = 0; i < words.length; i++) {
    const word = words[i].toLowerCase().replace(/[^a-z'-]/g, "");
    if (word.length < 3) continue;
    const code = phoneticCode(word);
    if (!code) continue;
    if (!index.has(code)) index.set(code, []);
    index.get(code)!.push({ index: i, word });
  }
  return index;
}

/**
 * Search for a name in a word array using phonetic matching.
 * Returns true if a phonetic match is found.
 */
export function phoneticSearch(targetName: string, words: string[]): boolean {
  const targetParts = targetName.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (targetParts.length === 0) return false;

  const wordsLower = words.map((w) => w.toLowerCase().replace(/[^a-z'-]/g, ""));

  for (const part of targetParts) {
    const targetCode = phoneticCode(part);
    if (!targetCode || targetCode.length < 2) continue;

    for (const word of wordsLower) {
      if (word.length < 3) continue;
      if (soundsLike(part, word)) return true;
    }
  }

  return false;
}
