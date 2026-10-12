import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { installHostCodeProtection } from "./host-code-protection.ts";
import { installSourceReadRestrictions, readSourceText, sourceReadRestrictionGeneration } from "./source-read.ts";
import { readWhole, readCapped, readCappedLinesAndBytes } from "../context/injection.ts";
import { expandImports } from "../context/imports.ts";
import { loadRules } from "../context/rules.ts";
import { resolveOutputStyle } from "../context/output-styles.ts";
import { readSkillMetadata, scanSkillRoot } from "../skills/loader.ts";
import { SkillIndex } from "../skills/store.ts";
import { loadAgentDefinitions } from "../subagents/definitions.ts";
import { loadPlugins } from "../plugins/loader.ts";
import { pluginAgentDefinitions } from "../plugins/bundle.ts";
import { readInstalledPlugins, resolveEnabledPlugins } from "../plugins/installed.ts";
import { loadSettingsFile, resolveSettingsDetailed } from "../settings/resolve.ts";
import { loadGlobalConfigMcp, loadProjectMcpConfig } from "../settings/loaders/mcp-config.ts";
import { FilesystemCommandResolver } from "../commands/resolver.ts";
import { listWorkflowsForListing, resolveWorkflowByName } from "../workflows/store.ts";
import { buildProductionWiring } from "../production-wiring.ts";
import { runEngine } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { createSystemPromptAssembler } from "../context/assembler.ts";
import { stubExecutor } from "../provider/mock.ts";

let root: string, cwd: string, home: string, denied: string;
const close: Array<() => void> = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "winter-source-policy-")));
  cwd = join(root, "repo"); home = join(root, "runhome"); denied = join(cwd, "cowork");
  for (const p of [cwd, home, denied]) mkdirSync(p, { recursive: true });
});
afterEach(() => { for (const fn of close.splice(0).reverse()) fn(); rmSync(root, { recursive: true, force: true }); });
function write(path: string, text: string): string { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path; }
function link(path: string, target: string) { mkdirSync(dirname(path), { recursive: true }); symlinkSync(target, path); }
function protect() { const lease = installHostCodeProtection({ revision: 1, denyReadPaths: [denied], denyWritePaths: [] }); close.push(() => lease.close()); return lease; }
function gitRepo() { execFileSync("git", ["init", "--quiet", cwd], { env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }); }
const skill = "---\ndescription: SECRET-DESCRIPTION\n---\nSECRET-BODY";
const agent = "---\nname: secret-agent\ndescription: SECRET-DESCRIPTION\n---\nSECRET-BODY";
const workflow = 'export const meta = { name: "secret-workflow", description: "SECRET-DESCRIPTION" };\nreturn "SECRET-BODY";';

test("live policy is checked again after pending asynchronous source I/O", async () => {
  const file = write(join(denied, "data.ext4"), "SECRET-BODY");
  const lease = installHostCodeProtection({ revision: 0, denyReadPaths: [], denyWritePaths: [] }); close.push(() => lease.close());
  const generation = sourceReadRestrictionGeneration();
  const pending = readSourceText(file);
  lease.update({ revision: 1, denyReadPaths: [denied], denyWritePaths: [] });
  expect(sourceReadRestrictionGeneration()).toBeGreaterThan(generation);
  await expect(pending).rejects.toThrow("protected host path");
});

