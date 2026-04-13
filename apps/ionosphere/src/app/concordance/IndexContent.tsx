"use client";

import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { prepare, layout } from "@chenglou/pretext";
import { TimestampProvider, useTimestamp } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import TranscriptView from "@/app/components/TranscriptView";
import { fetchComments, type CommentData } from "@/lib/comments";

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

type FlowItem =
  | { type: "heading"; letter: string }
  | { type: "entry"; entry: IndexEntry };

const FONT = "13px/1.6 ui-sans-serif, system-ui, sans-serif";
const LINE_HEIGHT = 21;
const HEADING_HEIGHT = 32;

function estimateItemHeight(item: FlowItem, columnWidth: number): number {
  if (item.type === "heading") return HEADING_HEIGHT;
  const entry = item.entry;
  let h = LINE_HEIGHT; // term line

  if (entry.see?.length > 0 && entry.talks.length === 0 && !entry.subentries?.length) {
    return h + 4;
  }

  h += Math.min(entry.talks.length, 5) * LINE_HEIGHT;
  if (entry.talks.length > 5) h += LINE_HEIGHT;
  for (const sub of entry.subentries || []) {
    h += LINE_HEIGHT + sub.talks.length * LINE_HEIGHT;
  }
  if (entry.see?.length > 0) h += LINE_HEIGHT;
  if (entry.seeAlso?.length > 0) h += LINE_HEIGHT;
  h += 4;
  return h;
}

// --- Greedy column fill ---

interface FilledColumn {
  items: FlowItem[];
  endIndex: number; // index in flowItems after last item in this column
  usedHeight: number;
  extraSpacing: number; // per-item extra margin for vertical justification
}

function fillColumn(flowItems: FlowItem[], startIndex: number, columnHeight: number, columnWidth: number): FilledColumn {
  const items: FlowItem[] = [];
  let used = 0;
  let i = startIndex;

  while (i < flowItems.length) {
    const h = estimateItemHeight(flowItems[i], columnWidth);
    if (used + h > columnHeight && items.length > 0) break;
    items.push(flowItems[i]);
    used += h;
    i++;
  }

  // Vertical justification: distribute remaining space as extra margin
  // Cap at 6px per gap to avoid huge gaps with few items
  const remaining = Math.max(0, columnHeight - used);
  const extraSpacing = items.length > 1 ? Math.min(remaining / (items.length - 1), 6) : 0;

  return { items, endIndex: i, usedHeight: used, extraSpacing };
}

// --- Mobile single-column with progressive rendering ---

