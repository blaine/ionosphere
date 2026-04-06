"use client";

import { useTimestamp } from "./TimestampProvider";
import { useRef, useCallback, useMemo } from "react";
import { talkColor, buildIndexMap } from "@/lib/track-colors";

interface Talk {
  rkey: string;
  title: string;
  startSeconds: number;
  endSeconds: number | null;
}

interface StreamTimelineProps {
  talks: Talk[];
  durationSeconds: number;
  offsetSeconds?: number;
  /** All talks in the stream (for stable color assignment). Pass the full list, not just visible. */
  allTalks?: Talk[];
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function StreamTimeline({ talks, durationSeconds, offsetSeconds = 0, allTalks }: StreamTimelineProps) {
  const { currentTimeNs, seekTo } = useTimestamp();
  const barRef = useRef<HTMLDivElement>(null);
  const currentTimeSec = currentTimeNs / 1e9;

  // Build stable color index from ALL talks (not just visible)
  const colorIndex = useMemo(
    () => buildIndexMap((allTalks ?? talks).map((t) => t.rkey)),
    [allTalks, talks],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!barRef.current) return;
      const rect = barRef.current.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      const seconds = offsetSeconds + fraction * durationSeconds;
      seekTo(seconds * 1e9);
    },
    [durationSeconds, offsetSeconds, seekTo],
  );

  const scrubberPct = Math.min(100, Math.max(0,
    ((currentTimeSec - offsetSeconds) / durationSeconds) * 100,
  ));

  const windowEnd = offsetSeconds + durationSeconds;

  return (
    <div
      ref={barRef}
      onClick={handleClick}
      className="relative w-full h-10 bg-neutral-900 rounded cursor-pointer overflow-hidden border border-neutral-800"
    >
      {talks.map((talk, i) => {
        const talkStart = Math.max(talk.startSeconds, offsetSeconds);
        const talkEnd = Math.min(talk.endSeconds ?? windowEnd, windowEnd);
        if (talkStart >= windowEnd || talkEnd <= offsetSeconds) return null;

        const left = ((talkStart - offsetSeconds) / durationSeconds) * 100;
        const width = ((talkEnd - talkStart) / durationSeconds) * 100;

        return (
          <div
            key={`${talk.rkey}-${i}`}
            className="absolute top-0 h-full border-r border-neutral-700/50 flex items-center overflow-hidden"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              backgroundColor: talkColor(talk.rkey, colorIndex),
            }}
            title={`${talk.title} (${formatTime(talk.startSeconds)})`}
          >
            <span className="text-[10px] text-neutral-300 px-1 truncate">
              {talk.title}
            </span>
          </div>
        );
      })}

      <div
        className="absolute top-0 h-full w-0.5 bg-white/80 z-10 pointer-events-none"
        style={{ left: `${scrubberPct}%` }}
      />

      <div className="absolute bottom-0 left-1 text-[9px] text-neutral-500">
        {formatTime(offsetSeconds)}
      </div>
      <div className="absolute bottom-0 right-1 text-[9px] text-neutral-500">
        {formatTime(windowEnd)}
      </div>
    </div>
  );
}
