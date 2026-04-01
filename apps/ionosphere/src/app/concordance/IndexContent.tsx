"use client";

import { useState, useMemo } from "react";
import { TimestampProvider } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import TranscriptView from "@/app/components/TranscriptView";

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

interface IndexContentProps {
  entries: IndexEntry[];
}

interface LetterGroup {
  letter: string;
  entries: IndexEntry[];
  estimatedLines: number;
}

/**
 * Balance letter groups across N columns using a greedy bin-packing approach.
 * Each group's estimated height (in lines) is used to minimize the max column height.
 *
 * TODO: Refine with Pretext measurement for precise text height calculation.
 */
function balanceColumns(groups: LetterGroup[], numColumns: number): LetterGroup[][] {
  const columns: LetterGroup[][] = Array.from({ length: numColumns }, () => []);
  const heights = new Array(numColumns).fill(0);

  for (const group of groups) {
    const minIdx = heights.indexOf(Math.min(...heights));
    columns[minIdx].push(group);
    heights[minIdx] += group.estimatedLines;
  }

  return columns;
}

export default function IndexContent({ entries }: IndexContentProps) {
  const [selectedTalk, setSelectedTalk] = useState<{
    rkey: string;
    title: string;
    videoUri: string;
    offsetNs: number;
    document: any;
  } | null>(null);

  // Group entries by first letter and estimate line counts
  const groups = useMemo(() => {
    const map = new Map<string, IndexEntry[]>();
    for (const entry of entries) {
      const letter = entry.word[0]?.toUpperCase() || "#";
      if (!map.has(letter)) map.set(letter, []);
      map.get(letter)!.push(entry);
    }
    const result: LetterGroup[] = [];
    for (const [letter, letterEntries] of [...map.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      // Each entry ~1 line, letter heading ~1.5 lines, bottom margin ~0.5 lines
      const estimatedLines = letterEntries.length + 2;
      result.push({ letter, entries: letterEntries, estimatedLines });
    }
    return result;
  }, [entries]);

  // Balance across 4 columns
  const columns = useMemo(() => balanceColumns(groups, 4), [groups]);

  async function handleSelect(rkey: string, _word: string, _timestampNs: number) {
    const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    const res = await fetch(`${API_BASE}/talks/${rkey}`);
    const { talk } = await res.json();
    const doc = talk.document ? JSON.parse(talk.document) : null;
    setSelectedTalk({
      rkey,
      title: talk.title,
      videoUri: talk.video_uri,
      offsetNs: talk.video_offset_ns || 0,
      document: doc?.facets?.length > 0 ? doc : null,
    });
  }

  return (
    <div className="h-full flex">
      {/* Left: multi-column word index */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4">
        <h1 className="text-xl font-bold mb-4">Word Index</h1>
        <div className="flex gap-6">
          {columns.map((column, colIdx) => (
            <div key={colIdx} className="flex-1 min-w-0">
              {column.map((group) => (
                <div key={group.letter} className="mb-4">
                  <h2 className="text-lg font-bold text-neutral-500 mb-1">
                    {group.letter}
                  </h2>
                  {group.entries.map((entry) => (
                    <div key={entry.word} className="text-sm leading-relaxed">
                      <span className="font-medium text-neutral-200">
                        {entry.word}
                      </span>
                      <span className="text-neutral-600"> &mdash; </span>
                      {entry.talks.slice(0, 5).map((talk, i) => (
                        <span key={talk.rkey}>
                          {i > 0 && (
                            <span className="text-neutral-700">, </span>
                          )}
                          <button
                            onClick={() =>
                              handleSelect(
                                talk.rkey,
                                entry.word,
                                talk.firstTimestampNs
                              )
                            }
                            className="text-neutral-400 hover:text-neutral-100 hover:underline underline-offset-2"
                          >
                            {talk.title}
                          </button>
                          {talk.count > 1 && (
                            <span className="text-neutral-600">
                              {" "}
                              ({talk.count})
                            </span>
                          )}
                        </span>
                      ))}
                      {entry.talks.length > 5 && (
                        <span className="text-neutral-600">
                          {" "}
                          +{entry.talks.length - 5} more
                        </span>
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
          <TimestampProvider>
            <div className="p-3 border-b border-neutral-800 text-sm font-medium truncate">
              {selectedTalk.title}
            </div>
            <div className="shrink-0">
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
            Click a word reference to play the talk
          </div>
        )}
      </div>
    </div>
  );
}
