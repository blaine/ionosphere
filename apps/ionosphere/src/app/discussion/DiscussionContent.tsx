"use client";

import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
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

interface DiscussionItem {
  uri: string;
  author_did: string;
  text: string;
  created_at: string;
  likes: number;
  reposts: number;
  replies: number;
  content_type: string | null;
  external_url: string | null;
  og_title: string | null;
  talk_rkey: string | null;
  mention_type: string | null;
  author_handle: string;
  author_display_name: string | null;
  author_avatar_url: string | null;
  talk_title: string | null;
}

interface Stats {
  totalPosts: number;
  blogCount: number;
  vodSiteCount: number;
  uniqueAuthors: number;
}

interface DiscussionData {
  posts: DiscussionItem[];
  blogs: DiscussionItem[];
  videos: DiscussionItem[];
  vodSites: string[];
  stats: Stats;
}

type FlowItem =
  | { type: "heading"; label: string }
  | { type: "item"; item: DiscussionItem }
  | { type: "stats"; stats: Stats }
  | { type: "vodDirectory"; sites: string[] };

type FilterKey = "all" | "posts" | "blogs" | "videos";

// --- Height estimation ---

function estimateItemHeight(item: FlowItem): number {
  if (item.type === "stats") return 70;
  if (item.type === "heading") return 28;
  if (item.type === "vodDirectory") return 80;
  // item
  return 58;
}

// --- Greedy column fill ---

interface FilledColumn {
  items: FlowItem[];
  endIndex: number;
  usedHeight: number;
  extraSpacing: number;
}

function fillColumn(flowItems: FlowItem[], startIndex: number, columnHeight: number): FilledColumn {
  const items: FlowItem[] = [];
  let used = 0;
  let i = startIndex;

  while (i < flowItems.length) {
    const h = estimateItemHeight(flowItems[i]);
    if (used + h > columnHeight && items.length > 0) break;
    items.push(flowItems[i]);
    used += h;
    i++;
  }

  const remaining = Math.max(0, columnHeight - used);
  const extraSpacing = items.length > 1 ? Math.min(remaining / (items.length - 1), 6) : 0;

  return { items, endIndex: i, usedHeight: used, extraSpacing };
}

// --- Mobile single-column with progressive rendering ---

