import { describe, it, expect } from "vitest";
import { correlate, type ScheduleEvent, type VodRecord } from "./correlate.js";

const GHS_CREATOR = "did:plc:7tattzlorncahxgtdiuci7x7";

function makeVod(overrides: Partial<VodRecord> & { uri: string; title: string; duration: number; createdAt: string }): VodRecord {
  const endTime = new Date(overrides.createdAt);
  const startTime = new Date(endTime.getTime() - overrides.duration / 1e6);
  return {
    creator: GHS_CREATOR,
    startTime,
    endTime,
    room: "",
    ...overrides,
  };
}

describe("correlate", () => {
  const schedule: ScheduleEvent[] = [
    {
      uri: "at://test/community.lexicon.calendar.event/abc",
      name: "Building Cirrus: a single-user, serverless PDS",
      startsAt: "2026-03-28T16:15:00.000Z",
      endsAt: "2026-03-28T16:45:00.000Z",
      type: "presentation",
      room: "Great Hall South",
      category: "Development",
      speakers: [{ id: "test.bsky.social", name: "Test Speaker" }],
      description: "A test talk.",
    },
  ];

  it("matches by title when duration is reasonable", () => {
    const vods = [
      makeVod({
        uri: "at://vod/place.stream.video/123",
        title: "Building Cirrus: a single-user, serverless PDS",
        duration: 2238000000000, // ~37 min
        createdAt: "2026-03-28T16:53:00Z",
      }),
    ];
    const matches = correlate(schedule, vods);
    expect(matches).toHaveLength(1);
    expect(matches[0].method).toBe("title");
    expect(matches[0].primaryVideo?.vodUri).toContain("123");
    expect(matches[0].primaryVideo?.offsetNs).toBe(0);
  });

  it("rejects title match when VOD is too short, falls back to time-window", () => {
    const vods = [
      makeVod({
        uri: "at://vod/place.stream.video/clip",
        title: "Building Cirrus: a single-user, serverless PDS",
        duration: 144000000000, // 2.4 min clip
        createdAt: "2026-03-28T16:18:00Z",
      }),
      makeVod({
        uri: "at://vod/place.stream.video/room",
        title: "ATmosphereConf 2026 Great Hall",
        duration: 3600000000000, // 60 min room recording
        createdAt: "2026-03-28T17:00:00Z",
      }),
    ];
    const matches = correlate(schedule, vods);
    const m = matches.find((m) => m.schedule.name.includes("Cirrus"))!;
    expect(m.method).toBe("time-window");
    expect(m.primaryVideo?.vodUri).toContain("room");
    // 16:15 is 15 min into the 16:00-17:00 recording
    expect(m.primaryVideo!.offsetNs).toBe(15 * 60 * 1000 * 1e6);
  });

  it("returns no recording when nothing covers the time", () => {
    const vods = [
      makeVod({
        uri: "at://vod/place.stream.video/later",
        title: "Later Talk",
        duration: 1800000000000,
        createdAt: "2026-03-28T18:00:00Z",
      }),
    ];
    const matches = correlate(schedule, vods);
    const m = matches.find((m) => m.schedule.name.includes("Cirrus"))!;
    expect(m.method).toBe("none");
    expect(m.primaryVideo).toBeNull();
  });

  it("filters out noise VODs", () => {
    const vods = [
      makeVod({
        uri: "at://vod/place.stream.video/lunch",
        title: "lunch",
        duration: 4308000000000,
        createdAt: "2026-03-28T19:30:00Z",
      }),
    ];
    const matches = correlate(schedule, vods);
    expect(matches[0].primaryVideo).toBeNull();
  });

  it("stores all segments for multi-vod coverage", () => {
    const vods = [
      makeVod({
        uri: "at://vod/place.stream.video/seg1",
        title: "Segment 1",
        duration: 1200000000000, // 20 min, covers 16:00-16:20
        createdAt: "2026-03-28T16:20:00Z",
      }),
      makeVod({
        uri: "at://vod/place.stream.video/seg2",
        title: "Segment 2",
        duration: 2400000000000, // 40 min, covers 16:00-16:40
        createdAt: "2026-03-28T16:40:00Z",
      }),
    ];
    const matches = correlate(schedule, vods);
    const m = matches.find((m) => m.schedule.name.includes("Cirrus"))!;
    expect(m.allSegments.length).toBe(2);
    // Primary should be the one with more coverage
    expect(m.primaryVideo?.vodUri).toContain("seg2");
  });
});
