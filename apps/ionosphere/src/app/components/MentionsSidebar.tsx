"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useTimestamp } from "@/app/components/TimestampProvider";

export interface Mention {
  uri: string;
  author_handle: string;
  author_display_name: string;
  author_avatar_url: string;
  text: string;
  created_at: string;
  talk_offset_ms: number | null;
  byte_position: number | null;
  likes: number;
  reposts: number;
  replies: number;
  mention_type: string;
  thread?: Mention[];
}

interface MentionsSidebarProps {
  mentions: Mention[];
  words: any[];
}

function formatOffset(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function MentionCard({
  mention,
  isActive,
  onSeek,
}: {
  mention: Mention;
  isActive: boolean;
  onSeek: (ms: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isDuringTalk = mention.talk_offset_ms != null;

  return (
    <div
      className={`p-2 rounded cursor-pointer transition-colors border-l-2 ${
        isActive
          ? "bg-blue-500/10 border-l-blue-400"
          : "bg-neutral-900/50 border-l-neutral-700 hover:bg-neutral-800/50"
      }`}
      onClick={() => {
        if (isDuringTalk && mention.talk_offset_ms != null) {
          onSeek(mention.talk_offset_ms);
        }
      }}
    >
      {/* Author row */}
      <div className="flex items-center gap-1.5 mb-1">
        {mention.author_avatar_url ? (
          <img
            src={mention.author_avatar_url}
            alt=""
            className="w-4 h-4 rounded-full shrink-0"
          />
        ) : (
          <div className="w-4 h-4 rounded-full bg-neutral-700 shrink-0" />
        )}
        <span className="text-[10px] text-blue-400 truncate">
          @{mention.author_handle}
        </span>
        {isDuringTalk && mention.talk_offset_ms != null && (
          <span className="text-[10px] text-neutral-500 ml-auto shrink-0">
            {formatOffset(mention.talk_offset_ms)}
          </span>
        )}
      </div>

      {/* Post text */}
      <p className="text-[11px] text-neutral-300 line-clamp-3 leading-relaxed">
        {mention.text}
      </p>

      {/* Metrics row */}
      <div className="flex items-center gap-3 mt-1">
        {mention.likes > 0 && (
          <span className="text-[10px] text-neutral-500">
            ♥ {mention.likes}
          </span>
        )}
        {mention.reposts > 0 && (
          <span className="text-[10px] text-neutral-500">
            ↻ {mention.reposts}
          </span>
        )}
        {mention.thread && mention.thread.length > 0 && (
          <button
            className="text-[10px] text-neutral-500 hover:text-neutral-300 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            {expanded ? "▾" : "▸"} {mention.thread.length}{" "}
            {mention.thread.length === 1 ? "reply" : "replies"}
          </button>
        )}
      </div>

      {/* Thread expansion */}
      {expanded && mention.thread && mention.thread.length > 0 && (
        <div className="mt-1.5 pl-3 border-l border-neutral-700 flex flex-col gap-1">
          {mention.thread.map((reply) => (
            <div key={reply.uri} className="p-1.5 rounded bg-neutral-900/30">
              <div className="flex items-center gap-1.5 mb-0.5">
                {reply.author_avatar_url ? (
                  <img
                    src={reply.author_avatar_url}
                    alt=""
                    className="w-3 h-3 rounded-full shrink-0"
                  />
                ) : (
                  <div className="w-3 h-3 rounded-full bg-neutral-700 shrink-0" />
                )}
                <span className="text-[10px] text-blue-400 truncate">
                  @{reply.author_handle}
                </span>
              </div>
              <p className="text-[10px] text-neutral-400 line-clamp-3 leading-relaxed">
                {reply.text}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MentionsSidebar({ mentions }: MentionsSidebarProps) {
  const { currentTimeNs, seekTo } = useTimestamp();
  const containerRef = useRef<HTMLDivElement>(null);

  const currentTimeMs = currentTimeNs / 1_000_000;

  const { duringTalk, postConference } = useMemo(() => {
    const during: Mention[] = [];
    const post: Mention[] = [];
    for (const m of mentions) {
      if (m.talk_offset_ms != null) {
        during.push(m);
      } else {
        post.push(m);
      }
    }
    during.sort((a, b) => (a.talk_offset_ms ?? 0) - (b.talk_offset_ms ?? 0));
    post.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    return { duringTalk: during, postConference: post };
  }, [mentions]);

  // Find active mention — closest during-talk mention at or before current time
  const activeUri = useMemo(() => {
    if (duringTalk.length === 0) return null;
    let closest: Mention | null = null;
    for (const m of duringTalk) {
      if ((m.talk_offset_ms ?? 0) <= currentTimeMs) {
        closest = m;
      }
    }
    return closest?.uri ?? duringTalk[0]?.uri ?? null;
  }, [duringTalk, currentTimeMs]);

  // Auto-scroll to active mention
  useEffect(() => {
    if (!activeUri || !containerRef.current) return;
    const el = containerRef.current.querySelector(
      `[data-mention-uri="${CSS.escape(activeUri)}"]`
    );
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeUri]);

  const handleSeek = (ms: number) => {
    seekTo(ms * 1_000_000);
  };

  if (mentions.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-500 text-xs">
        No mentions found for this talk.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-1 overflow-y-auto">
      {duringTalk.map((m) => (
        <div key={m.uri} data-mention-uri={m.uri}>
          <MentionCard
            mention={m}
            isActive={m.uri === activeUri}
            onSeek={handleSeek}
          />
        </div>
      ))}

      {postConference.length > 0 && (
        <>
          <div className="flex items-center gap-2 my-2">
            <div className="flex-1 h-px bg-neutral-700" />
            <span className="text-[10px] text-neutral-500 shrink-0">
              After the conference
            </span>
            <div className="flex-1 h-px bg-neutral-700" />
          </div>
          {postConference.map((m) => (
            <div key={m.uri} data-mention-uri={m.uri}>
              <MentionCard
                mention={m}
                isActive={false}
                onSeek={handleSeek}
              />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
