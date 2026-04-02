"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { TimestampProvider, useTimestamp } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import TranscriptView from "@/app/components/TranscriptView";
import { fetchComments, type CommentData } from "@/lib/comments";
import ReactionBar from "@/app/components/ReactionBar";

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
  reaction_summary?: [string, number][]; // [[emoji, count], ...]
  comment_count?: number;
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

// Conference days — March 30 talks fold into March 29 (timezone edge case)
const DAY_LABELS: Record<string, string> = {
  "2026-03-26": "Wednesday, March 26",
  "2026-03-27": "Thursday, March 27",
  "2026-03-28": "Friday, March 28",
  "2026-03-29": "Saturday, March 29",
};

function groupByDay(talks: Talk[]): DayGroup[] {
  const byDay = new Map<string, Talk[]>();
  for (const talk of talks) {
    let day = talk.starts_at?.slice(0, 10) || "";
    if (!day || !DAY_LABELS[day]) {
      // Fold March 30 into March 29, skip truly unknown
      if (day === "2026-03-30") day = "2026-03-29";
      else continue;
    }
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(talk);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, dayTalks]) => ({
      day,
      label: DAY_LABELS[day] || day,
      talks: dayTalks.sort((a, b) => (a.starts_at || "").localeCompare(b.starts_at || "")),
    }));
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
    talkUri: string;
  } | null>(null);

  const [comments, setComments] = useState<CommentData[]>([]);
  const [filter, setFilter] = useState("");
  const [widePlayer, setWidePlayer] = useState(false);
  const [showMobilePlayer, setShowMobilePlayer] = useState(false);

  const filteredTalks = useMemo(() => {
    if (!filter) return talks;
    const q = filter.toLowerCase();
    return talks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.speaker_names || "").toLowerCase().includes(q)
    );
  }, [talks, filter]);

  // One column per day — each day IS a column
  const dayGroups = useMemo(() => groupByDay(filteredTalks), [filteredTalks]);

  // Day labels for nav sidebar
  const dayNav = useMemo(() => {
    return dayGroups.map((g) => ({
      day: g.day,
      shortLabel: new Date(g.day + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short" }),
    }));
  }, [dayGroups]);

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
        talkUri: talk.uri,
      });
      setShowMobilePlayer(true);
      fetchComments(rkey).then(setComments);
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
      <nav className="shrink-0 w-10 flex flex-col items-center justify-center gap-0 border-r border-neutral-800 py-1 hidden md:flex">
        {dayNav.map(({ day, shortLabel }) => (
          <button
            key={day}
            onClick={() => scrollToDay(day)}
            className="text-[11px] leading-none text-neutral-500 hover:text-neutral-100 transition-colors w-6 h-6 flex items-center justify-center"
          >
            {shortLabel}
          </button>
        ))}
      </nav>

      {/* Main: search + multi-column talk list */}
      <div className={`flex-1 min-w-0 overflow-y-auto p-4 ${showMobilePlayer ? "hidden md:block" : ""}`}>
        {/* Sticky search bar */}
        <div className="flex items-center gap-3 mb-4 sticky top-0 z-10 bg-neutral-950 py-2 -mt-2">
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
        <div className="flex gap-6 items-start flex-wrap">
          {dayGroups.map((group) => (
            <div key={group.day} className="min-w-[280px] flex-1">
                <div className="mb-4">
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
                        {(() => {
                          const emojis: [string, number][] = talk.reaction_summary || [];
                          const count = talk.comment_count || 0;
                          if (emojis.length === 0 && count === 0) return null;
                          return (
                            <>
                              {" \u00b7 "}
                              {emojis.map(([emoji, n]) => (
                                <span key={emoji}>{emoji}{n > 1 ? n : ""}</span>
                              ))}
                              {count > 0 && <span>{emojis.length > 0 ? " " : ""}{"\uD83D\uDCAC"}{count}</span>}
                            </>
                          );
                        })()}
                      </div>
                    </button>
                  ))}
                </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: player panel */}
      <div className={
        !selectedTalk
          ? "hidden"
          : showMobilePlayer
            ? `flex w-full ${widePlayer ? "md:w-2/3" : "md:w-[400px]"} shrink-0 md:border-l border-neutral-800 flex-col transition-all`
            : `hidden md:flex ${widePlayer ? "md:w-2/3" : "md:w-[400px]"} shrink-0 border-l border-neutral-800 flex-col transition-all`
      }>
        {selectedTalk ? (
          <TimestampProvider key={selectedTalk.rkey + selectedTalk.seekToNs}>
            <InitialSeek timestampNs={selectedTalk.seekToNs} />
            <div className="p-3 border-b border-neutral-800 text-sm font-medium flex items-center gap-2">
              <button
                onClick={() => { setShowMobilePlayer(false); setSelectedTalk(null); }}
                className="md:hidden text-neutral-400 hover:text-neutral-200 transition-colors shrink-0 text-sm"
              >
                &larr; Back to list
              </button>
              <button
                onClick={() => setWidePlayer(!widePlayer)}
                className="text-neutral-500 hover:text-neutral-200 transition-colors shrink-0 hidden md:block"
                title={widePlayer ? "Collapse player" : "Expand player"}
              >
                {widePlayer ? "\u2192" : "\u2190"}
              </button>
              <a href={`/talks/${selectedTalk.rkey}`} className="truncate hover:text-neutral-100 transition-colors">{selectedTalk.title}</a>
              <a
                href={`/talks/${selectedTalk.rkey}`}
                className="text-neutral-500 hover:text-neutral-200 transition-colors shrink-0 text-xs"
                title="Open full talk page"
              >&#x2197;</a>
            </div>
            <div className="shrink-0 bg-black overflow-hidden">
              <VideoPlayer
                videoUri={selectedTalk.videoUri}
                offsetNs={selectedTalk.offsetNs}
              />
            </div>
            <ReactionBar
              subjectUri={selectedTalk.talkUri}
              comments={comments}
              onCommentPublished={() => fetchComments(selectedTalk.rkey).then(setComments)}
            />
            {selectedTalk.document && (
              <div className="flex-1 min-h-0">
                <TranscriptView document={selectedTalk.document} transcriptUri={selectedTalk.talkUri} comments={comments} onCommentPublished={() => fetchComments(selectedTalk.rkey).then(setComments)} />
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
