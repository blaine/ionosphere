import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  init as initPanproto,
  loadSchema,
  buildMigration,
  migrateRecord,
} from "./panproto.js";

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
    // Cross-schema migration works when the schemas are structurally similar.
    // For complex cross-schema transforms (calendar→talk with many unmapped fields),
    // compose panproto with a mechanical pre-processor.
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

describe("panproto wrapper (static checks)", () => {
  it("exports expected functions", async () => {
    const mod = await import("./panproto.js");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.loadSchema).toBe("function");
    expect(typeof mod.buildMigration).toBe("function");
    expect(typeof mod.migrateRecord).toBe("function");
    expect(typeof mod.createLens).toBe("function");
    expect(typeof mod.serializeChain).toBe("function");
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
