"use client";

import { useEffect, useState } from "react";
import { useTimelineEngine } from "@/lib/timeline-engine";

export default function InteractionOverlay() {
  const {
    editingEnabled,
    activeDrag,
    updateDrag,
    commitDrag,
    cancelDrag,
    pixelToTime,
    timeToPixel,
    findSnap,
  } = useTimelineEngine();

  const [snapGuide, setSnapGuide] = useState<{ px: number; label: string } | null>(null);

  useEffect(() => {
    if (!activeDrag) {
      setSnapGuide(null);
      return;
    }

    const onMouseMove = (e: MouseEvent) => {
      const timeline = document.querySelector("[data-timeline-bar]") as HTMLElement;
      if (!timeline) return;
      const rect = timeline.getBoundingClientRect();
      const px = e.clientX - rect.left;
      let timeSeconds = pixelToTime(px);

      if (!e.altKey) {
        const snapResult = findSnap(timeSeconds, activeDrag.edge, 10);
        if (snapResult) {
          timeSeconds = snapResult.snappedTime;
          const snapPx = timeToPixel(snapResult.snappedTime);
          setSnapGuide({ px: snapPx, label: snapResult.target.type.replace(/_/g, " ") });
        } else {
          setSnapGuide(null);
        }
      } else {
        setSnapGuide(null);
      }

      updateDrag(timeSeconds);
    };

    const onMouseUp = () => {
      commitDrag();
      setSnapGuide(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelDrag();
        setSnapGuide(null);
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeDrag, pixelToTime, timeToPixel, findSnap, updateDrag, commitDrag, cancelDrag]);

  if (!editingEnabled) return null;

  return (
    <>
      {snapGuide && (
        <div
          className="absolute top-0 h-full w-px bg-yellow-400/60 z-20 pointer-events-none"
          style={{ left: `${snapGuide.px}px` }}
        >
          <span className="absolute -top-4 left-1 text-[8px] text-yellow-400 whitespace-nowrap">
            {snapGuide.label}
          </span>
        </div>
      )}
    </>
  );
}
