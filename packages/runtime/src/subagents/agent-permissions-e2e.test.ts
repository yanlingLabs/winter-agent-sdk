// SDK 0.0.16 Lane P (R3b §4/§5): end-to-end proof for the two pieces of this lane that a pure-
// function/consumer-level unit test cannot reach on its own -- `allowedAgentTypes` actually
// surviving the real spawn path (tools/impl/agent.ts -> child-engine.ts's own tool-restriction
// section -> the CHILD's own RuntimeConfig -> the child's OWN engine.ts/tools/impl/agent.ts
// resolving AGAINST that restriction), and the Explore model cap (engine.ts's `resolveChildModel`,
// gated on `currentProviderIdentity`/`resolveSlot`, both of which only exist once real WS-13c slot
// machinery is wired). Everything else this lane built (the deny-rule lookup, the listing filters,
// the executor's own refusal texts, whenToUseLean's rendering) is already proven at the pure-
// function/consumer level in evaluator.test.ts, availability.test.ts, definitions.test.ts,
// builtin-agents.test.ts and tools/impl/agent.test.ts -- this file does not re-prove those.
//
// Mirrors subagents/child-engine.test.ts's own established harness (a REAL runEngine for the
// parent, a REAL createChildEngineFactory, never a fake ChildHandle) -- see that file's own header
// for the rationale. Importing tools/impl/agent.ts (for its module-load `replaceExecutor` side
// effect) is what makes the REAL Agent tool executor reachable through the default tool executor
// this file's own `driveParent` uses (no `tools:` override on `runEngine`'s own `EngineOptions`).
import { describe, test, expect, afterEach } from "bun:test";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { runEngine, type Provider, type EngineProviderIdentity } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest, type SpawnChildRequest } from "./child-handle.ts";
import { createChildEngineFactory, type ChildEngineFactoryDeps } from "./child-engine.ts";
import { resetSpawnLimitsForTest } from "./limits.ts";
import { scriptedProvider, echoProvider } from "../provider/mock.ts";
import type { SlotProviderResolution } from "../provider/slots.ts";
// Module-load side effect: registers the REAL Agent tool executor (AGENT_TOOL_NAME) in place of
// the WS-06 stub -- this file's own `driveParent` never overrides `tools:`, so it reaches this.
import "../tools/impl/agent.ts";

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

afterEach(() => {
  resetChildEngineFactoryForTest();
  resetSpawnLimitsForTest();
});

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  sessionId: "parent-s",
  cwd: "/tmp/winter-lane-p-e2e-tests",
  model: "winter-test/echo",
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  ...overrides,
});

interface DriveOpts {
  providerIdentity?: EngineProviderIdentity;
  resolveSlot?: (requested: string, currentModelKey: string | undefined) => SlotProviderResolution;
  env?: Record<string, string | undefined>;
}

