// The web tools' shared inner-model helper. Every claim in its header is a test here: the forced
// first call, the N-call bound, the transcript order, abort, no stated-model fallback -- and the two
// things the advisor's inner call never did: the signal reaches the provider, and the usage reaches
// the turn's accounting (proved against the REAL engine at the bottom of this file).
import { afterEach, describe, expect, test } from "bun:test";
import type { WinterFrame, ProtocolSdkMessage as SdkMessage, RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { WinterProviderResolutionError } from "@yanlinglabs/winter-provider-runtime";
import { INNER_TOOL_LIMIT_NOTICE, runInnerModel, type InnerModelRuntime, type InnerToolSpec } from "./_inner-model.ts";
import { ProviderTurnError, createContextAccountant, runEngine, type Provider, type ProviderRequest, type ProviderTurn, type ProviderUsage } from "../../engine.ts";
import { registerTool, unregisterToolForTest, type ToolExecutionContext } from "../registry.ts";
import { scriptedProvider } from "../../provider/mock.ts";
import { createInMemoryChannel } from "../../protocol/channel.ts";
import { getWebSessionRuntime, resetWebSessionRuntimesForTest } from "../../web/session-runtime.ts";

const SEARCH_TOOL: InnerToolSpec = { name: "web_search", description: "search the web", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };
const USAGE: ProviderUsage = { inputTokens: 100, outputTokens: 10 };

/** A provider that replays `turns` (the last one forever) and records every request it was sent. */
function recordingProvider(turns: ProviderTurn[]): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    async generate(input) {
      requests.push(input);
      return turns[Math.min(requests.length - 1, turns.length - 1)]!;
    },
  };
}

function runtimeOver(provider: Provider, over: Partial<InnerModelRuntime> = {}): InnerModelRuntime & { accounted: Array<{ key: string | undefined; usage: ProviderUsage }> } {
  const accounted: Array<{ key: string | undefined; usage: ProviderUsage }> = [];
  return {
    accounted,
    sessionModel: () => ({ provider, model: "prova/session-model" }),
    accountUsage: (key, usage) => void accounted.push({ key, usage }),
    ...over,
  };
}

const CTX = { sessionId: "inner-model-test" };
const call = (id: string, query: string): { id: string; name: string; input: unknown } => ({ id, name: "web_search", input: { query } });

afterEach(() => resetWebSessionRuntimesForTest());

describe("runInnerModel -- the single-shot shape (WebFetch's digest)", () => {
  test("one generation, no tools, no sink, thinking disabled, on the SESSION's own model; usage accounted under that model", async () => {
    const provider = recordingProvider([{ kind: "text", text: "the digest", usage: USAGE }]);
    const runtime = runtimeOver(provider);
    const controller = new AbortController();
    const result = await runInnerModel({ ...CTX, signal: controller.signal }, { prompt: "Web page content:\n---\n…\n---\nsummarise" }, runtime);
    expect(result).toMatchObject({ ok: true, text: "the digest", toolCalls: 0, stoppedBy: "answer", modelKey: "prova/session-model", usage: USAGE });
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    expect(request.messages).toEqual([{ role: "user", content: "Web page content:\n---\n…\n---\nsummarise" }]);
    expect(request.model).toBe("prova/session-model");
    expect(request.thinking).toEqual({ type: "disabled" });
    // THE ABORT SIGNAL IS ON THE REQUEST -- the advisor's inner call never passed one.
    expect(request.signal).toBe(controller.signal);
    expect("tools" in request).toBe(false);
    expect("toolChoice" in request).toBe(false);
    // No `sink` key at all: an auxiliary generation streams nothing (and `"sink" in req` is how a consumer tells).
    expect("sink" in request).toBe(false);
    // An absent system prompt is OMITTED, never sent as "".
    expect("system" in request).toBe(false);
    expect(runtime.accounted).toEqual([{ key: "prova/session-model", usage: USAGE }]);
  });

  test("a system prompt rides the request; a provider that reports no usage accounts nothing (never an invented zero)", async () => {
    const provider = recordingProvider([{ kind: "text", text: "ok" }]);
    const runtime = runtimeOver(provider);
    const result = await runInnerModel(CTX, { prompt: "p", system: "You are an assistant for performing a web search tool use" }, runtime);
    expect(result.ok).toBe(true);
    expect(provider.requests[0]!.system).toBe("You are an assistant for performing a web search tool use");
    expect(runtime.accounted).toEqual([]);
  });
});

