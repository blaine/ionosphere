export const NAMESPACE = "tv.ionosphere";

// Shared types used across packages
export interface WordTimestamp {
  word: string;
  start: number; // seconds
  end: number; // seconds
  confidence: number;
}

export interface TranscriptResult {
  text: string;
  words: WordTimestamp[];
}
