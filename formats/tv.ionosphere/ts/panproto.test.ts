import { describe, it, expect } from "vitest";
import { Panproto } from "@panproto/core";
import { readFileSync } from "node:fs";
import path from "node:path";

const LEXICON_DIR = path.resolve(import.meta.dirname, "../../../lexicons");

function readLexicon(relativePath: string): object {
  return JSON.parse(
    readFileSync(path.join(LEXICON_DIR, relativePath), "utf-8")
  );
}

/**
 * Probe whether the panproto WASM binary is available.
 * The @panproto/core npm package ships the TS SDK shell but the
 * wasm-bindgen glue module (panproto_wasm.js) must be built from
 * the Rust source. Tests skip gracefully when it is absent.
 */
let wasmAvailable = false;
try {
  const pp = await Panproto.init();
  pp[Symbol.dispose]();
  wasmAvailable = true;
} catch {
  // WASM binary not present — tests will be skipped
}

const describeWasm = wasmAvailable ? describe : describe.skip;

describeWasm("panproto wrapper", () => {
  // Lazy imports — only evaluated when WASM is available
  let init: typeof import("./panproto.js")["init"];
  let loadSchema: typeof import("./panproto.js")["loadSchema"];
  let convert: typeof import("./panproto.js")["convert"];

  it("loads wrapper module", async () => {
    const mod = await import("./panproto.js");
    init = mod.init;
    loadSchema = mod.loadSchema;
    convert = mod.convert;
    expect(init).toBeDefined();
  });

  it("initializes panproto", async () => {
    const pp = await init();
    expect(pp).toBeDefined();
    expect(pp.listProtocols()).toContain("atproto");
  });

  it("parses an ionosphere lexicon", async () => {
    const schema = await loadSchema(
      readLexicon("tv/ionosphere/talk.json")
    );
    expect(schema).toBeDefined();
  });

  it("parses a calendar event lexicon", async () => {
    const schema = await loadSchema(
      readLexicon("community/lexicon/calendar/event.json")
    );
    expect(schema).toBeDefined();
  });

  it("creates a lens between calendar event and talk", async () => {
    const calendarSchema = await loadSchema(
      readLexicon("community/lexicon/calendar/event.json")
    );
    const talkSchema = await loadSchema(
      readLexicon("tv/ionosphere/talk.json")
    );

    const pp = await init();
    const lens = pp.lens(calendarSchema, talkSchema);
    expect(lens).toBeDefined();
  });

  it("converts a calendar event to a talk", async () => {
    const calendarSchema = await loadSchema(
      readLexicon("community/lexicon/calendar/event.json")
    );
    const talkSchema = await loadSchema(
      readLexicon("tv/ionosphere/talk.json")
    );

    const event = {
      name: "Building with AT Protocol",
      description: "A talk about building apps",
      startsAt: "2026-03-27T10:00:00Z",
      endsAt: "2026-03-27T10:30:00Z",
      additionalData: {
        room: "Great Hall South",
        category: "developer",
        type: "presentation",
        speakers: [{ id: "alice.bsky.social", name: "Alice" }],
        isAtmosphereconf: true,
      },
    };

    const result = await convert(event, calendarSchema, talkSchema, {
      eventUri: "",
    });

    expect(result).toBeDefined();
    // Field mapping depends on panproto's structural analysis;
    // adjust expectations to match actual output once WASM is live.
    expect(typeof result).toBe("object");
  });

  it("serializes a protolens chain", async () => {
    const { serializeChain } = await import("./panproto.js");
    const calendarSchema = await loadSchema(
      readLexicon("community/lexicon/calendar/event.json")
    );
    const talkSchema = await loadSchema(
      readLexicon("tv/ionosphere/talk.json")
    );

    const json = await serializeChain(calendarSchema, talkSchema);
    expect(json).toBeTruthy();
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("verifies lens laws for calendar->talk lens", async () => {
    const calendarSchema = await loadSchema(
      readLexicon("community/lexicon/calendar/event.json")
    );
    const talkSchema = await loadSchema(
      readLexicon("tv/ionosphere/talk.json")
    );

    const pp = await init();
    const lens = pp.lens(calendarSchema, talkSchema);
    expect(lens).toBeDefined();

    const { encode } = await import("@msgpack/msgpack");
    const sampleEvent = encode({
      name: "Test Talk",
      description: "A test",
      startsAt: "2026-03-27T10:00:00Z",
      endsAt: "2026-03-27T10:30:00Z",
      additionalData: {
        room: "Room A",
        category: "dev",
        type: "presentation",
        speakers: [],
        isAtmosphereconf: true,
      },
    });
    const laws = lens.checkLaws(sampleEvent);
    expect(laws.passed).toBe(true);
  });
});

describe("panproto wrapper (static checks)", () => {
  it("exports expected functions", async () => {
    const mod = await import("./panproto.js");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.loadSchema).toBe("function");
    expect(typeof mod.createLens).toBe("function");
    expect(typeof mod.convert).toBe("function");
    expect(typeof mod.serializeChain).toBe("function");
  });

  it("reports WASM availability", () => {
    if (!wasmAvailable) {
      console.warn(
        "panproto WASM binary not available — " +
        "runtime tests skipped. Build panproto from source or " +
        "install a version that ships panproto_wasm.js."
      );
    }
    // This test always passes; it exists to surface the skip reason.
    expect(true).toBe(true);
  });
});
