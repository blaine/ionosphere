import { decode } from "@ionosphere/format/transcript-encoding";
import { isStopword } from "./stopwords.js";

export interface ConcordanceTalkRef {
  rkey: string;
  title: string;
  count: number;
  firstTimestampNs: number;
}

export interface ConcordanceEntry {
  word: string;
  talks: ConcordanceTalkRef[];
  totalCount: number;
}

interface TranscriptInput {
  talkRkey: string;
  talkTitle: string;
  text: string;
  startMs: number;
  timings: number[];
}

export function buildConcordance(transcripts: TranscriptInput[]): ConcordanceEntry[] {
  const index = new Map<string, Map<string, { title: string; count: number; firstTimestampNs: number }>>();

  for (const t of transcripts) {
    const decoded = decode({ text: t.text, startMs: t.startMs, timings: t.timings });
    const words = t.text.split(/\s+/).filter((w) => w.length > 0);

    for (let i = 0; i < words.length; i++) {
      const raw = words[i].toLowerCase().replace(/[^a-z0-9'-]/g, "");
      if (!raw || isStopword(raw)) continue;

      const timestampNs = i < decoded.words.length ? Math.round(decoded.words[i].start * 1e9) : 0;

      if (!index.has(raw)) index.set(raw, new Map());
      const talkMap = index.get(raw)!;

      if (!talkMap.has(t.talkRkey)) {
        talkMap.set(t.talkRkey, { title: t.talkTitle, count: 1, firstTimestampNs: timestampNs });
      } else {
        const ref = talkMap.get(t.talkRkey)!;
        ref.count++;
        if (timestampNs < ref.firstTimestampNs) ref.firstTimestampNs = timestampNs;
      }
    }
  }

  const entries: ConcordanceEntry[] = [];
  for (const [word, talkMap] of index) {
    const talks: ConcordanceTalkRef[] = [];
    let totalCount = 0;
    for (const [rkey, ref] of talkMap) {
      talks.push({ rkey, title: ref.title, count: ref.count, firstTimestampNs: ref.firstTimestampNs });
      totalCount += ref.count;
    }
    talks.sort((a, b) => b.count - a.count);
    entries.push({ word, talks, totalCount });
  }

  entries.sort((a, b) => a.word.localeCompare(b.word));
  return entries;
}