test("actual production startup uses native sandbox read denies before settings and prompt assembly", async () => {
  gitRepo();
  const image = write(join(denied, "data.ext4"), "SECRET-BODY");
  link(join(cwd, "leak.md"), image);
  write(join(cwd, "good.md"), "ALLOWED-GUIDANCE");
  write(join(cwd, "WINTER.md"), "REPO-GUIDANCE\n@./leak.md\n@./good.md");
  write(join(home, "WINTER.md"), "USER-GUIDANCE");
  link(join(cwd, ".winter", "settings.json"), write(join(denied, "settings.json"), JSON.stringify({ outputStyle: "learning", env: { SECRET_VAR: "SECRET-BODY" } })));
  const config = { sessionId: "native-source-fixture", cwd, winterHome: home, model: "winter-test/echo", trustedWorkspace: true, sandbox: { filesystem: { denyRead: [denied] } } };
  const wiring = await buildProductionWiring({ config, env: { WINTER_HOME: home }, winterHome: home, provider: { credentials: createMemoryCredentialStore() } });
  close.push(() => wiring.dispose());
  expect(wiring.settings()?.outputStyle).toBeUndefined();
  expect(wiring.settingsEnv.SECRET_VAR).toBeUndefined();
  const input = { config: wiring.config, cwd, env: { WINTER_HOME: home }, platform: "darwin", osVersion: "fixture", shell: "/bin/sh", date: "2026-10-12" };
  const assembler = wiring.engineOptions.systemPromptAssembler!;
  const prompt = JSON.stringify([assembler.assemble(input), assembler.userContext?.(input)]);
  expect(prompt).toContain("ALLOWED-GUIDANCE"); expect(prompt).toContain("USER-GUIDANCE"); expect(prompt).toContain("REPO-GUIDANCE");
  expect(prompt).not.toContain("SECRET-BODY");
});

test("injection, recursive rules and output styles refuse protected file and directory aliases", () => {
  protect(); const secret = write(join(denied, "context.md"), "SECRET-BODY");
  link(join(home, "context.md"), secret);
  expect(readWhole(join(home, "context.md"))).toBeNull();
  expect(readCapped(join(home, "context.md"), 50)).toBeNull();
  expect(readCappedLinesAndBytes(join(home, "context.md"), 10, 50)).toBeNull();
  link(join(cwd, ".winter", "rules", "secret.md"), secret);
  write(join(cwd, ".winter", "rules", "good.md"), "ALLOWED-RULE");
  link(join(cwd, ".winter", "rules", "aliasdir"), denied);
  const rules = loadRules({ home, cwd, projectRoot: cwd, sources: ["project"], brand: WINTER_BRAND });
  expect(JSON.stringify(rules)).toContain("ALLOWED-RULE"); expect(JSON.stringify(rules)).not.toContain("SECRET-BODY");
  link(join(cwd, ".winter", "output-styles", "secret.md"), secret);
  write(join(cwd, ".winter", "output-styles", "good.md"), "---\nname: good\ndescription: ALLOWED\n---\nALLOWED-STYLE");
  expect(resolveOutputStyle("secret", { home, cwd })).toBeNull();
  expect(resolveOutputStyle("good", { home, cwd })?.body).toContain("ALLOWED-STYLE");
});

test("skill metadata prefix and invocation recheck live symlink targets", () => {
  const target = write(join(denied, "SKILL.md"), skill);
  link(join(cwd, ".winter", "skills", "secret", "SKILL.md"), target);
  write(join(cwd, ".winter", "skills", "good", "SKILL.md"), "---\ndescription: ALLOWED-DESCRIPTION\n---\nALLOWED-BODY");
  const index = SkillIndex.build({ cwd, winterHome: home });
  expect(index.load("secret")?.body).toContain("SECRET-BODY");
  protect();
  expect(readSkillMetadata(target, "secret", { maxBytes: 65536 }).ok).toBe(false);
  expect(readSkillMetadata(target, "secret").ok).toBe(false);
  expect(scanSkillRoot(denied, "user").skills).toEqual([]);
  expect(index.load("secret")).toBeNull(); expect(index.names()).not.toContain("secret");
  expect(index.load("good")?.body).toBe("ALLOWED-BODY");
});

