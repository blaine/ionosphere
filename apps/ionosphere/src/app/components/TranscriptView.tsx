"use client";

import { useTimestamp } from "./TimestampProvider";
import { useRef, useEffect, useMemo, useCallback } from "react";

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

// Concept color: a warm accent that tints the brightness
// Returns an rgb string blending white (base) with accent color at the given brightness
function toColor(
  brightness: number,
  concept: ConceptSpan | null
): string {
  const v = Math.round(brightness * 255);
  if (!concept) {
    return `rgb(${v} ${v} ${v})`;
  }
  // Concept words always have a visible amber tint, even when dim.
  // Base: warm amber at minimum visible saturation
  // Peak: bright gold
  const minSat = 0.5; // minimum color saturation even at low brightness
  const sat = minSat + (1 - minSat) * brightness;
  const r = Math.round(sat * 255);
  const g = Math.round(sat * 190);
  const b = Math.round(Math.max(brightness * 60, 30));
  return `rgb(${r} ${g} ${b})`;
}

function WordSpanComponent({
  word,
  nextWord,
  concept,
  currentTimeNs,
  onSeek,
}: {
  word: WordSpan;
  nextWord: WordSpan | null;
  concept: ConceptSpan | null;
  currentTimeNs: number;
  onSeek: (ns: number) => void;
}) {
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
      onClick={() => onSeek(word.startTime)}
      className={`cursor-pointer${concept ? " underline decoration-amber-500/30 underline-offset-2" : ""}`}
      style={style}
      title={concept ? concept.conceptName : undefined}
    >
      {word.text}{" "}
    </span>
  );
}

export default function TranscriptView({ document }: TranscriptViewProps) {
  const { currentTimeNs, seekTo } = useTimestamp();
  const containerRef = useRef<HTMLDivElement>(null);
  const activeIndexRef = useRef<number>(-1);

  const { words, wordConcepts } = useMemo(
    () => extractData(document),
    [document]
  );

  // Find the active word index for auto-scroll
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

  // Auto-scroll only when we move to a new word
  useEffect(() => {
    if (activeIndex !== activeIndexRef.current && activeIndex >= 0) {
      activeIndexRef.current = activeIndex;
      const container = containerRef.current;
      if (!container) return;
      const activeEl = container.children[activeIndex] as HTMLElement;
      if (activeEl) {
        const rect = activeEl.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const margin = containerRect.height * 0.3;
        if (
          rect.top < containerRect.top + margin ||
          rect.bottom > containerRect.bottom - margin
        ) {
          activeEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }
  }, [activeIndex]);

  const handleSeek = useCallback(
    (ns: number) => seekTo(ns),
    [seekTo]
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
      {conceptCount > 0 && (
        <div className="text-xs text-amber-500/60 mb-3">
          {conceptCount} words linked to concepts
        </div>
      )}
      {words.map((word, i) => (
        <WordSpanComponent
          key={i}
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
