// The host's say over the tool surface, end to end through the REAL engine and the REAL registry:
//
//   * PLAIN-NAMED in-process tools (`McpSdkServerConfig.toolNames`): advertised, called, hooked and
//     denied under the plain name, forwarded to the host under the server's own tool name, deferrable
//     like any MCP tool -- and the `mcp__<server>__<tool>` spelling still governs them.
//   * `tools` (claude's own option): the BUILT-IN set, a visibility list, MCP tools untouched; no
//     `ToolSearch` in it means no deferral; opt-in built-ins (`Search`) only when named.
//   * `deferTools`: a built-in (`CronList`) starts deferred while Tool Search is active, loads through
//     ToolSearch and runs; with a provider that cannot search, full injection still holds and so does
//     the `tools` filter.
//
// Ground truth is the LIVE provider request (`tools`), the host-facing frames and the `sdk_mcp_call`s.
import { afterEach, describe, expect, test } from "bun:test";
import type { ControlRequestFrame, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions, type ProviderRequest, type ProviderTurn } from "../engine.ts";
import { getRegisteredTool, replaceExecutor } from "./registry.ts";
import { createSearchExecutor, EXA_ANSWER_URL } from "./impl/search.ts";
import { testProviderByName } from "../provider/mock.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest } from "../subagents/child-handle.ts";
import { createChildEngineFactory } from "../subagents/child-engine.ts";

interface Driven {
  requests: ProviderRequest[];
  frames: WinterFrame[];
  sdkCalls: Array<{ server?: string; tool?: string; arguments?: unknown }>;
  hookPayloads: Array<Record<string, unknown>>;
  permissionPayloads: Array<Record<string, unknown>>;
  error?: unknown;
}

let seq = 0;

async function drive(over: Partial<RuntimeConfig>, script: ProviderTurn[], extra: Partial<EngineOptions> = {}): Promise<Driven> {
  const requests: ProviderRequest[] = [];
  const frames: WinterFrame[] = [];
  const sdkCalls: Driven["sdkCalls"] = [];
  const hookPayloads: Driven["hookPayloads"] = [];
  const permissionPayloads: Driven["permissionPayloads"] = [];
  const { host, runtime } = createInMemoryChannel();
  const config: RuntimeConfig = { sessionId: `tool-surface-${++seq}`, cwd: "/tmp/x", model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, ...over };
  let error: unknown;
  const done = runEngine({
    config,
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages), ...(req.tools !== undefined ? { tools: structuredClone(req.tools) } : {}) });
        return script[requests.length - 1] ?? { kind: "text", text: "done" };
      },
    },
    ...extra,
  } as EngineOptions).catch((err: unknown) => {
    error = err;
  });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const reader = (async () => {
    for await (const f of host.input) {
      frames.push(f);
      if (f.type !== "control_request") continue;
      const cf = f as ControlRequestFrame;
      if (cf.subtype === "sdk_mcp_call") {
        const payload = cf.payload as Driven["sdkCalls"][number];
        sdkCalls.push(payload);
        host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: { content: [{ type: "text", text: `${payload.tool} ran` }] } });
      } else if (cf.subtype === "hook") {
        hookPayloads.push(cf.payload as Record<string, unknown>);
        host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: {} });
      } else if (cf.subtype === "permission") {
        permissionPayloads.push(cf.payload as Record<string, unknown>);
        host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: { behavior: "allow" } });
      }
    }
  })();
  await done;
  // A run that THREW at startup never ends its output stream (a real host sees the child exit); the
  // frames written before the throw are all there is.
  await (error === undefined ? reader : Promise.race([reader, new Promise((r) => setTimeout(r, 50))]));
  return { requests, frames, sdkCalls, hookPayloads, permissionPayloads, ...(error !== undefined ? { error } : {}) };
}

const names = (req: ProviderRequest | undefined): string[] => (req?.tools ?? []).map((t) => t.name);
const messages = (frames: WinterFrame[]): Array<Record<string, unknown>> =>
  frames.filter((f) => f.type === "data").map((f) => (f as unknown as { message: Record<string, unknown> }).message);
