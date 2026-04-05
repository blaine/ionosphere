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

export async function getIndex() {
  return fetchApi<{ entries: any[] }>("/xrpc/tv.ionosphere.getConcordance");
}

export async function getConceptClusters() {
  return fetchApi<{ clusters: any[] }>("/xrpc/tv.ionosphere.getConceptClusters");
}

export async function getTracks() {
  return fetchApi<{ tracks: any[] }>("/xrpc/tv.ionosphere.getTracks");
}

export async function getTrack(stream: string) {
  return fetchApi<any>(`/xrpc/tv.ionosphere.getTrack?stream=${encodeURIComponent(stream)}`);
}
