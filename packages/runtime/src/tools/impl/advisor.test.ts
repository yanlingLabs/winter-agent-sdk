import { describe, test, expect } from "bun:test";
import type { Provider, ProviderMessage, ProviderTurn } from "../../engine.ts";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { runEngine } from "../../engine.ts";
import { createInMemoryChannel } from "../../protocol/channel.ts";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import {
  ADVISOR_TOOL_NAME,
  assembleReviewerMessages,
  createAdvisorExecutor,
  type ResolvedReviewer,
  type TranscriptEntry,
} from "./advisor.ts";

function makeCtx(): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId: "test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/tmp/winter-test",
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
  };
}

function textProvider(text: string): Provider {
  return { async generate() {
    return { kind: "text", text } satisfies ProviderTurn;
  } };
}

describe("advisor (task-7 brief, R3-2/R3-3)", () => {
  test("module load installs a real executor over the WS-06 stub, with a safe (always-unavailable) default", async () => {
    const registered = getRegisteredTool(ADVISOR_TOOL_NAME);
    expect(registered?.executor).toBeDefined();
    const result = await registered!.executor!.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("unavailable");
  });

  test("no reviewer resolvable -> ordinary tool error, never throws", async () => {
    const executor = createAdvisorExecutor({
      transcriptSource: { getEntries: () => [] },
      resolveReviewer: () => undefined,
    });
    const result = await executor.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("unavailable");
  });

  test("resolveReviewer throwing is caught as an ordinary tool error", async () => {
    const executor = createAdvisorExecutor({
      transcriptSource: { getEntries: () => [] },
      resolveReviewer: () => {
        throw new Error("catalog lookup failed");
      },
    });
    const result = await executor.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("catalog lookup failed");
  });

  test("transcriptSource throwing is caught as an ordinary tool error", async () => {
    const reviewer: ResolvedReviewer = { provider: textProvider("advice"), model: "reviewer-model-x" };
    const executor = createAdvisorExecutor({
      transcriptSource: {
        getEntries: () => {
          throw new Error("transcript unavailable");
        },
      },
      resolveReviewer: () => reviewer,
    });
    const result = await executor.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("transcript unavailable");
  });

  test("happy path: resolves {advice, model}, no truncated field when nothing was clipped", async () => {
    const reviewer: ResolvedReviewer = { provider: textProvider("Looks solid; ship it."), model: "reviewer-model-x" };
    const executor = createAdvisorExecutor({
      transcriptSource: { getEntries: () => [{ role: "user", text: "should I ship this?" }] },
      resolveReviewer: () => reviewer,
    });
    const result = await executor.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed).toEqual({ advice: "Looks solid; ship it.", model: "reviewer-model-x" });
    expect("truncated" in parsed).toBe(false);
  });

  test("provider.generate throwing -> ordinary tool error, never blocks the turn", async () => {
    const reviewer: ResolvedReviewer = {
      provider: {
        async generate() {
          throw new Error("upstream 503");
        },
      },
      model: "reviewer-model-x",
    };
    const executor = createAdvisorExecutor({ transcriptSource: { getEntries: () => [] }, resolveReviewer: () => reviewer });
    const result = await executor.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("upstream 503");
  });

  test("provider.generate timing out never blocks the turn -- the executor's own promise still resolves (never hangs)", async () => {
    const reviewer: ResolvedReviewer = {
      provider: {
        async generate() {
          throw new Error("timeout");
        },
      },
      model: "reviewer-model-x",
    };
    const executor = createAdvisorExecutor({ transcriptSource: { getEntries: () => [] }, resolveReviewer: () => reviewer });
    await expect(executor.execute({}, makeCtx())).resolves.toMatchObject({ isError: true });
  });

  test("a non-text ProviderTurn (tool_use) -> ordinary tool error, since advisor has no tool-execution loop", async () => {
    const reviewer: ResolvedReviewer = {
      provider: {
        async generate() {
          return { kind: "tool_use", calls: [{ id: "1", name: "Bash", input: {} }] } satisfies ProviderTurn;
        },
      },
      model: "reviewer-model-x",
    };
    const executor = createAdvisorExecutor({ transcriptSource: { getEntries: () => [] }, resolveReviewer: () => reviewer });
    const result = await executor.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("non-text");
  });

  test("input is ignored entirely (schema is `{}`) -- never validated, never inspected", async () => {
    const reviewer: ResolvedReviewer = { provider: textProvider("fine"), model: "m" };
    const executor = createAdvisorExecutor({ transcriptSource: { getEntries: () => [] }, resolveReviewer: () => reviewer });
    const withExtra = await executor.execute({ anything: "goes" }, makeCtx());
    expect(withExtra.isError).toBeUndefined();
    const withUndefined = await executor.execute(undefined, makeCtx());
    expect(withUndefined.isError).toBeUndefined();
  });
});

