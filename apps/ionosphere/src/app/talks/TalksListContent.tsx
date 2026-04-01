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

interface Talk {
  rkey: string;
  title: string;
  speaker_names: string;
  room: string;
  talk_type: string;
  starts_at: string;
  video_uri?: string;
  video_offset_ns?: number;
  document?: string;
}

interface DayGroup {
  day: string;
  label: string;
  talks: Talk[];
}

interface MeasuredDayGroup extends DayGroup {
  height: number;
}

const LINE_HEIGHT = 22;
const HEADING_HEIGHT = 36;
const GROUP_MARGIN = 16;
const TALK_ENTRY_HEIGHT = LINE_HEIGHT * 2; // title + metadata

function groupByDay(talks: Talk[]): DayGroup[] {
  const byDay = new Map<string, Talk[]>();
  for (const talk of talks) {
    const day = talk.starts_at?.slice(0, 10) || "unknown";
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(talk);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, dayTalks]) => ({
      day,
      label: day === "unknown"
        ? "Unknown Date"
        : new Date(day + "T00:00:00Z").toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          }),
      talks: dayTalks.sort((a, b) => (a.starts_at || "").localeCompare(b.starts_at || "")),
    }));
}

function measureDayGroups(groups: DayGroup[]): MeasuredDayGroup[] {
  return groups.map((g) => {
    const height = HEADING_HEIGHT + g.talks.length * TALK_ENTRY_HEIGHT + GROUP_MARGIN;
    return { ...g, height };
  });
}

function balanceColumns(groups: MeasuredDayGroup[], numColumns: number): MeasuredDayGroup[][] {
  const totalHeight = groups.reduce((sum, g) => sum + g.height, 0);
  const targetHeight = totalHeight / numColumns;

  const columns: MeasuredDayGroup[][] = [];
  let currentColumn: MeasuredDayGroup[] = [];
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

function formatTime(startsAt: string): string {
  if (!startsAt) return "";
  try {
    return new Date(startsAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function TalksListContent({ talks }: { talks: Talk[] }) {
  const [selectedTalk, setSelectedTalk] = useState<{
    rkey: string;
    title: string;
    videoUri: string;
    offsetNs: number;
    document: any;
    seekToNs: number;
  } | null>(null);

  const [filter, setFilter] = useState("");
  const numColumns = 3;
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

  const filteredTalks = useMemo(() => {
    if (!filter) return talks;
    const q = filter.toLowerCase();
    return talks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.speaker_names || "").toLowerCase().includes(q)
    );
  }, [talks, filter]);

  const dayGroups = useMemo(() => groupByDay(filteredTalks), [filteredTalks]);

  // Day labels for nav sidebar
  const dayNav = useMemo(() => {
    return dayGroups.map((g) => ({
      day: g.day,
      shortLabel: g.day === "unknown"
        ? "?"
        : new Date(g.day + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short" }),
    }));
  }, [dayGroups]);

  const columns = useMemo(() => {
    const measured = measureDayGroups(dayGroups);
    return balanceColumns(measured, numColumns);
  }, [dayGroups, numColumns]);

  const handleSelect = useCallback(async (rkey: string) => {
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
      const res = await fetch(`${API_BASE}/talks/${rkey}`);
      if (!res.ok) return;
      const { talk } = await res.json();
      const doc = talk.document ? JSON.parse(talk.document) : null;
      setSelectedTalk({
        rkey,
        title: talk.title,
        videoUri: talk.video_uri,
        offsetNs: talk.video_offset_ns || 0,
        document: doc?.facets?.length > 0 ? doc : null,
        seekToNs: 0,
      });
    } catch (err) {
      console.error("[Talks] handleSelect error:", err);
    }
  }, []);

  const scrollToDay = useCallback((day: string) => {
    const el = document.getElementById(`day-${day}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="h-full flex">
      {/* Day nav — vertical strip on the left edge */}
      <nav className="shrink-0 w-10 flex flex-col items-center justify-center gap-1.5 border-r border-neutral-800 py-2">
        {dayNav.map(({ day, shortLabel }) => (
          <button
            key={day}
            onClick={() => scrollToDay(day)}
            className="text-[10px] leading-none text-neutral-500 hover:text-neutral-100 transition-colors"
          >
            {shortLabel}
          </button>
        ))}
      </nav>

      {/* Main: search + multi-column talk list */}
      <div ref={containerRef} className="flex-1 min-w-0 overflow-y-auto p-4">
        {/* Sticky search bar */}
        <div className="flex items-center gap-3 mb-4 sticky top-0 z-10 bg-neutral-950 py-2 -mt-2">
          <h1 className="text-xl font-bold tracking-tight shrink-0">Talks</h1>
          <div className="flex-1 max-w-sm">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by title or speaker..."
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500"
            />
          </div>
          <span className="text-sm text-neutral-500 shrink-0">
            {filteredTalks.length} talks
          </span>
        </div>

        {/* Multi-column layout */}
        <div className="flex gap-6 items-start">
          {columns.map((column, colIdx) => (
            <div key={colIdx} style={{ width: columnWidth }} className="min-w-0">
              {column.map((group) => (
                <div key={group.day} className="mb-4">
                  <h2
                    id={`day-${group.day}`}
                    className="text-base font-bold text-neutral-500 border-b border-neutral-800 pb-0.5 mb-1"
                  >
                    {group.label}
                  </h2>
                  {group.talks.map((talk) => (
                    <button
                      key={talk.rkey}
                      onClick={() => handleSelect(talk.rkey)}
                      className={`block w-full text-left text-[13px] leading-[1.6] mb-1.5 hover:text-neutral-100 transition-colors ${
                        selectedTalk?.rkey === talk.rkey
                          ? "bg-neutral-900 rounded px-1 -mx-1"
                          : ""
                      }`}
                    >
                      <div className="font-medium text-neutral-200">
                        {talk.title}
                      </div>
                      <div className="text-xs text-neutral-500 truncate">
                        {talk.speaker_names}
                        {talk.room && <> &middot; {talk.room}</>}
                        {talk.starts_at && <> &middot; {formatTime(talk.starts_at)}</>}
                      </div>
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
            Click a talk to play it
          </div>
        )}
      </div>
    </div>
  );
}
