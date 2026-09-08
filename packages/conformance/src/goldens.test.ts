import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { goldenPath, listGoldens, loadGolden } from "./goldens.ts";

describe("the goldens loader (P7a Lane C)", () => {
  test("listGoldens finds every committed *.trace.json, non-empty and sorted", () => {
    const names = listGoldens();
    expect(names.length).toBeGreaterThan(10); // there are 28+ at the time of writing; a generous floor
    expect(names).toEqual([...names].sort());
    for (const name of names) expect(name.endsWith(".trace.json")).toBe(true);
    expect(names).toContain("plain-query.trace.json");
  });

  test("goldenPath resolves to a real file on disk for every listed name", () => {
    for (const name of listGoldens()) expect(existsSync(goldenPath(name))).toBe(true);
  });

  test("loadGolden parses a real committed golden into an array of trace entries", () => {
    const entries = loadGolden("plain-query.trace.json");
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toHaveProperty("sequence");
    expect(entries[0]).toHaveProperty("kind");
  });

  test("loadGolden throws on an unknown name rather than silently returning nothing", () => {
    expect(() => loadGolden("does-not-exist.trace.json")).toThrow();
  });

  test("every name listGoldens() returns loads successfully", () => {
    for (const name of listGoldens()) {
      const entries = loadGolden(name);
      expect(Array.isArray(entries)).toBe(true);
    }
  });
});
