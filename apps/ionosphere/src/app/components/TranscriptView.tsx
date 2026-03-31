"use client";

import { useTimestamp } from "./TimestampProvider";
import { useRef, useEffect, useMemo, useCallback, forwardRef } from "react";

interface TranscriptFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{
    $type: string;
    startTime?: number;
    endTime?: number;
    conceptUri?: string;
    conceptRkey?: string;
    conceptName?: string;
    [key: string]: any;
  }>;
}

interface TranscriptDocument {
  text: string;
  facets: TranscriptFacet[];
}

interface TranscriptViewProps {
  document: TranscriptDocument;
}

interface WordSpan {
  text: string;
  startTime: number;
  endTime: number;
  byteStart: number;
  byteEnd: number;
  gapBefore: number; // ns of silence before this word (0 = contiguous)
}

interface ConceptSpan {
  byteStart: number;
  byteEnd: number;
  conceptUri: string;
  conceptRkey: string;
  conceptName: string;
}

function extractData(doc: TranscriptDocument) {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(doc.text);
  const decoder = new TextDecoder();

  const words: WordSpan[] = [];
  const concepts: ConceptSpan[] = [];

  for (const f of doc.facets) {
    for (const feat of f.features) {
      if (feat.$type === "tv.ionosphere.facet#timestamp") {
        words.push({
          text: decoder.decode(
            textBytes.slice(f.index.byteStart, f.index.byteEnd)
          ),
          startTime: feat.startTime!,
          endTime: feat.endTime!,
          byteStart: f.index.byteStart,
          byteEnd: f.index.byteEnd,
        });
      } else if (feat.$type === "tv.ionosphere.facet#concept-ref") {
        concepts.push({
          byteStart: f.index.byteStart,
          byteEnd: f.index.byteEnd,
          conceptUri: feat.conceptUri!,
          conceptRkey: feat.conceptRkey!,
          conceptName: feat.conceptName!,
        });
      }
    }
  }

  words.sort((a, b) => a.startTime - b.startTime);

  // Compute gap before each word
  for (let i = 0; i < words.length; i++) {
    if (i === 0) {
      words[i].gapBefore = words[i].startTime; // gap from 0 to first word
    } else {
      words[i].gapBefore = Math.max(0, words[i].startTime - words[i - 1].endTime);
    }
  }

  // Build a lookup: for each word, which concepts overlap it?
  const wordConcepts = words.map((w) =>
    concepts.filter(
      (c) => c.byteStart < w.byteEnd && c.byteEnd > w.byteStart
    )
  );

  return { words, concepts, wordConcepts };
}

// --- Brightness ---

const BASE_BRIGHTNESS = 0.3;
const PEAK_BRIGHTNESS = 1.0;
const WINDOW_NS = 2_000_000_000; // 2 second falloff

function brightnessAtTime(currentTimeNs: number, timeNs: number): number {
  const dist = Math.abs(currentTimeNs - timeNs);
  if (dist > WINDOW_NS) return BASE_BRIGHTNESS;
  const t = 1 - dist / WINDOW_NS;
  return BASE_BRIGHTNESS + (PEAK_BRIGHTNESS - BASE_BRIGHTNESS) * t * t;
}

/**
 * Brightness for a word, respecting gap boundaries.
 * If there's a gap before this word, the forward-looking brightness
 * (from earlier in time) is clamped so it can't bleed through the gap.
 */
function wordStartBrightness(
  currentTimeNs: number,
  word: WordSpan
): number {
  const raw = brightnessAtTime(currentTimeNs, word.startTime);

  // If current time is before this word's start and there's a gap,
  // only allow brightness if we're past the gap (close to the word)
  if (word.gapBefore > 0 && currentTimeNs < word.startTime) {
    const gapStart = word.startTime - word.gapBefore;
    if (currentTimeNs < gapStart) {
      // We're before the gap even started — no forward bleed
      return BASE_BRIGHTNESS;
    }
    // We're inside the gap — fade from base at gap start to raw at word start
    const gapProgress =
      (currentTimeNs - gapStart) / word.gapBefore;
    return BASE_BRIGHTNESS + (raw - BASE_BRIGHTNESS) * gapProgress * gapProgress;
  }

  return raw;
}

function wordEndBrightness(
  currentTimeNs: number,
  word: WordSpan,
  nextWord: WordSpan | null
): number {
  const raw = brightnessAtTime(currentTimeNs, word.endTime);

  // If there's a gap after this word and current time is past the word,
  // clamp the trailing brightness so it fades within the gap
  if (nextWord && nextWord.gapBefore > 0 && currentTimeNs > word.endTime) {
    const gapEnd = word.endTime + nextWord.gapBefore;
    if (currentTimeNs > gapEnd) {
      return BASE_BRIGHTNESS;
    }
    const gapProgress =
      1 - (currentTimeNs - word.endTime) / nextWord.gapBefore;
    return BASE_BRIGHTNESS + (raw - BASE_BRIGHTNESS) * gapProgress * gapProgress;
  }

  return raw;
}

