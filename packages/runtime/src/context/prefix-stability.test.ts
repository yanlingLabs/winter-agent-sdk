// WS-23 item 10: the headline property. Three turns on an Opus-5.5-shaped row with an effort switch
// before turn 3, each request serialised by the REAL Anthropic adapter: `tools`, `system`, the
// top-level effort, the thinking config and the beta set are byte-identical on every request, and
// each request's messages (with the moving `cache_control` removed) are a byte-identical PREFIX of the
// next one's. That is what "the cached prefix survives the whole session" means on the wire.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions, type ModelDescription, type ProviderRequest } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { buildRequestBody, perMessageEffortBetaFor } from "../../../provider-runtime/src/adapters/anthropic/messages.ts";
import { describeCatalogModel } from "../production-wiring.ts";
import { createSystemPromptAssembler } from "./assembler.ts";

/** The REAL catalog row, so the evidence under test is the evidence that ships. */
const OPUS_55: WinterModelDescriptor = loadCatalog().models.find((m) => m.key === "anthropic/claude-opus-5-5")!;

function stripCacheControl(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, v) => (key === "cache_control" ? undefined : v));
}

describe("the cached prefix across turns 1 -> 3 with an effort switch (WS-23 item 10)", () => {
  test("tools, system, top-level effort, thinking and betas never move; every request's messages prefix the next", async () => {
    const description: ModelDescription = describeCatalogModel(loadCatalog(), "anthropic/claude-opus-5-5", "anthropic")!;
    expect(description.wire?.perMessageEffort).toBe(true);
    const home = mkdtempSync(join(tmpdir(), "winter-ws23-prefix-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-ws23-prefix-cwd-"));
    const requests: ProviderRequest[] = [];
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: { sessionId: "ws23-prefix", cwd, model: "anthropic/claude-opus-5-5", effort: "high" },
      // The REAL assembler, so the request carries Winter's own system blocks and the index-0 context.
      systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
      input: runtime.input,
      output: runtime.output,
      provider: {
        async generate(req) {
          const { signal: _signal, sink: _sink, ...plain } = req;
          requests.push(structuredClone(plain));
          return { kind: "text", text: `reply ${requests.length}` };
        },
      },
      tools: stubExecutor,
      providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-opus-5-5", family: "anthropic" },
      describeModel: () => description,
    } as EngineOptions);
    const frames: WinterFrame[] = [];
    const reader = (async () => {
      for await (const f of host.input) frames.push(f);
    })();
    const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
    const send = async (text: string, n: number): Promise<void> => {
      host.output.write({ type: "user", text });
      for (let i = 0; i < 2000 && results() < n; i++) await new Promise((r) => setTimeout(r, 2));
    };
    await send("turn one", 1);
    await send("turn two", 2);
    host.output.write({ type: "control_request", requestId: "e", subtype: "set_effort", payload: { effort: "low" } });
    for (let i = 0; i < 500 && !frames.some((f) => f.type === "control_response"); i++) await new Promise((r) => setTimeout(r, 2));
    await send("turn three", 3);
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await done;
    await reader;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });

    // Serialised exactly as the adapter would put them on the wire (the bridge copies these fields
    // across verbatim; the model id is the row's own upstream id).
    const bodies = requests.map((r) =>
      buildRequestBody(
        {
          model: OPUS_55.upstreamId,
          messages: r.messages,
          ...(r.system !== undefined ? { system: r.system } : {}),
          ...(r.systemBlocks !== undefined ? { systemBlocks: r.systemBlocks } : {}),
          ...(r.tools !== undefined ? { tools: r.tools } : {}),
          ...(r.effort !== undefined ? { effort: r.effort } : {}),
        },
        OPUS_55,
        {},
      ),
    );
    expect(bodies).toHaveLength(3);
    // Real content on every axis: Winter's tools, its cache-marked system blocks, and message breakpoints.
    expect((bodies[0]!["tools"] as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(bodies[0]!["system"])).toContain('"cache_control"');
    expect(JSON.stringify(bodies[2]!["messages"])).toContain('"cache_control"');
    for (const body of bodies.slice(1)) {
      expect(JSON.stringify(body["tools"])).toBe(JSON.stringify(bodies[0]!["tools"]));
      expect(JSON.stringify(body["system"])).toBe(JSON.stringify(bodies[0]!["system"]));
      expect(body["output_config"]).toEqual(bodies[0]!["output_config"]);
      expect(body["thinking"]).toEqual(bodies[0]!["thinking"]);
    }
    expect(bodies[0]!["output_config"]).toEqual({ effort: "high" });
    // The switch rode a marker, placed before turn three's user message, and the beta rides with it.
    const last = bodies[2]!["messages"] as Array<{ role: string; content: unknown; output_config?: unknown }>;
    expect(last.filter((m) => m.role === "system")).toEqual([{ role: "system", content: [], output_config: { effort: "low" } }]);
    expect(perMessageEffortBetaFor(bodies[2]!, OPUS_55)).toBe("mid-conversation-output-config-2026-07-01");
    expect(perMessageEffortBetaFor(bodies[1]!, OPUS_55)).toBeUndefined();
    // Append-only, byte for byte (only the rolling breakpoint moves).
    for (let i = 0; i + 1 < bodies.length; i++) {
      const now = stripCacheControl(bodies[i]!["messages"]) as unknown[];
      const next = stripCacheControl(bodies[i + 1]!["messages"]) as unknown[];
      expect(JSON.stringify(next.slice(0, now.length))).toBe(JSON.stringify(now));
    }
  });
});
