// WS-21 lane L1b, Task L1b.2 (spec §6.3 item 5, Contract B): reads the SAME `installed_plugins.json`
// `@yanlinglabs/winter-agent-sdk`'s `packages/sdk/src/plugins/manage.ts` writes -- claude's own V2
// shape, `{version:2, plugins: {"<key>": [<record>, ...]}}`, an ARRAY per key because the identical
// id can be installed at more than one scope. SYNCHRONOUS, matching `plugins/loader.ts`'s own file
// I/O style (this reader feeds directly into `loadPlugins`, called synchronously inside
// `production-wiring.ts`), unlike `manage.ts`'s own ASYNC, CLI-facing reader of the same file.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstalledPlugins, resolveEnabledPlugins } from "./installed.ts";

function tempPluginsRoot(): string {
  return mkdtempSync(join(tmpdir(), "winter-installed-plugins-test-"));
}

function writeInstalled(root: string, plugins: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

describe("readInstalledPlugins: the same V2 shape manage.ts writes", () => {
  test("flattens every scope-record, keyed by the SAME compound id manage.ts writes (\"<name>@<marketplace>\")", () => {
    const root = tempPluginsRoot();
    try {
      writeInstalled(root, {
        "p@m": [{ scope: "user", installPath: "/plugins/p", version: "1.0.0", installedAt: "2026-09-23T00:00:00Z" }],
        "q@m": [
          { scope: "user", installPath: "/plugins/q-user" },
          { scope: "project", installPath: "/plugins/q-project" },
        ],
      });
      const records = readInstalledPlugins(root);
      expect(records).toHaveLength(3);
      expect(records).toContainEqual({ id: "p@m", installPath: "/plugins/p", version: "1.0.0", scope: "user" });
      expect(records).toContainEqual({ id: "q@m", installPath: "/plugins/q-user", scope: "user" });
      expect(records).toContainEqual({ id: "q@m", installPath: "/plugins/q-project", scope: "project" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an absent installed_plugins.json is an empty list, never a throw", () => {
    const root = tempPluginsRoot();
    try {
      expect(readInstalledPlugins(join(root, "does-not-exist"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed JSON is an empty list, never a throw -- a broken file never fails the whole session's plugin load", () => {
    const root = tempPluginsRoot();
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "installed_plugins.json"), "{not json");
      expect(readInstalledPlugins(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a record naming a scope outside the recognized three (claude's own \"managed\") still loads, never dropped", () => {
    const root = tempPluginsRoot();
    try {
      writeInstalled(root, { "p@m": [{ scope: "managed", installPath: "/plugins/p" }] });
      const [record] = readInstalledPlugins(root);
      expect(record?.installPath).toBe("/plugins/p");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveEnabledPlugins: enabledPlugins true loads it, false (or absent) does not", () => {
  test("only records whose id is TRUE in the enabled map are returned", () => {
    const root = tempPluginsRoot();
    try {
      writeInstalled(root, {
        "p@m": [{ scope: "user", installPath: "/plugins/p" }],
        "q@m": [{ scope: "user", installPath: "/plugins/q" }],
        "r@m": [{ scope: "user", installPath: "/plugins/r" }],
      });
      const enabled = resolveEnabledPlugins(root, { "p@m": true, "q@m": false });
      expect(enabled.map((r) => r.id)).toEqual(["p@m"]); // q@m is false, r@m is absent -- neither loads
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("undefined enabled map resolves nothing", () => {
    const root = tempPluginsRoot();
    try {
      writeInstalled(root, { "p@m": [{ scope: "user", installPath: "/plugins/p" }] });
      expect(resolveEnabledPlugins(root, undefined)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
