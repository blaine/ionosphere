"use client";

import { useRef, useEffect, useMemo, useCallback, useState, forwardRef } from "react";
import { prepareWithSegments, layoutWithLines, type PreparedTextWithSegments, type LayoutLinesResult } from "@chenglou/pretext";
import { useTimestamp } from "./TimestampProvider";
import {
  extractData,
  brightnessAtTime,
  toColor,
  type TranscriptDocument,
  type WordSpan,
  type ConceptSpan,
} from "@/lib/transcript";

/**
 * Windowed transcript view for large transcripts (full-day streams).
 *
 * Uses Pretext to compute the full text layout without rendering,
 * giving us accurate scroll-offset ↔ timecode mapping. Only words
 * in the visible viewport + buffer are mounted in the DOM.
 */

interface WindowedTranscriptViewProps {
  document: TranscriptDocument;
}

// --- Word rendering (simplified from TranscriptView, no comments/reactions) ---

const WordSpanComponent = forwardRef<
  HTMLSpanElement,
  {
    word: WordSpan;
    concept: ConceptSpan | null;
    currentTimeNs: number;
    onSeek: (ns: number) => void;
  }
>(function WordSpanComponent({ word, concept, currentTimeNs, onSeek }, ref) {
  const startB = brightnessAtTime(currentTimeNs, word.boundaryStartTime);
  const endB = brightnessAtTime(currentTimeNs, word.boundaryEndTime);
  const startColor = toColor(startB, concept);
  const endColor = toColor(endB, concept);

  const style: React.CSSProperties = {
    backgroundImage: `linear-gradient(to right, ${startColor}, ${endColor} calc(100% - 0.35em), ${endColor})`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    WebkitTextFillColor: "transparent",
  };

  return (
    <span
      ref={ref}
      onClick={() => onSeek(word.startTime)}
      className={`cursor-pointer${concept ? " underline decoration-amber-500/30 underline-offset-2" : ""}`}
      style={style}
      title={concept ? concept.conceptName : undefined}
    >
      {word.text}{" "}
    </span>
  );
});

// --- Line-to-time mapping built from Pretext layout ---

interface LineTimeEntry {
  lineIndex: number;
  yTop: number;      // px from top of text
  yBottom: number;    // px from top of text
  timeStart: number;  // ns
  timeEnd: number;    // ns
  wordStartIdx: number;
  wordEndIdx: number; // exclusive
}

