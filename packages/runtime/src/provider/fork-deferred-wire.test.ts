// WS-24 fix round 1 (I2): a FORK loading a deferred tool itself, ON THE WIRE, on an Anthropic row with
// deferred tool loading (claude-opus-5-5). The fork sends its parent's exact layout, so its `tools`
// already declares every deferred tool with `defer_loading`; the fork's own ToolSearch load must reach
// the model as the documented mechanism -- a references-only `tool_result` (`tool_reference` blocks) --
// with no `<functions>` text, no change to `tools`, and the call then runs. Real engine, real catalog
// row, real adapter, loopback endpoint (the same drive as midconv-prefix-wire.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions } from "../engine.ts";
import { buildSessionProvider } from "./session-provider.ts";
import { describeCatalogModel } from "../production-wiring.ts";
import { createSystemPromptAssembler } from "../context/assembler.ts";
import { registerMcpServerTools, registerTool, replaceExecutor, unregisterMcpServerTools, unregisterToolForTest, type ToolExecutionContext } from "../tools/registry.ts";
import { createFakeMcpServerStateSource } from "../mcp/state.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest, type SpawnChildRequest } from "../subagents/child-handle.ts";
import { createChildEngineFactory } from "../subagents/child-engine.ts";
import { resetSpawnLimitsForTest } from "../subagents/limits.ts";
import { fakeAnthropicCatalog, startAnthropicFake } from "./anthropic-fake.test-support.ts";
import "../tools/impl/index.ts";

type Block = Record<string, unknown>;

const SPAWN = "ws24_fork_wire_spawn";
const SERVER = "wsforkwire";
const DEFERRED = `mcp__${SERVER}__lookup`;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  resetChildEngineFactoryForTest();
  resetSpawnLimitsForTest();
});

describe("WS-24 fix round 1 (I2): a fork's self-loaded deferred tool on an Anthropic deferred-loading row", () => {
  test("the load is a references-only tool_result with no <functions> text, `tools` never moves, and the call runs", async () => {
    const model = "anthropic/claude-opus-5-5";
    let ran = 0;
    registerMcpServerTools(SERVER, [{ name: "lookup", description: "Look something up.", inputSchema: { type: "object", properties: { q: { type: "string" } } } }], { deferredDefault: true });
    replaceExecutor(DEFERRED, {
      async execute() {
        ran++;
        return { output: "found it" };
      },
    });
    cleanups.push(() => unregisterMcpServerTools(SERVER));
    registerTool({
      descriptor: {
        canonicalName: SPAWN, advertisedName: SPAWN, source: "builtin", inputSchema: { type: "object" },
        description: "spawns a fork and awaits it", exposure: "eager", permissionClass: "read",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: {
        async execute(input: unknown, ctx: ToolExecutionContext) {
          const handle = await ctx.session.spawnChild!(input as SpawnChildRequest);
          await handle.result();
          return { output: "forked" };
        },
      },
    });
    cleanups.push(() => unregisterToolForTest(SPAWN));

    // Request order is sequential (a foreground fork): parent 1, fork 1-3, parent 2.
    const fake = await startAnthropicFake((_request, index) => {
      if (index === 0) return { blocks: [{ type: "tool_use", id: "toolu_spawn", name: SPAWN, input: { parentToolUseId: "toolu_spawn", prompt: "look it up", runInBackground: false, fork: true } }], stopReason: "tool_use" };
      if (index === 1) return { blocks: [{ type: "tool_use", id: "toolu_search", name: "ToolSearch", input: { query: `select:${DEFERRED}` } }], stopReason: "tool_use" };
      if (index === 2) return { blocks: [{ type: "tool_use", id: "toolu_lookup", name: DEFERRED, input: { q: "x" } }], stopReason: "tool_use" };
      return { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" };
    });
    cleanups.push(() => fake.close());
    const home = mkdtempSync(join(tmpdir(), "winter-ws24-fork-wire-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-ws24-fork-wire-cwd-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    const catalog = fakeAnthropicCatalog(fake.url, [model]);
    const config = {
      sessionId: "ws24-fork-wire",
      cwd,
      model,
      winterHome: home,
      persistSession: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      toolSearchEnabled: true,
      capabilities: ["winter.mcp"],
      provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } },
    } as RuntimeConfig;
    const wiring = buildSessionProvider({ config, env: {}, catalog, credentials: createMemoryCredentialStore() });
    const describeModel = (m: string, providerId?: string) => describeCatalogModel(catalog, m, providerId);
    registerChildEngineFactory(createChildEngineFactory({ provider: wiring.provider, describeModel, env: { ENABLE_TOOL_SEARCH: "true" } }));
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider: wiring.provider,
      providerIdentity: { providerId: wiring.identity!.providerId, modelKey: wiring.identity!.modelKey, family: "anthropic" },
      describeModel,
      systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
      mcpServerStateSource: createFakeMcpServerStateSource([{ name: SERVER, state: "connected" as const, toolNames: [] }]),
      providerSupportsToolSearch: true,
      deferrableContextShare: 100,
    } as EngineOptions);
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    const frames: WinterFrame[] = [];
    for await (const f of host.input) frames.push(f);
    expect(await done).toBe(0);

    const reqs = fake.requests.filter((r) => r.path === "/v1/messages");
    expect(reqs).toHaveLength(5);
    const [parent, forkSearch, forkLoaded, forkRan] = reqs;
    // The parent declares the deferred tool up front, and the fork's `tools` is the parent's, byte for byte.
    expect((parent!.body["tools"] as Block[]).find((t) => t["name"] === DEFERRED)).toMatchObject({ defer_loading: true });
    for (const r of [forkSearch, forkLoaded, forkRan]) expect(JSON.stringify(r!.body["tools"])).toBe(JSON.stringify(parent!.body["tools"]));
    // The ToolSearch result the fork sends back: references only, no definition text anywhere.
    const messages = forkLoaded!.body["messages"] as Block[];
    const results = messages.flatMap((m) => (Array.isArray(m["content"]) ? (m["content"] as Block[]) : [])).filter((b) => b["type"] === "tool_result" && b["tool_use_id"] === "toolu_search");
    expect(results).toHaveLength(1);
    expect(results[0]!["content"]).toEqual([{ type: "tool_reference", tool_name: DEFERRED }]);
    expect(JSON.stringify(messages)).not.toContain("<functions>");
    // ...and the call the fork then makes runs.
    expect(ran).toBe(1);
    expect(JSON.stringify(forkRan!.body["messages"])).toContain("found it");
    expect(JSON.stringify(forkRan!.body["messages"])).not.toContain("No such tool available");
  }, 30_000);
});
