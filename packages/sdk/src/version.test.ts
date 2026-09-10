import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SDK_VERSION } from "./version.ts";
import * as barrel from "./index.ts";

describe("SDK_VERSION", () => {
  test("equals the package manifest's version (the version:sync parity rule)", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
    expect(SDK_VERSION).toBe(manifest.version);
  });
  test("is on the main barrel beside PROTOCOL_VERSION, as a plain semver string", () => {
    expect(barrel.SDK_VERSION).toBe(SDK_VERSION);
    expect(barrel.PROTOCOL_VERSION).toBe("1.0");
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
