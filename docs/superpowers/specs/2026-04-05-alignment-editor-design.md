# Alignment Editor Design

NLE-style alignment editing tools for the ionosphere.tv track timeline view. Enables visual verification and correction of talk boundaries, speaker naming, and ground truth building — directly in the browser.

## Scope

Phases 1–4 from the pre-plan:
1. Drag-to-edit boundaries with undo/redo
2. Magnetic snap to silence gaps, speaker changes, word boundaries
3. Verification workflow with ground truth export
4. Speaker naming from diarization IDs

Phase 5 (AT Protocol persistence) is deferred. The sidecar format is designed to map naturally to AT Protocol records when that time comes.

## Architecture: Timeline Engine with Layered Tracks

A shared `TimelineEngine` (React context + store) owns the coordinate system, editing state, and corrections log. Individual rendering layers subscribe to the engine and handle their own display. This separates interaction, rendering, and data concerns cleanly.

### Timeline Engine

The engine replaces the zoom/pan state currently in `ZoomableTimeline` and adds editing concerns.

**State:**
- **Viewport**: zoomLevel, panCenter, windowStart/windowEnd, durationSeconds
- **Editing**: mode (`select` | `trim` | `split` | `add`), editingEnabled (toggle), activeDrag, selection
- **Playback**: currentTimeSec (mirrored from TimestampProvider)
- **Corrections**: sidecar log, computed effectiveTalks, computed snapTargets, undo cursor

**Derived values:**
- `timeToPixel(seconds)` / `pixelToTime(px)` — coordinate conversion for all layers
- `effectiveTalks` — pipeline talks with corrections replayed
- `snapTargets` — computed from word timestamps, diarization, silence gaps
- `canUndo` / `canRedo`

**Actions:**
- `setMode(mode)`, `toggleEditing()`
- `startDrag(talkRkey, edge, pixelX)`, `updateDrag(pixelX)`, `commitDrag()`, `cancelDrag()`
- `splitTalk(rkey, atSeconds)`, `addTalk(startSeconds, endSeconds)`, `removeTalk(rkey)`
- `markVerified(rkey)`, `unmarkVerified(rkey)`
- `setSpeakerName(speakerId, name)`
- `undo()`, `redo()`
- `save()` — persist sidecar to disk via API

### Corrections Sidecar

An append-only log of edit operations. Each entry is a discrete record with identity and timestamp.

**Entry shape:**
```ts
interface CorrectionEntry {
  id: string;              // nanoid
  timestamp: string;       // ISO 8601
  authorDid?: string;      // AT Protocol DID if logged in
  streamSlug: string;
  action: CorrectionAction;
}

type CorrectionAction =
  | { type: "move_boundary"; talkRkey: string; edge: "start" | "end"; fromSeconds: number; toSeconds: number }
  | { type: "split_talk"; talkRkey: string; atSeconds: number; newRkey: string }
  | { type: "add_talk"; rkey: string; title: string; startSeconds: number; endSeconds: number }
  | { type: "remove_talk"; talkRkey: string }
  | { type: "set_talk_title"; talkRkey: string; title: string }
  | { type: "verify_talk"; talkRkey: string }
  | { type: "unverify_talk"; talkRkey: string }
  | { type: "name_speaker"; speakerId: string; name: string }
```

**Storage:** One JSON file per stream alongside the existing boundary JSON, e.g. `corrections-great-hall-day-1.json`.

**Effective state:** Computed by replaying the log (up to the undo cursor) against the base pipeline talks. Pure reduce — the log is the source of truth. Replay semantics per action:
- `move_boundary`: set the specified edge of the talk to `toSeconds` (absolute value; `fromSeconds` is for auditability only)
- `split_talk`: replace the original talk with two — first gets `[originalStart, atSeconds)`, second gets `[atSeconds, originalEnd)` with `newRkey` and a placeholder title
- `add_talk`: insert a new talk with the given fields
- `remove_talk`: exclude the talk from effective state (if the talk was created by an earlier `add_talk`, that entry is still in the log and will re-create it on undo)
- `set_talk_title`: update the talk's title

