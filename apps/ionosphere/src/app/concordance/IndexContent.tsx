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

// --- Flow items: letter headings and entries in one flat list ---

type FlowItem =
  | { type: "heading"; letter: string }
  | { type: "entry"; entry: IndexEntry };

const FONT = "13px/1.6 ui-sans-serif, system-ui, sans-serif";
const LINE_HEIGHT = 21;
const HEADING_HEIGHT = 32;

function measureEntryHeight(entry: IndexEntry, columnWidth: number, usePretext: boolean): number {
  let height = 0;

  if (usePretext && columnWidth > 0) {
    const prepared = prepare(entry.term, FONT);
    const measured = layout(prepared, columnWidth, LINE_HEIGHT);
    height += measured.height;
  } else {
    height += LINE_HEIGHT;
  }

  if (entry.see?.length > 0 && entry.talks.length === 0 && !entry.subentries?.length) {
    return height + 4;
  }

  height += Math.min(entry.talks.length, 5) * LINE_HEIGHT;
  if (entry.talks.length > 5) height += LINE_HEIGHT;
  for (const sub of entry.subentries || []) {
    height += LINE_HEIGHT;
    height += sub.talks.length * LINE_HEIGHT;
  }
  if (entry.see?.length > 0) height += LINE_HEIGHT;
  if (entry.seeAlso?.length > 0) height += LINE_HEIGHT;
  height += 4;
  return height;
}