function driveParent(deps: ChildEngineFactoryDeps, config: RuntimeConfig, provider: Provider, opts: DriveOpts = {}): Promise<{ code: number; frames: WinterFrame[] }> {
  registerChildEngineFactory(createChildEngineFactory(deps));
  const { host, runtime } = createInMemoryChannel();
  const donePromise = runEngine({
    config,
    input: runtime.input,
    output: runtime.output,
    provider,
    ...(opts.providerIdentity !== undefined ? { providerIdentity: opts.providerIdentity } : {}),
    ...(opts.resolveSlot !== undefined ? { resolveSlot: opts.resolveSlot } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
  return drain(host.input).then(async (frames) => ({ code: await donePromise, frames }));
}

// --- allowedAgentTypes: the child pool, end to end -----------------------------------------------

describe("SDK 0.0.16 Lane P (R3b §4): allowedAgentTypes survives the real spawn path end to end", () => {
  test('a child spawned from tools: ["*", "Agent(Explore, Plan)"] refuses an out-of-scope subagent_type with the filtered not-found list, and accepts an in-scope one', async () => {
    // The PARENT spawns ONE programmatic agent ("scoped-spawner") whose own tools list restricts
    // which subagent_type values IT may itself spawn -- R3b §4's own worked example.
    const parentConfig = baseConfig({
      agents: { "scoped-spawner": { description: "spawns other agents, but only Explore/Plan", prompt: "spawn one", tools: ["*", "Agent(Explore, Plan)"] } },
    });
    const parentProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: "Agent", input: { subagent_type: "scoped-spawner", description: "d", prompt: "p", run_in_background: false } }] },
      { kind: "text", text: "parent done" },
    ]);

    // The CHILD's own provider: first asks for "general-purpose" (out of ITS allowedAgentTypes),
    // then -- once it sees the refusal -- asks for "Explore" (in scope), then reports both.
    let sawFirstRefusal: string | undefined;
    let sawSecondOutcome: string | undefined;
    const childProvider: Provider = {
      async generate({ messages }) {
        const blocksOf = (content: unknown): Array<Record<string, unknown>> => (Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []);
        const toolResultFor = (id: string): Record<string, unknown> | undefined => {
          for (const m of messages as unknown as Array<{ content?: unknown }>) {
            for (const b of blocksOf(m.content)) if (b["type"] === "tool_result" && b["tool_use_id"] === id) return b;
          }
          return undefined;
        };
        const textOf = (b: Record<string, unknown> | undefined): string => {
          if (b === undefined) return "";
          const c = b["content"];
          if (typeof c === "string") return c;
          if (Array.isArray(c)) return c.map((x) => (typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : "")).join("");
          return "";
        };
        const first = toolResultFor("child-call-1");
        if (first === undefined) {
          return { kind: "tool_use", calls: [{ id: "child-call-1", name: "Agent", input: { subagent_type: "general-purpose", description: "d", prompt: "p", run_in_background: false } }], usage: { inputTokens: 1, outputTokens: 1 } };
        }
        sawFirstRefusal = textOf(first);
        const second = toolResultFor("child-call-2");
        if (second === undefined) {
          return { kind: "tool_use", calls: [{ id: "child-call-2", name: "Agent", input: { subagent_type: "Explore", description: "d", prompt: "p", run_in_background: false } }], usage: { inputTokens: 1, outputTokens: 1 } };
        }
        sawSecondOutcome = textOf(second);
        return { kind: "text", text: "reported", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const { code } = await driveParent({ provider: childProvider }, parentConfig, parentProvider);
    expect(code).toBe(0);

    // "general-purpose" genuinely exists in this session (it's a default-on built-in), but is
    // excluded from the scoped-spawner's own allowedAgentTypes -- claude's own not-found shape,
    // listing ONLY the two names actually in scope.
    expect(sawFirstRefusal).toBe("Agent type 'general-purpose' not found. Available agents: Explore, Plan");
    // "Explore" IS in scope -- the spawn succeeds (a real nested grandchild ran and reported back).
    expect(sawSecondOutcome).toBeDefined();
    expect(sawSecondOutcome).not.toContain("not found");
    expect(sawSecondOutcome).not.toContain("Error");
  }, 20_000);

  test("a plain child (no Agent(a,b) entry in its own tools) keeps the FULL, unrestricted universe -- no regression", async () => {
    const parentConfig = baseConfig({ agents: { "plain-spawner": { description: "spawns anything", prompt: "spawn one", tools: ["*"] } } });
    const parentProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: "Agent", input: { subagent_type: "plain-spawner", description: "d", prompt: "p", run_in_background: false } }] },
      { kind: "text", text: "parent done" },
    ]);
    let sawOutcome: string | undefined;
    const childProvider: Provider = {
      async generate({ messages }) {
        const blocksOf = (content: unknown): Array<Record<string, unknown>> => (Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []);
        const toolResultFor = (id: string): Record<string, unknown> | undefined => {
          for (const m of messages as unknown as Array<{ content?: unknown }>) {
            for (const b of blocksOf(m.content)) if (b["type"] === "tool_result" && b["tool_use_id"] === id) return b;
          }
          return undefined;
        };
        const result = toolResultFor("child-call-1");
        if (result === undefined) {
          return { kind: "tool_use", calls: [{ id: "child-call-1", name: "Agent", input: { subagent_type: "general-purpose", description: "d", prompt: "p", run_in_background: false } }], usage: { inputTokens: 1, outputTokens: 1 } };
        }
        const c = result["content"];
        sawOutcome = typeof c === "string" ? c : JSON.stringify(c);
        return { kind: "text", text: "reported", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { code } = await driveParent({ provider: childProvider }, parentConfig, parentProvider);
    expect(code).toBe(0);
    expect(sawOutcome).not.toContain("not found");
  }, 20_000);
});

// --- The Explore model cap, end to end -------------------------------------------------------------

