// apps/ionosphere/src/lib/timeline-engine.ts
"use client";

import {
  createContext,
  useContext,
  useReducer,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import {
  replayCorrections,
  type BaseTalk,
  type EffectiveTalk,
  type CorrectionEntry,
  type CorrectionAction,
} from "./corrections";
import {
  computeSnapTargets,
  findNearestSnap,
  type SnapTarget,
  type SnapResult,
} from "./snap-targets";

// --- Types ---

export type EditMode = "select" | "trim" | "split" | "add";

interface DragState {
  talkRkey: string;
  edge: "start" | "end";
  originalSeconds: number;
  currentSeconds: number;
}

interface EngineState {
  editingEnabled: boolean;
  mode: EditMode;
  selectedTalkRkey: string | null;
  activeDrag: DragState | null;
  corrections: CorrectionEntry[];
  undoCursor: number;
  savedCursor: number;
  streamSlug: string;
  baseTalks: BaseTalk[];
  authorDid?: string;
}

type EngineAction =
  | { type: "TOGGLE_EDITING" }
  | { type: "SET_MODE"; mode: EditMode }
  | { type: "SELECT_TALK"; rkey: string | null }
  | { type: "START_DRAG"; talkRkey: string; edge: "start" | "end"; seconds: number }
  | { type: "UPDATE_DRAG"; seconds: number }
  | { type: "COMMIT_DRAG" }
  | { type: "CANCEL_DRAG" }
  | { type: "APPLY_CORRECTION"; action: CorrectionAction }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "MARK_SAVED" }
  | { type: "LOAD_CORRECTIONS"; corrections: CorrectionEntry[] };

function generateId(): string {
  return crypto.randomUUID();
}

function engineReducer(state: EngineState, action: EngineAction): EngineState {
  switch (action.type) {
    case "TOGGLE_EDITING":
      return {
        ...state,
        editingEnabled: !state.editingEnabled,
        mode: "select",
        selectedTalkRkey: null,
        activeDrag: null,
      };

    case "SET_MODE":
      return { ...state, mode: action.mode, activeDrag: null };

    case "SELECT_TALK":
      return { ...state, selectedTalkRkey: action.rkey };

    case "START_DRAG":
      return {
        ...state,
        activeDrag: {
          talkRkey: action.talkRkey,
          edge: action.edge,
          originalSeconds: action.seconds,
          currentSeconds: action.seconds,
        },
      };

    case "UPDATE_DRAG":
      if (!state.activeDrag) return state;
      return {
        ...state,
        activeDrag: { ...state.activeDrag, currentSeconds: action.seconds },
      };

    case "COMMIT_DRAG": {
      if (!state.activeDrag) return state;
      const { talkRkey, edge, originalSeconds, currentSeconds } = state.activeDrag;
      if (Math.abs(originalSeconds - currentSeconds) < 0.05) {
        return { ...state, activeDrag: null };
      }
      const correction: CorrectionEntry = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        authorDid: state.authorDid,
        streamSlug: state.streamSlug,
        action: {
          type: "move_boundary",
          talkRkey,
          edge,
          fromSeconds: originalSeconds,
          toSeconds: currentSeconds,
        },
      };
      const corrections = [...state.corrections.slice(0, state.undoCursor), correction];
      return {
        ...state,
        corrections,
        undoCursor: corrections.length,
        activeDrag: null,
      };
    }

    case "CANCEL_DRAG":
      return { ...state, activeDrag: null };

    case "APPLY_CORRECTION": {
      const correction: CorrectionEntry = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        authorDid: state.authorDid,
        streamSlug: state.streamSlug,
        action: action.action,
      };
      const corrections = [...state.corrections.slice(0, state.undoCursor), correction];
      return { ...state, corrections, undoCursor: corrections.length };
    }

    case "UNDO":
      if (state.undoCursor <= 0) return state;
      return { ...state, undoCursor: state.undoCursor - 1 };

    case "REDO":
      if (state.undoCursor >= state.corrections.length) return state;
      return { ...state, undoCursor: state.undoCursor + 1 };

    case "MARK_SAVED":
      return { ...state, savedCursor: state.undoCursor };

    case "LOAD_CORRECTIONS":
      return {
        ...state,
        corrections: action.corrections,
        undoCursor: action.corrections.length,
        savedCursor: action.corrections.length,
      };

    default:
      return state;
  }
}

// --- Context ---

interface TimelineEngineContextValue {
  editingEnabled: boolean;
  mode: EditMode;
  selectedTalkRkey: string | null;
  activeDrag: DragState | null;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  effectiveTalks: EffectiveTalk[];
  speakerNames: Map<string, string>;
  snapTargets: SnapTarget[];
  windowStart: number;
  windowEnd: number;
  containerWidth: number;
  timeToPixel: (seconds: number) => number;
  pixelToTime: (px: number) => number;
  findSnap: (timeSeconds: number, edge: "start" | "end", radiusPx: number) => SnapResult | null;
  toggleEditing: () => void;
  setMode: (mode: EditMode) => void;
  selectTalk: (rkey: string | null) => void;
  startDrag: (talkRkey: string, edge: "start" | "end", seconds: number) => void;
  updateDrag: (seconds: number) => void;
  commitDrag: () => void;
  cancelDrag: () => void;
  applyCorrection: (action: CorrectionAction) => void;
  undo: () => void;
  redo: () => void;
  markSaved: () => void;
  getCorrectionsToSave: () => CorrectionEntry[];
}

