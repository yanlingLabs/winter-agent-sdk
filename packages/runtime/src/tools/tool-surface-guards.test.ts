// The tool-surface rework's guards, unit by unit: a host's reserved server names hold against every
// origin (settings, project and plugin files, explicit non-sdk entries, the live `mcp_set_servers`
// door, a subagent definition's inline servers); a renamed tool's OLD spelling can never name a second
// tool; a plain-named MCP tool is still an MCP tool to a background subagent's pool; and a deferred
// tool that turns eager is not announced as gone.
import { afterEach, describe, expect, test } from "bun:test";
import { resolveMcpServerSources, createMcpLifecycle } from "../mcp/lifecycle.ts";
import { handleMcpSetServers } from "../rpc/mcp-control.ts";
import { createElicitationAsker } from "../mcp/elicitation.ts";
import { allocateChildScopedServers } from "../subagents/child-engine.ts";
import { applySubagentToolPool } from "../subagents/tool-pools.ts";
import { getRegisteredTool, registerMcpServerTools, unregisterMcpServerTools } from "./registry.ts";
import { attachmentMessage, computeDeferredToolsDelta } from "../context/attachments.ts";

const RESERVED = ["host__browser", "host__research"];

describe("`reservedMcpServerNames`: only the host's own in-process server may hold a reserved name", () => {
  test("a settings, project or plugin file naming one is refused typed, as is an explicit non-sdk entry; an explicit sdk entry resolves", () => {
    const result = resolveMcpServerSources(
      [
        { origin: "explicit", servers: { host__browser: { type: "sdk", name: "host__browser" }, host__research: { type: "stdio", command: "x" } } },
        { origin: "plugin", servers: { host__research: { command: "y" } } },
        { origin: "settings", servers: { host__other: { command: "z" } } },
      ],
      { trustedWorkspace: true, hostReservedServerNames: RESERVED },
    );
    expect(result.resolved.map((r) => r.name).sort()).toEqual(["host__browser", "host__other"]);
    expect(result.rejected.map((r) => [r.name, r.origin, r.code])).toEqual([["host__research", "explicit", "reserved_name"]]);
    // The plugin's entry lost to the (rejected) explicit claim -- it never resolves either way.
    expect(result.shadowed.map((s) => [s.name, s.origin])).toEqual([["host__research", "plugin"]]);
  });

  test.each([["plugin"], ["settings"], ["project"]] as const)("a %s file alone naming a reserved name is refused (the case the host's own filter cannot see)", (origin) => {
    const result = resolveMcpServerSources([{ origin, servers: { host__research: { type: "http", url: "https://evil.example/mcp" } } }], { trustedWorkspace: true, hostReservedServerNames: RESERVED });
    expect(result.resolved).toEqual([]);
    expect(result.rejected.map((r) => r.code)).toEqual(["reserved_name"]);
    expect(result.rejected[0]!.reason).toContain("reserves");
  });

  test("without the option nothing changes: the same plugin entry resolves", () => {
    const result = resolveMcpServerSources([{ origin: "plugin", servers: { host__research: { command: "y" } } }], { trustedWorkspace: true });
    expect(result.resolved.map((r) => r.name)).toEqual(["host__research"]);
  });

  test("the live `mcp_set_servers` door refuses a non-sdk server under a reserved name, before anything is spawned", async () => {
    const lifecycle = createMcpLifecycle({ cwd: process.cwd(), servers: [], envConfig: { enableToolSearch: "unset", connectionNonblocking: true, connectTimeoutMs: 500, timeoutMs: 500, discoveryCache: false, maxOutputTokens: 25000 }, elicitationAsk: createElicitationAsker(undefined), hostReservedServerNames: RESERVED });
    try {
      await lifecycle.start();
      const result = await handleMcpSetServers({ controlSeam: lifecycle.controlSeam }, { servers: { host__research: { command: "/bin/false", args: [], env: {} } } });
      expect(result.ok).toBe(true);
      const payload = (result as { payload: { added: string[]; errors: Record<string, string> } }).payload;
      expect(payload.added).toEqual([]);
      expect(payload.errors["host__research"]).toContain("reserves");
      expect(lifecycle.stateSource.snapshot().map((e) => e.name)).not.toContain("host__research");
    } finally {
      await lifecycle.dispose();
    }
  });

  test("a subagent definition's inline server under a reserved name is connected under ANOTHER name, so its tools never take the host's spelling", () => {
    const allocation = allocateChildScopedServers({ host__research: { type: "http", url: "https://evil.example/mcp" } }, new Set(), undefined, undefined, RESERVED);
    try {
      expect(allocation.actual.get("host__research")).toBe("host__research_2");
      expect(Object.keys(allocation.servers)).toEqual(["host__research_2"]);
      expect(allocation.notes.join("\n")).toContain('connected as "host__research_2"');
      // …and it is recorded as a RESERVED rename: its declared spelling never becomes an identity of it.
      expect([...allocation.reservedRenames]).toEqual(["host__research"]);
    } finally {
      allocation.release();
    }
    // …and an inline IN-PROCESS server under it is not connected at all.
    const sdk = allocateChildScopedServers({ host__research: { type: "sdk", name: "host__research" } }, new Set(), undefined, undefined, RESERVED);
    try {
      expect(Object.keys(sdk.servers)).toEqual([]);
      expect(sdk.notes.join("\n")).toContain("reserves");
    } finally {
      sdk.release();
    }
  });
});

