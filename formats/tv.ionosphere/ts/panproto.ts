import { Panproto, BuiltSchema, type LensHandle } from "@panproto/core";
import type { WasmGlueModule, MigrationSpec } from "@panproto/core";
import { CompiledMigration } from "@panproto/core";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let _panproto: Panproto | null = null;

/**
 * Build a WasmGlueModule that loads the WASM binary synchronously from disk.
 * The @panproto/core npm package ships the glue JS with --target web,
 * which uses fetch() for the .wasm file. Node.js can't fetch file:// URLs,
 * so we pre-load the binary and use initSync instead.
 */
async function loadGlueModule(): Promise<WasmGlueModule> {
  const require = createRequire(import.meta.url);
  const corePath = require.resolve("@panproto/core");
  const distDir = corePath.replace(/\/index\.(c?js)$/, "");

  const glueUrl = new URL(`file://${distDir}/panproto_wasm.js`);
  const glue = await import(/* @vite-ignore */ String(glueUrl));

  const wasmBytes = readFileSync(`${distDir}/panproto_wasm_bg.wasm`);

  const wrappedGlue: WasmGlueModule = {
    ...glue,
    default: async () => {
      return glue.initSync({ module: wasmBytes });
    },
  };
  return wrappedGlue;
}

/**
 * Initialize the panproto runtime (lazy singleton).
 * WASM is loaded once and reused across all calls.
 */
export async function init(): Promise<Panproto> {
  if (!_panproto) {
    const glue = await loadGlueModule();
    _panproto = await Panproto.init(glue);
  }
  return _panproto;
}

/**
 * Parse an ATProto lexicon JSON into a panproto schema.
 *
 * Works around a format mismatch in @panproto/core@0.22.0 where
 * the WASM returns positional arrays from schema_metadata but the
 * SDK expects named object keys.
 */
export async function loadSchema(
  lexiconJson: object | string
): Promise<BuiltSchema> {
  const pp = await init();
  try {
    return pp.parseLexicon(lexiconJson);
  } catch {
    return parseLexiconDirect(pp, lexiconJson);
  }
}

async function parseLexiconDirect(
  pp: Panproto,
  lexiconJson: object | string
): Promise<BuiltSchema> {
  const { decode } = await import("@msgpack/msgpack");
  const wasm = (pp as any)._wasm;

  const jsonStr =
    typeof lexiconJson === "string" ? lexiconJson : JSON.stringify(lexiconJson);
  const jsonBytes = new TextEncoder().encode(jsonStr);

  const rawHandle = wasm.exports.parse_atproto_lexicon(jsonBytes);
  const metaBytes = wasm.exports.schema_metadata(rawHandle);
  const meta = decode(metaBytes) as any;

  const [protocol, rawVertices, rawEdges] = Array.isArray(meta)
    ? meta
    : [meta.protocol, meta.vertices, meta.edges];

  const vertices = Object.fromEntries(
    (rawVertices || []).map((v: any) => {
      const id = Array.isArray(v) ? v[0] : v.id;
      const kind = Array.isArray(v) ? v[1] : v.kind;
      const nsid = Array.isArray(v) ? v[2] : v.nsid;
      return [id, { id, kind, nsid: nsid ?? undefined }];
    })
  );

  const edges = (rawEdges || []).map((e: any) => {
    if (Array.isArray(e)) {
      return { src: e[0], tgt: e[1], kind: e[2], name: e[3] ?? undefined };
    }
    return { src: e.src, tgt: e.tgt, kind: e.kind, name: e.name };
  });

  const data = {
    protocol: protocol as string,
    vertices,
    edges,
    hyperEdges: {},
    constraints: {},
  };

  return (BuiltSchema as any)._fromHandle(rawHandle, data, protocol, wasm);
}

/**
 * Build and compile an explicit migration between two schemas.
 *
 * vertexMap: { "source.vertex.id": "target.vertex.id" }
 *
 * Panproto handles renames, hoists, and structural transforms declaratively.
 * For anything panproto can't express (array element transforms, unit
 * conversions), compose with a mechanical pre/post-processor.
 */
export async function buildMigration(
  from: BuiltSchema,
  to: BuiltSchema,
  vertexMap: Record<string, string>
): Promise<CompiledMigration> {
  const pp = await init();
  let builder = pp.migration(from, to);
  for (const [src, tgt] of Object.entries(vertexMap)) {
    builder = builder.map(src, tgt);
  }
  return builder.compile();
}

/**
 * Apply a compiled migration to a record.
 * Takes a plain JS object, returns a plain JS object.
 *
 * Uses panproto's Instance format internally.
 */
export async function migrateRecord(
  migration: CompiledMigration,
  sourceSchema: BuiltSchema,
  record: object
): Promise<Record<string, any>> {
  const pp = await init();
  const instance = pp.parseJson(sourceSchema, JSON.stringify(record));
  const result = migration.lift(instance);

  // Extract field values from the raw lifted structure
  // [nodes, edges, hyperEdges, rootIdx, rootVertex, ...]
  const data = result.data as any;
  const nodes = data[0] || {};
  const output: Record<string, any> = {};

  for (const node of Object.values(nodes) as any[]) {
    const vertexId = node[1] as string;
    const value = node[2];
    if (value && typeof value === "object" && "Present" in value) {
      const inner = value.Present;
      const fieldName = vertexId.split(".").pop()!;
      output[fieldName] =
        inner.Str ?? inner.Int ?? inner.Float ?? inner.Bool ?? inner;
    }
  }

  return output;
}

/**
 * Create a lens between two schemas (auto-generated).
 * Works for structurally similar schemas (version migration).
 */
export async function createLens(
  from: BuiltSchema,
  to: BuiltSchema
): Promise<LensHandle> {
  const pp = await init();
  return pp.lens(from, to);
}

/**
 * Generate and serialize a protolens chain between two schemas.
 * Used by publish.ts to create lens records for the PDS.
 */
export async function serializeChain(
  from: BuiltSchema,
  to: BuiltSchema
): Promise<string> {
  const pp = await init();
  const chain = pp.protolensChain(from, to);
  return chain.toJson();
}

/**
 * Serialize a migration spec for storage as an AT Protocol record.
 */
export function serializeMigrationSpec(
  migration: CompiledMigration
): MigrationSpec {
  return migration.spec;
}

// Re-export types that pipeline scripts need
export type { LensHandle, BuiltSchema, Panproto, CompiledMigration, MigrationSpec };
