"use client";

import { useTimestamp } from "./TimestampProvider";
import { useRef, useEffect } from "react";

interface TranscriptFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; startTime?: number; endTime?: number; [key: string]: any }>;
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

function extractWordSpans(doc: TranscriptDocument): WordSpan[] {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(doc.text);
  const decoder = new TextDecoder();

  return doc.facets
    .filter((f) => f.features.some((feat) => feat.$type === "tv.ionosphere.facet#timestamp"))
    .map((f) => {
      const ts = f.features.find((feat) => feat.$type === "tv.ionosphere.facet#timestamp")!;
      return {
        text: decoder.decode(textBytes.slice(f.index.byteStart, f.index.byteEnd)),
        startTime: ts.startTime!,
        endTime: ts.endTime!,
        byteStart: f.index.byteStart,
        byteEnd: f.index.byteEnd,
      };
    })
    .sort((a, b) => a.byteStart - b.byteStart);
}

export default function TranscriptView({ document }: TranscriptViewProps) {
  const { currentTimeNs, seekTo } = useTimestamp();
  const activeRef = useRef<HTMLSpanElement>(null);
  const words = extractWordSpans(document);

  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentTimeNs]);

  return (
    <div className="mt-8 p-6 rounded-lg border border-neutral-800 max-h-96 overflow-y-auto leading-relaxed">
      {words.map((word, i) => {
        const isActive = currentTimeNs >= word.startTime && currentTimeNs < word.endTime;
        return (
          <span key={i} ref={isActive ? activeRef : undefined}
            onClick={() => seekTo(word.startTime)}
            className={`cursor-pointer transition-colors ${
              isActive ? "bg-blue-500/30 text-white rounded px-0.5" : "text-neutral-300 hover:text-white"
            }`}>
            {word.text}{" "}
          </span>
        );
      })}
    </div>
  );
}