const TimelineEngineContext = createContext<TimelineEngineContextValue | null>(null);

export function useTimelineEngine() {
  const ctx = useContext(TimelineEngineContext);
  if (!ctx) throw new Error("useTimelineEngine must be used within TimelineEngineProvider");
  return ctx;
}

// --- Provider ---

interface TimelineEngineProviderProps {
  children: ReactNode;
  streamSlug: string;
  baseTalks: BaseTalk[];
  words: Array<{ start: number; end: number; speaker: string }>;
  diarization: Array<{ start: number; end: number; speaker: string }>;
  initialCorrections?: CorrectionEntry[];
  authorDid?: string;
  windowStart: number;
  windowEnd: number;
  containerWidth: number;
}

export function TimelineEngineProvider({
  children,
  streamSlug,
  baseTalks,
  words,
  diarization,
  initialCorrections,
  authorDid,
  windowStart,
  windowEnd,
  containerWidth,
}: TimelineEngineProviderProps) {
  const [state, dispatch] = useReducer(engineReducer, {
    editingEnabled: false,
    mode: "select",
    selectedTalkRkey: null,
    activeDrag: null,
    corrections: initialCorrections ?? [],
    undoCursor: initialCorrections?.length ?? 0,
    savedCursor: initialCorrections?.length ?? 0,
    streamSlug,
    baseTalks,
    authorDid,
  });

  const { talks: effectiveTalks, speakerNames } = useMemo(
    () => replayCorrections(state.baseTalks, state.corrections, state.undoCursor),
    [state.baseTalks, state.corrections, state.undoCursor],
  );

  const snapTargets = useMemo(
    () => computeSnapTargets(words, diarization),
    [words, diarization],
  );

  const windowDuration = windowEnd - windowStart;
  const timeToPixel = useCallback(
    (seconds: number) => ((seconds - windowStart) / windowDuration) * containerWidth,
    [windowStart, windowDuration, containerWidth],
  );
  const pixelToTime = useCallback(
    (px: number) => windowStart + (px / containerWidth) * windowDuration,
    [windowStart, containerWidth, windowDuration],
  );

  const findSnap = useCallback(
    (timeSeconds: number, edge: "start" | "end", radiusPx: number) => {
      const radiusSeconds = (radiusPx / containerWidth) * windowDuration;
      return findNearestSnap(snapTargets, timeSeconds, edge, radiusSeconds);
    },
    [snapTargets, containerWidth, windowDuration],
  );

  const value: TimelineEngineContextValue = useMemo(() => ({
    editingEnabled: state.editingEnabled,
    mode: state.mode,
    selectedTalkRkey: state.selectedTalkRkey,
    activeDrag: state.activeDrag,
    isDirty: state.undoCursor !== state.savedCursor,
    canUndo: state.undoCursor > 0,
    canRedo: state.undoCursor < state.corrections.length,
    effectiveTalks,
    speakerNames,
    snapTargets,
    windowStart,
    windowEnd,
    containerWidth,
    timeToPixel,
    pixelToTime,
    findSnap,
    toggleEditing: () => dispatch({ type: "TOGGLE_EDITING" }),
    setMode: (mode: EditMode) => dispatch({ type: "SET_MODE", mode }),
    selectTalk: (rkey: string | null) => dispatch({ type: "SELECT_TALK", rkey }),
    startDrag: (talkRkey: string, edge: "start" | "end", seconds: number) =>
      dispatch({ type: "START_DRAG", talkRkey, edge, seconds }),
    updateDrag: (seconds: number) => dispatch({ type: "UPDATE_DRAG", seconds }),
    commitDrag: () => dispatch({ type: "COMMIT_DRAG" }),
    cancelDrag: () => dispatch({ type: "CANCEL_DRAG" }),
    applyCorrection: (action: CorrectionAction) =>
      dispatch({ type: "APPLY_CORRECTION", action }),
    undo: () => dispatch({ type: "UNDO" }),
    redo: () => dispatch({ type: "REDO" }),
    markSaved: () => dispatch({ type: "MARK_SAVED" }),
    getCorrectionsToSave: () => state.corrections.slice(0, state.undoCursor),
  }), [state, effectiveTalks, speakerNames, snapTargets, windowStart, windowEnd, containerWidth, timeToPixel, pixelToTime, findSnap]);

  return (
    <TimelineEngineContext.Provider value={value}>
      {children}
    </TimelineEngineContext.Provider>
  );
}
