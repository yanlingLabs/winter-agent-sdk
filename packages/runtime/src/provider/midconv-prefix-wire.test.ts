// WS-23 (midconv) item 5: the headline property ON THE WIRE, per vendor. The real engine drives the real
// catalog-resolved provider (bridge, history renderer, adapter) against a loopback endpoint, and every
// assertion reads the request bodies the endpoint received:
//   - Anthropic (claude-opus-5-5): a late MCP tool, then its removal, then an effort change;
//   - OpenAI (gpt-6-astra): an effort change, then a ToolSearch load.
// For each: every earlier request is a byte prefix of the next (Anthropic's one rolling `cache_control`
// set aside), and `tools` -- the head of the cached prefix -- never changes inside the epoch.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions } from "../engine.ts";
import { buildSessionProvider } from "./session-provider.ts";
import { describeCatalogModel } from "../production-wiring.ts";
import { createSystemPromptAssembler } from "../context/assembler.ts";
import { registerMcpServerTools, replaceExecutor, unregisterMcpServerTools } from "../tools/registry.ts";
import { createFakeMcpServerStateSource } from "../mcp/state.ts";
import { fakeAnthropicCatalog, startAnthropicFake } from "./anthropic-fake.test-support.ts";
import { fakeResponsesCatalog, startResponsesFake, type ResponsesFakeAnswer } from "./responses-fake.test-support.ts";
import "../tools/impl/index.ts";

