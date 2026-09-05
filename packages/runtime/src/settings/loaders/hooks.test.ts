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
import type { PluginBundle } from "../../plugins/bundle.ts";

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

// ================================================================================================
// T8 rider 19: a plugin hook names ITSELF -- `HookSource` gained a `plugin` member.
// ================================================================================================
//
// Lane S's NEEDS_CONTEXT 4: plugin hooks were filed under `sdk`, which was right on AUTHORITY
// (ungated by workspace trust, like `pluginAgents`) but made a plugin hook indistinguishable from an
// `Options.hooks` registration in an audit record. `ResolvedSettingSource` is PINNED and could not
// grow the member, so the parse still runs under `flag` and the entry is re-stamped -- which is why
// the assertion is on the ENTRY, not on the parse input.
describe("rider 19: plugin hooks are sourced `plugin`, rank last, and survive an untrusted workspace", () => {
  const bundle = (name: string): PluginBundle =>
    ({
      name,
      path: `/synthetic/plugins/${name}`,
      skills: [],
      commands: [],
      agents: {},
      mcpServers: {},
      skipMcpDiscovery: false,
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `echo ${name}` }] }] },
    }) as unknown as PluginBundle;

  test("every plugin entry carries source `plugin`, never `sdk`", () => {
    const built = pluginHookEntries([bundle("alpha")]);
    expect(built.entries.length).toBe(1);
    expect(built.entries[0]!.source).toBe("plugin");
  });

  test("a plugin hook sorts AFTER an Options.hooks (`sdk`) hook -- a plugin ships a default the host may override", () => {
    const sdkEntry = buildHookEntriesFromSettings([{ source: "flag", settings: { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo sdk" }] }] } } }]);
    const pluginEntry = pluginHookEntries([bundle("beta")]);
    const registry = buildHookRegistry([...pluginEntry.entries, ...sdkEntry.entries], { trustedWorkspace: false });
    const matching = registry.matching("PreToolUse", "Bash");
    expect(matching.map((e) => e.source)).toEqual(["sdk", "plugin"]);
  });

  test("a plugin hook is NOT excluded in an untrusted workspace -- same posture as pluginAgents", () => {
    const registry = buildHookRegistry(pluginHookEntries([bundle("gamma")]).entries, { trustedWorkspace: false });
    expect(registry.matching("PreToolUse", "Bash").length).toBe(1);
  });
});

// ================================================================================================
// Phase 5 fix wave, A-2 + A-3 — two silent settings-file acceptances.
// ================================================================================================
describe("A-3: a settings hook block's `handler.type` is validated", () => {
  test("an UNKNOWN type is reported and SKIPPED -- it is no longer loaded as a command hook and run", () => {
    // The dangerous direction of "accepted, preserved, inert": `type` was read nowhere, so a block
    // asking for something this engine does not implement got a SHELL COMMAND instead.
    const built = buildHookEntriesFromSettings([
      { source: "user", path: "/synthetic/settings.json", settings: { hooks: { PreToolUse: [{ hooks: [{ type: "webhook", command: "curl https://evil.example" }] }] } } },
    ]);
    expect(built.entries.length).toBe(0);
    expect(built.rejected.length).toBe(1);
    expect(built.rejected[0]!.reason).toContain('"webhook"');
  });

  test('an explicit `type: "command"` still loads', () => {
    const built = buildHookEntriesFromSettings([
      { source: "user", settings: { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] } } },
    ]);
    expect(built.entries.length).toBe(1);
    expect(built.entries[0]!.command).toBe("echo hi");
  });

  test("an ABSENT `type` still loads -- omitting the one legal value is an abbreviation, not a request for something else", () => {
    const built = buildHookEntriesFromSettings([{ source: "user", settings: { hooks: { PreToolUse: [{ hooks: [{ command: "echo hi" }] }] } } }]);
    expect(built.entries.length).toBe(1);
  });

  test("one bad handler does not cost the user the rest of the block", () => {
    const built = buildHookEntriesFromSettings([
      { source: "user", settings: { hooks: { PreToolUse: [{ hooks: [{ type: "webhook", command: "a" }, { type: "command", command: "b" }] }] } } },
    ]);
    expect(built.entries.map((e) => e.command)).toEqual(["b"]);
    expect(built.rejected.length).toBe(1);
  });
});
