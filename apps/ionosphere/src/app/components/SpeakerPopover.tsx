"use client";

import { useState, useRef, useEffect } from "react";
import { useTimelineEngine } from "@/lib/timeline-engine";

interface SpeakerPopoverProps {
  speakerId: string;
  position: { x: number; y: number };
  onClose: () => void;
}

export default function SpeakerPopover({ speakerId, position, onClose }: SpeakerPopoverProps) {
  const { speakerNames, applyCorrection, effectiveTalks } = useTimelineEngine();
  const [name, setName] = useState(speakerNames.get(speakerId) || "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (name.trim()) {
      applyCorrection({ type: "name_speaker", speakerId, name: name.trim() });
    }
    onClose();
  };

  return (
    <div
      className="fixed z-50 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl p-3 w-64"
      style={{ left: position.x, top: position.y }}
    >
      <div className="text-xs text-neutral-500 mb-2">{speakerId}</div>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
          if (e.key === "Escape") onClose();
        }}
        placeholder="Speaker name"
        className="w-full px-2 py-1 text-sm bg-neutral-900 border border-neutral-700 rounded text-neutral-200 placeholder-neutral-600 mb-2"
      />
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500"
        >
          Save
        </button>
        <button
          onClick={onClose}
          className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