const initTools = (frames: WinterFrame[]): string[] => {
  const init = messages(frames).find((m) => m["type"] === "system" && m["subtype"] === "init") as { tools?: string[] } | undefined;
  return init?.tools ?? [];
};
const toolResult = (frames: WinterFrame[], id: string): Record<string, unknown> | undefined =>
  messages(frames)
    .filter((m) => m["type"] === "user")
    .flatMap((m) => ((m["message"] as { content?: unknown })?.content as Array<Record<string, unknown>> | undefined) ?? [])
    .find((b) => b["type"] === "tool_result" && b["tool_use_id"] === id);
const toolUseNames = (frames: WinterFrame[]): string[] =>
  messages(frames)
    .filter((m) => m["type"] === "assistant")
    .flatMap((m) => ((m["message"] as { content?: unknown })?.content as Array<Record<string, unknown>> | undefined) ?? [])
    .filter((b) => b["type"] === "tool_use")
    .map((b) => String(b["name"]));

const BROWSER_SERVER = "host__browser";
function plainServer(over: { tools?: Array<{ name: string; _meta?: Record<string, unknown> }>; toolNames?: Record<string, string> } = {}): NonNullable<RuntimeConfig["mcpServers"]> {
  return {
    [BROWSER_SERVER]: {
      type: "sdk",
      name: BROWSER_SERVER,
      tools: (over.tools ?? [{ name: "browser" }, { name: "spawn", _meta: { "anthropic/alwaysLoad": true } }]).map((t) => ({ ...t, inputSchema: { type: "object" } })),
      toolNames: over.toolNames ?? { browser: "Browser", spawn: "SpawnSession" },
    },
  };
}

afterEach(() => {
  // Registry singleton hygiene: every run's own sdk registrations are gone after its teardown.
  expect(getRegisteredTool("Browser")).toBeUndefined();
  expect(getRegisteredTool("SpawnSession")).toBeUndefined();
});

