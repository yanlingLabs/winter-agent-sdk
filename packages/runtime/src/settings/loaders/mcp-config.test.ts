// Phase 5 Lane S slice 7: the MCP CONFIG LOADERS. They produce Lane A's `McpServerSource[]` input
// and NEVER connect anything -- `resolveMcpServerSources` (mcp/lifecycle.ts, read-only here) is what
// validates, gates on trust and orders them.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMcpServerSources } from "../../mcp/lifecycle.ts";
import { loadPlugins } from "../../plugins/loader.ts";
import type { PluginBundle } from "../../plugins/bundle.ts";
import { globalConfigFileName, WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { loadGlobalConfigMcp, loadProjectMcpConfig, settingsMcpServerSources, PROJECT_MCP_CONFIG_RELATIVE } from "./mcp-config.ts";
import { pluginMcpServerSources } from "./plugin-mcp.ts";

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeMcpJson(repo: string, content: string): string {
  const path = join(repo, PROJECT_MCP_CONFIG_RELATIVE);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function writeGlobalConfig(home: string, content: string): string {
  mkdirSync(home, { recursive: true });
  const path = join(home, globalConfigFileName(WINTER_BRAND));
  writeFileSync(path, content, "utf8");
  return path;
}

describe("loadProjectMcpConfig: `.winter/mcp.json` (WS-01 §2.4)", () => {
  test("a `{ mcpServers }` wrapper produces ONE source at origin `project`", () => {
    const repo = mkTemp("winter-mcp-repo-");
    writeMcpJson(repo, JSON.stringify({ mcpServers: { local: { command: "srv" } } }));
    const result = loadProjectMcpConfig({ cwd: repo });
    expect(result.sources).toEqual([{ origin: "project", servers: { local: { command: "srv" } } }]);
    expect(result.rejected).toEqual([]);
  });

  test("a BARE name->config map is accepted too, matching Settings.mcpServers' own shape", () => {
    const repo = mkTemp("winter-mcp-bare-");
    writeMcpJson(repo, JSON.stringify({ local: { command: "srv" } }));
    expect(loadProjectMcpConfig({ cwd: repo }).sources[0]!.servers).toEqual({ local: { command: "srv" } });
  });

  test("an absent file yields no sources and no rejection", () => {
    expect(loadProjectMcpConfig({ cwd: mkTemp("winter-mcp-none-") })).toEqual({ sources: [], rejected: [] });
  });

  test("a malformed file is REPORTED, never thrown and never silently empty", () => {
    const repo = mkTemp("winter-mcp-bad-");
    writeMcpJson(repo, "{ not json");
    const result = loadProjectMcpConfig({ cwd: repo });
    expect(result.sources).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.origin).toBe("project");
    expect(result.rejected[0]!.path).toBe(join(repo, PROJECT_MCP_CONFIG_RELATIVE));
  });

  test("it is SOURCE-gated: without `project` in settingSources the file is not read at all", () => {
    const repo = mkTemp("winter-mcp-gate-");
    writeMcpJson(repo, JSON.stringify({ mcpServers: { local: { command: "srv" } } }));
    expect(loadProjectMcpConfig({ cwd: repo, settingSources: ["user"] }).sources).toEqual([]);
    expect(loadProjectMcpConfig({ cwd: repo, settingSources: [] }).sources).toEqual([]);
    expect(loadProjectMcpConfig({ cwd: repo, settingSources: ["project"] }).sources).toHaveLength(1);
  });

  test("the loader computes NO trust of its own -- the flagged origin is what carries the gate", () => {
    const repo = mkTemp("winter-mcp-trust-");
    writeMcpJson(repo, JSON.stringify({ mcpServers: { local: { command: "srv" } } }));
    const sources = loadProjectMcpConfig({ cwd: repo }).sources;
    const untrusted = resolveMcpServerSources(sources, { trustedWorkspace: false });
    const trusted = resolveMcpServerSources(sources, { trustedWorkspace: true });
    // RULING P5-K (fix wave): the untrusted verdict is now "loaded DISABLED with a visible reason",
    // not "rejected and invisible" -- the host is who declares trust, and a server it cannot see is
    // one it cannot decide about. Either way the loader itself still computes no trust of its own,
    // which is what this fixture is for.
    expect(untrusted.resolved.map((r) => r.name)).toEqual(["local"]);
    expect(untrusted.resolved[0]!.disabledReason).toContain("trusted workspace");
    expect(trusted.resolved.map((r) => r.name)).toEqual(["local"]);
    expect(trusted.resolved[0]!.disabledReason).toBeUndefined();
  });
});

describe("settingsMcpServerSources: `Settings.mcpServers` per tier", () => {
  const tiers = [
    { source: "user" as const, settings: { mcpServers: { fromUser: { command: "u" } } } },
    { source: "project" as const, path: "/p/.winter/settings.json", settings: { mcpServers: { fromProject: { command: "p" } } } },
    { source: "local" as const, settings: { mcpServers: { fromLocal: { command: "l" } } } },
  ];

  // rd-1: "project-origin", not "stdio" -- RULING P5-K gates every transport, and the tag is what
  // carries a block into that gate regardless of what the block configures.
  test("a PROJECT-tier block is tagged `project`, so it inherits the project-origin trust gate", () => {
    const result = settingsMcpServerSources(tiers);
    const project = result.sources.find((s) => Object.keys(s.servers)[0] === "fromProject");
    expect(project!.origin).toBe("project");
  });

  test("user, local and the two non-file tiers are tagged `settings`", () => {
    const result = settingsMcpServerSources([...tiers, { source: "managed" as const, settings: { mcpServers: { m: { command: "m" } } } }, { source: "flag" as const, settings: { mcpServers: { f: { command: "f" } } } }]);
    const origins = new Map(result.sources.map((s) => [Object.keys(s.servers)[0], s.origin]));
    expect(origins.get("fromUser")).toBe("settings");
    expect(origins.get("fromLocal")).toBe("settings");
    expect(origins.get("m")).toBe("settings");
    expect(origins.get("f")).toBe("settings");
  });

  test("a tier with no mcpServers block contributes nothing and is not a rejection", () => {
    expect(settingsMcpServerSources([{ source: "user", settings: {} }])).toEqual({ sources: [], rejected: [] });
  });

  test("a non-object mcpServers block is reported", () => {
    const result = settingsMcpServerSources([{ source: "user", path: "/u/settings.json", settings: { mcpServers: ["nope"] } }]);
    expect(result.sources).toEqual([]);
    expect(result.rejected[0]!.reason).toContain("object");
  });

  test("`perSource` may be the DetailedResolvedSettings shape (`values`) as well as the pinned one (`settings`)", () => {
    expect(settingsMcpServerSources([{ source: "user", values: { mcpServers: { v: { command: "v" } } } }]).sources[0]!.servers).toEqual({ v: { command: "v" } });
  });
});

describe("pluginMcpServerSources", () => {
  test("each bundle becomes one `plugin`-origin source, in load order", () => {
    const parent = mkTemp("winter-pluginmcp-");
    for (const name of ["first", "second"]) {
      const root = join(parent, name);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { [name]: { command: name } } }), "utf8");
    }
    const { bundles } = loadPlugins([
      { type: "local", path: join(parent, "first") },
      { type: "local", path: join(parent, "second") },
    ]);
    expect(pluginMcpServerSources(bundles)).toEqual([
      { origin: "plugin", servers: { first: { command: "first" } } },
      { origin: "plugin", servers: { second: { command: "second" } } },
    ]);
  });

  test("`skipMcpDiscovery` is re-checked against a HAND-BUILT bundle, not only the loader's own output", () => {
    // Fix round 1, Minor 2: the fixture below goes through `loadPlugins`, which already emptied
    // `mcpServers`, so it cannot fail if the guard is removed -- untested BY CONSTRUCTION, exactly
    // what the guard's own comment names. This one constructs the bundle the guard defends against.
    const bundle: PluginBundle = {
      name: "hand-built",
      path: "/p/hand-built",
      metadata: {},
      skills: [],
      commands: [],
      agents: {},
      mcpServers: { sneaky: { command: "should-not-be-produced" } },
      skipMcpDiscovery: true,
    };
    expect(pluginMcpServerSources([bundle])).toEqual([]);
    expect(pluginMcpServerSources([{ ...bundle, skipMcpDiscovery: false }])).toHaveLength(1);
  });

  test("a `skipMcpDiscovery` plugin contributes NO source at all", () => {
    const parent = mkTemp("winter-pluginmcp-skip-");
    const root = join(parent, "skipped");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { s: { command: "s" } } }), "utf8");
    const { bundles } = loadPlugins([{ type: "local", path: root, skipMcpDiscovery: true }]);
    expect(pluginMcpServerSources(bundles)).toEqual([]);
  });
});

