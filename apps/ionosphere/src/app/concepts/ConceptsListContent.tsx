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

interface Concept {
  rkey: string;
  name: string;
  description?: string;
  talk_count?: number;
}

interface ConceptTalk {
  rkey: string;
  title: string;
}

interface LetterGroup {
  letter: string;
  concepts: Concept[];
}

interface MeasuredGroup extends LetterGroup {
  height: number;
}

const LINE_HEIGHT = 22;
const HEADING_HEIGHT = 36;
const GROUP_MARGIN = 16;

function groupByLetter(concepts: Concept[]): LetterGroup[] {
  const map = new Map<string, Concept[]>();
  for (const c of concepts) {
    const letter = c.name[0]?.toUpperCase() || "#";
    if (!map.has(letter)) map.set(letter, []);
    map.get(letter)!.push(c);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([letter, items]) => ({ letter, concepts: items }));
}

function measureGroups(groups: LetterGroup[], expandedTalks: Map<string, ConceptTalk[]>): MeasuredGroup[] {
  return groups.map((g) => {
    let height = HEADING_HEIGHT;
    for (const c of g.concepts) {
      // concept name + description = ~2 lines
      height += LINE_HEIGHT * 2;
      // expanded talks
      const talks = expandedTalks.get(c.rkey);
      if (talks) {
        height += talks.length * LINE_HEIGHT;
      }
    }
    height += GROUP_MARGIN;
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

export default function ConceptsListContent({ concepts }: { concepts: Concept[] }) {
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

  // Track which concepts have been expanded to show their talks
  const [expandedTalks, setExpandedTalks] = useState<Map<string, ConceptTalk[]>>(new Map());
  const [loadingConcept, setLoadingConcept] = useState<string | null>(null);

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

  const sortedConcepts = useMemo(
    () => [...concepts].sort((a, b) => a.name.localeCompare(b.name)),
    [concepts]
  );

  const filteredConcepts = useMemo(() => {
    if (!filter) return sortedConcepts;
    const q = filter.toLowerCase();
    return sortedConcepts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.description || "").toLowerCase().includes(q)
    );
  }, [sortedConcepts, filter]);

  const allLetters = useMemo(() => {
    const set = new Set<string>();
    for (const c of sortedConcepts) {
      const l = c.name[0]?.toUpperCase();
      if (l && /[A-Z]/.test(l)) set.add(l);
    }
    return [...set].sort();
  }, [sortedConcepts]);

  const groups = useMemo(() => groupByLetter(filteredConcepts), [filteredConcepts]);

  const columns = useMemo(() => {
    const measured = measureGroups(groups, expandedTalks);
    return balanceColumns(measured, numColumns);
  }, [groups, numColumns, expandedTalks]);

  /** Fetch concept talks and expand, also load first talk in player */
  const handleConceptClick = useCallback(async (conceptRkey: string) => {
    // If already expanded, collapse
    if (expandedTalks.has(conceptRkey)) {
      setExpandedTalks((prev) => {
        const next = new Map(prev);
        next.delete(conceptRkey);
        return next;
      });
      return;
    }

    try {
      setLoadingConcept(conceptRkey);
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
      const conceptRes = await fetch(`${API_BASE}/concepts/${conceptRkey}`);
      if (!conceptRes.ok) return;
      const { talks } = await conceptRes.json();
      if (!talks || talks.length === 0) {
        setExpandedTalks((prev) => new Map(prev).set(conceptRkey, []));
        return;
      }

      // Store talk list for display
      setExpandedTalks((prev) =>
        new Map(prev).set(
          conceptRkey,
          talks.map((t: any) => ({ rkey: t.rkey, title: t.title }))
        )
      );

      // Load first talk in player
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
      console.error("[Concepts] handleConceptClick error:", err);
    } finally {
      setLoadingConcept(null);
    }
  }, [expandedTalks]);

  /** Load a specific talk in the player */
  const handleSelectTalk = useCallback(async (rkey: string) => {
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
      const talkRes = await fetch(`${API_BASE}/talks/${rkey}`);
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
      console.error("[Concepts] handleSelectTalk error:", err);
    }
  }, []);

  const scrollToLetter = useCallback((letter: string) => {
    const el = document.getElementById(`concept-letter-${letter}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  if (concepts.length === 0) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <h1 className="text-3xl font-bold mb-6">Concepts</h1>
        <p className="text-neutral-400">Concepts will appear here after transcript enrichment.</p>
      </div>
    );
  }

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

      {/* Main: search + multi-column concept list */}
      <div ref={containerRef} className="flex-1 min-w-0 overflow-y-auto p-4">
        {/* Sticky search bar */}
        <div className="flex items-center gap-3 mb-4 sticky top-0 z-10 bg-neutral-950 py-2 -mt-2">
          <h1 className="text-xl font-bold tracking-tight shrink-0">Concepts</h1>
          <div className="flex-1 max-w-sm">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name or description..."
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500"
            />
          </div>
          <span className="text-sm text-neutral-500 shrink-0">
            {filteredConcepts.length} concepts
          </span>
        </div>

        <div className="flex gap-6 items-start">
          {columns.map((column, colIdx) => (
            <div key={colIdx} style={{ width: columnWidth }} className="min-w-0">
              {column.map((group) => (
                <div key={group.letter} className="mb-4">
                  <h2
                    id={`concept-letter-${group.letter}`}
                    className="text-base font-bold text-neutral-500 border-b border-neutral-800 pb-0.5 mb-1"
                  >
                    {group.letter}
                  </h2>
                  {group.concepts.map((concept) => {
                    const conceptTalks = expandedTalks.get(concept.rkey);
                    const isExpanded = conceptTalks !== undefined;
                    const isLoading = loadingConcept === concept.rkey;

                    return (
                      <div key={concept.rkey} className="text-[13px] leading-[1.6] mb-2">
                        <button
                          onClick={() => handleConceptClick(concept.rkey)}
                          className="block w-full text-left hover:text-neutral-100 transition-colors"
                        >
                          <div className="font-medium text-neutral-200">
                            {concept.name}
                            {concept.talk_count != null && concept.talk_count > 0 && (
                              <span className="text-neutral-600 font-normal ml-1.5">
                                ({concept.talk_count} {concept.talk_count === 1 ? "talk" : "talks"})
                              </span>
                            )}
                            {isLoading && (
                              <span className="text-neutral-600 font-normal ml-1.5">...</span>
                            )}
                          </div>
                          {concept.description && (
                            <div className="text-neutral-600 text-xs truncate">
                              {concept.description}
                            </div>
                          )}
                        </button>
                        {/* Expanded talk list */}
                        {isExpanded && conceptTalks.length > 0 && (
                          <div className="mt-0.5">
                            {conceptTalks.map((talk) => (
                              <div key={talk.rkey} className="pl-3 truncate text-neutral-500">
                                <button
                                  onClick={() => handleSelectTalk(talk.rkey)}
                                  className="hover:text-neutral-100 hover:underline underline-offset-2 transition-colors text-left"
                                >
                                  {talk.title}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        {isExpanded && conceptTalks.length === 0 && (
                          <div className="pl-3 text-neutral-600 text-xs italic">
                            No talks linked
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
            Click a concept to see related talks
          </div>
        )}
      </div>
    </div>
  );
}
