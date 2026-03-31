import { Panproto, type LensHandle, type BuiltSchema } from "@panproto/core";

let _panproto: Panproto | null = null;

/**
 * Initialize the panproto runtime (lazy singleton).
 * WASM is loaded once and reused across all calls.
 */
export async function init(): Promise<Panproto> {
  if (!_panproto) _panproto = await Panproto.init();
  return _panproto;
}

/**
 * Parse an ATProto lexicon JSON into a panproto schema.
 */
export async function loadSchema(
  lexiconJson: object | string
): Promise<BuiltSchema> {
  const pp = await init();
  return pp.parseLexicon(lexiconJson);
}

/**
 * Create a lens between two schemas.
 */
export async function createLens(
  from: BuiltSchema,
  to: BuiltSchema
): Promise<LensHandle> {
  const pp = await init();
  return pp.lens(from, to);
}

/**
 * Convert a record from one schema to another using an auto-generated lens.
 * Plain JS objects in, plain JS objects out.
 */
export async function convert(
  data: object,
  from: BuiltSchema,
  to: BuiltSchema,
  defaults?: Record<string, unknown>
): Promise<unknown> {
  const pp = await init();
  return pp.convert(data, { from, to, defaults });
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

// Re-export types that pipeline scripts need
export type { LensHandle, BuiltSchema, Panproto };
