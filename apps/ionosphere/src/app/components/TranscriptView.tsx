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

  words.sort((a, b) => a.byteStart - b.byteStart);

  // Build a lookup: for each word, which concepts overlap it?
  const wordConcepts = words.map((w) =>
    concepts.filter(
      (c) => c.byteStart <= w.byteStart && c.byteEnd >= w.byteEnd
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
  // Tint toward a warm gold/amber for concepts
  // At full brightness: rgb(255, 220, 120) — gold
  // At base brightness: same dim gray as non-concept text
  const r = Math.round(brightness * 255);
  const g = Math.round(brightness * 220);
  const b = Math.round(brightness * 120);
  return `rgb(${r} ${g} ${b})`;
}

function WordSpanComponent({
  word,
  concept,
  currentTimeNs,
  onSeek,
}: {
  word: WordSpan;
  concept: ConceptSpan | null;
  currentTimeNs: number;
  onSeek: (ns: number) => void;
}) {
  const startB = brightnessAtTime(currentTimeNs, word.startTime);
  const endB = brightnessAtTime(currentTimeNs, word.endTime);

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

  return (
    <div
      ref={containerRef}
      className="mt-8 p-6 rounded-lg border border-neutral-800 max-h-96 overflow-y-auto leading-relaxed select-none"
    >
      {words.map((word, i) => (
        <WordSpanComponent
          key={i}
          word={word}
          concept={wordConcepts[i]?.[0] || null}
          currentTimeNs={currentTimeNs}
          onSeek={handleSeek}
        />
      ))}
    </div>
  );
}