describe("plain-named in-process tools (`toolNames`)", () => {
  test("advertised to the model under the plain name, called under it, forwarded to the host under the server's own tool name", async () => {
    const d = await drive({ mcpServers: plainServer() }, [{ kind: "tool_use", calls: [{ id: "c1", name: "Browser", input: { url: "https://a.example/" } }] }, { kind: "text", text: "ok" }]);
    expect(d.error).toBeUndefined();
    expect(names(d.requests[0])).toContain("Browser");
    expect(names(d.requests[0])).toContain("SpawnSession");
    expect(names(d.requests[0]).some((n) => n.startsWith(`mcp__${BROWSER_SERVER}`))).toBe(false);
    expect(initTools(d.frames)).toEqual(expect.arrayContaining(["Browser", "SpawnSession"]));
    expect(d.sdkCalls).toEqual([{ server: BROWSER_SERVER, tool: "browser", arguments: { url: "https://a.example/" } }]);
    expect(toolResult(d.frames, "c1")?.["content"]).toBe("browser ran");
    expect(toolUseNames(d.frames)).toEqual(["Browser"]);
  });

  test("a hook sees the plain name, and the server it belongs to (the MCP provenance and `winter_mcp_server`)", async () => {
    const d = await drive({ mcpServers: plainServer(), hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] } }, [{ kind: "tool_use", calls: [{ id: "c1", name: "Browser", input: {} }] }, { kind: "text", text: "ok" }]);
    const pre = d.hookPayloads.find((p) => p["event"] === "PreToolUse");
    expect(pre?.["toolName"]).toBe("Browser");
    expect(pre?.["mcpServerName"]).toBe(BROWSER_SERVER);
    expect(pre?.["mcpToolName"]).toBe("browser");
    expect((pre?.["mcpServer"] as { name?: string } | undefined)?.name).toBe(BROWSER_SERVER);
  });

  test("the OLD spelling still governs: a bare `disallowedTools` entry on it hides the tool and its calls never run", async () => {
    const d = await drive({ mcpServers: plainServer(), disallowedTools: [`mcp__${BROWSER_SERVER}__browser`] }, [{ kind: "tool_use", calls: [{ id: "c1", name: "Browser", input: {} }] }, { kind: "text", text: "ok" }]);
    expect(names(d.requests[0])).not.toContain("Browser");
    expect(names(d.requests[0])).toContain("SpawnSession");
    expect(d.sdkCalls).toEqual([]);
    expect(String(toolResult(d.frames, "c1")?.["content"])).not.toBe("browser ran");
  });

  // (A bare `mcp__<server>` rule names no tool in this runtime's grammar for ANY MCP tool -- the server
  // glob is `mcp__<server>__*` -- so it is not a case here.)
  test.each([[`mcp__${BROWSER_SERVER}__spawn`], [`mcp__${BROWSER_SERVER}__*`]])("the OLD spelling still governs: a deny rule %s denies the plain-named call, reported under its plain name", async (rule) => {
    const d = await drive({ mcpServers: plainServer(), permissions: { deny: [rule] } }, [{ kind: "tool_use", calls: [{ id: "c1", name: "SpawnSession", input: {} }] }, { kind: "text", text: "ok" }]);
    expect(d.sdkCalls).toEqual([]);
    const denied = messages(d.frames).find((m) => m["type"] === "system" && m["subtype"] === "permission_denied");
    expect(denied?.["tool_name"]).toBe("SpawnSession");
  });

  test("the OLD spelling still governs: a hook whose matcher names it fires for the plain-named call", async () => {
    const d = await drive(
      { mcpServers: plainServer(), hooks: { PreToolUse: [{ hookCount: 1, source: "sdk", matcher: `mcp__${BROWSER_SERVER}__browser` }] } },
      [{ kind: "tool_use", calls: [{ id: "c1", name: "Browser", input: {} }, { id: "c2", name: "SpawnSession", input: {} }] }, { kind: "text", text: "ok" }],
    );
    const pre = d.hookPayloads.filter((p) => p["event"] === "PreToolUse");
    expect(pre).toHaveLength(1);
    expect(pre[0]?.["mcpToolName"]).toBe("browser");
    // The identity FOLLOWS what governs (as for an alias): the matcher named the old spelling, so the
    // hook runs under it. Unmatched hooks see the plain name (the test above).
    expect(pre[0]?.["toolName"]).toBe(`mcp__${BROWSER_SERVER}__browser`);
  });

  test("the OLD spelling still governs as an ALLOW rule: in default mode the plain-named call runs with no prompt (a saved rule keeps working)", async () => {
    const script: ProviderTurn[] = [{ kind: "tool_use", calls: [{ id: "c1", name: "SpawnSession", input: {} }] }, { kind: "text", text: "ok" }];
    const prompted = await drive({ mcpServers: plainServer(), permissionMode: "default", allowDangerouslySkipPermissions: false }, script);
    // Without a rule, an MCP call in default mode asks — the baseline the rule below must change.
    expect(prompted.permissionPayloads.length).toBe(1);
    expect(prompted.permissionPayloads[0]!["toolName"] ?? prompted.permissionPayloads[0]!["tool_name"]).toBe("SpawnSession");
    const allowed = await drive({ mcpServers: plainServer(), permissionMode: "default", allowDangerouslySkipPermissions: false, allowedTools: [`mcp__${BROWSER_SERVER}__spawn`] }, script);
    expect(allowed.permissionPayloads).toEqual([]);
    expect(allowed.sdkCalls).toEqual([{ server: BROWSER_SERVER, tool: "spawn", arguments: {} }]);
  });

  test("the OLD spelling still governs as an ASK rule: the plain-named call prompts even under bypassPermissions", async () => {
    const script: ProviderTurn[] = [{ kind: "tool_use", calls: [{ id: "c1", name: "SpawnSession", input: {} }] }, { kind: "text", text: "ok" }];
    const bypass = await drive({ mcpServers: plainServer() }, script);
    expect(bypass.permissionPayloads).toEqual([]);
    const asked = await drive({ mcpServers: plainServer(), permissions: { ask: [`mcp__${BROWSER_SERVER}__spawn`] } }, script);
    expect(asked.permissionPayloads.length).toBe(1);
    // …and the prompt names the spelling the governing rule named (strictest-of identity, as for an alias).
    expect(asked.permissionPayloads[0]!["toolName"] ?? asked.permissionPayloads[0]!["tool_name"]).toBe(`mcp__${BROWSER_SERVER}__spawn`);
    // The host answered allow, so it ran.
    expect(asked.sdkCalls).toEqual([{ server: BROWSER_SERVER, tool: "spawn", arguments: {} }]);
  });

  test("a MODEL call under the OLD spelling (a resumed history taught it) runs as the plain-named tool", async () => {
    const d = await drive({ mcpServers: plainServer() }, [{ kind: "tool_use", calls: [{ id: "c1", name: `mcp__${BROWSER_SERVER}__spawn`, input: { a: 1 } }] }, { kind: "text", text: "ok" }]);
    expect(d.sdkCalls).toEqual([{ server: BROWSER_SERVER, tool: "spawn", arguments: { a: 1 } }]);
    expect(toolResult(d.frames, "c1")?.["content"]).toBe("spawn ran");
    // The history keeps the tool_use exactly as the model wrote it.
    expect(toolUseNames(d.frames)).toEqual([`mcp__${BROWSER_SERVER}__spawn`]);
  });

  test("a plain name that collides with a built-in, or that is not a plain tool name, refuses the session at startup -- nothing is shadowed", async () => {
    const clash = await drive({ mcpServers: plainServer({ toolNames: { browser: "Bash" } }) }, []);
    expect(String(clash.error ?? JSON.stringify(messages(clash.frames)))).toContain("Bash");
    expect(getRegisteredTool("Bash")?.descriptor.source).toBe("builtin");
    const bad = await drive({ mcpServers: plainServer({ toolNames: { browser: "mcp__x__y" } }) }, []);
    expect(String(bad.error ?? JSON.stringify(messages(bad.frames)))).toContain("plain tool name");
  });

  test("deferred like any MCP tool while Tool Search is active -- `alwaysLoad` keeps one eager -- and loadable through ToolSearch under the plain name", async () => {
    const d = await drive({ mcpServers: plainServer(), toolSearchEnabled: true }, [
      { kind: "tool_use", calls: [{ id: "c1", name: "ToolSearch", input: { query: "select:Browser" } }] },
      { kind: "tool_use", calls: [{ id: "c2", name: "Browser", input: {} }] },
      { kind: "text", text: "ok" },
    ]);
    expect(names(d.requests[0])).toContain("ToolSearch");
    expect(names(d.requests[0])).toContain("SpawnSession");
    expect(names(d.requests[0])).not.toContain("Browser");
    expect(initTools(d.frames)).not.toContain("Browser");
    expect(names(d.requests[1])).toContain("Browser");
    expect(d.sdkCalls).toEqual([{ server: BROWSER_SERVER, tool: "browser", arguments: {} }]);
  });

  test("the model is TOLD the deferred names: a persisted deferred_tools_delta attachment (claude's), once, in the history", async () => {
    const d = await drive({ mcpServers: plainServer(), toolSearchEnabled: true, deferTools: ["CronList"] }, [
      { kind: "tool_use", calls: [{ id: "c1", name: "ToolSearch", input: { query: "select:Browser" } }] },
      { kind: "text", text: "ok" },
    ]);
    const text = (req: ProviderRequest | undefined): string => JSON.stringify(req?.messages ?? []);
    const announcement = "The following deferred tools are now available via ToolSearch:\\nBrowser\\nCronList";
    expect(text(d.requests[0])).toContain(announcement);
    // The standing server's twins of offered natives are not listed (the model has those tools already).
    expect(text(d.requests[0])).not.toContain("mcp__winter__send_message");
    // It stays in the history (the next request re-sends it at the same place) and is NOT repeated.
    expect(text(d.requests[1]).split("now available via ToolSearch").length - 1).toBe(1);
    // ToolSearch's own description says where to look.
    expect(d.requests[0]!.tools!.find((t) => t.name === "ToolSearch")?.description).toContain("Deferred tools appear by name in <system-reminder> messages");
    // …and nothing is announced while deferral is off.
    const off = await drive({ mcpServers: plainServer() }, []);
    expect(JSON.stringify(off.requests[0]!.messages)).not.toContain("deferred tools");
  });
});

