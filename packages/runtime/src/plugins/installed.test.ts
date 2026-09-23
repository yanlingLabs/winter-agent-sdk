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

// SV-4 (router same-view test): real claude reads a DIRECTORY marketplace IN PLACE -- an
// `enabledPlugins` key plus a `known_marketplaces.json` entry is enough, even with NO
// `installed_plugins.json` record. Winter's runtime only ever consulted `installed_plugins.json`,
// so a plugin enabled in settings.json without an explicit install step silently never loaded.
describe("resolveEnabledPlugins: a DIRECTORY marketplace resolves in place with no install record (SV-4)", () => {
  function writeDirectoryMarketplace(root: string, name: string, marketplaceDir: string, plugins: { name: string; source: string }[]): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "known_marketplaces.json"),
      JSON.stringify({ [name]: { source: { source: "directory", path: marketplaceDir }, installLocation: marketplaceDir, lastUpdated: "2026-09-23T00:00:00Z", autoUpdate: false } }),
    );
    mkdirSync(join(marketplaceDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(marketplaceDir, ".claude-plugin", "marketplace.json"), JSON.stringify({ name, plugins }));
  }

  test("an enabledPlugins key with no install record resolves via the directory marketplace's own manifest", () => {
    const root = tempPluginsRoot();
    const marketplaceDir = mkdtempSync(join(tmpdir(), "winter-installed-marketplace-"));
    try {
      writeDirectoryMarketplace(root, "m", marketplaceDir, [{ name: "p", source: "./plugins/p" }]);
      const records = resolveEnabledPlugins(root, { "p@m": true });
      expect(records).toHaveLength(1);
      expect(records[0]!.id).toBe("p@m");
      expect(records[0]!.installPath).toBe(join(marketplaceDir, "plugins", "p"));
      expect(records[0]!.scope).toBe("user");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  test("an installed_plugins.json record still wins over the marketplace fallback -- no duplicate entry", () => {
    const root = tempPluginsRoot();
    const marketplaceDir = mkdtempSync(join(tmpdir(), "winter-installed-marketplace-"));
    try {
      writeInstalled(root, { "p@m": [{ scope: "project", installPath: "/explicit/install/p" }] });
      writeDirectoryMarketplace(root, "m", marketplaceDir, [{ name: "p", source: "./plugins/p" }]);
      const records = resolveEnabledPlugins(root, { "p@m": true });
      expect(records).toHaveLength(1);
      expect(records[0]!.installPath).toBe("/explicit/install/p"); // the REAL install record, not the marketplace-resolved fallback
      expect(records[0]!.scope).toBe("project");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  test("a non-directory marketplace (git/github/url) is never read in place -- this synchronous reader cannot fetch", () => {
    const root = tempPluginsRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "known_marketplaces.json"), JSON.stringify({ m: { source: { source: "github", repo: "owner/repo" }, installLocation: "/wherever", lastUpdated: "x", autoUpdate: false } }));
    try {
      expect(resolveEnabledPlugins(root, { "p@m": true })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unknown marketplace name resolves nothing, never a throw", () => {
    const root = tempPluginsRoot();
    try {
      expect(resolveEnabledPlugins(root, { "p@nosuchmarketplace": true })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a plugin name not listed in the marketplace manifest resolves nothing, never a throw", () => {
    const root = tempPluginsRoot();
    const marketplaceDir = mkdtempSync(join(tmpdir(), "winter-installed-marketplace-"));
    try {
      writeDirectoryMarketplace(root, "m", marketplaceDir, [{ name: "other", source: "./plugins/other" }]);
      expect(resolveEnabledPlugins(root, { "p@m": true })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  test("no known_marketplaces.json at all resolves nothing, never a throw", () => {
    const root = tempPluginsRoot();
    try {
      expect(resolveEnabledPlugins(root, { "p@m": true })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Fix round 3 (I-1, security): end to end through THIS reader, not just the unit-level resolver
  // (marketplace-path.test.ts) -- a malicious marketplace entry must never resolve to an install
  // path outside the marketplace directory, since a resolved plugin's hooks run shell commands.
  test("I-1: a marketplace entry naming a source that escapes the marketplace directory never resolves -- SECURITY", () => {
    const root = tempPluginsRoot();
    const marketplaceDir = mkdtempSync(join(tmpdir(), "winter-installed-marketplace-"));
    try {
      writeDirectoryMarketplace(root, "m", marketplaceDir, [{ name: "evil", source: "../../etc/passwd" }]);
      expect(resolveEnabledPlugins(root, { "evil@m": true })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  test("I-1: a marketplace entry naming an ABSOLUTE source never resolves -- SECURITY", () => {
    const root = tempPluginsRoot();
    const marketplaceDir = mkdtempSync(join(tmpdir(), "winter-installed-marketplace-"));
    try {
      writeDirectoryMarketplace(root, "m", marketplaceDir, [{ name: "evil", source: "/etc" }]);
      expect(resolveEnabledPlugins(root, { "evil@m": true })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  test("I-1: pluginRoot and an already-relative source do not double-join", () => {
    const root = tempPluginsRoot();
    const marketplaceDir = mkdtempSync(join(tmpdir(), "winter-installed-marketplace-"));
    try {
      mkdirSync(join(marketplaceDir, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(marketplaceDir, ".claude-plugin", "marketplace.json"),
        JSON.stringify({ name: "m", plugins: [{ name: "p", source: "./plugins/p" }], metadata: { pluginRoot: "./plugins" } }),
      );
      writeFileSync(
        join(root, "known_marketplaces.json"),
        JSON.stringify({ m: { source: { source: "directory", path: marketplaceDir }, installLocation: marketplaceDir, lastUpdated: "x", autoUpdate: false } }),
      );
      const records = resolveEnabledPlugins(root, { "p@m": true });
      expect(records).toHaveLength(1);
      expect(records[0]!.installPath).toBe(join(marketplaceDir, "plugins", "p")); // NOT plugins/plugins/p
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  test("I-1: a bare source name with no metadata.pluginRoot never resolves, matching claude's own refusal", () => {
    const root = tempPluginsRoot();
    const marketplaceDir = mkdtempSync(join(tmpdir(), "winter-installed-marketplace-"));
    try {
      writeDirectoryMarketplace(root, "m", marketplaceDir, [{ name: "p", source: "p" }]);
      expect(resolveEnabledPlugins(root, { "p@m": true })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });
});
