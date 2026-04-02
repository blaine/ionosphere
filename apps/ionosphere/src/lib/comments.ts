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
  rkey: string;
  subject_uri: string;
  text: string;
  facets: string | null;
  byte_start: number | null;
  byte_end: number | null;
  created_at: string;
}

export async function fetchComments(talkRkey: string): Promise<CommentData[]> {
  const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
  const res = await fetch(`${API_BASE}/talks/${talkRkey}/comments`);
  if (!res.ok) return [];
  const { comments } = await res.json();
  return comments;
}

export async function fetchReplies(commentUri: string): Promise<CommentData[]> {
  const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:9401";
  const res = await fetch(`${API_BASE}/comments?subject=${encodeURIComponent(commentUri)}`);
  if (!res.ok) return [];
  const { comments } = await res.json();
  return comments;
}
