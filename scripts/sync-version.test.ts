import { test, expect } from "bun:test";
import { computeSyncedManifests } from "./sync-version.ts";

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
