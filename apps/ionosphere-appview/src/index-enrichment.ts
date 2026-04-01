// ─── Index Enrichment ────────────────────────────────────────────────────────
//
// Takes raw concordance entries + concept data and produces enriched index
// entries with subentries, cross-references, and see/see-also redirects.

export interface TalkRef {
  rkey: string;
  title: string;
  count: number;
  firstTimestampNs: number;
}

export interface Subentry {
  label: string; // concept name providing the context
  talks: TalkRef[];
}

export interface EnrichedEntry {
  term: string;
  proper: boolean;
  talks: TalkRef[]; // references not covered by subentries
  subentries: Subentry[];
  see: string[]; // "see" redirects (this term → canonical)
  seeAlso: string[]; // "see also" cross-references
  totalCount: number;
}

export interface ConceptData {
  name: string;
  rkey: string;
  aliases: string[];
  talkRkeys: string[]; // talks this concept appears in
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Lowercase tokenize a string into words. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/]+/)
    .filter(Boolean);
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Enrich concordance entries with concept data.
 *
 * @param entries - Raw concordance entries (word + talks)
 * @param concepts - Concept data from the appview DB
 * @returns Enriched entries with subentries, see, seeAlso
 */
export function enrichIndex(
  entries: Array<{ word: string; proper: boolean; talks: TalkRef[] }>,
  concepts: ConceptData[]
): EnrichedEntry[] {
  // 1. Build word→concepts map
  const wordToConcepts = new Map<string, ConceptData[]>();
  for (const concept of concepts) {
    const names = [concept.name, ...concept.aliases];
    const seenWords = new Set<string>();
    for (const name of names) {
      for (const word of tokenize(name)) {
        if (seenWords.has(word)) continue;
        seenWords.add(word);
        const existing = wordToConcepts.get(word);
        if (existing) {
          existing.push(concept);
        } else {
          wordToConcepts.set(word, [concept]);
        }
      }
    }
  }

  // 4. Build alias→canonical "see" map
  const aliasSeeMap = new Map<string, string>();
  for (const concept of concepts) {
    for (const alias of concept.aliases) {
      aliasSeeMap.set(alias.toLowerCase(), concept.name);
    }
  }

  // Build entry lookup by word (lowercased) for seeAlso
  const entryWordSet = new Set(entries.map((e) => e.word.toLowerCase()));

  // Build word→concepts-that-contain-this-entry for seeAlso computation
  // For each entry, find which concepts it co-occurs with (via talk overlap)
  const wordToConceptRkeys = new Map<string, Set<string>>();
  for (const entry of entries) {
    const wordLower = entry.word.toLowerCase();
    const talkRkeySet = new Set(entry.talks.map((t) => t.rkey));
    const matchingConcepts = new Set<string>();

    for (const concept of concepts) {
      const conceptTalkSet = new Set(concept.talkRkeys);
      for (const rkey of talkRkeySet) {
        if (conceptTalkSet.has(rkey)) {
          matchingConcepts.add(concept.rkey);
          break;
        }
      }
    }
    wordToConceptRkeys.set(wordLower, matchingConcepts);
  }

  const result: EnrichedEntry[] = [];

  for (const entry of entries) {
    const wordLower = entry.word.toLowerCase();
    const totalCount = entry.talks.reduce((sum, t) => sum + t.count, 0);

    // "see" redirects from aliases
    const see: string[] = [];
    const canonical = aliasSeeMap.get(wordLower);
    if (canonical) {
      see.push(canonical);
    }

    // 2. Generate subentries for entries in 3+ talks
    const subentries: Subentry[] = [];
    let topLevelTalks = entry.talks;

    if (entry.talks.length >= 3) {
      const coveredRkeys = new Set<string>();

      // Only use concepts directly related to this word (name/alias match)
      const relatedConcepts = wordToConcepts.get(wordLower) ?? [];

      for (const concept of relatedConcepts) {
        const conceptTalkRkeys = new Set(concept.talkRkeys);
        const subTalks = entry.talks.filter((t) => conceptTalkRkeys.has(t.rkey));
        if (subTalks.length > 0) {
          subentries.push({ label: concept.name, talks: subTalks.slice(0, 3) });
          for (const t of subTalks) coveredRkeys.add(t.rkey);
        }
      }

      // Cap subentries at 3 most relevant (by talk count)
      subentries.sort((a, b) => b.talks.length - a.talks.length);
      subentries.splice(3);

      // Top-level talks are those not covered by any subentry
      topLevelTalks = entry.talks.filter((t) => !coveredRkeys.has(t.rkey));
    }

    // 3. Generate seeAlso from shared concepts
    // Only include entries that share 2+ concepts AND are directly
    // referenced by a concept name/alias (not just any word that
    // happens to appear in the same talk)
    const myDirectConcepts = wordToConcepts.get(wordLower) ?? [];
    const myConceptRkeys = new Set(myDirectConcepts.map((c) => c.rkey));
    const seeAlso: string[] = [];

    if (myConceptRkeys.size > 0) {
      const relatedEntryScores = new Map<string, number>();

      for (const otherEntry of entries) {
        const otherLower = otherEntry.word.toLowerCase();
        if (otherLower === wordLower) continue;

        const otherDirectConcepts = wordToConcepts.get(otherLower) ?? [];
        let sharedCount = 0;
        for (const c of otherDirectConcepts) {
          if (myConceptRkeys.has(c.rkey)) sharedCount++;
        }
        if (sharedCount >= 2) {
          relatedEntryScores.set(otherEntry.word, sharedCount);
        }
      }

      const sorted = [...relatedEntryScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      for (const [word] of sorted) seeAlso.push(word);
    }

    result.push({
      term: entry.word,
      proper: entry.proper,
      talks: topLevelTalks.slice(0, 5),
      subentries,
      see,
      seeAlso,
      totalCount,
    });
  }

  // 5. Generate inversions for multi-word proper noun entries
  const existingTerms = new Set(result.map((e) => e.term.toLowerCase()));

  const inversions: EnrichedEntry[] = [];
  for (const entry of entries) {
    if (!entry.proper) continue;
    const parts = entry.word.split(/\s+/);
    if (parts.length < 2) continue;

    // "First Last" → "Last, First"
    const inverted = `${parts.slice(1).join(" ")}, ${parts[0]}`;
    if (existingTerms.has(inverted.toLowerCase())) continue;
    existingTerms.add(inverted.toLowerCase());

    inversions.push({
      term: inverted,
      proper: true,
      talks: [],
      subentries: [],
      see: [entry.word],
      seeAlso: [],
      totalCount: 0,
    });
  }

  return [...result, ...inversions];
}
