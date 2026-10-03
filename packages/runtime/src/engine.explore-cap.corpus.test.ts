// A recorded input -> output corpus for the Explore model cap: 800 generated parent sessions, each
// making one Agent spawn -- first-party and other providers, no identity, slot tables that match the
// session model on some tiers / none / are missing, no resolver at all, the opt-out variable at many
// spellings, the subagent model variable, per-call models, built-in vs session-defined Explore, Plan
// and general-purpose -- with the `resolvedModel` the Agent tool reported when the corpus was recorded.
import { expect, test } from "bun:test";
import type { WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { runEngine } from "./engine.ts";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest } from "./subagents/child-handle.ts";
import { createChildEngineFactory } from "./subagents/child-engine.ts";
import { resetSpawnLimitsForTest } from "./subagents/limits.ts";
import { echoProvider } from "./provider/mock.ts";
import type { SlotProviderResolution } from "./provider/slots.ts";
import "./tools/impl/agent.ts";
import corpus from "./__corpus__/explore-cap.json";

interface Row {
  providerId: string | null;
  identityModel: string;
  model: string;
  slots: Partial<Record<string, string>> | null;
  disableCap: string | null;
  subagentModelEnv: string | null;
  subagentType: string;
  callModel: string | null;
  userExplore: boolean;
  expected: string;
}

async function run(row: Row): Promise<string> {
  resetChildEngineFactoryForTest();
  resetSpawnLimitsForTest();
  registerChildEngineFactory(createChildEngineFactory({ provider: echoProvider }));
  const { host, runtime } = createInMemoryChannel();
  let round = 0;
  const provider = {
    async generate() {
      if (round++ === 0) {
        return { kind: "tool_use" as const, calls: [{ id: "call-0", name: "Agent", input: { subagent_type: row.subagentType, description: "d", prompt: "p", run_in_background: false, ...(row.callModel !== null ? { model: row.callModel } : {}) } }], usage: { inputTokens: 1, outputTokens: 1 } };
      }
      return { kind: "text" as const, text: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const slots = row.slots;
  const resolveSlot =
    slots === null
      ? undefined
      : (requested: string): SlotProviderResolution => {
          const modelKey = slots[requested];
          if (modelKey === undefined) return { ok: false, code: "unknown-slot", message: `no such slot ${requested}`, wouldServe: [] };
          return { ok: true, modelKey, providerId: "anthropic", canonicalModelId: `claude-${requested}`, slot: { family: "claude", name: requested, source: "claude-pinned" }, viaSlotName: true };
        };
  const env: Record<string, string> = {};
  if (row.disableCap !== null) env["WINTER_DISABLE_EXPLORE_INHERIT_CAP"] = row.disableCap;
  if (row.subagentModelEnv !== null) env["WINTER_SUBAGENT_MODEL"] = row.subagentModelEnv;
  const done = runEngine({
    config: {
      sessionId: "explore-cap-corpus",
      cwd: "/tmp/winter-explore-cap-corpus-nonexistent",
      model: row.model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(row.userExplore ? { agents: { Explore: { description: "a session-defined Explore", prompt: "p" } } } : {}),
    },
    input: runtime.input,
    output: runtime.output,
    provider,
    ...(row.providerId !== null ? { providerIdentity: { providerId: row.providerId, modelKey: row.identityModel, family: "claude" as const } } : {}),
    ...(resolveSlot !== undefined ? { resolveSlot } : {}),
    env,
  });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  for await (const f of host.input) frames.push(f);
  await done;
  for (const f of frames) {
    if (f.type !== "data") continue;
    const m = (f as { message: SdkMessage }).message;
    if (m.type !== "user") continue;
    const blocks = (m as unknown as { message: { content: unknown } }).message.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as Array<{ tool_use_id?: string; content?: unknown }>) {
      if (b.tool_use_id !== "call-0") continue;
      const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      try {
        return (JSON.parse(text) as { resolvedModel: string }).resolvedModel;
      } catch {
        return `ERROR: ${text}`;
      }
    }
  }
  return "MISSING";
}

test("the recorded Explore-cap corpus resolves exactly as recorded", async () => {
  const rows = corpus as Row[];
  expect(rows.length).toBe(800);
  const mismatches: Array<{ row: Row; got: string }> = [];
  for (const row of rows) {
    const got = await run(row);
    if (got !== row.expected) mismatches.push({ row, got });
  }
  expect(mismatches).toEqual([]);
}, 180_000);
