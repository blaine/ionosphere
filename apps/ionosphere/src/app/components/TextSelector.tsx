"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth";

interface TextSelectorProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onComment: (byteStart: number, byteEnd: number, text: string) => void;
  wordSpans: Array<{ byteStart: number; byteEnd: number }>;
}

const QUICK_EMOJI = ["\u{1F525}", "\u{1F44F}", "\u{1F4A1}", "\u2753", "\u{1F4AF}", "\u2764\uFE0F"];

export default function TextSelector({ containerRef, onComment, wordSpans }: TextSelectorProps) {
  const { did } = useAuth();
  const [selection, setSelection] = useState<{ byteStart: number; byteEnd: number; rect: DOMRect } | null>(null);
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [commentText, setCommentText] = useState("");
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Map a DOM Selection to byte range using word span data attributes
  const getByteRange = useCallback((sel: Selection): { byteStart: number; byteEnd: number } | null => {
    const range = sel.getRangeAt(0);

    // Find the word spans that overlap with the selection
    const container = containerRef.current;
    if (!container) return null;

    const spans = container.querySelectorAll("[data-byte-start]");
    let minByte = Infinity;
    let maxByte = -1;

    for (const span of spans) {
      if (sel.containsNode(span, true)) {
        const bs = parseInt(span.getAttribute("data-byte-start") || "0");
        const be = parseInt(span.getAttribute("data-byte-end") || "0");
        if (bs < minByte) minByte = bs;
        if (be > maxByte) maxByte = be;
      }
    }

    if (minByte === Infinity || maxByte === -1) return null;
    return { byteStart: minByte, byteEnd: maxByte };
  }, [containerRef]);

  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      // Don't dismiss if clicking inside the toolbar
      if (toolbarRef.current?.contains(e.target as Node)) return;

      const sel = window.getSelection();
      console.log("[TextSelector] mouseup, selection:", sel?.toString().slice(0, 30), "collapsed:", sel?.isCollapsed);
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelection(null);
        return;
      }

      const container = containerRef.current;
      if (!container) { console.log("[TextSelector] no container ref"); return; }

      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        console.log("[TextSelector] selection outside container");
        setSelection(null);
        return;
      }

      const byteRange = getByteRange(sel);
      console.log("[TextSelector] byteRange:", byteRange);
      if (!byteRange) { setSelection(null); return; }

      const rect = range.getBoundingClientRect();
      setSelection({ ...byteRange, rect });
      setShowCommentInput(false);
      setCommentText("");
    };

    // Dismiss on mousedown outside toolbar and container
    const handleMouseDown = (e: MouseEvent) => {
      if (toolbarRef.current?.contains(e.target as Node)) return;
      if (containerRef.current?.contains(e.target as Node)) return;
      setSelection(null);
    };

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [containerRef, getByteRange]);

  const handleEmoji = useCallback((emoji: string) => {
    if (!selection) return;
    onComment(selection.byteStart, selection.byteEnd, emoji);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection, onComment]);

  const handleSubmitComment = useCallback(() => {
    if (!selection || !commentText.trim()) return;
    onComment(selection.byteStart, selection.byteEnd, commentText.trim());
    setSelection(null);
    setShowCommentInput(false);
    setCommentText("");
    window.getSelection()?.removeAllRanges();
  }, [selection, commentText, onComment]);

  if (!selection || !did) return null;

  // Use fixed positioning (viewport coordinates) — immune to scroll
  const top = selection.rect.top - 44;
  const left = selection.rect.left + selection.rect.width / 2;

  return (
    <div
      ref={toolbarRef}
      className="fixed z-50 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl p-1 flex items-center gap-0.5"
      style={{ top, left, transform: "translateX(-50%)" }}
    >
      {!showCommentInput ? (
        <>
          {QUICK_EMOJI.map((emoji) => (
            <button
              key={emoji}
              onClick={() => handleEmoji(emoji)}
              className="w-8 h-8 flex items-center justify-center hover:bg-neutral-700 rounded text-base"
            >{emoji}</button>
          ))}
          <div className="w-px h-6 bg-neutral-700 mx-0.5" />
          <button
            onClick={() => setShowCommentInput(true)}
            className="px-2 h-8 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 rounded"
          >Comment</button>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); handleSubmitComment(); }} className="flex items-center gap-1">
          <input
            type="text"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Add a comment..."
            className="bg-neutral-900 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-200 w-48 focus:outline-none"
            autoFocus
          />
          <button type="submit" className="text-xs text-neutral-400 hover:text-neutral-200 px-1">Post</button>
        </form>
      )}
    </div>
  );
}
