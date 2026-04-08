"use client";

import { useMemo } from "react";
import { speakerColor, buildIndexMap } from "@/lib/track-colors";
import { useTimelineEngine } from "@/lib/timeline-engine";

interface WaveformBandProps {
  words: Array<{ start: number; end: number; speaker: string }>;
  diarization: Array<{ start: number; end: number; speaker: string }>;
  allSpeakers: string[];
  zoomLevel: number;
  onSpeakerClick?: (speakerId: string, position: { x: number; y: number }) => void;
}

interface Bin {
  startTime: number;
  endTime: number;
  wordCount: number;
  dominantSpeaker: string;
}

export default function WaveformBand({
  words,
  diarization,
  allSpeakers,
  zoomLevel,
  onSpeakerClick,
}: WaveformBandProps) {
  const { windowStart, windowEnd } = useTimelineEngine();
  const windowDuration = windowEnd - windowStart;

  const colorIndex = useMemo(() => buildIndexMap(allSpeakers), [allSpeakers]);

  const useWaveform = zoomLevel >= 4;

  const bins = useMemo(() => {
    if (!useWaveform || words.length === 0) return [];

    const binCount = Math.min(400, Math.max(50, Math.round(windowDuration * 2)));
    const binDuration = windowDuration / binCount;
    const result: Bin[] = [];

    for (let i = 0; i < binCount; i++) {
      const binStart = windowStart + i * binDuration;
      const binEnd = binStart + binDuration;
      const speakerCounts = new Map<string, number>();
      let count = 0;

      for (const w of words) {
        if (w.end < binStart) continue;
        if (w.start > binEnd) break;
        count++;
        speakerCounts.set(w.speaker, (speakerCounts.get(w.speaker) || 0) + 1);
      }

      let dominant = "";
      let maxCount = 0;
      for (const [spk, cnt] of speakerCounts) {
        if (cnt > maxCount) { dominant = spk; maxCount = cnt; }
      }

      result.push({ startTime: binStart, endTime: binEnd, wordCount: count, dominantSpeaker: dominant });
    }

    return result;
  }, [words, windowStart, windowEnd, windowDuration, useWaveform]);

  const maxWordCount = useMemo(
    () => Math.max(1, ...bins.map((b) => b.wordCount)),
    [bins],
  );

  const visibleDiarization = useMemo(() => {
    if (useWaveform) return [];
    return diarization.filter((s) => s.end > windowStart && s.start < windowEnd);
  }, [diarization, windowStart, windowEnd, useWaveform]);

  const merged = useMemo(() => {
    if (visibleDiarization.length === 0) return [];
    const result: typeof visibleDiarization = [];
    let current = {
      ...visibleDiarization[0],
      start: Math.max(visibleDiarization[0].start, windowStart),
      end: Math.min(visibleDiarization[0].end, windowEnd),
    };
    for (let i = 1; i < visibleDiarization.length; i++) {
      const seg = visibleDiarization[i];
      const clipped = {
        ...seg,
        start: Math.max(seg.start, windowStart),
        end: Math.min(seg.end, windowEnd),
      };
      if (clipped.speaker === current.speaker && clipped.start - current.end < 1) {
        current.end = clipped.end;
      } else {
        result.push(current);
        current = clipped;
      }
    }
    result.push(current);
    return result;
  }, [visibleDiarization, windowStart, windowEnd]);

  const bandHeight = useWaveform ? 24 : 12;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSpeakerClick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    const time = windowStart + fraction * windowDuration;
    const seg = diarization.find((s) => s.start <= time && s.end >= time);
    if (seg) {
      onSpeakerClick(seg.speaker, { x: e.clientX, y: e.clientY });
    }
  };

  return (
    <div
      className="relative w-full bg-neutral-900 rounded overflow-hidden border border-neutral-800 cursor-pointer"
      style={{ height: `${bandHeight}px` }}
      onClick={handleClick}
    >
      {useWaveform
        ? bins.map((bin, i) => {
            if (bin.wordCount === 0) return null;
            const left = ((bin.startTime - windowStart) / windowDuration) * 100;
            const width = ((bin.endTime - bin.startTime) / windowDuration) * 100;
            const height = (bin.wordCount / maxWordCount) * 100;

            return (
              <div
                key={i}
                className="absolute bottom-0"
                style={{
                  left: `${left}%`,
                  width: `${Math.max(width, 0.2)}%`,
                  height: `${height}%`,
                  backgroundColor: bin.dominantSpeaker
                    ? speakerColor(bin.dominantSpeaker, colorIndex)
                    : "transparent",
                }}
              />
            );
          })
        : merged.map((seg, i) => {
            const left = ((seg.start - windowStart) / windowDuration) * 100;
            const width = ((seg.end - seg.start) / windowDuration) * 100;
            if (width < 0.05) return null;
            return (
              <div
                key={i}
                className="absolute top-0 h-full"
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  backgroundColor: speakerColor(seg.speaker, colorIndex),
                }}
                title={seg.speaker}
              />
            );
          })}
    </div>
  );
}
