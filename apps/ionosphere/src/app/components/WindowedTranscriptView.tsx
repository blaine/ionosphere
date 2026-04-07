"use client";

import { useRef, useEffect, useMemo, useCallback, useState, forwardRef } from "react";
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
 * Computes full text layout using monospace character counting (no DOM needed),
 * giving accurate scroll-offset ↔ timecode mapping. Only words in the visible
 * viewport + buffer are mounted in the DOM.
 */

interface WindowedTranscriptViewProps {
  document: TranscriptDocument;
}

// --- Word rendering ---

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

// --- Layout computation via monospace character counting ---

interface LineEntry {
  yTop: number;
  yBottom: number;
  timeStart: number;  // ns
  timeEnd: number;    // ns
  wordStartIdx: number;
  wordEndIdx: number; // exclusive
}

/**
 * Compute line breaks for a word list rendered in a monospace font.
 * Each word is followed by a space. Words wrap to the next line when
 * they would exceed the available width. Returns a line→time mapping.
 */
function computeMonospaceLayout(
  words: WordSpan[],
  containerWidthPx: number,
  charWidthPx: number,
  lineHeightPx: number,
): LineEntry[] {
  if (words.length === 0 || containerWidthPx < charWidthPx) return [];

  const maxCharsPerLine = Math.floor(containerWidthPx / charWidthPx);
  const lines: LineEntry[] = [];

  let lineIdx = 0;
  let col = 0; // current column position in characters
  let lineWordStart = 0;

  for (let i = 0; i < words.length; i++) {
    const wordLen = words[i].text.length;
    const needed = wordLen + 1; // word + space

    if (col > 0 && col + wordLen > maxCharsPerLine) {
      // This word doesn't fit — flush current line
      lines.push({
        yTop: lineIdx * lineHeightPx,
        yBottom: (lineIdx + 1) * lineHeightPx,
        timeStart: words[lineWordStart].startTime,
        timeEnd: words[i - 1].endTime,
        wordStartIdx: lineWordStart,
        wordEndIdx: i,
      });
      lineIdx++;
      col = 0;
      lineWordStart = i;
    }

    col += needed;
  }

  // Flush last line
  if (lineWordStart < words.length) {
    lines.push({
      yTop: lineIdx * lineHeightPx,
      yBottom: (lineIdx + 1) * lineHeightPx,
      timeStart: words[lineWordStart].startTime,
      timeEnd: words[words.length - 1].endTime,
      wordStartIdx: lineWordStart,
      wordEndIdx: words.length,
    });
  }

  return lines;
}

// --- Main component ---

const LINE_HEIGHT = 28; // px — matches leading-relaxed at ~16px font
const CHAR_WIDTH = 9.6; // px — monospace 16px (measured: ch unit ≈ 9.6px)
const VIEWPORT_BUFFER = 800; // px of buffer above and below viewport

