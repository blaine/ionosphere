"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { prepare, layout } from "@chenglou/pretext";
import { TimestampProvider, useTimestamp } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import TranscriptView from "@/app/components/TranscriptView";
import { fetchComments, type CommentData } from "@/lib/comments";

/** Aggressively seeks and plays the video once HLS is ready. */
function InitialSeek({ timestampNs }: { timestampNs: number }) {
  const { seekTo } = useTimestamp();
  useEffect(() => {
    let cancelled = false;
    function trySeekAndPlay() {
      if (cancelled) return;
      const video = document.querySelector<HTMLVideoElement>("video");
      if (!video) { setTimeout(trySeekAndPlay, 100); return; }
      function doSeekAndPlay() {
        if (cancelled) return;
        if (timestampNs > 0) seekTo(timestampNs);
        video!.play().catch(() => {});
      }
      if (video.readyState >= 2) { doSeekAndPlay(); return; }
      video.addEventListener("loadeddata", doSeekAndPlay, { once: true });
      video.addEventListener("canplay", doSeekAndPlay, { once: true });
      video.play().catch(() => {});
    }
    trySeekAndPlay();
    return () => { cancelled = true; };
  }, [timestampNs, seekTo]);
  return null;
}

// --- Types ---

interface TalkRef {
  rkey: string;
  title: string;
  count: number;
  firstTimestampNs: number;
}

function formatTimecode(ns: number): string {
  const totalSec = Math.floor(ns / 1e9);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function TalkEntry({ talk, term, onSelect }: {
  talk: TalkRef;
  term: string;
  onSelect: (rkey: string, term: string, seekToNs: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [timestamps, setTimestamps] = useState<number[] | null>(null);
  const hasMultiple = talk.count > 1;

  const handleExpand = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next && !timestamps) {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
      fetch(`${API_BASE}/xrpc/tv.ionosphere.getTimecodes?term=${encodeURIComponent(term)}&rkey=${encodeURIComponent(talk.rkey)}`)
        .then((r) => r.json())
        .then((d) => setTimestamps(d.timestamps || []))
        .catch(() => setTimestamps([]));
    }
  }, [expanded, timestamps, term, talk.rkey]);

  return (
    <div className="text-neutral-500 pl-3">
      <div className="truncate">
        <button
          onClick={() => onSelect(talk.rkey, term, talk.firstTimestampNs)}
          className="hover:text-neutral-100 hover:underline underline-offset-2 transition-colors text-left"
        >{talk.title}</button>
        {hasMultiple && (
          <button
            onClick={handleExpand}
            className="text-neutral-600 hover:text-neutral-400 ml-1 transition-colors"
          >({talk.count}){expanded ? " \u25B4" : " \u25BE"}</button>
        )}
      </div>
      {expanded && (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 pl-2 mt-0.5 mb-1">
          {timestamps ? timestamps.map((ts, i) => (
            <button
              key={i}
              onClick={() => onSelect(talk.rkey, term, ts)}
              className="text-[11px] text-neutral-600 hover:text-neutral-300 tabular-nums transition-colors"
            >{formatTimecode(ts)}</button>
          )) : (
            <span className="text-[11px] text-neutral-700">loading...</span>
          )}
        </div>
      )}
    </div>
  );
}

interface IndexEntry {
  term: string;
  proper: boolean;
  talks: TalkRef[];
  subentries: { label: string; talks: TalkRef[] }[];
  see: string[];
  seeAlso: string[];
  totalCount: number;
}

interface LetterGroup {
  letter: string;
  entries: IndexEntry[];
}

// --- Pretext measurement ---

const FONT = "13px/1.6 ui-sans-serif, system-ui, sans-serif";
const LINE_HEIGHT = 21;
const HEADING_HEIGHT = 32;
const GROUP_MARGIN = 16;

/**
 * Measure a letter group's height using Pretext.
 * With the 20-per-group cap, this is fast (~500 entries total).
 */
function measureGroupHeight(
  group: LetterGroup,
  visibleCount: number,
  columnWidth: number,
  usePretext: boolean
): number {
  let height = HEADING_HEIGHT;
  const visible = group.entries.slice(0, visibleCount);

  for (const entry of visible) {
    if (usePretext && columnWidth > 0) {
      // Measure the term line with Pretext
      const termText = entry.term;
      const prepared = prepare(termText, FONT);
      const measured = layout(prepared, columnWidth, LINE_HEIGHT);
      height += measured.height;
    } else {
      height += LINE_HEIGHT;
    }

    // See-only entries are compact
    if (entry.see?.length > 0 && entry.talks.length === 0 && !entry.subentries?.length) {
      height += 4;
      continue;
    }
    // Talk refs (max 5 shown)
    height += Math.min(entry.talks.length, 5) * LINE_HEIGHT;
    if (entry.talks.length > 5) height += LINE_HEIGHT;
    // Subentries
    for (const sub of entry.subentries || []) {
      height += LINE_HEIGHT; // label
      height += sub.talks.length * LINE_HEIGHT;
    }
    // See/seeAlso
    if (entry.see?.length > 0) height += LINE_HEIGHT;
    if (entry.seeAlso?.length > 0) height += LINE_HEIGHT;
    height += 4; // entry margin
  }

  // "+N more" button
  if (group.entries.length > visibleCount) height += LINE_HEIGHT;

  height += GROUP_MARGIN;
  return height;
}