describe("`tools` (claude's own option): the built-in set", () => {
  test("only the named built-ins are offered; MCP tools are untouched; an unoffered built-in is refused as no such tool", async () => {
    const d = await drive({ mcpServers: plainServer(), tools: ["Read", "Glob"] }, [{ kind: "tool_use", calls: [{ id: "c1", name: "Bash", input: { command: "echo hi" } }] }, { kind: "text", text: "ok" }]);
    const offered = names(d.requests[0]);
    expect(offered).toEqual(expect.arrayContaining(["Read", "Glob", "Browser", "SpawnSession"]));
    expect(offered).not.toContain("Bash");
    expect(offered).not.toContain("Write");
    // `ToolSearch` is not in the list, so nothing defers: the MCP tools are eager.
    expect(offered).not.toContain("ToolSearch");
    expect(String(toolResult(d.frames, "c1")?.["content"])).toContain("No such tool available: Bash");
  });

  test("leaving `ToolSearch` out switches deferral off even with Tool Search enabled (claude's rule)", async () => {
    const d = await drive({ mcpServers: plainServer(), tools: ["Read"], toolSearchEnabled: true }, []);
    expect(names(d.requests[0])).toEqual(expect.arrayContaining(["Read", "Browser", "SpawnSession"]));
    expect(names(d.requests[0])).not.toContain("ToolSearch");
  });

  test("with `ToolSearch` in the list the MCP tool defers and the standing server's twin of an unlisted built-in is not searchable", async () => {
    const d = await drive({ mcpServers: plainServer(), tools: ["Read", "ToolSearch"], toolSearchEnabled: true }, [
      { kind: "tool_use", calls: [{ id: "c1", name: "ToolSearch", input: { query: "select:Browser,mcp__winter__send_message,mcp__winter__list_agents" } }] },
      { kind: "text", text: "ok" },
    ]);
    expect(names(d.requests[0]).sort()).toEqual(["Read", "SpawnSession", "ToolSearch"]);
    expect(names(d.requests[1])).toContain("Browser");
    expect(names(d.requests[1]).some((n) => n.startsWith("mcp__winter__"))).toBe(false);
  });

  test("the opt-in `Search` is offered only when named, and only with a key named for it", async () => {
    const keyed = { web: { search: { authRef: { kind: "keychain" as const, account: "exa-api-key", service: "t" } } } };
    const resolver: Partial<EngineOptions> = { resolveToolSecret: async () => ({ status: "found" as const, key: "k" }) };
    expect(names((await drive({ ...keyed }, [], resolver)).requests[0])).not.toContain("Search");
    expect(names((await drive({ ...keyed, tools: ["Read", "Search"] }, [], resolver)).requests[0])).toEqual(expect.arrayContaining(["Read", "Search"]));
    expect(names((await drive({ tools: ["Read", "Search"] }, [], resolver)).requests[0])).not.toContain("Search");
    expect(names((await drive({ ...keyed, tools: ["Read", "Search"] }, [])).requests[0])).not.toContain("Search");
  });

  test("`Search` runs through the engine on the session's key and reports its citations' icons to the HOST only", async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    replaceExecutor(
      "Search",
      createSearchExecutor({
        fetchFn: (async (url: string, init: RequestInit) => {
          seen.push({ url: String(url), key: (init.headers as Record<string, string>)["x-api-key"] ?? null });
          return new Response(JSON.stringify({ answer: "Bun 2 shipped.", citations: [{ title: "Bun", url: "https://bun.example.com/blog", favicon: "https://bun.example.com/favicon.png" }] }), { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );
    try {
      const d = await drive(
        { tools: ["Search"], web: { search: { authRef: { kind: "keychain", account: "exa-api-key", service: "t" } } } },
        [{ kind: "tool_use", calls: [{ id: "s1", name: "Search", input: { query: "what is new in bun 2" } }] }, { kind: "text", text: "ok" }],
        { resolveToolSecret: async () => ({ status: "found", key: "exa-key-xyz" }) },
      );
      expect(seen).toEqual([{ url: EXA_ANSWER_URL, key: "exa-key-xyz" }]);
      const block = toolResult(d.frames, "s1");
      expect(block?.["content"]).toBe("Bun 2 shipped.\n\nSources:\n1. Bun\n   https://bun.example.com/blog");
      expect(block?.["winter_site_icons"]).toEqual([{ url: "https://bun.example.com/blog", icon_url: "https://bun.example.com/favicon.png" }]);
      expect(JSON.stringify(d.requests[1]?.messages)).not.toContain("favicon.png");
    } finally {
      replaceExecutor("Search", createSearchExecutor());
    }
  });
});

describe("`winter-test/calls`: a host's end-to-end double, scripted from the prompt", () => {
  test("makes the CALL lines in order, one per round, then reports every result", async () => {
    const requests: ProviderRequest[] = [];
    const frames: WinterFrame[] = [];
    const { host, runtime } = createInMemoryChannel();
    const provider = testProviderByName("calls");
    const done = runEngine({
      config: { sessionId: `tool-surface-calls-${++seq}`, cwd: "/tmp/x", model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, mcpServers: plainServer(), toolSearchEnabled: true },
      input: runtime.input,
      output: runtime.output,
      provider: { async generate(req) { requests.push(req); return provider.generate(req); } },
    } as EngineOptions);
    host.output.write({ type: "user", text: 'please\nCALL ToolSearch {"query":"select:Browser"}\nCALL Browser {"url":"https://a.example/"}' });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    for await (const f of host.input) {
      frames.push(f);
      if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "sdk_mcp_call") {
        host.output.write({ type: "control_response", requestId: (f as ControlRequestFrame).requestId, ok: true, payload: { content: [{ type: "text", text: "browsed" }] } });
      }
    }
    await done;
    expect(requests).toHaveLength(3);
    const answer = messages(frames).filter((m) => m["type"] === "assistant").at(-1) as { message: { content: Array<{ type: string; text?: string }> } };
    const reported = JSON.parse(answer.message.content.find((b) => b.type === "text")!.text!) as Array<{ name: string; isError: boolean; content: string }>;
    expect(reported.map((r) => r.name)).toEqual(["ToolSearch", "Browser"]);
    expect(reported[1]).toEqual({ name: "Browser", isError: false, content: "browsed" });
  });
});

describe("`deferTools`: deferring a built-in", () => {
  test("a named built-in starts deferred (no MCP server needed), loads through ToolSearch, and runs", async () => {
    const d = await drive({ toolSearchEnabled: true, deferTools: ["CronList", "ToolSearch"] }, [
      { kind: "tool_use", calls: [{ id: "c1", name: "CronList", input: {} }] },
      { kind: "tool_use", calls: [{ id: "c2", name: "ToolSearch", input: { query: "select:CronList" } }] },
      { kind: "tool_use", calls: [{ id: "c3", name: "CronList", input: {} }] },
      { kind: "text", text: "ok" },
    ]);
    expect(names(d.requests[0])).toContain("ToolSearch");
    expect(names(d.requests[0])).toContain("CronCreate");
    expect(names(d.requests[0])).not.toContain("CronList");
    expect(initTools(d.frames)).not.toContain("CronList");
    // Called before it is loaded: the load-first answer, never a run.
    expect(toolResult(d.frames, "c1")?.["loadFirst"]).toBe(true);
    expect(names(d.requests[2])).toContain("CronList");
    expect(toolResult(d.frames, "c3")?.["loadFirst"]).toBeUndefined();
  });

  test("a provider that cannot search gets full injection -- and the `tools` filter still holds", async () => {
    const d = await drive({ toolSearchEnabled: true, deferTools: ["CronList"], tools: ["Read", "CronList", "ToolSearch"] }, [], { providerSupportsToolSearch: false });
    expect(names(d.requests[0]).sort()).toEqual(["CronList", "Read"]);
  });
});

describe("old names keep working: a renamed tool's MCP spelling, a host's `legacyToolNames`", () => {
  afterEach(() => resetChildEngineFactoryForTest());

  test("ToolSearch `select:` under the OLD spelling loads the plain-named tool", async () => {
    const d = await drive({ mcpServers: plainServer(), toolSearchEnabled: true }, [
      { kind: "tool_use", calls: [{ id: "c1", name: "ToolSearch", input: { query: `select:mcp__${BROWSER_SERVER}__browser` } }] },
      { kind: "text", text: "ok" },
    ]);
    expect(names(d.requests[0])).not.toContain("Browser");
    expect(names(d.requests[1])).toContain("Browser");
  });

  test("an agent definition written against the OLD spelling hands its child the plain-named tool", async () => {
    const childTools: string[][] = [];
    registerChildEngineFactory(
      createChildEngineFactory({
        provider: {
          async generate(req) {
            childTools.push((req.tools ?? []).map((t) => t.name));
            return { kind: "text", text: "child done" };
          },
        },
      }),
    );
    const d = await drive({ mcpServers: plainServer(), agents: { prober: { description: "probes", prompt: "probe", tools: ["Read", `mcp__${BROWSER_SERVER}__browser`] } } }, [
      { kind: "tool_use", calls: [{ id: "a1", name: "Agent", input: { subagent_type: "prober", description: "d", prompt: "p", run_in_background: false } }] },
      { kind: "text", text: "ok" },
    ]);
    expect(d.error).toBeUndefined();
    expect(childTools[0]).toEqual(expect.arrayContaining(["Read", "Browser"]));
    expect(childTools[0]).not.toContain("SpawnSession");
  });

  const LEGACY = "mcp__winter__research__Search";
  const keyed = { tools: ["Read", "Search"], web: { search: { authRef: { kind: "keychain" as const, account: "exa-api-key", service: "t" } } }, legacyToolNames: { [LEGACY]: "Search" } };
  const withFakeExa = async <T,>(fn: (seen: string[]) => Promise<T>): Promise<T> => {
    const seen: string[] = [];
    replaceExecutor(
      "Search",
      createSearchExecutor({
        fetchFn: (async (_url: string, init: RequestInit) => {
          seen.push(String(init.body));
          return new Response(JSON.stringify({ answer: "an answer", citations: [] }), { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );
    try {
      return await fn(seen);
    } finally {
      replaceExecutor("Search", createSearchExecutor());
    }
  };
  const resolver: Partial<EngineOptions> = { resolveToolSecret: async () => ({ status: "found" as const, key: "k" }) };

  test("a resumed history's call under a host's legacy name runs the tool it names now", async () => {
    await withFakeExa(async (seen) => {
      const d = await drive(keyed, [{ kind: "tool_use", calls: [{ id: "s1", name: LEGACY, input: { query: "q" } }] }, { kind: "text", text: "ok" }], resolver);
      expect(seen).toEqual([JSON.stringify({ query: "q" })]);
      expect(String(toolResult(d.frames, "s1")?.["content"])).toContain("an answer");
      expect(toolUseNames(d.frames)).toEqual([LEGACY]);
    });
  });

  test("a rule written against the legacy name still governs: `disallowedTools` hides the tool, a deny rule denies it", async () => {
    await withFakeExa(async (seen) => {
      const hidden = await drive({ ...keyed, disallowedTools: [LEGACY] }, [{ kind: "tool_use", calls: [{ id: "s1", name: "Search", input: { query: "q" } }] }, { kind: "text", text: "ok" }], resolver);
      expect(names(hidden.requests[0])).not.toContain("Search");
      const denied = await drive({ ...keyed, permissions: { deny: [LEGACY] } }, [{ kind: "tool_use", calls: [{ id: "s1", name: "Search", input: { query: "q" } }] }, { kind: "text", text: "ok" }], resolver);
      expect(messages(denied.frames).some((m) => m["type"] === "system" && m["subtype"] === "permission_denied")).toBe(true);
      expect(seen).toEqual([]);
    });
  });

  test("ToolSearch `select:` under a legacy name finds the tool", async () => {
    const d = await drive(
      { ...keyed, tools: ["Read", "Search", "ToolSearch"], toolSearchEnabled: true, deferTools: ["Search"] },
      [{ kind: "tool_use", calls: [{ id: "c1", name: "ToolSearch", input: { query: `select:${LEGACY}` } }] }, { kind: "text", text: "ok" }],
      resolver,
    );
    expect(names(d.requests[0])).not.toContain("Search");
    expect(names(d.requests[1])).toContain("Search");
  });
});

describe("`reservedMcpServerNames` through the engine", () => {
  test("a plugin's server under a reserved name never connects; the host's own in-process server under one does", async () => {
    const d = await drive(
      { mcpServers: plainServer(), reservedMcpServerNames: [BROWSER_SERVER, "host__research"] },
      [{ kind: "tool_use", calls: [{ id: "c1", name: "Browser", input: {} }] }, { kind: "text", text: "ok" }],
      { extraMcpServerSources: [{ origin: "plugin", servers: { host__research: { type: "http", url: "https://evil.example/mcp" } } }] },
    );
    const init = messages(d.frames).find((m) => m["type"] === "system" && m["subtype"] === "init") as { mcp_servers?: Array<{ name: string }> } | undefined;
    expect(init?.mcp_servers).toBeDefined();
    expect((init?.mcp_servers ?? []).map((s) => s.name)).not.toContain("host__research");
    expect(d.sdkCalls).toEqual([{ server: BROWSER_SERVER, tool: "browser", arguments: {} }]);
  });
});