export default function WindowedTranscriptView({ document }: WindowedTranscriptViewProps) {
  const { currentTimeNs, seekTo, paused } = useTimestamp();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const { words, wordConcepts } = useMemo(() => extractData(document), [document]);

  // Measure container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width - 32); // subtract padding (p-4 = 16px each side)
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Measure actual char width from DOM once
  const [charWidth, setCharWidth] = useState(CHAR_WIDTH);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const probe = window.document.createElement("span");
    probe.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    probe.style.fontSize = "16px";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.textContent = "M"; // reference character
    el.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    el.removeChild(probe);
    if (w > 0) setCharWidth(w);
  }, []);

  // Compute layout — pure computation, no DOM/canvas needed
  const lines = useMemo(() => {
    if (containerWidth < 50) return [];
    return computeMonospaceLayout(words, containerWidth, charWidth, LINE_HEIGHT);
  }, [words, containerWidth, charWidth]);

  const totalHeight = lines.length > 0 ? lines[lines.length - 1].yBottom : 0;

  // --- Time ↔ scroll position ---

  const timeToScrollY = useCallback(
    (timeNs: number): number => {
      if (lines.length === 0) return 0;
      let lo = 0, hi = lines.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lines[mid].timeStart <= timeNs) lo = mid;
        else hi = mid - 1;
      }
      const entry = lines[lo];
      const frac = entry.timeEnd > entry.timeStart
        ? Math.min(1, Math.max(0, (timeNs - entry.timeStart) / (entry.timeEnd - entry.timeStart)))
        : 0;
      return entry.yTop + frac * (entry.yBottom - entry.yTop);
    },
    [lines],
  );

  const scrollYToTime = useCallback(
    (y: number): number => {
      if (lines.length === 0) return 0;
      let lo = 0, hi = lines.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lines[mid].yTop <= y) lo = mid;
        else hi = mid - 1;
      }
      const entry = lines[lo];
      const frac = entry.yBottom > entry.yTop
        ? Math.min(1, Math.max(0, (y - entry.yTop) / (entry.yBottom - entry.yTop)))
        : 0;
      return entry.timeStart + frac * (entry.timeEnd - entry.timeStart);
    },
    [lines],
  );

  // --- Scroll state ---
  //
  // After scroll-scrub seeks the video, currentTimeNs still reflects the
  // old position until the video's timeupdate fires. Without protection,
  // the auto-scroll effect would see the stale time and scroll back to
  // the old position, causing a visible bounce.
  //
  // Fix: track the last seeked time from scroll-scrub. Auto-scroll only
  // resumes once currentTimeNs is within tolerance of the seek target
  // (meaning the video has caught up to the seek).

  const [scrollTop, setScrollTop] = useState(0);
  const userScrolling = useRef(false);
  const userScrollTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastScrubSeekNs = useRef<number | null>(null);
  const playheadFrac = 0.33;
  const scrollTargetRef = useRef<number | null>(null);
  const animFrameRef = useRef(0);

  // Auto-scroll: position playhead time at 33% of viewport.
  // Suppressed while user is scrolling OR while the video hasn't caught
  // up to the last scroll-scrub seek.
  useEffect(() => {
    if (userScrolling.current || !containerRef.current || lines.length === 0) return;

    // If we recently scroll-scrubbed, wait for the video to catch up
    if (lastScrubSeekNs.current !== null) {
      const drift = Math.abs(currentTimeNs - lastScrubSeekNs.current);
      if (drift > 2e9) {
        // Video hasn't caught up yet — don't auto-scroll
        scrollTargetRef.current = null;
        return;
      }
      // Video caught up — clear the lock
      lastScrubSeekNs.current = null;
    }

    const viewportH = containerRef.current.clientHeight;
    const playheadOffset = viewportH * playheadFrac;
    const textY = timeToScrollY(currentTimeNs);
    scrollTargetRef.current = textY - playheadOffset;
  }, [currentTimeNs, timeToScrollY, lines]);

  // Smooth scroll animation loop
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

  // Scroll-to-scrub: user scrolling is authoritative.
  // Sets lastScrubSeekNs to suppress auto-scroll until the video catches up.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let userInitiated = false;
    const onWheel = () => { userInitiated = true; };
    const onTouchMove = () => { userInitiated = true; };

    const onScroll = () => {
      if (!userInitiated) return;
      userScrolling.current = true;
      scrollTargetRef.current = null; // cancel any pending auto-scroll

      clearTimeout(userScrollTimer.current);
      userScrollTimer.current = setTimeout(() => {
        userScrolling.current = false;
      }, paused ? 999999 : 2000);

      const viewportH = container.clientHeight;
      const playheadY = container.scrollTop + viewportH * playheadFrac;
      const seekTimeNs = scrollYToTime(playheadY);
      lastScrubSeekNs.current = seekTimeNs;
      seekTo(seekTimeNs);
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

  // Compute visible LINE range from scroll position
  const { startLine, endLine } = useMemo(() => {
    if (lines.length === 0) return { startLine: 0, endLine: 0 };
    const viewportH = containerRef.current?.clientHeight ?? 600;
    const viewTop = scrollTop - VIEWPORT_BUFFER;
    const viewBottom = scrollTop + viewportH + VIEWPORT_BUFFER;

    let lo = 0, hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].yBottom < viewTop) lo = mid + 1;
      else hi = mid;
    }
    const sl = lo;

    lo = sl; hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].yTop <= viewBottom) lo = mid;
      else hi = mid - 1;
    }

    return { startLine: sl, endLine: lo + 1 };
  }, [scrollTop, lines]);

  const handleSeek = useCallback((ns: number) => seekTo(ns), [seekTo]);

  return (
    <div
      ref={containerRef}
      className="relative h-full overflow-y-auto leading-relaxed"
      style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "16px" }}
    >
      {/* Playhead indicator at 33% */}
      <div className="pointer-events-none sticky z-10" style={{ top: "33%" }}>
        <div className="h-px" style={{
          background: "linear-gradient(to right, rgba(255,255,255,0.35), rgba(255,255,255,0.35) 10px, rgba(255,255,255,0.1) 10px, rgba(255,255,255,0.1) calc(100% - 10px), rgba(255,255,255,0.35) calc(100% - 10px), rgba(255,255,255,0.35))"
        }} />
      </div>

      {/* Total scrollable area — each line is absolutely positioned */}
      <div style={{ height: totalHeight, position: "relative", padding: "0 16px" }}>
        {lines.slice(startLine, endLine).map((line) => (
          <div
            key={line.wordStartIdx}
            style={{
              position: "absolute",
              top: line.yTop,
              left: 16,
              right: 16,
              height: LINE_HEIGHT,
              lineHeight: `${LINE_HEIGHT}px`,
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
          >
            {words.slice(line.wordStartIdx, line.wordEndIdx).map((word, i) => {
              const globalIdx = line.wordStartIdx + i;
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
        ))}
      </div>
    </div>
  );
}
