"use client";

import { useEffect } from "react";
import { useTimelineEngine } from "@/lib/timeline-engine";
import { useTimestamp } from "./TimestampProvider";

export function useEditorKeyboard(onSave: () => void) {
  const {
    editingEnabled,
    toggleEditing,
    mode,
    setMode,
    selectedTalkRkey,
    effectiveTalks,
    applyCorrection,
    undo,
    redo,
    canUndo,
    canRedo,
    activeDrag,
    cancelDrag,
    selectTalk,
  } = useTimelineEngine();

  const { seekTo, currentTimeNs, paused, setPaused } = useTimestamp();
  const currentTimeSec = currentTimeNs / 1e9;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const ctrl = e.ctrlKey || e.metaKey;

      // --- Playback shortcuts (always active) ---
      switch (e.key) {
        case " ":
          e.preventDefault();
          setPaused(!paused);
          return;
        case "ArrowLeft":
          e.preventDefault();
          seekTo((currentTimeSec - (e.shiftKey ? 0.1 : 1)) * 1e9);
          return;
        case "ArrowRight":
          e.preventDefault();
          seekTo((currentTimeSec + (e.shiftKey ? 0.1 : 1)) * 1e9);
          return;
        case "j":
        case "J":
          seekTo((currentTimeSec - 5) * 1e9);
          return;
        case "k":
        case "K":
          setPaused(!paused);
          return;
        case "l":
        case "L":
          seekTo((currentTimeSec + 5) * 1e9);
          return;
      }

      // --- Editing shortcuts (only when editing) ---
      if (!editingEnabled) return;

      if (ctrl && e.key === "s") {
        e.preventDefault();
        onSave();
        return;
      }

      if (ctrl && e.key === "z" && !e.shiftKey && canUndo) {
        e.preventDefault();
        undo();
        return;
      }
      if (ctrl && e.key === "z" && e.shiftKey && canRedo) {
        e.preventDefault();
        redo();
        return;
      }

      if (!ctrl) {
        switch (e.key) {
          case "v": setMode("select"); return;
          case "t": setMode("trim"); return;
          case "s": setMode("split"); return;
          case "a": setMode("add"); return;
        }
      }

      if (e.key === "Escape") {
        if (activeDrag) {
          cancelDrag();
        } else if (selectedTalkRkey) {
          selectTalk(null);
        } else {
          toggleEditing();
        }
        return;
      }

      if (selectedTalkRkey) {
        const talk = effectiveTalks.find((t) => t.rkey === selectedTalkRkey);
        if (!talk) return;

        switch (e.key) {
          case "Enter":
            applyCorrection(
              talk.verified
                ? { type: "unverify_talk", talkRkey: selectedTalkRkey }
                : { type: "verify_talk", talkRkey: selectedTalkRkey },
            );
            return;
          case "Backspace":
          case "Delete":
            if (talk.verified && !confirm("Delete verified talk?")) return;
            applyCorrection({ type: "remove_talk", talkRkey: selectedTalkRkey });
            return;
          case "[":
            e.preventDefault();
            applyCorrection({
              type: "move_boundary",
              talkRkey: selectedTalkRkey,
              edge: "start",
              fromSeconds: talk.startSeconds,
              toSeconds: talk.startSeconds - (e.shiftKey ? 0.1 : 1),
            });
            return;
          case "]":
            e.preventDefault();
            applyCorrection({
              type: "move_boundary",
              talkRkey: selectedTalkRkey,
              edge: "end",
              fromSeconds: talk.endSeconds ?? 0,
              toSeconds: (talk.endSeconds ?? 0) + (e.shiftKey ? 0.1 : 1),
            });
            return;
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [editingEnabled, mode, selectedTalkRkey, effectiveTalks, currentTimeSec, paused, activeDrag, canUndo, canRedo, onSave, setMode, selectTalk, applyCorrection, undo, redo, cancelDrag, toggleEditing, seekTo, setPaused]);
}
