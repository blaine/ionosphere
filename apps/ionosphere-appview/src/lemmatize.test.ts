import { describe, it, expect } from "vitest";
import { lemmatize, isProperNoun, expandAbbreviation } from "./lemmatize.js";

describe("lemmatize", () => {
  it("singularizes nouns", () => {
    expect(lemmatize("protocols")).toBe("protocol");
    expect(lemmatize("communities")).toBe("community");
  });

  it("converts verbs to base form", () => {
    expect(lemmatize("building")).toBe("build");
    expect(lemmatize("decentralized")).toBe("decentralize");
  });

  it("normalizes British spelling", () => {
    expect(lemmatize("normalise")).toBe("normalize");
    expect(lemmatize("colour")).toBe("color");
  });

  it("passes through already-base forms", () => {
    expect(lemmatize("protocol")).toBe("protocol");
    expect(lemmatize("build")).toBe("build");
  });
});

describe("isProperNoun", () => {
  it("detects capitalized words", () => {
    expect(isProperNoun("bluesky", "Bluesky")).toBe(true);
    expect(isProperNoun("protocol", "protocol")).toBe(false);
  });
});

describe("expandAbbreviation", () => {
  it("expands known abbreviations", () => {
    const aliases = new Map([["api", "application programming interface"]]);
    expect(expandAbbreviation("api", aliases)).toBe(
      "application programming interface"
    );
  });

  it("returns null for non-abbreviations", () => {
    const aliases = new Map([["api", "application programming interface"]]);
    expect(expandAbbreviation("protocol", aliases)).toBeNull();
  });
});
