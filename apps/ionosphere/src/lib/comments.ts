import type { Agent } from "@atproto/api";

export async function publishComment(
  agent: Agent,
  subject: string,
  text: string,
  anchor?: { byteStart: number; byteEnd: number }
): Promise<string> {
  const record: Record<string, unknown> = {
    $type: "tv.ionosphere.comment",
    subject,
    text,
    createdAt: new Date().toISOString(),
  };
  if (anchor) {
    record.anchor = anchor;
  }

  const result = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: "tv.ionosphere.comment",
    record,
  });

  return result.data.uri;
}

export interface CommentData {
  uri: string;
  author_did: string;
  author_handle?: string | null;
  author_display_name?: string | null;
  author_avatar_url?: string | null;
  rkey: string;
  subject_uri: string;
  text: string;
  facets: string | null;
  byte_start: number | null;
  byte_end: number | null;
  created_at: string;
}

/** Returns true if the text is an emoji reaction (not a text comment). */
export function isEmojiReaction(text: string): boolean {
  return text.length <= 2 && !/[a-zA-Z]/.test(text);
}

export async function fetchComments(talkRkey: string): Promise<CommentData[]> {
  const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
  const res = await fetch(`${API_BASE}/xrpc/tv.ionosphere.getComments?talkRkey=${encodeURIComponent(talkRkey)}`);
  if (!res.ok) return [];
  const { comments } = await res.json();
  return comments;
}

export async function fetchReplies(commentUri: string): Promise<CommentData[]> {
  const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
  const res = await fetch(`${API_BASE}/xrpc/tv.ionosphere.getComments?subject=${encodeURIComponent(commentUri)}`);
  if (!res.ok) return [];
  const { comments } = await res.json();
  return comments;
}
