// WS-23: what a hook SAYS now reaches the model, the host and the turn loop -- pinned through the
// real engine, the real registry and the real hook bridge (callback hooks answered over the in-memory
// channel exactly as a host's SDK wrapper answers them). Each test asserts the observable outcome: the
// provider request's messages, the frames a host sees, or how many generations ran.
import { test, expect, describe } from "bun:test";
import type { ControlRequestFrame, RuntimeConfig, RuntimeHooksConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { runEngine, STOP_HOOK_BLOCK_CAP, type ContentBlock, type EngineOptions, type Provider, type ProviderMessage, type ProviderTurn } from "./engine.ts";
import { stubExecutor } from "./provider/mock.ts";
import { fakeCompactionController } from "./compaction/seam.ts";

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ sessionId: "s", cwd: "/tmp/x", model: "winter-test/echo", ...overrides });

interface HookCall {
  event: string;
  toolName?: string;
  payload?: Record<string, unknown>;
}

/** A provider that plays `turns` in order (repeating the last) and records every request's messages and system prompt. */
function recordingProvider(turns: ProviderTurn[]): { provider: Provider; requests: Array<{ messages: ProviderMessage[]; system?: string }> } {
  const requests: Array<{ messages: ProviderMessage[]; system?: string }> = [];
  let i = 0;
  return {
    requests,
    provider: {
      async generate(input) {
        requests.push({ messages: input.messages.map((m) => ({ ...m })), ...(input.system !== undefined ? { system: input.system } : {}) });
        return turns[Math.min(i++, turns.length - 1)]!;
      },
    },
  };
}

/**
 * Runs one engine with SDK-callback hooks (`hooks` is the wire config a host's `Options.hooks`
 * becomes) and answers every `hook` control_request with `answer(call)`. Returns every data message
 * and the hook calls in order.
 */
async function run(opts: {
  prompts: string[];
  turns: ProviderTurn[];
  hooks: RuntimeHooksConfig;
  answer: (call: HookCall) => unknown;
  config?: Partial<RuntimeConfig>;
  engine?: Partial<EngineOptions>;
}): Promise<{ messages: SdkMessage[]; hookCalls: HookCall[]; requests: Array<{ messages: ProviderMessage[]; system?: string }> }> {
  const { host, runtime } = createInMemoryChannel();
  const { provider, requests } = recordingProvider(opts.turns);
  const done = runEngine({
    config: baseConfig({ allowedTools: ["t"], hooks: opts.hooks, ...opts.config }),
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: stubExecutor,
    ...opts.engine,
  });
  for (const text of opts.prompts) host.output.write({ type: "user", text });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const hookCalls: HookCall[] = [];
  const frames: WinterFrame[] = [];
  for await (const f of host.input) {
    frames.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
      const cf = f as ControlRequestFrame;
      const p = cf.payload as { event: string; toolName?: string; payload?: Record<string, unknown> };
      const call: HookCall = { event: p.event, ...(p.toolName !== undefined ? { toolName: p.toolName } : {}), ...(p.payload !== undefined ? { payload: p.payload } : {}) };
      hookCalls.push(call);
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: opts.answer(call) ?? {} });
    }
  }
  await done;
  const messages = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
  return { messages, hookCalls, requests };
}

const one = (event: string): RuntimeHooksConfig => ({ [event]: [{ hookCount: 1, source: "sdk" }] });

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? textOf(b.content) : "")).join("\n");
}

/** The tool_result block for `id` in a request's messages. */
function toolResult(messages: ProviderMessage[], id: string): Extract<ContentBlock, { type: "tool_result" }> | undefined {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_result" && b.tool_use_id === id) return b;
  }
  return undefined;
}

const TOOL_ROUND: ProviderTurn[] = [{ kind: "tool_use", calls: [{ id: "c1", name: "t", input: { x: 1 } }] }, { kind: "text", text: "done" }];

