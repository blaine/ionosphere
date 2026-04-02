"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import { Agent } from "@atproto/api";

interface AuthState {
  agent: Agent | null;
  did: string | null;
  handle: string | null;
  loading: boolean;
  signIn: (handle: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

let _oauthClientPromise: Promise<BrowserOAuthClient> | null = null;

function getOAuthClient(): Promise<BrowserOAuthClient> {
  if (!_oauthClientPromise) {
    const origin = window.location.origin;
    const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
    // Loopback client ID: http://localhost?scope=atproto&redirect_uri=...
    // Must be exactly "http://localhost" with params in query string (no port, no path).
    // Production: full URL to client-metadata.json
    const clientId = isLocalhost
      ? `http://localhost?scope=${encodeURIComponent("atproto repo:tv.ionosphere.comment")}&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${window.location.port}/auth/callback`)}`
      : `${origin}/client-metadata.json`;

    _oauthClientPromise = BrowserOAuthClient.load({
      clientId,
      handleResolver: "https://bsky.social",
    });
  }
  return _oauthClientPromise;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [did, setDid] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // AT Protocol OAuth requires 127.0.0.1 for loopback, not localhost
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hostname === "localhost") {
      window.location.replace(
        window.location.href.replace("localhost", "127.0.0.1")
      );
    }
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hostname === "localhost") return;
    async function restore() {
      try {
        const client = await getOAuthClient();
        const result = await client.init();
        if (result?.session) {
          const newAgent = new Agent(result.session);
          setAgent(newAgent);
          setDid(result.session.did);
          // Fetch profile from public API (no auth needed)
          try {
            const res = await fetch(
              `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(result.session.did)}`
            );
            if (res.ok) {
              const profile = await res.json();
              setHandle(profile.handle);
            }
          } catch {}
        }
      } catch (err) {
        console.error("Auth restore error:", err);
      } finally {
        setLoading(false);
      }
    }
    restore();
  }, []);

  const signIn = useCallback(async (userHandle: string) => {
    const client = await getOAuthClient();
        await client.signIn(userHandle, {
      scope: "atproto repo:tv.ionosphere.comment",
    });
  }, []);

  const signOut = useCallback(async () => {
    setAgent(null);
    setDid(null);
    setHandle(null);
  }, []);

  return (
    <AuthContext.Provider value={{ agent, did, handle, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