// A minimal, hand-built "family" -- resolves a tier NAME to a fixed fake key on the SAME
// providerId as `contextModelKey`'s own identity, so `claudeTierMatches` (engine.ts) can compare
// `resolution.modelKey === modelKey` without any real catalog. `unknown-slot` is never exercised
// by these tests (this lane's own cap logic only ever asks for "haiku"/"sonnet"/"opus").
function fakeAnthropicResolveSlot(tierKeys: Record<"haiku" | "sonnet" | "opus", string>): (requested: string, currentModelKey: string | undefined) => SlotProviderResolution {
  return (requested) => {
    const tier = requested as "haiku" | "sonnet" | "opus";
    const modelKey = tierKeys[tier];
    if (modelKey === undefined) return { ok: false, code: "unknown-slot", message: `no such tier ${requested}`, wouldServe: [] };
    return { ok: true, modelKey, providerId: "anthropic", canonicalModelId: `claude-${tier}-fake`, slot: { family: "claude", name: tier, source: "claude-pinned" }, viaSlotName: true };
  };
}

const FABLE_KEY = "anthropic/fable-fake";
const OPUS_KEY = "anthropic/opus-fake";
const SONNET_KEY = "anthropic/sonnet-fake";
const HAIKU_KEY = "anthropic/haiku-fake";
const TIER_KEYS = { haiku: HAIKU_KEY, sonnet: SONNET_KEY, opus: OPUS_KEY } as const;

// The REAL Agent tool's own foreground-result shape (tools/impl/agent.ts's `foregroundResultToPayload`)
// -- NOT the raw `{record, result}` shape a hand-built fixture tool (child-engine.test.ts's own
// SPAWN_PROBE) would return; going through the real executor is the whole point of this file.
function resolvedModelFrom(frames: WinterFrame[]): string {
  const msgs = dataMessages(frames);
  const toolResult = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } };
  const block = toolResult.message.content.find((b) => b.tool_use_id === "call-1")!;
  return (JSON.parse(block.content) as { resolvedModel: string }).resolvedModel;
}

describe("SDK 0.0.16 Lane P (R3b §5): the Explore model cap, end to end", () => {
  test("a first-party Anthropic session at Fable tier caps a spawned Explore down to Opus", async () => {
    const config = baseConfig({ model: FABLE_KEY });
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: "Agent", input: { subagent_type: "Explore", description: "d", prompt: "p", run_in_background: false } }] },
      { kind: "text", text: "parent done" },
    ]);
    const { code, frames } = await driveParent(
      { provider: echoProvider },
      config,
      provider,
      { providerIdentity: { providerId: "anthropic", modelKey: FABLE_KEY, family: "claude" }, resolveSlot: fakeAnthropicResolveSlot(TIER_KEYS) },
    );
    expect(code).toBe(0);
    expect(resolvedModelFrom(frames)).toBe(OPUS_KEY);
  });

  test("a session already at Opus (or below) is left alone -- Explore inherits it unchanged", async () => {
    const config = baseConfig({ model: SONNET_KEY });
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: "Agent", input: { subagent_type: "Explore", description: "d", prompt: "p", run_in_background: false } }] },
      { kind: "text", text: "parent done" },
    ]);
    const { frames } = await driveParent(
      { provider: echoProvider },
      config,
      provider,
      { providerIdentity: { providerId: "anthropic", modelKey: SONNET_KEY, family: "claude" }, resolveSlot: fakeAnthropicResolveSlot(TIER_KEYS) },
    );
    expect(resolvedModelFrom(frames)).toBe(SONNET_KEY);
  });

  test("WINTER_DISABLE_EXPLORE_INHERIT_CAP opts out even at Fable tier on a first-party session", async () => {
    const config = baseConfig({ model: FABLE_KEY });
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: "Agent", input: { subagent_type: "Explore", description: "d", prompt: "p", run_in_background: false } }] },
      { kind: "text", text: "parent done" },
    ]);
    const { frames } = await driveParent(
      { provider: echoProvider },
      config,
      provider,
      { providerIdentity: { providerId: "anthropic", modelKey: FABLE_KEY, family: "claude" }, resolveSlot: fakeAnthropicResolveSlot(TIER_KEYS), env: { WINTER_DISABLE_EXPLORE_INHERIT_CAP: "1" } },
    );
    expect(resolvedModelFrom(frames)).toBe(FABLE_KEY);
  });

  test("never caps on a non-Anthropic provider, even at an unresolvable tier", async () => {
    const config = baseConfig({ model: FABLE_KEY });
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: "Agent", input: { subagent_type: "Explore", description: "d", prompt: "p", run_in_background: false } }] },
      { kind: "text", text: "parent done" },
    ]);
    const { frames } = await driveParent(
      { provider: echoProvider },
      config,
      provider,
      { providerIdentity: { providerId: "openai", modelKey: FABLE_KEY, family: "other" }, resolveSlot: fakeAnthropicResolveSlot(TIER_KEYS) },
    );
    expect(resolvedModelFrom(frames)).toBe(FABLE_KEY);
  });

  test("never caps a same-named user override of Explore (not the built-in)", async () => {
    const config = baseConfig({ model: FABLE_KEY, agents: { Explore: { description: "a user's own Explore", prompt: "custom" } } });
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: "Agent", input: { subagent_type: "Explore", description: "d", prompt: "p", run_in_background: false } }] },
      { kind: "text", text: "parent done" },
    ]);
    const { frames } = await driveParent(
      { provider: echoProvider },
      config,
      provider,
      { providerIdentity: { providerId: "anthropic", modelKey: FABLE_KEY, family: "claude" }, resolveSlot: fakeAnthropicResolveSlot(TIER_KEYS) },
    );
    expect(resolvedModelFrom(frames)).toBe(FABLE_KEY);
  });

  test("never caps a non-Explore built-in (general-purpose) even at Fable tier", async () => {
    const config = baseConfig({ model: FABLE_KEY });
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: "Agent", input: { subagent_type: "general-purpose", description: "d", prompt: "p", run_in_background: false } }] },
      { kind: "text", text: "parent done" },
    ]);
    const { frames } = await driveParent(
      { provider: echoProvider },
      config,
      provider,
      { providerIdentity: { providerId: "anthropic", modelKey: FABLE_KEY, family: "claude" }, resolveSlot: fakeAnthropicResolveSlot(TIER_KEYS) },
    );
    expect(resolvedModelFrom(frames)).toBe(FABLE_KEY);
  });
});