const MobileConcordance = React.forwardRef<HTMLDivElement, {
  flowItems: FlowItem[];
  renderItem: (item: FlowItem, extraMargin: number) => React.ReactNode;
  onSetVisibleCount?: React.MutableRefObject<((count: number) => void) | undefined>;
}>(function MobileConcordance({ flowItems, renderItem, onSetVisibleCount }, ref) {
  const BATCH = 200;
  const [visibleCount, setVisibleCount] = useState(BATCH);

  // Expose setter for parent (letter nav)
  useEffect(() => {
    if (onSetVisibleCount) {
      onSetVisibleCount.current = (count: number) => setVisibleCount((prev) => Math.max(prev, Math.min(count, flowItems.length)));
    }
  }, [onSetVisibleCount, flowItems.length]);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + BATCH, flowItems.length));
        }
      },
      { rootMargin: "400px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [flowItems.length]);

  return (
    <div ref={ref} className="flex-1 min-h-0 overflow-y-auto">
      {flowItems.slice(0, visibleCount).map((item) => renderItem(item, 0))}
      {visibleCount < flowItems.length && (
        <div ref={sentinelRef} className="text-center text-neutral-600 text-xs py-4">
          Loading more...
        </div>
      )}
    </div>
  );
});

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
  const [filterInput, setFilterInput] = useState("");
  const [filter, setFilter] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const filterTimer = useRef<ReturnType<typeof setTimeout>>();
  const handleFilterChange = useCallback((value: string) => {
    setFilterInput(value);
    clearTimeout(filterTimer.current);
    filterTimer.current = setTimeout(() => {
      setFilter(value);
      setStartIndex(0);
    }, 150);
  }, []);
  const [widePlayer, setWidePlayer] = useState(false);
  const [showMobilePlayer, setShowMobilePlayer] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const [columnWidth, setColumnWidth] = useState(280);
  const [columnHeight, setColumnHeight] = useState(600);
  const [numCols, setNumCols] = useState(4);

  // Measure container
  const searchBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const available = el.clientWidth;
      if (available < 640) {
        setNumCols(1);
        setColumnWidth(available - 32);
        setColumnHeight(0);
        return;
      }
      const padding = 32;
      const usable = available - padding;
      const cols = Math.max(2, Math.floor(usable / 280));
      const gap = (cols - 1) * 24;
      setColumnWidth(Math.max(200, Math.floor((usable - gap) / cols)));
      setNumCols(cols);
      // Column height = container height minus search bar and padding
      const searchH = searchBarRef.current?.offsetHeight || 0;
      setColumnHeight(el.clientHeight - searchH - 20);
    };
    // Measure immediately and on resize
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading]);

  // Filter
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

  // Flatten into flow items
  const flowItems = useMemo(() => {
    const items: FlowItem[] = [];
    let currentLetter = "";
    for (const entry of filteredEntries) {
      const letter = entry.term[0]?.toUpperCase() || "#";
      if (letter !== currentLetter) {
        currentLetter = letter;
        items.push({ type: "heading", letter });
      }
      items.push({ type: "entry", entry });
    }
    return items;
  }, [filteredEntries]);

  // Letter-to-index mapping (index in flowItems where each letter heading is)
  const letterToIndex = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < flowItems.length; i++) {
      const item = flowItems[i];
      if (item.type === "heading" && !map.has(item.letter)) {
        map.set(item.letter, i);
      }
    }
    return map;
  }, [flowItems]);

  // Start index: which item in flowItems is at the top of the leftmost column
  const [startIndex, setStartIndex] = useState(0);

  // Reset on filter change
  useEffect(() => { setStartIndex(0); }, [filter]);

  // Greedy-fill visible columns + 1 buffer column on each side
  const filled = useMemo(() => {
    if (numCols <= 1 || columnHeight <= 0) return [];

    // Fill one buffer column before the visible ones to know what "scrolling back" looks like
    // But we start from startIndex for the visible columns
    const cols: FilledColumn[] = [];
    let idx = startIndex;
    for (let c = 0; c < numCols + 1; c++) { // +1 buffer after
      if (idx >= flowItems.length) {
        cols.push({ items: [], endIndex: idx, usedHeight: 0, extraSpacing: 0 });
      } else {
        const col = fillColumn(flowItems, idx, columnHeight, columnWidth);
        cols.push(col);
        idx = col.endIndex;
      }
    }
    return cols;
  }, [startIndex, numCols, columnHeight, columnWidth, flowItems]);

  // The visible columns (exclude the buffer)
  const visibleFilled = filled.slice(0, numCols);

  // Current letter for nav highlighting
  const currentLetter = useMemo(() => {
    let letter = "A";
    for (let i = 0; i <= startIndex && i < flowItems.length; i++) {
      if (flowItems[i].type === "heading") letter = (flowItems[i] as { type: "heading"; letter: string }).letter;
    }
    return letter;
  }, [startIndex, flowItems]);

  // Can scroll forward/back?
  const canScrollForward = filled.length > 0 && filled[filled.length - 1].endIndex < flowItems.length;
  const canScrollBack = startIndex > 0;

  // Scroll: advance by one column's worth of items
  const scrollForward = useCallback(() => {
    if (visibleFilled.length > 0 && visibleFilled[0].endIndex < flowItems.length) {
      setStartIndex(visibleFilled[0].endIndex);
    }
  }, [visibleFilled, flowItems.length]);

  const scrollBack = useCallback(() => {
    if (startIndex <= 0) return;
    // Fill one column backwards from startIndex to find where the previous column started
    let idx = startIndex - 1;
    let used = 0;
    while (idx >= 0) {
      const h = estimateItemHeight(flowItems[idx], columnWidth);
      if (used + h > columnHeight && used > 0) break;
      used += h;
      idx--;
    }
    setStartIndex(Math.max(0, idx + 1));
  }, [startIndex, flowItems, columnWidth, columnHeight]);

  // Wheel handler
  useEffect(() => {
    if (numCols <= 1) return;
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY > 0) scrollForward();
      else if (e.deltaY < 0) scrollBack();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [numCols, scrollForward, scrollBack]);

  const handleSelect = useCallback(
    async (rkey: string, _word: string, timestampNs: number) => {
      try {
        const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
        const res = await fetch(`${API_BASE}/xrpc/tv.ionosphere.getTalk?rkey=${encodeURIComponent(rkey)}`);
        if (!res.ok) return;
        const { talk } = await res.json();
        const doc = talk.document ? (typeof talk.document === "string" ? JSON.parse(talk.document) : talk.document) : null;
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

  const mobileVisibleCountRef = useRef<(count: number) => void>();
  const scrollToLetter = useCallback((letter: string) => {
    if (numCols <= 1) {
      // Mobile: ensure items up to this letter are loaded, then scroll
      const idx = letterToIndex.get(letter);
      if (idx !== undefined && mobileVisibleCountRef.current) {
        mobileVisibleCountRef.current(idx + 200); // load up to the letter + a buffer
      }
      requestAnimationFrame(() => {
        const el = document.getElementById(`heading-${letter}`);
        if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
      });
    } else {
      const idx = letterToIndex.get(letter);
      if (idx !== undefined) setStartIndex(idx);
    }
  }, [letterToIndex, numCols]);

  const scrollToTerm = useCallback((term: string) => {
    for (let i = 0; i < flowItems.length; i++) {
      const item = flowItems[i];
      if (item.type === "entry" && item.entry.term.toLowerCase() === term.toLowerCase()) {
        setStartIndex(i);
        return;
      }
    }
  }, [flowItems]);

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

  // Render a flow item with optional extra bottom margin for justification
  const renderItem = (item: FlowItem, extraMargin: number) => {
    const style = extraMargin > 0 ? { marginBottom: extraMargin } : undefined;
    if (item.type === "heading") {
      return (
        <h2 key={`h-${item.letter}`} id={`heading-${item.letter}`} className="text-base font-bold text-neutral-500 border-b border-neutral-800 pb-0.5 mb-1 mt-3 first:mt-0" style={style}>
          {item.letter}
        </h2>
      );
    }
    const entry = item.entry;
    const isSeeOnly = entry.see?.length > 0 && entry.talks.length === 0 && !entry.subentries?.length;
    if (isSeeOnly) {
      return (
        <div key={entry.term} className="text-[13px] leading-[1.6] mb-1" style={style}>
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
      <div key={entry.term} className="text-[13px] leading-[1.6] mb-2" style={style}>
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
  };

  return (
    <div className="h-full flex">
      {/* Letter nav */}
      <nav className="shrink-0 w-8 flex flex-col items-center justify-center gap-0 border-r border-neutral-800 py-1">
        {allLetters.map((letter) => (
          <button
            key={letter}
            onClick={() => scrollToLetter(letter)}
            className={`text-[11px] leading-none transition-colors w-6 h-6 flex items-center justify-center ${
              letter === currentLetter ? "text-neutral-100 font-bold" : "text-neutral-500 hover:text-neutral-100"
            }`}
          >
            {letter}
          </button>
        ))}
      </nav>

      {/* Main area */}
      <div ref={containerRef} className={`flex-1 min-w-0 flex flex-col overflow-hidden px-4 pt-3 pb-2 ${showMobilePlayer ? "hidden md:flex" : ""}`}>
        {/* Search bar */}
        <div ref={searchBarRef} className="flex items-center gap-3 mb-2 shrink-0">
          <div className="flex-1 max-w-sm relative">
            <input
              type="text"
              value={filterInput}
              onChange={(e) => handleFilterChange(e.target.value)}
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

        {/* Columns */}
        {numCols <= 1 ? (
          <MobileConcordance ref={columnsRef} flowItems={flowItems} renderItem={renderItem} onSetVisibleCount={mobileVisibleCountRef} />
        ) : (
          <div ref={columnsRef} className="flex gap-6 flex-1 min-h-0">
            {visibleFilled.map((col, colIdx) => (
              <div key={`${startIndex}-${colIdx}`} className="min-w-0 flex-1 overflow-hidden">
                {col.items.map((item) => renderItem(item, col.extraSpacing))}
              </div>
            ))}
          </div>
        )}
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
              <a href={`/talks/${selectedTalk.rkey}`} className="truncate hover:text-neutral-100 transition-colors min-w-0">{selectedTalk.title}</a>
              <a
                href={`/talks/${selectedTalk.rkey}`}
                className="text-neutral-500 hover:text-neutral-200 transition-colors shrink-0 text-xs ml-1"
                title="Open full talk page"
              >&#x2197;</a>
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