describe("the three loaders compose into Lane A's precedence, unchanged", () => {
  test("settings beats project beats plugin for one contested name", () => {
    const repo = mkTemp("winter-mcp-compose-");
    writeMcpJson(repo, JSON.stringify({ mcpServers: { contested: { command: "from-project-file" } } }));
    const pluginParent = mkTemp("winter-mcp-composeplugin-");
    const pluginRoot = join(pluginParent, "p");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, ".mcp.json"), JSON.stringify({ mcpServers: { contested: { command: "from-plugin" } } }), "utf8");
    const { bundles } = loadPlugins([{ type: "local", path: pluginRoot }]);

    const sources = [
      ...settingsMcpServerSources([{ source: "user", settings: { mcpServers: { contested: { command: "from-settings" } } } }]).sources,
      ...loadProjectMcpConfig({ cwd: repo }).sources,
      ...pluginMcpServerSources(bundles),
    ];
    const resolved = resolveMcpServerSources(sources, { trustedWorkspace: true });
    expect(resolved.resolved).toHaveLength(1);
    expect(resolved.resolved[0]!.config).toEqual({ command: "from-settings" });
    expect(resolved.shadowed.map((s) => s.origin).sort()).toEqual(["plugin", "project"]);
  });

  test("`strictMcpConfig` drops every one of these ambient sources", () => {
    const repo = mkTemp("winter-mcp-strict-");
    writeMcpJson(repo, JSON.stringify({ mcpServers: { local: { command: "srv" } } }));
    const resolved = resolveMcpServerSources(loadProjectMcpConfig({ cwd: repo }).sources, { trustedWorkspace: true, strictMcpConfig: true });
    expect(resolved.resolved).toEqual([]);
  });
});

