// The Explore model cap: which model a spawned built-in `Explore` subagent runs on when nothing
// above it in the child-model chain named one. Driven through the real spawn path (a real parent
// `runEngine`, the real child-engine factory, the real Agent tool executor), observing the
// `resolvedModel` the Agent tool reports back to the parent model.
import { describe, test, expect, afterEach } from "bun:test";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { runEngine, type EngineProviderIdentity } from "./engine.ts";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest } from "./subagents/child-handle.ts";
import { createChildEngineFactory } from "./subagents/child-engine.ts";
import { resetSpawnLimitsForTest } from "./subagents/limits.ts";
import { scriptedProvider, echoProvider } from "./provider/mock.ts";
import type { SlotProviderResolution } from "./provider/slots.ts";
// Registers the real Agent tool executor.
import "./tools/impl/agent.ts";

afterEach(() => {
  resetChildEngineFactoryForTest();
  resetSpawnLimitsForTest();
});

const FABLE = "anthropic/fable-x";
const OPUS = "anthropic/opus-x";
const SONNET = "anthropic/sonnet-x";
const HAIKU = "anthropic/haiku-x";
type Tier = "haiku" | "sonnet" | "opus";
const TIERS: Record<Tier, string> = { haiku: HAIKU, sonnet: SONNET, opus: OPUS };

type ResolveSlot = (requested: string, currentModelKey: string | undefined) => SlotProviderResolution;

/** A tier-name resolver over a fixed table; a name missing from the table is `unknown-slot`. */
function tierResolver(table: Partial<Record<string, string>>, calls?: Array<[string, string | undefined]>): ResolveSlot {
  return (requested, current) => {
    calls?.push([requested, current]);
    const modelKey = table[requested];
    if (modelKey === undefined) return { ok: false, code: "unknown-slot", message: `no such slot ${requested}`, wouldServe: [] };
    return { ok: true, modelKey, providerId: "anthropic", canonicalModelId: `claude-${requested}`, slot: { family: "claude", name: requested, source: "claude-pinned" }, viaSlotName: true };
  };
}

interface Spawn {
  subagentType: string;
  model?: string;
}

interface Run {
  model: string;
  identity?: EngineProviderIdentity;
  resolveSlot?: ResolveSlot;
  env?: Record<string, string | undefined>;
  agents?: RuntimeConfig["agents"];
  spawns: Spawn[];
  /** Called between spawns (after spawn i's result reached the parent, before spawn i+1 is made). */
  between?: (i: number) => void;
}

