import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  init as initPanproto,
  loadSchema,
  buildMigration,
  migrateRecord,
  createPipeline,
  autoGenerateWithHints,
} from "./panproto.js";
import { applyLens, loadLens, buildPipelineFromSpec } from "./lenses.js";

const LEXICON_DIR = path.resolve(import.meta.dirname, "../../../lexicons");

function readLexicon(relativePath: string): object {
  return JSON.parse(
    readFileSync(path.join(LEXICON_DIR, relativePath), "utf-8")
  );
}

let wasmAvailable = false;
try {
  await initPanproto();
  wasmAvailable = true;
} catch {
  // WASM binary not present — tests will be skipped
}

const describeWasm = wasmAvailable ? describe : describe.skip;

describeWasm("panproto wrapper", () => {
  it("initializes panproto with ATProto support", async () => {
    const pp = await initPanproto();
    expect(pp.listProtocols()).toContain("atproto");
  });

  it("parses ionosphere lexicons", async () => {
    const talkSchema = await loadSchema(readLexicon("tv/ionosphere/talk.json"));
    expect(talkSchema).toBeDefined();
    expect(Object.keys(talkSchema.vertices)).toContain(
      "tv.ionosphere.talk:body.title"
    );
  });

  it("parses source lexicons", async () => {
    const calSchema = await loadSchema(
      readLexicon("community/lexicon/calendar/event.json")
    );
    expect(calSchema).toBeDefined();
    expect(Object.keys(calSchema.vertices)).toContain(
      "community.lexicon.calendar.event:body.name"
    );
  });

  it("renames fields via migration on structurally similar schemas", async () => {
    const pp = await initPanproto();
    const atproto = pp.protocol("atproto");

    const sourceSchema = atproto
      .schema()
      .vertex("src", "record", { nsid: "test.source" })
      .vertex("src:body", "object")
      .vertex("src:body.name", "string")
      .vertex("src:body.createdAt", "string")
      .edge("src", "src:body", "record-schema")
      .edge("src:body", "src:body.name", "prop", { name: "name" })
      .edge("src:body", "src:body.createdAt", "prop", { name: "createdAt" })
      .build();

    const targetSchema = atproto
      .schema()
      .vertex("tgt", "record", { nsid: "test.target" })
      .vertex("tgt:body", "object")
      .vertex("tgt:body.title", "string")
      .vertex("tgt:body.createdAt", "string")
      .edge("tgt", "tgt:body", "record-schema")
      .edge("tgt:body", "tgt:body.title", "prop", { name: "title" })
      .edge("tgt:body", "tgt:body.createdAt", "prop", { name: "createdAt" })
      .build();

    const migration = await buildMigration(sourceSchema, targetSchema, {
      src: "tgt",
      "src:body": "tgt:body",
      "src:body.name": "tgt:body.title",
      "src:body.createdAt": "tgt:body.createdAt",
    });

    const result = await migrateRecord(migration, sourceSchema, {
      name: "Hello World",
      createdAt: "2026-03-27T10:00:00Z",
    });

    expect(result.title).toBe("Hello World");
    expect(result.createdAt).toBe("2026-03-27T10:00:00Z");
    expect(result.name).toBeUndefined();
  });

  it("diffs schemas for version migration", async () => {
    const pp = await initPanproto();
    const atproto = pp.protocol("atproto");

    const v1 = atproto
      .schema()
      .vertex("talk", "record", { nsid: "tv.ionosphere.talk" })
      .vertex("talk:body", "object")
      .vertex("talk:body.title", "string")
      .edge("talk", "talk:body", "record-schema")
      .edge("talk:body", "talk:body.title", "prop", { name: "title" })
      .build();

    const v2 = atproto
      .schema()
      .vertex("talk", "record", { nsid: "tv.ionosphere.talk" })
      .vertex("talk:body", "object")
      .vertex("talk:body.title", "string")
      .vertex("talk:body.subtitle", "string")
      .edge("talk", "talk:body", "record-schema")
      .edge("talk:body", "talk:body.title", "prop", { name: "title" })
      .edge("talk:body", "talk:body.subtitle", "prop", { name: "subtitle" })
      .build();

    const diff = pp.diff(v1, v2);
    // diff[0] = added vertices
    expect((diff as any)[0]).toContain("talk:body.subtitle");
  });

  it("serializes migration spec", async () => {
    const calSchema = await loadSchema(
      readLexicon("community/lexicon/calendar/event.json")
    );
    const talkSchema = await loadSchema(readLexicon("tv/ionosphere/talk.json"));

    const migration = await buildMigration(calSchema, talkSchema, {
      "community.lexicon.calendar.event": "tv.ionosphere.talk",
      "community.lexicon.calendar.event:body": "tv.ionosphere.talk:body",
      "community.lexicon.calendar.event:body.name":
        "tv.ionosphere.talk:body.title",
    });

    const spec = migration.spec;
    expect(spec.vertexMap).toBeDefined();
    expect(
      (spec.vertexMap as any)["community.lexicon.calendar.event:body.name"]
    ).toBe("tv.ionosphere.talk:body.title");
  });
});

