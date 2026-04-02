"use client";

import { useState, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { publishComment, type CommentData, isEmojiReaction } from "@/lib/comments";

const QUICK_EMOJI = ["\u{1F525}", "\u{1F44F}", "\u{1F4A1}", "\u2753", "\u{1F4AF}", "\u2764\uFE0F"];

interface ReactionBarProps {
  subjectUri: string;
  comments: CommentData[];
  onCommentPublished?: () => void;
}

export default function ReactionBar({ subjectUri, comments, onCommentPublished }: ReactionBarProps) {
  const { agent, did } = useAuth();
  const [showInput, setShowInput] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);

  // Whole-talk reactions (unanchored emojis)
  const reactionCounts = new Map<string, number>();
  for (const c of comments) {
    if (c.byte_start === null && isEmojiReaction(c.text)) {
      reactionCounts.set(c.text, (reactionCounts.get(c.text) || 0) + 1);
    }
  }

  const handleEmoji = useCallback(async (emoji: string) => {
    if (!agent) return;
    try {
      await publishComment(agent, subjectUri, emoji);
      onCommentPublished?.();
    } catch (err) {
      console.error("Failed to post reaction:", err);
    }
    localStorage.setItem("has_commented", "1");
  }, [agent, subjectUri, onCommentPublished]);

  const handleSubmit = useCallback(async () => {
    if (!agent || !commentText.trim()) return;
    setPosting(true);
    try {
      await publishComment(agent, subjectUri, commentText.trim());
      setCommentText("");
      setShowInput(false);
      onCommentPublished?.();
    } catch (err) {
      console.error("Failed to post comment:", err);
    } finally {
      setPosting(false);
    }
    localStorage.setItem("has_commented", "1");
  }, [agent, subjectUri, commentText, onCommentPublished]);

  return (
    <div className="flex items-center gap-1 px-4 py-1.5 border-b border-neutral-800 bg-neutral-950/50">
      {/* Existing reaction counts */}
      {[...reactionCounts.entries()].map(([emoji, count]) => (
        <span key={emoji} className="text-xs bg-neutral-800 rounded-full px-1.5 py-0.5 border border-neutral-700">
          {emoji}{count > 1 && <span className="text-neutral-500 ml-0.5">{count}</span>}
        </span>
      ))}

      {/* Divider if there are existing reactions */}
      {reactionCounts.size > 0 && <div className="w-px h-4 bg-neutral-800 mx-1" />}

      {/* Quick emoji buttons (only shown when logged in) */}
      {did && (
        <>
          {QUICK_EMOJI.map((emoji) => (
            <button
              key={emoji}
              onClick={() => handleEmoji(emoji)}
              className="w-6 h-6 flex items-center justify-center hover:bg-neutral-800 rounded text-sm transition-colors"
            >{emoji}</button>
          ))}
          <div className="w-px h-4 bg-neutral-800 mx-1" />
          {!showInput ? (
            <button
              onClick={() => setShowInput(true)}
              className="text-xs text-neutral-500 hover:text-neutral-300 px-1.5 py-0.5 hover:bg-neutral-800 rounded transition-colors"
            >Comment</button>
          ) : (
            <form
              onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}
              className="flex items-center gap-1 flex-1 min-w-0"
            >
              <input
                type="text"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setShowInput(false); setCommentText(""); } }}
                placeholder="Add a comment..."
                className="flex-1 min-w-0 bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
                autoFocus
                disabled={posting}
              />
              <button
                type="submit"
                disabled={posting || !commentText.trim()}
                className="text-xs text-neutral-400 hover:text-neutral-200 px-1 disabled:opacity-50"
              >{posting ? "..." : "Post"}</button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