function measureItemHeight(item: FlowItem, columnWidth: number, usePretext: boolean): number {
  if (item.type === "heading") return HEADING_HEIGHT;
  return measureEntryHeight(item.entry, columnWidth, usePretext);
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

  const containerRef = useRef<HTMLDivElement>(null);
  const [columnWidth, setColumnWidth] = useState(280);
  const [columnHeight, setColumnHeight] = useState(600);
  const [numCols, setNumCols] = useState(4);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Measure container — use a dedicated ref for the column area
  const columnsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    const colEl = columnsRef.current;
    if (!el || !colEl) return;
    const observer = new ResizeObserver(() => {
      const available = el.clientWidth;
      // On narrow screens (< 640px), single column with vertical scroll
      if (available < 640) {
        setNumCols(1);
        setColumnWidth(available - 32);
        setColumnHeight(0); // not used in single-column mode
        return;
      }
      const padding = 32;
      const usable = available - padding;
      const cols = Math.max(2, Math.floor(usable / 280));
      const gap = (cols - 1) * 24;
      setColumnWidth(Math.max(200, Math.floor((usable - gap) / cols)));
      setNumCols(cols);
      // Column height = actual rendered height of the columns flex container
      setColumnHeight(colEl.clientHeight);
    });
    observer.observe(el);
    observer.observe(colEl);
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

  // All letters for nav (from unfiltered entries)
  const allLetters = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries || []) {
      const l = e.term[0]?.toUpperCase();
      if (l && /[A-Z]/.test(l)) set.add(l);
    }
    return [...set].sort();
  }, [entries]);

  // Flatten into flow items: heading + entries for each letter
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

  // Pre-compute cumulative heights
  const itemHeights = useMemo(() => {
    return flowItems.map((item) => measureItemHeight(item, columnWidth, mounted));
  }, [flowItems, columnWidth, mounted]);

  const cumulativeHeights = useMemo(() => {
    const cumulative: number[] = [0];
    for (let i = 0; i < itemHeights.length; i++) {
      cumulative.push(cumulative[i] + itemHeights[i]);
    }
    return cumulative;
  }, [itemHeights]);

  const totalHeight = cumulativeHeights[cumulativeHeights.length - 1] || 0;
  const totalColumns = Math.max(1, Math.ceil(totalHeight / Math.max(1, columnHeight)));

  // Scroll position: which column is at the left edge
  const [scrollColumn, setScrollColumn] = useState(0);
  const maxScroll = Math.max(0, totalColumns - numCols);

  // Letter-to-column mapping
  const letterToColumn = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < flowItems.length; i++) {
      const item = flowItems[i];
      if (item.type === "heading" && !map.has(item.letter)) {
        const offset = cumulativeHeights[i];
        map.set(item.letter, Math.floor(offset / Math.max(1, columnHeight)));
      }
    }
    return map;
  }, [flowItems, cumulativeHeights, columnHeight]);

  // Current letter (for nav highlighting)
  const currentLetter = useMemo(() => {
    const startOffset = scrollColumn * columnHeight;
    let letter = "A";
    for (let i = 0; i < flowItems.length; i++) {
      if (cumulativeHeights[i] > startOffset) break;
      if (flowItems[i].type === "heading") letter = (flowItems[i] as { type: "heading"; letter: string }).letter;
    }
    return letter;
  }, [scrollColumn, columnHeight, flowItems, cumulativeHeights]);

  // Compute which items go in each visible column
  const visibleColumns = useMemo(() => {
    const cols: FlowItem[][] = [];
    for (let c = 0; c < numCols; c++) {
      const colIndex = scrollColumn + c;
      const colStart = colIndex * columnHeight;
      const colEnd = colStart + columnHeight;
      const items: FlowItem[] = [];

      // Find first item that overlaps this column
      let i = 0;
      while (i < flowItems.length && cumulativeHeights[i + 1] <= colStart) i++;

      // Fill column
      let filled = cumulativeHeights[i] - colStart; // partial item overlap from top
      while (i < flowItems.length && filled < columnHeight) {
        items.push(flowItems[i]);
        filled += itemHeights[i];
        i++;
      }
      cols.push(items);
    }
    return cols;
  }, [scrollColumn, numCols, columnHeight, flowItems, itemHeights, cumulativeHeights]);

  // Scroll handler: wheel scrolls columns (multi-column only)
  useEffect(() => {
    if (numCols <= 1) return;
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = Math.sign(e.deltaY);
      setScrollColumn((prev) => Math.max(0, Math.min(maxScroll, prev + delta)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [maxScroll, numCols]);

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
    const col = letterToColumn.get(letter);
    if (col !== undefined) {
      setScrollColumn(Math.min(col, maxScroll));
    }
  }, [letterToColumn, maxScroll]);

  const scrollToTerm = useCallback((term: string) => {
    // Find the term in flowItems, compute its column
    for (let i = 0; i < flowItems.length; i++) {
      const item = flowItems[i];
      if (item.type === "entry" && item.entry.term.toLowerCase() === term.toLowerCase()) {
        const offset = cumulativeHeights[i];
        const col = Math.floor(offset / Math.max(1, columnHeight));
        setScrollColumn(Math.min(col, maxScroll));
        return;
      }
    }
  }, [flowItems, cumulativeHeights, columnHeight, maxScroll]);

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

  // Render a flow item
  const renderItem = (item: FlowItem) => {
    if (item.type === "heading") {
      return (
        <h2 key={`h-${item.letter}`} className="text-base font-bold text-neutral-500 border-b border-neutral-800 pb-0.5 mb-1 mt-3 first:mt-0">
          {item.letter}
        </h2>
      );
    }
    const entry = item.entry;
    const isSeeOnly = entry.see?.length > 0 && entry.talks.length === 0 && !entry.subentries?.length;
    if (isSeeOnly) {
      return (
        <div key={entry.term} className="text-[13px] leading-[1.6] mb-1">
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
      <div key={entry.term} className="text-[13px] leading-[1.6] mb-2">
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
      <nav className="shrink-0 w-8 flex-col items-center justify-center gap-0 border-r border-neutral-800 py-1 hidden md:flex">
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
        <div className="flex items-center gap-3 mb-2 shrink-0">
          <div className="flex-1 max-w-sm relative">
            <input
              type="text"
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setScrollColumn(0); }}
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
          {totalColumns > numCols && (
            <span className="text-xs text-neutral-600 shrink-0">
              {scrollColumn + 1}–{Math.min(scrollColumn + numCols, totalColumns)} of {totalColumns}
            </span>
          )}
        </div>

        {/* Columns — multi-column: fixed height, paged. Single column: vertical scroll */}
        {numCols <= 1 ? (
          <div ref={columnsRef} className="flex-1 min-h-0 overflow-y-auto">
            {flowItems.map(renderItem)}
          </div>
        ) : (
          <div ref={columnsRef} className="flex gap-6 flex-1 min-h-0">
            {visibleColumns.map((items, colIdx) => (
              <div key={`${scrollColumn}-${colIdx}`} className="min-w-0 flex-1 overflow-hidden">
                {items.map(renderItem)}
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
              <span className="truncate">{selectedTalk.title}</span>
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