describe("runInnerModel -- the bounded tool loop (WebSearch's inner pass)", () => {
  test("ROUND 1 CARRIES THE FORCED toolChoice; later rounds are `auto`; the transcript is in stream order", async () => {
    const provider = recordingProvider([
      { kind: "tool_use", text: "Let me look that up.", calls: [call("c1", "bun 1.4 release notes")], usage: USAGE },
      { kind: "tool_use", calls: [call("c2", "bun 1.4.2 changelog")], usage: USAGE },
      { kind: "text", text: "Bun 1.4.2 fixed two regressions.", usage: USAGE },
    ]);
    const runtime = runtimeOver(provider);
    const seen: Array<{ input: unknown; index: number; toolUseId: string }> = [];
    const result = await runInnerModel(
      CTX,
      {
        prompt: "Perform a web search for the query: bun release notes",
        tool: SEARCH_TOOL,
        maxToolCalls: 8,
        handler: async (input, info) => {
          seen.push({ input, index: info.index, toolUseId: info.toolUseId });
          return { output: `results for #${info.index}` };
        },
      },
      runtime,
    );
    if (!result.ok) throw new Error(result.message);

    // The forced first call is the whole point: the model cannot answer from memory on round 1.
    expect(provider.requests.map((r) => r.toolChoice)).toEqual([{ type: "tool", name: "web_search" }, { type: "auto" }, { type: "auto" }]);
    for (const r of provider.requests) expect(r.tools).toEqual([SEARCH_TOOL]);

    expect(seen).toEqual([
      { input: { query: "bun 1.4 release notes" }, index: 1, toolUseId: "c1" },
      { input: { query: "bun 1.4.2 changelog" }, index: 2, toolUseId: "c2" },
    ]);
    expect(result.steps).toEqual([
      { kind: "text", text: "Let me look that up." },
      { kind: "tool_call", toolUseId: "c1", input: { query: "bun 1.4 release notes" }, output: "results for #1", isError: false, executed: true },
      { kind: "tool_call", toolUseId: "c2", input: { query: "bun 1.4.2 changelog" }, output: "results for #2", isError: false, executed: true },
      { kind: "text", text: "Bun 1.4.2 fixed two regressions." },
    ]);
    expect(result).toMatchObject({ toolCalls: 2, stoppedBy: "answer", text: "Let me look that up.\n\nBun 1.4.2 fixed two regressions." });

    // The history the model is shown on round 2 is the engine's own shape: an assistant message with
    // the leading text and the tool_use, then a `tool` message carrying the matching tool_result.
    expect(provider.requests[1]!.messages.slice(1)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Let me look that up." }, { type: "tool_use", id: "c1", name: "web_search", input: { query: "bun 1.4 release notes" } }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "results for #1" }] },
    ]);
    // EVERY generation was accounted, as it happened.
    expect(runtime.accounted).toHaveLength(3);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
  });

  test("THE N-CALL BOUND: calls beyond it never reach the handler (parallel calls count one each), the model gets ONE closing generation, then the loop stops", async () => {
    // A model that never stops searching: two calls per turn, forever.
    let n = 0;
    const provider: Provider & { requests: ProviderRequest[] } = {
      requests: [],
      async generate(input) {
        this.requests.push(input);
        n += 1;
        return { kind: "tool_use", calls: [call(`c${n}a`, `q${n}a`), call(`c${n}b`, `q${n}b`)], usage: USAGE };
      },
    };
    const handled: string[] = [];
    const result = await runInnerModel(
      CTX,
      { prompt: "p", tool: SEARCH_TOOL, maxToolCalls: 3, handler: async (_input, info) => (handled.push(info.toolUseId), { output: "r" }) },
      runtimeOver(provider),
    );
    if (!result.ok) throw new Error(result.message);
    expect(handled).toEqual(["c1a", "c1b", "c2a"]);
    expect(result.toolCalls).toBe(3);
    expect(result.stoppedBy).toBe("tool-call-limit");
    // Round 2's SECOND call crossed the bound: answered with the notice, never executed.
    expect(result.steps.at(-1)).toEqual({ kind: "tool_call", toolUseId: "c2b", input: { query: "q2b" }, output: INNER_TOOL_LIMIT_NOTICE, isError: true, executed: false });
    // Exactly ONE closing generation after the bound (3 requests total), and it was told why.
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]!.messages.at(-1)).toEqual({
      role: "tool",
      content: [
        { type: "tool_result", tool_use_id: "c2a", content: "r" },
        { type: "tool_result", tool_use_id: "c2b", content: INNER_TOOL_LIMIT_NOTICE, is_error: true },
      ],
    });
  });

  // --- THE GENERATION BOUND ------------------------------------------------------------------------
  //
  // `maxToolCalls` bounds HANDLER calls, and a handler call happens only for a correctly-named call.
  // A model that never names the tool correctly therefore never advances that counter -- so the loop
  // needs its own bound on GENERATIONS, each of which is real, accounted spend. The N-bound test
  // above cannot see this: its fake always names the right tool.
  test("a model that names an UNKNOWN tool every round is stopped by the GENERATION cap (maxToolCalls + 2), not left to run", async () => {
    let n = 0;
    const provider: Provider & { requests: ProviderRequest[] } = {
      requests: [],
      async generate(input) {
        this.requests.push(input);
        if (this.requests.length > 40) throw new Error("runaway: the loop has no bound on generations");
        n += 1;
        return { kind: "tool_use", calls: [{ id: `x${n}`, name: "Bash", input: { command: "ls" } }], usage: USAGE };
      },
    };
    const runtime = runtimeOver(provider);
    let handled = 0;
    const result = await runInnerModel(CTX, { prompt: "p", tool: SEARCH_TOOL, maxToolCalls: 2, handler: async () => (handled++, { output: "r" }) }, runtime);
    expect(result).toMatchObject({ ok: true, stoppedBy: "tool-call-limit", toolCalls: 0 });
    expect(handled).toBe(0);
    expect(provider.requests).toHaveLength(4);
    expect(runtime.accounted).toHaveLength(4);
  });

  test("a tool-call turn with an EMPTY calls array is terminal -- there is nothing to answer and nothing to wait for", async () => {
    const provider = recordingProvider([{ kind: "tool_use", text: "I have nothing to look up.", calls: [], usage: USAGE }]);
    const result = await runInnerModel(CTX, { prompt: "p", tool: SEARCH_TOOL, maxToolCalls: 2, handler: async () => ({ output: "r" }) }, runtimeOver(provider));
    expect(result).toMatchObject({ ok: true, stoppedBy: "answer", toolCalls: 0, text: "I have nothing to look up." });
    expect(provider.requests).toHaveLength(1);
  });

  test("MIXED: unknown names, empty turns and real calls interleaved still end within the generation cap", async () => {
    let n = 0;
    const provider: Provider & { requests: ProviderRequest[] } = {
      requests: [],
      async generate(input) {
        this.requests.push(input);
        if (this.requests.length > 40) throw new Error("runaway: the loop has no bound on generations");
        n += 1;
        // real, unknown, real(limit reached), then unknown forever
        if (n === 1) return { kind: "tool_use", calls: [call("c1", "a")], usage: USAGE };
        if (n === 3) return { kind: "tool_use", calls: [call("c3", "b")], usage: USAGE };
        return { kind: "tool_use", calls: [{ id: `x${n}`, name: "nope", input: {} }], usage: USAGE };
      },
    };
    const handled: string[] = [];
    const result = await runInnerModel(CTX, { prompt: "p", tool: SEARCH_TOOL, maxToolCalls: 2, handler: async (_i, info) => (handled.push(info.toolUseId), { output: "r" }) }, runtimeOver(provider));
    expect(result).toMatchObject({ ok: true, stoppedBy: "tool-call-limit", toolCalls: 2 });
    expect(handled).toEqual(["c1", "c3"]);
    // c1, unknown, c3 (limit) -> ONE closing generation -> stop. Never more than maxToolCalls + 2.
    expect(provider.requests).toHaveLength(4);
  });

  test("the session's BUDGET is checked between rounds: an inner pass cannot spend past `maxBudgetUsd` on its own", async () => {
    const provider = recordingProvider([{ kind: "tool_use", calls: [call("c1", "a")], usage: USAGE }, { kind: "tool_use", calls: [call("c2", "b")], usage: USAGE }, { kind: "text", text: "never reached" }]);
    let generations = 0;
    const runtime = { ...runtimeOver(provider), budgetExceeded: () => generations >= 1 };
    runtime.accountUsage = () => void generations++;
    const result = await runInnerModel(CTX, { prompt: "p", tool: SEARCH_TOOL, maxToolCalls: 8, handler: async () => ({ output: "r" }) }, runtime);
    expect(result).toMatchObject({ ok: false, code: "aborted", detail: "budget-exceeded", toolCalls: 1 });
    expect(provider.requests).toHaveLength(1);
  });

  test("a call to a tool that was never offered, a handler error and a handler THROW are all results to the inner model -- none ends the pass", async () => {
    const provider = recordingProvider([
      { kind: "tool_use", calls: [{ id: "x1", name: "Bash", input: { command: "ls" } }, call("c1", "a"), call("c2", "b")] },
      { kind: "text", text: "done" },
    ]);
    const result = await runInnerModel(
      CTX,
      {
        prompt: "p",
        tool: SEARCH_TOOL,
        maxToolCalls: 8,
        handler: async (_input, info) => {
          if (info.index === 1) return { output: "quota exhausted, add a key", isError: true };
          throw new Error("SECRET-IN-A-HANDLER-MESSAGE");
        },
      },
      runtimeOver(provider),
    );
    if (!result.ok) throw new Error(result.message);
    const calls = result.steps.filter((s) => s.kind === "tool_call");
    expect(calls.map((s) => (s.kind === "tool_call" ? [s.toolUseId, s.isError, s.executed] : []))).toEqual([["x1", true, false], ["c1", true, true], ["c2", true, true]]);
    expect(JSON.stringify(result)).not.toContain("SECRET-IN-A-HANDLER-MESSAGE");
    expect(result.toolCalls).toBe(2);
  });

  test("ABORT MID-LOOP: the handler observes the signal, the pass ends `aborted`, no further generation is made, and what ran is still reported", async () => {
    const controller = new AbortController();
    const provider = recordingProvider([{ kind: "tool_use", calls: [call("c1", "a")], usage: USAGE }, { kind: "text", text: "never reached" }]);
    const runtime = runtimeOver(provider);
    let handlerSawSignal: AbortSignal | undefined;
    const result = await runInnerModel(
      { ...CTX, signal: controller.signal },
      {
        prompt: "p",
        tool: SEARCH_TOOL,
        maxToolCalls: 8,
        handler: (_input, info) => {
          handlerSawSignal = info.signal;
          controller.abort();
          // A handler that never settles: the RACE, not the handler's cooperation, ends the pass.
          return new Promise(() => {});
        },
      },
      runtime,
    );
    expect(handlerSawSignal).toBe(controller.signal);
    expect(result).toMatchObject({ ok: false, code: "aborted", toolCalls: 1 });
    expect(provider.requests).toHaveLength(1);
    // Round 1 was paid for, so it was accounted even though the pass did not finish.
    expect(runtime.accounted).toEqual([{ key: "prova/session-model", usage: USAGE }]);
  });

  test("a provider that IGNORES the signal still cannot hold an interrupted turn; an already-aborted turn makes no request at all", async () => {
    const controller = new AbortController();
    const hanging: Provider = { generate: () => new Promise(() => {}) };
    const pending = runInnerModel({ ...CTX, signal: controller.signal }, { prompt: "p" }, runtimeOver(hanging));
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: "aborted" });

    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    expect(await runInnerModel({ ...CTX, signal: controller.signal }, { prompt: "p" }, runtimeOver(provider))).toMatchObject({ ok: false, code: "aborted" });
    expect(provider.requests).toHaveLength(0);
  });
});