/** Runs one parent turn that makes each spawn in its own tool round; returns each spawn's `resolvedModel` (or its error text). */
async function resolvedModels(run: Run): Promise<string[]> {
  registerChildEngineFactory(createChildEngineFactory({ provider: echoProvider }));
  const { host, runtime } = createInMemoryChannel();
  let round = 0;
  const provider = {
    async generate() {
      const i = round++;
      if (i > 0) run.between?.(i - 1);
      if (i < run.spawns.length) {
        const s = run.spawns[i]!;
        return { kind: "tool_use" as const, calls: [{ id: `call-${i}`, name: "Agent", input: { subagent_type: s.subagentType, description: "d", prompt: "p", run_in_background: false, ...(s.model !== undefined ? { model: s.model } : {}) } }], usage: { inputTokens: 1, outputTokens: 1 } };
      }
      return { kind: "text" as const, text: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const done = runEngine({
    config: {
      sessionId: "explore-cap-edge",
      cwd: "/tmp/winter-explore-cap-edge",
      model: run.model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(run.agents !== undefined ? { agents: run.agents } : {}),
    },
    input: runtime.input,
    output: runtime.output,
    provider,
    ...(run.identity !== undefined ? { providerIdentity: run.identity } : {}),
    ...(run.resolveSlot !== undefined ? { resolveSlot: run.resolveSlot } : {}),
    env: run.env ?? {},
  });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  for await (const f of host.input) frames.push(f);
  await done;
  const messages = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
  return run.spawns.map((_, i) => {
    for (const m of messages) {
      if (m.type !== "user") continue;
      const blocks = (m as unknown as { message: { content: unknown } }).message.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks as Array<{ tool_use_id?: string; content?: unknown }>) {
        if (b.tool_use_id !== `call-${i}`) continue;
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        try {
          return (JSON.parse(text) as { resolvedModel: string }).resolvedModel;
        } catch {
          return `ERROR: ${text}`;
        }
      }
    }
    return "MISSING";
  });
}

const anthropicAt = (modelKey: string, providerId = "anthropic"): EngineProviderIdentity => ({ providerId, modelKey, family: "claude" });
const explore: Spawn = { subagentType: "Explore" };

describe("Explore model cap: who is capped", () => {
  test("a first-party `anthropic` session above the three named tiers runs Explore on the `opus` slot", async () => {
    expect(await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE), resolveSlot: tierResolver(TIERS), spawns: [explore] })).toEqual([OPUS]);
  });

  test("a first-party `console` session is capped the same way", async () => {
    expect(await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE, "console"), resolveSlot: tierResolver(TIERS), spawns: [explore] })).toEqual([OPUS]);
  });

  for (const tier of ["haiku", "sonnet", "opus"] as const) {
    test(`a session already on the ${tier} tier is not capped: Explore inherits it`, async () => {
      const key = TIERS[tier];
      expect(await resolvedModels({ model: key, identity: anthropicAt(key), resolveSlot: tierResolver(TIERS), spawns: [explore] })).toEqual([key]);
    });
  }

  for (const providerId of ["openai", "cc", "bedrock", "deepseek-anthropic", "Anthropic", ""]) {
    test(`provider "${providerId}" is not first-party: never capped`, async () => {
      expect(await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE, providerId), resolveSlot: tierResolver(TIERS), spawns: [explore] })).toEqual([FABLE]);
    });
  }

  test("a session with no provider identity at all is never capped", async () => {
    expect(await resolvedModels({ model: FABLE, resolveSlot: tierResolver(TIERS), spawns: [explore] })).toEqual([FABLE]);
  });
});

describe("Explore model cap: how the tier is decided", () => {
  test("a model counts as a tier only when resolving that tier name yields exactly the model's own key", async () => {
    // The resolver maps every tier to some OTHER key: the session model is none of them.
    const other = tierResolver({ haiku: "anthropic/h2", sonnet: "anthropic/s2", opus: "anthropic/o2" });
    expect(await resolvedModels({ model: "anthropic/s1", identity: anthropicAt("anthropic/s1"), resolveSlot: other, spawns: [explore] })).toEqual(["anthropic/o2"]);
  });

  test("a tier the resolver refuses counts as not matching; one matching tier is enough to stay uncapped", async () => {
    expect(await resolvedModels({ model: SONNET, identity: anthropicAt(SONNET), resolveSlot: tierResolver({ sonnet: SONNET }), spawns: [explore] })).toEqual([SONNET]);
  });

  test("each tier is asked about with the session's own model as the context key", async () => {
    const calls: Array<[string, string | undefined]> = [];
    await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE), resolveSlot: tierResolver(TIERS, calls), spawns: [explore] });
    const tierQuestions = calls.filter(([requested]) => requested === "haiku" || requested === "sonnet").sort(([a], [b]) => a.localeCompare(b));
    expect(tierQuestions).toEqual([
      ["haiku", FABLE],
      ["sonnet", FABLE],
    ]);
    expect(calls.filter(([requested]) => requested === "opus").every(([, ctx]) => ctx === FABLE)).toBe(true);
  });

  test("with no slot resolver wired, a first-party session is always capped and the child gets the literal `opus`", async () => {
    expect(await resolvedModels({ model: SONNET, identity: anthropicAt(SONNET), spawns: [explore] })).toEqual(["opus"]);
  });

  test("the tier check reads the LIVE provider identity's model key, not the configured model string", async () => {
    // Configured as Sonnet, but the resolved identity says Fable: capped.
    expect(await resolvedModels({ model: SONNET, identity: anthropicAt(FABLE), resolveSlot: tierResolver(TIERS), spawns: [explore] })).toEqual([OPUS]);
    // Configured as Fable, but the resolved identity says Haiku: not capped -- the child inherits the configured model.
    expect(await resolvedModels({ model: FABLE, identity: anthropicAt(HAIKU), resolveSlot: tierResolver(TIERS), spawns: [explore] })).toEqual([FABLE]);
  });
});