describeWasm("pipeline combinator API (v0.23+)", () => {
  it("builds a pipeline with renameField", async () => {
    const pp = await initPanproto();
    const pipeline = createPipeline(pp);
    const chain = pipeline
      .renameField("test.source:body", "name", "title")
      .build();
    expect(chain).toBeDefined();
    const json = chain.toJson();
    expect(json).toContain("rename_field");
  });

  it("builds a pipeline with hoistField", async () => {
    const pp = await initPanproto();
    const pipeline = createPipeline(pp);
    const chain = pipeline
      .hoistField(
        "community.lexicon.calendar.event:body",
        "community.lexicon.calendar.event:body.additionalData",
        "room"
      )
      .build();
    expect(chain).toBeDefined();
    const json = chain.toJson();
    expect(json).toContain("hoist_field");
  });

  it("builds the schedule-to-talk pipeline", async () => {
    const pp = await initPanproto();
    const pipeline = createPipeline(pp);
    const parent = "community.lexicon.calendar.event:body";
    const ad = `${parent}.additionalData`;

    const chain = pipeline
      .renameField(parent, "name", "title")
      .hoistField(parent, ad, "room")
      .hoistField(parent, ad, "category")
      .hoistField(parent, ad, "type")
      .renameField(parent, "type", "talkType")
      .hoistField(parent, ad, "speakers")
      .build();

    expect(chain).toBeDefined();
    const json = chain.toJson();
    expect(json).toContain("rename_field");
    expect(json).toContain("hoist_field");
  });
});

describeWasm("autoGenerateWithHints (v0.23+)", () => {
  it("generates a cross-schema lens with hints for calendar->talk", async () => {
    const calSchema = await loadSchema(
      readLexicon("community/lexicon/calendar/event.json")
    );
    const talkSchema = await loadSchema(readLexicon("tv/ionosphere/talk.json"));

    // Seed the morphism search with vertex correspondences
    const chain = await autoGenerateWithHints(calSchema, talkSchema, {
      "community.lexicon.calendar.event": "tv.ionosphere.talk",
      "community.lexicon.calendar.event:body": "tv.ionosphere.talk:body",
      "community.lexicon.calendar.event:body.name":
        "tv.ionosphere.talk:body.title",
      "community.lexicon.calendar.event:body.description":
        "tv.ionosphere.talk:body.description",
      "community.lexicon.calendar.event:body.startsAt":
        "tv.ionosphere.talk:body.startsAt",
      "community.lexicon.calendar.event:body.endsAt":
        "tv.ionosphere.talk:body.endsAt",
    });

    expect(chain).toBeDefined();
    const json = chain.toJson();
    expect(json.length).toBeGreaterThan(0);
  });
});

