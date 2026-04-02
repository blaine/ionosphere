import { readFileSync } from "node:fs";
import path from "node:path";
import { createPipeline as _createPipeline } from "./panproto.js";
import type { PipelineBuilder, ProtolensChainHandle, Panproto } from "./panproto.js";

export interface LensSpec {
  $type: string;
  id: string;
  description: string;
  source: string;
  target: string;
  invertible?: boolean;
  passthrough?: "keep" | "drop";
  rules: LensRule[];
}

export interface LensRule {
  match: { name: string };
  replace: { name: string };
}

const LENS_DIR = path.resolve(import.meta.dirname, "../lenses");

export function loadLens(filename: string): LensSpec {
  const raw = readFileSync(path.join(LENS_DIR, filename), "utf-8");
  return JSON.parse(raw);
}

/**
 * Build a panproto PipelineBuilder from a lens spec JSON file.
 *
 * Translates LensSpec rules into native panproto combinators:
 * - Simple field renames use renameField()
 * - Dotted paths (e.g. "additionalData.room") use hoistField()
 *
 * Returns a ProtolensChainHandle that can be applied via WASM.
 *
 * @since @panproto/core@0.23.0
 */
export function buildPipelineFromSpec(
  pp: Panproto,
  lens: LensSpec
): ProtolensChainHandle {
  const builder: PipelineBuilder = _createPipeline(pp);

  // The parent vertex for ATProto record fields is typically "nsid:body"
  const parent = `${lens.source}:body`;

  for (const rule of lens.rules) {
    const sourceName = rule.match.name;
    const targetName = rule.replace.name;

    if (sourceName === targetName) {
      // Identity mapping — no transform needed
      continue;
    }

    const parts = sourceName.split(".");
    if (parts.length === 2) {
      // Dotted path like "additionalData.room" -> hoist from intermediate
      const [intermediate, child] = parts;
      builder.hoistField(parent, `${parent}.${intermediate}`, child);
      // Then rename if the target name differs from the child
      if (child !== targetName) {
        builder.renameField(parent, child, targetName);
      }
    } else {
      // Simple rename
      builder.renameField(parent, sourceName, targetName);
    }
  }

  return builder.build();
}

/**
 * Apply a lens to transform a source record's fields to target field names.
 *
 * This is the JS-only fallback that works without WASM. It handles field
 * renames and dotted-path hoisting per the lens spec rules. When panproto
 * WASM is available, prefer buildPipelineFromSpec() for full bidirectional
 * lens semantics with complement tracking.
 *
 * Fields not matched by any rule are kept or dropped per `passthrough`.
 */
export function applyLens(
  lens: LensSpec,
  source: Record<string, any>
): Record<string, any> {
  const result: Record<string, any> = {};
  const matched = new Set<string>();

  for (const rule of lens.rules) {
    const sourceName = rule.match.name;
    // Support dotted paths (e.g., "additionalData.room")
    const value = getNestedValue(source, sourceName);
    if (value !== undefined) {
      result[rule.replace.name] = value;
      matched.add(sourceName.split(".")[0]);
    }
  }

  // Handle passthrough
  if (lens.passthrough === "keep") {
    for (const [key, value] of Object.entries(source)) {
      if (!matched.has(key) && !(key in result)) {
        result[key] = value;
      }
    }
  }

  return result;
}

function getNestedValue(obj: any, path: string): any {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

// Panproto wrapper re-exports for new code
export {
  init,
  loadSchema,
  createLens,
  createPipeline,
  autoGenerateWithHints,
  buildMigration,
  migrateRecord,
  serializeChain,
  PipelineBuilder,
  ProtolensChainHandle,
} from "./panproto.js";

export type { BuiltSchema, Panproto } from "./panproto.js";