describe("WS-23 additionalContext reaches the model, at the conversation tail, never in the system prompt", () => {
  test("PostToolUse: folded INTO that call's tool_result on the next request, wrapped as a harness reminder", async () => {
    const { requests } = await run({ prompts: ["go"], turns: TOOL_ROUND, hooks: one("PostToolUse"), answer: () => ({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "diagnostics: 0 errors" } }) });
    const result = toolResult(requests[1]!.messages, "c1")!;
    expect(textOf(result.content)).toContain("<system-reminder>\nPostToolUse:t hook additional context: diagnostics: 0 errors\n</system-reminder>");
    expect(requests[1]!.system ?? "").not.toContain("diagnostics: 0 errors");
  });

  test("PreToolUse: its context lands with the same call's result", async () => {
    const { requests } = await run({ prompts: ["go"], turns: TOOL_ROUND, hooks: one("PreToolUse"), answer: () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "this file is generated" } }) });
    expect(textOf(toolResult(requests[1]!.messages, "c1")!.content)).toContain("PreToolUse:t hook additional context: this file is generated");
  });

  test("PostToolUseFailure: an isError result's hook context reaches the model too", async () => {
    const failing = { async execute() { return { output: "boom", isError: true }; } };
    const { requests } = await run({ prompts: ["go"], turns: TOOL_ROUND, hooks: one("PostToolUseFailure"), answer: () => ({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "retry with --force" } }), engine: { tools: failing } });
    expect(textOf(toolResult(requests[1]!.messages, "c1")!.content)).toContain("PostToolUseFailure:t hook additional context: retry with --force");
  });

  test("UserPromptSubmit: delivered WITH the prompt on the first request", async () => {
    const { requests } = await run({ prompts: ["hello"], turns: [{ kind: "text", text: "hi" }], hooks: one("UserPromptSubmit"), answer: () => ({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "the user prefers terse answers" } }) });
    const all = requests[0]!.messages.map((m) => textOf(m.content)).join("\n");
    expect(all).toContain("UserPromptSubmit hook additional context: the user prefers terse answers");
    expect(all).toContain("hello");
    expect(requests[0]!.system ?? "").not.toContain("terse answers");
  });

  test("SessionStart: delivered with the FIRST user turn only -- the second turn does not repeat it", async () => {
    const { requests } = await run({ prompts: ["one", "two"], turns: [{ kind: "text", text: "a" }], hooks: one("SessionStart"), answer: () => ({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "branch: main, 3 dirty files" } }) });
    const first = requests[0]!.messages.map((m) => textOf(m.content)).join("\n");
    expect(first).toContain("SessionStart:startup hook additional context: branch: main, 3 dirty files");
    const second = requests[1]!.messages.map((m) => textOf(m.content)).join("\n");
    // Once in the history (so still present), never appended a second time.
    expect(second.split("branch: main, 3 dirty files").length - 1).toBe(1);
  });

  test("SessionStart fires again with source \"compact\" after a compaction, and its context rides with the compacted history", async () => {
    const { hookCalls, requests } = await run({
      prompts: ["hello", "/compact", "after"],
      turns: [{ kind: "text", text: "ok" }],
      hooks: one("SessionStart"),
      answer: (c) => ({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `ctx for ${String(c.payload?.["source"])}` } }),
      engine: { compactionController: fakeCompactionController({ keep: 0, summary: "SUMMARY" }) },
    });
    expect(hookCalls.filter((c) => c.event === "SessionStart").map((c) => c.payload?.["source"])).toEqual(["startup", "compact"]);
    const afterCompaction = requests[requests.length - 1]!.messages.map((m) => textOf(m.content)).join("\n");
    expect(afterCompaction).toContain("SessionStart:compact hook additional context: ctx for compact");
    // Merged into the same leading user message as the summary (the request layout bubbles an
    // attachment to the top of the history when nothing precedes it -- claude's `SJn`).
    expect(afterCompaction).toContain("SUMMARY");
    expect(afterCompaction.split("ctx for compact").length - 1).toBe(1);
  });
});

