"use client";

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { TimestampProvider, useTimestamp } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import TranscriptView from "@/app/components/TranscriptView";
import { fetchComments, type CommentData } from "@/lib/comments";
import ReactionBar from "@/app/components/ReactionBar";
import MentionsSidebar from "@/app/components/MentionsSidebar";

function ConceptSidebar({ concepts }: { concepts: Array<{ rkey: string; name: string; timeNs?: number }> }) {
  const { seekTo } = useTimestamp();
  return (
    <section>
      <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-2">Concepts</h2>
      <div className="flex flex-wrap gap-1.5">
        {concepts.map((c) => (
          <button
            key={c.rkey}
            onClick={() => c.timeNs ? seekTo(c.timeNs) : undefined}
            className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300/80 hover:bg-amber-500/20 hover:text-amber-200 transition-colors cursor-pointer"
            title={c.timeNs ? `Jump to ${Math.floor(c.timeNs / 1e9 / 60)}:${String(Math.floor((c.timeNs / 1e9) % 60)).padStart(2, "0")}` : c.name}
          >
            {c.name}
          </button>
        ))}
      </div>
    </section>
  );
}

interface TalkContentProps {
  talk: any;
  speakers: any[];
  concepts: any[];
  mentions: any[];
}

interface VideoSource {
  uri: string;
  offsetNs: number;
  type: string;
  stream?: string;
  confidence?: string;
}

