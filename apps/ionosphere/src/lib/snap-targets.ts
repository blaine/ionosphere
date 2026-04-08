// apps/ionosphere/src/lib/snap-targets.ts

export interface SnapTarget {
  type: "silence_gap" | "speaker_change" | "low_confidence" | "word_boundary";
  time: number;
  priority: number;
  gapStart?: number;
  gapEnd?: number;
  nearestWordBeforeGap?: number;
  nearestWordAfterGap?: number;
}

export interface SnapResult {
  target: SnapTarget;
  snappedTime: number;
}

interface Word {
  start: number;
  end: number;
  speaker: string;
}

interface DiarizationSegment {
  start: number;
  end: number;
  speaker: string;
}

const SILENCE_GAP_THRESHOLD = 2;
const SNAP_OFFSET = 0.5;

export function computeSnapTargets(
  words: Word[],
  diarization: DiarizationSegment[],
): SnapTarget[] {
  const targets: SnapTarget[] = [];

  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > SILENCE_GAP_THRESHOLD) {
      targets.push({
        type: "silence_gap",
        time: (words[i - 1].end + words[i].start) / 2,
        priority: 1,
        gapStart: words[i - 1].end,
        gapEnd: words[i].start,
        nearestWordBeforeGap: words[i - 1].end,
        nearestWordAfterGap: words[i].start,
      });
    }
  }

  for (let i = 1; i < diarization.length; i++) {
    if (diarization[i].speaker !== diarization[i - 1].speaker) {
      targets.push({
        type: "speaker_change",
        time: diarization[i].start,
        priority: 2,
      });
    }
  }

  targets.sort((a, b) => a.time - b.time);
  return targets;
}

export function findNearestSnap(
  targets: SnapTarget[],
  timeSeconds: number,
  edge: "start" | "end",
  radiusSeconds: number,
): SnapResult | null {
  let lo = 0;
  let hi = targets.length - 1;
  const candidates: SnapTarget[] = [];

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (targets[mid].time < timeSeconds - radiusSeconds) {
      lo = mid + 1;
    } else if (targets[mid].time > timeSeconds + radiusSeconds) {
      hi = mid - 1;
    } else {
      let left = mid;
      while (left > 0 && targets[left - 1].time >= timeSeconds - radiusSeconds) left--;
      let right = mid;
      while (right < targets.length - 1 && targets[right + 1].time <= timeSeconds + radiusSeconds) right++;
      for (let i = left; i <= right; i++) candidates.push(targets[i]);
      break;
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.priority - b.priority || Math.abs(a.time - timeSeconds) - Math.abs(b.time - timeSeconds));
  const best = candidates[0];

  return { target: best, snappedTime: resolveSnapPosition(best, edge) };
}

function resolveSnapPosition(target: SnapTarget, edge: "start" | "end"): number {
  if (target.type === "silence_gap" && target.gapStart != null && target.gapEnd != null) {
    if (edge === "start") {
      const ideal = target.gapEnd + SNAP_OFFSET;
      if (target.nearestWordAfterGap != null && ideal > target.nearestWordAfterGap) {
        return target.nearestWordAfterGap;
      }
      return ideal;
    } else {
      const ideal = target.gapStart - SNAP_OFFSET;
      if (target.nearestWordBeforeGap != null && ideal < target.nearestWordBeforeGap) {
        return target.nearestWordBeforeGap;
      }
      return ideal;
    }
  }

  return target.time;
}
