"use client";

import { useRef, useCallback, useMemo } from "react";
import { useTimestamp } from "./TimestampProvider";
import { talkColor, buildIndexMap } from "@/lib/track-colors";
import { useTimelineEngine } from "@/lib/timeline-engine";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface StreamTimelineProps {
  allTalkRkeys: string[];
}

export default function StreamTimeline({ allTalkRkeys }: StreamTimelineProps) {
  const { currentTimeNs, seekTo } = useTimestamp();
  const barRef = useRef<HTMLDivElement>(null);
  const currentTimeSec = currentTimeNs / 1e9;

  const {
    effectiveTalks,
    editingEnabled,
    mode,
    selectedTalkRkey,
    selectedEdge,
    selectTalk,
    selectEdge,
    activeDrag,
    windowStart,
    windowEnd,
    startDrag,
    applyCorrection,
  } = useTimelineEngine();

  const windowDuration = windowEnd - windowStart;

  const colorIndex = useMemo(
    () => buildIndexMap(allTalkRkeys),
    [allTalkRkeys],
  );

  const visibleTalks = useMemo(
    () => effectiveTalks.filter(
      (t) => t.startSeconds < windowEnd && (t.endSeconds ?? windowEnd) > windowStart,
    ),
    [effectiveTalks, windowStart, windowEnd],
  );

  const handleBarClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!barRef.current) return;
      const rect = barRef.current.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      const seconds = windowStart + fraction * windowDuration;

      if (editingEnabled && mode === "split" && selectedTalkRkey) {
        const talk = effectiveTalks.find((t) => t.rkey === selectedTalkRkey);
        if (talk && seconds > talk.startSeconds && seconds < (talk.endSeconds ?? windowEnd)) {
          const newRkey = crypto.randomUUID().slice(0, 8);
          applyCorrection({ type: "split_talk", talkRkey: selectedTalkRkey, atSeconds: seconds, newRkey });
          return;
        }
      }

      if (editingEnabled && mode === "select") {
        const clicked = visibleTalks.find(
          (t) => seconds >= t.startSeconds && seconds < (t.endSeconds ?? windowEnd),
        );
        selectTalk(clicked?.rkey ?? null);
        if (clicked) {
          seekTo(clicked.startSeconds * 1e9);
          return;
        }
      }

      seekTo(seconds * 1e9);
    },
    [windowStart, windowDuration, seekTo, editingEnabled, mode, selectedTalkRkey, effectiveTalks, visibleTalks, selectTalk, applyCorrection, windowEnd],
  );

  const handleEdgeMouseDown = useCallback(
    (e: React.MouseEvent, talkRkey: string, edge: "start" | "end", seconds: number) => {
      if (!editingEnabled) return;
      e.stopPropagation();
      // Always select the edge on click
      selectTalk(talkRkey);
      selectEdge(edge);
      // In trim mode, also start a drag
      if (mode === "trim") {
        startDrag(talkRkey, edge, seconds);
      }
    },
    [editingEnabled, mode, startDrag, selectTalk, selectEdge],
  );

  const scrubberPct = Math.min(100, Math.max(0,
    ((currentTimeSec - windowStart) / windowDuration) * 100,
  ));

  return (
    <div
      ref={barRef}
      onClick={handleBarClick}
      data-timeline-bar
      className={`relative w-full h-10 bg-neutral-900 rounded cursor-pointer overflow-hidden border border-neutral-800 ${editingEnabled ? "select-none" : ""}`}
    >
      {visibleTalks.map((talk, i) => {
        const talkStart = Math.max(talk.startSeconds, windowStart);
        const talkEnd = Math.min(talk.endSeconds ?? windowEnd, windowEnd);
        if (talkStart >= windowEnd || talkEnd <= windowStart) return null;

        let displayStart = talkStart;
        let displayEnd = talkEnd;
        if (activeDrag?.talkRkey === talk.rkey) {
          if (activeDrag.edge === "start") displayStart = Math.max(activeDrag.currentSeconds, windowStart);
          if (activeDrag.edge === "end") displayEnd = Math.min(activeDrag.currentSeconds, windowEnd);
        }

        const left = ((displayStart - windowStart) / windowDuration) * 100;
        const width = ((displayEnd - displayStart) / windowDuration) * 100;
        const isSelected = selectedTalkRkey === talk.rkey;
        const isStartEdgeSelected = isSelected && selectedEdge === "start";
        const isEndEdgeSelected = isSelected && selectedEdge === "end";

        return (
          <div
            key={`${talk.rkey}-${i}`}
            className={`absolute top-0 h-full flex items-center overflow-hidden ${
              isSelected ? "ring-1 ring-white/30 z-[5]" : ""
            }`}
            style={{
              left: `${left}%`,
              width: `${width}%`,
              backgroundColor: talkColor(talk.rkey, colorIndex),
            }}
            title={`${talk.title} (${formatTime(talk.startSeconds)})`}
          >
            {/* Left (start) edge handle */}
            {editingEnabled && (
              <div
                className={`absolute left-0 top-0 w-1.5 h-full cursor-col-resize z-[6] transition-colors ${
                  isStartEdgeSelected
                    ? "bg-yellow-400/80"
                    : "hover:bg-white/40"
                }`}
                onMouseDown={(e) => handleEdgeMouseDown(e, talk.rkey, "start", talk.startSeconds)}
              />
            )}

            <span className="text-[10px] text-neutral-300 px-2 truncate">
              {talk.title}
            </span>

            {talk.verified && (
              <span className="absolute top-0.5 right-1 text-[8px] text-green-400">&#10003;</span>
            )}

            {/* Right (end) edge handle */}
            {editingEnabled && (
              <div
                className={`absolute right-0 top-0 w-1.5 h-full cursor-col-resize z-[6] transition-colors ${
                  isEndEdgeSelected
                    ? "bg-yellow-400/80"
                    : "hover:bg-white/40"
                }`}
                onMouseDown={(e) => handleEdgeMouseDown(e, talk.rkey, "end", talk.endSeconds ?? windowEnd)}
              />
            )}
          </div>
        );
      })}

      <div
        className="absolute top-0 h-full w-0.5 bg-white/80 z-10 pointer-events-none"
        style={{ left: `${scrubberPct}%` }}
      />

      <div className="absolute bottom-0 left-1 text-[9px] text-neutral-500">
        {formatTime(windowStart)}
      </div>
      <div className="absolute bottom-0 right-1 text-[9px] text-neutral-500">
        {formatTime(windowEnd)}
      </div>
    </div>
  );
}