export default function TalkContent({ talk, speakers, concepts, mentions }: TalkContentProps) {
  const [comments, setComments] = useState<CommentData[]>([]);
  const [sidebarTab, setSidebarTab] = useState<"concepts" | "mentions">(mentions.length > 0 ? "mentions" : "concepts");

  // Parse video sources
  const videoSources: VideoSource[] = useMemo(() => {
    const sources: VideoSource[] = [];
    if (talk.video_segments) {
      try {
        const parsed = JSON.parse(talk.video_segments);
        if (Array.isArray(parsed)) sources.push(...parsed);
      } catch {}
    }
    // If no sources from segments, use the primary video_uri
    if (sources.length === 0 && talk.video_uri) {
      sources.push({ uri: talk.video_uri, offsetNs: talk.video_offset_ns || 0, type: "individual" });
    }
    return sources;
  }, [talk.video_segments, talk.video_uri, talk.video_offset_ns]);

  const [activeSourceIdx, setActiveSourceIdx] = useState(0);
  const activeSource = videoSources[activeSourceIdx] || (talk.video_uri ? { uri: talk.video_uri, offsetNs: talk.video_offset_ns || 0, type: "primary" } : null);

  useEffect(() => {
    fetchComments(talk.rkey).then(setComments);
  }, [talk.rkey]);

  const handleCommentPublished = useCallback(() => {
    fetchComments(talk.rkey).then(setComments);
  }, [talk.rkey]);

  const durationMin = talk.duration ? (talk.duration / 1e9 / 60).toFixed(0) : null;
  const document = useMemo(() => {
    if (!talk.document) return null;
    const doc = typeof talk.document === "string" ? JSON.parse(talk.document) : talk.document;
    return doc?.facets?.length > 0 ? doc : null;
  }, [talk.document]);

  // Derive concepts from document facets (concept-ref entities)
  // For each concept, find the timestamp of its first mention
  const docConcepts = useMemo(() => {
    if (!document) return [];

    // Build a byte→time lookup from timestamp facets
    const byteToTime: Array<{ byteStart: number; byteEnd: number; startTime: number }> = [];
    for (const f of document.facets) {
      for (const feat of f.features) {
        if (feat.$type === "tv.ionosphere.facet#timestamp" && feat.startTime != null) {
          byteToTime.push({ byteStart: f.index.byteStart, byteEnd: f.index.byteEnd, startTime: feat.startTime });
        }
      }
    }

    const seen = new Map<string, { name: string; uri: string; rkey: string; timeNs: number }>();
    for (const f of document.facets) {
      for (const feat of f.features) {
        if (feat.$type === "tv.ionosphere.facet#concept-ref" && feat.conceptUri) {
          if (!seen.has(feat.conceptUri)) {
            const rkey = feat.conceptUri.split("/").pop() || "";
            // Find the nearest timestamp facet overlapping this byte range
            let timeNs = 0;
            for (const ts of byteToTime) {
              if (ts.byteStart < f.index.byteEnd && ts.byteEnd > f.index.byteStart) {
                timeNs = ts.startTime;
                break;
              }
            }
            seen.set(feat.conceptUri, {
              name: feat.conceptName || feat.label || rkey,
              uri: feat.conceptUri,
              rkey,
              timeNs,
            });
          }
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [document]);

  const videoContainerRef = useRef<HTMLDivElement>(null);
  const [videoWidth, setVideoWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = videoContainerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      const video = el.querySelector("video");
      if (video && video.offsetWidth > 0) {
        setVideoWidth(video.offsetWidth);
      }
    });

    // Observe both the container and the video element (once it exists)
    observer.observe(el);

    // The video element may not exist yet (HLS loading), so poll briefly
    const checkVideo = setInterval(() => {
      const video = el.querySelector("video");
      if (video) {
        observer.observe(video);
        if (video.offsetWidth > 0) {
          setVideoWidth(video.offsetWidth);
        }
        clearInterval(checkVideo);
      }
    }, 200);

    return () => {
      observer.disconnect();
      clearInterval(checkVideo);
    };
  }, []);

  return (
    <TimestampProvider>
      {/* Mobile: single column scrolling. Desktop: three fixed columns */}
      <div className="h-full flex flex-col lg:flex-row">

        {/* Left sidebar — talk info (hidden on mobile, scrollable on desktop) */}
        <aside className="hidden lg:flex lg:flex-col lg:w-64 xl:w-72 shrink-0 border-r border-neutral-800 overflow-y-auto p-4 gap-5">
          <div>
            <h1 className="text-lg font-bold leading-tight">{talk.title}</h1>
            <div className="text-sm text-neutral-400 mt-1">
              {durationMin && <>{durationMin} min</>}
              {talk.room && <> &middot; {talk.room}</>}
              {talk.talk_type && <> &middot; {talk.talk_type}</>}
            </div>
          </div>

          {talk.description && (
            <section>
              <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-1">About</h2>
              <p className="text-sm text-neutral-300 leading-relaxed">{talk.description}</p>
            </section>
          )}

          <section>
            <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-1">Speakers</h2>
            {speakers.map((s: any) => (
              <a key={s.rkey} href={`/speakers/${s.rkey}`} className="block text-sm text-neutral-200 hover:text-white">
                {s.name}
                {s.handle && <span className="text-neutral-500 ml-1">@{s.handle}</span>}
              </a>
            ))}
          </section>

          {talk.category && (
            <section>
              <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-1">Category</h2>
              <span className="text-sm text-neutral-300">{talk.category}</span>
            </section>
          )}
        </aside>

        {/* Center — video + transcript */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Mobile: show title above video */}
          <div className="lg:hidden px-4 pt-3 pb-2">
            <h1 className="text-lg font-bold leading-tight">{talk.title}</h1>
            <div className="text-xs text-neutral-400 mt-0.5">
              {speakers.map((s: any) => s.name).join(", ")}
              {durationMin && <> &middot; {durationMin} min</>}
            </div>
          </div>

          {/* Video — shrink to fit, max 45% of viewport */}
          {activeSource && (
            <div ref={videoContainerRef} className="shrink-0 px-4 pt-2 lg:pt-4 pb-1 flex flex-col items-center" style={{ maxHeight: "45vh" }}>
              <div className="w-full max-h-full flex items-center justify-center overflow-hidden">
                <VideoPlayer key={`${activeSource.uri}-${activeSource.offsetNs}`} videoUri={activeSource.uri} offsetNs={activeSource.offsetNs} />
              </div>
              {videoSources.length > 1 && (
                <div className="flex gap-1 mt-1 shrink-0">
                  {videoSources.map((src, i) => (
                    <button
                      key={i}
                      onClick={() => setActiveSourceIdx(i)}
                      className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                        i === activeSourceIdx
                          ? "bg-neutral-700 text-neutral-200"
                          : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800"
                      }`}
                    >
                      {src.type === "individual" ? "Talk" : src.stream?.replace(/ - Day \d/, "") || "Full stream"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Whole-talk reaction bar */}
          <ReactionBar
            subjectUri={talk.uri}
            comments={comments}
            onCommentPublished={handleCommentPublished}
          />

          {/* Transcript — fills remaining space, width pinned to video */}
          <div className="flex-1 min-h-0 px-4 pb-4 pt-1 flex justify-center">
            <div style={videoWidth ? { width: videoWidth } : undefined} className={`h-full ${videoWidth ? "" : "w-full"}`}>
              {document ? (
                <TranscriptView document={document} transcriptUri={talk.uri} comments={comments} onCommentPublished={handleCommentPublished} />
              ) : (
                <div className="h-full flex items-center justify-center text-neutral-500 text-sm border border-neutral-800 rounded-lg">
                  {activeSource ? "Transcript not yet available." : "No recording available for this talk."}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right sidebar — tabbed concepts/mentions (hidden on mobile, scrollable on desktop) */}
        <aside className="hidden lg:flex lg:flex-col lg:w-56 xl:w-64 shrink-0 border-l border-neutral-800 overflow-hidden">
          {/* Tab bar */}
          <div className="flex border-b border-neutral-800 shrink-0">
            <button
              onClick={() => setSidebarTab("concepts")}
              className={`flex-1 text-[10px] font-semibold uppercase tracking-wide py-2 transition-colors ${
                sidebarTab === "concepts"
                  ? "text-amber-400 border-b-2 border-amber-400"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              Concepts ({(concepts.length > 0 ? concepts : docConcepts).length})
            </button>
            <button
              onClick={() => setSidebarTab("mentions")}
              className={`flex-1 text-[10px] font-semibold uppercase tracking-wide py-2 transition-colors ${
                sidebarTab === "mentions"
                  ? "text-blue-400 border-b-2 border-blue-400"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              Mentions ({mentions.length})
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-4">
            {sidebarTab === "concepts" && (
              <ConceptSidebar concepts={concepts.length > 0 ? concepts : docConcepts} />
            )}
            {sidebarTab === "mentions" && (
              <MentionsSidebar mentions={mentions} words={[]} />
            )}
          </div>

          {/* Mobile speakers (shown below transcript on small screens) */}
          <section className="lg:hidden p-4">
            <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-1">Speakers</h2>
            {speakers.map((s: any) => (
              <a key={s.rkey} href={`/speakers/${s.rkey}`} className="block text-sm text-neutral-200 hover:text-white">
                {s.name}
              </a>
            ))}
          </section>
        </aside>
      </div>
    </TimestampProvider>
  );
}