function buildLineTimeMap(
  layoutResult: LayoutLinesResult,
  words: WordSpan[],
  fullText: string,
  lineHeight: number,
): LineTimeEntry[] {
  const entries: LineTimeEntry[] = [];
  if (words.length === 0 || layoutResult.lines.length === 0) return entries;

  // Map character offset in fullText to word index.
  // Each word occupies its text + a trailing space in fullText.
  // Build a sorted array of { charStart, wordIdx } for binary search.
  const wordCharStarts: number[] = [];
  let charPos = 0;
  for (let i = 0; i < words.length; i++) {
    wordCharStarts.push(charPos);
    charPos += words[i].text.length + 1; // +1 for trailing space
  }

  function charOffsetToWordIdx(charOffset: number): number {
    // Binary search for the word containing this character offset
    let lo = 0, hi = wordCharStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (wordCharStarts[mid] <= charOffset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  for (let i = 0; i < layoutResult.lines.length; i++) {
    const line = layoutResult.lines[i];
    // line.start and line.end are LayoutCursors with segmentIndex and graphemeIndex.
    // Since we prepared with a single segment (the full text), segmentIndex is always 0.
    const startChar = line.start.graphemeIndex;
    const endChar = line.end.graphemeIndex;

    const startWordIdx = charOffsetToWordIdx(startChar);
    const endWordIdx = Math.min(charOffsetToWordIdx(Math.max(0, endChar - 1)) + 1, words.length);

    if (startWordIdx >= words.length) continue;

    const timeStart = words[startWordIdx].startTime;
    const timeEnd = words[Math.min(endWordIdx - 1, words.length - 1)].endTime;

    entries.push({
      lineIndex: i,
      yTop: i * lineHeight,
      yBottom: (i + 1) * lineHeight,
      timeStart,
      timeEnd,
      wordStartIdx: startWordIdx,
      wordEndIdx: endWordIdx,
    });
  }

  return entries;
}

// --- Main component ---

const LINE_HEIGHT = 28; // px — matches leading-relaxed at ~16px font
const VIEWPORT_BUFFER = 600; // px of buffer above and below viewport

export default function WindowedTranscriptView({ document }: WindowedTranscriptViewProps) {
  const { currentTimeNs, seekTo, paused } = useTimestamp();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(600);

  // Extract words and concepts
  const { words, wordConcepts } = useMemo(() => extractData(document), [document]);

  // Build the plain text (words joined by spaces) for Pretext
  const fullText = useMemo(() => words.map((w) => w.text).join(" "), [words]);

  // Measure container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width - 32); // subtract padding
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Pretext layout: compute line breaks and positions for the full text.
  // Runs client-side only (Pretext needs canvas for font measurement).
  // Recomputes when container width changes.
  const [layoutState, setLayoutState] = useState<{
    layoutResult: LayoutLinesResult | null;
    lineTimeMap: LineTimeEntry[];
    forWidth: number;
  }>({ layoutResult: null, lineTimeMap: [], forWidth: 0 });

  useEffect(() => {
    if (words.length === 0 || containerWidth < 100) return;
    // Skip if we already computed for this width
    if (layoutState.forWidth === containerWidth && layoutState.layoutResult) return;

    try {
      const font = "16px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      const prepared = prepareWithSegments(fullText, font);
      const result = layoutWithLines(prepared, containerWidth, LINE_HEIGHT);
      const map = buildLineTimeMap(result, words, fullText, LINE_HEIGHT);
      setLayoutState({ layoutResult: result, lineTimeMap: map, forWidth: containerWidth });
    } catch (err) {
      console.error("Pretext layout failed:", err);
    }
  }, [fullText, words, containerWidth]);

  const { layoutResult, lineTimeMap } = layoutState;
  const totalHeight = layoutResult ? layoutResult.height : 0;

  // --- Time ↔ scroll position mapping ---

  const timeToScrollY = useCallback(
    (timeNs: number): number => {
      if (lineTimeMap.length === 0) return 0;
      // Binary search for the line containing this time
      let lo = 0, hi = lineTimeMap.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineTimeMap[mid].timeStart <= timeNs) lo = mid;
        else hi = mid - 1;
      }
      const entry = lineTimeMap[lo];
      // Interpolate within the line
      const frac = entry.timeEnd > entry.timeStart
        ? (timeNs - entry.timeStart) / (entry.timeEnd - entry.timeStart)
        : 0;
      return entry.yTop + frac * (entry.yBottom - entry.yTop);
    },
    [lineTimeMap],
  );

  const scrollYToTime = useCallback(
    (y: number): number => {
      if (lineTimeMap.length === 0) return 0;
      // Binary search for the line at this Y position
      let lo = 0, hi = lineTimeMap.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineTimeMap[mid].yTop <= y) lo = mid;
        else hi = mid - 1;
      }
      const entry = lineTimeMap[lo];
      const frac = entry.yBottom > entry.yTop
        ? (y - entry.yTop) / (entry.yBottom - entry.yTop)
        : 0;
      return entry.timeStart + frac * (entry.timeEnd - entry.timeStart);
    },
    [lineTimeMap],
  );

  // --- Determine which words to render based on scroll position ---

  const [scrollTop, setScrollTop] = useState(0);
  const userScrolling = useRef(false);
  const userScrollTimer = useRef<ReturnType<typeof setTimeout>>();

  // The playhead is at 33% of the viewport
  const playheadFrac = 0.33;

  // Auto-scroll: position the playhead time at 33% of the container
  const scrollTargetRef = useRef<number | null>(null);
  const animFrameRef = useRef(0);

  useEffect(() => {
    if (userScrolling.current || !containerRef.current) return;
    const viewportH = containerRef.current.clientHeight;
    const playheadOffset = viewportH * playheadFrac;
    const textY = timeToScrollY(currentTimeNs);
    scrollTargetRef.current = textY - playheadOffset;
  }, [currentTimeNs, timeToScrollY]);

  // Smooth scroll animation
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const animate = () => {
      if (!userScrolling.current && scrollTargetRef.current !== null) {
        const diff = scrollTargetRef.current - container.scrollTop;
        if (Math.abs(diff) > 0.5) {
          container.scrollTop += diff * 0.15;
        }
      }
      setScrollTop(container.scrollTop);
      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  // Scroll-to-scrub: user scrolling seeks the video
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let userInitiated = false;
    const onWheel = () => { userInitiated = true; };
    const onTouchMove = () => { userInitiated = true; };

    const onScroll = () => {
      if (!userInitiated) return;
      userScrolling.current = true;
      clearTimeout(userScrollTimer.current);
      userScrollTimer.current = setTimeout(() => {
        userScrolling.current = false;
      }, paused ? 999999 : 2000);

      const viewportH = container.clientHeight;
      const playheadY = container.scrollTop + viewportH * playheadFrac;
      const timeNs = scrollYToTime(playheadY);
      seekTo(timeNs);
      userInitiated = false;
    };

    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("scroll", onScroll);
      clearTimeout(userScrollTimer.current);
    };
  }, [seekTo, paused, scrollYToTime]);

  // Compute visible word range from scroll position
  const { visibleStartIdx, visibleEndIdx } = useMemo(() => {
    if (lineTimeMap.length === 0) return { visibleStartIdx: 0, visibleEndIdx: 0 };
    const container = containerRef.current;
    const viewportH = container?.clientHeight ?? 600;

    const viewTop = scrollTop - VIEWPORT_BUFFER;
    const viewBottom = scrollTop + viewportH + VIEWPORT_BUFFER;

    // Find first visible line
    let startLine = 0;
    for (let i = 0; i < lineTimeMap.length; i++) {
      if (lineTimeMap[i].yBottom >= viewTop) { startLine = i; break; }
    }
    // Find last visible line
    let endLine = lineTimeMap.length - 1;
    for (let i = lineTimeMap.length - 1; i >= 0; i--) {
      if (lineTimeMap[i].yTop <= viewBottom) { endLine = i; break; }
    }

    return {
      visibleStartIdx: lineTimeMap[startLine]?.wordStartIdx ?? 0,
      visibleEndIdx: lineTimeMap[endLine]?.wordEndIdx ?? 0,
    };
  }, [scrollTop, lineTimeMap]);

  // Compute the Y offset for the first visible word
  const topSpacerHeight = useMemo(() => {
    if (lineTimeMap.length === 0 || visibleStartIdx === 0) return 0;
    // Find the line containing visibleStartIdx
    for (const entry of lineTimeMap) {
      if (entry.wordStartIdx <= visibleStartIdx && entry.wordEndIdx > visibleStartIdx) {
        return entry.yTop;
      }
    }
    return 0;
  }, [lineTimeMap, visibleStartIdx]);

  const handleSeek = useCallback((ns: number) => seekTo(ns), [seekTo]);

  return (
    <div
      ref={containerRef}
      className="relative h-full overflow-y-auto leading-relaxed"
      style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "16px" }}
    >
      {/* Playhead indicator at 33% */}
      <div
        className="pointer-events-none sticky z-10 -mx-4"
        style={{ top: "33%" }}
      >
        <div className="h-[10px] -mt-[5px]" style={{
          background: "linear-gradient(to bottom, transparent, rgba(255,255,255,0.03) 30%, rgba(255,255,255,0.06) 50%, rgba(255,255,255,0.03) 70%, transparent)"
        }} />
        <div className="h-px -mt-[5px]" style={{
          background: "linear-gradient(to right, rgba(255,255,255,0.35), rgba(255,255,255,0.35) 10px, rgba(255,255,255,0.1) 10px, rgba(255,255,255,0.1) calc(100% - 10px), rgba(255,255,255,0.35) calc(100% - 10px), rgba(255,255,255,0.35))"
        }} />
      </div>

      {/* Total scrollable area */}
      {!layoutResult && (
        <div className="flex items-center justify-center h-32 text-neutral-500 text-sm">
          Computing layout...
        </div>
      )}
      <div style={{ height: totalHeight, position: "relative" }}>
        {/* Rendered words positioned at the right offset */}
        <div className="p-4" style={{ position: "absolute", top: 0, left: 0, right: 0, paddingTop: topSpacerHeight + 16 }}>
          {words.slice(visibleStartIdx, visibleEndIdx).map((word, i) => {
            const globalIdx = visibleStartIdx + i;
            return (
              <WordSpanComponent
                key={globalIdx}
                word={word}
                concept={wordConcepts[globalIdx]?.[0] || null}
                currentTimeNs={currentTimeNs}
                onSeek={handleSeek}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
