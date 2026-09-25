// WS-23: the Anthropic path under CODE-MODE conditions, end to end -- the REAL Anthropic adapter
// (resolved through `buildSessionProvider` from the compiled catalog's own Claude rows) driven by the
// REAL `runEngine` against a loopback fake. What each case asserts is what a provider was actually
// SENT (`fake.requests`) and what the transcript was actually GIVEN (the store's `recordAssistantEntry`),
// because neither is visible from a unit test of any one layer: the fold, the engine's assembly, the
// wire serializer and the history renderer all touch the same blocks on the way through.
import { describe, expect, test } from "bun:test";
import type { ProtocolSdkMessage as SdkMessage, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT, WinterProviderResolutionError, createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type ContentBlock } from "../engine.ts";
import { stubExecutor } from "./mock.ts";
import { buildSessionProvider } from "./session-provider.ts";
import { assistantEntry, userEntry, type SessionCtx } from "../store/dialect.ts";
import { rebuildProviderMessages } from "../store/resume.ts";
import { fakeAnthropicCatalog, startAnthropicFake, type AnthropicFake, type FakeResponse } from "./anthropic-fake.test-support.ts";

interface SessionRun {
  frames: WinterFrame[];
  messages: SdkMessage[];
  /** Every `content` the engine handed the transcript writer, in order. */
  recorded: ContentBlock[][];
  fake: AnthropicFake;
}

async function runSession(opts: { model: string; script: (index: number, body: Record<string, unknown>) => FakeResponse; prompts?: string[]; config?: Partial<RuntimeConfig>; engine?: Record<string, unknown> }): Promise<SessionRun> {
  const fake = await startAnthropicFake((request, index) => opts.script(index, request.body));
  // HERMETIC BY CONSTRUCTION, not by configuration alone: any request this session makes to anything
  // but the fake is refused before it leaves the process, so a wiring regression that falls back to
  // the adapter's compiled endpoint fails the test loudly instead of calling the real API.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!target.startsWith(fake.url)) throw new Error(`hermetic fixture: refused a request to ${new URL(target).origin}`);
    return await realFetch(input, init);
  }) as typeof fetch;
  try {
    const catalog = fakeAnthropicCatalog(fake.url, [opts.model]);
    const config = {
      sessionId: "ws23",
      cwd: "/tmp/ws23",
      model: opts.model,
      persistSession: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // THE CONNECTION IS PINNED TO THE FAKE, explicitly. The `anthropic` row is the one provider this
      // adapter does NOT copy a catalog endpoint into the profile for (it has its own compiled
      // default, `https://api.anthropic.com`), so without a session connection every request here
      // would leave the machine. A user `baseUrl` with `local: true` is the documented way a host
      // points a session at a loopback endpoint.
      provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } },
      ...opts.config,
    } as RuntimeConfig;
    const wiring = buildSessionProvider({ config, env: {}, catalog, credentials: createMemoryCredentialStore() });
    const recorded: ContentBlock[][] = [];
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider: wiring.provider,
      tools: stubExecutor,
      providerIdentity: {
        providerId: wiring.identity!.providerId,
        modelKey: wiring.identity!.modelKey,
        family: String(wiring.resolved?.adapter.family ?? ""),
        ...(wiring.identity!.continuationDomain !== undefined ? { continuationDomain: wiring.identity!.continuationDomain } : {}),
      },
      store: {
        recordUserEntry: () => {},
        recordAssistantEntry: (content: ContentBlock[]) => void recorded.push(content),
        recordAttachmentEntry: () => {},
      },
      ...(opts.engine ?? {}),
    } as never);
    for (const prompt of opts.prompts ?? ["go"]) host.output.write({ type: "user", text: prompt });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    const frames: WinterFrame[] = [];
    for await (const f of host.input) frames.push(f);
    await done;
    const messages = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
    return { frames, messages, recorded, fake };
  } finally {
    globalThis.fetch = realFetch;
    await fake.close();
  }
}

const assistantTurns = (body: Record<string, unknown>): Array<{ role: string; content: Array<Record<string, unknown>> }> =>
  (body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>).filter((m) => m.role === "assistant");

