"use client";

import { useTimestamp } from "./TimestampProvider";
import { useRef, useEffect, useMemo, useCallback, forwardRef, useState } from "react";
import {
  extractData,
  brightnessAtTime,
  toColor,
  type TranscriptDocument,
  type WordSpan,
  type ConceptSpan,
} from "@/lib/transcript";
import { useAuth } from "@/lib/auth";
import { publishComment, type CommentData } from "@/lib/comments";
import TextSelector from "./TextSelector";

interface TranscriptViewProps {
  document: TranscriptDocument;
  comments?: CommentData[];
  transcriptUri?: string;
  onCommentPublished?: () => void;
}

const WordSpanComponent = forwardRef<
  HTMLSpanElement,
  {
    word: WordSpan;
    concept: ConceptSpan | null;
    currentTimeNs: number;
    onSeek: (ns: number) => void;
    hasComment?: boolean;
  }
>(function WordSpanComponent({ word, concept, currentTimeNs, onSeek, hasComment }, ref) {
  // Brightness at shared boundary times — guaranteed continuous with neighbors
  const startB = brightnessAtTime(currentTimeNs, word.boundaryStartTime);
  const endB = brightnessAtTime(currentTimeNs, word.boundaryEndTime);

  // The gradient must reach endColor at the last VISIBLE character, not
  // at the end of the span. With background-clip:text, the trailing space
  // is invisible (no glyph shape), so if the gradient is still interpolating
  // through the space, the last visible pixel undershoots endColor.
  //
  // Fix: multi-stop gradient that reaches endColor at calc(100% - 0.35em)
  // (≈ where the space begins), then holds endColor through the space.
  // The space is invisible anyway, so the held color doesn't matter — what
  // matters is that the last visible character is at endColor, matching
  // the next word's startColor exactly.
  const startColor = toColor(startB, concept);
  const endColor = toColor(endB, concept);

  const style: React.CSSProperties = {
    backgroundImage: `linear-gradient(to right, ${startColor}, ${endColor} calc(100% - 0.35em), ${endColor})`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    WebkitTextFillColor: "transparent",
  };

  const commentClass = hasComment ? " border-b border-blue-500/30" : "";

  return (
    <span
      ref={ref}
      data-byte-start={word.byteStart}
      data-byte-end={word.byteEnd}
      onClick={() => onSeek(word.startTime)}
      className={`cursor-pointer${concept ? " underline decoration-amber-500/30 underline-offset-2" : ""}${commentClass}`}
      style={style}
      title={concept ? concept.conceptName : undefined}
    >
      {word.text}{" "}
    </span>
  );
});

