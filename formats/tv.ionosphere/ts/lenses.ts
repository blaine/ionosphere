import { readFileSync } from "node:fs";
import path from "node:path";

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
 * Apply a lens to transform a source record's fields to target field names.
 * Returns a new object with renamed keys per the lens rules.
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
