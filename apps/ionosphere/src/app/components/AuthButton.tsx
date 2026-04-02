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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (inputHandle) {
            sessionStorage.setItem("auth_return_to", window.location.pathname);
            signIn(inputHandle);
          }
        }}
        className="flex items-center gap-1"
      >
        <input
          type="text"
          value={inputHandle}
          onChange={(e) => setInputHandle(e.target.value)}
          placeholder="handle.bsky.social"
          className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-200 w-40 focus:outline-none focus:border-neutral-500"
          autoFocus
        />
        <button type="submit" className="text-xs text-neutral-400 hover:text-neutral-200">
          Go
        </button>
        <button type="button" onClick={() => setShowInput(false)} className="text-xs text-neutral-600">
          ✕
        </button>
      </form>
    );
  }

  return (
    <button
      onClick={() => setShowInput(true)}
      className="text-xs text-neutral-500 hover:text-neutral-300"
    >
      Sign in
    </button>
  );
}
