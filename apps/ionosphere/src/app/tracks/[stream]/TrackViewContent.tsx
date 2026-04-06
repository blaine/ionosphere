"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { TimestampProvider, useTimestamp } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import TranscriptView from "@/app/components/TranscriptView";
import StreamTimeline from "@/app/components/StreamTimeline";
import DiarizationBand from "@/app/components/DiarizationBand";
import { TimelineEngineProvider, useTimelineEngine } from "@/lib/timeline-engine";
import TimelineToolbar from "@/app/components/TimelineToolbar";
import InteractionOverlay from "@/app/components/InteractionOverlay";
import { useEditorKeyboard } from "@/app/components/useEditorKeyboard";
import { getCorrections, saveCorrections } from "@/lib/api";
import type { BaseTalk, CorrectionEntry } from "@/lib/corrections";

interface Talk {
  rkey: string;
  title: string;
  speakers: string[];
  startSeconds: number;
  endSeconds: number | null;
  confidence: string;
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
  transcript?: { text: string; facets: any[] };
  words?: Array<{ start: number; end: number; speaker: string }>;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// --- Talk List (reads from engine) ---

function TalkList() {
  const { seekTo, currentTimeNs } = useTimestamp();
  const { effectiveTalks } = useTimelineEngine();
  const currentTimeSec = currentTimeNs / 1e9;
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [Math.floor(currentTimeSec / 60)]);

