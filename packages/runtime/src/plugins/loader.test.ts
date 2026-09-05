// Phase 5 Lane S slice 6 (WS-11 §4, derived-shapes-p5 item (b)): `loadPlugins` -- the namespaced
// aggregator over skills/commands/agents/hooks/mcpServers/metadata, with RESOLVED absolute paths.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPlugins } from "./loader.ts";
import { pluginAgentDefinitions, pluginInitInfo, pluginSkillContributions, pluginCommandContributions } from "./bundle.ts";
import { readPluginManifest, WINTER_PLUGIN_MANIFEST_DIR, CLAUDE_PLUGIN_MANIFEST_DIR } from "./manifest.ts";

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(path: string, content: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

/** A plugin directory with one of everything. `manifestDir` omitted = manifestless. */
function plugin(opts?: { manifestDir?: string; manifest?: Record<string, unknown>; dirName?: string }): string {
  const parent = mkTemp("winter-plugin-parent-");
  const root = join(parent, opts?.dirName ?? "my-plugin");
  mkdirSync(root, { recursive: true });
  if (opts?.manifestDir) write(join(root, opts.manifestDir, "plugin.json"), JSON.stringify(opts.manifest ?? {}));
  write(join(root, "skills", "ship", "SKILL.md"), "---\nname: ship\ndescription: ships\n---\n\nSHIP BODY");
  write(join(root, "commands", "deploy.md"), "---\ndescription: deploys\n---\n\nDeploy $ARGUMENTS");
  write(join(root, "agents", "helper.md"), "---\ndescription: a helper\nmodel: sonnet\n---\nYou are a helper.");
  write(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { tools: { command: "tools-server" } } }));
  return root;
}

describe("loadPlugins: `type: \"local\"` is the only accepted config (WS-11 §4)", () => {
  test("a local plugin loads", () => {
    const result = loadPlugins([{ type: "local", path: plugin() }]);
    expect(result.rejected).toEqual([]);
    expect(result.bundles).toHaveLength(1);
  });

  test("any other `type` is a TYPED rejection naming the kind, never a silent skip", () => {
    const result = loadPlugins([{ type: "marketplace", path: "/anywhere" } as unknown as { type: "local"; path: string }]);
    expect(result.bundles).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.kind).toBe("unsupported-type");
    expect(result.rejected[0]!.reason).toContain("local");
  });

  test("a missing directory, and a path that is a FILE, are both typed rejections", () => {
    const parent = mkTemp("winter-plugin-missing-");
    write(join(parent, "not-a-dir"), "hello");
    const result = loadPlugins([
      { type: "local", path: join(parent, "nope") },
      { type: "local", path: join(parent, "not-a-dir") },
    ]);
    expect(result.bundles).toEqual([]);
    expect(result.rejected.map((r) => r.kind)).toEqual(["missing", "missing"]);
  });

  test("the same path listed twice loads once and reports the duplicate", () => {
    const root = plugin();
    const result = loadPlugins([
      { type: "local", path: root },
      { type: "local", path: root },
    ]);
    expect(result.bundles).toHaveLength(1);
    expect(result.rejected[0]!.kind).toBe("duplicate");
  });

  test("no plugins at all is an empty result, not an error", () => {
    expect(loadPlugins(undefined)).toEqual({ bundles: [], rejected: [] });
    expect(loadPlugins([])).toEqual({ bundles: [], rejected: [] });
  });
});

