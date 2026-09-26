// WS-23 item 10 (extended in fix round 1, M5): the headline property, end to end ON THE WIRE. A real
// engine drives the REAL catalog-resolved Anthropic provider -- the bridge, the continuity history
// renderer and the adapter -- against a loopback Messages endpoint, on the real Opus 5.5 row, through:
//   - a tool round whose replies carry signed thinking blocks (replayed on every later request);
//   - a ToolSearch load of a deferred MCP tool (surfaced by `tool_reference`, `tools` untouched);
//   - a hook-style `<system-reminder>` appended after each tool round (it folds into an ordinary
//     tool_result, and follows a reference-carrying one as text -- the live gate's rule);
//   - an effort switch before the second turn.
// Across every request the `tools`, `system`, top-level `output_config`, `thinking` and the
// `anthropic-beta` header are byte-identical, and each request's messages (with the one moving
// `cache_control` set aside) are a byte-identical prefix of the next one's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions } from "../engine.ts";
import { buildSessionProvider } from "../provider/session-provider.ts";
import { describeCatalogModel } from "../production-wiring.ts";
import { createSystemPromptAssembler } from "./assembler.ts";
import { registerAttachmentRenderer } from "./attachments.ts";
import { registerMcpServerTools, replaceExecutor, unregisterMcpServerTools } from "../tools/registry.ts";
import { createFakeMcpServerStateSource } from "../mcp/state.ts";
import "../tools/impl/index.ts";

const SERVER = "ws23prefix";
const DEFERRED = `mcp__${SERVER}__lookup`;
const HOOK_TAIL = "ws23_hook_tail";

interface Captured {
  body: Record<string, unknown>;
  beta: string | null;
}

type Block = Record<string, unknown>;

/** One scripted Messages response, as SSE. */
function sse(index: number, blocks: Block[], stop: "end_turn" | "tool_use"): string {
  const events: Block[] = [{ type: "message_start", message: { id: `msg_${index}`, model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
  blocks.forEach((block, i) => {
    if (block["type"] === "thinking") {
      events.push({ type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } });
      events.push({ type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: block["thinking"] } });
      events.push({ type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: block["signature"] } });
    } else if (block["type"] === "tool_use") {
      events.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: block["id"], name: block["name"], input: {} } });
      events.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block["input"]) } });
    } else {
      events.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: block["text"] } });
    }
    events.push({ type: "content_block_stop", index: i });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } });
  events.push({ type: "message_stop" });
  return events.map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const SCRIPT: Array<[Block[], "end_turn" | "tool_use"]> = [
  [[{ type: "thinking", thinking: "search first", signature: "sig-1" }, { type: "tool_use", id: "toolu_search", name: "ToolSearch", input: { query: `select:${DEFERRED}` } }], "tool_use"],
  [[{ type: "thinking", thinking: "now call it", signature: "sig-2" }, { type: "tool_use", id: "toolu_lookup", name: DEFERRED, input: {} }], "tool_use"],
  [[{ type: "thinking", thinking: "answer", signature: "sig-3" }, { type: "text", text: "done one" }], "end_turn"],
  [[{ type: "text", text: "done two" }], "end_turn"],
];

let server: ReturnType<typeof Bun.serve>;
const captured: Captured[] = [];
let home: string;
let cwd: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      captured.push({ body, beta: request.headers.get("anthropic-beta") });
      const [blocks, stop] = SCRIPT[Math.min(captured.length - 1, SCRIPT.length - 1)]!;
      return new Response(sse(captured.length - 1, blocks, stop), { headers: { "content-type": "text/event-stream" } });
    },
  });
  home = mkdtempSync(join(tmpdir(), "winter-ws23-prefix-home-"));
  cwd = mkdtempSync(join(tmpdir(), "winter-ws23-prefix-cwd-"));
  registerMcpServerTools(SERVER, [{ name: "lookup", description: "Look something up.", inputSchema: { type: "object" } }], { deferredDefault: true });
  replaceExecutor(DEFERRED, { async execute() { return { output: "found it" }; } });
  // A hook-style tail: Winter-authored `<system-reminder>` text appended after every tool round, which
  // the request layout folds INTO the preceding tool_result (the shape a hook's additionalContext takes).
  registerAttachmentRenderer(HOOK_TAIL, () => "hook says: keep going");
});

