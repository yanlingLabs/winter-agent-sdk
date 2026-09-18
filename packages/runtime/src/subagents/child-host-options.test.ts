// A SUBAGENT RUNS UNDER ITS HOST'S OPTIONS TOO. A child's `RuntimeConfig` is hand-built (it does not
// spread its parent's), so every host option has to be threaded onto it deliberately -- and one that
// is not simply reads as its DEFAULT inside the child, silently. Three are pinned here, each against
// the real default factory and a real parent run that spawns a real child:
//
//   - `autoMemory`: the child shares the production assembler and renders the memory section, so a
//     host that turned memory off (or moved it) got children that showed it at the computed path.
//   - `web`: a child that cannot see the root's registration must FAIL CLOSED onto the host's own
//     configuration -- not onto "search on, no block-list".
//   - cost: a child's generations were counted as tokens and never PRICED, so `total_cost_usd`
//     under-reported and `maxBudgetUsd` ignored everything a subagent spent.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtocolSdkMessage as SdkMessage, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { runEngine, type EngineOptions, type Provider, type ProviderRequest, type ProviderTurn } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { registerTool, unregisterToolForTest, type ToolExecutionContext } from "../tools/registry.ts";
import { resetChildEngineFactoryForTest, type SpawnChildRequest } from "./child-handle.ts";
import { registerDefaultChildEngineFactory } from "./register-default-factory.ts";
import { resetSpawnLimitsForTest } from "./limits.ts";
import { createSystemPromptAssembler } from "../context/assembler.ts";
import { AUTO_MEMORY_HEADING } from "../context/memory.ts";
import { resetWebSessionRuntimesForTest, webSessionRuntimeFor } from "../web/session-runtime.ts";

const SPAWN = "HostOptionsSpawnProbe";
const WEB_PROBE = "HostOptionsWebProbe";
const descriptor = (name: string) => ({ canonicalName: name, advertisedName: name, source: "builtin" as const, inputSchema: { type: "object" }, description: name, exposure: "eager" as const, permissionClass: "read" as const, availability: {}, capabilityRequirements: [], disposition: "implement-now" as const });

let home: string | undefined;
afterEach(() => {
  unregisterToolForTest(SPAWN);
  unregisterToolForTest(WEB_PROBE);
  resetChildEngineFactoryForTest();
  resetSpawnLimitsForTest();
  resetWebSessionRuntimesForTest();
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

const CHILD_MARK = "you are the host-options probe child";

interface Driven {
  requests: ProviderRequest[];
  childRequests: ProviderRequest[];
  result: Record<string, unknown>;
  webSeenByChild: unknown;
}

/**
 * ONE provider serves the parent and the child; a request is the CHILD's when its system prompt
 * carries the child definition's own prompt. The parent spawns the child (foreground) from a probe
 * tool; the child optionally calls `WEB_PROBE` first.
 */
async function drive(config: Partial<RuntimeConfig>, opts: { childCallsWebProbe?: boolean; dropRootRegistrationBeforeSpawn?: boolean; childModel?: string; engine?: Partial<EngineOptions>; factory?: Record<string, unknown> | ((provider: Provider) => Record<string, unknown>) } = {}): Promise<Driven> {
  home = mkdtempSync(join(tmpdir(), "winter-child-host-options-"));
  const requests: ProviderRequest[] = [];
  const childRequests: ProviderRequest[] = [];
  let parentTurns = 0;
  let childTurns = 0;
  const provider: Provider = {
    async generate(input): Promise<ProviderTurn> {
      requests.push(input);
      if ((input.system ?? "").includes(CHILD_MARK)) {
        childRequests.push(input);
        childTurns += 1;
        if (opts.childCallsWebProbe === true && childTurns === 1) return { kind: "tool_use", calls: [{ id: "w1", name: WEB_PROBE, input: {} }], usage: { inputTokens: 300, outputTokens: 3 } };
        return { kind: "text", text: "child done", usage: { inputTokens: 300, outputTokens: 3 } };
      }
      parentTurns += 1;
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "do the thing", runInBackground: false, name: "prober", definition: { description: "probe", prompt: CHILD_MARK, ...(opts.childModel !== undefined ? { model: opts.childModel } : {}) } };
      return parentTurns === 1 ? { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN, input: req }], usage: { inputTokens: 1000, outputTokens: 10 } } : { kind: "text", text: "parent done", usage: { inputTokens: 1000, outputTokens: 10 } };
    },
  };
  let webSeenByChild: unknown;
  registerTool({
    descriptor: descriptor(SPAWN),
    executor: {
      async execute(input: unknown, ctx: ToolExecutionContext) {
        if (!ctx.session.spawnChild) return { output: "no spawnChild capability configured", isError: true };
        if (opts.dropRootRegistrationBeforeSpawn === true) resetWebSessionRuntimesForTest();
        const handle = await ctx.session.spawnChild(input as SpawnChildRequest);
        const result = await handle.result();
        return { output: JSON.stringify({ status: result.status }) };
      },
    },
  });
  registerTool({
    descriptor: descriptor(WEB_PROBE),
    executor: {
      async execute(_input: unknown, ctx: ToolExecutionContext) {
        webSeenByChild = { agent: ctx.agentId !== undefined, web: webSessionRuntimeFor(ctx)?.web };
        return { output: "probed" };
      },
    },
  });
  const full = { sessionId: `child-host-options-${Math.random().toString(36).slice(2)}`, cwd: home, model: "prova/main", persistSession: false, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, ...config } as RuntimeConfig;
  const assembler = createSystemPromptAssembler({ home });
  registerDefaultChildEngineFactory({ provider, config: full, env: {}, systemPromptAssembler: assembler, ...(typeof opts.factory === "function" ? opts.factory(provider) : (opts.factory ?? {})) } as never);
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({ config: full, input: runtime.input, output: runtime.output, provider, systemPromptAssembler: assembler, ...(opts.engine ?? {}) });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  for await (const f of host.input) frames.push(f);
  await done;
  const result = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message).filter((m) => m.type === "result").at(-1) as unknown as Record<string, unknown>;
  return { requests, childRequests, result, webSeenByChild };
}

