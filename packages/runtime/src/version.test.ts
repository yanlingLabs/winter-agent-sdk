import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SDK_VERSION } from "@yanlinglabs/winter-agent-sdk";
import { RUNTIME_VERSION } from "./version.ts";
import { RUNTIME_ENGINE_VERSION } from "./store/dialect.ts";

// WS-23: the value an embedding host compares against its own pin and the wrapper's SDK_VERSION at
// boot. The three packages publish together at ONE version with exact pins between them, so every
// one of these equalities is a release invariant, not a coincidence.
describe("RUNTIME_VERSION", () => {
  test("equals the runtime package manifest's version (the version:sync parity rule)", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
    expect(RUNTIME_VERSION).toBe(manifest.version);
  });
  test("equals RUNTIME_ENGINE_VERSION and the wrapper's SDK_VERSION", () => {
    expect(RUNTIME_VERSION).toBe(RUNTIME_ENGINE_VERSION);
    expect(RUNTIME_VERSION).toBe(SDK_VERSION);
  });
  test("its module imports nothing, so a host can read it without evaluating the runtime", () => {
    const source = readFileSync(join(import.meta.dir, "version.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\(/);
  });
});