/**
 * Newspaper-style column distribution: fill down then right,
 * balanced by measured height.
 */
function distributeColumns(
  groups: LetterGroup[],
  heights: number[],
  numColumns: number
): LetterGroup[][] {
  const totalHeight = heights.reduce((sum, h) => sum + h, 0);
  const targetHeight = totalHeight / numColumns;

  const columns: LetterGroup[][] = [];
  let currentColumn: LetterGroup[] = [];
  let currentHeight = 0;

  for (let i = 0; i < groups.length; i++) {
    currentColumn.push(groups[i]);
    currentHeight += heights[i];

    if (currentHeight >= targetHeight && columns.length < numColumns - 1) {
      columns.push(currentColumn);
      currentColumn = [];
      currentHeight = 0;
    }
  }
  columns.push(currentColumn);

  return columns;
}

// --- Component ---

export default function IndexContent({ entries: initialEntries }: { entries: IndexEntry[] | null }) {
  const [entries, setEntries] = useState<IndexEntry[] | null>(initialEntries);
  const [loading, setLoading] = useState(!initialEntries);

  useEffect(() => {
    if (initialEntries) return;
    const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
    fetch(`${API_BASE}/xrpc/tv.ionosphere.getConcordance`)
      .then((r) => r.json())
      .then((d) => { setEntries(d.entries); setLoading(false); })
      .catch(() => setLoading(false));
  }, [initialEntries]);

  const [selectedTalk, setSelectedTalk] = useState<{
    rkey: string; title: string; videoUri: string;
    offsetNs: number; document: any; seekToNs: number;
    talkUri: string;
  } | null>(null);

  const [comments, setComments] = useState<CommentData[]>([]);
  const [filter, setFilter] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [widePlayer, setWidePlayer] = useState(false);
  const [showMobilePlayer, setShowMobilePlayer] = useState(false);
  const [expandedLetters] = useState<Set<string>>(new Set()); // kept for API compat

  const containerRef = useRef<HTMLDivElement>(null);
  const [columnWidth, setColumnWidth] = useState(280);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Measure available width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const padding = 32;
      const available = el.clientWidth - padding;
      const cols = Math.max(1, Math.floor(available / 300));
      const gap = (cols - 1) * 24;
      setColumnWidth(Math.max(200, Math.floor((available - gap) / cols)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Filter entries
  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    if (!filter) return entries;
    try {
      const pattern = isRegex ? new RegExp(filter, "i") : null;
      return entries.filter((e) =>
        pattern ? pattern.test(e.term) : e.term.toLowerCase().includes(filter.toLowerCase())
      );
    } catch {
      return entries.filter((e) =>
        e.term.toLowerCase().includes(filter.toLowerCase())
      );
    }
  }, [entries, filter, isRegex]);

  // All letters for nav
  const allLetters = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries || []) {
      const l = e.term[0]?.toUpperCase();
      if (l && /[A-Z]/.test(l)) set.add(l);
    }
    return [...set].sort();
  }, [entries]);

  // Group by letter
  const groups = useMemo(() => {
    const map = new Map<string, IndexEntry[]>();
    for (const entry of filteredEntries) {
      const letter = entry.term[0]?.toUpperCase() || "#";
      if (!map.has(letter)) map.set(letter, []);
      map.get(letter)!.push(entry);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([letter, letterEntries]) => ({ letter, entries: letterEntries }));
  }, [filteredEntries]);

  // Pretext-measured heights for ALL groups (cheap — no DOM)
  const groupHeights = useMemo(() => {
    return groups.map((g) => measureGroupHeight(g, g.entries.length, columnWidth, mounted));
  }, [groups, columnWidth, mounted]);

  // Column layout for ALL groups (distributes by height, no rendering)
  const numCols = useMemo(() => {
    return Math.max(1, Math.floor((columnWidth > 0 ? (containerRef.current?.clientWidth || 1200) : 1200) / 300));
  }, [columnWidth]);

  const columnLayout = useMemo(() => {
    return distributeColumns(groups, groupHeights, numCols);
  }, [groups, groupHeights, numCols]);

  // Per-column: cumulative height offsets for each group (for spacer sizing)
  const columnOffsets = useMemo(() => {
    return columnLayout.map((col) => {
      const offsets: number[] = [];
      let h = 0;
      for (const group of col) {
        offsets.push(h);
        const idx = groups.indexOf(group);
        h += idx >= 0 ? groupHeights[idx] : 0;
      }
      offsets.push(h); // total height
      return offsets;
    });
  }, [columnLayout, groups, groupHeights]);

  // Centroid: which letter group index is "centered" in the viewport
  const [centroidLetter, setCentroidLetter] = useState("A");
  const RENDER_WINDOW = 5; // render groups within ±5 of centroid in the alphabet

  // Which group indices are visible (within window of centroid)
  const visibleLetters = useMemo(() => {
    if (filter) return new Set(groups.map((g) => g.letter)); // show all when filtering
    const centroidIdx = groups.findIndex((g) => g.letter === centroidLetter);
    const center = centroidIdx >= 0 ? centroidIdx : 0;
    const set = new Set<string>();
    for (let i = Math.max(0, center - RENDER_WINDOW); i < Math.min(groups.length, center + RENDER_WINDOW + 1); i++) {
      set.add(groups[i].letter);
    }
    return set;
  }, [groups, centroidLetter, filter]);

  // Update centroid from scroll position using IntersectionObserver
  const groupRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  useEffect(() => {
    if (filter) return; // don't update centroid when filtering
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const letter = entry.target.getAttribute("data-letter");
            if (letter) setCentroidLetter(letter);
          }
        }
      },
      { rootMargin: "-20% 0px -60% 0px" } // trigger when group enters top third
    );
    for (const el of groupRefs.current.values()) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, [groups, visibleLetters, filter]);

  const handleSelect = useCallback(
    async (rkey: string, _word: string, timestampNs: number) => {
      try {
        const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
        const res = await fetch(`${API_BASE}/xrpc/tv.ionosphere.getTalk?rkey=${encodeURIComponent(rkey)}`);
        if (!res.ok) return;
        const { talk } = await res.json();
        const doc = talk.document ? JSON.parse(talk.document) : null;
        setSelectedTalk({
          rkey, title: talk.title, videoUri: talk.video_uri,
          offsetNs: talk.video_offset_ns || 0,
          document: doc?.facets?.length > 0 ? doc : null, seekToNs: timestampNs,
          talkUri: talk.uri,
        });
        setShowMobilePlayer(true);
        fetchComments(rkey).then(setComments);
      } catch {}
    },
    []
  );

  const scrollToLetter = useCallback((letter: string) => {
    setCentroidLetter(letter);
    // The group will render on next frame; scroll to it after
    requestAnimationFrame(() => {
      const el = document.getElementById(`letter-${letter}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const scrollToTerm = useCallback((term: string) => {
    const id = `term-${term.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-neutral-500 text-sm">
        <svg className="animate-spin h-4 w-4 mr-2" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Loading index...
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* Letter nav */}
      <nav className="shrink-0 w-8 flex-col items-center justify-center gap-0 border-r border-neutral-800 py-1 hidden md:flex">
        {allLetters.map((letter) => (
          <button
            key={letter}
            onClick={() => scrollToLetter(letter)}
            className={`text-[11px] leading-none transition-colors w-6 h-6 flex items-center justify-center ${
              letter === centroidLetter ? "text-neutral-100 font-bold" : "text-neutral-500 hover:text-neutral-100"
            }`}
          >
            {letter}
          </button>
        ))}
      </nav>

      {/* Main: search + Pretext-balanced columns */}
      <div ref={containerRef} className={`flex-1 min-w-0 overflow-y-auto p-4 ${showMobilePlayer ? "hidden md:block" : ""}`}>
        {/* Sticky search */}
        <div className="flex items-center gap-3 mb-4 sticky top-0 z-10 bg-neutral-950 py-2 -mt-2">
          <div className="flex-1 max-w-sm relative">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={isRegex ? "Filter (regex)..." : "Filter..."}
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500"
            />
            <button
              onClick={() => setIsRegex(!isRegex)}
              className={`absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono px-1 rounded ${
                isRegex ? "bg-neutral-600 text-neutral-200" : "text-neutral-600 hover:text-neutral-400"
              }`}
              title="Toggle regex mode"
            >.*</button>
          </div>
          <span className="text-sm text-neutral-500 shrink-0">
            {filteredEntries.length.toLocaleString()} terms
          </span>
        </div>

        {/* Pretext-balanced columns with viewport virtualization */}
        <div className="flex gap-6 items-start">
          {columnLayout.map((column, colIdx) => (
            <div key={colIdx} className="min-w-0 flex-1">
              {column.map((group, groupIdx) => {
                const isVisible = visibleLetters.has(group.letter);
                const gIdx = groups.indexOf(group);
                const height = gIdx >= 0 ? groupHeights[gIdx] : 0;

                if (!isVisible) {
                  // Spacer preserving measured height
                  return <div key={group.letter} id={`letter-${group.letter}`} style={{ height }} />;
                }

                return (
                  <div
                    key={group.letter}
                    ref={(el) => { if (el) groupRefs.current.set(group.letter, el); else groupRefs.current.delete(group.letter); }}
                    data-letter={group.letter}
                    className="mb-4"
                  >
                    <h2 id={`letter-${group.letter}`} className="text-base font-bold text-neutral-500 border-b border-neutral-800 pb-0.5 mb-1">
                      {group.letter}
                    </h2>
                    {group.entries.map((entry) => {
                      const isSeeOnly = entry.see?.length > 0 && entry.talks.length === 0 && !entry.subentries?.length;
                      if (isSeeOnly) {
                        return (
                          <div key={entry.term} id={`term-${entry.term.toLowerCase().replace(/[^a-z0-9]/g, "-")}`} className="text-[13px] leading-[1.6] mb-1">
                            <span className="text-neutral-400">{entry.term}</span>
                            <span className="text-neutral-600 italic"> — see{" "}
                              {entry.see.map((ref, i) => (
                                <span key={ref}>{i > 0 && ", "}
                                  <button onClick={() => scrollToTerm(ref)} className="hover:text-neutral-300 underline underline-offset-2">{ref}</button>
                                </span>
                              ))}
                            </span>
                          </div>
                        );
                      }
                      return (
                        <div key={entry.term} id={`term-${entry.term.toLowerCase().replace(/[^a-z0-9]/g, "-")}`} className="text-[13px] leading-[1.6] mb-2">
                          <div className="font-medium text-neutral-200">{entry.term}</div>
                          {entry.talks.slice(0, 5).map((talk) => (
                            <TalkEntry key={talk.rkey} talk={talk} term={entry.term} onSelect={handleSelect} />
                          ))}
                          {entry.talks.length > 5 && (
                            <div className="text-neutral-600 pl-3">+{entry.talks.length - 5} more</div>
                          )}
                          {entry.subentries?.map((sub) => (
                            <div key={sub.label} className="pl-3">
                              <span className="text-neutral-400 italic text-xs">{sub.label}</span>
                              {sub.talks.map((talk) => (
                                <TalkEntry key={talk.rkey} talk={talk} term={entry.term} onSelect={handleSelect} />
                              ))}
                            </div>
                          ))}
                          {entry.see?.length > 0 && (
                            <div className="text-neutral-600 italic pl-3">
                              see{" "}{entry.see.map((ref, i) => (
                                <span key={ref}>{i > 0 && ", "}
                                  <button onClick={() => scrollToTerm(ref)} className="hover:text-neutral-300 underline underline-offset-2">{ref}</button>
                                </span>
                              ))}
                            </div>
                          )}
                          {entry.seeAlso?.length > 0 && (
                            <div className="text-neutral-600 text-xs pl-3">
                              see also:{" "}{entry.seeAlso.map((ref, i) => (
                                <span key={ref}>{i > 0 && ", "}
                                  <button onClick={() => scrollToTerm(ref)} className="hover:text-neutral-300 underline underline-offset-2">{ref}</button>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
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
              >&larr; Back</button>
              <button
                onClick={() => setWidePlayer(!widePlayer)}
                className="text-neutral-500 hover:text-neutral-200 transition-colors shrink-0 hidden md:block"
                title={widePlayer ? "Collapse player" : "Expand player"}
              >{widePlayer ? "\u2192" : "\u2190"}</button>
              <span className="truncate">{selectedTalk.title}</span>
              {/* Whole-talk reactions */}
              {(() => {
                const wholeTalk = comments.filter(c => c.byte_start === null && c.text.length <= 2 && !/[a-zA-Z]/.test(c.text));
                if (wholeTalk.length === 0) return null;
                const counts = new Map<string, number>();
                for (const c of wholeTalk) counts.set(c.text, (counts.get(c.text) || 0) + 1);
                return (
                  <span className="ml-auto shrink-0 flex gap-1 text-xs">
                    {[...counts.entries()].map(([emoji, count]) => (
                      <span key={emoji} className="bg-neutral-800 rounded-full px-1.5 py-0.5">
                        {emoji}{count > 1 && <span className="text-neutral-500 ml-0.5">{count}</span>}
                      </span>
                    ))}
                  </span>
                );
              })()}
            </div>
            <div className="shrink-0 bg-black overflow-hidden">
              <VideoPlayer videoUri={selectedTalk.videoUri} offsetNs={selectedTalk.offsetNs} />
            </div>
            {selectedTalk.document && (
              <div className="flex-1 min-h-0">
                <TranscriptView document={selectedTalk.document} transcriptUri={selectedTalk.talkUri} comments={comments} onCommentPublished={() => fetchComments(selectedTalk.rkey).then(setComments)} />
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
