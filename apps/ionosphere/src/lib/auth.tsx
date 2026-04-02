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
    // Localhost uses loopback client ID (just the origin, no path).
    // Production uses the client-metadata.json URL.
    const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
    const clientId = isLocalhost ? origin : `${origin}/client-metadata.json`;

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

  useEffect(() => {
    async function restore() {
      try {
        const client = await getOAuthClient();
        const result = await client.init();
        if (result?.session) {
          const newAgent = new Agent(result.session);
          setAgent(newAgent);
          setDid(result.session.did);
          try {
            const profile = await newAgent.getProfile({ actor: result.session.did });
            setHandle(profile.data.handle);
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
    await client.signIn(userHandle, { scope: "atproto" });
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
