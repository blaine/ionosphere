"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { publishComment, type CommentData } from "@/lib/comments";

interface CommentPanelProps {
  comments: CommentData[];
  subjectUri: string;
  onCommentPublished?: () => void;
}

export default function CommentPanel({ comments, subjectUri, onCommentPublished }: CommentPanelProps) {
  const { agent, did, handle } = useAuth();
  const [newComment, setNewComment] = useState("");
  const [posting, setPosting] = useState(false);

  // Separate emoji reactions from text comments
  const reactions = comments.filter((c) => c.text.length <= 2 && !c.text.match(/[a-zA-Z]/));
  const textComments = comments.filter((c) => c.text.length > 2 || c.text.match(/[a-zA-Z]/));

  // Group emoji counts
  const emojiCounts = new Map<string, number>();
  for (const r of reactions) {
    emojiCounts.set(r.text, (emojiCounts.get(r.text) || 0) + 1);
  }

  const handlePost = async () => {
    if (!agent || !newComment.trim()) return;
    setPosting(true);
    try {
      await publishComment(agent, subjectUri, newComment.trim());
      setNewComment("");
      onCommentPublished?.();
    } catch (err) {
      console.error("Failed to post comment:", err);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="p-3 text-sm">
      <h3 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-2">
        Comments ({comments.length})
      </h3>

      {/* Emoji reaction summary */}
      {emojiCounts.size > 0 && (
        <div className="flex gap-1.5 mb-3 flex-wrap">
          {[...emojiCounts.entries()].map(([emoji, count]) => (
            <span key={emoji} className="bg-neutral-800 rounded-full px-2 py-0.5 text-xs border border-neutral-700">
              {emoji} {count > 1 && <span className="text-neutral-500">{count}</span>}
            </span>
          ))}
        </div>
      )}

      {/* Text comments */}
      {textComments.map((comment) => (
        <div key={comment.uri} className="mb-3 border-l-2 border-neutral-800 pl-3">
          <div className="text-xs text-neutral-500 mb-0.5">
            {comment.author_did.slice(8, 28)}...
          </div>
          <div className="text-neutral-300 text-[13px]">{comment.text}</div>
          <div className="text-xs text-neutral-600 mt-0.5">
            {new Date(comment.created_at).toLocaleDateString()}
          </div>
        </div>
      ))}

      {comments.length === 0 && (
        <p className="text-neutral-600 text-xs mb-3">No comments yet. Select text in the transcript to add one.</p>
      )}

      {/* New comment input */}
      {did ? (
        <div className="mt-3 border-t border-neutral-800 pt-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Add a comment on this talk..."
              className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handlePost(); } }}
              disabled={posting}
            />
            <button
              onClick={handlePost}
              disabled={posting || !newComment.trim()}
              className="text-xs px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-neutral-300 disabled:opacity-50"
            >
              {posting ? "..." : "Post"}
            </button>
          </div>
          <p className="text-[10px] text-neutral-600 mt-1">
            Posting as {handle || did.slice(0, 20) + "..."}
          </p>
        </div>
      ) : (
        <p className="text-xs text-neutral-600 mt-3 border-t border-neutral-800 pt-3">
          Sign in to comment
        </p>
      )}
    </div>
  );
}
