"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { prepare, layout } from "@chenglou/pretext";
import { TimestampProvider, useTimestamp } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import TranscriptView from "@/app/components/TranscriptView";

/** Seeks the video to a timestamp after HLS loads, then plays. */
function InitialSeek({ timestampNs }: { timestampNs: number }) {
  const { seekTo } = useTimestamp();
  useEffect(() => {
    if (timestampNs <= 0) return;

    // Poll for the video element (HLS creates it async)
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const video = document.querySelector<HTMLVideoElement>("video");
      if (video && video.readyState >= 1) {
        clearInterval(poll);
        seekTo(timestampNs);
        video.play().catch(() => {});
      }
      if (attempts > 50) clearInterval(poll); // give up after ~5s
    }, 100);

    return () => clearInterval(poll);
  }, [timestampNs, seekTo]);
  return null;
}

// --- Types ---

interface IndexEntry {
  word: string;
  talks: {
    rkey: string;
    title: string;
    count: number;
    firstTimestampNs: number;
  }[];
  totalCount: number;
}

interface LetterGroup {
  letter: string;
  entries: IndexEntry[];
}

interface MeasuredGroup {
  letter: string;
  entries: IndexEntry[];
  height: number; // measured by Pretext in px
}

// --- Pretext measurement ---

const FONT = "14px/1.6 ui-sans-serif, system-ui, sans-serif";
const LINE_HEIGHT = 22; // 14px * 1.6
const HEADING_HEIGHT = 36; // letter heading + margin
const GROUP_MARGIN = 16;

/**
 * Format an entry as plain text for Pretext measurement.
 * Mirrors the rendered layout: "word — Talk Title (3), Other Talk (1)"
 */
function entryToText(entry: IndexEntry): string {
  const talks = entry.talks
    .slice(0, 5)
    .map((t) => t.title + (t.count > 1 ? ` (${t.count})` : ""))
    .join(", ");
  const overflow = entry.talks.length > 5 ? ` +${entry.talks.length - 5} more` : "";
  return `${entry.word} — ${talks}${overflow}`;
}

/**
 * Measure each letter group's height using Pretext (client-side only).
 * Falls back to line-count estimation when Pretext isn't available (SSR).
 */
function measureGroups(
  groups: LetterGroup[],
  columnWidth: number,
  usePretext: boolean
): MeasuredGroup[] {
  return groups.map((g) => {
    let height = HEADING_HEIGHT;
    for (const entry of g.entries) {
      if (usePretext) {
        const wordPrepared = prepare(entry.word, FONT);
        const wordMeasured = layout(wordPrepared, columnWidth, LINE_HEIGHT);
        height += wordMeasured.height;
      } else {
        height += LINE_HEIGHT;
      }
      const talkLines = Math.min(entry.talks.length, 5);
      height += talkLines * LINE_HEIGHT;
      if (entry.talks.length > 5) height += LINE_HEIGHT;
      height += 4;
    }
    height += GROUP_MARGIN;
    return { ...g, height };
  });
}

/**
 * Distribute measured groups across N columns, minimizing max column height.
 * Greedy: always add next group to the shortest column.
 * Groups stay in alphabetical order within each column.
 */
function balanceColumns(groups: MeasuredGroup[], numColumns: number): MeasuredGroup[][] {
  const columns: MeasuredGroup[][] = Array.from({ length: numColumns }, () => []);
  const heights = new Array(numColumns).fill(0);

  for (const group of groups) {
    const minIdx = heights.indexOf(Math.min(...heights));
    columns[minIdx].push(group);
    heights[minIdx] += group.height;
  }

  return columns;
}

// --- Component ---

