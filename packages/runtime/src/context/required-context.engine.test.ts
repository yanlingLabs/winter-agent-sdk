import { expect, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { runEngine, type EngineOptions, type ProviderRequest, type ProviderTurn } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { stubExecutor } from "../provider/mock.ts";
import { getSessionRequestLayout } from "./request-layout.ts";
import type { RequiredContextSource } from "./required-context.ts";
import type { SystemPromptAssembler } from "./seam.ts";
import { createChildEngineFactory } from "../subagents/child-engine.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest, type SpawnChildRequest } from "../subagents/child-handle.ts";
import { resetSpawnLimitsForTest } from "../subagents/limits.ts";
import { registerTool, unregisterToolForTest } from "../tools/registry.ts";

const source = (instructions: () => string): RequiredContextSource => ({ resolve: async () => ({ revision: "host-config:1", facts: "HOST-FACTS", instructions: instructions() }) });
function assembler(requiredContext?: RequiredContextSource): SystemPromptAssembler {
  return { assemble: () => ({ system: "BASE-SYSTEM", systemParts: { staticParts: ["BASE-SYSTEM"], dynamicParts: [], hasBoundary: true } }),
    userContext: () => [["claudeMd", "STALE-LEGACY-GUIDANCE"], ["currentDate", "fixture-date"]],
    ...(requiredContext !== undefined ? { requiredContext } : {}),
  };
}
async function drive(options: { prompts?: string[]; engine?: Partial<EngineOptions>; betweenTurns?: () => void;
  realTools?: boolean; generate?: (request: ProviderRequest, index: number) => ProviderTurn; onRequest?: (request: ProviderRequest) => void }) {
  const { host, runtime } = createInMemoryChannel(); const requests: ProviderRequest[] = [], frames: WinterFrame[] = [];
  const config: RuntimeConfig = { sessionId: "required-context-fixture", cwd: "/fixture", model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
  const done = runEngine({ config, input: runtime.input, output: runtime.output, ...(options.realTools ? {} : { tools: stubExecutor }),
    provider: { generate: async request => { requests.push(request); options.onRequest?.(request); return options.generate?.(request, requests.length - 1) ?? { kind: "text", text: "ok" }; } },
    ...options.engine,
  });
  const reader = (async () => { for await (const frame of host.input) frames.push(frame); })();
  const results = () => frames.filter(frame => frame.type === "data" && (frame.message as { type?: string })?.type === "result");
  const prompts = options.prompts ?? ["task"];
  for (let turn = 0; turn < prompts.length; turn++) {
    host.output.write({ type: "user", text: prompts[turn]! });
    for (let tick = 0; tick < 600 && results().length <= turn; tick++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(results().length).toBe(turn + 1); options.betweenTurns?.();
  }
  host.output.write({ type: "control_request", requestId: "finish", subtype: "end_input", payload: undefined });
  await done; await reader;
  return { requests, frames };
}
const messageText = (request: ProviderRequest) => JSON.stringify(request.messages);

test("absent required layer retains ordinary Code request context", async () => {
  const run = await drive({ engine: { systemPromptAssembler: assembler() } });
  expect(messageText(run.requests[0]!)).toContain("STALE-LEGACY-GUIDANCE");
  expect(run.requests[0]!.system).toBe("BASE-SYSTEM");
});

test.each([false, true])("current guidance survives omitted project context (%s) and updates with unchanged host revision", async omitProjectContext => {
  let text = "CURRENT-ONE";
  const run = await drive({ prompts: ["first", "second"], engine: { systemPromptAssembler: assembler(source(() => text)), omitProjectContext }, betweenTurns: () => { text = "CURRENT-TWO"; } });
  expect(messageText(run.requests[0]!)).toContain("CURRENT-ONE"); expect(messageText(run.requests[1]!)).toContain("CURRENT-TWO");
  expect(messageText(run.requests[1]!)).not.toContain("CURRENT-ONE");
  for (const request of run.requests) {
    expect(messageText(request)).not.toContain("STALE-LEGACY-GUIDANCE"); expect(request.system!.match(/# Current workspace context/g)).toHaveLength(1);
    expect(request.system).not.toContain("CURRENT-"); expect(messageText(request).match(/# claudeMd/g)).toHaveLength(1);
  }
});

test("tool continuations re-resolve and the captured fork base contains no live overlay", async () => {
  let text = "BEFORE-TOOL", resolutions = 0;
  const required: RequiredContextSource = { resolve: async request => { expect(request.cwd).toBe("/fixture"); resolutions++; return { revision: "host:1", facts: "HOST", instructions: text }; } };
  const captured: unknown[] = [];
  const run = await drive({ engine: { systemPromptAssembler: assembler(required), tools: { execute: async () => { text = "AFTER-TOOL"; return { output: "effect" }; } } },
    generate: (_, index) => index === 0 ? { kind: "tool_use", calls: [{ id: "call-1", name: "Probe", input: {} }] } : { kind: "text", text: "done" },
    onRequest: () => captured.push(structuredClone(getSessionRequestLayout("required-context-fixture"))),
  });
  expect(resolutions).toBe(2); expect(messageText(run.requests[0]!)).toContain("BEFORE-TOOL"); expect(messageText(run.requests[1]!)).toContain("AFTER-TOOL");
  expect(JSON.stringify(captured)).not.toContain("BEFORE-TOOL"); expect(JSON.stringify(captured)).not.toContain("AFTER-TOOL"); expect(JSON.stringify(captured)).not.toContain("STALE-LEGACY-GUIDANCE");
});

test("an exact inherited layout with prior history receives current guidance while preserving its base", async () => {
  const run = await drive({ engine: { systemPromptAssembler: assembler(source(() => "RESTORED-CURRENT")),
    exactRequestLayout: { system: "INHERITED-BASE", systemBlocks: [{ text: "INHERITED-BASE", cacheScope: "global" }], userContext: [["claudeMd", "FROZEN-OLD-GUIDANCE"], ["currentDate", "inherited-date"]], tools: [] },
    initialMessages: [{ role: "user", content: "historical task" }, { role: "assistant", content: "historical reply" }],
  } });
  expect(run.requests[0]!.system).toContain("INHERITED-BASE"); expect(messageText(run.requests[0]!)).toContain("RESTORED-CURRENT");
  expect(run.requests[0]!.system).not.toContain("RESTORED-CURRENT");
  expect(messageText(run.requests[0]!)).not.toContain("FROZEN-OLD-GUIDANCE"); expect(messageText(run.requests[0]!)).toContain("historical reply");
});

test("a timed-out context lookup dispatches no model request", async () => {
  const run = await drive({ engine: { systemPromptAssembler: assembler({ timeoutMs: 10, resolve: async () => new Promise(() => {}) }) } });
  expect(run.requests).toEqual([]); expect(JSON.stringify(run.frames)).toContain("required_context_timed_out");
});

test("interrupting a parked context lookup settles without model dispatch", async () => {
  const { host, runtime } = createInMemoryChannel(); let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }); const frames: WinterFrame[] = []; let dispatched = 0;
  const done = runEngine({ config: { sessionId: "required-interrupt", cwd: "/fixture", model: "winter-test/echo" },
    input: runtime.input, output: runtime.output, tools: stubExecutor,
    provider: { generate: async () => { dispatched++; return { kind: "text", text: "must not run" }; } },
    systemPromptAssembler: assembler({ resolve: async () => { entered(); return new Promise(() => {}); } }),
  });
  const reader = (async () => { for await (const frame of host.input) frames.push(frame); })();
  host.output.write({ type: "user", text: "task" }); await ready;
  host.output.write({ type: "control_request", requestId: "interrupt", subtype: "interrupt", payload: undefined });
  for (let tick = 0; tick < 200 && !frames.some(frame => frame.type === "data" && (frame.message as { type?: string })?.type === "result"); tick++) await new Promise(resolve => setTimeout(resolve, 5));
  host.output.write({ type: "control_request", requestId: "finish", subtype: "end_input", payload: undefined });
  await done; await reader;
  expect(dispatched).toBe(0); expect(JSON.stringify(frames)).toContain("interrupted");
});

test("idle compact control after an interrupted turn uses a fresh operation signal", async () => {
  const { host, runtime } = createInMemoryChannel(); let entered!: () => void, idle!: () => void, acknowledge!: (frame: WinterFrame) => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), quiescent = new Promise<void>(resolve => { idle = resolve; });
  const compacted = new Promise<WinterFrame>(resolve => { acknowledge = resolve; });
  let waiting = false; const requests: ProviderRequest[] = [], purposes: string[] = [];
  const frames: WinterFrame[] = [];
  const done = runEngine({ config: { sessionId: "required-idle-compact", cwd: "/fixture", model: "winter-test/echo" },
    input: runtime.input, output: runtime.output, tools: stubExecutor,
    onSessionPhase: phase => { if (waiting && phase === "idle") idle(); },
    provider: { generate: async request => { requests.push(request); return { kind: "text", text: "summary" }; } },
    systemPromptAssembler: assembler({ resolve: async (request, options) => {
      purposes.push(request.purpose);
      if (request.purpose === "generation") { waiting = true; entered(); return new Promise(() => {}); }
      expect(options.signal.aborted).toBe(false);
      return { revision: "host:2", facts: "CURRENT-HOST", instructions: "CURRENT-AFTER-INTERRUPT" };
    } }),
    compactionController: { shouldCompact: () => false, compact: async input => {
      await input.provider.generate(input.prefixRequest ?? { messages: input.messages });
      return { summary: "summary", retained: [], preTokens: 1, evidencedToolNames: [] };
    } },
  });
  const reader = (async () => { for await (const frame of host.input) {
    frames.push(frame); if (frame.type === "control_response" && frame.requestId === "compact-idle") acknowledge(frame);
  } })();
  host.output.write({ type: "user", text: "task" }); await ready;
  host.output.write({ type: "control_request", requestId: "interrupt", subtype: "interrupt", payload: undefined }); await quiescent;
  host.output.write({ type: "control_request", requestId: "compact-idle", subtype: "compact", payload: {} });
  expect(await compacted).toMatchObject({ ok: true });
  // A manual command also owns a fresh turn signal after the same interruption.
  host.output.write({ type: "user", text: "/compact" });
  for (let tick = 0; tick < 200 && requests.length < 2; tick++) await new Promise(resolve => setTimeout(resolve, 5));
  host.output.write({ type: "control_request", requestId: "finish", subtype: "end_input", payload: undefined }); await done; await reader;
  expect(purposes).toEqual(["generation", "compaction", "compaction"]); expect(requests).toHaveLength(2);
  for (const request of requests) expect(messageText(request)).toContain("CURRENT-AFTER-INTERRUPT");
});

test("unavailable current guidance prevents dispatch and does not expose the host exception", async () => {
  const run = await drive({ engine: { systemPromptAssembler: assembler({ resolve: async () => { throw Error("PRIVATE-HOST-DETAIL"); } }) } });
  expect(run.requests).toEqual([]); const wire = JSON.stringify(run.frames);
  expect(wire).toContain("required_context_unavailable"); expect(wire).not.toContain("PRIVATE-HOST-DETAIL");
});

test("compaction dispatch refreshes current guidance outside the reusable prefix", async () => {
  let text = "BEFORE-COMPACT"; const requests: ProviderRequest[] = [];
  const run = await drive({ prompts: ["first", "/compact", "next"], engine: { systemPromptAssembler: assembler(source(() => text)), compactionController: {
    shouldCompact: () => false,
    compact: async input => { text = "DURING-COMPACT"; await input.provider.generate(input.prefixRequest ?? { messages: input.messages });
      return { summary: "summary", retained: [], preTokens: 1, evidencedToolNames: [] }; },
  } }, onRequest: request => requests.push(request) });
  expect(run.requests).toHaveLength(3); expect(messageText(run.requests[1]!)).toContain("DURING-COMPACT");
  expect(messageText(run.requests[1]!)).not.toContain("BEFORE-COMPACT"); expect(run.requests[2]!.system!.match(/# Current workspace context/g)).toHaveLength(1);
});

test("per-message effort and a live tool epoch retain one current Code reminder after the leading marker", async () => {
  const first = "RequiredContextEpochFirst", late = "RequiredContextEpochLate";
  const register = (name: string) => registerTool({ descriptor: { canonicalName: name, advertisedName: name, source: "sdk", inputSchema: { type: "object" },
    description: "fixture epoch tool", exposure: "eager", permissionClass: "read", availability: {}, capabilityRequirements: [], disposition: "implement-now" },
    executor: { execute: async () => ({ output: "unused" }) },
  });
  register(first);
  let runLate = false;
  try {
    const run = await drive({ prompts: ["first", "second"], engine: {
      config: { sessionId: "required-context-fixture", cwd: "/fixture", model: "anthropic/claude-opus-5-5", effort: "high" },
      providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-opus-5-5", family: "anthropic" },
      describeModel: () => ({ efforts: ["low", "high"], wire: { perMessageEffort: true, deferredToolLoading: true, toolChanges: "reference" } }),
      systemPromptAssembler: assembler(source(() => "CURRENT-EPOCH-GUIDANCE")),
    }, betweenTurns: () => { if (!runLate) { register(late); runLate = true; } } });
    expect(run.requests[1]!.messages.some(message => message.toolChanges !== undefined)).toBe(true);
    for (const request of run.requests) {
      expect(request.messages[0]).toMatchObject({ role: "system", content: [], outputConfig: { effort: "high" } });
      const blocks = request.messages.flatMap(message => typeof message.content === "string" ? [message.content] : message.content.flatMap(block => block.type === "text" ? [block.text] : []));
      const reminders = blocks.filter(text => text.includes("As you answer the user's questions"));
      expect(reminders).toHaveLength(1); expect(reminders[0]).toContain("# claudeMd"); expect(reminders[0]).toContain("# currentDate");
      expect(reminders[0]).toContain("CURRENT-EPOCH-GUIDANCE");
    }
  } finally { unregisterToolForTest(first); unregisterToolForTest(late); }
});

test("the real child factory carries current guidance into ordinary, specialized and forked children", async () => {
  const name = "RequiredContextChildProbe", childRequests: ProviderRequest[] = [];
  const seenActors: Array<string | undefined> = [];
  const shared = assembler({ resolve: async input => {
    seenActors.push(input.agentId);
    return { revision: "host:1", facts: "HOST", instructions: input.agentId ? "CURRENT-CHILD-GUIDANCE" : "CURRENT-PARENT-GUIDANCE" };
  } });
  registerTool({ descriptor: { canonicalName: name, advertisedName: name, source: "builtin", inputSchema: { type: "object" },
    description: "fixture child probe", exposure: "eager", permissionClass: "read", availability: {}, capabilityRequirements: [], disposition: "implement-now" },
    executor: { execute: async (input, context) => {
      const child = await context.session.spawnChild!(input as SpawnChildRequest);
      return { output: JSON.stringify(await child.result()) };
    } },
  });
  registerChildEngineFactory(createChildEngineFactory({ systemPromptAssembler: shared,
    provider: { generate: async request => { childRequests.push(request); return { kind: "text", text: "child done" }; } },
  }));
  try {
    const calls = [
      { id: "ordinary", name, input: { parentToolUseId: "ordinary", prompt: "ordinary task", runInBackground: false } },
      { id: "specialized", name, input: { parentToolUseId: "specialized", prompt: "specialized task", runInBackground: false, definition: { description: "specialized", prompt: "persona", omitProjectContext: true } } },
      { id: "fork", name, input: { parentToolUseId: "fork", prompt: "fork task", runInBackground: false, fork: true } },
    ];
    await drive({ realTools: true, engine: { systemPromptAssembler: shared },
      generate: (_, index) => index === 0 ? { kind: "tool_use", calls } : { kind: "text", text: "done" },
    });
    expect(childRequests).toHaveLength(3);
    expect(seenActors.filter(actor => actor !== undefined)).toHaveLength(3);
    for (const request of childRequests) {
      expect(messageText(request)).toContain("CURRENT-CHILD-GUIDANCE"); expect(messageText(request)).not.toContain("CURRENT-PARENT-GUIDANCE");
      expect(request.system).not.toContain("CURRENT-CHILD-GUIDANCE");
      expect(request.system!.match(/# Current workspace context/g)).toHaveLength(1);
      expect(messageText(request)).not.toContain("STALE-LEGACY-GUIDANCE");
    }
  } finally { resetChildEngineFactoryForTest(); resetSpawnLimitsForTest(); unregisterToolForTest(name); }
});
