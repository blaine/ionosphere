"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import { TimestampProvider } from "@/app/components/TimestampProvider";
import VideoPlayer from "@/app/components/VideoPlayer";
import TranscriptView from "@/app/components/TranscriptView";

interface TalkContentProps {
  talk: any;
  speakers: any[];
  concepts: any[];
}

export default function TalkContent({ talk, speakers, concepts }: TalkContentProps) {
  const durationMin = talk.duration ? (talk.duration / 1e9 / 60).toFixed(0) : null;
  const document = useMemo(() => {
    if (!talk.document) return null;
    const doc = JSON.parse(talk.document);
    return doc?.facets?.length > 0 ? doc : null;
  }, [talk.document]);

  const videoContainerRef = useRef<HTMLDivElement>(null);
  const [videoWidth, setVideoWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = videoContainerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      // Find the actual video element and measure its rendered width
      const video = el.querySelector("video");
      if (video && video.offsetWidth > 0) {
        setVideoWidth(video.offsetWidth);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
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

          {/* Video — top half */}
          {talk.video_uri && (
            <div ref={videoContainerRef} className="h-1/2 px-4 pt-2 lg:pt-4 pb-1 overflow-hidden flex items-center justify-center">
              <VideoPlayer videoUri={talk.video_uri} offsetNs={talk.video_offset_ns || 0} />
            </div>
          )}

          {/* Transcript — bottom half, width pinned to video */}
          <div className="h-1/2 px-4 pb-4 pt-1 flex justify-center">
            <div style={videoWidth ? { width: videoWidth } : undefined} className={`h-full ${videoWidth ? "" : "w-full"}`}>
              {document ? (
                <TranscriptView document={document} />
              ) : (
                <div className="h-full flex items-center justify-center text-neutral-500 text-sm border border-neutral-800 rounded-lg">
                  {talk.video_uri ? "Transcript not yet available." : "No recording available for this talk."}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right sidebar — concepts + cross-refs (hidden on mobile, scrollable on desktop) */}
        <aside className="hidden lg:flex lg:flex-col lg:w-56 xl:w-64 shrink-0 border-l border-neutral-800 overflow-y-auto p-4 gap-5">
          {concepts.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-2">Concepts</h2>
              <div className="flex flex-wrap gap-1.5">
                {concepts.map((c: any) => (
                  <a
                    key={c.rkey}
                    href={`/concepts/${c.rkey}`}
                    className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300/80 hover:bg-amber-500/20 hover:text-amber-200 transition-colors"
                  >
                    {c.name}
                  </a>
                ))}
              </div>
            </section>
          )}

          {/* Mobile speakers (shown below transcript on small screens) */}
          <section className="lg:hidden">
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