// WS-21 §6.3 item 3 (F9): the shared home's global config file, `.winter.json` -- claude's
// `.claude.json` shape, `mcpServers` for `user` and `projects[<key>].mcpServers` for `local`.
describe("loadGlobalConfigMcp: `.winter.json` user and local MCP scopes", () => {
  test("user servers are loaded under [\"user\"]", () => {
    const home = mkTemp("winter-global-home-");
    const cwd = mkTemp("winter-global-cwd-");
    writeGlobalConfig(home, JSON.stringify({ mcpServers: { shared: { command: "user-srv" } } }));
    const result = loadGlobalConfigMcp({ home, cwd, gitRoot: null, brand: WINTER_BRAND, sources: ["user"] });
    expect(result.user).toEqual({ shared: { command: "user-srv" } });
    expect(result.local).toEqual({});
    expect(result.rejected).toEqual([]);
  });

  test("local servers are NOT loaded under [\"user\"] alone, but ARE loaded with `local`", () => {
    const home = mkTemp("winter-global-home-");
    const repo = mkTemp("winter-global-repo-");
    writeGlobalConfig(home, JSON.stringify({ projects: { [repo]: { mcpServers: { proj: { command: "local-srv" } } } } }));
    const withoutLocal = loadGlobalConfigMcp({ home, cwd: repo, gitRoot: null, brand: WINTER_BRAND, sources: ["user"] });
    expect(withoutLocal.local).toEqual({});
    const withLocal = loadGlobalConfigMcp({ home, cwd: repo, gitRoot: null, brand: WINTER_BRAND, sources: ["user", "local"] });
    expect(withLocal.local).toEqual({ proj: { command: "local-srv" } });
  });

  test("the local scope is keyed by the CANONICAL GIT ROOT when one is given, not the raw cwd (claude's getProjectPathForConfig)", () => {
    const home = mkTemp("winter-global-home-");
    const gitRoot = mkTemp("winter-global-gitroot-");
    const cwd = join(gitRoot, "sub", "dir");
    mkdirSync(cwd, { recursive: true });
    writeGlobalConfig(home, JSON.stringify({ projects: { [gitRoot]: { mcpServers: { proj: { command: "root-srv" } } } } }));
    // Keyed by the cwd itself, NOT the git root: this must find nothing.
    const keyedByCwd = loadGlobalConfigMcp({ home, cwd, gitRoot: null, brand: WINTER_BRAND, sources: ["local"] });
    expect(keyedByCwd.local).toEqual({});
    // Keyed by the git root (the caller's own resolution, threaded through `gitRoot`): this finds it.
    const keyedByGitRoot = loadGlobalConfigMcp({ home, cwd, gitRoot, brand: WINTER_BRAND, sources: ["local"] });
    expect(keyedByGitRoot.local).toEqual({ proj: { command: "root-srv" } });
  });

  test("local wins a name clash (the two scopes are returned separately; a caller merging `{...user, ...local}` gets local)", () => {
    const home = mkTemp("winter-global-home-");
    const repo = mkTemp("winter-global-clash-repo-");
    writeGlobalConfig(
      home,
      JSON.stringify({
        mcpServers: { contested: { command: "from-user" } },
        projects: { [repo]: { mcpServers: { contested: { command: "from-local" } } } },
      }),
    );
    const result = loadGlobalConfigMcp({ home, cwd: repo, gitRoot: null, brand: WINTER_BRAND, sources: ["user", "local"] });
    expect(result.user).toEqual({ contested: { command: "from-user" } });
    expect(result.local).toEqual({ contested: { command: "from-local" } });
    expect({ ...result.user, ...result.local }).toEqual({ contested: { command: "from-local" } });
  });

  test("a malformed file produces a scan error, not a throw", () => {
    const home = mkTemp("winter-global-home-");
    const cwd = mkTemp("winter-global-cwd-");
    writeGlobalConfig(home, "{ not valid json");
    let result: ReturnType<typeof loadGlobalConfigMcp> | undefined;
    expect(() => {
      result = loadGlobalConfigMcp({ home, cwd, gitRoot: null, brand: WINTER_BRAND, sources: ["user", "local"] });
    }).not.toThrow();
    expect(result!.user).toEqual({});
    expect(result!.local).toEqual({});
    expect(result!.rejected).toHaveLength(1);
    expect(result!.rejected[0]!.reason).toContain("not valid JSON");
  });

  test("an absent file is not a rejection", () => {
    const home = mkTemp("winter-global-home-");
    const cwd = mkTemp("winter-global-cwd-");
    const result = loadGlobalConfigMcp({ home, cwd, gitRoot: null, brand: WINTER_BRAND, sources: ["user", "local"] });
    expect(result).toEqual({ user: {}, local: {}, rejected: [] });
  });
});
