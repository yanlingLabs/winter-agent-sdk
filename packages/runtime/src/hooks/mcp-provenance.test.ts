// WS-24: `mcp_server_name` / `mcp_tool_name` on a hook's input -- which MCP server a tool call is for,
// read from the registry's owner index (runner.ts's `mcpToolProvenance`), carried on the invocation
// request, and written into BOTH input builders: the command hook's stdin here, the SDK callback's
// `HookInput` in sdk/query.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookEvent } from "@yanlinglabs/winter-agent-sdk";
import { registerMcpServerTools, unregisterMcpServerTools } from "../tools/registry.ts";
import { mcpServerIdentity, mcpToolProvenance, runHooks, type HookInvocationRequest, type HookInvoker, type RunHooksContext } from "./runner.ts";
import { commandHookInput, createCommandHookInvoker } from "./command-invoker.ts";
import { buildHookRegistry, type SourcedHookEntry } from "./registry.ts";

const SERVERS = ["ws24-srv", "winter__sessions"];
const dirs: string[] = [];
afterEach(() => {
  for (const server of SERVERS) unregisterMcpServerTools(server);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function registerFixtures(): void {
  registerMcpServerTools("ws24-srv", [{ name: "do_thing", inputSchema: { type: "object" } }], { deferredDefault: false });
  // A server name that itself contains `__` -- the daemon's capability servers are named this way.
  registerMcpServerTools("winter__sessions", [{ name: "list", inputSchema: { type: "object" } }], { deferredDefault: false });
}

function recordingInvoker(): { invoker: HookInvoker; requests: HookInvocationRequest[] } {
  const requests: HookInvocationRequest[] = [];
  return { requests, invoker: { invoke: async (request) => (requests.push(request), {}) } };
}

function ctx(invoker: HookInvoker, entries: SourcedHookEntry[]): RunHooksContext {
  return { registry: buildHookRegistry(entries), invoker, audit: { record: () => {} }, sessionId: "s", policyVersion: 1, timeouts: { gatingTimeoutMs: 2000, observationalTimeoutMs: 2000 } };
}

describe("mcpToolProvenance", () => {
  test("names the REGISTERING server and the bare tool -- never a split on the first `__`", () => {
    registerFixtures();
    expect(mcpToolProvenance("mcp__ws24-srv__do_thing")).toEqual({ server: "ws24-srv", tool: "do_thing" });
    expect(mcpToolProvenance("mcp__winter__sessions__list")).toEqual({ server: "winter__sessions", tool: "list" });
  });

  test("no provenance for a built-in, for an `mcp__` name no server registered, or once the server is gone", () => {
    registerFixtures();
    expect(mcpToolProvenance("Bash")).toBeUndefined();
    expect(mcpToolProvenance("mcp__nobody__tool")).toBeUndefined();
    unregisterMcpServerTools("ws24-srv");
    expect(mcpToolProvenance("mcp__ws24-srv__do_thing")).toBeUndefined();
  });
});

describe("the invocation request carries it on every tool-scoped event", () => {
  const events: HookEvent[] = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"];
  for (const event of events) {
    test(`${event}: an MCP tool gets mcpServerName/mcpToolName; a built-in gets neither`, async () => {
      registerFixtures();
      const { invoker, requests } = recordingInvoker();
      const c = ctx(invoker, [{ id: "h", event, source: "sdk" }]);
      await runHooks(event, { toolUseID: "tu", toolName: "mcp__winter__sessions__list", input: {} }, c);
      await runHooks(event, { toolUseID: "tu2", toolName: "Bash", input: { command: "ls" } }, c);
      expect(requests[0]).toMatchObject({ toolName: "mcp__winter__sessions__list", mcpServerName: "winter__sessions", mcpToolName: "list" });
      expect("mcpServerName" in requests[1]!).toBe(false);
      expect("mcpToolName" in requests[1]!).toBe(false);
    });
  }

  test("a tool-less event never looks anything up", async () => {
    const { invoker, requests } = recordingInvoker();
    let lookups = 0;
    const c = { ...ctx(invoker, [{ id: "h", event: "SessionStart", source: "sdk" }]), mcpProvenance: () => (lookups++, undefined) };
    await runHooks("SessionStart", { payload: { source: "startup" } }, c);
    expect(requests).toHaveLength(1);
    expect(lookups).toBe(0);
    expect("mcpServerName" in requests[0]!).toBe(false);
  });
});

describe("the command hook's stdin (claude's wire, extended additively)", () => {
  test("commandHookInput writes mcp_server_name / mcp_tool_name beside tool_name", () => {
    const input = commandHookInput(
      { event: "PreToolUse", sessionId: "s", toolName: "mcp__winter__sessions__list", mcpServerName: "winter__sessions", mcpToolName: "list", input: { a: 1 }, policyVersion: "1", requestId: "r", hookId: "h" },
      { cwd: "/w", transcriptPath: "" },
    );
    expect(input).toMatchObject({ tool_name: "mcp__winter__sessions__list", mcp_server_name: "winter__sessions", mcp_tool_name: "list", tool_input: { a: 1 } });
    const builtIn = commandHookInput({ event: "PreToolUse", sessionId: "s", toolName: "Bash", policyVersion: "1", requestId: "r", hookId: "h" }, { cwd: "/w", transcriptPath: "" });
    expect("mcp_server_name" in builtIn).toBe(false);
    expect("mcp_tool_name" in builtIn).toBe(false);
  });

  test("end to end: a real command hook on an MCP tool reads both fields on stdin", async () => {
    registerFixtures();
    const dir = mkdtempSync(join(tmpdir(), "winter-mcp-provenance-"));
    dirs.push(dir);
    const out = join(dir, "stdin.json");
    const entries: SourcedHookEntry[] = [{ id: "PreToolUse:user:0:0", event: "PreToolUse", source: "user", command: `cat > ${JSON.stringify(out)}; echo '{}'` }];
    const invoker = createCommandHookInvoker(entries, { next: recordingInvoker().invoker, cwd: dir });
    await runHooks("PreToolUse", { toolUseID: "tu", toolName: "mcp__ws24-srv__do_thing", input: { x: 1 } }, ctx(invoker, entries));
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "mcp__ws24-srv__do_thing", mcp_server_name: "ws24-srv", mcp_tool_name: "do_thing", tool_input: { x: 1 } });
  });
});