test("project agents and cached plugin-agent provenance refuse after activation", () => {
  const target = write(join(denied, "helper.md"), agent);
  link(join(cwd, ".winter", "agents", "helper.md"), target);
  const plugin = join(root, "plugin"); link(join(plugin, "agents", "helper.md"), target);
  const bundles = loadPlugins([{ type: "local", path: plugin }]).bundles;
  const pluginAgents = pluginAgentDefinitions(bundles);
  expect(Object.keys(pluginAgents)).toContain("secret-agent");
  protect();
  const defs = loadAgentDefinitions({ cwd, home, winterHome: home, trustedWorkspace: true, pluginAgents });
  expect(defs.has("secret-agent")).toBe(false);
  write(join(cwd, ".winter", "agents", "good.md"), "---\nname: good\ndescription: ALLOWED\n---\nALLOWED-BODY");
  expect(loadAgentDefinitions({ cwd, home, winterHome: home, trustedWorkspace: true }).get("good")?.prompt).toBe("ALLOWED-BODY");
});

test("plugins guard manifests, components, hooks, MCP and installation source ledgers", () => {
  protect(); const plugin = join(root, "plugin"); mkdirSync(plugin);
  write(join(plugin, ".winter-plugin", "plugin.json"), JSON.stringify({ name: "safe-plugin" }));
  for (const [relative, content] of [["skills/secret/SKILL.md", skill], ["agents/helper.md", agent], ["commands/secret.md", "SECRET-BODY"], ["hooks/hooks.json", JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "SECRET-BODY" }] }] } })], [".mcp.json", JSON.stringify({ mcpServers: { secret: { command: "SECRET-BODY" } } })]]) link(join(plugin, relative!), write(join(denied, relative!), content!));
  write(join(plugin, "commands", "good.md"), "ALLOWED-COMMAND");
  const loaded = loadPlugins([{ type: "local", path: plugin }]);
  expect(loaded.bundles).toHaveLength(1); expect(loaded.bundles[0]?.commands.map(v => v.name)).toEqual(["good"]);
  expect(JSON.stringify(loaded)).not.toContain("SECRET-BODY"); expect(JSON.stringify(loaded)).not.toContain("SECRET-DESCRIPTION");
  link(join(root, "manifest-plugin", ".winter-plugin", "plugin.json"), write(join(denied, "manifest.json"), JSON.stringify({ name: "secret-plugin", description: "SECRET-BODY" })));
  expect(JSON.stringify(loadPlugins([{ type: "local", path: join(root, "manifest-plugin") }]))).not.toContain("SECRET-BODY");
  const ledger = join(root, "plugins");
  link(join(ledger, "installed_plugins.json"), write(join(denied, "installed.json"), JSON.stringify({ plugins: { secret: [{ installPath: "SECRET-BODY" }] } })));
  link(join(ledger, "known_marketplaces.json"), write(join(denied, "known.json"), JSON.stringify({ marketplace: { source: { source: "directory" }, installLocation: "SECRET-BODY" } })));
  expect(readInstalledPlugins(ledger)).toEqual([]); expect(resolveEnabledPlugins(ledger, { "secret@marketplace": true })).toEqual([]);
});

test("settings and MCP guards preserve the fixed own control read without a source bypass", async () => {
  const config = write(join(home, ".winter.json"), JSON.stringify({ mcpServers: { allowed: { command: "/fixture/server" } } }));
  close.push(installSourceReadRestrictions([config, denied], cwd));
  const input = { home, cwd, gitRoot: null, brand: WINTER_BRAND, sources: ["user" as const] };
  expect(loadGlobalConfigMcp(input).user.allowed).toEqual({ command: "/fixture/server" });
  expect(readWhole(config)).toBeNull(); // A source import never inherits the control exception.
  const imported = expandImports({ content: "@" + config, filePath: join(home, "WINTER.md"), tier: "user", projectRoot: null });
  expect(imported.content).not.toContain("/fixture/server");
  link(join(cwd, "control-alias.md"), config);
  expect(readWhole(join(cwd, "control-alias.md"))).toBeNull();
  protect();
  expect(loadGlobalConfigMcp(input).user.allowed).toBeDefined();
  link(join(cwd, ".winter", "settings.json"), write(join(denied, "settings.json"), JSON.stringify({ outputStyle: "learning" })));
  link(join(cwd, ".winter", "mcp.json"), write(join(denied, "mcp.json"), JSON.stringify({ mcpServers: { secret: { command: "SECRET-BODY" } } })));
  expect((await loadSettingsFile(join(cwd, ".winter", "settings.json"))).loaded).toBe(false);
  expect((await resolveSettingsDetailed({ cwd, winterHome: home })).effective.outputStyle).toBeUndefined();
  expect(loadProjectMcpConfig({ cwd }).sources).toEqual([]);
  unlinkSync(config); link(config, join(denied, "mcp.json"));
  expect(loadGlobalConfigMcp(input).user).toEqual({});
  // Even a regular own-looking control file cannot bypass a broader Cowork directory restriction.
  write(join(denied, ".winter.json"), JSON.stringify({ mcpServers: { secret: { command: "SECRET-BODY" } } }));
  expect(loadGlobalConfigMcp({ ...input, home: denied }).user).toEqual({});
});

