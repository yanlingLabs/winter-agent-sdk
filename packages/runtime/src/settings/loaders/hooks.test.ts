// Phase 5 Lane S slice 7: the settings-file and plugin HOOK BLOCK producers.
//
// Everything here feeds `buildHookEntriesFromSettings` and then `buildHookRegistry` -- never a
// runner directly (T2 divergence 8). The trust gate lives in `buildHookRegistry`; nothing here
// re-implements it.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHookEntriesFromSettings } from "../../hooks/from-config.ts";
import { buildHookRegistry } from "../../hooks/registry.ts";
import { loadPlugins } from "../../plugins/loader.ts";
import { settingsHookSourceInputs, pluginHookEntries, PLUGIN_HOOK_SOURCE } from "./hooks.ts";

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const block = (command: string) => ({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] });

function pluginWithHooks(name: string, command: string): string {
  const parent = mkTemp(`winter-hookplugin-${name}-`);
  const root = join(parent, name);
  mkdirSync(join(root, ".winter-plugin"), { recursive: true });
  writeFileSync(join(root, ".winter-plugin", "plugin.json"), JSON.stringify({ name, hooks: block(command) }), "utf8");
  return root;
}

describe("settingsHookSourceInputs", () => {
  test("a DetailedResolvedSettings-shaped perSource passes straight through with its tier and path", () => {
    const inputs = settingsHookSourceInputs({
      perSource: [
        { source: "project", path: "/p/.winter/settings.json", settings: { hooks: block("p") }, values: { hooks: block("p") }, loaded: true },
        { source: "user", path: "/u/settings.json", settings: {}, values: {}, loaded: true },
      ],
    });
    expect(inputs.map((i) => i.source)).toEqual(["project", "user"]);
    expect(inputs[0]!.path).toBe("/p/.winter/settings.json");
    expect(buildHookEntriesFromSettings(inputs).entries.map((e) => e.source)).toEqual(["project"]);
  });

  test("`undefined` and an empty resolve produce no inputs", () => {
    expect(settingsHookSourceInputs(undefined)).toEqual([]);
    expect(settingsHookSourceInputs({ perSource: [] })).toEqual([]);
  });

  test("the pinned `sources` array works too -- it is the same shape minus `values`", () => {
    const inputs = settingsHookSourceInputs({ sources: [{ source: "local", settings: { hooks: block("l") } }] });
    expect(buildHookEntriesFromSettings(inputs).entries.map((e) => e.source)).toEqual(["local"]);
  });

  test("routed through buildHookRegistry, project/local entries are excluded in an untrusted workspace", () => {
    const inputs = settingsHookSourceInputs({
      perSource: [
        { source: "project", settings: { hooks: block("p") } },
        { source: "user", settings: { hooks: block("u") } },
      ],
    });
    const { entries } = buildHookEntriesFromSettings(inputs);
    expect(buildHookRegistry(entries, { trustedWorkspace: false }).matching("PreToolUse", "Bash").map((e) => e.source)).toEqual(["user"]);
    expect(buildHookRegistry(entries, { trustedWorkspace: true }).matching("PreToolUse", "Bash").map((e) => e.source).sort()).toEqual(["project", "user"]);
  });
});

describe("pluginHookEntries", () => {
  test("a plugin's manifest hooks become real command entries carrying the command", () => {
    const { bundles } = loadPlugins([{ type: "local", path: pluginWithHooks("acme", "echo acme") }]);
    const { entries } = pluginHookEntries(bundles);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: "PreToolUse", matcher: "Bash", source: PLUGIN_HOOK_SOURCE, command: "echo acme" });
  });

  test("TWO plugins produce DISTINCT ids -- the id is what the command invoker dispatches on", () => {
    const { bundles } = loadPlugins([
      { type: "local", path: pluginWithHooks("first", "echo first") },
      { type: "local", path: pluginWithHooks("second", "echo second") },
    ]);
    const { entries } = pluginHookEntries(bundles);
    expect(entries).toHaveLength(2);
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toContain("plugin");
    // The collision this guards: a Map keyed by id, exactly as createCommandHookInvoker builds one.
    const byId = new Map(entries.map((e) => [e.id, e.command]));
    expect([...byId.values()].sort()).toEqual(["echo first", "echo second"]);
  });

  test("a plugin id can never collide with a settings-file id of the same positional shape", () => {
    const { bundles } = loadPlugins([{ type: "local", path: pluginWithHooks("acme", "echo acme") }]);
    const settings = buildHookEntriesFromSettings(settingsHookSourceInputs({ perSource: [{ source: "flag", settings: { hooks: block("echo sdk") } }] })).entries;
    const plugin = pluginHookEntries(bundles).entries;
    expect(new Set([...settings, ...plugin].map((e) => e.id)).size).toBe(2);
  });

  test("plugin hooks are NOT trust-gated -- they survive an untrusted workspace", () => {
    const { bundles } = loadPlugins([{ type: "local", path: pluginWithHooks("acme", "echo acme") }]);
    const registry = buildHookRegistry(pluginHookEntries(bundles).entries, { trustedWorkspace: false });
    expect(registry.matching("PreToolUse", "Bash")).toHaveLength(1);
  });

  test("a malformed plugin hooks block is REPORTED against that plugin's path, never thrown", () => {
    const parent = mkTemp("winter-hookbad-");
    const root = join(parent, "broken");
    mkdirSync(join(root, ".winter-plugin"), { recursive: true });
    writeFileSync(join(root, ".winter-plugin", "plugin.json"), JSON.stringify({ name: "broken", hooks: { PreToolUse: "not an array" } }), "utf8");
    const { bundles } = loadPlugins([{ type: "local", path: root }]);
    const result = pluginHookEntries(bundles);
    expect(result.entries).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.path).toContain("broken");
  });

  test("a plugin with no hooks block contributes nothing at all", () => {
    const parent = mkTemp("winter-hooknone-");
    const root = join(parent, "quiet");
    mkdirSync(root, { recursive: true });
    expect(pluginHookEntries(loadPlugins([{ type: "local", path: root }]).bundles)).toEqual({ entries: [], rejected: [] });
  });
});