describe("loadPlugins: naming", () => {
  test("a MANIFESTLESS root is named by its basename (WS-11 §4)", () => {
    expect(loadPlugins([{ type: "local", path: plugin({ dirName: "basename-named" }) }]).bundles[0]!.name).toBe("basename-named");
  });

  test("a manifest `name` wins over the basename, and `version` rides along", () => {
    const root = plugin({ manifestDir: WINTER_PLUGIN_MANIFEST_DIR, manifest: { name: "declared", version: "2.1.0" }, dirName: "on-disk" });
    const bundle = loadPlugins([{ type: "local", path: root }]).bundles[0]!;
    expect(bundle.name).toBe("declared");
    expect(bundle.version).toBe("2.1.0");
  });

  test("the `.claude-plugin` manifest directory is honoured too, so an existing CC plugin dir is drop-in", () => {
    const root = plugin({ manifestDir: CLAUDE_PLUGIN_MANIFEST_DIR, manifest: { name: "cc-shaped" } });
    expect(loadPlugins([{ type: "local", path: root }]).bundles[0]!.name).toBe("cc-shaped");
  });

  test("an unparseable manifest is a typed rejection -- never a silently manifestless load", () => {
    const parent = mkTemp("winter-plugin-badmanifest-");
    const root = join(parent, "broken");
    mkdirSync(root, { recursive: true });
    write(join(root, WINTER_PLUGIN_MANIFEST_DIR, "plugin.json"), "{ not json");
    const result = loadPlugins([{ type: "local", path: root }]);
    expect(result.bundles).toEqual([]);
    expect(result.rejected[0]!.kind).toBe("invalid-manifest");
  });

  test("a name that could traverse or collide with the reserved qualifier is refused", () => {
    const root = plugin({ manifestDir: WINTER_PLUGIN_MANIFEST_DIR, manifest: { name: "../evil" } });
    expect(loadPlugins([{ type: "local", path: root }]).rejected[0]!.kind).toBe("invalid-name");
  });

  test("`.winter` as a plugin root qualifies its skills `.winter:<skill>` on BOTH branches", () => {
    const parent = mkTemp("winter-dotwinter-");
    const root = join(parent, ".winter");
    mkdirSync(root, { recursive: true });
    write(join(root, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: d\n---\n\nB");
    const declared = plugin({ manifestDir: WINTER_PLUGIN_MANIFEST_DIR, manifest: { name: ".winter" } });
    const byBasename = loadPlugins([{ type: "local", path: root }]).bundles[0]!;
    const byManifest = loadPlugins([{ type: "local", path: declared }]).bundles[0]!;
    expect(byBasename.name).toBe(".winter");
    expect(byManifest.name).toBe(".winter");
    expect(byBasename.skills[0]!.qualifiedName).toBe(".winter:review");
    expect(byManifest.skills[0]!.qualifiedName).toBe(".winter:ship");
  });
});

describe("loadPlugins: aggregation with resolved absolute paths", () => {
  test("skills, commands, agents and MCP servers are all collected", () => {
    const root = plugin();
    const bundle = loadPlugins([{ type: "local", path: root }]).bundles[0]!;
    expect(bundle.skills.map((s) => s.qualifiedName)).toEqual(["my-plugin:ship"]);
    expect(bundle.commands.map((c) => c.qualifiedName)).toEqual(["my-plugin:deploy"]);
    expect(bundle.commands[0]!.description).toBe("deploys");
    expect(Object.keys(bundle.agents)).toEqual(["helper"]);
    expect(bundle.agents["helper"]!.plugin).toBe("my-plugin");
    expect(bundle.mcpServers).toEqual({ tools: { command: "tools-server" } });
  });

  test("every emitted path is ABSOLUTE and resolved, even from a relative config path", () => {
    const root = plugin();
    const bundle = loadPlugins([{ type: "local", path: join(root, "..", "my-plugin") }]).bundles[0]!;
    expect(bundle.path).toBe(resolve(root));
    for (const p of [bundle.skills[0]!.path, bundle.commands[0]!.path]) {
      expect(p.startsWith(resolve(root))).toBe(true);
    }
  });

  test("a plugin with none of the optional subdirectories loads as an empty bundle, not an error", () => {
    const parent = mkTemp("winter-plugin-bare-");
    const root = join(parent, "bare");
    mkdirSync(root, { recursive: true });
    const bundle = loadPlugins([{ type: "local", path: root }]).bundles[0]!;
    expect(bundle).toMatchObject({ name: "bare", skills: [], commands: [], agents: {}, mcpServers: {} });
  });

  test("manifest `mcpServers` merges with `.mcp.json`, the manifest winning a name collision", () => {
    const parent = mkTemp("winter-plugin-mcp-");
    const root = join(parent, "mcp-plugin");
    mkdirSync(root, { recursive: true });
    write(join(root, WINTER_PLUGIN_MANIFEST_DIR, "plugin.json"), JSON.stringify({ mcpServers: { shared: { command: "from-manifest" }, only: { command: "m" } } }));
    write(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "from-file" }, other: { command: "f" } } }));
    const bundle = loadPlugins([{ type: "local", path: root }]).bundles[0]!;
    expect(bundle.mcpServers).toEqual({ shared: { command: "from-manifest" }, only: { command: "m" }, other: { command: "f" } });
  });

  test("`skipMcpDiscovery` loads everything EXCEPT the MCP servers (sdk.d.ts:4609)", () => {
    const bundle = loadPlugins([{ type: "local", path: plugin(), skipMcpDiscovery: true }]).bundles[0]!;
    expect(bundle.skipMcpDiscovery).toBe(true);
    expect(bundle.mcpServers).toEqual({});
    expect(bundle.skills).toHaveLength(1);
    expect(Object.keys(bundle.agents)).toEqual(["helper"]);
  });

  test("a manifest `hooks` block is carried verbatim for the hook loader", () => {
    const parent = mkTemp("winter-plugin-hooks-");
    const root = join(parent, "hooked");
    mkdirSync(root, { recursive: true });
    const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] };
    write(join(root, WINTER_PLUGIN_MANIFEST_DIR, "plugin.json"), JSON.stringify({ hooks }));
    expect(loadPlugins([{ type: "local", path: root }]).bundles[0]!.hooks).toEqual(hooks);
  });

  test("metadata (description/author/homepage/keywords) is carried for `system/init`", () => {
    const root = plugin({ manifestDir: WINTER_PLUGIN_MANIFEST_DIR, manifest: { description: "does things", author: "someone", homepage: "https://example.invalid", keywords: ["a"] } });
    expect(loadPlugins([{ type: "local", path: root }]).bundles[0]!.metadata).toEqual({ description: "does things", author: "someone", homepage: "https://example.invalid", keywords: ["a"] });
  });

  test("a symlinked plugin root resolves to its real absolute path", () => {
    const root = plugin();
    const linkParent = mkTemp("winter-plugin-link-");
    const link = join(linkParent, "linked");
    symlinkSync(root, link);
    expect(loadPlugins([{ type: "local", path: link }]).bundles[0]!.skills).toHaveLength(1);
  });
});

