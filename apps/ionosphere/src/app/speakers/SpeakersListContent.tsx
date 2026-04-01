"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { TimestampProvider, useTimestamp } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import TranscriptView from "@/app/components/TranscriptView";

/** Aggressively seeks and plays the video once HLS is ready. */
function InitialSeek({ timestampNs }: { timestampNs: number }) {
  const { seekTo } = useTimestamp();
  useEffect(() => {
    let cancelled = false;

    function trySeekAndPlay() {
      if (cancelled) return;
      const video = document.querySelector<HTMLVideoElement>("video");
      if (!video) {
        setTimeout(trySeekAndPlay, 100);
        return;
      }

      function doSeekAndPlay() {
        if (cancelled) return;
        if (timestampNs > 0) seekTo(timestampNs);
        video!.play().catch(() => {});
      }

      if (video.readyState >= 2) {
        doSeekAndPlay();
        return;
      }

      video.addEventListener("loadeddata", doSeekAndPlay, { once: true });
      video.addEventListener("canplay", doSeekAndPlay, { once: true });
      video.play().catch(() => {});
    }

    trySeekAndPlay();
    return () => { cancelled = true; };
  }, [timestampNs, seekTo]);
  return null;
}

interface Speaker {
  rkey: string;
  name: string;
  handle?: string;
}

interface LetterGroup {
  letter: string;
  speakers: Speaker[];
}

interface MeasuredGroup extends LetterGroup {
  height: number;
}

const LINE_HEIGHT = 22;
const HEADING_HEIGHT = 36;
const GROUP_MARGIN = 16;

function groupByLetter(speakers: Speaker[]): LetterGroup[] {
  const map = new Map<string, Speaker[]>();
  for (const s of speakers) {
    const letter = s.name[0]?.toUpperCase() || "#";
    if (!map.has(letter)) map.set(letter, []);
    map.get(letter)!.push(s);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([letter, items]) => ({ letter, speakers: items }));
}

function measureGroups(groups: LetterGroup[]): MeasuredGroup[] {
  return groups.map((g) => {
    // heading + one line per speaker (name + handle) + margin
    const height = HEADING_HEIGHT + g.speakers.length * LINE_HEIGHT + GROUP_MARGIN;
    return { ...g, height };
  });
}

function balanceColumns(groups: MeasuredGroup[], numColumns: number): MeasuredGroup[][] {
  const totalHeight = groups.reduce((sum, g) => sum + g.height, 0);
  const targetHeight = totalHeight / numColumns;

  const columns: MeasuredGroup[][] = [];
  let currentColumn: MeasuredGroup[] = [];
  let currentHeight = 0;

  for (const group of groups) {
    currentColumn.push(group);
    currentHeight += group.height;

    if (currentHeight >= targetHeight && columns.length < numColumns - 1) {
      columns.push(currentColumn);
      currentColumn = [];
      currentHeight = 0;
    }
  }
  columns.push(currentColumn);

  return columns;
}