describe("WS-23 decisions the runner used to ignore", () => {
  test("Stop `decision: block` keeps the turn going with the reason fed to the model; the re-fire carries stop_hook_active", async () => {
    let stops = 0;
    const { hookCalls, requests, messages } = await run({
      prompts: ["go"],
      turns: [{ kind: "text", text: "first answer" }, { kind: "text", text: "fixed" }],
      hooks: one("Stop"),
      answer: () => (++stops === 1 ? { decision: "block", reason: "the tests are still failing" } : {}),
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.map((m) => textOf(m.content)).join("\n")).toContain("Stop hook feedback:\nthe tests are still failing");
    expect(hookCalls.filter((c) => c.event === "Stop").map((c) => c.payload?.["stop_hook_active"])).toEqual([false, true]);
    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect((results[0] as { result?: string }).result).toBe("fixed");
  });

  test("a Stop hook that ALWAYS blocks is cut off at the cap, and the host is told", async () => {
    const { requests, messages } = await run({ prompts: ["go"], turns: [{ kind: "text", text: "again" }], hooks: one("Stop"), answer: () => ({ decision: "block", reason: "never satisfied" }) });
    expect(requests).toHaveLength(STOP_HOOK_BLOCK_CAP + 1);
    expect(messages.some((m) => m.type === "system" && (m as { subtype?: string }).subtype === "informational" && String((m as { content?: unknown }).content).includes("blocked the turn from ending"))).toBe(true);
    expect(messages.filter((m) => m.type === "result")).toHaveLength(1);
  });

  test("UserPromptSubmit `decision: block` drops the prompt: no generation, a result carrying the reason, a notice for the host", async () => {
    const { requests, messages } = await run({ prompts: ["paste my API key sk-123"], turns: [{ kind: "text", text: "x" }], hooks: one("UserPromptSubmit"), answer: () => ({ decision: "block", reason: "prompt contains a secret" }) });
    expect(requests).toHaveLength(0);
    const result = messages.find((m) => m.type === "result") as { result?: string; terminal_reason?: string; is_error?: boolean };
    expect(result.result).toBe("prompt contains a secret");
    expect(result.terminal_reason).toBe("hook_stopped");
    expect(messages.some((m) => (m as { subtype?: string }).subtype === "informational" && String((m as { content?: unknown }).content).includes("prompt contains a secret"))).toBe(true);
  });

  test("a blocked prompt never enters the history: the NEXT turn's request does not carry it", async () => {
    let calls = 0;
    const { requests } = await run({ prompts: ["forbidden words", "fine words"], turns: [{ kind: "text", text: "ok" }], hooks: one("UserPromptSubmit"), answer: () => (++calls === 1 ? { decision: "block", reason: "no" } : {}) });
    expect(requests).toHaveLength(1);
    const all = requests[0]!.messages.map((m) => textOf(m.content)).join("\n");
    expect(all).toContain("fine words");
    expect(all).not.toContain("forbidden words");
  });

  test("`continue: false` from PostToolUse ends the turn after the round with the hook's stopReason", async () => {
    const { requests, messages } = await run({ prompts: ["go"], turns: TOOL_ROUND, hooks: one("PostToolUse"), answer: () => ({ continue: false, stopReason: "budget review required" }) });
    expect(requests).toHaveLength(1); // no second generation
    const result = messages.find((m) => m.type === "result") as { result?: string; terminal_reason?: string };
    expect(result.result).toBe("budget review required");
    expect(result.terminal_reason).toBe("hook_stopped");
  });

  test("`continue: false` from PreToolUse stops the call it gates (denied, never executed) and the turn", async () => {
    let executed = 0;
    const counting = { async execute() { executed++; return { output: "ran" }; } };
    const { requests, messages } = await run({ prompts: ["go"], turns: TOOL_ROUND, hooks: one("PreToolUse"), answer: () => ({ continue: false, stopReason: "maintenance window" }), engine: { tools: counting } });
    expect(executed).toBe(0);
    expect(requests).toHaveLength(1);
    expect((messages.find((m) => m.type === "result") as { terminal_reason?: string }).terminal_reason).toBe("hook_stopped");
  });

  test("`systemMessage` is surfaced to the host as an informational notice", async () => {
    const { messages } = await run({ prompts: ["go"], turns: [{ kind: "text", text: "ok" }], hooks: one("UserPromptSubmit"), answer: () => ({ systemMessage: "Using the staging database" }) });
    const notice = messages.find((m) => (m as { subtype?: string }).subtype === "informational") as { content?: string; level?: string } | undefined;
    expect(notice?.content).toBe("Using the staging database");
    expect(notice?.level).toBe("warning");
  });

  test("PostToolUse `updatedToolOutput` replaces what the model sees -- on the wire, and in the next request", async () => {
    const { requests, messages } = await run({ prompts: ["go"], turns: TOOL_ROUND, hooks: one("PostToolUse"), answer: () => ({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "[redacted]" } }) });
    expect(textOf(toolResult(requests[1]!.messages, "c1")!.content)).toBe("[redacted]");
    const userFrame = messages.find((m) => m.type === "user") as { message: { content: ContentBlock[] } };
    expect((userFrame.message.content[0] as { content: unknown }).content).toBe("[redacted]");
  });

  test("an MCP-shaped updatedToolOutput contributes its content blocks", async () => {
    const { requests } = await run({ prompts: ["go"], turns: TOOL_ROUND, hooks: one("PostToolUse"), answer: () => ({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedMCPToolOutput: { content: [{ type: "text", text: "clean" }] } } }) });
    expect(textOf(toolResult(requests[1]!.messages, "c1")!.content)).toBe("clean");
  });
});