describe("runInnerModel -- a STATED model", () => {
  test("resolves through `resolveAuxiliaryModel` with the route's own authRef; the request names NO model; usage is accounted under the RESOLVED key", async () => {
    const session = recordingProvider([{ kind: "text", text: "from the session model" }]);
    const digest = recordingProvider([{ kind: "text", text: "from the digest model", usage: USAGE }]);
    const asked: Array<{ tag: string; opts: unknown }> = [];
    const runtime = runtimeOver(session, { resolveAuxiliaryModel: (tag, opts) => (asked.push({ tag, opts }), { ok: true, provider: digest, modelKey: "provb/small" }) });
    const result = await runInnerModel(CTX, { prompt: "p", model: { kind: "tag", tag: "small", authRef: { kind: "env", name: "WINTER_TEST_DIGEST" } } }, runtime);
    expect(result).toMatchObject({ ok: true, text: "from the digest model", modelKey: "provb/small" });
    expect(asked).toEqual([{ tag: "small", opts: { authRef: { kind: "env", name: "WINTER_TEST_DIGEST" } } }]);
    expect(session.requests).toHaveLength(0);
    expect("model" in digest.requests[0]!).toBe(false);
    expect(runtime.accounted).toEqual([{ key: "provb/small", usage: USAGE }]);
  });

  test("an UNRESOLVABLE stated model is a typed failure -- NEVER a silent fallback onto the session's model", async () => {
    const session = recordingProvider([{ kind: "text", text: "must not be used" }]);
    const refused = await runInnerModel(CTX, { prompt: "p", model: { kind: "tag", tag: "nope/none" } }, runtimeOver(session, { resolveAuxiliaryModel: () => ({ ok: false, code: "unknown-model", message: "no such row" }) }));
    expect(refused).toMatchObject({ ok: false, code: "model-unresolvable", detail: "unknown-model" });
    // ...and the same when the session has no catalog to resolve against at all.
    const noCatalog = await runInnerModel(CTX, { prompt: "p", model: { kind: "tag", tag: "nope/none" } }, runtimeOver(session));
    expect(noCatalog).toMatchObject({ ok: false, code: "model-unresolvable", detail: "no-catalog" });
    expect(session.requests).toHaveLength(0);
  });

  test("a resolver (or `sessionModel`) that THROWS is a value too -- and only the error's NAME is exposed, never its message", async () => {
    const session = recordingProvider([{ kind: "text", text: "must not be used" }]);
    const throwing = runtimeOver(session, {
      resolveAuxiliaryModel: () => {
        throw new RangeError("boom sk-secret-IN-A-RESOLVER-MESSAGE");
      },
    });
    const viaTag = await runInnerModel(CTX, { prompt: "p", model: { kind: "tag", tag: "provb/small" } }, throwing);
    expect(viaTag).toMatchObject({ ok: false, code: "model-unresolvable" });
    expect(JSON.stringify(viaTag)).toContain("RangeError");
    expect(JSON.stringify(viaTag)).not.toContain("sk-secret");
    expect(session.requests).toHaveLength(0);

    const brokenSession = runtimeOver(session, {
      sessionModel: () => {
        throw new TypeError("boom sk-secret-IN-A-SESSION-MODEL-MESSAGE");
      },
    });
    const viaSession = await runInnerModel(CTX, { prompt: "p" }, brokenSession);
    expect(viaSession).toMatchObject({ ok: false, code: "model-unresolvable" });
    expect(JSON.stringify(viaSession)).not.toContain("sk-secret");
  });

  test("a missing credential and a provider failure are VALUES with their own codes", async () => {
    const noCredential: Provider = {
      async generate() {
        throw new WinterProviderResolutionError("no-credential-for-provider", 'no credential is configured for provider "provb"');
      },
    };
    expect(await runInnerModel(CTX, { prompt: "p" }, runtimeOver(noCredential))).toMatchObject({ ok: false, code: "no-credential", detail: "no-credential-for-provider" });

    const failing: Provider = {
      async generate() {
        throw new ProviderTurnError("rate limited", { status: 429, code: "rate_limit" });
      },
    };
    const failed = await runInnerModel(CTX, { prompt: "p" }, runtimeOver(failing));
    expect(failed).toMatchObject({ ok: false, code: "provider-error", detail: "rate_limit" });
    if (failed.ok) throw new Error("unreachable");
    expect(failed.message).toContain("HTTP 429");

    // An arbitrary throw contributes its NAME only -- its message is not vetted for material.
    const odd: Provider = {
      async generate() {
        throw new TypeError("token=SECRET-IN-AN-UNVETTED-MESSAGE");
      },
    };
    expect(JSON.stringify(await runInnerModel(CTX, { prompt: "p" }, runtimeOver(odd)))).not.toContain("SECRET-IN-AN-UNVETTED-MESSAGE");
  });
});