describe("readPluginManifest", () => {
  test("a missing manifest is neither an error nor a manifest", () => {
    expect(readPluginManifest(mkTemp("winter-nomanifest-"))).toEqual({});
  });

  test("`.winter-plugin` is preferred over `.claude-plugin` when both exist", () => {
    const root = mkTemp("winter-bothmanifests-");
    write(join(root, WINTER_PLUGIN_MANIFEST_DIR, "plugin.json"), JSON.stringify({ name: "winter-native" }));
    write(join(root, CLAUDE_PLUGIN_MANIFEST_DIR, "plugin.json"), JSON.stringify({ name: "cc" }));
    expect(readPluginManifest(root).manifest?.["name"]).toBe("winter-native");
  });

  test("a manifest that is not a JSON OBJECT is an error, not an empty manifest", () => {
    const root = mkTemp("winter-arraymanifest-");
    write(join(root, WINTER_PLUGIN_MANIFEST_DIR, "plugin.json"), "[1,2,3]");
    expect(readPluginManifest(root).error).toBeDefined();
  });
});

describe("the producers T8 wires", () => {
  test("`pluginInitInfo` is the `system/init.plugins` shape: name, resolved path, optional version", () => {
    const withVersion = plugin({ manifestDir: WINTER_PLUGIN_MANIFEST_DIR, manifest: { name: "v", version: "1.0.0" } });
    const without = plugin({ dirName: "no-version" });
    const { bundles } = loadPlugins([{ type: "local", path: withVersion }, { type: "local", path: without }]);
    const info = pluginInitInfo(bundles);
    expect(info[0]).toEqual({ name: "v", path: resolve(withVersion), version: "1.0.0" });
    expect(info[1]).not.toHaveProperty("version");
  });

  test("`pluginAgentDefinitions` is `loadAgentDefinitions`' pluginAgents map, keyed by subagent_type", () => {
    const { bundles } = loadPlugins([{ type: "local", path: plugin() }]);
    const agents = pluginAgentDefinitions(bundles);
    expect(agents["helper"]).toMatchObject({ description: "a helper", model: "sonnet", plugin: "my-plugin", prompt: "You are a helper." });
  });

  test("an EARLIER plugin wins an agent-name collision, matching the loader's own first-wins order", () => {
    const a = plugin({ dirName: "first" });
    const b = plugin({ dirName: "second" });
    const { bundles } = loadPlugins([{ type: "local", path: a }, { type: "local", path: b }]);
    expect(pluginAgentDefinitions(bundles)["helper"]!.plugin).toBe("first");
  });

  test("`pluginSkillContributions` / `pluginCommandContributions` feed the index and the resolver with BARE names", () => {
    const { bundles } = loadPlugins([{ type: "local", path: plugin() }]);
    expect(pluginSkillContributions(bundles)).toEqual([{ plugin: "my-plugin", skills: [{ name: "ship", description: "ships", path: join(resolve(bundles[0]!.path), "skills", "ship", "SKILL.md") }] }]);
    expect(pluginCommandContributions(bundles)[0]!.commands[0]).toMatchObject({ name: "deploy", description: "deploys" });
  });
});