describe("Explore model cap: the opt-out", () => {
  for (const value of ["1", "true"]) {
    test(`WINTER_DISABLE_EXPLORE_INHERIT_CAP=${value} disables the cap`, async () => {
      expect(await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE), resolveSlot: tierResolver(TIERS), env: { WINTER_DISABLE_EXPLORE_INHERIT_CAP: value }, spawns: [explore] })).toEqual([FABLE]);
    });
  }

  for (const value of ["0", "false", "TRUE", "yes", "", " 1", "on"]) {
    test(`WINTER_DISABLE_EXPLORE_INHERIT_CAP=${JSON.stringify(value)} is not an opt-out`, async () => {
      expect(await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE), resolveSlot: tierResolver(TIERS), env: { WINTER_DISABLE_EXPLORE_INHERIT_CAP: value }, spawns: [explore] })).toEqual([OPUS]);
    });
  }

  test("the opt-out is read at each spawn, not once per session", async () => {
    const env: Record<string, string | undefined> = {};
    const got = await resolvedModels({
      model: FABLE,
      identity: anthropicAt(FABLE),
      resolveSlot: tierResolver(TIERS),
      env,
      spawns: [explore, explore],
      between: () => {
        env["WINTER_DISABLE_EXPLORE_INHERIT_CAP"] = "1";
      },
    });
    expect(got).toEqual([OPUS, FABLE]);
  });
});

describe("Explore model cap: where it sits in the child-model chain", () => {
  test("only the built-in Explore is capped: Plan and general-purpose inherit", async () => {
    for (const subagentType of ["Plan", "general-purpose"]) {
      expect(await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE), resolveSlot: tierResolver(TIERS), spawns: [{ subagentType }] })).toEqual([FABLE]);
    }
  });

  test("a session-defined agent named Explore is not the built-in and is not capped", async () => {
    expect(await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE), resolveSlot: tierResolver(TIERS), agents: { Explore: { description: "mine", prompt: "p" } }, spawns: [explore] })).toEqual([FABLE]);
  });

  test("a per-call model on the Agent call wins over the cap", async () => {
    expect(await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE), resolveSlot: tierResolver(TIERS), spawns: [{ subagentType: "Explore", model: "haiku" }] })).toEqual([HAIKU]);
  });

  test("the session-wide subagent model variable wins over the cap", async () => {
    expect(await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE), resolveSlot: tierResolver(TIERS), env: { WINTER_SUBAGENT_MODEL: "sonnet" }, spawns: [explore] })).toEqual([SONNET]);
  });

  test("a subagent model variable of `inherit` or empty falls through to the cap", async () => {
    for (const value of ["inherit", ""]) {
      expect(await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE), resolveSlot: tierResolver(TIERS), env: { WINTER_SUBAGENT_MODEL: value }, spawns: [explore] })).toEqual([OPUS]);
    }
  });

  test("a per-call model of `inherit` falls through to the cap", async () => {
    expect(await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE), resolveSlot: tierResolver(TIERS), spawns: [{ subagentType: "Explore", model: "inherit" }] })).toEqual([OPUS]);
  });

  test("the cap's `opus` goes through the slot resolver on the session's own model key", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const got = await resolvedModels({ model: FABLE, identity: anthropicAt(FABLE), resolveSlot: tierResolver({ ...TIERS, opus: "anthropic/opus-other" }, calls), spawns: [explore] });
    expect(got).toEqual(["anthropic/opus-other"]);
    expect(calls.at(-1)).toEqual(["opus", FABLE]);
  });

  test("when the session's configured model IS the literal `opus`, the capped child inherits it unresolved", async () => {
    // Identity says Fable (so the cap fires); config.model is the bare slot name itself.
    expect(await resolvedModels({ model: "opus", identity: anthropicAt(FABLE), resolveSlot: tierResolver(TIERS), spawns: [explore] })).toEqual(["opus"]);
  });
});
