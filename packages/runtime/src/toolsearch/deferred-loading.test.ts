// WS-23 item 3: a stable tool list. On a model whose row documents deferred tool loading, every
// deferred tool is declared up front with `defer_loading` and a ToolSearch load surfaces one by
// reference (`tool_result.loadedTools`), so `tools` -- the first thing in the cached prefix -- never
// changes when a tool loads. Everywhere, the list is sorted by name. Ground truth is the LIVE provider
// request.
import { describe, expect, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type ContentBlock, type EngineOptions, type ModelDescription, type ProviderMessage, type ProviderRequest, type ProviderTurn } from "../engine.ts";
import { registerMcpServerTools, registerTool, replaceExecutor, unregisterMcpServerTools, unregisterToolForTest } from "../tools/registry.ts";
import { createFakeMcpServerStateSource } from "../mcp/state.ts";
import { evidencedToolNames } from "../compaction/retention.ts";

const DEFERRED_ROW: ModelDescription = { wire: { deferredToolLoading: true } };

interface Fixture {
  canonical: string;
  select: string;
  dispose(): void;
}

/** A deferred MCP tool plus a stand-in ToolSearch that loads it -- the same shape engine.test.ts's own tool_reference suite uses. */
function fixture(tag: string): Fixture {
  const server = `ws23-${tag}`;
  registerMcpServerTools(server, [{ name: "search_docs", inputSchema: { type: "object" } }], { deferredDefault: true });
  const canonical = `mcp__${server}__search_docs`;
  replaceExecutor(canonical, { async execute() { return { output: "real result" }; } });
  const select = `__ws23_select_${tag}__`;
  registerTool({
    descriptor: { canonicalName: select, advertisedName: select, source: "sdk", inputSchema: { type: "object" }, description: "test-only ToolSearch stand-in", exposure: "hidden", permissionClass: "read", availability: {}, capabilityRequirements: [], disposition: "implement-now" },
    executor: {
      async execute(_input, ctx) {
        ctx.emitToolReference?.([canonical]);
        return { output: '{"matches":["search_docs"]}' };
      },
    },
  });
  return {
    canonical,
    select,
    dispose() {
      unregisterMcpServerTools(server);
      unregisterToolForTest(select);
    },
  };
}

async function drive(opts: { f: Fixture; script: ProviderTurn[]; describe?: ModelDescription; initialMessages?: ProviderMessage[] }): Promise<{ requests: ProviderRequest[]; frames: WinterFrame[] }> {
  const requests: ProviderRequest[] = [];
  const { host, runtime } = createInMemoryChannel();
  const config: RuntimeConfig = { sessionId: `ws23-deferred-${Math.random().toString(36).slice(2)}`, cwd: "/tmp/x", model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, toolSearchEnabled: true, capabilities: ["winter.mcp"] };
  const server = opts.f.canonical.split("__")[1]!;
  const done = runEngine({
    config,
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages), ...(req.tools !== undefined ? { tools: structuredClone(req.tools) } : {}) });
        return opts.script[requests.length - 1] ?? { kind: "text", text: "done" };
      },
    },
    mcpServerStateSource: createFakeMcpServerStateSource([{ name: server, state: "connected", toolNames: [] }]),
    providerSupportsToolSearch: true,
    deferrableContextShare: 100,
    ...(opts.describe !== undefined ? { describeModel: () => opts.describe } : {}),
    ...(opts.initialMessages !== undefined ? { initialMessages: opts.initialMessages } : {}),
  } as EngineOptions);
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  for await (const frame of host.input) frames.push(frame);
  await done;
  return { requests, frames };
}

const names = (req: ProviderRequest): string[] => (req.tools ?? []).map((t) => t.name);
const isSorted = (list: string[]): boolean => list.every((n, i) => i === 0 || list[i - 1]! <= n);
const toolResults = (req: ProviderRequest): Array<Extract<ContentBlock, { type: "tool_result" }>> =>
  req.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")));