export default function SpeakersListContent({ speakers }: { speakers: Speaker[] }) {
  const [selectedTalk, setSelectedTalk] = useState<{
    rkey: string;
    title: string;
    videoUri: string;
    offsetNs: number;
    document: any;
    seekToNs: number;
  } | null>(null);

  const [filter, setFilter] = useState("");
  const numColumns = 4;
  const containerRef = useRef<HTMLDivElement>(null);
  const [columnWidth, setColumnWidth] = useState(280);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const padding = 32;
      const gaps = (numColumns - 1) * 24;
      const available = el.clientWidth - padding - gaps;
      setColumnWidth(Math.max(200, Math.floor(available / numColumns)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [numColumns]);

  const sortedSpeakers = useMemo(
    () => [...speakers].sort((a, b) => a.name.localeCompare(b.name)),
    [speakers]
  );

  const filteredSpeakers = useMemo(() => {
    if (!filter) return sortedSpeakers;
    const q = filter.toLowerCase();
    return sortedSpeakers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.handle || "").toLowerCase().includes(q)
    );
  }, [sortedSpeakers, filter]);

  const allLetters = useMemo(() => {
    const set = new Set<string>();
    for (const s of sortedSpeakers) {
      const l = s.name[0]?.toUpperCase();
      if (l && /[A-Z]/.test(l)) set.add(l);
    }
    return [...set].sort();
  }, [sortedSpeakers]);

  const groups = useMemo(() => groupByLetter(filteredSpeakers), [filteredSpeakers]);

  const columns = useMemo(() => {
    const measured = measureGroups(groups);
    return balanceColumns(measured, numColumns);
  }, [groups, numColumns]);

  const handleSelect = useCallback(async (speakerRkey: string) => {
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
      // Fetch the speaker's talks
      const speakerRes = await fetch(`${API_BASE}/speakers/${speakerRkey}`);
      if (!speakerRes.ok) return;
      const { talks } = await speakerRes.json();
      if (!talks || talks.length === 0) return;

      // Load the first talk with full document
      const firstTalk = talks[0];
      const talkRes = await fetch(`${API_BASE}/talks/${firstTalk.rkey}`);
      if (!talkRes.ok) return;
      const { talk } = await talkRes.json();
      const doc = talk.document ? JSON.parse(talk.document) : null;

      setSelectedTalk({
        rkey: talk.rkey,
        title: talk.title,
        videoUri: talk.video_uri,
        offsetNs: talk.video_offset_ns || 0,
        document: doc?.facets?.length > 0 ? doc : null,
        seekToNs: 0,
      });
    } catch (err) {
      console.error("[Speakers] handleSelect error:", err);
    }
  }, []);

  const scrollToLetter = useCallback((letter: string) => {
    const el = document.getElementById(`speaker-letter-${letter}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="h-full flex">
      {/* Letter nav */}
      <nav className="shrink-0 w-6 flex flex-col items-center justify-center gap-1.5 border-r border-neutral-800 py-2">
        {allLetters.map((letter) => (
          <button
            key={letter}
            onClick={() => scrollToLetter(letter)}
            className="text-[10px] leading-none text-neutral-500 hover:text-neutral-100 transition-colors"
          >
            {letter}
          </button>
        ))}
      </nav>

      {/* Main: search + multi-column speaker list */}
      <div ref={containerRef} className="flex-1 min-w-0 overflow-y-auto p-4">
        {/* Sticky search bar */}
        <div className="flex items-center gap-3 mb-4 sticky top-0 z-10 bg-neutral-950 py-2 -mt-2">
          <h1 className="text-xl font-bold tracking-tight shrink-0">Speakers</h1>
          <div className="flex-1 max-w-sm">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name or handle..."
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500"
            />
          </div>
          <span className="text-sm text-neutral-500 shrink-0">
            {filteredSpeakers.length} speakers
          </span>
        </div>

        <div className="flex gap-6 items-start">
          {columns.map((column, colIdx) => (
            <div key={colIdx} style={{ width: columnWidth }} className="min-w-0">
              {column.map((group) => (
                <div key={group.letter} className="mb-4">
                  <h2
                    id={`speaker-letter-${group.letter}`}
                    className="text-base font-bold text-neutral-500 border-b border-neutral-800 pb-0.5 mb-1"
                  >
                    {group.letter}
                  </h2>
                  {group.speakers.map((speaker) => (
                    <button
                      key={speaker.rkey}
                      onClick={() => handleSelect(speaker.rkey)}
                      className="block w-full text-left text-[13px] leading-[1.6] mb-0.5 hover:text-neutral-100 transition-colors"
                    >
                      <span className="font-medium text-neutral-200">{speaker.name}</span>
                      {speaker.handle && (
                        <span className="text-neutral-600 ml-1.5">@{speaker.handle}</span>
                      )}
                    </button>
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
            Click a speaker to play their talk
          </div>
        )}
      </div>
    </div>
  );
}
