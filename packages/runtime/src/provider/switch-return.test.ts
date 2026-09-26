// WS-23 (reasoning-state): Claude -> GPT -> Claude, END TO END. A session starts on Claude Opus 5.5, is
// resumed on GPT-6 Sol (a cross-provider switch is a new incarnation), then resumed on Claude again. The
// real engine, session-provider wiring and adapters run against two loopback endpoints, persisting through
// the real on-disk store. What must hold:
//   - the transcript is provider-neutral: no thinking, no signature, no effort field, no tool epoch;
//   - GPT never receives Claude's signed thinking (only the capped `<recovered_reasoning>` decoration), nor
//     a marker derived from Claude's effort levels, nor Claude's tool changes -- layer 2 is per model;
//   - back on Claude WITHIN the cache lifetime, its reasoning re-attaches, its tool epoch resumes (a tool
//     that appeared meanwhile rides a tool-change message, `tools` untouched) and its earlier request is a
//     byte prefix of the new one -- the cache holds;
//   - back on Claude PAST the cache lifetime, a fresh epoch starts instead (`tools` re-frozen).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { loadCatalog, type WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { RECOVERED_REASONING_TAG, createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions } from "../engine.ts";
import { resolveEngineSession } from "../store/dialect.ts";
import { buildSessionProvider, loadResumedChain } from "./session-provider.ts";
import { describeCatalogModel } from "../production-wiring.ts";
import { registerMcpServerTools, replaceExecutor, unregisterMcpServerTools } from "../tools/registry.ts";
import { createFakeMcpServerStateSource } from "../mcp/state.ts";
import { fakeAnthropicProvider, startAnthropicFake, type AnthropicFake } from "./anthropic-fake.test-support.ts";
import { fakeResponsesProvider, startResponsesFake, type ResponsesFake } from "./responses-fake.test-support.ts";
import "../tools/impl/index.ts";

const CLAUDE = "anthropic/claude-opus-5-5";
const GPT = "openai/gpt-6-sol";
const SERVER_A = "ws23retA";
const SERVER_B = "ws23retB";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Fx {
  claude: AnthropicFake;
  gpt: ResponsesFake;
  catalog: WinterCatalog;
  home: string;
  cwd: string;
}

