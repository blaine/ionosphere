const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { next: { revalidate: false } });
  if (!res.ok) throw new Error(`API error: ${res.status} ${path}`);
  return res.json();
}

export async function getTalks() {
  return fetchApi<{ talks: any[] }>("/talks");
}

export async function getTalk(rkey: string) {
  return fetchApi<{ talk: any; speakers: any[]; concepts: any[] }>(`/talks/${rkey}`);
}

export async function getSpeakers() {
  return fetchApi<{ speakers: any[] }>("/speakers");
}

export async function getSpeaker(rkey: string) {
  return fetchApi<{ speaker: any; talks: any[] }>(`/speakers/${rkey}`);
}

export async function getConcepts() {
  return fetchApi<{ concepts: any[] }>("/concepts");
}

export async function getConcept(rkey: string) {
  return fetchApi<{ concept: any; talks: any[] }>(`/concepts/${rkey}`);
}