describe("deferred tool loading (WS-23 item 3)", () => {
  test("a row with the evidence: the deferred tool is declared up front with `deferLoading`, and a ToolSearch load leaves `tools` byte-identical", async () => {
    const f = fixture("evidence");
    try {
      const { requests, frames } = await drive({
        f,
        describe: DEFERRED_ROW,
        script: [{ kind: "tool_use", calls: [{ id: "call-1", name: f.select, input: {} }] }, { kind: "tool_use", calls: [{ id: "call-2", name: f.canonical, input: {} }] }, { kind: "text", text: "done" }],
      });
      expect(requests).toHaveLength(3);
      const declared = requests[0]!.tools!.find((t) => t.name === f.canonical);
      expect(declared?.deferLoading).toBe(true);
      // THE POINT: loading the tool changed nothing in `tools` -- the whole cached prefix survives.
      expect(JSON.stringify(requests[1]!.tools)).toBe(JSON.stringify(requests[0]!.tools));
      expect(JSON.stringify(requests[2]!.tools)).toBe(JSON.stringify(requests[0]!.tools));
      // The ToolSearch result names what it loaded, by the ADVERTISED name `tools` carries.
      expect(toolResults(requests[1]!).find((b) => b.tool_use_id === "call-1")?.loadedTools).toEqual([f.canonical]);
      // And the loaded tool really runs.
      const userFrames = frames.filter((fr) => fr.type === "data" && (fr as { message: { type: string } }).message.type === "user");
      const call2 = userFrames.flatMap((fr) => (fr as unknown as { message: { message: { content: Array<{ tool_use_id: string; content: unknown }> } } }).message.message.content).find((b) => b.tool_use_id === "call-2");
      expect(call2?.content).toBe("real result");
      expect(isSorted(names(requests[0]!))).toBe(true);
    } finally {
      f.dispose();
    }
  });

  test("a row WITHOUT the evidence keeps today's shape (the loaded tool is appended on load), but the list is still sorted", async () => {
    const f = fixture("plain");
    try {
      const { requests } = await drive({ f, script: [{ kind: "tool_use", calls: [{ id: "call-1", name: f.select, input: {} }] }, { kind: "text", text: "done" }] });
      expect(names(requests[0]!)).not.toContain(f.canonical);
      expect(names(requests[1]!)).toContain(f.canonical);
      expect(requests[1]!.tools!.some((t) => t.deferLoading === true)).toBe(false);
      expect(isSorted(names(requests[0]!))).toBe(true);
      expect(isSorted(names(requests[1]!))).toBe(true);
    } finally {
      f.dispose();
    }
  });

  test("a RESUMED history whose ToolSearch result names the tool re-seeds the loaded set: the tool stays deferred-and-referenced and runs without a load-first refusal", async () => {
    const f = fixture("resume");
    try {
      const history: ProviderMessage[] = [
        { role: "user", content: "earlier" },
        { role: "assistant", content: [{ type: "tool_use", id: "old-1", name: f.select, input: {} }] },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "old-1", content: '{"matches":["search_docs"]}', loadedTools: [f.canonical] }] },
        { role: "assistant", content: "ok" },
      ];
      const { requests, frames } = await drive({ f, describe: DEFERRED_ROW, initialMessages: history, script: [{ kind: "tool_use", calls: [{ id: "call-9", name: f.canonical, input: {} }] }, { kind: "text", text: "done" }] });
      expect(requests[0]!.tools!.find((t) => t.name === f.canonical)?.deferLoading).toBe(true);
      const userFrames = frames.filter((fr) => fr.type === "data" && (fr as { message: { type: string } }).message.type === "user");
      const call9 = userFrames.flatMap((fr) => (fr as unknown as { message: { message: { content: Array<{ tool_use_id: string; content: unknown; loadFirst?: boolean }> } } }).message.message.content).find((b) => b.tool_use_id === "call-9");
      expect(call9?.loadFirst).toBeUndefined();
      expect(call9?.content).toBe("real result");
    } finally {
      f.dispose();
    }
  });

  test("a pre-WS-23 history (a ToolSearch result with no `loadedTools`) loads nothing on resume; this run's own load then keeps `tools` unchanged", async () => {
    const f = fixture("unreferenced");
    try {
      const history: ProviderMessage[] = [
        { role: "user", content: "earlier" },
        { role: "assistant", content: [{ type: "tool_use", id: "old-1", name: f.select, input: {} }] },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "old-1", content: '{"matches":["search_docs"]}' }] },
        { role: "assistant", content: "ok" },
      ];
      const { requests } = await drive({ f, describe: DEFERRED_ROW, initialMessages: history, script: [{ kind: "tool_use", calls: [{ id: "c", name: f.select, input: {} }] }, { kind: "text", text: "done" }] });
      // Not loaded yet -> declared deferred.
      expect(requests[0]!.tools!.find((t) => t.name === f.canonical)?.deferLoading).toBe(true);
      // Loaded by this run's own ToolSearch -> referenced -> still deferred, tools unchanged.
      expect(JSON.stringify(requests[1]!.tools)).toBe(JSON.stringify(requests[0]!.tools));
    } finally {
      f.dispose();
    }
  });
});

describe("compaction evidence (WS-23 item 3)", () => {
  test("a retained ToolSearch result's `loadedTools` count as evidence, beside the tool_use names", () => {
    const retained: ProviderMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "ToolSearch", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "a", content: "{}", loadedTools: ["mcp__x__y"] }] },
    ];
    expect(evidencedToolNames(retained)).toEqual(["ToolSearch", "mcp__x__y"]);
  });
});
