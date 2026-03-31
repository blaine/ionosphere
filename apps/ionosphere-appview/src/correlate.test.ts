import { describe, it, expect } from "vitest";
import { correlate, type ScheduleEvent, type VodRecord } from "./correlate.js";

describe("correlate", () => {
  const schedule: ScheduleEvent[] = [
    {
      uri: "at://did:plc:test/community.lexicon.calendar.event/abc",
      name: "Building Cirrus: a single-user, serverless PDS",
      startsAt: "2026-03-28T16:15:00.000Z",
      endsAt: "2026-03-28T16:45:00.000Z",
      type: "presentation",
      room: "Great Hall South",
      category: "Development and Protocol",
      speakers: [{ id: "test.bsky.social", name: "Test Speaker" }],
      description: "A test talk.",
    },
  ];

  const vods: VodRecord[] = [
    {
      uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/123",
      title: "Building Cirrus: a single-user, serverless PDS",
      creator: "did:plc:7tattzlorncahxgtdiuci7x7",
      duration: 2238000000000,
      createdAt: "2026-03-28T16:50:00Z",
    },
    {
      uri: "at://did:plc:rbvrr34edl5ddpuwcubjiost/place.stream.video/456",
      title: "lunch",
      creator: "did:plc:7tattzlorncahxgtdiuci7x7",
      duration: 4308000000000,
      createdAt: "2026-03-28T19:30:00Z",
    },
  ];

  it("matches VODs to schedule events by title", () => {
    const matches = correlate(schedule, vods);
    expect(matches).toHaveLength(1);
    expect(matches[0].schedule.name).toBe("Building Cirrus: a single-user, serverless PDS");
    expect(matches[0].vod.uri).toContain("123");
  });

  it("filters out noise titles", () => {
    const matches = correlate(schedule, vods);
    expect(matches.every((m) => m.vod.title !== "lunch")).toBe(true);
  });
});
