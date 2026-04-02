import {
  Panproto,
  BuiltSchema,
  PipelineBuilder,
  ProtolensChainHandle,
  type LensHandle,
} from "@panproto/core";
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
 * In @panproto/core@0.25.1, parseLexicon is a stable, direct method
 * on the Panproto instance. The v0.22.0 workaround for positional
 * arrays from schema_metadata is no longer needed.
 */
export async function loadSchema(
  lexiconJson: object | string
): Promise<BuiltSchema> {
  const pp = await init();
  return pp.parseLexicon(lexiconJson);
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
 * Auto-generate a protolens chain with morphism hints.
 *
 * Hints are vertex correspondences that seed the morphism search,
 * enabling alignment across schemas with different NSID namespaces
 * (e.g. community.lexicon.calendar.event -> tv.ionosphere.talk).
 *
 * @since @panproto/core@0.23.0
 */
export async function autoGenerateWithHints(
  from: BuiltSchema,
  to: BuiltSchema,
  hints: Record<string, string>
): Promise<ProtolensChainHandle> {
  const pp = await init();
  return ProtolensChainHandle.autoGenerateWithHints(from, to, hints, pp._wasm);
}

/**
 * Create a PipelineBuilder for constructing lens transforms from combinators.
 *
 * Usage:
 *   const pp = await init();
 *   const chain = createPipeline(pp)
 *     .renameField('body', 'name', 'title')
 *     .hoistField('body', 'additionalData', 'room')
 *     .build();
 *
 * @since @panproto/core@0.23.0
 */
export function createPipeline(pp: Panproto): PipelineBuilder {
  return new PipelineBuilder(pp._wasm);
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
export { PipelineBuilder, ProtolensChainHandle };