export default function TranscriptView({ document, comments, transcriptUri, onCommentPublished }: TranscriptViewProps) {
  const { currentTimeNs, paused, seekTo } = useTimestamp();
  const { agent } = useAuth();
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
  // Auto-scroll: continuously position based on currentTimeNs.
  // Uses an animation loop that eases toward the target scroll position
  // for buttery smooth movement between timeupdate events.
  const scrollTarget = useRef<number | null>(null);
  const animFrameId = useRef<number>(0);

  // Compute the desired scroll target whenever time changes.
  //
  // The key insight: we need a CONTINUOUS time→Y mapping with no jumps.
  // Text lines have gaps between them (line spacing), but speech is
  // continuous across those gaps. If we just interpolate within each line
  // and jump between them, the target Y is discontinuous at line boundaries.
  //
  // Fix: split each inter-line gap at its midpoint. Each line's Y range
  // extends from the midpoint of the gap above to the midpoint of the gap
  // below. This creates a seamless, continuous mapping — line N's extended
  // bottom == line N+1's extended top.
  useEffect(() => {
    const sel = window.getSelection?.();
    if (userScrolling.current || (sel && !sel.isCollapsed)) return;
    const container = containerRef.current;
    if (!container || currentTimeNs <= 0) return;

    // Build line map
    const lineMap = new Map<number, { startTime: number; endTime: number; bottom: number }>();
    for (const [idx, el] of wordRefsMap.current) {
      if (idx >= words.length) continue;
      const rect = el.getBoundingClientRect();
      const top = Math.round(rect.top);
      const existing = lineMap.get(top);
      if (existing) {
        existing.startTime = Math.min(existing.startTime, words[idx].startTime);
        existing.endTime = Math.max(existing.endTime, words[idx].endTime);
        existing.bottom = Math.max(existing.bottom, rect.bottom);
      } else {
        lineMap.set(top, {
          startTime: words[idx].startTime,
          endTime: words[idx].endTime,
          bottom: rect.bottom,
        });
      }
    }
    const rawLines = [...lineMap.entries()]
      .map(([top, v]) => ({ top, bottom: v.bottom, startTime: v.startTime, endTime: v.endTime }))
      .sort((a, b) => a.top - b.top);

    if (rawLines.length === 0) return;

    // Build continuous segments by splitting inter-line gaps at midpoints
    const segments: Array<{ yStart: number; yEnd: number; timeStart: number; timeEnd: number }> = [];
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const yStart = i === 0
        ? line.top
        : (rawLines[i - 1].bottom + line.top) / 2; // midpoint of gap above
      const yEnd = i === rawLines.length - 1
        ? line.bottom
        : (line.bottom + rawLines[i + 1].top) / 2; // midpoint of gap below
      segments.push({
        yStart,
        yEnd,
        timeStart: line.startTime,
        timeEnd: line.endTime,
      });
    }

    const containerRect = container.getBoundingClientRect();
    const playheadY = containerRect.top + containerRect.height * 0.33;

    let targetY: number | null = null;
    for (const seg of segments) {
      if (currentTimeNs >= seg.timeStart && currentTimeNs <= seg.timeEnd) {
        const frac = (currentTimeNs - seg.timeStart) / (seg.timeEnd - seg.timeStart);
        targetY = seg.yStart + frac * (seg.yEnd - seg.yStart);
        break;
      }
      if (currentTimeNs < seg.timeStart) {
        targetY = seg.yStart;
        break;
      }
    }
    if (targetY === null) {
      const last = segments[segments.length - 1];
      targetY = last.yEnd;
    }

    scrollTarget.current = container.scrollTop + (targetY - playheadY);
  }, [currentTimeNs, words]);

  // Animation loop: ease toward scrollTarget
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const LERP = 0.15; // easing factor — higher = snappier

    const animate = () => {
      // Check selection state directly every frame — more reliable than selectionchange event
      const sel = window.getSelection?.();
      const hasSelection = !!(sel && !sel.isCollapsed);

      if (!userScrolling.current && !hasSelection && scrollTarget.current !== null) {
        const diff = scrollTarget.current - container.scrollTop;
        if (Math.abs(diff) > 0.5) {
          container.scrollTop += diff * LERP;
        }
      }
      animFrameId.current = requestAnimationFrame(animate);
    };

    animFrameId.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameId.current);
  }, []);

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

    // Detect real user scrolls via wheel/touch, not scroll events
    // (scroll events fire for both user and programmatic scrolls)
    let userInitiated = false;

    const onWheel = () => { userInitiated = true; };
    // Only touchmove triggers scroll-scrub, not touchstart.
    // A tap (touchstart without move) should not seek — it's for
    // clicking words or play/pause.
    const onTouchMove = () => { userInitiated = true; };

    const onScroll = () => {
      if (!userInitiated) return; // ignore programmatic scrolls entirely

      userScrolling.current = true;

      // Reset the "hand back to auto-scroll" timer
      clearTimeout(userScrollTimer.current);
      userScrollTimer.current = setTimeout(() => {
        userScrolling.current = false;
      }, paused ? 999999 : 2000);

      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        findWordAtPlayhead();
        userInitiated = false; // consumed
      });
    };

    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchmove", onTouchMove);
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

  const wordHasComment = useMemo(() => {
    if (allComments.length === 0) return new Set<number>();
    const set = new Set<number>();
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const has = allComments.some(c =>
        c.byte_start !== null && c.byte_end !== null &&
        c.byte_start < word.byteEnd && c.byte_end > word.byteStart
      );
      if (has) set.add(i);
    }
    return set;
  }, [words, allComments]);

  // Group comments by byte range for margin indicators
  // Key: "byteStart-byteEnd", Value: { emoji counts, text comments }
  const reactionGroups = useMemo(() => {
    if (allComments.length === 0) return new Map<string, { emojis: Map<string, number>; texts: CommentData[]; byteStart: number; byteEnd: number }>();
    const groups = new Map<string, { emojis: Map<string, number>; texts: CommentData[]; byteStart: number; byteEnd: number }>();
    for (const c of allComments) {
      if (c.byte_start === null || c.byte_end === null) continue;
      const key = `${c.byte_start}-${c.byte_end}`;
      if (!groups.has(key)) {
        groups.set(key, { emojis: new Map(), texts: [], byteStart: c.byte_start, byteEnd: c.byte_end });
      }
      const group = groups.get(key)!;
      const isEmoji = c.text.length <= 2 && !/[a-zA-Z]/.test(c.text);
      if (isEmoji) {
        group.emojis.set(c.text, (group.emojis.get(c.text) || 0) + 1);
      } else {
        group.texts.push(c);
      }
    }
    return groups;
  }, [allComments]);

  // Track if user is selecting text — pause auto-scroll
  const userSelecting = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined" || !document?.addEventListener) return;
    const onSelectionChange = () => {
      const sel = window.getSelection?.();
      const hasSelection = !!(sel && !sel.isCollapsed);
      userSelecting.current = hasSelection;
      // Clear scroll target when selecting to fully stop auto-scroll
      if (hasSelection) scrollTarget.current = null;
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  // Expanded reaction group (which span's comments are shown)
  const [expandedSpan, setExpandedSpan] = useState<string | null>(null);

  // Optimistic comments — rendered immediately before the round-trip completes
  const [pendingComments, setPendingComments] = useState<CommentData[]>([]);

  // Merge server comments + pending, dedup by text+anchor
  const allComments = useMemo(() => {
    if (pendingComments.length === 0) return comments || [];
    const serverUris = new Set((comments || []).map((c) => c.uri));
    // Remove pending comments that have arrived from the server
    const stillPending = pendingComments.filter((p) => !serverUris.has(p.uri));
    return [...(comments || []), ...stillPending];
  }, [comments, pendingComments]);

  const handlePublish = useCallback(async (byteStart: number, byteEnd: number, text: string) => {
    if (!agent || !transcriptUri) return;

    // Optimistic: add immediately
    const optimisticComment: CommentData = {
      uri: `pending-${Date.now()}`,
      author_did: agent.assertDid,
      rkey: "",
      subject_uri: transcriptUri,
      text,
      facets: null,
      byte_start: byteStart,
      byte_end: byteEnd,
      created_at: new Date().toISOString(),
    };
    setPendingComments((prev) => [...prev, optimisticComment]);

    try {
      const uri = await publishComment(agent, transcriptUri, text, { byteStart, byteEnd });
      // Update the pending comment with the real URI so dedup works
      setPendingComments((prev) =>
        prev.map((p) => (p === optimisticComment ? { ...p, uri } : p))
      );
      onCommentPublished?.();
    } catch (err) {
      console.error("Failed to publish comment:", err);
    }
  }, [agent, transcriptUri, onCommentPublished]);

  return (
    <div
      ref={containerRef}
      className="relative h-full p-4 rounded-lg border border-neutral-800 overflow-y-auto leading-relaxed select-text"
    >
      <TextSelector containerRef={containerRef} onComment={handlePublish} wordSpans={words} />
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
      {/* Top spacer: pushes first word down to the playhead (33% mark) */}
      <div style={{ height: "calc(33% + 1rem)" }} />
      {words.map((word, i) => (
        <WordSpanComponent
          key={i}
          ref={(el) => setWordRef(i, el)}
          word={word}
          concept={wordConcepts[i]?.[0] || null}
          currentTimeNs={currentTimeNs}
          onSeek={handleSeek}
          hasComment={wordHasComment.has(i)}
        />
      ))}
      {/* Reaction margin indicators */}
      {[...reactionGroups.entries()].map(([key, group]) => {
        // Find the first word span that overlaps this range to position the indicator
        const firstWordIdx = words.findIndex(
          (w) => w.byteStart < group.byteEnd && w.byteEnd > group.byteStart
        );
        const el = firstWordIdx >= 0 ? wordRefsMap.current.get(firstWordIdx) : null;
        if (!el) return null;

        const emojiStr = [...group.emojis.entries()]
          .map(([emoji, count]) => (count > 1 ? `${emoji}${count}` : emoji))
          .join("");
        const hasTexts = group.texts.length > 0;
        const isExpanded = expandedSpan === key;

        return (
          <div
            key={key}
            className="absolute right-1 z-20"
            style={{ top: el.offsetTop - 2 }}
          >
            <button
              onClick={() => setExpandedSpan(isExpanded ? null : key)}
              className="text-[11px] bg-neutral-900/80 border border-neutral-700/50 rounded-full px-1.5 py-0.5 hover:bg-neutral-800 transition-colors"
              title={`${group.emojis.size + group.texts.length} reactions`}
            >
              {emojiStr || "💬"}
              {hasTexts && !emojiStr && group.texts.length}
            </button>
            {isExpanded && (
              <div className="absolute right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl p-2 min-w-[200px] max-w-[300px] z-50">
                {group.emojis.size > 0 && (
                  <div className="flex gap-1 flex-wrap mb-1">
                    {[...group.emojis.entries()].map(([emoji, count]) => (
                      <span key={emoji} className="text-sm">
                        {emoji}{count > 1 && <span className="text-[10px] text-neutral-500">{count}</span>}
                      </span>
                    ))}
                  </div>
                )}
                {group.texts.map((c) => (
                  <div key={c.uri} className="text-[12px] text-neutral-300 border-t border-neutral-700 pt-1 mt-1">
                    <span className="text-neutral-500">{c.author_did.slice(8, 24)}...</span>
                    <p>{c.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {/* Bottom spacer: lets last word scroll up to the playhead (33% mark) */}
      <div style={{ height: "calc(67% + 1rem)" }} />
    </div>
  );
}