const MobileDiscussion = React.forwardRef<HTMLDivElement, {
  flowItems: FlowItem[];
  renderItem: (item: FlowItem, extraMargin: number) => React.ReactNode;
}>(function MobileDiscussion({ flowItems, renderItem }, ref) {
  const BATCH = 200;
  const [visibleCount, setVisibleCount] = useState(BATCH);
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

// --- Section nav labels per filter ---

const SECTION_NAV: Record<FilterKey, { key: string; label: string }[]> = {
  all: [
    { key: "Top Posts", label: "T" },
    { key: "Recaps & Blog Posts", label: "R" },
    { key: "Videos & VOD Sites", label: "V" },
  ],
  posts: [{ key: "Top Posts", label: "T" }],
  blogs: [{ key: "Recaps & Blog Posts", label: "R" }],
  videos: [{ key: "Videos & VOD Sites", label: "V" }],
};

// --- Component ---

export default function DiscussionContent({ data }: { data: DiscussionData }) {
  const [filter, setFilter] = useState<FilterKey>("all");

  const [selectedTalk, setSelectedTalk] = useState<{
    rkey: string; title: string; videoUri: string;
    offsetNs: number; document: any; seekToNs: number;
    talkUri: string;
  } | null>(null);

  const [comments, setComments] = useState<CommentData[]>([]);
  const [widePlayer, setWidePlayer] = useState(false);
  const [showMobilePlayer, setShowMobilePlayer] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const [columnWidth, setColumnWidth] = useState(280);
  const [columnHeight, setColumnHeight] = useState(600);
  const [numCols, setNumCols] = useState(4);

  // Measure container
  const filterBarRef = useRef<HTMLDivElement>(null);
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
      const filterH = filterBarRef.current?.offsetHeight || 0;
      setColumnHeight(el.clientHeight - filterH - 20);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Build flow items from data based on filter
  const flowItems = useMemo(() => {
    const items: FlowItem[] = [];

    // Stats card at the beginning
    items.push({ type: "stats", stats: data.stats });

    if (filter === "all" || filter === "posts") {
      if (data.posts.length > 0) {
        items.push({ type: "heading", label: "Top Posts" });
        for (const post of data.posts) {
          items.push({ type: "item", item: post });
        }
      }
    }

    if (filter === "all" || filter === "blogs") {
      if (data.blogs.length > 0) {
        items.push({ type: "heading", label: "Recaps & Blog Posts" });
        for (const blog of data.blogs) {
          items.push({ type: "item", item: blog });
        }
      }
    }

    if (filter === "all" || filter === "videos") {
      if (data.videos.length > 0) {
        items.push({ type: "heading", label: "Videos & VOD Sites" });
        for (const video of data.videos) {
          items.push({ type: "item", item: video });
        }
      }
      if (data.vodSites.length > 0) {
        items.push({ type: "vodDirectory", sites: data.vodSites });
      }
    }

    return items;
  }, [data, filter]);

  // Section-to-index mapping
  const sectionToIndex = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < flowItems.length; i++) {
      const item = flowItems[i];
      if (item.type === "heading" && !map.has(item.label)) {
        map.set(item.label, i);
      }
    }
    return map;
  }, [flowItems]);

  // Start index for column fill
  const [startIndex, setStartIndex] = useState(0);

  // Reset on filter change
  useEffect(() => { setStartIndex(0); }, [filter]);

  // Greedy-fill columns
  const filled = useMemo(() => {
    if (numCols <= 1 || columnHeight <= 0) return [];
    const cols: FilledColumn[] = [];
    let idx = startIndex;
    for (let c = 0; c < numCols + 1; c++) {
      if (idx >= flowItems.length) {
        cols.push({ items: [], endIndex: idx, usedHeight: 0, extraSpacing: 0 });
      } else {
        const col = fillColumn(flowItems, idx, columnHeight);
        cols.push(col);
        idx = col.endIndex;
      }
    }
    return cols;
  }, [startIndex, numCols, columnHeight, flowItems]);

  const visibleFilled = filled.slice(0, numCols);

  // Current section for nav highlighting
  const currentSection = useMemo(() => {
    let section = "";
    for (let i = 0; i <= startIndex && i < flowItems.length; i++) {
      if (flowItems[i].type === "heading") section = (flowItems[i] as { type: "heading"; label: string }).label;
    }
    return section;
  }, [startIndex, flowItems]);

  // Scroll
  const canScrollForward = filled.length > 0 && filled[filled.length - 1].endIndex < flowItems.length;
  const canScrollBack = startIndex > 0;

  const scrollForward = useCallback(() => {
    if (visibleFilled.length > 0 && visibleFilled[0].endIndex < flowItems.length) {
      setStartIndex(visibleFilled[0].endIndex);
    }
  }, [visibleFilled, flowItems.length]);

  const scrollBack = useCallback(() => {
    if (startIndex <= 0) return;
    let idx = startIndex - 1;
    let used = 0;
    while (idx >= 0) {
      const h = estimateItemHeight(flowItems[idx]);
      if (used + h > columnHeight && used > 0) break;
      used += h;
      idx--;
    }
    setStartIndex(Math.max(0, idx + 1));
  }, [startIndex, flowItems, columnHeight]);

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
    async (rkey: string) => {
      try {
        const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
        const res = await fetch(`${API_BASE}/xrpc/tv.ionosphere.getTalk?rkey=${encodeURIComponent(rkey)}`);
        if (!res.ok) return;
        const { talk } = await res.json();
        const doc = talk.document ? JSON.parse(talk.document) : null;
        setSelectedTalk({
          rkey, title: talk.title, videoUri: talk.video_uri,
          offsetNs: talk.video_offset_ns || 0,
          document: doc?.facets?.length > 0 ? doc : null, seekToNs: 0,
          talkUri: talk.uri,
        });
        setShowMobilePlayer(true);
        fetchComments(rkey).then(setComments);
      } catch {}
    },
    []
  );

  const scrollToSection = useCallback((sectionLabel: string) => {
    if (numCols <= 1) {
      const el = document.getElementById(`section-${sectionLabel.replace(/\s+/g, "-")}`);
      if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
    } else {
      const idx = sectionToIndex.get(sectionLabel);
      if (idx !== undefined) setStartIndex(idx);
    }
  }, [sectionToIndex, numCols]);

  // Render a flow item
  const renderItem = (item: FlowItem, extraMargin: number) => {
    const style = extraMargin > 0 ? { marginBottom: extraMargin } : undefined;

    if (item.type === "stats") {
      return (
        <div key="stats" className="mb-2 p-2 rounded bg-neutral-900 border border-neutral-800 text-[11px] text-neutral-500" style={style}>
          <div className="flex gap-4 flex-wrap">
            <span>{item.stats.totalPosts.toLocaleString()} posts</span>
            <span>{item.stats.blogCount} recaps</span>
            <span>{item.stats.vodSiteCount} VOD sites</span>
            <span>{item.stats.uniqueAuthors} authors</span>
          </div>
        </div>
      );
    }

    if (item.type === "heading") {
      return (
        <h2 key={`h-${item.label}`} id={`section-${item.label.replace(/\s+/g, "-")}`}
          className="text-[13px] font-bold text-neutral-500 border-b border-neutral-800 pb-0.5 mb-1 mt-2 first:mt-0" style={style}>
          {item.label}
        </h2>
      );
    }

    if (item.type === "vodDirectory") {
      return (
        <div key="vod-dir" className="mb-2 flex flex-wrap gap-1.5" style={style}>
          {item.sites.map((site) => (
            <span key={site} className="text-[10px] px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400">
              {site}
            </span>
          ))}
        </div>
      );
    }

    // item
    const di = item.item;
    return (
      <div key={di.uri} className="mb-1.5 text-[12px] leading-[1.5]" style={style}>
        <div className="flex items-baseline gap-1">
          {di.author_avatar_url ? (
            <img src={di.author_avatar_url} alt="" className="w-3.5 h-3.5 rounded-full shrink-0 relative top-[2px]" />
          ) : (
            <div className="w-3.5 h-3.5 rounded-full bg-neutral-700 shrink-0 relative top-[2px]" />
          )}
          <span className="text-blue-400 text-[11px] truncate">{di.author_handle}</span>
          <span className="text-neutral-600 text-[10px] ml-auto shrink-0">{di.likes || 0}&#9825;</span>
        </div>
        <div className="text-neutral-400 pl-[18px] line-clamp-2 -mt-px">
          {di.og_title || di.text}
        </div>
        {(di.talk_rkey || di.external_url) && (
          <div className="pl-[18px] mt-0.5 flex gap-2 text-[10px]">
            {di.talk_rkey && (
              <button onClick={() => handleSelect(di.talk_rkey!)}
                className="text-neutral-500 hover:text-neutral-300 truncate">
                {di.talk_title || "Talk"} &rarr;
              </button>
            )}
            {di.external_url && (
              <a href={di.external_url} target="_blank" rel="noopener"
                className={di.content_type === "blog" ? "text-emerald-500" : di.content_type === "video" ? "text-purple-400" : "text-neutral-500"}>
                {(() => { try { return new URL(di.external_url).hostname; } catch { return "link"; } })()} &#8599;
              </a>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex">
      {/* Section nav */}
      <nav className="shrink-0 w-8 flex flex-col items-center justify-center gap-0 border-r border-neutral-800 py-1">
        {SECTION_NAV[filter].map((s) => (
          <button
            key={s.key}
            onClick={() => scrollToSection(s.key)}
            className={`text-[11px] leading-none transition-colors w-6 h-6 flex items-center justify-center ${
              s.key === currentSection ? "text-neutral-100 font-bold" : "text-neutral-500 hover:text-neutral-100"
            }`}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {/* Main area */}
      <div ref={containerRef} className={`flex-1 min-w-0 flex flex-col overflow-hidden px-4 pt-3 pb-2 ${showMobilePlayer ? "hidden md:flex" : ""}`}>
        {/* Filter bar */}
        <div ref={filterBarRef} className="flex items-center gap-2 mb-2 shrink-0">
          {([
            { key: "all" as FilterKey, label: "All" },
            { key: "posts" as FilterKey, label: "Top Posts" },
            { key: "blogs" as FilterKey, label: "Recaps & Blog Posts" },
            { key: "videos" as FilterKey, label: "Videos & VOD Sites" },
          ]).map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`text-xs px-3 py-1 rounded-full transition-colors ${
                filter === f.key ? "bg-blue-500/20 text-blue-300" : "text-neutral-500 hover:text-neutral-300"
              }`}>{f.label}</button>
          ))}
          <span className="text-sm text-neutral-500 ml-auto shrink-0">
            {data.stats.totalPosts.toLocaleString()} posts
          </span>
        </div>

        {/* Columns */}
        {numCols <= 1 ? (
          <MobileDiscussion ref={columnsRef} flowItems={flowItems} renderItem={renderItem} />
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
            Click a talk link to play
          </div>
        )}
      </div>
    </div>
  );
}