const result = (messages: SdkMessage[]): Record<string, unknown> => messages.find((m) => m.type === "result") as Record<string, unknown>;

// --- item 1: block order ------------------------------------------------------------------------------

/** The interleaving a Claude tool loop produces with interleaved thinking. */
const INTERLEAVED: FakeResponse = {
  blocks: [
    { type: "thinking", thinking: "plan the search", signature: "sig-one" },
    { type: "text", text: "Let me look for it." },
    { type: "thinking", thinking: "Glob is the right tool", signature: "sig-two" },
    { type: "tool_use", id: "toolu_1", name: "Glob", input: { pattern: "*.ts" } },
  ],
  stopReason: "tool_use",
};

const INTERLEAVED_BLOCKS = [
  { type: "thinking", thinking: "plan the search", signature: "sig-one" },
  { type: "text", text: "Let me look for it." },
  { type: "thinking", thinking: "Glob is the right tool", signature: "sig-two" },
  { type: "tool_use", id: "toolu_1", name: "Glob", input: { pattern: "*.ts" } },
];

describe("WS-23 item 1: [thinking, text, thinking, tool_use] keeps its order across a tool round trip", () => {
  for (const model of ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5-5"]) {
    test(`${model}: the transcript, the frame and the NEXT request's body all carry the stream's own order, signatures untouched`, async () => {
      const run = await runSession({
        model,
        script: (index) => (index === 0 ? INTERLEAVED : { blocks: [{ type: "text", text: "found nothing" }], stopReason: "end_turn" }),
      });
      expect(run.fake.requests).toHaveLength(2);

      // The transcript.
      expect(run.recorded[0]).toEqual(INTERLEAVED_BLOCKS as ContentBlock[]);
      // The assistant frame the host saw.
      const assistantFrame = run.messages.find((m) => m.type === "assistant") as { message: { content: unknown[] } };
      expect(assistantFrame.message.content).toEqual(INTERLEAVED_BLOCKS);

      // The replay: the second request's assistant turn is the SAME four blocks, in place, byte-identical
      // (the only addition the wire may make is the message-level cache marker on the LAST message,
      // which is the user's tool result, not this turn).
      const replay = assistantTurns(run.fake.requests[1]!.body);
      expect(replay).toHaveLength(1);
      expect(replay[0]!.content).toEqual(INTERLEAVED_BLOCKS);
      // …and the tool result answers the call that turn made.
      const lastUser = (run.fake.requests[1]!.body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>).at(-1)!;
      expect(lastUser.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
      expect(result(run.messages)).toMatchObject({ subtype: "success", is_error: false, result: "found nothing" });
    });
  }

  test("a RESUMED session rebuilds the same order from the transcript it was given", async () => {
    const run = await runSession({
      model: "anthropic/claude-sonnet-5",
      script: (index) => (index === 0 ? INTERLEAVED : { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" }),
    });
    const ctx: SessionCtx = { sessionId: "ws23", cwd: "/tmp/ws23", version: "test" };
    const user = userEntry({ text: "go", chain: { parentUuid: null }, ctx });
    const assistant = assistantEntry({ content: run.recorded[0]! as never, chain: { parentUuid: user.uuid }, ctx });
    const rebuilt = rebuildProviderMessages([user, assistant] as never);
    expect(rebuilt.find((m) => m.role === "assistant")?.content).toEqual(INTERLEAVED_BLOCKS as ContentBlock[]);
  });

  test("an ordinary [text, tool_use] turn is persisted exactly as before (the per-kind assembly and the stream order agree)", async () => {
    const run = await runSession({
      model: "anthropic/claude-sonnet-5",
      script: (index) =>
        index === 0
          ? { blocks: [{ type: "text", text: "checking" }, { type: "tool_use", id: "toolu_2", name: "Glob", input: { pattern: "x" } }], stopReason: "tool_use" }
          : { blocks: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    });
    expect(run.recorded[0]).toEqual([
      { type: "text", text: "checking" },
      { type: "tool_use", id: "toolu_2", name: "Glob", input: { pattern: "x" } },
    ]);
    // A text-only turn still records one text block.
    expect(run.recorded[1]).toEqual([{ type: "text", text: "ok" }]);
  });
});

// --- item 2: overflow recovery, refusal, pause_turn ---------------------------------------------------

/** A compaction controller that never fires on its own and folds everything but the last message into "S". */
function scriptedCompaction(): { controller: { shouldCompact: () => boolean; compact: (input: { messages: unknown[] }) => Promise<unknown> }; calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    controller: {
      shouldCompact: () => false,
      async compact(input: { messages: unknown[] }) {
        state.calls++;
        return { summary: "SUMMARY-OF-EARLIER-TURNS", retained: input.messages.slice(-1), preTokens: 1234, evidencedToolNames: [] };
      },
    },
  } as never;
}

const PROMPT_TOO_LONG: FakeResponse = { status: 400, error: { type: "invalid_request_error", message: "prompt is too long: 1000321 tokens > 1000000 maximum" } };
const TEXT = (text: string): FakeResponse => ({ blocks: [{ type: "text", text }], stopReason: "end_turn" });

describe("WS-23 item 2: context overflow -> reactive compaction -> ONE retry", () => {
  test("a 400 `prompt is too long` compacts through the engine's own compaction and retries the round on the compacted history", async () => {
    const compaction = scriptedCompaction();
    const run = await runSession({
      model: "anthropic/claude-sonnet-5",
      prompts: ["first", "second"],
      engine: { compactionController: compaction.controller },
      script: (index) => (index === 0 ? TEXT("one") : index === 1 ? PROMPT_TOO_LONG : TEXT("recovered")),
    });
    expect(compaction.calls).toBe(1);
    expect(run.fake.requests).toHaveLength(3);
    // The retry carries the summary, not the history it replaced.
    expect(JSON.stringify(run.fake.requests[2]!.body["messages"])).toContain("SUMMARY-OF-EARLIER-TURNS");
    expect(JSON.stringify(run.fake.requests[2]!.body["messages"])).not.toContain('"one"');
    // The boundary is announced exactly as an auto compaction's is.
    expect(run.messages.some((m) => (m as { subtype?: string }).subtype === "compact_boundary")).toBe(true);
    const results = run.messages.filter((m) => m.type === "result") as Array<Record<string, unknown>>;
    expect(results.at(-1)).toMatchObject({ subtype: "success", is_error: false, result: "recovered" });
  });

  test("`stop_reason: model_context_window_exceeded` takes the same path, and the overflowed partial output is DISCARDED, never persisted", async () => {
    const compaction = scriptedCompaction();
    const run = await runSession({
      model: "anthropic/claude-sonnet-5",
      prompts: ["first", "second"],
      engine: { compactionController: compaction.controller },
      script: (index) =>
        index === 0 ? TEXT("one") : index === 1 ? { blocks: [{ type: "text", text: "HALF-WRITTEN" }], stopReason: "model_context_window_exceeded" } : TEXT("recovered"),
    });
    expect(compaction.calls).toBe(1);
    expect(run.recorded.flat().some((b) => JSON.stringify(b).includes("HALF-WRITTEN"))).toBe(false);
    expect(JSON.stringify(run.fake.requests[2]!.body["messages"])).not.toContain("HALF-WRITTEN");
    expect((run.messages.filter((m) => m.type === "result") as Array<Record<string, unknown>>).at(-1)).toMatchObject({ is_error: false, result: "recovered" });
  });

  test("the retry overflowing AGAIN ends the turn typed (`terminal_reason: prompt_too_long`) after exactly one compaction", async () => {
    const compaction = scriptedCompaction();
    const run = await runSession({
      model: "anthropic/claude-sonnet-5",
      prompts: ["first", "second"],
      engine: { compactionController: compaction.controller },
      script: (index) => (index === 0 ? TEXT("one") : PROMPT_TOO_LONG),
    });
    expect(compaction.calls).toBe(1);
    expect(run.fake.requests).toHaveLength(3);
    expect((run.messages.filter((m) => m.type === "result") as Array<Record<string, unknown>>).at(-1)).toMatchObject({ subtype: "success", is_error: true, terminal_reason: "prompt_too_long", api_error_status: 400 });
  });

  test("no compaction controller -> typed `prompt_too_long` at once, one request, no retry", async () => {
    const run = await runSession({ model: "anthropic/claude-sonnet-5", script: () => PROMPT_TOO_LONG });
    expect(run.fake.requests).toHaveLength(1);
    expect(result(run.messages)).toMatchObject({ is_error: true, terminal_reason: "prompt_too_long" });
    expect(String(result(run.messages)["result"])).toContain("No compaction controller");
  });

  test("an ordinary 400 is still an ordinary api_error -- no compaction, no retry", async () => {
    const compaction = scriptedCompaction();
    const run = await runSession({
      model: "anthropic/claude-sonnet-5",
      engine: { compactionController: compaction.controller },
      script: () => ({ status: 400, error: { type: "invalid_request_error", message: "tools.0: bad schema" } }),
    });
    expect(compaction.calls).toBe(0);
    expect(run.fake.requests).toHaveLength(1);
    expect(result(run.messages)).toMatchObject({ is_error: true, terminal_reason: "api_error", api_error_status: 400 });
  });
});

describe("WS-23 item 2: a refusal is surfaced TYPED and its output is not kept", () => {
  test("text refusal: typed result, the refusal frame carries the vendor's category/explanation, nothing reaches the transcript", async () => {
    const run = await runSession({
      model: "anthropic/claude-opus-5-5",
      script: () => ({ blocks: [{ type: "text", text: "I can't help" }], stopReason: "refusal", stopDetails: { type: "refusal", category: "cyber", explanation: "declined for cyber" } }),
    });
    expect(result(run.messages)).toMatchObject({ subtype: "success", is_error: true, terminal_reason: "refusal", result: "I can't help" });
    const refusal = run.messages.find((m) => (m as { subtype?: string }).subtype === "model_refusal_no_fallback") as Record<string, unknown>;
    expect(refusal).toMatchObject({ api_refusal_category: "cyber", api_refusal_explanation: "declined for cyber", content: "I can't help" });
    expect(run.recorded).toHaveLength(0);
    expect(run.messages.some((m) => m.type === "assistant")).toBe(false);
  });

  test("a refusal that cut off mid-call NEVER executes the half-streamed call", async () => {
    let executed = 0;
    const run = await runSession({
      model: "anthropic/claude-sonnet-5",
      engine: { tools: { execute: async () => (executed++, { output: "ran" }) } },
      script: () => ({ blocks: [{ type: "tool_use", id: "toolu_r", name: "Glob", input: { pattern: "*" } }], stopReason: "refusal" }),
    });
    expect(executed).toBe(0);
    expect(run.fake.requests).toHaveLength(1);
    expect(result(run.messages)).toMatchObject({ is_error: true, terminal_reason: "refusal", result: "The model declined to respond to this request." });
  });
});

describe("WS-23 item 2: `pause_turn` continues the turn", () => {
  test("the paused response is persisted and sent back; the turn ends on the resumed answer", async () => {
    const run = await runSession({
      model: "anthropic/claude-sonnet-5",
      script: (index) => (index === 0 ? { blocks: [{ type: "text", text: "working on it" }], stopReason: "pause_turn" } : TEXT("finished")),
    });
    expect(run.fake.requests).toHaveLength(2);
    expect(assistantTurns(run.fake.requests[1]!.body)[0]!.content).toEqual([{ type: "text", text: "working on it" }]);
    expect(result(run.messages)).toMatchObject({ is_error: false, result: "finished" });
  });

  test("bounded: a model that pauses forever ends typed after MAX_PAUSE_TURN_CONTINUATIONS resends", async () => {
    const run = await runSession({ model: "anthropic/claude-sonnet-5", script: () => ({ blocks: [{ type: "text", text: "still going" }], stopReason: "pause_turn" }) });
    expect(run.fake.requests).toHaveLength(6);
    expect(result(run.messages)).toMatchObject({ is_error: true, terminal_reason: "pause_turn_limit" });
  });
});

// --- review I-3: a CROSS-PROVIDER Console target resolves to the broker's `anthropic:console` record ---

describe("WS-23 I-3: a GPT session reaching a Console model (advisor reviewer, stated auxiliary model, subagent) uses `anthropic:console`", () => {
  const SERVICE = "com.winter.test.hermetic";
  const CONSOLE = { kind: "keychain" as const, account: ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT, service: SERVICE };

  /** A GPT session whose only Console material is the broker's record, with api.anthropic.com answered IN-PROCESS (never reached). */
  async function withGptSession(fn: (wiring: ReturnType<typeof buildSessionProvider>, seen: Array<{ url: string; headers: Headers }>) => Promise<void>, extra: Partial<RuntimeConfig> = {}): Promise<void> {
    const config = { sessionId: "ws23-i3", cwd: "/tmp/ws23", model: "openai/gpt-4.1", persistSession: false, keychainService: SERVICE, provider: { providerId: "openai", authRef: { kind: "inline", value: "fixture" } }, ...extra } as RuntimeConfig;
    const credentials = createMemoryCredentialStore([[CONSOLE, { kind: "bearer", token: "fixture-console-bearer" }]]);
    const wiring = buildSessionProvider({ config, env: {}, catalog: loadCatalog(), credentials });
    const seen: Array<{ url: string; headers: Headers }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`hermetic fixture: refused ${new URL(url).origin}`);
      seen.push({ url, headers: new Headers(init?.headers) });
      const frames = [
        { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      return new Response(frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      await fn(wiring, seen);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  const expectConsoleBearer = (seen: Array<{ headers: Headers }>) => {
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer fixture-console-bearer");
    expect(seen[0]!.headers.get("anthropic-beta") ?? "").toContain("oauth-2025-04-20");
  };

  test("advisor reviewer (`config.advisor.model` on Console): resolves to the broker's record and its generation carries the Console bearer", async () => {
    await withGptSession(async (wiring, seen) => {
      const reviewer = wiring.resolveReviewer?.();
      if (reviewer === undefined) throw new Error("no reviewer resolved");
      expect(reviewer.model).toBe("console/claude-sonnet-5");
      await reviewer.provider.generate({ messages: [{ role: "user", content: "hi" }] });
      expectConsoleBearer(seen);
    }, { advisor: { model: "console/claude-sonnet-5" } });
  });

  test("an in-runtime `set_model` GPT -> Console stays R6-K's typed `provider-mismatch` (a cross-provider switch is a new incarnation, never this seam)", async () => {
    await withGptSession(async (wiring) => {
      expect(wiring.resolveModelSwitch("console/claude-sonnet-5")).toMatchObject({ refused: true, code: "provider-mismatch" });
    });
  });

  test("a stated auxiliary model on Console (e.g. WebFetch's digest pin): resolves to the same record", async () => {
    await withGptSession(async (wiring, seen) => {
      const aux = wiring.resolveAuxiliaryModel!("console/claude-sonnet-5");
      if (!aux.ok) throw new Error(`refused: ${aux.code}`);
      await aux.provider.generate({ messages: [{ role: "user", content: "hi" }] });
      expectConsoleBearer(seen);
    });
  });

  test("subagent (a child on `console`): the target material is the broker's record, and it is present", async () => {
    await withGptSession(async (wiring, seen) => {
      const resolved = wiring.registry.resolve({ model: "console/claude-sonnet-5" });
      if (resolved instanceof WinterProviderResolutionError) throw resolved;
      const material = wiring.describeTargetMaterial(resolved);
      expect(material).toMatchObject({ source: "provider-record", authRef: CONSOLE });
      expect(await wiring.credentials.get(material.authRef)).not.toBeNull();
      await wiring.buildProvider(resolved).generate({ messages: [{ role: "user", content: "hi" }] });
      expectConsoleBearer(seen);
    });
  });
});