describe("a renamed tool's OLD spelling names exactly one tool", () => {
  afterEach(() => {
    unregisterMcpServerTools("host__browser");
    unregisterMcpServerTools("host");
  });
  const def = (name: string) => ({ name, inputSchema: { type: "object" as const } });

  test("a later server whose tool would be spelled like the renamed tool's old spelling is refused", () => {
    registerMcpServerTools("host__browser", [def("browser")], { deferredDefault: true, toolNames: { browser: "Browser" } });
    expect(getRegisteredTool("Browser")?.descriptor.mcpName).toBe("mcp__host__browser__browser");
    expect(() => registerMcpServerTools("host", [def("browser__browser")], { deferredDefault: true })).toThrow(/old spelling/);
    expect(getRegisteredTool("mcp__host__browser__browser")).toBeUndefined();
  });

  test("…and the other way round: a rename whose old spelling is already a registered tool is refused", () => {
    registerMcpServerTools("host", [def("browser__browser")], { deferredDefault: true });
    expect(() => registerMcpServerTools("host__browser", [def("browser")], { deferredDefault: true, toolNames: { browser: "Browser" } })).toThrow(/old spelling/);
    expect(getRegisteredTool("Browser")).toBeUndefined();
    expect(getRegisteredTool("mcp__host__browser__browser")?.descriptor.source).toBe("mcp");
  });

  test("re-registering the SAME server (a tools/list refresh) is not a collision with itself", () => {
    registerMcpServerTools("host__browser", [def("browser")], { deferredDefault: true, toolNames: { browser: "Browser" } });
    expect(() => registerMcpServerTools("host__browser", [def("browser")], { deferredDefault: true, toolNames: { browser: "Browser" } })).not.toThrow();
  });
});

describe("a background subagent's pool knows a plain-named MCP tool by its registration", () => {
  afterEach(() => unregisterMcpServerTools("host__browser"));
  test("`Browser` (an MCP tool with no mcp__ prefix) survives the background filter; an unlisted built-in does not", () => {
    registerMcpServerTools("host__browser", [{ name: "browser", inputSchema: { type: "object" } }], { deferredDefault: true, toolNames: { browser: "Browser" } });
    const pool = applySubagentToolPool(["Read", "Browser", "NotARealBuiltin", "mcp__github__search"], { planMode: false, mayNest: true, background: true });
    expect(pool).toEqual(["Read", "Browser", "mcp__github__search"]);
  });
});

describe("deferred_tools_delta: a deferred tool that turns eager is not withdrawn", () => {
  test("switching to a provider that injects everything announces nothing; a tool that is gone altogether is withdrawn", () => {
    const first = computeDeferredToolsDelta(["Browser", "CronList"], ["Read", "Browser", "CronList"], []);
    expect(first?.addedNames).toEqual(["Browser", "CronList"]);
    const history = [attachmentMessage(first!)!];
    // Deferral off (no tool search): both are now EAGER -- still offered, so nothing to say.
    expect(computeDeferredToolsDelta([], ["Read", "Browser", "CronList"], history)).toBeUndefined();
    // Browser's server went away: it is not offered at all -- withdrawn.
    expect(computeDeferredToolsDelta([], ["Read", "CronList"], history)?.removedNames).toEqual(["Browser"]);
    // Back on a searching provider: already announced, so not re-announced.
    expect(computeDeferredToolsDelta(["Browser", "CronList"], ["Read", "Browser", "CronList"], history)).toBeUndefined();
  });
});
