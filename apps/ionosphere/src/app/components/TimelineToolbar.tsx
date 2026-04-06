"use client";

import { useTimelineEngine, type EditMode } from "@/lib/timeline-engine";

const MODE_BUTTONS: { mode: EditMode; label: string; shortcut: string }[] = [
  { mode: "select", label: "Select", shortcut: "V" },
  { mode: "trim", label: "Trim", shortcut: "T" },
  { mode: "split", label: "Split", shortcut: "S" },
  { mode: "add", label: "Add", shortcut: "A" },
];

export default function TimelineToolbar({ onSave }: { onSave: () => void }) {
  const {
    editingEnabled,
    toggleEditing,
    mode,
    setMode,
    canUndo,
    canRedo,
    undo,
    redo,
    isDirty,
    effectiveTalks,
    selectedTalkRkey,
    applyCorrection,
  } = useTimelineEngine();

  const verifiedCount = effectiveTalks.filter((t) => t.verified).length;
  const totalCount = effectiveTalks.length;

  const handleDelete = () => {
    if (!selectedTalkRkey) return;
    const talk = effectiveTalks.find((t) => t.rkey === selectedTalkRkey);
    if (!talk) return;
    if (talk.verified && !confirm("Delete verified talk?")) return;
    applyCorrection({ type: "remove_talk", talkRkey: selectedTalkRkey });
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          onClick={toggleEditing}
          className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
            editingEnabled
              ? "bg-blue-600 text-white"
              : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
          }`}
        >
          {editingEnabled ? "Editing" : "Edit"}
        </button>
        <span className="text-xs text-neutral-500">
          {verifiedCount}/{totalCount} verified
        </span>
      </div>

      {editingEnabled && (
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-0.5 border-r border-neutral-700 pr-2 mr-1">
            {MODE_BUTTONS.map(({ mode: m, label, shortcut }) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  mode === m
                    ? "bg-neutral-700 text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800"
                }`}
                title={`${label} (${shortcut})`}
              >
                {label}
              </button>
            ))}
            <button
              onClick={handleDelete}
              disabled={!selectedTalkRkey}
              className="px-2 py-0.5 text-xs rounded text-neutral-500 hover:text-red-400 hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Delete (Backspace)"
            >
              Delete
            </button>
          </div>

          <div className="flex items-center gap-0.5 border-r border-neutral-700 pr-2 mr-1">
            <button
              onClick={undo}
              disabled={!canUndo}
              className="px-2 py-0.5 text-xs rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 disabled:opacity-30"
              title="Undo (Ctrl+Z)"
            >
              Undo
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              className="px-2 py-0.5 text-xs rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 disabled:opacity-30"
              title="Redo (Ctrl+Shift+Z)"
            >
              Redo
            </button>
          </div>

          <button
            onClick={onSave}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              isDirty
                ? "bg-blue-600/20 text-blue-400 hover:bg-blue-600/30"
                : "text-neutral-600 cursor-default"
            }`}
            disabled={!isDirty}
            title="Save (Ctrl+S)"
          >
            Save{isDirty ? " *" : ""}
          </button>
        </div>
      )}
    </div>
  );
}
