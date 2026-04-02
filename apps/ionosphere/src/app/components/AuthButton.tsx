"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth";

export default function AuthButton() {
  const { did, handle, loading, signIn, signOut } = useAuth();
  const [inputHandle, setInputHandle] = useState("");
  const [showInput, setShowInput] = useState(false);

  if (loading) return null;

  if (did) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-400 hidden sm:inline">
          {handle || did.slice(0, 20) + "..."}
        </span>
        <button
          onClick={signOut}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          Sign out
        </button>
      </div>
    );
  }

  if (showInput) {
    return (
      <div className="relative">
        <div className="absolute right-0 top-full mt-1 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-3 z-50 w-72">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (inputHandle) {
                sessionStorage.setItem("auth_return_to", window.location.pathname);
                signIn(inputHandle);
              }
            }}
          >
            <div className="flex items-center gap-1.5 mb-2">
              <input
                type="text"
                value={inputHandle}
                onChange={(e) => setInputHandle(e.target.value)}
                placeholder="handle.bsky.social"
                className="flex-1 bg-neutral-800 border border-neutral-600 rounded px-2 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-neutral-400"
                autoFocus
              />
              <button type="submit" className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1.5 bg-neutral-800 rounded border border-neutral-600">
                Sign in
              </button>
              <button type="button" onClick={() => setShowInput(false)} className="text-xs text-neutral-600 px-1">
                ✕
              </button>
            </div>
            <p className="text-[10px] text-neutral-600 leading-snug">
              Sign in with your Bluesky or AT Protocol account to leave comments and reactions. Your credentials stay in your browser — nothing is stored on our servers. Comments are saved to your own personal data server.
            </p>
          </form>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => setShowInput(true)}
      className="text-xs text-neutral-500 hover:text-neutral-300"
    >
      Sign in to comment
    </button>
  );
}
