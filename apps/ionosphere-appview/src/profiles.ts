import type Database from "better-sqlite3";

const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const PUBLIC_API = "https://public.api.bsky.app";

export interface Profile {
  did: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

/**
 * Get a cached profile or fetch from public API.
 * Returns null only on fetch failure for unknown DIDs.
 */
export async function resolveProfile(
  db: Database.Database,
  did: string
): Promise<Profile | null> {
  const cached = db
    .prepare("SELECT * FROM profiles WHERE did = ?")
    .get(did) as any;

  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < PROFILE_MAX_AGE_MS) {
      return {
        did: cached.did,
        handle: cached.handle,
        display_name: cached.display_name,
        avatar_url: cached.avatar_url,
      };
    }
  }

  try {
    const res = await fetch(
      `${PUBLIC_API}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
    );
    if (!res.ok) return cached || null;
    const data = await res.json();

    const profile: Profile = {
      did,
      handle: data.handle || null,
      display_name: data.displayName || null,
      avatar_url: data.avatar || null,
    };

    db.prepare(
      `INSERT OR REPLACE INTO profiles (did, handle, display_name, avatar_url, fetched_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(did, profile.handle, profile.display_name, profile.avatar_url, new Date().toISOString());

    return profile;
  } catch {
    return cached || null;
  }
}

/**
 * Fire-and-forget profile resolution. Call when indexing a comment
 * from a DID we haven't seen. Does not block the caller.
 */
export function ensureProfile(db: Database.Database, did: string): void {
  const existing = db
    .prepare("SELECT fetched_at FROM profiles WHERE did = ?")
    .get(did) as any;
  if (existing) {
    const age = Date.now() - new Date(existing.fetched_at).getTime();
    if (age < PROFILE_MAX_AGE_MS) return;
  }
  resolveProfile(db, did).catch(() => {});
}
