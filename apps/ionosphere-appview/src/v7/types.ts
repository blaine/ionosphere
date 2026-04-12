export interface DiarizationInput {
  speakers: string[];
  segments: { start: number; end: number; speaker: string }[];
  total_segments: number;
}

export interface TranscriptInput {
  stream: string;
  duration_seconds: number;
  words: { word: string; start: number; end: number; speaker?: string; confidence?: number }[];
}

export interface TalkSegment {
  startS: number;
  endS: number;
  speakers: { id: string; durationS: number }[];
  type: 'single-speaker' | 'panel' | 'unknown';
  dominantSpeaker?: string;
  precedingGapS: number;
  hallucinationZone: boolean;
}

export interface HallucinationZone {
  startS: number;
  endS: number;
  pattern: string;
}

export interface ScheduleTalk {
  rkey: string;
  title: string;
  starts_at: string;
  ends_at: string;
  speaker_names: string;
}

export interface BoundaryMatch {
  rkey: string;
  title: string;
  startTimestamp: number;
  endTimestamp: number | null;
  confidence: 'high' | 'medium' | 'low' | 'unverifiable';
  signals: string[];
  panel: boolean;
  hallucinationZones: HallucinationZone[];
}

export interface V7Output {
  stream: string;
  results: BoundaryMatch[];
  hallucinationZones: HallucinationZone[];
  unmatchedSegments: TalkSegment[];
  unmatchedSchedule: string[];
}