// --- The lean/normal Agent-listing choice, end to end -----------------------------------------------
//
// Mirrors context/request-layout.engine.test.ts's own `run()` harness (the REAL assembler is what
// actually produces the "Available agent types for the Agent tool:" attachment -- `driveParent`
// above wires none, by design, since the allowedAgentTypes/Explore-cap tests don't need it).

const AGENTS_HEADER = "Available agent types for the Agent tool:";

function requestTexts(req: { messages: unknown[] }): string[] {
  const out: string[] = [];
  for (const m of req.messages as Array<{ content?: unknown }>) {
    const c = m.content;
    if (typeof c === "string") out.push(c);
    else if (Array.isArray(c)) for (const b of c as Array<{ type?: string; text?: string }>) if (b.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out;
}

describe("SDK 0.0.16 Lane P (R3b §5): lean vs normal Agent-listing text, end to end", () => {
  async function firstRequestTextFor(providerIdentity: EngineProviderIdentity): Promise<string> {
    const { createSystemPromptAssembler } = await import("../context/assembler.ts");
    const { stubExecutor } = await import("../provider/mock.ts");
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "winter-lane-p-listing-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "winter-lane-p-listing-cwd-"));
    try {
      const { host, runtime } = createInMemoryChannel();
      let captured: string[] = [];
      const done = runEngine({
        config: baseConfig({ sessionId: "listing-s", cwd, model: providerIdentity.modelKey }),
        input: runtime.input,
        output: runtime.output,
        provider: {
          async generate(req) {
            if (captured.length === 0) captured = requestTexts(req);
            return { kind: "text", text: "ok" };
          },
        },
        tools: stubExecutor,
        systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
        providerIdentity,
        resolveSlot: fakeAnthropicResolveSlot(TIER_KEYS),
      });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
      await drain(host.input);
      await done;
      return captured.join("\n");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  test("a first-party Anthropic session at haiku/sonnet tier renders Explore's LEAN whenToUse", async () => {
    const text = await firstRequestTextFor({ providerId: "anthropic", modelKey: SONNET_KEY, family: "claude" });
    expect(text).toContain(AGENTS_HEADER);
    expect(text).toContain("- Explore:");
    expect(text).toContain("broad fan-out searches");
    expect(text).not.toContain("Fast read-only search agent for locating code.");
  });

  test("an opus-tier session renders the NORMAL whenToUse", async () => {
    const text = await firstRequestTextFor({ providerId: "anthropic", modelKey: OPUS_KEY, family: "claude" });
    expect(text).toContain(AGENTS_HEADER);
    expect(text).toContain("- Explore:");
    expect(text).toContain("Fast read-only search agent for locating code.");
    expect(text).not.toContain("broad fan-out searches");
  });
});