  return (
    <div className="space-y-1 p-4">
      {effectiveTalks.map((talk, i) => {
        const isActive =
          currentTimeSec >= talk.startSeconds &&
          (talk.endSeconds ? currentTimeSec < talk.endSeconds : i === effectiveTalks.length - 1);

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
            {talk.verified && (
              <span className="text-xs text-green-400 shrink-0">&#10003;</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// --- SaveHandler: bridges engine context to the saveRef ---

function SaveHandler({ saveRef, streamSlug }: { saveRef: React.MutableRefObject<(() => void) | null>; streamSlug: string }) {
  const { getCorrectionsToSave, markSaved, isDirty } = useTimelineEngine();

  const handleSave = useCallback(async () => {
    if (!isDirty) return;
    const corrections = getCorrectionsToSave();
    try {
      await saveCorrections(streamSlug, corrections);
      markSaved();
    } catch (err) {
      console.error("Failed to save corrections:", err);
    }
  }, [isDirty, getCorrectionsToSave, markSaved, streamSlug]);

  useEffect(() => {
    saveRef.current = handleSave;
  }, [handleSave, saveRef]);

  useEditorKeyboard(handleSave);

  return null;
}

// --- Main Inner (inside engine provider) ---

function TrackViewInner({ track }: { track: TrackData }) {
  const [activeTab, setActiveTab] = useState<"talks" | "transcript">("talks");
  const hasTranscript = !!(track.transcript?.facets?.length);

  // Zoom state
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panCenter, setPanCenter] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  const { currentTimeNs } = useTimestamp();
  const currentTimeSec = currentTimeNs / 1e9;

  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<(() => void) | null>(null);

  // Measure container width with ResizeObserver
  useEffect(() => {
    const el = timelineContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Compute viewport
  const center = panCenter ?? currentTimeSec;
  const windowDuration = track.durationSeconds / zoomLevel;
  const windowStart = Math.max(0, Math.min(
    center - windowDuration / 2,
    track.durationSeconds - windowDuration,
  ));
  const windowEnd = windowStart + windowDuration;

  // Gesture handling: wheel to zoom, shift+wheel or horizontal scroll to pan
  useEffect(() => {
    const el = timelineContainerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();

      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        const zoomDelta = e.deltaY > 0 ? 0.8 : 1.25;
        setZoomLevel((prev) => Math.max(1, Math.min(64, prev * zoomDelta)));
      }

      if (Math.abs(e.deltaX) > 0 || e.shiftKey) {
        const panDelta = (e.deltaX || e.deltaY) * (windowDuration / 1000);
        setPanCenter((prev) => {
          const c = prev ?? currentTimeSec;
          return Math.max(windowDuration / 2, Math.min(track.durationSeconds - windowDuration / 2, c + panDelta));
        });
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [windowDuration, track.durationSeconds, currentTimeSec]);

  // Reset pan when zoom returns to 1x
  useEffect(() => {
    if (zoomLevel <= 1) setPanCenter(null);
  }, [zoomLevel]);

  // Stable speaker list for diarization colors
  const allSpeakers = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const s of track.diarization) {
      if (!seen.has(s.speaker)) {
        seen.add(s.speaker);
        ordered.push(s.speaker);
      }
    }
    return ordered;
  }, [track.diarization]);

  const visibleDiarization = track.diarization.filter(
    (s) => s.start < windowEnd && s.end > windowStart,
  );

  // Load corrections on mount
  const [initialCorrections, setInitialCorrections] = useState<CorrectionEntry[] | undefined>(undefined);
  const [correctionsLoaded, setCorrectionsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCorrections(track.slug)
      .then((data) => {
        if (!cancelled) {
          setInitialCorrections(data.corrections as CorrectionEntry[]);
          setCorrectionsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setCorrectionsLoaded(true);
      });
    return () => { cancelled = true; };
  }, [track.slug]);

  // Convert talks to BaseTalk for the engine
  const baseTalks: BaseTalk[] = useMemo(
    () => track.talks.map((t) => ({
      rkey: t.rkey,
      title: t.title,
      speakers: t.speakers,
      startSeconds: t.startSeconds,
      endSeconds: t.endSeconds,
      confidence: t.confidence,
    })),
    [track.talks],
  );

  if (!correctionsLoaded) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-500 text-sm">
        Loading...
      </div>
    );
  }

  return (
    <TimelineEngineProvider
      streamSlug={track.slug}
      baseTalks={baseTalks}
      words={track.words ?? []}
      diarization={track.diarization}
      initialCorrections={initialCorrections}
      windowStart={windowStart}
      windowEnd={windowEnd}
      containerWidth={containerWidth}
    >
      <SaveHandler saveRef={saveRef} streamSlug={track.slug} />

      <div className="h-full flex flex-col">
        {/* Fixed header */}
        <div className="shrink-0 px-4 pt-3 border-b border-neutral-800">
          <div className="max-w-5xl mx-auto">
            <div className="mb-2 flex items-start justify-between">
              <div>
                <h1 className="text-lg font-bold">{track.name}</h1>
                <p className="text-xs text-neutral-500">
                  {track.room} · {track.talks.length} talks · {formatTime(track.durationSeconds)}
                </p>
              </div>
              <TimelineToolbar onSave={() => saveRef.current?.()} />
            </div>

            {/* Video */}
            <div className="mb-2 max-h-[33vh] overflow-hidden rounded-lg bg-black">
              <VideoPlayer videoUri={track.streamUri} />
            </div>

            {/* Timeline area */}
            <div className="mb-2" ref={timelineContainerRef}>
              {/* Zoom controls */}
              <div className="flex items-center gap-2 mb-1">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => { setZoomLevel((z) => Math.max(1, z / 2)); }}
                    disabled={zoomLevel <= 1}
                    className="px-2 py-0.5 text-xs rounded bg-neutral-800 text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
                  >
                    −
                  </button>
                  <span className="text-xs text-neutral-500 w-10 text-center">
                    {zoomLevel <= 1 ? "Full" : `${zoomLevel.toFixed(zoomLevel < 2 ? 1 : 0)}x`}
                  </span>
                  <button
                    onClick={() => { setZoomLevel((z) => Math.min(64, z * 2)); }}
                    disabled={zoomLevel >= 64}
                    className="px-2 py-0.5 text-xs rounded bg-neutral-800 text-neutral-400 hover:text-neutral-200 disabled:opacity-30"
                  >
                    +
                  </button>
                </div>
                {zoomLevel > 1 && (
                  <>
                    <span className="text-xs text-neutral-600">
                      {formatTime(windowStart)} — {formatTime(windowEnd)}
                    </span>
                    <button
                      onClick={() => { setZoomLevel(1); setPanCenter(null); }}
                      className="text-xs text-neutral-600 hover:text-neutral-300 ml-auto"
                    >
                      Reset
                    </button>
                  </>
                )}
              </div>

              {/* Timeline bar with interaction overlay */}
              <div className="relative" data-timeline-bar>
                <StreamTimeline allTalkRkeys={track.talks.map((t) => t.rkey)} />
                <InteractionOverlay />
              </div>

              {/* Diarization band */}
              {track.diarization.length > 0 && (
                <div className="mt-1">
                  <DiarizationBand
                    segments={visibleDiarization}
                    allSpeakers={allSpeakers}
                    durationSeconds={windowDuration}
                    offsetSeconds={windowStart}
                  />
                </div>
              )}
            </div>

            {/* Tabs */}
            <div className="flex gap-4">
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

        {/* Scrollable content */}
        <div className="flex-1 min-h-0">
          <div className="max-w-5xl mx-auto h-full">
            {activeTab === "talks" && (
              <div className="h-full overflow-y-auto">
                <TalkList />
              </div>
            )}
            {activeTab === "transcript" && hasTranscript && (
              <TranscriptView document={track.transcript!} />
            )}
          </div>
        </div>
      </div>
    </TimelineEngineProvider>
  );
}

export default function TrackViewContent({ track }: { track: TrackData }) {
  return (
    <TimestampProvider>
      <TrackViewInner track={track} />
    </TimestampProvider>
  );
}
