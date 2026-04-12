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
  isParagraphStart: boolean;
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
  paragraphStarts: Set<number> = new Set(),
): LineEntry[] {
  if (words.length === 0 || containerWidthPx < charWidthPx) return [];

  const maxCharsPerLine = Math.floor(containerWidthPx / charWidthPx);
  const lines: LineEntry[] = [];

  let currentY = 0;
  let col = 0; // current column position in characters
  let lineWordStart = 0;

  for (let i = 0; i < words.length; i++) {
    const wordLen = words[i].text.length;
    const needed = wordLen + 1; // word + space

    if (col > 0 && col + wordLen > maxCharsPerLine) {
      // This word doesn't fit — flush current line
      const isParaStart = paragraphStarts.has(lineWordStart);
      if (isParaStart) {
        currentY += lineHeightPx; // add paragraph gap
      }
      lines.push({
        yTop: currentY,
        yBottom: currentY + lineHeightPx,
        timeStart: words[lineWordStart].startTime,
        timeEnd: words[i - 1].endTime,
        wordStartIdx: lineWordStart,
        wordEndIdx: i,
        isParagraphStart: isParaStart,
      });
      currentY += lineHeightPx;
      col = 0;
      lineWordStart = i;
    }

    col += needed;
  }

  // Flush last line
  if (lineWordStart < words.length) {
    const isParaStart = paragraphStarts.has(lineWordStart);
    if (isParaStart) {
      currentY += lineHeightPx; // add paragraph gap
    }
    lines.push({
      yTop: currentY,
      yBottom: currentY + lineHeightPx,
      timeStart: words[lineWordStart].startTime,
      timeEnd: words[words.length - 1].endTime,
      wordStartIdx: lineWordStart,
      wordEndIdx: words.length,
      isParagraphStart: isParaStart,
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

  const { words, wordConcepts, paragraphs } = useMemo(() => extractData(document), [document]);

  // Compute paragraph start word indices for gap insertion
  const paragraphStartIndices = useMemo(() => {
    const set = new Set<number>();
    let globalIdx = 0;
    for (const para of paragraphs) {
      const firstWordIdx = globalIdx;
      for (const sent of para.sentences) {
        globalIdx += sent.words.length;
      }
      // Don't mark the very first paragraph — no gap before the first one
      if (firstWordIdx > 0) {
        set.add(firstWordIdx);
      }
    }
    return set;
  }, [paragraphs]);

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
    return computeMonospaceLayout(words, containerWidth, charWidth, LINE_HEIGHT, paragraphStartIndices);
  }, [words, containerWidth, charWidth, paragraphStartIndices]);

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
  // The scroll position is AUTHORITATIVE after user scrolling. Auto-scroll
  // must never fight it. The approach:
  //
  // 1. On user scroll: seek video, set scrollTargetRef = current scrollTop
  //    (anchoring auto-scroll to the user's position).
  // 2. Auto-scroll only advances scrollTargetRef by the DELTA in currentTimeNs
  //    since the last update — it never recomputes an absolute position that
  //    could differ from where the user scrolled.
  // 3. This means after scroll-scrub, playback smoothly continues FROM the
  //    user's scroll position with no jump/bounce.

  const [scrollTop, setScrollTop] = useState(0);
  const userScrolling = useRef(false);
  const userScrollTimer = useRef<ReturnType<typeof setTimeout>>();
  const playheadFrac = 0.33;
  const scrollTargetRef = useRef<number | null>(null);
  const prevTimeNs = useRef(currentTimeNs);
  const scrollVelocity = useRef(0); // px per ms — for interpolation between timeupdates
  const lastTickMs = useRef(0);
  const animFrameRef = useRef(0);

  // On each timeupdate (~4Hz): compute scroll velocity from the delta.
  // The animation loop uses this to interpolate at 60fps.
  useEffect(() => {
    if (!containerRef.current || lines.length === 0) return;

    const deltaTimeNs = currentTimeNs - prevTimeNs.current;
    prevTimeNs.current = currentTimeNs;

    if (userScrolling.current) return;

    if (scrollTargetRef.current === null) {
      const viewportH = containerRef.current.clientHeight;
      const textY = timeToScrollY(currentTimeNs);
      scrollTargetRef.current = textY - viewportH * playheadFrac;
      scrollVelocity.current = 0;
    } else if (deltaTimeNs > 0 && deltaTimeNs < 1e9) {
      const curY = timeToScrollY(currentTimeNs);
      const prevY = timeToScrollY(currentTimeNs - deltaTimeNs);
      const deltaScrollPx = curY - prevY;
      const deltaMs = deltaTimeNs / 1e6;

      // Snap target to the correct absolute position for this time
      const viewportH = containerRef.current.clientHeight;
      scrollTargetRef.current = curY - viewportH * playheadFrac;

      // Update velocity (px/ms) — smoothed to avoid jitter
      if (deltaMs > 0) {
        const newVelocity = deltaScrollPx / deltaMs;
        scrollVelocity.current = scrollVelocity.current * 0.7 + newVelocity * 0.3;
      }
    } else {
      // Seek or pause — stop velocity
      scrollVelocity.current = 0;
    }

    lastTickMs.current = performance.now();
  }, [currentTimeNs, timeToScrollY, lines]);

  // Animation loop: interpolate at 60fps using velocity between timeupdates.
  // This gives truly continuous motion instead of LERP-chasing 4Hz updates.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let prevFrameMs = performance.now();

    const animate = () => {
      const now = performance.now();
      const frameDt = now - prevFrameMs;
      prevFrameMs = now;

      if (!userScrolling.current && scrollTargetRef.current !== null) {
        // Extrapolate target forward using velocity since last timeupdate
        const msSinceUpdate = now - lastTickMs.current;
        const extrapolated = scrollTargetRef.current + scrollVelocity.current * msSinceUpdate;

        const diff = extrapolated - container.scrollTop;
        if (Math.abs(diff) > 0.3) {
          // Blend: mostly linear tracking, slight LERP for convergence
          const linearStep = scrollVelocity.current * frameDt;
          const lerpStep = diff * 0.12;
          // Use whichever moves us closer to the target
          container.scrollTop += Math.abs(linearStep) > 0.1 ? linearStep + (diff - linearStep) * 0.1 : lerpStep;
        }
      }
      setScrollTop(container.scrollTop);
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  // Scroll-to-scrub: user scrolling is authoritative.
  // Anchors scrollTargetRef to current scroll position so auto-scroll
  // continues smoothly from where the user left off.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let userInitiated = false;
    const onWheel = () => { userInitiated = true; };
    const onTouchMove = () => { userInitiated = true; };

    const onScroll = () => {
      if (!userInitiated) return;
      userScrolling.current = true;

      // Anchor auto-scroll to the user's position
      scrollTargetRef.current = container.scrollTop;

      clearTimeout(userScrollTimer.current);
      userScrollTimer.current = setTimeout(() => {
        // When user stops, anchor target to current position so
        // playback continues smoothly from here
        scrollTargetRef.current = container.scrollTop;
        userScrolling.current = false;
      }, paused ? 999999 : 500);

      const viewportH = container.clientHeight;
      const playheadY = container.scrollTop + viewportH * playheadFrac;
      seekTo(scrollYToTime(playheadY));
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
