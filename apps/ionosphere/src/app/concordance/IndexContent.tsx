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

export default function IndexContent({ entries }: { entries: IndexEntry[] }) {
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
    for (const e of entries) {
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

  // Pretext-measured column distribution
  const columns = useMemo(() => {
    const numCols = Math.max(1, Math.floor((columnWidth > 0 ? (containerRef.current?.clientWidth || 1200) : 1200) / 300));
    const heights = groups.map((g) => {
      return measureGroupHeight(g, g.entries.length, columnWidth, mounted);
    });
    return distributeColumns(groups, heights, numCols);
  }, [groups, columnWidth, mounted, expandedLetters, filter]);

  const handleSelect = useCallback(
    async (rkey: string, _word: string, timestampNs: number) => {
      try {
        const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
        const res = await fetch(`${API_BASE}/talks/${rkey}`);
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
    const el = document.getElementById(`letter-${letter}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const scrollToTerm = useCallback((term: string) => {
    const id = `term-${term.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="h-full flex">
      {/* Letter nav */}
      <nav className="shrink-0 w-8 flex-col items-center justify-center gap-0 border-r border-neutral-800 py-1 hidden md:flex">
        {allLetters.map((letter) => (
          <button
            key={letter}
            onClick={() => scrollToLetter(letter)}
            className="text-[11px] leading-none text-neutral-500 hover:text-neutral-100 transition-colors w-6 h-6 flex items-center justify-center"
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

        {/* Pretext-balanced columns */}
        <div className="flex gap-6 items-start">
          {columns.map((column, colIdx) => (
            <div key={colIdx} style={{ width: columnWidth }} className="min-w-0">
              {column.map((group) => (
                  <div key={group.letter} className="mb-4">
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
                            <div key={talk.rkey} className="truncate text-neutral-500 pl-3">
                              <button
                                onClick={() => handleSelect(talk.rkey, entry.term, talk.firstTimestampNs)}
                                className="hover:text-neutral-100 hover:underline underline-offset-2 transition-colors text-left"
                              >{talk.title}</button>
                              {talk.count > 1 && <span className="text-neutral-600"> ({talk.count})</span>}
                            </div>
                          ))}
                          {entry.talks.length > 5 && (
                            <div className="text-neutral-600 pl-3">+{entry.talks.length - 5} more</div>
                          )}
                          {entry.subentries?.map((sub) => (
                            <div key={sub.label} className="pl-3">
                              <span className="text-neutral-400 italic text-xs">{sub.label}</span>
                              {sub.talks.map((talk) => (
                                <div key={talk.rkey} className="truncate text-neutral-500 pl-3">
                                  <button
                                    onClick={() => handleSelect(talk.rkey, entry.term, talk.firstTimestampNs)}
                                    className="hover:text-neutral-100 hover:underline underline-offset-2 transition-colors text-left"
                                  >{talk.title}</button>
                                  {talk.count > 1 && <span className="text-neutral-600"> ({talk.count})</span>}
                                </div>
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
              ))}
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