describe("assembleReviewerMessages (the transcript assembler)", () => {
  test("maps entries straight through to ProviderMessage[] when well under the budget", () => {
    const entries: TranscriptEntry[] = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ];
    const { messages, truncated } = assembleReviewerMessages(entries, 1000);
    expect(truncated).toBe(false);
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  test("RULING R3-3: a line mentioning an opaque marker key is stripped, case-insensitively", () => {
    const entries: TranscriptEntry[] = [
      { role: "assistant", text: "plain line one\nencrypted_content: abc123\nplain line two" },
      { role: "user", text: "SIGNATURE=deadbeef\nsafe text" },
      { role: "tool", text: "REASONING_ITEM payload here\nsafe tool output" },
    ];
    const { messages } = assembleReviewerMessages(entries, 100_000);
    expect(messages[0]?.content).toBe("plain line one\nplain line two");
    expect(messages[1]?.content).toBe("safe text");
    expect(messages[2]?.content).toBe("safe tool output");
    for (const m of messages) {
      const text = typeof m.content === "string" ? m.content : "";
      expect(text.toLowerCase()).not.toContain("encrypted_content");
      expect(text.toLowerCase()).not.toContain("signature");
      expect(text.toLowerCase()).not.toContain("reasoning_item");
    }
  });

  test("keeps the TAIL when the transcript exceeds maxChars, and reports truncated: true", () => {
    const entries: TranscriptEntry[] = [
      { role: "user", text: "a".repeat(50) },
      { role: "assistant", text: "b".repeat(50) },
      { role: "user", text: "c".repeat(50) },
    ];
    // Budget only fits the last two entries (100 chars).
    const { messages, truncated } = assembleReviewerMessages(entries, 100);
    expect(truncated).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe("b".repeat(50));
    expect(messages[1]?.content).toBe("c".repeat(50));
  });

  test("a single entry alone larger than maxChars is kept clipped rather than dropped entirely", () => {
    const entries: TranscriptEntry[] = [{ role: "user", text: "x".repeat(500) }];
    const { messages, truncated } = assembleReviewerMessages(entries, 100);
    expect(truncated).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toHaveLength(100);
    // The clip keeps the END of the oversized entry (tail-preference applies within an entry too).
    expect(messages[0]?.content).toBe("x".repeat(100));
  });

  test("an empty transcript assembles to an empty, non-truncated message list", () => {
    const { messages, truncated } = assembleReviewerMessages([], 1000);
    expect(messages).toEqual([]);
    expect(truncated).toBe(false);
  });

  test("truncated: true propagates end-to-end through createAdvisorExecutor's JSON result", async () => {
    const reviewer: ResolvedReviewer = { provider: textProvider("ok"), model: "m" };
    const bigEntries: TranscriptEntry[] = [
      { role: "user", text: "a".repeat(50) },
      { role: "assistant", text: "b".repeat(50) },
    ];
    const executor = createAdvisorExecutor({ transcriptSource: { getEntries: () => bigEntries }, resolveReviewer: () => reviewer, maxChars: 10 });
    const result = await executor.execute({}, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.truncated).toBe(true);
  });
});

// ================================================================================================
// P7a LANE B (D29/D30): the advisor with a REAL reviewer behind it.
//
// Everything above ran against hand-built `ResolvedReviewer`s, which is all P3 had: `engine.ts`
// passed `resolveReviewer: () => undefined`, so the tool answered "no reviewer" in every real
// session no matter how the catalog was configured. These tests drive the ENGINE's own wiring — a
// resolver on `EngineOptions`, the run's own `messages` as the transcript — and assert the two
// things the wire contract names: the result reports the reviewer's CATALOG KEY, and the transcript
// that reaches the reviewer carries no provider-opaque state.
// ================================================================================================
describe("P7a: the engine's advisor wiring (D29/D30)", () => {
  /** Records exactly what the reviewer was asked, so the transcript claim is about the wire and not about intent. */
  function recordingReviewer(model: string): { reviewer: ResolvedReviewer; seen: ProviderMessage[][] } {
    const seen: ProviderMessage[][] = [];
    return {
      seen,
      reviewer: {
        model,
        provider: {
          async generate(input) {
            seen.push(input.messages as ProviderMessage[]);
            return { kind: "text", text: "the reviewer's advice" } satisfies ProviderTurn;
          },
        },
      },
    };
  }

  /** Runs one turn on a scripted provider, with the advisor's reviewer wired the way production wires it. */
  async function runWith(opts: { resolveReviewer?: (currentModelKey?: string) => ResolvedReviewer | undefined; capabilities?: string[]; assistantText?: string }): Promise<{ tools: string[] }> {
    const { host, runtime } = createInMemoryChannel();
    let turns = 0;
    const done = runEngine({
      config: {
        sessionId: "advisor-p7a",
        cwd: process.cwd(),
        model: "winter-test/echo",
        ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
      } as RuntimeConfig,
      input: runtime.input,
      output: runtime.output,
      provider: {
        async generate() {
          turns += 1;
          return { kind: "text", text: opts.assistantText ?? `turn ${turns}` } satisfies ProviderTurn;
        },
      },
      ...(opts.resolveReviewer !== undefined ? { resolveReviewer: opts.resolveReviewer } : {}),
    });
    host.output.write({ type: "user", text: "please review the plan" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    const frames: unknown[] = [];
    for await (const f of host.input) frames.push(f);
    await done;
    const init = frames.find((f) => (f as { type?: string }).type === "init") as { tools: string[] } | undefined;
    return { tools: init?.tools ?? [] };
  }

  test("WS-06 §4's availability predicate: `advisor` is advertised because a reviewer RESOLVES, with no host capability supplied", async () => {
    const { reviewer } = recordingReviewer("openai/gpt-6-astra");
    const withReviewer = await runWith({ resolveReviewer: () => reviewer });
    expect(withReviewer.tools).toContain(ADVISOR_TOOL_NAME);
    // The negative control, same session shape: a resolver that answers `undefined` is a session
    // with no reviewer, and the tool is not advertised. (This is the state EVERY session was in
    // before P7a, because `engine.ts` hardcoded exactly this resolver.)
    const withoutReviewer = await runWith({ resolveReviewer: () => undefined });
    expect(withoutReviewer.tools).not.toContain(ADVISOR_TOOL_NAME);
  });

  test("the tool's result carries the REVIEWER'S CATALOG KEY, and the advice the reviewer actually returned", async () => {
    const { reviewer } = recordingReviewer("codex-oauth/gpt-6-astra");
    await runWith({ resolveReviewer: () => reviewer });
    // The executor the run installed is the one the model would have called.
    const result = await getRegisteredTool(ADVISOR_TOOL_NAME)!.executor!.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ advice: "the reviewer's advice", model: "codex-oauth/gpt-6-astra" });
  });

  test("the transcript that REACHES the reviewer is this run's own history, and carries no provider-opaque state", async () => {
    const { reviewer, seen } = recordingReviewer("openai/gpt-6-astra");
    // The assistant turn carries text shaped like the three opaque keys. WS-06 §4 / RULING R3-3: a
    // review channel must never forward them, and the engine's own `messages` is where they would
    // arrive from if a provider ever inlined one as literal text.
    await runWith({
      resolveReviewer: () => reviewer,
      assistantText: "here is my plan\nencrypted_content: AAAA-OPAQUE-BBBB\nreasoning_item: {\"itemJson\":\"...\"}\nsignature: sig-abc\nand that is the plan",
    });
    await getRegisteredTool(ADVISOR_TOOL_NAME)!.executor!.execute({}, makeCtx());
    expect(seen).toHaveLength(1);
    const wire = JSON.stringify(seen[0]);
    // The run's real history reached the reviewer...
    expect(wire).toContain("please review the plan");
    expect(wire).toContain("here is my plan");
    // ...with every opaque-shaped line dropped, key AND value.
    expect(wire).not.toContain("encrypted_content");
    expect(wire).not.toContain("AAAA-OPAQUE-BBBB");
    expect(wire).not.toContain("reasoning_item");
    expect(wire).not.toContain("signature");
    expect(wire).not.toContain("sig-abc");
  });

  test("the reviewer is asked with the session's LIVE model key, not a value captured at wiring time", async () => {
    const asked: Array<string | undefined> = [];
    const { reviewer } = recordingReviewer("openai/gpt-6-astra");
    await runWith({
      resolveReviewer: (currentModelKey) => {
        asked.push(currentModelKey);
        return reviewer;
      },
    });
    await getRegisteredTool(ADVISOR_TOOL_NAME)!.executor!.execute({}, makeCtx());
    // Asked at least twice — once for the capability, once for the call — and always with a key.
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.every((k) => k === "winter-test/echo")).toBe(true);
  });
});