describe("WS-23 subagent lifecycle: a child engine fires SubagentStart/SubagentStop", () => {
  test("SubagentStart replaces SessionStart and SubagentStop replaces Stop, carrying agent_type; the start context reaches the child's model", async () => {
    let stops = 0;
    const { hookCalls, requests } = await run({
      prompts: ["do the task"],
      turns: [{ kind: "text", text: "partial" }, { kind: "text", text: "complete" }],
      hooks: { SessionStart: [{ hookCount: 1, source: "sdk" }], SubagentStart: [{ hookCount: 1, source: "sdk" }], Stop: [{ hookCount: 1, source: "sdk" }], SubagentStop: [{ hookCount: 1, source: "sdk" }] },
      answer: (c) => {
        if (c.event === "SubagentStart") return { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "you are reviewing PR 42" } };
        if (c.event === "SubagentStop") return ++stops === 1 ? { decision: "block", reason: "also check the tests" } : {};
        return {};
      },
      config: { agentId: "agent-1" },
      engine: { subagentHooks: { agentType: "code-reviewer", agentTranscriptPath: "/t/agent-1.jsonl" } },
    });
    const events = hookCalls.map((c) => c.event);
    expect(events).not.toContain("SessionStart");
    expect(events).not.toContain("Stop");
    expect(events.filter((e) => e === "SubagentStart")).toHaveLength(1);
    const start = hookCalls.find((c) => c.event === "SubagentStart")!;
    expect(start.payload).toMatchObject({ agent_id: "agent-1", agent_type: "code-reviewer" });
    const subStops = hookCalls.filter((c) => c.event === "SubagentStop");
    expect(subStops.map((c) => c.payload?.["stop_hook_active"])).toEqual([false, true]);
    expect(subStops[0]!.payload).toMatchObject({ agent_type: "code-reviewer", agent_transcript_path: "/t/agent-1.jsonl", last_assistant_message: "partial" });
    expect(requests[0]!.messages.map((m) => textOf(m.content)).join("\n")).toContain("SubagentStart:code-reviewer hook additional context: you are reviewing PR 42");
    expect(requests[1]!.messages.map((m) => textOf(m.content)).join("\n")).toContain("SubagentStop:code-reviewer hook feedback:\nalso check the tests");
  });
});