test("command and workflow source paths refuse protected aliases and retain allowed entries", async () => {
  protect();
  link(join(cwd, ".winter", "commands", "secret.md"), write(join(denied, "command.md"), "SECRET-BODY"));
  write(join(cwd, ".winter", "commands", "good.md"), "ALLOWED-COMMAND");
  link(join(cwd, ".winter", "workflows", "secret.js"), write(join(denied, "workflow.js"), workflow));
  write(join(cwd, ".winter", "workflows", "good.js"), 'export const meta = { name: "good", description: "ALLOWED" };\nreturn "ALLOWED-BODY";');
  const commands = FilesystemCommandResolver.build({ cwd, winterHome: home });
  expect(await commands.resolve("/secret", cwd)).toEqual({ kind: "none" });
  expect((await commands.resolve("/good", cwd) as { text: string }).text).toBe("ALLOWED-COMMAND");
  expect(resolveWorkflowByName("secret", { cwd, trustedWorkspace: true }).ok).toBe(false);
  expect(resolveWorkflowByName("good", { cwd, trustedWorkspace: true }).ok).toBe(true);
  expect(listWorkflowsForListing({ cwd, trustedWorkspace: true }).map(v => v.name)).toEqual(["good"]);
});


test("standalone global MCP config keeps ordinary symlink behavior without control exemption", () => {
  const target = write(join(root, "ordinary-config.json"), JSON.stringify({ mcpServers: { allowed: { command: "/fixture/server" } } }));
  link(join(home, ".winter.json"), target);
  expect(loadGlobalConfigMcp({ home, cwd, gitRoot: null, brand: WINTER_BRAND, sources: ["user"] }).user.allowed).toBeDefined();
});

test("a live host policy refresh rebuilds the engine's cached instruction context", async () => {
  write(join(denied, "data.ext4"), "SECRET-BODY");
  write(join(home, "WINTER.md"), "ALLOWED-GUIDANCE\n@" + join(denied, "data.ext4"));
  const lease = installHostCodeProtection({ revision: 0, denyReadPaths: [], denyWritePaths: [] }); close.push(() => lease.close());
  const requests: string[] = [];
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: "context-refresh", cwd, winterHome: home, model: "fixture", settingSources: ["user"] },
    input: runtime.input, output: runtime.output, tools: stubExecutor,
    systemPromptAssembler: createSystemPromptAssembler({ home }),
    provider: { async generate(input) {
      requests.push(JSON.stringify({ system: input.system, messages: input.messages }));
      if (requests.length === 1) lease.update({ revision: 1, denyReadPaths: [denied], denyWritePaths: [] });
      return { kind: "text", text: "OK" };
    } },
  });
  host.output.write({ type: "user", text: "first" }); host.output.write({ type: "user", text: "second" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const frames = []; for await (const frame of host.input) frames.push(frame);
  await done;
  expect(requests, JSON.stringify(frames)).toHaveLength(2);
  expect(JSON.stringify(requests[0])).toContain("SECRET-BODY");
  expect(JSON.stringify(requests[1])).not.toContain("SECRET-BODY");
  expect(JSON.stringify(requests[1])).toContain("ALLOWED-GUIDANCE");
});
