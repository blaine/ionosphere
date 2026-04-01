"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
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

      // If already enough data, seek now
      if (video.readyState >= 2) {
        doSeekAndPlay();
        return;
      }

      // Otherwise wait for loadeddata (HLS has buffered enough to seek)
      video.addEventListener("loadeddata", doSeekAndPlay, { once: true });
      // Also try on canplay as backup
      video.addEventListener("canplay", doSeekAndPlay, { once: true });
      // Force play attempt even before seek (gets HLS buffering)
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

  const [filter, setFilter] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [widePlayer, setWidePlayer] = useState(false);
  const [showMobilePlayer, setShowMobilePlayer] = useState(false);

  // Filter entries by search term (plain text or regex)
  const filteredEntries = useMemo(() => {
    if (!filter) return entries;
    try {
      const pattern = isRegex ? new RegExp(filter, "i") : null;
      return entries.filter((e) =>
        pattern ? pattern.test(e.term) : e.term.toLowerCase().includes(filter.toLowerCase())
      );
    } catch {
      // Invalid regex — treat as plain text
      return entries.filter((e) =>
        e.term.toLowerCase().includes(filter.toLowerCase())
      );
    }
  }, [entries, filter, isRegex]);

  // All letters present in the full (unfiltered) entries for the nav
  const allLetters = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      const l = e.term[0]?.toUpperCase();
      if (l && /[A-Z]/.test(l)) set.add(l);
    }
    return [...set].sort();
  }, [entries]);

  // Group filtered entries by first letter
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

  const handleSelect = useCallback(
    async (rkey: string, _word: string, timestampNs: number) => {
      try {
        const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
        console.log("[Index] fetching talk", rkey);
        const res = await fetch(`${API_BASE}/talks/${rkey}`);
        if (!res.ok) {
          console.error("[Index] fetch failed:", res.status);
          return;
        }
        const { talk } = await res.json();
        console.log("[Index] loaded talk:", talk.title, "video:", !!talk.video_uri);
        const doc = talk.document ? JSON.parse(talk.document) : null;
        setSelectedTalk({
          rkey,
          title: talk.title,
          videoUri: talk.video_uri,
          offsetNs: talk.video_offset_ns || 0,
          document: doc?.facets?.length > 0 ? doc : null,
          seekToNs: timestampNs,
        });
        setShowMobilePlayer(true);
      } catch (err) {
        console.error("[Index] handleSelect error:", err);
      }
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
      {/* Letter nav — vertical strip on the left edge */}
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

      {/* Main: search + multi-column word index */}
      <div className={`flex-1 min-w-0 overflow-y-auto p-4 ${showMobilePlayer ? "hidden md:block" : ""}`}>
        {/* Search bar — sticky */}
        <div className="flex items-center gap-3 mb-4 sticky top-0 z-10 bg-neutral-950 py-2 -mt-2">
          <h1 className="text-xl font-bold tracking-tight shrink-0">Word Index</h1>
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
            >
              .*
            </button>
          </div>
          <span className="text-sm text-neutral-500 shrink-0">
            {filteredEntries.length.toLocaleString()} terms
          </span>
        </div>
        <div style={{ columnWidth: "280px", columnGap: "1.5rem" }}>
          {groups.map((group) => (
            <div key={group.letter} className="break-inside-avoid mb-4">
              <h2 id={`letter-${group.letter}`} className="text-base font-bold text-neutral-500 border-b border-neutral-800 pb-0.5 mb-1">
                {group.letter}
              </h2>
                  {group.entries.map((entry) => {
                    // "see"-only entry: compact redirect
                    const isSeeOnly = entry.see?.length > 0 && entry.talks.length === 0 && !entry.subentries?.length;
                    if (isSeeOnly) {
                      return (
                        <div key={entry.term} id={`term-${entry.term.toLowerCase().replace(/[^a-z0-9]/g, "-")}`} className="text-[13px] leading-[1.6] mb-1">
                          <span className="text-neutral-400">{entry.term}</span>
                          <span className="text-neutral-600 italic"> — see{" "}
                            {entry.see.map((ref, i) => (
                              <span key={ref}>
                                {i > 0 && ", "}
                                <button onClick={() => scrollToTerm(ref)} className="hover:text-neutral-300 underline underline-offset-2">{ref}</button>
                              </span>
                            ))}
                          </span>
                        </div>
                      );
                    }

                    return (
                      <div key={entry.term} id={`term-${entry.term.toLowerCase().replace(/[^a-z0-9]/g, "-")}`} className="text-[13px] leading-[1.6] mb-2">
                        <div className="font-medium text-neutral-200">
                          {entry.term}
                        </div>
                        {/* Direct talk refs */}
                        {entry.talks.slice(0, 5).map((talk) => (
                          <div
                            key={talk.rkey}
                            className="truncate text-neutral-500 pl-3"
                            style={{ maxWidth: "100%" }}
                          >
                            <button
                              onClick={() =>
                                handleSelect(talk.rkey, entry.term, talk.firstTimestampNs)
                              }
                              className="hover:text-neutral-100 hover:underline underline-offset-2 transition-colors text-left"
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
                        {/* Subentries */}
                        {entry.subentries?.map((sub) => (
                          <div key={sub.label} className="pl-3">
                            <span className="text-neutral-400 italic text-xs">{sub.label}</span>
                            {sub.talks.map((talk) => (
                              <div
                                key={talk.rkey}
                                className="truncate text-neutral-500 pl-3"
                                style={{ maxWidth: "100%" }}
                              >
                                <button
                                  onClick={() =>
                                    handleSelect(talk.rkey, entry.term, talk.firstTimestampNs)
                                  }
                                  className="hover:text-neutral-100 hover:underline underline-offset-2 transition-colors text-left"
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
                          </div>
                        ))}
                        {/* See references */}
                        {entry.see?.length > 0 && (
                          <div className="text-neutral-600 italic pl-3">
                            see{" "}
                            {entry.see.map((ref, i) => (
                              <span key={ref}>
                                {i > 0 && ", "}
                                <button onClick={() => scrollToTerm(ref)} className="hover:text-neutral-300 underline underline-offset-2">{ref}</button>
                              </span>
                            ))}
                          </div>
                        )}
                        {/* See also */}
                        {entry.seeAlso?.length > 0 && (
                          <div className="text-neutral-600 text-xs pl-3">
                            see also:{" "}
                            {entry.seeAlso.map((ref, i) => (
                              <span key={ref}>
                                {i > 0 && ", "}
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
      </div>

      {/* Right: player panel */}
      <div className={`${widePlayer ? "w-2/3" : "w-[400px]"} shrink-0 border-l border-neutral-800 flex flex-col transition-all
        ${showMobilePlayer ? "!w-full" : "hidden md:flex"}
        ${!selectedTalk && !showMobilePlayer ? "hidden md:flex" : ""}`}>
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
              <span className="truncate">{selectedTalk.title}</span>
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