describe("Options.autoMemory reaches a subagent", () => {
  test("CONTROL: with no host option a child renders the memory section (so the two tests below are not vacuous)", async () => {
    const r = await drive({});
    expect(r.childRequests.length).toBeGreaterThan(0);
    expect(r.childRequests[0]!.system).toContain(AUTO_MEMORY_HEADING);
  });

  test("`autoMemory.enabled: false` turns the section off in the CHILD too", async () => {
    const r = await drive({ autoMemory: { enabled: false } });
    expect(r.requests.find((q) => !(q.system ?? "").includes(CHILD_MARK))!.system).not.toContain(AUTO_MEMORY_HEADING);
    expect(r.childRequests.length).toBeGreaterThan(0);
    expect(r.childRequests[0]!.system).not.toContain(AUTO_MEMORY_HEADING);
  });

  test("a relocated `autoMemory.directory` is the one the CHILD names, not the computed default", async () => {
    const r = await drive({ autoMemory: { directory: "/host/chosen/memory-dir" } });
    expect(r.childRequests[0]!.system).toContain("/host/chosen/memory-dir");
    expect(r.childRequests[0]!.system).not.toContain(join("projects"));
  });
});

describe("Options.web reaches a subagent, and a child with no root registration FAILS CLOSED", () => {
  const web = { search: { enabled: false }, fetch: { privateAddressPolicy: "deny" as const }, blockedDomains: ["blocked.example"] };

  test("a child sees the host's web configuration through its own registration", async () => {
    const r = await drive({ web }, { childCallsWebProbe: true });
    expect(r.webSeenByChild).toMatchObject({ agent: true, web: { search: { enabled: false }, fetch: { privateAddressPolicy: "deny" }, blockedDomains: ["blocked.example"] } });
  });

  test("...and STILL does when the root's registration is gone at spawn -- never the defaults (search on, no block-list, `ask`)", async () => {
    const r = await drive({ web }, { childCallsWebProbe: true, dropRootRegistrationBeforeSpawn: true });
    expect(r.webSeenByChild).toMatchObject({ agent: true, web: { search: { enabled: false }, fetch: { privateAddressPolicy: "deny" }, blockedDomains: ["blocked.example"] } });
  });
});