async function fixture(): Promise<Fx> {
  const claude = await startAnthropicFake((request) => {
    const text = JSON.stringify(request.body["messages"]);
    if (text.includes("turn four")) return { blocks: [{ type: "text", text: "claude four" }], stopReason: "end_turn" };
    if (text.includes("turn two")) return { blocks: [{ type: "text", text: "claude two" }], stopReason: "end_turn" };
    return { blocks: [{ type: "thinking", thinking: "claude thinking one", signature: "SIG-CLAUDE-1" }, { type: "text", text: "claude one" }], stopReason: "end_turn" };
  });
  const gpt = await startResponsesFake(() => ({ items: [{ type: "reasoning", encrypted: "ENC-GPT", summary: ["gpt summary"] }, { type: "text", text: "gpt three" }] }));
  const home = mkdtempSync(join(tmpdir(), "winter-ws23-return-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-ws23-return-cwd-"));
  const compiled = loadCatalog();
  const catalog: WinterCatalog = {
    ...compiled,
    providers: [fakeAnthropicProvider(claude.url), fakeResponsesProvider("openai", gpt.url)],
    models: compiled.models.filter((m) => m.key === CLAUDE || m.key === GPT),
    families: [],
  };
  registerMcpServerTools(SERVER_A, [{ name: "alpha", description: "Alpha.", inputSchema: { type: "object" } }], { deferredDefault: false });
  replaceExecutor(`mcp__${SERVER_A}__alpha`, { async execute() { return { output: "a" }; } });
  cleanups.push(async () => {
    unregisterMcpServerTools(SERVER_A);
    unregisterMcpServerTools(SERVER_B);
    await claude.close();
    await gpt.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  return { claude, gpt, catalog, home, cwd };
}

type Step = { user: string } | { effort: string };

async function incarnation(fx: Fx, opts: { model: string; effort: string; resume?: boolean; steps: Step[]; servers: string[]; now?: () => Date }): Promise<WinterFrame[]> {
  const claude = opts.model === CLAUDE;
  const base = {
    sessionId: "ws23-return",
    cwd: fx.cwd,
    model: opts.model,
    effort: opts.effort,
    winterHome: fx.home,
    provider: { providerId: claude ? "anthropic" : "openai", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: claude ? fx.claude.url : fx.gpt.url, local: true } },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    toolSearchEnabled: true,
    capabilities: ["winter.mcp"],
    ...(opts.resume === true ? { resume: "ws23-return" } : {}),
  } as unknown as RuntimeConfig;
  const resolved = await resolveEngineSession({ config: base, resolveWinterHome: () => fx.home, env: {} });
  const chain = await loadResumedChain(resolved.store, resolved.initialMessages);
  const wiring = buildSessionProvider({ config: resolved.config, env: {}, catalog: fx.catalog, credentials: createMemoryCredentialStore(), chain: () => chain });
  const identity = wiring.identity!;
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: resolved.config,
    input: runtime.input,
    output: runtime.output,
    provider: wiring.provider,
    providerIdentity: { providerId: identity.providerId, modelKey: identity.modelKey, family: claude ? "anthropic" : "openai", ...(identity.continuationDomain !== undefined ? { continuationDomain: identity.continuationDomain } : {}) },
    ...(wiring.resolveModelSwitch !== undefined ? { resolveModelSwitch: wiring.resolveModelSwitch } : {}),
    describeModel: (model: string, providerId?: string) => describeCatalogModel(fx.catalog, model, providerId),
    mcpServerStateSource: createFakeMcpServerStateSource(opts.servers.map((name) => ({ name, state: "connected" as const, toolNames: [] }))),
    providerSupportsToolSearch: true,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(resolved.store !== undefined ? { store: resolved.store } : {}),
    ...(resolved.initialMessages.length > 0 ? { initialMessages: resolved.initialMessages } : {}),
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
  let users = 0;
  let controls = 0;
  for (const step of opts.steps) {
    if ("effort" in step) {
      const requestId = `e${++controls}`;
      host.output.write({ type: "control_request", requestId, subtype: "set_effort", payload: { effort: step.effort } });
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

const errors = (frames: WinterFrame[]): boolean[] => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").map((f) => (f as { message: { is_error: boolean } }).message.is_error);
const strip = (value: unknown): string => JSON.stringify(JSON.parse(JSON.stringify(value)), (key, v) => (key === "cache_control" ? undefined : v));

function sessionFile(fx: Fx, suffix: string): string {
  const projects = join(fx.home, "projects");
  for (const project of readdirSync(projects)) {
    try {
      return readFileSync(join(projects, project, `ws23-return${suffix}`), "utf8");
    } catch {
      /* not this project */
    }
  }
  return "";
}

/** Claude, then GPT, then Claude again (with SERVER_B's tool appearing before the return). */
async function claudeGptClaude(fx: Fx, returnClock?: () => Date): Promise<void> {
  expect(errors(await incarnation(fx, { model: CLAUDE, effort: "high", servers: [SERVER_A], steps: [{ user: "turn one" }, { effort: "low" }, { user: "turn two" }] }))).toEqual([false, false]);
  expect(errors(await incarnation(fx, { model: GPT, effort: "medium", resume: true, servers: [SERVER_A], steps: [{ user: "turn three" }] }))).toEqual([false]);
  registerMcpServerTools(SERVER_B, [{ name: "beta", description: "Beta.", inputSchema: { type: "object" } }], { deferredDefault: false });
  replaceExecutor(`mcp__${SERVER_B}__beta`, { async execute() { return { output: "b" }; } });
  expect(errors(await incarnation(fx, { model: CLAUDE, effort: "low", resume: true, servers: [SERVER_A, SERVER_B], steps: [{ user: "turn four" }], ...(returnClock !== undefined ? { now: returnClock } : {}) }))).toEqual([false]);
}

describe("Claude -> GPT -> Claude (WS-23 reasoning-state)", () => {
  test("within the cache lifetime: reasoning re-attaches, the epoch resumes, and Claude's earlier request prefixes the new one", async () => {
    const fx = await fixture();
    await claudeGptClaude(fx);

    // The transcript is provider-neutral.
    const transcript = sessionFile(fx, ".jsonl");
    for (const needle of ["SIG-CLAUDE-1", '"signature"', '"thinking"', '"effort"', '"perTurnEffort"', "tool_epoch", "tool_changes", "ENC-GPT"]) expect(transcript).not.toContain(needle);
    const kinds = sessionFile(fx, ".provider-state.jsonl").trim().split("\n").map((l) => JSON.parse(l) as { kind: string; model: string });
    expect(kinds.filter((r) => r.kind === "effort").every((r) => r.model === CLAUDE || r.model === GPT)).toBe(true);
    expect(new Set(kinds.filter((r) => r.kind === "tool-epoch").map((r) => r.model))).toEqual(new Set([CLAUDE, GPT]));
    expect(kinds.some((r) => r.kind === "reasoning-blocks" && r.model === CLAUDE)).toBe(true);

    // GPT: none of Claude's layer-1 or layer-2 state, only the readable decoration.
    expect(fx.gpt.requests).toHaveLength(1);
    const gpt = fx.gpt.requests[0]!;
    expect(gpt.raw).not.toContain("SIG-CLAUDE-1");
    expect(gpt.raw).toContain(RECOVERED_REASONING_TAG);
    expect(gpt.raw).toContain("claude thinking one");
    const updates = (gpt.body["input"] as Array<{ type?: string; reasoning?: { effort?: string } }>).filter((i) => i.type === "configuration_update");
    // Only GPT's own leading level -- nothing derived from Claude's high -> low change.
    expect(updates).toEqual([{ type: "configuration_update", reasoning: { effort: "medium" } }]);
    expect(gpt.raw).not.toContain("additional_tools");

    // Claude again.
    const claude = fx.claude.requests.filter((r) => r.path === "/v1/messages");
    expect(claude).toHaveLength(3);
    const [, before, after] = claude;
    const afterText = JSON.stringify(after!.body["messages"]);
    // Reasoning re-attached, in place.
    expect(afterText).toContain('"signature":"SIG-CLAUDE-1"');
    // GPT's own reasoning never reaches Claude natively.
    expect(afterText).not.toContain("ENC-GPT");
    // The epoch resumed: `tools` exactly as before, the new tool by value in a tool-change message.
    expect(JSON.stringify(after!.body["tools"])).toBe(JSON.stringify(before!.body["tools"]));
    expect(afterText).toContain('"tool_addition"');
    expect(afterText).toContain(`mcp__${SERVER_B}__beta`);
    // The cache holds: Claude's previous request is a byte prefix of this one, the rolling breakpoint aside.
    const prev = before!.body["messages"] as unknown[];
    expect(strip((after!.body["messages"] as unknown[]).slice(0, prev.length))).toBe(strip(prev));
    // Claude's effort markers are its own again: high (leading), low before turn two, none for GPT's turn.
    const markers = (after!.body["messages"] as Array<{ role: string; output_config?: { effort: string }; content: unknown[] }>).filter((m) => m.role === "system" && m.output_config !== undefined).map((m) => m.output_config!.effort);
    expect(markers).toEqual(["high", "low"]);
    expect(after!.body["output_config"]).toEqual({ effort: "high" });
  });

  test("past the cache lifetime: a fresh epoch -- `tools` re-frozen with the new tool, no tool-change message", async () => {
    const fx = await fixture();
    await claudeGptClaude(fx, () => new Date(Date.now() + 10 * 60_000));
    const claude = fx.claude.requests.filter((r) => r.path === "/v1/messages");
    const [, before, after] = claude;
    const names = (r: typeof after): string[] => (r!.body["tools"] as Array<{ name: string }>).map((t) => t.name);
    expect(names(before)).not.toContain(`mcp__${SERVER_B}__beta`);
    expect(names(after)).toContain(`mcp__${SERVER_B}__beta`);
    expect(JSON.stringify(after!.body["messages"])).not.toContain('"tool_addition"');
    // Reasoning still re-attaches -- that is layer 1, and not a cache question.
    expect(JSON.stringify(after!.body["messages"])).toContain('"signature":"SIG-CLAUDE-1"');
  });
});