afterAll(() => {
  server.stop(true);
  unregisterMcpServerTools(SERVER);
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const strip = (value: unknown): string => JSON.stringify(JSON.parse(JSON.stringify(value), (key, v) => (key === "cache_control" ? undefined : v)));

describe("the cached prefix on the wire, turns 1 -> 2 with a tool round, a ToolSearch load, a hook tail and an effort switch (WS-23 items 3, 5, 10)", () => {
  test("tools, system, output_config, thinking and the beta header never move; every request's messages prefix the next", async () => {
    const catalog = loadCatalog();
    const config: RuntimeConfig = {
      sessionId: "ws23-prefix-wire",
      cwd,
      model: "anthropic/claude-opus-5-5",
      effort: "high",
      winterHome: home,
      provider: { providerId: "anthropic", authRef: { kind: "inline", value: "test-key" }, connection: { baseUrl: `http://127.0.0.1:${server.port}`, local: true } },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      toolSearchEnabled: true,
      capabilities: ["winter.mcp"],
    };
    const wiring = buildSessionProvider({ config, env: {}, catalog });
    const identity = wiring.identity!;
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider: wiring.provider,
      providerIdentity: { providerId: identity.providerId, modelKey: identity.modelKey, family: String(wiring.resolved!.adapter.family), ...(identity.continuationDomain !== undefined ? { continuationDomain: identity.continuationDomain } : {}) },
      describeModel: (model: string, providerId?: string) => describeCatalogModel(catalog, model, providerId),
      systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
      mcpServerStateSource: createFakeMcpServerStateSource([{ name: SERVER, state: "connected", toolNames: [] }]),
      providerSupportsToolSearch: true,
      deferrableContextShare: 100,
      attachmentProducers: [async ({ phase }) => (phase === "tool-round" ? [{ type: HOOK_TAIL }] : [])],
    } as EngineOptions);
    const frames: WinterFrame[] = [];
    const reader = (async () => {
      for await (const f of host.input) frames.push(f);
    })();
    const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
    const send = async (text: string, n: number): Promise<void> => {
      host.output.write({ type: "user", text });
      for (let i = 0; i < 3000 && results() < n; i++) await new Promise((r) => setTimeout(r, 2));
    };
    await send("turn one", 1);
    host.output.write({ type: "control_request", requestId: "e", subtype: "set_effort", payload: { effort: "low" } });
    for (let i = 0; i < 500 && !frames.some((f) => f.type === "control_response"); i++) await new Promise((r) => setTimeout(r, 2));
    await send("turn two", 2);
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await done;
    await reader;

    expect(captured).toHaveLength(4);
    const [first] = captured;
    for (const { body, beta } of captured) {
      expect(JSON.stringify(body["tools"])).toBe(JSON.stringify(first!.body["tools"]));
      expect(JSON.stringify(body["system"])).toBe(JSON.stringify(first!.body["system"]));
      expect(body["output_config"]).toEqual({ effort: "high" });
      expect(body["thinking"]).toEqual(first!.body["thinking"]);
      // THE BETA SET IS CONSTANT (fix round 1, I1): per-message effort and block binding on every request.
      expect(beta).toBe(first!.beta);
    }
    // WS-23 midconv: the tool-change beta rides every request too (the row documents changes by reference).
    expect(first!.beta!.split(",").sort()).toEqual(["mid-conversation-output-config-2026-07-01", "mid-conversation-tool-changes-2026-07-01", "thinking-binding-controls-2026-08-01"]);
    // The deferred tool is declared up front, and stays declared the same way after it loads.
    expect((first!.body["tools"] as Block[]).find((t) => t["name"] === DEFERRED)).toMatchObject({ defer_loading: true });

    const wire = captured.map((c) => c.body["messages"] as Block[]);
    // Append-only, byte for byte (only the rolling breakpoint moves).
    for (let i = 0; i + 1 < wire.length; i++) expect(strip(wire[i + 1]!.slice(0, wire[i]!.length))).toBe(strip(wire[i]));
    const last = JSON.stringify(wire[3]);
    // Signed thinking replayed verbatim, the ToolSearch result carrying Anthropic's own tool_reference,
    // the hook tail inside a tool_result, and the switch riding a marker before `turn two`.
    expect(last).toContain('"signature":"sig-1"');
    expect(last).toContain('"signature":"sig-2"');
    expect(last).toContain(`{"type":"tool_reference","tool_name":"${DEFERRED}"}`);
    const toolResults = wire[3]!.flatMap((m) => (Array.isArray(m["content"]) ? (m["content"] as Block[]) : [])).filter((b) => b["type"] === "tool_result");
    expect(toolResults).toHaveLength(2);
    // Live gate (claude-opus-5-5): a result carrying `tool_reference` holds ONLY references -- mixing
    // them with other content is a 400 that bricks the session. So the ToolSearch result is
    // references-only and ITS hook tail follows it as text in the same user message; the ordinary
    // result keeps its tail folded inside, as before.
    for (const message of wire.flat()) {
      for (const block of Array.isArray(message["content"]) ? (message["content"] as Block[]) : []) {
        if (block["type"] !== "tool_result" || !Array.isArray(block["content"])) continue;
        const inner = block["content"] as Block[];
        if (inner.some((b) => b["type"] === "tool_reference")) expect(inner.every((b) => b["type"] === "tool_reference")).toBe(true);
      }
    }
    const referencing = toolResults.filter((b) => JSON.stringify(b["content"]).includes("tool_reference"));
    expect(referencing).toHaveLength(1);
    expect(toolResults.filter((b) => JSON.stringify(b["content"]).includes("hook says: keep going"))).toHaveLength(1);
    const searchTurn = wire[3]!.find((m) => Array.isArray(m["content"]) && (m["content"] as Block[]).includes(referencing[0]!))!;
    expect((searchTurn["content"] as Block[]).filter((b) => b["type"] === "text").some((b) => String(b["text"]).includes("hook says: keep going"))).toBe(true);
    const systems = wire[3]!.filter((m) => m["role"] === "system");
    expect(systems).toEqual([
      { role: "system", content: [], output_config: { effort: "high" } },
      { role: "system", content: [], output_config: { effort: "low" } },
    ]);
    expect(wire[3]!.indexOf(systems[1]!)).toBe(wire[3]!.length - 2);
  });
});