describe("a subagent's generations are PRICED, and roll up into the session's cost and budget", () => {
  // $1 per token, so a cost IS a token count.
  const priceUsage: NonNullable<EngineOptions["priceUsage"]> = (key, usage) => ({ costUsd: usage.inputTokens + usage.outputTokens, costBasis: "list", canonicalModel: key });

  test("`total_cost_usd` and `modelUsage` on the PARENT's result include the child's generation", async () => {
    const r = await drive({}, { engine: { priceUsage }, factory: { priceUsage } });
    // parent 2 x 1010, child 1 x 303.
    expect(r.result.total_cost_usd).toBe(2 * 1010 + 303);
    expect((r.result.modelUsage as Record<string, Record<string, number>>)["prova/main"]).toMatchObject({ inputTokens: 2300, outputTokens: 23 });
  });

  test("`maxBudgetUsd` SEES subagent spend: the parent request that follows an over-budget child never goes out", async () => {
    // parent round 1 (1010) + child (303) = 1313 > 1200, so the parent's second request is refused.
    const r = await drive({ maxBudgetUsd: 1200 }, { engine: { priceUsage }, factory: { priceUsage } });
    expect(r.result.subtype).toBe("error_max_budget_usd");
    expect(r.requests.filter((q) => !(q.system ?? "").includes(CHILD_MARK))).toHaveLength(1);
  });

  test("a child on a DIFFERENT PROVIDER than its parent is priced under ITS OWN qualified key -- never its slot name paired with the parent's provider", async () => {
    // The pricing seam as the production wiring implements it: a `/`-bearing key self-qualifies; a
    // BARE key can only be read against the session-START provider (`prova`), which has no `haiku`.
    const RATES: Record<string, number> = { "prova/main": 1, "provb/small": 10 };
    const asked: string[] = [];
    const catalogPricing: NonNullable<EngineOptions["priceUsage"]> = (key, usage) => {
      asked.push(key);
      const qualified = key.includes("/") ? key : `prova/${key}`;
      const rate = RATES[qualified];
      return rate === undefined ? undefined : { costUsd: rate * (usage.inputTokens + usage.outputTokens), costBasis: "list", canonicalModel: qualified };
    };
    const r = await drive(
      {},
      {
        childModel: "haiku",
        engine: { priceUsage: catalogPricing },
        // The agent definition says `haiku`; the resolver maps that slot onto ANOTHER provider.
        factory: (provider) => ({ priceUsage: catalogPricing, resolveChildProvider: (model: string) => (model === "haiku" ? { provider, identity: { providerId: "provb", modelKey: "provb/small", family: "fam-b" } } : undefined) }),
      },
    );
    expect(r.childRequests).toHaveLength(1);
    // Priced at the CHILD's provider's rate: parent 2 x 1010 x $1, child 303 x $10.
    expect(r.result.total_cost_usd).toBe(2 * 1010 + 303 * 10);
    const rows = r.result.modelUsage as Record<string, Record<string, unknown>>;
    // ONE row per model, keyed by the qualified tag -- not a `haiku` row beside it.
    expect(Object.keys(rows).sort()).toEqual(["prova/main", "provb/small"]);
    expect(rows["provb/small"]).toMatchObject({ inputTokens: 300, outputTokens: 3, costUSD: 3030, canonicalModel: "provb/small" });
    expect(rows["prova/main"]).toMatchObject({ inputTokens: 2000, outputTokens: 20 });
    // The slot name never reached the pricing seam at all.
    expect(asked).not.toContain("haiku");
  });
});