describeWasm("mapItems combinator (v0.23+)", () => {
  it("builds a pipeline with mapItems for array transforms", async () => {
    const pp = await initPanproto();
    const pipeline = createPipeline(pp);

    // Whisper words[] — each element has { word, start, end } and we could
    // add a confidence field via an inner addField step
    const chain = pipeline
      .mapItems("openai.whisper.verbose_json:body.words", {
        step_type: "add_field",
        parent: "openai.whisper.verbose_json:word",
        name: "confidence",
        kind: "number",
      })
      .build();

    expect(chain).toBeDefined();
    const json = chain.toJson();
    expect(json).toContain("map_items");
  });
});

describeWasm("ATProto array fix (v0.25.1)", () => {
  it("parses lexicons with array items edges correctly", async () => {
    // The Whisper verbose_json lexicon has array fields with "items" refs.
    // v0.25.1 fixes the "items" edge kind handling for ATProto arrays.
    const whisperSchema = await loadSchema(
      readLexicon("openai/whisper/verbose_json.json")
    );
    expect(whisperSchema).toBeDefined();

    // The words array should be parsed with proper items edges
    const vertexNames = Object.keys(whisperSchema.vertices);
    expect(vertexNames).toContain("openai.whisper.verbose_json:body.words");

    // Check edges for "items" kind
    const itemsEdges = whisperSchema.edges.filter(
      (e: any) => e.kind === "items"
    );
    expect(itemsEdges.length).toBeGreaterThan(0);
  });

  it("parses talk lexicon with speakerUris array", async () => {
    const talkSchema = await loadSchema(readLexicon("tv/ionosphere/talk.json"));
    expect(talkSchema).toBeDefined();

    const vertexNames = Object.keys(talkSchema.vertices);
    expect(vertexNames).toContain("tv.ionosphere.talk:body.speakerUris");

    // speakerUris is an array of strings — should have items edge
    const itemsEdges = talkSchema.edges.filter(
      (e: any) => e.kind === "items"
    );
    expect(itemsEdges.length).toBeGreaterThan(0);
  });
});

describe("applyLens (JS fallback)", () => {
  it("renames simple fields", () => {
    const lens = loadLens("schedule-to-talk.lens.json");
    const source = {
      name: "Building on AT Protocol",
      description: "A great talk",
      startsAt: "2026-03-27T10:00:00Z",
      endsAt: "2026-03-27T11:00:00Z",
      additionalData: {
        room: "Great Hall South",
        category: "Development",
        type: "presentation",
        speakers: [{ name: "Alice", id: "alice.bsky.social" }],
      },
    };

    const result = applyLens(lens, source);

    expect(result.title).toBe("Building on AT Protocol");
    expect(result.description).toBe("A great talk");
    expect(result.startsAt).toBe("2026-03-27T10:00:00Z");
    expect(result.room).toBe("Great Hall South");
    expect(result.category).toBe("Development");
    expect(result.talkType).toBe("presentation");
    expect(result.speakers).toEqual([
      { name: "Alice", id: "alice.bsky.social" },
    ]);
    // Original field name should not be present
    expect(result.name).toBeUndefined();
  });
});

describe("panproto wrapper (static checks)", () => {
  it("exports expected functions", async () => {
    const mod = await import("./panproto.js");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.loadSchema).toBe("function");
    expect(typeof mod.buildMigration).toBe("function");
    expect(typeof mod.migrateRecord).toBe("function");
    expect(typeof mod.createLens).toBe("function");
    expect(typeof mod.serializeChain).toBe("function");
    // New v0.23+ exports
    expect(typeof mod.createPipeline).toBe("function");
    expect(typeof mod.autoGenerateWithHints).toBe("function");
    expect(mod.PipelineBuilder).toBeDefined();
    expect(mod.ProtolensChainHandle).toBeDefined();
  });

  it("reports WASM availability", () => {
    if (!wasmAvailable) {
      console.warn(
        "panproto WASM binary not available — runtime tests skipped."
      );
    }
    expect(true).toBe(true);
  });
});
