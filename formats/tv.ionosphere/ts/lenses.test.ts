import { describe, it, expect } from "vitest";
import { applyLens, type LensSpec } from "./lenses.js";

describe("applyLens", () => {
  const lens: LensSpec = {
    $type: "org.relationaltext.lens",
    id: "test",
    description: "test lens",
    source: "source",
    target: "target",
    rules: [
      { match: { name: "name" }, replace: { name: "title" } },
      { match: { name: "additionalData.room" }, replace: { name: "room" } },
    ],
  };

  it("renames fields per rules", () => {
    const result = applyLens(lens, { name: "Hello" });
    expect(result.title).toBe("Hello");
    expect(result.name).toBeUndefined();
  });

  it("handles dotted paths", () => {
    const result = applyLens(lens, {
      name: "Test",
      additionalData: { room: "Room 1", type: "presentation" },
    });
    expect(result.title).toBe("Test");
    expect(result.room).toBe("Room 1");
  });

  it("drops unmatched fields by default", () => {
    const result = applyLens(lens, { name: "Test", extra: "value" });
    expect(result.extra).toBeUndefined();
  });

  it("keeps unmatched fields with passthrough=keep", () => {
    const keepLens = { ...lens, passthrough: "keep" as const };
    const result = applyLens(keepLens, { name: "Test", extra: "value" });
    expect(result.extra).toBe("value");
  });
});