describe("`maxBudgetUsd` is the WHOLE TREE's ceiling: a descendant's own loop stops on it too", () => {
  const GRANDCHILD_MARK = "you are the host-options probe GRANDCHILD";
  const priceUsage: NonNullable<EngineOptions["priceUsage"]> = (key, usage) => ({ costUsd: usage.inputTokens + usage.outputTokens, costBasis: "list", canonicalModel: key });

  /**
   * root -> child -> grandchild. The grandchild would happily loop on a probe tool for six rounds
   * (101 each); the root and the child spend 1010 + 303 before it starts.
   */
  async function driveTree(maxBudgetUsd: number | undefined): Promise<{ grandchildRequests: number; childRequests: number; rootRequests: number; result: Record<string, unknown>; grandchildStatus: unknown }> {
    home = mkdtempSync(join(tmpdir(), "winter-child-budget-tree-"));
    const counts = { root: 0, child: 0, grandchild: 0 };
    const provider: Provider = {
      async generate(input): Promise<ProviderTurn> {
        const system = input.system ?? "";
        if (system.includes(GRANDCHILD_MARK)) {
          counts.grandchild += 1;
          const usage = { inputTokens: 100, outputTokens: 1 };
          return counts.grandchild <= 6 ? { kind: "tool_use", calls: [{ id: `g${counts.grandchild}`, name: WEB_PROBE, input: {} }], usage } : { kind: "text", text: "grandchild done", usage };
        }
        if (system.includes(CHILD_MARK)) {
          counts.child += 1;
          const usage = { inputTokens: 300, outputTokens: 3 };
          const req: SpawnChildRequest = { parentToolUseId: "call-2", prompt: "go deeper", runInBackground: false, name: "deeper", definition: { description: "deep probe", prompt: GRANDCHILD_MARK } };
          return counts.child === 1 ? { kind: "tool_use", calls: [{ id: "call-2", name: SPAWN, input: req }], usage } : { kind: "text", text: "child done", usage };
        }
        counts.root += 1;
        const usage = { inputTokens: 1000, outputTokens: 10 };
        const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "do the thing", runInBackground: false, name: "prober", definition: { description: "probe", prompt: CHILD_MARK } };
        return counts.root === 1 ? { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN, input: req }], usage } : { kind: "text", text: "root done", usage };
      },
    };
    let grandchildStatus: unknown;
    registerTool({
      descriptor: descriptor(SPAWN),
      executor: {
        async execute(input: unknown, ctx: ToolExecutionContext) {
          if (!ctx.session.spawnChild) return { output: "no spawnChild capability configured", isError: true };
          const handle = await ctx.session.spawnChild(input as SpawnChildRequest);
          const result = await handle.result();
          if ((input as SpawnChildRequest).parentToolUseId === "call-2") grandchildStatus = result.status;
          return { output: JSON.stringify({ status: result.status }) };
        },
      },
    });
    registerTool({ descriptor: descriptor(WEB_PROBE), executor: { execute: async () => ({ output: "probed" }) } });
    const full = { sessionId: `child-budget-tree-${Math.random().toString(36).slice(2)}`, cwd: home, model: "prova/main", persistSession: false, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}) } as RuntimeConfig;
    const assembler = createSystemPromptAssembler({ home });
    registerDefaultChildEngineFactory({ provider, config: full, env: {}, systemPromptAssembler: assembler, priceUsage } as never);
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: full, input: runtime.input, output: runtime.output, provider, systemPromptAssembler: assembler, priceUsage });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const frames: WinterFrame[] = [];
    for await (const f of host.input) frames.push(f);
    await done;
    const result = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message).filter((m) => m.type === "result").at(-1) as unknown as Record<string, unknown>;
    return { grandchildRequests: counts.grandchild, childRequests: counts.child, rootRequests: counts.root, result, grandchildStatus };
  }

  test("CONTROL: with no budget the grandchild runs its whole loop (so the case below is not vacuous)", async () => {
    const r = await driveTree(undefined);
    expect(r.grandchildRequests).toBe(7);
    expect(r.childRequests).toBe(2);
    expect(r.rootRequests).toBe(2);
  });

  test("a GRANDCHILD stops at its next request once the ROOT's budget is crossed -- and so does every level above it", async () => {
    // 1010 (root) + 303 (child) + 2 x 101 (grandchild) = 1515 > 1500: the grandchild's THIRD request
    // never goes out. Nothing in the child's or grandchild's own config carries a ceiling -- each
    // level's ledger is only its own subtree -- so the ROOT's answer is what stops them.
    const r = await driveTree(1500);
    expect(r.grandchildRequests).toBe(2);
    // The child's second request and the root's second request are refused for the same reason.
    expect(r.childRequests).toBe(1);
    expect(r.rootRequests).toBe(1);
    expect(r.result.subtype).toBe("error_max_budget_usd");
    expect(r.result.total_cost_usd).toBe(1010 + 303 + 2 * 101);
  });
});