// WS-27: `winter_mcp_server` -- the exact identity of the server the model CALLED, on the three events the
// contract names (PreToolUse / PostToolUse / PostToolUseFailure): the name in the tool name (after any
// rename), the config key before it, and the tool's own stated `readOnlyHint`.
describe("WS-27: mcpServerIdentity and winter_mcp_server", () => {
  const RO = "ws27-ro";
  afterEach(() => unregisterMcpServerTools(RO));
  function registerAnnotated(): void {
    registerMcpServerTools(
      RO,
      [
        { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        { name: "write", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true } },
        { name: "bare", inputSchema: { type: "object" } },
      ],
      { deferredDefault: false },
    );
  }

  test("a plain server: name === configName; readOnlyHint only when the server states it", () => {
    registerAnnotated();
    expect(mcpServerIdentity(`mcp__${RO}__read`)).toEqual({ name: RO, configName: RO, readOnlyHint: true });
    expect(mcpServerIdentity(`mcp__${RO}__write`)).toEqual({ name: RO, configName: RO, readOnlyHint: false });
    const bare = mcpServerIdentity(`mcp__${RO}__bare`)!;
    expect(bare).toEqual({ name: RO, configName: RO });
    expect("readOnlyHint" in bare).toBe(false);
  });

  test("a renamed server (`{ actual: declared }`): name is the connected name, configName the declared one; a `__` server resolves whole", () => {
    registerFixtures();
    registerAnnotated();
    expect(mcpServerIdentity(`mcp__${RO}__read`, { [RO]: "cf" })).toEqual({ name: RO, configName: "cf", readOnlyHint: true });
    expect(mcpServerIdentity("mcp__winter__sessions__list")).toEqual({ name: "winter__sessions", configName: "winter__sessions" });
  });

  test("no identity for a built-in or an unregistered mcp__ name", () => {
    expect(mcpServerIdentity("Bash")).toBeUndefined();
    expect(mcpServerIdentity("mcp__nobody__tool")).toBeUndefined();
  });

  for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const) {
    test(`${event}: the request carries mcpServer -- the caller's when given, else looked up from toolName`, async () => {
      registerAnnotated();
      const { invoker, requests } = recordingInvoker();
      const c = ctx(invoker, [{ id: "h", event, source: "sdk" }]);
      await runHooks(event, { toolUseID: "tu", toolName: `mcp__${RO}__read`, input: {} }, c);
      // The engine's explicit identity wins over the lookup (the hook subject may be a declared spelling).
      await runHooks(event, { toolUseID: "tu2", toolName: "mcp__cf__read", mcpServer: { name: "cf_2", configName: "cf" }, input: {} }, c);
      await runHooks(event, { toolUseID: "tu3", toolName: "Bash", input: { command: "ls" } }, c);
      expect(requests[0]!.mcpServer).toEqual({ name: RO, configName: RO, readOnlyHint: true });
      expect(requests[1]!.mcpServer).toEqual({ name: "cf_2", configName: "cf" });
      expect("mcpServer" in requests[2]!).toBe(false);
    });
  }

  for (const event of ["PermissionRequest", "PermissionDenied"] as const) {
    test(`${event}: not one of the contract's events -- no mcpServer (mcp_server_name still)`, async () => {
      registerAnnotated();
      const { invoker, requests } = recordingInvoker();
      await runHooks(event, { toolUseID: "tu", toolName: `mcp__${RO}__read`, mcpServer: { name: RO, configName: RO }, input: {} }, ctx(invoker, [{ id: "h", event, source: "sdk" }]));
      expect(requests[0]).toMatchObject({ mcpServerName: RO });
      expect("mcpServer" in requests[0]!).toBe(false);
    });
  }

  test("commandHookInput writes winter_mcp_server in snake_case, read_only_hint only when stated", () => {
    const base = { event: "PreToolUse" as const, sessionId: "s", toolName: "mcp__cf_2__read", policyVersion: "1", requestId: "r", hookId: "h" };
    expect(commandHookInput({ ...base, mcpServer: { name: "cf_2", configName: "cf", readOnlyHint: true } }, { cwd: "/w", transcriptPath: "" })).toMatchObject({
      winter_mcp_server: { name: "cf_2", config_name: "cf", read_only_hint: true },
    });
    const noHint = commandHookInput({ ...base, mcpServer: { name: "gh", configName: "gh" } }, { cwd: "/w", transcriptPath: "" });
    expect(noHint["winter_mcp_server"]).toEqual({ name: "gh", config_name: "gh" });
    expect("winter_mcp_server" in commandHookInput({ ...base, toolName: "Bash" }, { cwd: "/w", transcriptPath: "" })).toBe(false);
  });
});
