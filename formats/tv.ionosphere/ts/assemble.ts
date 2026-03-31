export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

export interface TranscriptInput {
  text: string;
  words: WordTimestamp[];
}

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, any>>;
}

export interface Document {
  text: string;
  facets: Facet[];
}

function secondsToNs(s: number): number {
  return Math.round(s * 1e9);
}

export function assembleDocument(transcript: TranscriptInput): Document {
  const encoder = new TextEncoder();
  const facets: Facet[] = [];

  let searchFrom = 0;
  for (const word of transcript.words) {
    const idx = transcript.text.indexOf(word.word, searchFrom);
    if (idx === -1) continue;

    const byteStart = encoder.encode(transcript.text.slice(0, idx)).length;
    const byteEnd = encoder.encode(transcript.text.slice(0, idx + word.word.length)).length;

    facets.push({
      index: { byteStart, byteEnd },
      features: [
        {
          $type: "tv.ionosphere.facet#timestamp",
          startTime: secondsToNs(word.start),
          endTime: secondsToNs(word.end),
        },
      ],
    });

    searchFrom = idx + word.word.length;
  }

  return { text: transcript.text, facets };
}
