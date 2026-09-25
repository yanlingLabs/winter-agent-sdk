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

describe("WS-23 command hooks through the engine: claude's stdin, with the store's own transcript path", () => {
  test("a settings command hook reads session_id, the REAL transcript_path, cwd, permission_mode and the tool fields on stdin", async () => {
    const { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { resolveEngineSession } = await import("./store/dialect.ts");
    const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-ws23-cmdhook-")));
    try {
      const cwd = join(home, "work");
      mkdirSync(cwd, { recursive: true });
      const captured = join(home, "stdin.json");
      const sessionConfig: RuntimeConfig = { sessionId: "sess-ws23", cwd, model: "winter-test/echo", winterHome: home, allowedTools: ["t"] };
      const resolved = await resolveEngineSession({ config: sessionConfig, resolveWinterHome: () => home, env: {} });
      const { host, runtime } = createInMemoryChannel();
      const { provider } = recordingProvider(TOOL_ROUND);
      const done = runEngine({
        config: resolved.config,
        input: runtime.input,
        output: runtime.output,
        provider,
        tools: stubExecutor,
        store: resolved.store!,
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        extraHookEntries: [{ id: "PreToolUse:user:0:0", event: "PreToolUse", source: "user", matcher: "t", command: `cat > ${JSON.stringify(captured)}` }],
      });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
      for await (const _f of host.input) {
        /* drain */
      }
      await done;
      const input = JSON.parse(readFileSync(captured, "utf8")) as Record<string, unknown>;
      expect(input).toMatchObject({ session_id: "sess-ws23", cwd, permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "t", tool_input: { x: 1 }, tool_use_id: "c1" });
      expect(typeof input["transcript_path"]).toBe("string");
      expect(String(input["transcript_path"]).endsWith("/sess-ws23.jsonl")).toBe(true);
      expect(existsSync(String(input["transcript_path"]))).toBe(true); // the file the session actually writes
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- WS-23 fix round 1 -----------------------------------------------------------------------------

describe("WS-23 fix round 1 (C1): a huge hook contribution cannot break the session", () => {
  test("a 5 MB PostToolUse additionalContext is bounded: the turn completes, and the NEXT turn runs", async () => {
    const big = "A".repeat(5 * 1024 * 1024);
    const { requests, messages } = await run({
      prompts: ["go", "second prompt"],
      turns: [...TOOL_ROUND, { kind: "text", text: "second answer" }],
      hooks: one("PostToolUse"),
      answer: () => ({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: big } }),
    });
    expect(requests).toHaveLength(3); // tool round, its follow-up, and the second prompt's own generation
    const results = messages.filter((m) => m.type === "result") as Array<{ is_error?: boolean; result?: string }>;
    expect(results.map((r) => r.is_error)).toEqual([false, false]);
    expect(results[1]!.result).toBe("second answer");
    const carried = textOf(toolResult(requests[2]!.messages, "c1")!.content);
    expect(carried).toContain("[…truncated: hook output exceeded");
    expect(carried.length).toBeLessThan(20_000);
  });

  test("a 5 MB updatedToolOutput is bounded too", async () => {
    const { requests } = await run({ prompts: ["go"], turns: TOOL_ROUND, hooks: one("PostToolUse"), answer: () => ({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "B".repeat(5 * 1024 * 1024) } }) });
    const replaced = textOf(toolResult(requests[1]!.messages, "c1")!.content);
    expect(replaced.length).toBeLessThan(110_000);
    expect(replaced).toContain("[…truncated: hook output exceeded 100000 characters]");
  });
});

describe("WS-23 fix round 1 (I1/M2): a stop request belongs to the turn that raised it", () => {
  test("SessionStart `continue:false` is announced and consumed -- the first prompt still runs", async () => {
    const { requests, messages } = await run({ prompts: ["hello"], turns: [{ kind: "text", text: "hi" }], hooks: one("SessionStart"), answer: () => ({ continue: false, stopReason: "maintenance" }) });
    expect(requests).toHaveLength(1);
    const notice = messages.find((m) => (m as { subtype?: string }).subtype === "informational") as { content?: string };
    expect(notice.content).toContain("SessionStart:startup hook asked to stop");
    expect(notice.content).not.toContain("UserPromptSubmit");
    expect((messages.find((m) => m.type === "result") as { terminal_reason?: string }).terminal_reason).toBeUndefined();
  });

  test("PostCompact `continue:false` during /compact does not drop the NEXT prompt", async () => {
    const { requests } = await run({
      prompts: ["hello", "/compact", "after"],
      turns: [{ kind: "text", text: "ok" }],
      hooks: one("PostCompact"),
      answer: () => ({ continue: false, stopReason: "compact-stop" }),
      engine: { compactionController: fakeCompactionController({ keep: 0, summary: "SUMMARY" }) },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.map((m) => textOf(m.content)).join("\n")).toContain("after");
  });

  test("M2: SessionStart context survives a BLOCKED first prompt and rides with the next one", async () => {
    let prompts = 0;
    const { requests } = await run({
      prompts: ["blocked one", "allowed one"],
      turns: [{ kind: "text", text: "ok" }],
      hooks: { SessionStart: [{ hookCount: 1, source: "sdk" }], UserPromptSubmit: [{ hookCount: 1, source: "sdk" }] },
      answer: (c) =>
        c.event === "SessionStart"
          ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "project briefing" } }
          : ++prompts === 1
            ? { decision: "block", reason: "no", hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "context of the blocked prompt" } }
            : {},
    });
    expect(requests).toHaveLength(1);
    const sent = requests[0]!.messages.map((m) => textOf(m.content)).join("\n");
    expect(sent).toContain("project briefing");
    expect(sent).not.toContain("context of the blocked prompt");
    expect(sent).not.toContain("blocked one");
  });
});

// I4: fail-closed END TO END through the engine, the evaluator and the in-memory hook bridge, under
// the two postures in which nothing else would stop the call -- bypassPermissions, and a matching
// allow rule (both skip the approval prompt). Adapted from the security review's probe.
describe("WS-23 fix round 1 (I4): a fail-closed PreToolUse hook denies under bypass and under an allow rule", () => {
  type Answer = { kind: "ok"; payload: unknown } | { kind: "err"; code: string; message: string } | { kind: "never" };
  async function runFailClosed(opts: { answer: Answer; failClosed: boolean; posture: Partial<RuntimeConfig>; timeoutSec?: number }): Promise<{ executed: number; result?: Extract<ContentBlock, { type: "tool_result" }> }> {
    const { host, runtime } = createInMemoryChannel();
    let executed = 0;
    const tools = { async execute({ name, input }: { name: string; input: unknown }) { executed++; return { output: `${name}:${JSON.stringify(input)}` }; } };
    const { provider } = recordingProvider(TOOL_ROUND);
    const done = runEngine({
      config: baseConfig({
        hooks: { PreToolUse: [{ matcher: "t", hookCount: 1, source: "sdk", ...(opts.failClosed ? { failClosed: true } : {}), ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}) }] },
        ...opts.posture,
      }),
      input: runtime.input,
      output: runtime.output,
      provider,
      tools,
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    const frames: WinterFrame[] = [];
    for await (const f of host.input) {
      frames.push(f);
      if (f.type !== "control_request") continue;
      const cf = f as ControlRequestFrame;
      if (cf.subtype === "hook") {
        if (opts.answer.kind === "ok") host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: opts.answer.payload });
        else if (opts.answer.kind === "err") host.output.write({ type: "control_response", requestId: cf.requestId, ok: false, error: { code: opts.answer.code, message: opts.answer.message } });
      } else if (cf.subtype === "permission") {
        host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: { behavior: "allow" } });
      }
    }
    await done;
    const blocks = frames
      .filter((f) => f.type === "data" && (f as { message: SdkMessage }).message.type === "user")
      .flatMap((f) => ((f as { message: { message?: { content?: ContentBlock[] } } }).message.message?.content ?? []));
    const result = blocks.find((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result" && b.tool_use_id === "c1");
    return { executed, ...(result !== undefined ? { result } : {}) };
  }

  const POSTURES: Array<[string, Partial<RuntimeConfig>]> = [
    ["bypassPermissions", { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }],
    ["a matching allow rule", { allowedTools: ["t"] }],
  ];
  const FAILURES: Array<[string, Answer, number | undefined]> = [
    ["a throw (hook_threw)", { kind: "err", code: "hook_threw", message: "boom" }, undefined],
    ["a timeout", { kind: "never" }, 0.3],
    ["a malformed (non-object) answer", { kind: "ok", payload: "nope" }, undefined],
    ["a null answer", { kind: "ok", payload: null }, undefined],
    ["an unknown_hook_id (bridge drift)", { kind: "err", code: "unknown_hook_id", message: "no such hook" }, undefined],
  ];
  for (const [postureName, posture] of POSTURES) {
    for (const [failureName, answer, timeoutSec] of FAILURES) {
      test(`${postureName}: ${failureName} DENIES and the executor never runs`, async () => {
        const r = await runFailClosed({ answer, failClosed: true, posture, ...(timeoutSec !== undefined ? { timeoutSec } : {}) });
        expect(r.executed).toBe(0);
        expect(r.result?.denied).toBe(true);
        expect(String(r.result?.content)).toContain("fail-closed");
        expect(String(r.result?.content)).not.toContain("boom"); // M3: never the host's error text
      });
    }
    test(`${postureName}: WITHOUT failClosed a throw still lets the call run (the default is unchanged)`, async () => {
      const r = await runFailClosed({ answer: { kind: "err", code: "hook_threw", message: "boom" }, failClosed: false, posture });
      expect(r.executed).toBe(1);
    });
  }
});
