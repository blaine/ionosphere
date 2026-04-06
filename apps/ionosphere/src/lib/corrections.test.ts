// apps/ionosphere/src/lib/corrections.test.ts
import { describe, it, expect } from "vitest";
import { replayCorrections, type CorrectionEntry, type BaseTalk } from "./corrections";

const baseTalks: BaseTalk[] = [
  { rkey: "talk1", title: "First Talk", speakers: ["Alice"], startSeconds: 100, endSeconds: 500, confidence: "high" },
  { rkey: "talk2", title: "Second Talk", speakers: ["Bob"], startSeconds: 500, endSeconds: 900, confidence: "high" },
];

function entry(action: CorrectionEntry["action"]): CorrectionEntry {
  return { id: "test", timestamp: new Date().toISOString(), streamSlug: "test", action };
}

describe("replayCorrections", () => {
  it("returns base talks when no corrections", () => {
    const result = replayCorrections(baseTalks, []);
    expect(result.talks).toEqual(baseTalks.map(t => ({ ...t, verified: false })));
    expect(result.speakerNames).toEqual(new Map());
  });

  it("applies move_boundary to start edge", () => {
    const corrections = [entry({ type: "move_boundary", talkRkey: "talk1", edge: "start", fromSeconds: 100, toSeconds: 110 })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks[0].startSeconds).toBe(110);
  });

  it("applies move_boundary to end edge", () => {
    const corrections = [entry({ type: "move_boundary", talkRkey: "talk1", edge: "end", fromSeconds: 500, toSeconds: 480 })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks[0].endSeconds).toBe(480);
  });

  it("applies split_talk", () => {
    const corrections = [entry({ type: "split_talk", talkRkey: "talk1", atSeconds: 300, newRkey: "talk1b" })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks).toHaveLength(3);
    expect(result.talks[0]).toMatchObject({ rkey: "talk1", startSeconds: 100, endSeconds: 300 });
    expect(result.talks[1]).toMatchObject({ rkey: "talk1b", startSeconds: 300, endSeconds: 500, title: "Untitled" });
  });

  it("applies add_talk", () => {
    const corrections = [entry({ type: "add_talk", rkey: "talk3", title: "New Talk", startSeconds: 950, endSeconds: 1100 })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks).toHaveLength(3);
    expect(result.talks[2]).toMatchObject({ rkey: "talk3", title: "New Talk" });
  });

  it("applies remove_talk", () => {
    const corrections = [entry({ type: "remove_talk", talkRkey: "talk1" })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks).toHaveLength(1);
    expect(result.talks[0].rkey).toBe("talk2");
  });

  it("applies set_talk_title", () => {
    const corrections = [entry({ type: "set_talk_title", talkRkey: "talk1", title: "Renamed" })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks[0].title).toBe("Renamed");
  });

  it("applies verify_talk and unverify_talk", () => {
    const corrections = [
      entry({ type: "verify_talk", talkRkey: "talk1" }),
      entry({ type: "unverify_talk", talkRkey: "talk1" }),
    ];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks[0].verified).toBe(false);
  });

  it("applies name_speaker", () => {
    const corrections = [entry({ type: "name_speaker", speakerId: "SPEAKER_01", name: "Alice Smith" })];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.speakerNames.get("SPEAKER_01")).toBe("Alice Smith");
  });

  it("respects undo cursor", () => {
    const corrections = [
      entry({ type: "move_boundary", talkRkey: "talk1", edge: "start", fromSeconds: 100, toSeconds: 110 }),
      entry({ type: "move_boundary", talkRkey: "talk1", edge: "start", fromSeconds: 110, toSeconds: 120 }),
    ];
    const result = replayCorrections(baseTalks, corrections, 1);
    expect(result.talks[0].startSeconds).toBe(110);
  });

  it("respects undo cursor = 0 (no corrections applied)", () => {
    const corrections = [entry({ type: "move_boundary", talkRkey: "talk1", edge: "start", fromSeconds: 100, toSeconds: 999 })];
    const result = replayCorrections(baseTalks, corrections, 0);
    expect(result.talks[0].startSeconds).toBe(100);
  });

  it("handles null endSeconds in base talk", () => {
    const talks: BaseTalk[] = [
      { rkey: "t1", title: "Last Talk", speakers: [], startSeconds: 800, endSeconds: null, confidence: "high" },
    ];
    const corrections = [entry({ type: "move_boundary", talkRkey: "t1", edge: "end", fromSeconds: 0, toSeconds: 1000 })];
    const result = replayCorrections(talks, corrections);
    expect(result.talks[0].endSeconds).toBe(1000);
  });

  it("splits talk with null endSeconds", () => {
    const talks: BaseTalk[] = [
      { rkey: "t1", title: "Last Talk", speakers: [], startSeconds: 800, endSeconds: null, confidence: "high" },
    ];
    const corrections = [entry({ type: "split_talk", talkRkey: "t1", atSeconds: 900, newRkey: "t1b" })];
    const result = replayCorrections(talks, corrections);
    expect(result.talks[0]).toMatchObject({ rkey: "t1", endSeconds: 900 });
    expect(result.talks[1]).toMatchObject({ rkey: "t1b", startSeconds: 900, endSeconds: null });
  });

  it("composes multiple operations on the same talk", () => {
    const corrections = [
      entry({ type: "move_boundary", talkRkey: "talk1", edge: "start", fromSeconds: 100, toSeconds: 90 }),
      entry({ type: "split_talk", talkRkey: "talk1", atSeconds: 300, newRkey: "talk1b" }),
      entry({ type: "set_talk_title", talkRkey: "talk1b", title: "Second Half" }),
      entry({ type: "verify_talk", talkRkey: "talk1b" }),
    ];
    const result = replayCorrections(baseTalks, corrections);
    expect(result.talks[0]).toMatchObject({ rkey: "talk1", startSeconds: 90, endSeconds: 300 });
    expect(result.talks[1]).toMatchObject({ rkey: "talk1b", title: "Second Half", startSeconds: 300, verified: true });
  });
});
