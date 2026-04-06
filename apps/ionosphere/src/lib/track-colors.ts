/**
 * Stable, perceptually distinct colors for talks and speakers.
 *
 * Colors are assigned by key (rkey for talks, speaker ID for diarization)
 * so they remain stable across zoom/scroll/re-render.
 *
 * Uses OKLab-inspired hue spacing for perceptual distinctness:
 * - Golden angle (137.5°) spacing ensures maximum hue separation
 * - Fixed lightness/chroma for dark-theme readability
 */

// Golden angle in degrees — maximally separates sequential hues
const GOLDEN_ANGLE = 137.508;

/**
 * Deterministic hash of a string to a number.
 */
function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Assign a stable hue to a key based on its position in a known set.
 * Uses golden angle spacing for maximum perceptual separation.
 *
 * If no index map is provided, falls back to hashing.
 */
export function stableHue(key: string, indexMap?: Map<string, number>): number {
  const idx = indexMap?.get(key) ?? hashString(key);
  return (idx * GOLDEN_ANGLE) % 360;
}

/**
 * Build an index map from an ordered array of keys.
 * The index determines the hue via golden angle spacing.
 */
export function buildIndexMap(keys: string[]): Map<string, number> {
  const map = new Map<string, number>();
  keys.forEach((key, i) => map.set(key, i));
  return map;
}

/**
 * HSL color string for a talk segment (used as inline style).
 */
export function talkColor(key: string, indexMap?: Map<string, number>): string {
  const hue = stableHue(key, indexMap);
  return `hsl(${hue}, 45%, 30%)`;
}

/**
 * HSL color string for a speaker segment.
 */
export function speakerColor(speakerId: string, indexMap?: Map<string, number>): string {
  const hue = stableHue(speakerId, indexMap);
  return `hsl(${hue}, 50%, 40%)`;
}