type Step = { user: string } | { act: () => void } | { control: string; payload: unknown };
type Block = Record<string, unknown>;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function drive(opts: { config: RuntimeConfig; catalog: WinterCatalog; family: string; servers: string[]; steps: Step[] }): Promise<WinterFrame[]> {
  const home = mkdtempSync(join(tmpdir(), "winter-midconv-wire-home-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const config = { ...opts.config, winterHome: home } as RuntimeConfig;
  const wiring = buildSessionProvider({ config, env: {}, catalog: opts.catalog, credentials: createMemoryCredentialStore() });
  const identity = wiring.identity!;
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config,
    input: runtime.input,
    output: runtime.output,
    provider: wiring.provider,
    providerIdentity: { providerId: identity.providerId, modelKey: identity.modelKey, family: opts.family },
    describeModel: (model: string, providerId?: string) => describeCatalogModel(opts.catalog, model, providerId),
    systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
    mcpServerStateSource: createFakeMcpServerStateSource(opts.servers.map((name) => ({ name, state: "connected" as const, toolNames: [] }))),
    providerSupportsToolSearch: true,
    deferrableContextShare: 100,
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
  let users = 0;
  let controls = 0;
  for (const step of opts.steps) {
    if ("act" in step) step.act();
    else if ("control" in step) {
      const requestId = `c${++controls}`;
      host.output.write({ type: "control_request", requestId, subtype: step.control, payload: step.payload });
      for (let n = 0; n < 2000 && !frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === requestId); n++) await new Promise((r) => setTimeout(r, 2));
    } else {
      host.output.write({ type: "user", text: step.user });
      users++;
      for (let n = 0; n < 3000 && results() < users; n++) await new Promise((r) => setTimeout(r, 2));
    }
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return frames;
}

/** JSON with `cache_control` removed from non-system messages -- Anthropic's rolling breakpoint moves by design; a system message never carries one (asserted separately). */
const strip = (value: unknown): string =>
  JSON.stringify((value as Block[]).map((m) => (m["role"] === "system" ? m : JSON.parse(JSON.stringify(m), (key, v) => (key === "cache_control" ? undefined : v)))));
const isErrorResult = (frames: WinterFrame[]): boolean[] => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").map((f) => (f as { message: { is_error: boolean } }).message.is_error);

describe("the cached prefix on the wire through mid-session changes (WS-23 midconv item 5)", () => {
  test("Anthropic (claude-opus-5-5): a late MCP tool, then its removal, then an effort change -- `tools`, system, output_config and betas never move; each request prefixes the next", async () => {
    const SERVER = "wsmidlate";
    const model = "anthropic/claude-opus-5-5";
    const fake = await startAnthropicFake(() => ({ blocks: [{ type: "text", text: "ok" }], stopReason: "end_turn" }));
    cleanups.push(() => fake.close());
    cleanups.push(() => unregisterMcpServerTools(SERVER));
    const cwd = mkdtempSync(join(tmpdir(), "winter-midconv-wire-cwd-"));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    const frames = await drive({
      config: {
        sessionId: "midconv-wire-anthropic",
        cwd,
        model,
        effort: "high",
        persistSession: false,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        toolSearchEnabled: true,
        capabilities: ["winter.mcp"],
        provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } },
      } as RuntimeConfig,
      catalog: fakeAnthropicCatalog(fake.url, [model]),
      family: "anthropic",
      servers: [SERVER],
      steps: [
        { user: "one" },
        {
          act: () => {
            registerMcpServerTools(SERVER, [{ name: "lookup", description: "Look something up.", inputSchema: { type: "object", properties: { q: { type: "string" } } } }], { deferredDefault: false });
            replaceExecutor(`mcp__${SERVER}__lookup`, { async execute() { return { output: "found" }; } });
          },
        },
        { user: "two" },
        { act: () => unregisterMcpServerTools(SERVER) },
        { user: "three" },
        { control: "set_effort", payload: { effort: "low" } },
        { user: "four" },
      ],
    });
    expect(isErrorResult(frames)).toEqual([false, false, false, false]);
    const reqs = fake.requests.filter((r) => r.path === "/v1/messages");
    expect(reqs).toHaveLength(4);
    const [first] = reqs;
    for (const r of reqs) {
      expect(JSON.stringify(r.body["tools"])).toBe(JSON.stringify(first!.body["tools"]));
      expect(JSON.stringify(r.body["system"])).toBe(JSON.stringify(first!.body["system"]));
      expect(r.body["output_config"]).toEqual({ effort: "high" });
      expect(r.headers["anthropic-beta"]).toBe(first!.headers["anthropic-beta"]);
    }
    expect(first!.headers["anthropic-beta"]!.split(",")).toContain("inline-tools-2026-09-15");
    expect((first!.body["tools"] as Block[]).some((t) => String(t["name"]).includes(SERVER))).toBe(false);
    const wire = reqs.map((r) => r.body["messages"] as Block[]);
    // Review I-1: no system message EVER carries a breakpoint (one there moves off on the next request,
    // and the entry it wrote is never read) -- so the system messages are compared WITH their bytes.
    for (const messages of wire) for (const m of messages) if (m["role"] === "system") expect(JSON.stringify(m)).not.toContain("cache_control");
    // Only the rolling breakpoint on a user/assistant block moves, by design.
    for (let i = 0; i + 1 < wire.length; i++) expect(strip(wire[i + 1]!.slice(0, wire[i]!.length))).toBe(strip(wire[i]));
    // The three changes, each where it belongs -- compared byte for byte (no breakpoint to set aside).
    const systems = wire[3]!.filter((m) => m["role"] === "system").map((m) => JSON.stringify(m));
    expect(systems).toContain(JSON.stringify({ role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: `mcp__${SERVER}__lookup`, description: "Look something up.", input_schema: { type: "object", properties: { q: { type: "string" } } } } } }] }));
    expect(systems).toContain(JSON.stringify({ role: "system", content: [{ type: "tool_removal", tool: { type: "tool_reference", name: `mcp__${SERVER}__lookup` } }] }));
    expect(systems).toContain(JSON.stringify({ role: "system", content: [], output_config: { effort: "low" } }));
  });

  test("RULING (fix round 1), Anthropic: a late DEFERRED MCP tool is declared `defer_loading` at the END of `tools` and not announced -- no change message, messages still prefix", async () => {
    const SERVER = "wsmidlatedeferred";
    const model = "anthropic/claude-opus-5-5";
    const fake = await startAnthropicFake(() => ({ blocks: [{ type: "text", text: "ok" }], stopReason: "end_turn" }));
    cleanups.push(() => fake.close());
    cleanups.push(() => unregisterMcpServerTools(SERVER));
    const cwd = mkdtempSync(join(tmpdir(), "winter-midconv-wire-cwd-"));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    await drive({
      config: {
        sessionId: "midconv-wire-anthropic-deferred",
        cwd,
        model,
        effort: "high",
        persistSession: false,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        toolSearchEnabled: true,
        capabilities: ["winter.mcp"],
        provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } },
      } as RuntimeConfig,
      catalog: fakeAnthropicCatalog(fake.url, [model]),
      family: "anthropic",
      servers: [SERVER],
      steps: [
        { user: "one" },
        { act: () => registerMcpServerTools(SERVER, [{ name: "lookup", description: "Look something up.", inputSchema: { type: "object" } }], { deferredDefault: true }) },
        { user: "two" },
      ],
    });
    const reqs = fake.requests.filter((r) => r.path === "/v1/messages");
    expect(reqs).toHaveLength(2);
    const [before, after] = reqs.map((r) => r.body["tools"] as Block[]);
    expect(JSON.stringify(after!.slice(0, before!.length))).toBe(JSON.stringify(before));
    expect(after!.at(-1)).toMatchObject({ name: `mcp__${SERVER}__lookup`, defer_loading: true });
    expect(JSON.stringify(reqs[1]!.body["messages"])).not.toContain("tool_addition");
  });

  test("OpenAI (gpt-6-astra): an effort change, then a ToolSearch load -- `tools` byte-identical (the loaded tool arrives in tool_search_output), effort pinned, each input prefixes the next", async () => {
    const SERVER = "wsmidcrm";
    const DEFERRED = `mcp__${SERVER}__lookup`;
    registerMcpServerTools(SERVER, [{ name: "lookup", description: "Look up a customer.", inputSchema: { type: "object", properties: { q: { type: "string" } } } }], { deferredDefault: true });
    replaceExecutor(DEFERRED, { async execute() { return { output: "customer 7" }; } });
    cleanups.push(() => unregisterMcpServerTools(SERVER));
    const script: ResponsesFakeAnswer[] = [
      { items: [{ type: "text", text: "r1" }] },
      { items: [{ type: "tool_search_call", callId: "ts_1", arguments: { query: `select:${DEFERRED}` } }] },
      { items: [{ type: "function_call", callId: "fc_1", namespace: `mcp__${SERVER}`, name: "lookup", arguments: { q: "7" } }] },
      { items: [{ type: "text", text: "done" }] },
    ];
    const fake = await startResponsesFake((_r, i) => script[Math.min(i, script.length - 1)]!);
    cleanups.push(() => fake.close());
    const model = "openai/gpt-6-astra";
    const frames = await drive({
      config: {
        sessionId: "midconv-wire-openai",
        cwd: "/tmp/midconv-wire",
        model,
        effort: "high",
        persistSession: false,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        toolSearchEnabled: true,
        capabilities: ["winter.mcp"],
        provider: { providerId: "openai", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } },
      } as RuntimeConfig,
      catalog: fakeResponsesCatalog("openai", fake.url, [model]),
      family: "openai",
      servers: [SERVER],
      steps: [{ user: "one" }, { control: "set_effort", payload: { effort: "low" } }, { user: "load the lookup tool and use it" }],
    });
    expect(isErrorResult(frames)).toEqual([false, false]);
    const reqs = fake.requests.filter((r) => r.path.endsWith("/responses"));
    expect(reqs).toHaveLength(4);
    const tools = reqs[0]!.body["tools"] as Block[];
    expect(tools.some((t) => t["type"] === "tool_search" && t["execution"] === "client")).toBe(true);
    expect(tools.some((t) => t["name"] === DEFERRED || t["name"] === "lookup")).toBe(false);
    for (const r of reqs) {
      expect(JSON.stringify(r.body["tools"])).toBe(JSON.stringify(tools));
      expect(r.body["reasoning"]).toMatchObject({ effort: "high" });
      expect(r.body["prompt_cache_key"]).toBe("midconv-wire-openai");
    }
    const inputs = reqs.map((r) => r.body["input"] as Block[]);
    for (let i = 0; i + 1 < inputs.length; i++) expect(JSON.stringify(inputs[i + 1]!.slice(0, inputs[i]!.length))).toBe(JSON.stringify(inputs[i]));
    const last = inputs[3]!;
    const types = last.map((item) => String(item["type"]));
    // The effort change before the prompt, the search round trip, then the namespaced call.
    expect(types.filter((t) => t === "configuration_update")).toHaveLength(2);
    const search = last.find((item) => item["type"] === "tool_search_call")!;
    expect(search).toEqual({ type: "tool_search_call", call_id: "ts_1", execution: "client", status: "completed", arguments: { query: `select:${DEFERRED}` } });
    const output = last.find((item) => item["type"] === "tool_search_output")!;
    expect(output["tools"]).toEqual([
      { type: "namespace", name: `mcp__${SERVER}`, description: `Tools from the MCP server "${SERVER}".`, tools: [expect.objectContaining({ type: "function", name: "lookup", defer_loading: true })] },
    ]);
    expect(last.find((item) => item["type"] === "function_call")).toMatchObject({ call_id: "fc_1", name: "lookup", namespace: `mcp__${SERVER}` });
    expect(last.find((item) => item["type"] === "function_call_output")).toMatchObject({ call_id: "fc_1", output: "customer 7" });
  });

  test("review I-2 (gpt-6-astra): after a load, the tool's MCP server DISCONNECTS, then returns with a REWORDED tool -- the earlier tool_search_output and namespaced call replay byte-identically on each later request", async () => {
    const SERVER = "wsmidgone";
    const DEFERRED = `mcp__${SERVER}__lookup`;
    const register = (description: string): void => {
      registerMcpServerTools(SERVER, [{ name: "lookup", description, inputSchema: { type: "object", properties: { q: { type: "string" } } } }], { deferredDefault: true });
      replaceExecutor(DEFERRED, { async execute() { return { output: "customer 7" }; } });
    };
    register("Look up a customer.");
    cleanups.push(() => unregisterMcpServerTools(SERVER));
    const script: ResponsesFakeAnswer[] = [
      { items: [{ type: "tool_search_call", callId: "ts_1", arguments: { query: `select:${DEFERRED}` } }] },
      { items: [{ type: "function_call", callId: "fc_1", namespace: `mcp__${SERVER}`, name: "lookup", arguments: { q: "7" } }] },
      { items: [{ type: "text", text: "done" }] },
    ];
    const fake = await startResponsesFake((_r, i) => script[Math.min(i, script.length - 1)]!);
    cleanups.push(() => fake.close());
    const model = "openai/gpt-6-astra";
    await drive({
      config: {
        sessionId: "midconv-wire-openai-i2",
        cwd: "/tmp/midconv-wire",
        model,
        effort: "high",
        persistSession: false,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        toolSearchEnabled: true,
        capabilities: ["winter.mcp"],
        provider: { providerId: "openai", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } },
      } as RuntimeConfig,
      catalog: fakeResponsesCatalog("openai", fake.url, [model]),
      family: "openai",
      servers: [SERVER],
      steps: [
        { user: "load the lookup tool and use it" },
        { act: () => unregisterMcpServerTools(SERVER) },
        { user: "the server is gone" },
        { act: () => register("Look up a customer (reworded).") },
        { user: "the server is back" },
      ],
    });
    const reqs = fake.requests.filter((r) => r.path.endsWith("/responses"));
    expect(reqs).toHaveLength(5);
    const inputs = reqs.map((r) => r.body["input"] as Block[]);
    // Every request is a byte prefix of the next, through both registry changes.
    for (let i = 0; i + 1 < inputs.length; i++) expect(JSON.stringify(inputs[i + 1]!.slice(0, inputs[i]!.length))).toBe(JSON.stringify(inputs[i]));
    const output = inputs[4]!.find((item) => item["type"] === "tool_search_output")!;
    expect(JSON.stringify(output)).toContain('"description":"Look up a customer."');
    expect(inputs[4]!.find((item) => item["type"] === "function_call")).toMatchObject({ name: "lookup", namespace: `mcp__${SERVER}` });
  });
});