// Concept color: amber tint whose saturation scales with brightness.
// When dim (far from playhead), concepts are barely distinguishable
// from plain text. When lit, they glow gold.
function toColor(
  brightness: number,
  concept: ConceptSpan | null
): string {
  const v = Math.round(brightness * 255);
  if (!concept) {
    return `rgb(${v} ${v} ${v})`;
  }
  // Saturation scales with brightness — dim concepts are nearly gray
  const sat = brightness * brightness; // quadratic: very low at base, strong at peak
  const r = Math.round(v + sat * (255 - v) * 0.2);
  const g = Math.round(v - sat * v * 0.15);
  const b = Math.round(v - sat * v * 0.55);
  return `rgb(${Math.min(255, r)} ${Math.max(0, g)} ${Math.max(0, b)})`;
}

const WordSpanComponent = forwardRef<
  HTMLSpanElement,
  {
    word: WordSpan;
    nextWord: WordSpan | null;
    concept: ConceptSpan | null;
    currentTimeNs: number;
    onSeek: (ns: number) => void;
  }
>(function WordSpanComponent({ word, nextWord, concept, currentTimeNs, onSeek }, ref) {
  const startB = wordStartBrightness(currentTimeNs, word);
  const endB = wordEndBrightness(currentTimeNs, word, nextWord);

  const needsGradient = Math.abs(startB - endB) > 0.02;

  const style: React.CSSProperties = needsGradient
    ? {
        backgroundImage: `linear-gradient(to right, ${toColor(startB, concept)}, ${toColor(endB, concept)})`,
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        WebkitTextFillColor: "transparent",
      }
    : {
        color: toColor((startB + endB) / 2, concept),
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

export default function TranscriptView({ document }: TranscriptViewProps) {
  const { currentTimeNs, paused, seekTo } = useTimestamp();
  const containerRef = useRef<HTMLDivElement>(null);
  const activeIndexRef = useRef<number>(-1);
  const scrollScrubbing = useRef(false);
  const wordRefsMap = useRef<Map<number, HTMLSpanElement>>(new Map());

  const { words, wordConcepts } = useMemo(
    () => extractData(document),
    [document]
  );

  // Find the active word index
  const activeIndex = useMemo(() => {
    for (let i = 0; i < words.length; i++) {
      if (
        currentTimeNs >= words[i].startTime &&
        currentTimeNs < words[i].endTime
      ) {
        return i;
      }
    }
    return -1;
  }, [currentTimeNs, words]);

  // Track whether the user is actively scrubbing via scroll.
  // When they scroll (touch/wheel), we take over for a moment,
  // then hand back to auto-scroll after a timeout.
  const userScrolling = useRef(false);
  const userScrollTimer = useRef<ReturnType<typeof setTimeout>>();
  const programmaticScroll = useRef(false);

  // Auto-scroll: keep the active word at the 1/3 mark.
  // Suppressed while user is scroll-scrubbing.
  useEffect(() => {
    if (userScrolling.current) return;
    if (activeIndex !== activeIndexRef.current && activeIndex >= 0) {
      activeIndexRef.current = activeIndex;
      const container = containerRef.current;
      const activeEl = wordRefsMap.current.get(activeIndex);
      if (!container || !activeEl) return;

      const rect = activeEl.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const targetY = containerRect.top + containerRect.height * 0.33;
      const diff = rect.top - targetY;
      if (Math.abs(diff) > 5) {
        programmaticScroll.current = true;
        container.scrollBy({ top: diff, behavior: "instant" });
        // Use rAF to clear the flag after the browser processes the scroll
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            programmaticScroll.current = false;
          });
        });
      }
    }
  }, [activeIndex]);

  // Scroll-to-scrub: always active. User scrolling seeks the video.
  // During playback, auto-scroll resumes after 2s of no user scrolling.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let rafId: number;

    // Build a sorted list of text lines with their time ranges.
    // Computed once and cached until words change.
    let cachedLines: Array<{
      top: number; bottom: number;
      startTime: number; endTime: number;
    }> | null = null;

    const getLines = () => {
      if (cachedLines) return cachedLines;
      // Group words by line (same top position)
      const lineMap = new Map<number, { startTime: number; endTime: number; bottom: number }>();
      for (const [idx, el] of wordRefsMap.current) {
        if (idx >= words.length) continue;
        const rect = el.getBoundingClientRect();
        const top = Math.round(rect.top); // round to group same-line words
        const existing = lineMap.get(top);
        if (existing) {
          existing.startTime = Math.min(existing.startTime, words[idx].startTime);
          existing.endTime = Math.max(existing.endTime, words[idx].endTime);
        } else {
          lineMap.set(top, {
            startTime: words[idx].startTime,
            endTime: words[idx].endTime,
            bottom: rect.bottom,
          });
        }
      }
      cachedLines = [...lineMap.entries()]
        .map(([top, v]) => ({ top, bottom: v.bottom, startTime: v.startTime, endTime: v.endTime }))
        .sort((a, b) => a.top - b.top);
      return cachedLines;
    };

    const findWordAtPlayhead = () => {
      const containerRect = container.getBoundingClientRect();
      const targetY = containerRect.top + containerRect.height * 0.33;
      const lines = getLines();
      if (lines.length === 0) return;

      // Invalidate cache on next call (positions change after scroll)
      cachedLines = null;

      // Find which line the playhead is on or between
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (targetY >= line.top && targetY <= line.bottom) {
          // Playhead is on this line — interpolate within it
          const frac = (targetY - line.top) / (line.bottom - line.top);
          const time = line.startTime + frac * (line.endTime - line.startTime);
          seekTo(time);
          return;
        }

        if (targetY < line.top) {
          if (i === 0) {
            seekTo(line.startTime);
            return;
          }
          // Between lines — snap to whichever is closer
          const prev = lines[i - 1];
          const distToPrev = targetY - prev.bottom;
          const distToNext = line.top - targetY;
          seekTo(distToPrev <= distToNext ? prev.endTime : line.startTime);
          return;
        }
      }

      // Below the last line
      seekTo(lines[lines.length - 1].endTime);
    };

    const onScroll = () => {
      // Ignore scrolls we triggered programmatically
      if (programmaticScroll.current) return;

      userScrolling.current = true;

      // Reset the "hand back to auto-scroll" timer
      clearTimeout(userScrollTimer.current);
      userScrollTimer.current = setTimeout(() => {
        userScrolling.current = false;
      }, paused ? 999999 : 2000); // stay in user mode indefinitely when paused

      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(findWordAtPlayhead);
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafId);
      clearTimeout(userScrollTimer.current);
    };
  }, [words, seekTo, paused]);

  const handleSeek = useCallback(
    (ns: number) => seekTo(ns),
    [seekTo]
  );

  const setWordRef = useCallback(
    (index: number, el: HTMLSpanElement | null) => {
      if (el) {
        wordRefsMap.current.set(index, el);
      } else {
        wordRefsMap.current.delete(index);
      }
    },
    []
  );

  const conceptCount = useMemo(
    () => words.filter((_, i) => wordConcepts[i]?.length > 0).length,
    [words, wordConcepts]
  );

  return (
    <div
      ref={containerRef}
      className="h-full p-4 rounded-lg border border-neutral-800 overflow-y-auto leading-relaxed select-none"
    >
      {/* Playhead indicator at 1/3 from top */}
      <div
        className="pointer-events-none sticky z-10 -mx-4"
        style={{ top: "33%" }}
      >
        {/* Glow zone: ~10px tall soft highlight */}
        <div className="h-[10px] -mt-[5px]" style={{
          background: "linear-gradient(to bottom, transparent, rgba(255,255,255,0.03) 30%, rgba(255,255,255,0.06) 50%, rgba(255,255,255,0.03) 70%, transparent)"
        }} />
        {/* Sharp line — bright notches at edges, subtle across middle */}
        <div className="h-px -mt-[5px]" style={{
          background: "linear-gradient(to right, rgba(255,255,255,0.35), rgba(255,255,255,0.35) 10px, rgba(255,255,255,0.1) 10px, rgba(255,255,255,0.1) calc(100% - 10px), rgba(255,255,255,0.35) calc(100% - 10px), rgba(255,255,255,0.35))"
        }} />
      </div>
      {conceptCount > 0 && (
        <div className="text-xs text-amber-500/60 mb-3">
          {conceptCount} words linked to concepts
        </div>
      )}
      {words.map((word, i) => (
        <WordSpanComponent
          key={i}
          ref={(el) => setWordRef(i, el)}
          word={word}
          nextWord={i < words.length - 1 ? words[i + 1] : null}
          concept={wordConcepts[i]?.[0] || null}
          currentTimeNs={currentTimeNs}
          onSeek={handleSeek}
        />
      ))}
    </div>
  );
}
