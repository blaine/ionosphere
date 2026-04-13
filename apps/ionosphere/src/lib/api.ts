const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`API error: ${res.status} ${path}`);
  return res.json();
}

export async function getTalks() {
  return fetchApi<{ talks: any[] }>("/xrpc/tv.ionosphere.getTalks");
}

export async function getTalk(rkey: string) {
  return fetchApi<{ talk: any; speakers: any[]; concepts: any[] }>(`/xrpc/tv.ionosphere.getTalk?rkey=${encodeURIComponent(rkey)}`);
}

export async function getSpeakers() {
  return fetchApi<{ speakers: any[] }>("/xrpc/tv.ionosphere.getSpeakers");
}

export async function getSpeaker(rkey: string) {
  return fetchApi<{ speaker: any; talks: any[] }>(`/xrpc/tv.ionosphere.getSpeaker?rkey=${encodeURIComponent(rkey)}`);
}

export async function getConcepts() {
  return fetchApi<{ concepts: any[] }>("/xrpc/tv.ionosphere.getConcepts");
}

export async function getConcept(rkey: string) {
  return fetchApi<{ concept: any; talks: any[] }>(`/xrpc/tv.ionosphere.getConcept?rkey=${encodeURIComponent(rkey)}`);
}

export async function getMentions(talkRkey: string) {
  return fetchApi<{ mentions: any[]; total: number }>(`/xrpc/tv.ionosphere.getMentions?talkRkey=${encodeURIComponent(talkRkey)}`);
}

export async function getIndex() {
  return fetchApi<{ entries: any[] }>("/xrpc/tv.ionosphere.getConcordance");
}

export async function getConceptClusters() {
  return fetchApi<{ clusters: any[] }>("/xrpc/tv.ionosphere.getConceptClusters");
}

export async function getDiscussion() {
  return fetchApi<{
    posts: any[];
    blogs: any[];
    videos: any[];
    photos: any[];
    projects: any[];
    vodSites: string[];
    stats: { totalPosts: number; blogCount: number; videoCount: number; photoCount: number; vodSiteCount: number; uniqueAuthors: number };
  }>("/xrpc/tv.ionosphere.getDiscussion");
}

export async function getTracks() {
  return fetchApi<{ tracks: any[] }>("/xrpc/tv.ionosphere.getTracks");
}

export async function getTrack(stream: string) {
  return fetchApi<any>(`/xrpc/tv.ionosphere.getTrack?stream=${encodeURIComponent(stream)}`);
}

export async function getCorrections(stream: string) {
  const res = await fetch(`${API_BASE}/xrpc/tv.ionosphere.getCorrections?stream=${encodeURIComponent(stream)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<{ corrections: any[] }>;
}

export async function saveCorrections(stream: string, corrections: any[]) {
  const res = await fetch(`${API_BASE}/xrpc/tv.ionosphere.putCorrections`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream, corrections }),
  });
  if (!res.ok) throw new Error(`Save failed: ${res.status}`);
  return res.json();
}