**Undo/redo:** A cursor into the log. Undo decrements (entry stays but isn't applied). Redo increments. New edits truncate after the cursor. On save, only entries up to the cursor are persisted.

**AT Protocol future:** Each entry maps naturally to an AT Protocol record. The sidecar becomes a collection of records published to a PDS.

## Rendering Layers

The timeline is a stack of independently rendered layers sharing coordinate conversion from the engine.

**Layer stack (top to bottom):**

1. **Interaction overlay** — transparent div on top, handles all pointer events during editing. Renders drag handles, cursor changes, snap guide lines.

2. **Talk segments** — the existing `StreamTimeline` rendering, refactored to read from `effectiveTalks`. In edit mode, boundary edges get a visual affordance (brighter edge, ~4px hit zone). Selected talk gets a highlight. Verified talks show a checkmark badge.

3. **Waveform/diarization band** — combined visualization that morphs with zoom level:
   - **Low zoom (1–4x):** Speaker-colored blocks (current diarization band behavior)
   - **High zoom (4–8x+):** Speaker-colored area chart where height = word density per time bin
   - Crossover is gradual — blocks gain height variation as zoom increases

4. **Snap guides** — vertical lines at snap target positions, only visible during drag. Faint dashed lines that brighten within snap range.

5. **Time ruler** — tick marks and time labels. At higher zoom, intermediate ticks appear.

Each layer is a React component reading from `useTimelineEngine()`, absolutely positioned within a shared container.

**Waveform computation:** Pre-computed on mount from transcript words. For the visible window, bucket words into ~2px-wide time bins. Height = word count per bin. Color = dominant speaker in each bin. 64K words into a few hundred bins is trivial.

## NLE Toolbar & Edit Mode

**Layout:**
```
[Edit toggle] | [− zoom +] [window range] [Reset]
              | [Select] [Trim] [Split] [Add] [Delete]  |  [Undo] [Redo]  |  [Save]
```

Top row: existing zoom controls. Bottom row: editing toolbar, visible only when Edit is toggled on.

**Modes:**

- **Select** (`V`): Click a talk to select it. Shows details (title, speaker, start/end, verified status). Default when editing is enabled.
- **Trim** (`T`): Hover near a boundary edge to see drag handle. Click-drag to move. Snap targets attract within 10px. Alt/Option overrides snapping.
- **Split** (`S`): Click on a talk segment to split at that position. First segment inherits original metadata; second gets a placeholder title.
- **Add** (`A`): Click-drag on an empty gap to create a new talk segment. Gets placeholder title, unverified status.
- **Delete** (`Backspace`/`Delete` when selected): Removes the selected talk. Confirmation required for verified talks.

**Keyboard shortcuts:**

Playback (always active):
- `J` / `K` / `L` — reverse / pause / forward
- `Arrow Left` / `Arrow Right` — nudge playhead 1 second
- `Shift+Arrow Left` / `Shift+Arrow Right` — nudge playhead 0.1 second
- `Space` — play/pause

Editing (when edit mode is on):
- `Ctrl+Z` / `Ctrl+Shift+Z` — undo / redo
- `[` — nudge selected talk's start boundary 1 second earlier
- `]` — nudge selected talk's end boundary 1 second later
- `Shift+[` — nudge start boundary 0.1 second earlier
- `Shift+]` — nudge end boundary 0.1 second later
- `Enter` — mark selected talk as verified
- `Escape` — cancel drag, deselect, or exit edit mode
- `V` / `T` / `S` / `A` — switch mode
- `Ctrl+S` / `Cmd+S` — save

**Save** writes the corrections sidecar to disk via the API. Explicit save (not auto-save) — an editor should be intentional.

**Dirty state indicator:** When unsaved edits exist (in-memory log diverges from persisted sidecar), the Save button shows a dot/badge and the toolbar displays "unsaved changes".

## Snap System

During boundary drag in Trim mode, nearby positions exert magnetic pull.

**Snap targets (priority order):**

1. **Silence gaps > 2s** — from word timestamps. Where consecutive words are > 2s apart, the gap is a snap target. (Refined from the pre-plan's 3s threshold — 2s catches more useful transitions.)
2. **Speaker change points** — from diarization segments.
3. **Low-confidence zones** — Whisper segments with low `avg_logprob`. Edges often correspond to applause/noise.
4. **Word boundaries** — at high zoom, snap to nearest word start/end.

**Edge-aware snapping:** Snap targets resolve to the near edge of the target feature relative to the boundary being dragged, offset by 500ms:

- Dragging a **start boundary** (left edge): snaps to the **end** of the preceding gap + 500ms. Lands just before the speaker's first words.
- Dragging an **end boundary** (right edge): snaps to the **start** of the following gap − 500ms. Lands just after the speaker's last words.

The 500ms delta provides breathing room so cuts don't land on the first/last syllable. If the offset would overshoot the nearest word boundary (e.g., gap ends only 300ms before the first word), clamp to the word boundary instead.

**Behavior:**
- Snap radius: ~10px screen distance (adapts to zoom)
- Multiple targets within range: highest priority wins
- Visual feedback: snap guide brightens, small label appears ("silence gap", "speaker change")
- Alt/Option held: snapping disabled, continuous positioning

**Pre-computation:** Snap targets computed once on stream data load from existing transcript and diarization data. Stored sorted by time for binary-search during drag.

## Verification Workflow

1. Open track view, toggle Edit on
2. Select a talk — highlights on timeline, video seeks to start
3. Play through boundary — video + transcript sync shows what's happening
4. If wrong: Trim mode, drag to correct, snaps help
5. If correct: Enter to mark verified

**Visual indicators:** Verified talks show a checkmark badge on the timeline segment and in the talk list.

**Progress:** Stream page shows "8/13 talks verified" stat.

**Ground truth export:** An action (toolbar button or CLI) that outputs all verified talks in the existing ground truth JSON format. Field mapping from effective state:
- `rkey` — from the effective talk
- `title` — from the effective talk (after any `set_talk_title` corrections)
- `speaker` — from the `name_speaker` mapping for the dominant speaker during the talk, or empty string if unnamed
- `ground_truth_start` — the effective talk's `startSeconds`
- `tolerance_seconds` — 120 (uniform, matching existing ground truth)
- `verified` — true (only verified talks are exported)
- `notes` — auto-generated: correction count, original pipeline timestamp for diff reference

Feeds directly into the boundary detection evaluation pipeline.

## Speaker Naming

**Interaction:** In Select mode, clicking a diarization segment selects that speaker. A popover shows:
- Current label (e.g., "SPEAKER_12")
- Text input to assign a name
- List of talks where this speaker is dominant

**Auto-suggestion:** When verifying a talk, the engine checks which speaker ID is dominant during that talk's range. If the talk has a known speaker from schedule data, it offers to auto-map.

**Scope:** Stream-level mapping. SPEAKER_12 in Great Hall Day 1 maps to a name for that stream only (pyannote assigns IDs independently per file).

**Display:** Named speakers show their name in tooltips. Diarization band legend uses names where available.

## Data Flow

```
Pipeline boundary JSON (read-only base)
  ↓
TimelineEngine loads base talks + corrections sidecar
  ↓ replay corrections log up to undo cursor
Effective talks (derived)
  ↓
Rendering layers read effective talks + snap targets
  ↓
User edits → new CorrectionEntry appended to log
  ↓
Save → sidecar JSON written to disk
  ↓ (future)
Publish → sidecar entries become AT Protocol records
```

## API Surface

The appview needs two new endpoints:

- `GET /api/tracks/:slug/corrections` — load the corrections sidecar
- `PUT /api/tracks/:slug/corrections` — save the corrections sidecar

These read/write the sidecar JSON file. No schema changes to the existing database.

## File References

Files to modify:
- `apps/ionosphere/src/app/tracks/[stream]/TrackViewContent.tsx` — refactor to use TimelineEngine
- `apps/ionosphere/src/app/components/StreamTimeline.tsx` — becomes a rendering layer
- `apps/ionosphere/src/app/components/DiarizationBand.tsx` — becomes the waveform/diarization layer

New files:
- `apps/ionosphere/src/lib/timeline-engine.ts` — engine store and logic
- `apps/ionosphere/src/lib/corrections.ts` — sidecar types, replay, serialization
- `apps/ionosphere/src/lib/snap-targets.ts` — snap computation and lookup
- `apps/ionosphere/src/app/components/TimelineToolbar.tsx` — NLE toolbar
- `apps/ionosphere/src/app/components/InteractionOverlay.tsx` — drag handles, hit detection
- `apps/ionosphere/src/app/components/WaveformBand.tsx` — combined waveform/diarization
- `apps/ionosphere/src/app/components/SnapGuides.tsx` — snap guide rendering
- `apps/ionosphere/src/app/components/SpeakerPopover.tsx` — speaker naming UI
- `apps/ionosphere-appview/src/corrections-api.ts` — load/save endpoints