describe("runInnerModel -- wiring and misuse are values too", () => {
  test("no registered session runtime -> `not-wired`; a tool with no handler/bound -> `invalid-request`", async () => {
    expect(await runInnerModel({ sessionId: "nobody-registered-this" }, { prompt: "p" })).toMatchObject({ ok: false, code: "not-wired" });
    expect(await runInnerModel(CTX, { prompt: "p", tool: SEARCH_TOOL }, runtimeOver(recordingProvider([{ kind: "text", text: "x" }])))).toMatchObject({ ok: false, code: "invalid-request" });
  });
});

// --- THE REAL ENGINE: inner usage lands in the TURN's usage ----------------------------------------
//
// The claim the advisor's inner call cannot make. A probe tool runs an inner pass from inside a real
// `runEngine` round; ground truth is the RESULT FRAME (`total_cost_usd`, `modelUsage`) and the
// session's accountant -- not the helper's own bookkeeping.
describe("inner generations are accounted into the turn exactly as a main-loop generation is -- and are never counted as context", () => {
  const PROBE = "InnerModelUsageProbe";
  afterEach(() => unregisterToolForTest(PROBE));

  test("same-model and stated-model inner passes reach `modelUsage`/`total_cost_usd` under their OWN keys, add to spend, and leave the context reading alone", async () => {
    const digest = recordingProvider([{ kind: "text", text: "digested", usage: { inputTokens: 7000, outputTokens: 70 } }]);
    const innerSignals: Array<AbortSignal | undefined> = [];
    registerTool({
      descriptor: { canonicalName: PROBE, advertisedName: PROBE, source: "builtin", inputSchema: { type: "object" }, description: "runs two inner passes", exposure: "eager", permissionClass: "read", availability: {}, capabilityRequirements: [], disposition: "implement-now" },
      executor: {
        async execute(_input: unknown, ctx: ToolExecutionContext) {
          innerSignals.push(ctx.signal);
          const own = await runInnerModel(ctx, { prompt: "on the session's own model" });
          const stated = await runInnerModel(ctx, { prompt: "on the digest model", model: { kind: "tag", tag: "provb/small" } });
          return { output: JSON.stringify({ own: own.ok ? own.text : own.code, stated: stated.ok ? stated.text : stated.code }) };
        },
      },
    });

    // ONE scripted provider serves the main loop AND the same-model inner pass, in call order:
    // main round 1 (calls the probe) -> the inner pass -> main round 2 (the answer).
    const main = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "t1", name: PROBE, input: {} }], usage: { inputTokens: 1000, outputTokens: 10 } },
      { kind: "text", text: "inner answer", usage: { inputTokens: 500, outputTokens: 5 } },
      { kind: "text", text: "final", usage: { inputTokens: 1200, outputTokens: 12 } },
    ]);
    const accountant = createContextAccountant({ limit: 200_000 });
    const priced: Array<{ key: string; usage: ProviderUsage }> = [];
    const { host, runtime } = createInMemoryChannel();
    let registeredDuringRun = false;
    const done = runEngine({
      config: { sessionId: "inner-usage-e2e", cwd: process.cwd(), model: "prova/main", persistSession: false, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } as RuntimeConfig,
      input: runtime.input,
      output: runtime.output,
      provider: main,
      contextAccountant: accountant,
      // $1 per token either way, so a cost IS a token count and the arithmetic below is exact.
      priceUsage: (key, usage) => (priced.push({ key, usage }), { costUsd: usage.inputTokens + usage.outputTokens, costBasis: "list", canonicalModel: key }),
      resolveAuxiliaryModel: (tag) => {
        registeredDuringRun = getWebSessionRuntime("inner-usage-e2e") !== undefined;
        return tag === "provb/small" ? { ok: true, provider: digest, modelKey: "provb/small" } : { ok: false, code: "unknown-model", message: "no such row" };
      },
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const frames: WinterFrame[] = [];
    for await (const f of host.input) frames.push(f);
    await done;

    const messages = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
    const result = messages.filter((m) => m.type === "result").at(-1) as unknown as Record<string, unknown>;
    expect(result.subtype).toBe("success");
    const modelUsage = result.modelUsage as Record<string, Record<string, number>>;
    // The session-model row is main(1000+1200) + INNER(500); the digest has its OWN row.
    expect(modelUsage["prova/main"]).toMatchObject({ inputTokens: 2700, outputTokens: 27, costUSD: 2727 });
    expect(modelUsage["provb/small"]).toMatchObject({ inputTokens: 7000, outputTokens: 70, costUSD: 7070, canonicalModel: "provb/small" });
    expect(result.total_cost_usd).toBe(2727 + 7070);
    expect(priced.map((p) => p.key)).toEqual(["prova/main", "prova/main", "provb/small", "prova/main"]);

    // SPEND includes both inner passes; the CONTEXT reading is the last MAIN-LOOP generation's alone
    // (1200 + 12) -- an inner prompt is never part of the session's next request, so a 7,000-token
    // digest must not push the session toward compaction.
    expect(accountant.spentTokens()).toBe(1010 + 505 + 7070 + 1212);
    expect(accountant.contextTokens()).toBe(1212);

    // The executor was handed the turn's abort signal, which is what the inner requests carried.
    expect(innerSignals[0]).toBeInstanceOf(AbortSignal);
    expect(digest.requests[0]!.signal).toBe(innerSignals[0]);
    // Registered for the run, and withdrawn at teardown (one leaked entry per run otherwise).
    expect(registeredDuringRun).toBe(true);
    expect(getWebSessionRuntime("inner-usage-e2e")).toBeUndefined();
  });

  test("`maxBudgetUsd` binds an inner pass on the REAL engine: the generation that would follow a crossed ceiling never goes out", async () => {
    let probeOutput = "";
    registerTool({
      descriptor: { canonicalName: PROBE, advertisedName: PROBE, source: "builtin", inputSchema: { type: "object" }, description: "runs an inner tool loop", exposure: "eager", permissionClass: "read", availability: {}, capabilityRequirements: [], disposition: "implement-now" },
      executor: {
        async execute(_input: unknown, ctx: ToolExecutionContext) {
          const inner = await runInnerModel(ctx, { prompt: "search", tool: SEARCH_TOOL, maxToolCalls: 8, handler: async () => ({ output: "r" }) });
          probeOutput = JSON.stringify({ ok: inner.ok, code: inner.ok ? undefined : inner.code, detail: inner.ok ? undefined : inner.detail, toolCalls: inner.toolCalls });
          return { output: probeOutput };
        },
      },
    });
    // main round 1 (1010) -> inner generation 1 (505): the total, 1515, crosses the 1500 ceiling, so
    // inner generation 2 must never be requested. A model that would happily search forever.
    const requests: ProviderRequest[] = [];
    const script: ProviderTurn[] = [
      { kind: "tool_use", calls: [{ id: "t1", name: PROBE, input: {} }], usage: { inputTokens: 1000, outputTokens: 10 } },
      { kind: "tool_use", calls: [call("c1", "a")], usage: { inputTokens: 500, outputTokens: 5 } },
      { kind: "tool_use", calls: [call("c2", "b")], usage: { inputTokens: 500, outputTokens: 5 } },
    ];
    const main: Provider = {
      async generate(input) {
        requests.push(input);
        return script[Math.min(requests.length - 1, script.length - 1)]!;
      },
    };
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: { sessionId: "inner-budget-e2e", cwd: process.cwd(), model: "prova/main", persistSession: false, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, maxBudgetUsd: 1500 } as RuntimeConfig,
      input: runtime.input,
      output: runtime.output,
      provider: main,
      priceUsage: (key, usage) => ({ costUsd: usage.inputTokens + usage.outputTokens, costBasis: "list", canonicalModel: key }),
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const frames: WinterFrame[] = [];
    for await (const f of host.input) frames.push(f);
    await done;
    expect(JSON.parse(probeOutput)).toEqual({ ok: false, code: "aborted", detail: "budget-exceeded", toolCalls: 1 });
    // Exactly two generations went out: the main loop's, and the ONE inner generation that crossed.
    expect(requests).toHaveLength(2);
    const result = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message).filter((m) => m.type === "result").at(-1) as unknown as Record<string, unknown>;
    expect(result.subtype).toBe("error_max_budget_usd");
    expect(result.total_cost_usd).toBe(1515);
  });
});
