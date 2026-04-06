"use client";

import { useMemo } from "react";
import { speakerColor, buildIndexMap } from "@/lib/track-colors";

interface DiarizationSegment {
  start: number;
  end: number;
  speaker: string;
}

interface DiarizationBandProps {
  segments: DiarizationSegment[];
  durationSeconds: number;
  offsetSeconds?: number;
  /** All unique speaker IDs (for stable color assignment). */
  allSpeakers?: string[];
}

export default function DiarizationBand({ segments, durationSeconds, offsetSeconds = 0, allSpeakers }: DiarizationBandProps) {
  const windowEnd = offsetSeconds + durationSeconds;

  // Build stable color index from ALL speakers
  const colorIndex = useMemo(() => {
    if (allSpeakers) return buildIndexMap(allSpeakers);
    // Fallback: extract unique speakers from segments in order of first appearance
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const s of segments) {
      if (!seen.has(s.speaker)) {
        seen.add(s.speaker);
        ordered.push(s.speaker);
      }
    }
    return buildIndexMap(ordered);
  }, [allSpeakers, segments]);

  const merged = useMemo(() => {
    const visible = segments.filter((s) => s.end > offsetSeconds && s.start < windowEnd);
    if (visible.length === 0) return [];

    const result: DiarizationSegment[] = [];
    let current = {
      ...visible[0],
      start: Math.max(visible[0].start, offsetSeconds),
      end: Math.min(visible[0].end, windowEnd),
    };

    for (let i = 1; i < visible.length; i++) {
      const seg = visible[i];
      const clipped = {
        ...seg,
        start: Math.max(seg.start, offsetSeconds),
        end: Math.min(seg.end, windowEnd),
      };
      if (clipped.speaker === current.speaker && clipped.start - current.end < 1) {
        current.end = clipped.end;
      } else {
        result.push(current);
        current = clipped;
      }
    }
    result.push(current);
    return result;
  }, [segments, offsetSeconds, windowEnd]);

  return (
    <div className="relative w-full h-3 bg-neutral-900 rounded overflow-hidden border border-neutral-800">
      {merged.map((seg, i) => {
        const left = ((seg.start - offsetSeconds) / durationSeconds) * 100;
        const width = ((seg.end - seg.start) / durationSeconds) * 100;
        if (width < 0.05) return null;
        return (
          <div
            key={i}
            className="absolute top-0 h-full"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              backgroundColor: speakerColor(seg.speaker, colorIndex),
            }}
            title={seg.speaker}
          />
        );
      })}
    </div>
  );
}
