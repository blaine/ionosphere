import type { DiarizationInput, HallucinationZone, TalkSegment } from './types.js';

// Thresholds for gap classification
const MERGE_GAP_S = 5; // merge same-speaker segments with gaps < 5s into speech blocks
const SESSION_BREAK_S = 60; // gaps > 60s = session break
const TALK_BOUNDARY_S = 30; // gaps 30-60s with speaker change = talk boundary
const DOMINANT_SPEAKER_THRESHOLD = 0.7; // 70% of duration = single-speaker

interface SpeechBlock {
  startS: number;
  endS: number;
  speaker: string;
}

/**
 * Step 1+2: Sort diarization segments and merge adjacent same-speaker segments
 * with gaps < MERGE_GAP_S into contiguous speech blocks.
 */
function buildSpeechBlocks(diarization: DiarizationInput): SpeechBlock[] {
  if (diarization.segments.length === 0) return [];

  const sorted = [...diarization.segments].sort((a, b) => a.start - b.start);
  const blocks: SpeechBlock[] = [];

  let current: SpeechBlock = {
    startS: sorted[0].start,
    endS: sorted[0].end,
    speaker: sorted[0].speaker,
  };

  for (let i = 1; i < sorted.length; i++) {
    const seg = sorted[i];
    const gap = seg.start - current.endS;

    if (seg.speaker === current.speaker && gap < MERGE_GAP_S) {
      // Extend the current block
      current.endS = Math.max(current.endS, seg.end);
    } else {
      blocks.push(current);
      current = { startS: seg.start, endS: seg.end, speaker: seg.speaker };
    }
  }
  blocks.push(current);

  return blocks;
}

/**
 * Determine the dominant speaker of a set of blocks.
 * Returns the speaker ID if one speaker covers > DOMINANT_SPEAKER_THRESHOLD of total,
 * otherwise null.
 */
function getDominantSpeaker(
  blocks: SpeechBlock[],
): { speaker: string; fraction: number } | null {
  const durations = new Map<string, number>();
  let total = 0;

  for (const block of blocks) {
    const d = block.endS - block.startS;
    durations.set(block.speaker, (durations.get(block.speaker) ?? 0) + d);
    total += d;
  }

  if (total === 0) return null;

  for (const [speaker, duration] of durations) {
    if (duration / total > DOMINANT_SPEAKER_THRESHOLD) {
      return { speaker, fraction: duration / total };
    }
  }

  return null;
}

/**
 * Build a TalkSegment from a group of speech blocks.
 */
function buildTalkSegment(
  blocks: SpeechBlock[],
  precedingGapS: number,
  hallucinationZones: HallucinationZone[],
): TalkSegment {
  const startS = blocks[0].startS;
  const endS = blocks[blocks.length - 1].endS;

  // Aggregate speaker durations
  const speakerDurations = new Map<string, number>();
  for (const block of blocks) {
    const d = block.endS - block.startS;
    speakerDurations.set(block.speaker, (speakerDurations.get(block.speaker) ?? 0) + d);
  }

  const speakers = [...speakerDurations.entries()].map(([id, durationS]) => ({
    id,
    durationS,
  }));

  // Classify segment type
  const dominant = getDominantSpeaker(blocks);
  let type: TalkSegment['type'];
  let dominantSpeaker: string | undefined;

  if (dominant) {
    type = 'single-speaker';
    dominantSpeaker = dominant.speaker;
  } else {
    type = 'panel';
  }

  // Check hallucination zone overlap
  const hallucinationZone = hallucinationZones.some(
    (zone) => zone.startS < endS && zone.endS > startS,
  );

  return {
    startS,
    endS,
    speakers,
    type,
    dominantSpeaker,
    precedingGapS,
    hallucinationZone,
  };
}

/**
 * Segment diarization data into talk-shaped blocks.
 *
 * Algorithm:
 * 1. Sort diarization segments by start time
 * 2. Merge adjacent same-speaker segments with < 5s gaps into speech blocks
 * 3. Find gaps between blocks and classify:
 *    - > 60s = session break (boundary)
 *    - 30-60s with speaker change = talk boundary
 *    - < 30s or no speaker change = within-talk pause (merge)
 * 4. Group blocks between talk boundaries into TalkSegments
 * 5. Classify each segment (single-speaker or panel)
 */
export function segmentDiarization(
  diarization: DiarizationInput,
  hallucinationZones: HallucinationZone[],
): TalkSegment[] {
  const blocks = buildSpeechBlocks(diarization);

  if (blocks.length === 0) return [];

  // Group blocks into talk segments by detecting boundaries between consecutive blocks
  const segments: TalkSegment[] = [];
  let currentGroup: SpeechBlock[] = [blocks[0]];
  let groupStartGap = 0; // preceding gap before the current group

  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1];
    const curr = blocks[i];
    const gap = curr.startS - prev.endS;

    const isBoundary =
      gap > SESSION_BREAK_S ||
      (gap >= TALK_BOUNDARY_S && curr.speaker !== prev.speaker);

    if (isBoundary) {
      // Finalize the current group as a TalkSegment
      segments.push(buildTalkSegment(currentGroup, groupStartGap, hallucinationZones));
      // Start a new group
      groupStartGap = gap;
      currentGroup = [curr];
    } else {
      // Within-talk pause — keep merging into current group
      currentGroup.push(curr);
    }
  }

  // Finalize the last group
  segments.push(buildTalkSegment(currentGroup, groupStartGap, hallucinationZones));

  return segments;
}
