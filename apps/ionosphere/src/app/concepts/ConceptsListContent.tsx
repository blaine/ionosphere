"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { TimestampProvider, useTimestamp } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import TranscriptView from "@/app/components/TranscriptView";

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

interface ConceptInfo {
  rkey: string;
  name: string;
  description?: string;
  talkCount: number;
}

interface Cluster {
  id: string;
  label: string;
  description: string;
  concepts: ConceptInfo[];
}

export default function ConceptsListContent({ clusters }: { clusters: Cluster[] }) {
  const [selectedTalk, setSelectedTalk] = useState<{
    rkey: string; title: string; videoUri: string;
    offsetNs: number; document: any; seekToNs: number;
  } | null>(null);

  const [filter, setFilter] = useState("");
  const [expandedConcept, setExpandedConcept] = useState<string | null>(null);
  const [conceptTalks, setConceptTalks] = useState<Map<string, any[]>>(new Map());
  const [widePlayer, setWidePlayer] = useState(false);

  const filteredClusters = useMemo(() => {
    if (!filter) return clusters;
    const q = filter.toLowerCase();
    return clusters
      .map((cluster) => ({
        ...cluster,
        concepts: cluster.concepts.filter((c) =>
          c.name.toLowerCase().includes(q) ||
          (c.description || "").toLowerCase().includes(q) ||
          cluster.label.toLowerCase().includes(q)
        ),
      }))
      .filter((c) => c.concepts.length > 0);
  }, [clusters, filter]);

  const totalConcepts = useMemo(
    () => filteredClusters.reduce((sum, c) => sum + c.concepts.length, 0),
    [filteredClusters]
  );

  // Newspaper-style 3-column balancing
  const columns = useMemo(() => {
    const numCols = 3;
    const totalHeight = filteredClusters.reduce(
      (sum, c) => sum + 48 + c.concepts.length * 22 + 16, 0
    );
    const target = totalHeight / numCols;
    const cols: Cluster[][] = [];
    let col: Cluster[] = [];
    let h = 0;
    for (const cluster of filteredClusters) {
      col.push(cluster);
      h += 48 + cluster.concepts.length * 22 + 16;
      if (h >= target && cols.length < numCols - 1) {
        cols.push(col); col = []; h = 0;
      }
    }
    cols.push(col);
    return cols;
  }, [filteredClusters]);

  const handleConceptClick = useCallback(async (conceptRkey: string) => {
    if (expandedConcept === conceptRkey) { setExpandedConcept(null); return; }
    setExpandedConcept(conceptRkey);
    if (!conceptTalks.has(conceptRkey)) {
      try {
        const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
        const res = await fetch(`${API_BASE}/concepts/${conceptRkey}`);
        if (res.ok) {
          const { talks } = await res.json();
          setConceptTalks((prev) => new Map(prev).set(conceptRkey, talks));
        }
      } catch {}
    }
  }, [expandedConcept, conceptTalks]);

  const handleTalkClick = useCallback(async (rkey: string) => {
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
      const res = await fetch(`${API_BASE}/talks/${rkey}`);
      if (!res.ok) return;
      const { talk } = await res.json();
      const doc = talk.document ? JSON.parse(talk.document) : null;
      setSelectedTalk({
        rkey, title: talk.title, videoUri: talk.video_uri,
        offsetNs: talk.video_offset_ns || 0,
        document: doc?.facets?.length > 0 ? doc : null, seekToNs: 0,
      });
    } catch {}
  }, []);

  return (
    <div className="h-full flex">
      <div className="flex-1 min-w-0 overflow-y-auto p-4">
        <div className="flex items-center gap-3 mb-4 sticky top-0 z-10 bg-neutral-950 py-2 -mt-2">
          <h1 className="text-xl font-bold tracking-tight shrink-0">Concepts</h1>
          <div className="flex-1 max-w-sm">
            <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter concepts or topics..."
              className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500" />
          </div>
          <span className="text-sm text-neutral-500 shrink-0">
            {totalConcepts} concepts in {filteredClusters.length} topics
          </span>
        </div>

        <div className="flex gap-6 items-start">
          {columns.map((column, colIdx) => (
            <div key={colIdx} className="flex-1 min-w-0">
              {column.map((cluster) => (
                <div key={cluster.id} className="mb-5">
                  <h2 className="text-sm font-bold text-neutral-400 border-b border-neutral-800 pb-0.5 mb-1.5 uppercase tracking-wide">
                    {cluster.label}
                  </h2>
                  <p className="text-[11px] text-neutral-600 mb-2 leading-snug">{cluster.description}</p>
                  {cluster.concepts.map((concept) => (
                    <div key={concept.rkey} className="mb-0.5">
                      <button onClick={() => handleConceptClick(concept.rkey)}
                        className={`text-[13px] leading-[1.5] text-left w-full hover:text-neutral-100 transition-colors ${
                          expandedConcept === concept.rkey ? "text-neutral-100 font-medium" : "text-neutral-400"
                        }`}>
                        {concept.name}
                        {concept.talkCount > 0 && (
                          <span className="text-neutral-600 text-[11px] ml-1">({concept.talkCount})</span>
                        )}
                      </button>
                      {expandedConcept === concept.rkey && (
                        <div className="pl-3 mt-0.5 mb-1">
                          {conceptTalks.has(concept.rkey) ? (
                            (conceptTalks.get(concept.rkey) || []).map((talk: any) => (
                              <div key={talk.rkey} className="text-[12px] truncate">
                                <button onClick={() => handleTalkClick(talk.rkey)}
                                  className="text-neutral-500 hover:text-neutral-100 hover:underline underline-offset-2 transition-colors">
                                  {talk.title}
                                </button>
                              </div>
                            ))
                          ) : (
                            <span className="text-neutral-600 text-[11px]">loading...</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className={`${widePlayer ? "w-2/3" : "w-[400px]"} shrink-0 border-l border-neutral-800 flex flex-col transition-all`}>
        {selectedTalk ? (
          <TimestampProvider key={selectedTalk.rkey + selectedTalk.seekToNs}>
            <InitialSeek timestampNs={selectedTalk.seekToNs} />
            <div className="p-3 border-b border-neutral-800 text-sm font-medium flex items-center gap-2">
              <button
                onClick={() => setWidePlayer(!widePlayer)}
                className="text-neutral-500 hover:text-neutral-200 transition-colors shrink-0"
                title={widePlayer ? "Collapse player" : "Expand player"}
              >
                {widePlayer ? "→" : "←"}
              </button>
              <span className="truncate">{selectedTalk.title}</span>
            </div>
            <div className="shrink-0 aspect-video bg-black">
              <VideoPlayer videoUri={selectedTalk.videoUri} offsetNs={selectedTalk.offsetNs} />
            </div>
            {selectedTalk.document && (
              <div className="flex-1 min-h-0"><TranscriptView document={selectedTalk.document} /></div>
            )}
          </TimestampProvider>
        ) : (
          <div className="flex-1 flex items-center justify-center text-neutral-600 text-sm p-6 text-center">
            Click a concept to explore its talks
          </div>
        )}
      </div>
    </div>
  );
}
