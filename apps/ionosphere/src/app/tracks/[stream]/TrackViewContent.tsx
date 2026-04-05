"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { TimestampProvider, useTimestamp } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import StreamTimeline from "@/app/components/StreamTimeline";
import DiarizationBand from "@/app/components/DiarizationBand";

interface Talk {
  rkey: string;
  title: string;
  speakers: string[];
  startSeconds: number;
  endSeconds: number | null;
  confidence: string;
}

interface WordData {
  word: string;
  start: number;
  end: number;
  speaker?: string;
}

interface TrackData {
  slug: string;
  name: string;
  room: string;
  dayLabel: string;
  streamUri: string;
  durationSeconds: number;
  playbackUrl: string;
  talks: Talk[];
  diarization: Array<{ start: number; end: number; speaker: string }>;
  transcript?: { words: WordData[] };
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// --- Talk List Tab ---

function TalkList({ talks }: { talks: Talk[] }) {
  const { seekTo, currentTimeNs } = useTimestamp();
  const currentTimeSec = currentTimeNs / 1e9;
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [Math.floor(currentTimeSec / 60)]); // scroll when minute changes

  return (
    <div className="space-y-1">
      {talks.map((talk, i) => {
        const isActive =
          currentTimeSec >= talk.startSeconds &&
          (talk.endSeconds ? currentTimeSec < talk.endSeconds : i === talks.length - 1);

        return (
          <button
            key={`${talk.rkey}-${i}`}
            ref={isActive ? activeRef : undefined}
            onClick={() => seekTo(talk.startSeconds * 1e9)}
            className={`w-full text-left px-3 py-2 rounded transition-colors flex items-baseline gap-3 ${
              isActive
                ? "bg-neutral-800 text-neutral-100"
                : "hover:bg-neutral-800/50 text-neutral-400"
            }`}
          >
            <span className="text-xs font-mono shrink-0 w-16 text-neutral-500">
              {formatTime(talk.startSeconds)}
            </span>
            <span className="text-sm flex-1 truncate">{talk.title}</span>
            <span className="text-xs text-neutral-600 shrink-0 hidden sm:inline">
              {talk.speakers.join(", ")}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// --- Transcript Tab ---

function TrackTranscript({ words, talks }: { words: WordData[]; talks: Talk[] }) {
  const { seekTo, currentTimeNs } = useTimestamp();
  const currentTimeSec = currentTimeNs / 1e9;
  const containerRef = useRef<HTMLDivElement>(null);
  const activeWordRef = useRef<HTMLSpanElement>(null);

  // Auto-scroll to active word
  useEffect(() => {
    activeWordRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [Math.floor(currentTimeSec / 5)]); // every 5 seconds

  // Build talk boundary map for markers
  const talkStarts = useMemo(() => {
    const map = new Map<number, Talk>();
    for (const t of talks) {
      // Find the word index closest to the talk start
      const idx = words.findIndex((w) => w.start >= t.startSeconds);
      if (idx >= 0) map.set(idx, t);
    }
    return map;
  }, [words, talks]);

  // Render a window of words around current time for performance
  const windowSize = 500;
  const centerIdx = useMemo(() => {
    let best = 0;
    for (let i = 0; i < words.length; i++) {
      if (words[i].start <= currentTimeSec) best = i;
      else break;
    }
    return best;
  }, [Math.floor(currentTimeSec / 3), words]);

  const startIdx = Math.max(0, centerIdx - windowSize);
  const endIdx = Math.min(words.length, centerIdx + windowSize);
  const visibleWords = words.slice(startIdx, endIdx);

  return (
    <div ref={containerRef} className="text-sm leading-relaxed text-neutral-400">
      {startIdx > 0 && (
        <div className="text-center text-neutral-600 text-xs py-2">
          ... {startIdx} words above ...
        </div>
      )}
      {visibleWords.map((word, i) => {
        const globalIdx = startIdx + i;
        const isActive = currentTimeSec >= word.start && currentTimeSec < word.end + 0.5;
        const talkBoundary = talkStarts.get(globalIdx);

        return (
          <span key={globalIdx}>
            {talkBoundary && (
              <span className="block mt-4 mb-2 pt-3 border-t border-neutral-800">
                <span className="text-xs font-semibold text-neutral-300 uppercase tracking-wider">
                  {formatTime(talkBoundary.startSeconds)} — {talkBoundary.title}
                </span>
                {talkBoundary.speakers.length > 0 && (
                  <span className="text-xs text-neutral-600 ml-2">
                    {talkBoundary.speakers.join(", ")}
                  </span>
                )}
              </span>
            )}
            <span
              ref={isActive ? activeWordRef : undefined}
              onClick={() => seekTo(word.start * 1e9)}
              className={`cursor-pointer hover:text-neutral-200 ${
                isActive ? "text-white font-medium bg-neutral-800 rounded px-0.5" : ""
              }`}
            >
              {word.word}{" "}
            </span>
          </span>
        );
      })}
      {endIdx < words.length && (
        <div className="text-center text-neutral-600 text-xs py-2">
          ... {words.length - endIdx} words below ...
        </div>
      )}
    </div>
  );
}

// --- Timeline Zoom ---

function ZoomableTimeline({
  talks,
  diarization,
  durationSeconds,
}: {
  talks: Talk[];
  diarization: Array<{ start: number; end: number; speaker: string }>;
  durationSeconds: number;
}) {
  const { currentTimeNs } = useTimestamp();
  const [zoomLevel, setZoomLevel] = useState(1); // 1 = full stream, 2 = half, 4 = quarter, etc.
  const currentTimeSec = currentTimeNs / 1e9;

  // Zoom window: center on current time
  const windowDuration = durationSeconds / zoomLevel;
  const windowStart = Math.max(0, Math.min(
    currentTimeSec - windowDuration / 2,
    durationSeconds - windowDuration
  ));
  const windowEnd = windowStart + windowDuration;

  // Filter data to visible window
  const visibleTalks = talks.filter(
    (t) => t.startSeconds < windowEnd && (t.endSeconds ?? durationSeconds) > windowStart
  );
  const visibleDiarization = diarization.filter(
    (s) => s.start < windowEnd && s.end > windowStart
  );

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setZoomLevel(Math.max(1, zoomLevel / 2))}
            disabled={zoomLevel <= 1}
            className="px-2 py-0.5 text-xs rounded bg-neutral-800 text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
          >
            −
          </button>
          <span className="text-xs text-neutral-500 w-10 text-center">
            {zoomLevel === 1 ? "Full" : `${zoomLevel}x`}
          </span>
          <button
            onClick={() => setZoomLevel(Math.min(32, zoomLevel * 2))}
            disabled={zoomLevel >= 32}
            className="px-2 py-0.5 text-xs rounded bg-neutral-800 text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
          >
            +
          </button>
        </div>
        {zoomLevel > 1 && (
          <span className="text-xs text-neutral-600">
            {formatTime(windowStart)} — {formatTime(windowEnd)}
          </span>
        )}
      </div>

      <StreamTimeline
        talks={visibleTalks}
        durationSeconds={windowDuration}
        offsetSeconds={windowStart}
      />

      {diarization.length > 0 && (
        <div className="mt-1">
          <DiarizationBand
            segments={visibleDiarization}
            durationSeconds={windowDuration}
            offsetSeconds={windowStart}
          />
        </div>
      )}
    </div>
  );
}

// --- Main ---

function TrackViewInner({ track }: { track: TrackData }) {
  const [activeTab, setActiveTab] = useState<"talks" | "transcript">("talks");

  const hasTranscript = track.transcript && track.transcript.words.length > 0;

  return (
    <div className="h-full flex flex-col">
      {/* Fixed header: title + video + timeline */}
      <div className="shrink-0 px-4 pt-4">
        <div className="max-w-5xl mx-auto">
          <div className="mb-3">
            <h1 className="text-xl font-bold">{track.name}</h1>
            <p className="text-sm text-neutral-500">
              {track.room} · {track.talks.length} talks · {formatTime(track.durationSeconds)}
            </p>
          </div>

          <div className="mb-3">
            <VideoPlayer videoUri={track.streamUri} />
          </div>

          <div className="mb-3">
            <ZoomableTimeline
              talks={track.talks}
              diarization={track.diarization}
              durationSeconds={track.durationSeconds}
            />
          </div>

          {/* Tabs */}
          <div className="flex gap-4 border-b border-neutral-800">
            <button
              onClick={() => setActiveTab("talks")}
              className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "talks"
                  ? "border-neutral-300 text-neutral-100"
                  : "border-transparent text-neutral-500 hover:text-neutral-300"
              }`}
            >
              Talks
            </button>
            <button
              onClick={() => setActiveTab("transcript")}
              disabled={!hasTranscript}
              className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "transcript"
                  ? "border-neutral-300 text-neutral-100"
                  : "border-transparent text-neutral-500 hover:text-neutral-300"
              } ${!hasTranscript ? "opacity-30 cursor-not-allowed" : ""}`}
            >
              Transcript
            </button>
          </div>
        </div>
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <div className="max-w-5xl mx-auto">
          {activeTab === "talks" && <TalkList talks={track.talks} />}
          {activeTab === "transcript" && hasTranscript && (
            <TrackTranscript words={track.transcript!.words} talks={track.talks} />
          )}
        </div>
      </div>
    </div>
  );
}

export default function TrackViewContent({ track }: { track: TrackData }) {
  return (
    <TimestampProvider>
      <TrackViewInner track={track} />
    </TimestampProvider>
  );
}
