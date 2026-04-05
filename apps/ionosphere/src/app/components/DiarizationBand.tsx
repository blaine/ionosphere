"use client";

import { useMemo } from "react";

interface DiarizationSegment {
  start: number;
  end: number;
  speaker: string;
}

interface DiarizationBandProps {
  segments: DiarizationSegment[];
  durationSeconds: number;
}

// Deterministic hue from speaker ID
function speakerHue(speaker: string): number {
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = ((hash << 5) - hash + speaker.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export default function DiarizationBand({ segments, durationSeconds }: DiarizationBandProps) {
  // Merge adjacent segments from the same speaker for performance
  const merged = useMemo(() => {
    if (segments.length === 0) return [];
    const result: DiarizationSegment[] = [];
    let current = { ...segments[0] };
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.speaker === current.speaker && seg.start - current.end < 1) {
        current.end = seg.end;
      } else {
        result.push(current);
        current = { ...seg };
      }
    }
    result.push(current);
    return result;
  }, [segments]);

  return (
    <div className="relative w-full h-3 bg-neutral-900 rounded overflow-hidden border border-neutral-800">
      {merged.map((seg, i) => {
        const left = (seg.start / durationSeconds) * 100;
        const width = ((seg.end - seg.start) / durationSeconds) * 100;
        if (width < 0.05) return null; // skip tiny segments
        const hue = speakerHue(seg.speaker);
        return (
          <div
            key={i}
            className="absolute top-0 h-full"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              backgroundColor: `hsl(${hue}, 50%, 40%)`,
            }}
            title={seg.speaker}
          />
        );
      })}
    </div>
  );
}
