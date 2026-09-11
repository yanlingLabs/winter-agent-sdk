import { test, expect } from "bun:test";
import { computeSyncedManifests, stampRuntimeEngineVersion, stampVersionConstant } from "./sync-version.ts";

test("stamps every workspace manifest with the VERSION value", () => {
  const result = computeSyncedManifests("1.2.345", [
    { path: "packages/sdk/package.json", json: { version: "0.0.001", optionalDependencies: { "@yanlinglabs/winter-agent-sdk-darwin-arm64": "0.0.001" } } },
    { path: "packages/platform/darwin-arm64/package.json", json: { version: "0.0.001" } },
  ]);
  expect(result[0]!.json.version).toBe("1.2.345");
  // lockstep: optionalDependencies on a sibling @yanlinglabs platform pkg also bump (WS-02 §4)
  expect((result[0]!.json.optionalDependencies as Record<string,string>)["@yanlinglabs/winter-agent-sdk-darwin-arm64"]).toBe("1.2.345");
  expect(result[1]!.json.version).toBe("1.2.345");
});

test("normalizes padded VERSION (0.0.001) to unpadded semver (0.0.1)", () => {
  const result = computeSyncedManifests("0.0.014", [
    { path: "packages/sdk/package.json", json: { version: "0.0.1", optionalDependencies: { "@yanlinglabs/winter-agent-sdk-darwin-arm64": "0.0.1" } } },
  ]);
  expect(result[0]!.json.version).toBe("0.0.14");
  // lockstep: optionalDependencies also get normalized
  expect((result[0]!.json.optionalDependencies as Record<string,string>)["@yanlinglabs/winter-agent-sdk-darwin-arm64"]).toBe("0.0.14");
});

test("leaves a workspace:* optionalDependency untouched (does not reintroduce the pinned-version break)", () => {
  const result = computeSyncedManifests("0.0.014", [
    { path: "packages/sdk/package.json", json: { version: "0.0.1", optionalDependencies: { "@yanlinglabs/winter-agent-sdk-darwin-arm64": "workspace:*" } } },
  ]);
  expect(result[0]!.json.version).toBe("0.0.14");
  // workspace:* is a link protocol, not a semver — must survive sync unchanged (mirrors the dependencies-loop guard)
  expect((result[0]!.json.optionalDependencies as Record<string,string>)["@yanlinglabs/winter-agent-sdk-darwin-arm64"]).toBe("workspace:*");
});

// --- Phase 7b: the one version string that is not in a manifest ----------------------------------
//
// `RUNTIME_ENGINE_VERSION` is hardcoded in `packages/runtime/src/store/dialect.ts` (a compiled
// `$bunfs` binary cannot read its own package.json), and its only drift protection was a parity test
// -- which works, but fires AFTER a bump, as a red suite in the middle of a release. `version:sync`
// restamps it now; these pin the rewrite's precision, because a loose regex here would rewrite prose.
test("stampRuntimeEngineVersion rewrites the declaration and nothing else", () => {
  const source = [
    "// Task 8 chose packages/runtime/package.json's version as the source; see RUNTIME_ENGINE_VERSION = \"0.0.1\" below.",
    'export const RUNTIME_ENGINE_VERSION = "0.0.1";',
    'const OTHER_VERSION = "0.0.1";',
  ].join("\n");
  // Routed through the generalized stamper -- stampRuntimeEngineVersion is now a one-line wrapper
  // over stampVersionConstant(source, "RUNTIME_ENGINE_VERSION", semver); this plant proves the
  // wrapper's precision survived the generalization.
  const out = stampVersionConstant(source, "RUNTIME_ENGINE_VERSION", "0.0.2");
  expect(out).toContain('export const RUNTIME_ENGINE_VERSION = "0.0.2";');
  // The COMMENT above it and an unrelated constant below both still say 0.0.1 -- the anchor is the
  // declaration, not the string.
  expect(out).toContain('see RUNTIME_ENGINE_VERSION = \"0.0.1\" below');
  expect(out).toContain('const OTHER_VERSION = "0.0.1";');
  // The compatibility wrapper produces the identical result.
  expect(stampRuntimeEngineVersion(source, "0.0.2")).toBe(out);
});

test("stampRuntimeEngineVersion returns the source UNCHANGED when the declaration is absent", () => {
  // A caller then writes nothing, rather than silently corrupting a file whose shape it no longer
  // recognises -- and the parity test in dialect.test.ts is still there to report the drift.
  const source = "export const SOMETHING_ELSE = 1;\n";
  expect(stampVersionConstant(source, "RUNTIME_ENGINE_VERSION", "9.9.9")).toBe(source);
  expect(stampRuntimeEngineVersion(source, "9.9.9")).toBe(source);
});

// --- Task S1: the generalized stamper, exercised under a second constant name --------------------
//
// `stampVersionConstant` is the function `stampRuntimeEngineVersion` now wraps; these plant it
// directly under "SDK_VERSION" (the name `version.ts` declares) to prove the generalization holds
// for any declaration name, not just the one it was extracted from.
test("stampVersionConstant rewrites only the named declaration", () => {
  const source = 'export const SDK_VERSION = "0.0.2";\nexport const OTHER = "x";';
  const out = stampVersionConstant(source, "SDK_VERSION", "0.0.3");
  expect(out).toBe('export const SDK_VERSION = "0.0.3";\nexport const OTHER = "x";');
});

test("stampVersionConstant returns the source unchanged when the name is absent", () => {
  const source = 'export const OTHER = "x";';
  expect(stampVersionConstant(source, "SDK_VERSION", "0.0.3")).toBe(source);
});

test("stampVersionConstant does not rewrite a comment mentioning the name", () => {
  const source = [
    '// stamped from package.json by version:sync; see SDK_VERSION = "0.0.2" below.',
    'export const SDK_VERSION = "0.0.2";',
  ].join("\n");
  const out = stampVersionConstant(source, "SDK_VERSION", "0.0.3");
  expect(out).toContain('export const SDK_VERSION = "0.0.3";');
  expect(out).toContain('see SDK_VERSION = "0.0.2" below');
});
