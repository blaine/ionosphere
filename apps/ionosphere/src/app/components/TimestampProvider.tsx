"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface TimestampContextValue {
  currentTimeNs: number;
  setCurrentTimeNs: (ns: number) => void;
  seekTo: (ns: number) => void;
  onSeek: (handler: (ns: number) => void) => () => void;
}

const TimestampContext = createContext<TimestampContextValue | null>(null);

export function useTimestamp() {
  const ctx = useContext(TimestampContext);
  if (!ctx) throw new Error("useTimestamp must be used within TimestampProvider");
  return ctx;
}

export function TimestampProvider({ children }: { children: ReactNode }) {
  const [currentTimeNs, setCurrentTimeNs] = useState(0);
  const [seekHandlers] = useState<Set<(ns: number) => void>>(new Set());

  const seekTo = useCallback((ns: number) => {
    for (const handler of seekHandlers) { handler(ns); }
  }, [seekHandlers]);

  const onSeek = useCallback((handler: (ns: number) => void) => {
    seekHandlers.add(handler);
    return () => seekHandlers.delete(handler);
  }, [seekHandlers]);

  return (
    <TimestampContext.Provider value={{ currentTimeNs, setCurrentTimeNs, seekTo, onSeek }}>
      {children}
    </TimestampContext.Provider>
  );
}
