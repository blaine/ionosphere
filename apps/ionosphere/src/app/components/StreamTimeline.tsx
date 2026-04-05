"use client";

import { useTimestamp } from "./TimestampProvider";
import { useRef, useCallback } from "react";

interface Talk {
  rkey: string;
  title: string;
  startSeconds: number;
  endSeconds: number | null;
}

interface StreamTimelineProps {
  talks: Talk[];
  durationSeconds: number;
}

// Deterministic color for each talk index
const TALK_COLORS = [
  "bg-blue-800/60",
  "bg-emerald-800/60",
  "bg-purple-800/60",
  "bg-amber-800/60",
  "bg-rose-800/60",
  "bg-cyan-800/60",
  "bg-indigo-800/60",
  "bg-lime-800/60",
  "bg-pink-800/60",
  "bg-teal-800/60",
  "bg-orange-800/60",
  "bg-violet-800/60",
  "bg-sky-800/60",
  "bg-fuchsia-800/60",
  "bg-yellow-800/60",
  "bg-red-800/60",
];

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function StreamTimeline({ talks, durationSeconds }: StreamTimelineProps) {
  const { currentTimeNs, seekTo } = useTimestamp();
  const barRef = useRef<HTMLDivElement>(null);
  const currentTimeSec = currentTimeNs / 1e9;

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!barRef.current) return;
      const rect = barRef.current.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      const seconds = fraction * durationSeconds;
      seekTo(seconds * 1e9);
    },
    [durationSeconds, seekTo],
  );

  const scrubberPct = Math.min(100, (currentTimeSec / durationSeconds) * 100);

  return (
    <div
      ref={barRef}
      onClick={handleClick}
      className="relative w-full h-10 bg-neutral-900 rounded cursor-pointer overflow-hidden border border-neutral-800"
    >
      {/* Talk segments */}
      {talks.map((talk, i) => {
        const left = (talk.startSeconds / durationSeconds) * 100;
        const end = talk.endSeconds ?? durationSeconds;
        const width = ((end - talk.startSeconds) / durationSeconds) * 100;
        const color = TALK_COLORS[i % TALK_COLORS.length];

        return (
          <div
            key={`${talk.rkey}-${i}`}
            className={`absolute top-0 h-full ${color} border-r border-neutral-700/50 flex items-center overflow-hidden`}
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`${talk.title} (${formatTime(talk.startSeconds)})`}
          >
            <span className="text-[10px] text-neutral-300 px-1 truncate">
              {talk.title}
            </span>
          </div>
        );
      })}

      {/* Scrubber */}
      <div
        className="absolute top-0 h-full w-0.5 bg-white/80 z-10 pointer-events-none"
        style={{ left: `${scrubberPct}%` }}
      />

      {/* Time labels */}
      <div className="absolute bottom-0 left-1 text-[9px] text-neutral-500">0:00</div>
      <div className="absolute bottom-0 right-1 text-[9px] text-neutral-500">
        {formatTime(durationSeconds)}
      </div>
    </div>
  );
}