export default function IndexContent({ entries }: { entries: IndexEntry[] }) {
  const [selectedTalk, setSelectedTalk] = useState<{
    rkey: string;
    title: string;
    videoUri: string;
    offsetNs: number;
    document: any;
    seekToNs: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [columnWidth, setColumnWidth] = useState(280);
  const numColumns = 4;

  // Measure available width for columns
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const padding = 32; // p-4 = 16px each side
      const gaps = (numColumns - 1) * 24; // gap-6 = 24px
      const available = el.clientWidth - padding - gaps;
      setColumnWidth(Math.max(200, Math.floor(available / numColumns)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [numColumns]);

  // Group entries by first letter
  const groups = useMemo(() => {
    const map = new Map<string, IndexEntry[]>();
    for (const entry of entries) {
      const letter = entry.word[0]?.toUpperCase() || "#";
      if (!map.has(letter)) map.set(letter, []);
      map.get(letter)!.push(entry);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([letter, letterEntries]) => ({ letter, entries: letterEntries }));
  }, [entries]);

  // Track whether we're client-side (Pretext needs canvas)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Measure with Pretext (client-side) and balance across columns
  const columns = useMemo(() => {
    const measured = measureGroups(groups, columnWidth, mounted);
    return balanceColumns(measured, numColumns);
  }, [groups, columnWidth, numColumns, mounted]);

  const handleSelect = useCallback(
    async (rkey: string, _word: string, timestampNs: number) => {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
      const res = await fetch(`${API_BASE}/talks/${rkey}`);
      const { talk } = await res.json();
      const doc = talk.document ? JSON.parse(talk.document) : null;
      setSelectedTalk({
        rkey,
        title: talk.title,
        videoUri: talk.video_uri,
        offsetNs: talk.video_offset_ns || 0,
        document: doc?.facets?.length > 0 ? doc : null,
        seekToNs: timestampNs,
      });
    },
    []
  );

  return (
    <div className="h-full flex">
      {/* Left: Pretext-balanced multi-column word index */}
      <div ref={containerRef} className="flex-1 min-w-0 overflow-y-auto p-4">
        <h1 className="text-xl font-bold mb-4 tracking-tight">Word Index</h1>
        <p className="text-sm text-neutral-500 mb-6">
          {entries.length.toLocaleString()} words across{" "}
          {new Set(entries.flatMap((e) => e.talks.map((t) => t.rkey))).size} talks
        </p>
        <div className="flex gap-6 items-start">
          {columns.map((column, colIdx) => (
            <div key={colIdx} style={{ width: columnWidth }} className="min-w-0">
              {column.map((group) => (
                <div key={group.letter} className="mb-4">
                  <h2 className="text-base font-bold text-neutral-500 border-b border-neutral-800 pb-0.5 mb-1">
                    {group.letter}
                  </h2>
                  {group.entries.map((entry) => (
                    <div key={entry.word} className="text-[13px] leading-[1.6] mb-1">
                      <div className="font-medium text-neutral-200">
                        {entry.word}
                      </div>
                      {entry.talks.slice(0, 5).map((talk) => (
                        <div
                          key={talk.rkey}
                          className="truncate text-neutral-500 pl-3"
                          style={{ maxWidth: "100%" }}
                        >
                          <button
                            onClick={() =>
                              handleSelect(talk.rkey, entry.word, talk.firstTimestampNs)
                            }
                            className="hover:text-neutral-100 hover:underline underline-offset-2 transition-colors text-right"
                          >
                            {talk.title}
                          </button>
                          {talk.count > 1 && (
                            <span className="text-neutral-600">
                              {" "}({talk.count})
                            </span>
                          )}
                        </div>
                      ))}
                      {entry.talks.length > 5 && (
                        <div className="text-neutral-600 pl-3">
                          +{entry.talks.length - 5} more
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Right: player panel */}
      <div className="w-[400px] shrink-0 border-l border-neutral-800 flex flex-col">
        {selectedTalk ? (
          <TimestampProvider key={selectedTalk.rkey + selectedTalk.seekToNs}>
            <InitialSeek timestampNs={selectedTalk.seekToNs} />
            <div className="p-3 border-b border-neutral-800 text-sm font-medium truncate">
              {selectedTalk.title}
            </div>
            <div className="shrink-0 aspect-video bg-black">
              <VideoPlayer
                videoUri={selectedTalk.videoUri}
                offsetNs={selectedTalk.offsetNs}
              />
            </div>
            {selectedTalk.document && (
              <div className="flex-1 min-h-0">
                <TranscriptView document={selectedTalk.document} />
              </div>
            )}
          </TimestampProvider>
        ) : (
          <div className="flex-1 flex items-center justify-center text-neutral-600 text-sm p-6 text-center">
            Click a word to play the talk
          </div>
        )}
      </div>
    </div>
  );
}
