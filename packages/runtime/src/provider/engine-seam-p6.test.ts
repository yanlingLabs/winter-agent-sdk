// Phase 6 Task 3: the ENGINE's half of the provider seam, driven through a real `runEngine`.
//
// Everything here is observable only end-to-end. A request field the engine forgets to populate, a
// frame it emits when the pinned runtime suppresses one, an `AbortSignal` that reaches
// `provider.generate` but never `ToolExecutor` -- none of it fails a type-check, and none of it is
// visible from a unit test of any single function. So each fixture below drives the real engine and
// asserts on what the PROVIDER received or what the HOST saw.
import { test, expect, describe } from "bun:test";
import type { ProtocolSdkMessage as SdkMessage, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, DEFAULT_MAX_PROVIDER_MESSAGE_BYTES, ProviderTurnError, type Provider, type ProviderRequest, type ProviderTurn, type ToolExecutor } from "../engine.ts";
import { stubExecutor } from "./mock.ts";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { buildSessionProvider } from "./session-provider.ts";
import { chatCatalog, chatModel, chatProvider, startRawChatFake } from "./raw-chat-fake.test-support.ts";

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ sessionId: "s", cwd: "/tmp/x", model: "sonnet", persistSession: false, ...overrides });

/**
 * A config whose tool calls actually DISPATCH.
 *
 * Under the default mode an unmatched `Bash` call needs a `canUseTool` answer, and these fixtures
 * supply no host handler -- so the engine would sit on an unanswered control_request forever and the
 * test would time out on the wrong thing entirely. Bypass is the right instrument here because the
 * question under test is the SIGNAL's path to the executor, not the permission decision.
 */
const dispatchingConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig =>
  baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, ...overrides });

/** A provider that records every request it is handed and answers from a script. */
function recordingProvider(turns: ProviderTurn[]): { provider: Provider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let i = 0;
  return {
    requests,
    provider: {
      async generate(input) {
        requests.push(input);
        const turn = turns[Math.min(i, turns.length - 1)];
        i++;
        return turn ?? { kind: "text", text: "done" };
      },
    },
  };
}

async function runTurn(opts: {
  provider: Provider;
  config?: Partial<RuntimeConfig>;
  tools?: ToolExecutor;
  engine?: Record<string, unknown>;
  before?: (host: ReturnType<typeof createInMemoryChannel>["host"]) => void;
}): Promise<SdkMessage[]> {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: baseConfig(opts.config),
    input: runtime.input,
    output: runtime.output,
    provider: opts.provider,
    tools: opts.tools ?? stubExecutor,
    ...(opts.engine ?? {}),
  } as never);
  opts.before?.(host);
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;
  return dataMessages(frames);
}

/** Like `runTurn`, with the user's own prompt text under the caller's control. */
async function runTurnWithPrompt(opts: { provider: Provider; prompt: string; engine?: Record<string, unknown> }): Promise<SdkMessage[]> {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: opts.provider, tools: stubExecutor, ...(opts.engine ?? {}) } as never);
  host.output.write({ type: "user", text: opts.prompt });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;
  return dataMessages(frames);
}

describe("R6-3: the request the engine actually sends", () => {
  test("a session with no provider options sends the pre-P6 shape plus only `signal`/`sink`", async () => {
    // Every pre-existing Provider double must keep working unchanged, and the conditional spreads are
    // what guarantee it: `tools` is OMITTED for an empty advertised set rather than sent as `[]` --
    // to a real provider those are different requests ("you have no tools" vs saying nothing).
    const { provider, requests } = recordingProvider([{ kind: "text", text: "done" }]);
    await runTurn({ provider });
    const req = requests[0]!;
    expect(req.messages.length).toBeGreaterThan(0);
    expect(req.model).toBe("sonnet");
    expect(req.signal).toBeDefined();
    expect(req.sink).toBeDefined();
    expect(req.effort).toBeUndefined();
    expect(req.thinking).toBeUndefined();
  });

  test("effort and thinking are forwarded from the session config when set", async () => {
    const { provider, requests } = recordingProvider([{ kind: "text", text: "done" }]);
    await runTurn({ provider, config: { effort: "high", thinking: { type: "enabled", budgetTokens: 2048 } } });
    expect(requests[0]!.effort).toBe("high");
    expect(requests[0]!.thinking).toEqual({ type: "enabled", budgetTokens: 2048 });
  });

  test("the advertised tool set rides the request with REAL schemas, keyed on the name the MODEL sees", async () => {
    const { provider, requests } = recordingProvider([{ kind: "text", text: "done" }]);
    // A session with real capabilities advertises a real set. The assertion is about SHAPE, not a
    // specific tool: a name the model was never shown, or a placeholder schema, is the defect.
    await runTurn({ provider, config: { cwd: "/tmp/x" } });
    const tools = requests[0]!.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    for (const spec of tools) {
      expect(typeof spec.name).toBe("string");
      expect(spec.name.length).toBeGreaterThan(0);
      expect(typeof spec.description).toBe("string");
      expect(spec.inputSchema).toBeDefined();
      expect(typeof spec.inputSchema).toBe("object");
    }
  });
});

describe("R6-6: true cancellation", () => {
  test("an interrupt ABORTS the in-flight generation's signal, not merely the await on it", async () => {
    // Before this task the interrupt resolved a raced Promise and the provider ran to completion
    // behind an abandoned await. The assertion is on what the PROVIDER observed.
    let seenAborted: boolean | undefined;
    const provider: Provider = {
      generate(input) {
        return new Promise<ProviderTurn>((resolve) => {
          input.signal?.addEventListener("abort", () => {
            seenAborted = true;
            resolve({ kind: "text", text: "aborted" });
          });
        });
      },
    };
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });
    host.output.write({ type: "user", text: "go" });
    // The interrupt has to arrive after the turn is in flight; the pump acks it unconditionally.
    await new Promise((r) => setTimeout(r, 20));
    host.output.write({ type: "control_request", requestId: "i1", subtype: "interrupt", payload: undefined });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await done;
    expect(seenAborted).toBe(true);
  });

  test("the signal also reaches the tool executor, so an interrupt stops the in-flight tool", async () => {
    let toolSawSignal = false;
    let toolSawAbort = false;
    const provider: Provider = {
      async generate() {
        return { kind: "tool_use", calls: [{ id: "t1", name: "Bash", input: { command: "sleep 30" } }] };
      },
    };
    const tools: ToolExecutor = {
      execute(_call, opts) {
        toolSawSignal = opts?.signal !== undefined;
        return new Promise((resolve) => {
          opts?.signal?.addEventListener("abort", () => {
            toolSawAbort = true;
            resolve({ output: "killed" });
          });
        });
      },
    };
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: dispatchingConfig(), input: runtime.input, output: runtime.output, provider, tools });
    host.output.write({ type: "user", text: "go" });
    await new Promise((r) => setTimeout(r, 20));
    host.output.write({ type: "control_request", requestId: "i1", subtype: "interrupt", payload: undefined });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await done;
    expect(toolSawSignal).toBe(true);
    expect(toolSawAbort).toBe(true);
  });
});

describe("R6-5 / R6-G: the sink becomes frames, under the gating each frame carries", () => {
  const streamingProvider = (): Provider => ({
    async generate(input) {
      input.sink?.onStreamEvent({ type: "message_start", message: { id: "m1" } });
      input.sink?.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "he" } });
      input.sink?.onStreamEvent({ type: "content_block_stop", index: 0 });
      return { kind: "text", text: "hello" };
    },
  });

  test("`stream_event` is GATED on includePartialMessages, and absent by default", async () => {
    const off = await runTurn({ provider: streamingProvider() });
    expect(off.filter((m) => m.type === "stream_event")).toHaveLength(0);

    const on = await runTurn({ provider: streamingProvider(), config: { includePartialMessages: true } });
    const events = on.filter((m) => m.type === "stream_event") as Array<{ event: { type: string }; parent_tool_use_id: string | null; ttft_ms?: number }>;
    expect(events.map((e) => e.event.type)).toEqual(["message_start", "content_block_delta", "content_block_stop"]);
    // Present-and-null on the main thread -- the pin types it `string | null`, not optional.
    for (const e of events) expect("parent_tool_use_id" in e).toBe(true);
    expect(events[0]!.parent_tool_use_id).toBeNull();
  });

  test("`ttft_ms` rides the FIRST stream_event of the generation and no other", async () => {
    // Capture (F): exactly 2 frames carried it across the run -- one per FORWARDED turn.
    const on = await runTurn({ provider: streamingProvider(), config: { includePartialMessages: true } });
    const events = on.filter((m) => m.type === "stream_event") as Array<{ ttft_ms?: number }>;
    expect(typeof events[0]!.ttft_ms).toBe("number");
    for (const e of events.slice(1)) expect(e.ttft_ms).toBeUndefined();
  });

  test("the ASSISTANT frame still follows the stream events -- stream_event is additive, never a replacement", async () => {
    const on = await runTurn({ provider: streamingProvider(), config: { includePartialMessages: true } });
    expect(on.filter((m) => m.type === "assistant")).toHaveLength(1);
  });

  test("api_retry carries the pinned nine keys, and an absent status becomes NULL on the frame", async () => {
    const provider: Provider = {
      async generate(input) {
        input.sink?.onRetry({ attempt: 1, maxRetries: 10, retryDelayMs: 2000, errorStatus: 529, error: "overloaded" });
        input.sink?.onRetry({ attempt: 2, maxRetries: 10, retryDelayMs: 1000, error: "server_error" }); // a connection error: no HTTP response
        return { kind: "text", text: "done" };
      },
    };
    const messages = await runTurn({ provider });
    const retries = messages.filter((m) => m.type === "system" && (m as { subtype?: string }).subtype === "api_retry") as Array<Record<string, unknown>>;
    expect(retries).toHaveLength(2);
    expect(Object.keys(retries[0]!).sort()).toEqual(["attempt", "error", "error_status", "max_retries", "retry_delay_ms", "session_id", "subtype", "type", "uuid"]);
    expect(retries[0]!.error_status).toBe(529);
    expect(retries[1]!.error_status).toBeNull();
  });

  test("rate_limit_event and auth_status are TOP-LEVEL types, and reasoning_summary is the Winter-only system subtype", async () => {
    const provider: Provider = {
      async generate(input) {
        input.sink?.onRateLimit({ kind: "subscription-quota", info: { status: "allowed_warning", rateLimitType: "five_hour" } });
        input.sink?.onAuthStatus({ isAuthenticating: true, output: ["refreshing"] });
        input.sink?.onReasoningSummary("it considered two options");
        return { kind: "text", text: "done" };
      },
    };
    const messages = await runTurn({ provider });
    expect(messages.filter((m) => m.type === "rate_limit_event")).toHaveLength(1);
    expect(messages.filter((m) => m.type === "auth_status")).toHaveLength(1);
    const summary = messages.find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "reasoning_summary") as { text: string } | undefined;
    expect(summary?.text).toBe("it considered two options");
  });
});

describe("R6-3: what a turn PERSISTS and what it must not", () => {
  test("a tool_use turn's leading TEXT survives into the assistant frame, ahead of the calls", async () => {
    // R6-3's own reason for the field: before it, a model that returned text AND calls in one turn
    // lost the text with nothing failing anywhere.
    const { provider } = recordingProvider([
      { kind: "tool_use", text: "I'll read the file first.", calls: [{ id: "t1", name: "Bash", input: { command: "true" } }] },
      { kind: "text", text: "done" },
    ]);
    const messages = await runTurn({ provider, config: { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }, tools: { async execute() { return { output: "ok" }; } } });
    const assistant = messages.find((m) => m.type === "assistant") as { message: { content: Array<{ type: string; text?: string }> } };
    expect(assistant.message.content[0]).toEqual({ type: "text", text: "I'll read the file first." });
    expect(assistant.message.content[1]!.type).toBe("tool_use");
  });

  test("IN-DIALECT thinking blocks lead the assistant frame with their real signatures", async () => {
    const provider: Provider = {
      async generate() {
        return { kind: "text", text: "answer", thinking: { blocks: [{ type: "thinking", thinking: "reasoned", signature: "real-sig" }] } };
      },
    };
    const messages = await runTurn({ provider });
    const assistant = messages.find((m) => m.type === "assistant") as { message: { content: Array<Record<string, unknown>> } };
    expect(assistant.message.content[0]).toEqual({ type: "thinking", thinking: "reasoned", signature: "real-sig" });
    expect(assistant.message.content[1]).toEqual({ type: "text", text: "answer" });
  });

  test("R6-8: a FOREIGN summary never reaches the assistant frame -- it rides the Winter-only frame only", async () => {
    const provider: Provider = {
      async generate(input) {
        input.sink?.onReasoningSummary("foreign reasoning");
        return { kind: "text", text: "answer", thinking: { summary: "foreign reasoning" } };
      },
    };
    const messages = await runTurn({ provider });
    const assistant = messages.find((m) => m.type === "assistant") as { message: { content: Array<Record<string, unknown>> } };
    expect(JSON.stringify(assistant.message.content)).not.toContain("foreign reasoning");
    expect(assistant.message.content.every((b) => b.type !== "thinking")).toBe(true);
    expect(messages.some((m) => m.type === "system" && (m as { subtype?: string }).subtype === "reasoning_summary")).toBe(true);
  });
});

describe("R6-F: a provider failure lands on the pinned result shape", () => {
  test("a ProviderTurnError becomes subtype 'success' + is_error + terminal_reason 'api_error' + api_error_status", async () => {
    const provider: Provider = {
      async generate() {
        throw new ProviderTurnError("the provider refused the request", { status: 529 });
      },
    };
    const messages = await runTurn({ provider });
    const result = messages.find((m) => m.type === "result") as Record<string, unknown>;
    expect(result.subtype).toBe("success");
    expect(result.is_error).toBe(true);
    expect(result.terminal_reason).toBe("api_error");
    expect(result.api_error_status).toBe(529);
  });

  test("a connection error with no HTTP response reports api_error_status: null", async () => {
    const provider: Provider = {
      async generate() {
        throw new ProviderTurnError("connection reset");
      },
    };
    const result = (await runTurn({ provider })).find((m) => m.type === "result") as Record<string, unknown>;
    expect(result.api_error_status).toBeNull();
  });

  test("ANY OTHER throw stays `error_during_execution`, byte-identical to before this task", async () => {
    const provider: Provider = {
      async generate() {
        throw new Error("a plain bug");
      },
    };
    const result = (await runTurn({ provider })).find((m) => m.type === "result") as Record<string, unknown>;
    expect(result.subtype).toBe("error_during_execution");
    expect(result.terminal_reason).toBeUndefined();
  });
});

describe("P1 carry: the per-message input byte cap", () => {
  test("an oversized message is REFUSED with a typed error, never silently truncated", async () => {
    const { provider, requests } = recordingProvider([{ kind: "text", text: "done" }]);
    // A 64-byte cap against a prompt that is comfortably over it -- the cap is measured on the
    // SERIALIZED message, because that is what goes on the wire.
    const messages = await runTurnWithPrompt({ provider, prompt: "x".repeat(500), engine: { maxProviderMessageBytes: 64 } });
    // The provider was never called: the cap is enforced BEFORE the request leaves the engine.
    expect(requests).toHaveLength(0);
    const result = messages.find((m) => m.type === "result") as Record<string, unknown>;
    expect(result.terminal_reason).toBe("api_error");
    expect(String(result.result)).toContain("per-message cap");
    expect(String(result.result)).toContain("NOT truncated");
  });

  test("the default cap is disclosed and generous enough that an ordinary turn is unaffected", async () => {
    expect(DEFAULT_MAX_PROVIDER_MESSAGE_BYTES).toBe(4 * 1024 * 1024);
    const { provider, requests } = recordingProvider([{ kind: "text", text: "done" }]);
    await runTurn({ provider });
    expect(requests).toHaveLength(1);
  });
});

describe("R6-I: the set_model hook points", () => {
  test("a set_model arriving BETWEEN turns applies at the next turn's quiescent boundary and emits model_switch", async () => {
    const { provider, requests } = recordingProvider([{ kind: "text", text: "one" }, { kind: "text", text: "two" }]);
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });
    host.output.write({ type: "user", text: "first" });
    host.output.write({ type: "control_request", requestId: "m1", subtype: "set_model", payload: { model: "opus" } });
    host.output.write({ type: "user", text: "second" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;

    // The FIRST generation still ran on the original model; the second is the swapped one.
    expect(requests[0]!.model).toBe("sonnet");
    expect(requests[1]!.model).toBe("opus");
    const ack = frames.find((f) => f.type === "control_response" && (f as { requestId: string }).requestId === "m1") as { ok: boolean };
    expect(ack.ok).toBe(true);
    const switches = dataMessages(frames).filter((m) => m.type === "system" && (m as { subtype?: string }).subtype === "model_switch") as Array<Record<string, unknown>>;
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ reason: "set_model", from_model: "sonnet", to_model: "opus" });
  });

  test("the pin's THREE-WAY reset spelling: omitted, null and the literal 'default' all reset", async () => {
    // A Winter implementation that accepting only undefined/null as "reset" silently treats the
    // literal string 'default' as a model id -- the exact defect item (d) names.
    //
    // SEQUENCED, not written up-front: two `set_model`s written before the pump has consumed the
    // intervening user envelope both park before the first boundary and the second simply wins. That
    // is correct last-wins behaviour, but it tests nothing about the reset -- so each request is sent
    // only after the previous turn's terminal result has been observed.
    for (const payload of [{ model: "default" }, { model: null }, {}]) {
      const { provider, requests } = recordingProvider([{ kind: "text", text: "one" }, { kind: "text", text: "two" }, { kind: "text", text: "three" }]);
      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });
      const frames: WinterFrame[] = [];
      const reader = (async () => {
        for await (const f of host.input) frames.push(f);
      })();
      const awaitResults = async (n: number): Promise<void> => {
        const deadline = Date.now() + 5000;
        while (dataMessages(frames).filter((m) => m.type === "result").length < n) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} results`);
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      host.output.write({ type: "user", text: "first" });
      await awaitResults(1);
      host.output.write({ type: "control_request", requestId: "m1", subtype: "set_model", payload: { model: "opus" } });
      host.output.write({ type: "user", text: "second" });
      await awaitResults(2);
      host.output.write({ type: "control_request", requestId: "m2", subtype: "set_model", payload });
      host.output.write({ type: "user", text: "third" });
      await awaitResults(3);
      host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
      await reader;
      await done;
      expect(requests[0]!.model).toBe("sonnet");
      expect(requests[1]!.model).toBe("opus");
      expect(requests[2]!.model).toBe("sonnet"); // back to config.model, the session default
    }
  });

  test("(whole-branch M-8) the SAME hook points through a CATALOG-RESOLVED adapter with a KEY: the wire carries the provider-local id, never the key, and the switch is announced with keys", async () => {
    // The fixtures above script the provider and speak bare ids, which is exactly why C-2 was
    // invisible: a scripted double cannot tell a key from a wire id. This variant drives the real
    // `buildSessionProvider` chain against a loopback fake and reads the ground truth off its log.
    const fake = await startRawChatFake();
    try {
      const catalog = chatCatalog([chatProvider("prova", fake.url)], [chatModel({ key: "prova/m1", providerId: "prova", upstreamId: "m1" }), chatModel({ key: "prova/m2", providerId: "prova", upstreamId: "m2" })]);
      const config: RuntimeConfig = { sessionId: "m8", cwd: "/tmp/x", model: "prova/m1", persistSession: false, provider: { providerId: "prova", authRef: { kind: "inline", value: "fixture" } } } as RuntimeConfig;
      const wiring = buildSessionProvider({ config, env: {}, catalog, credentials: createMemoryCredentialStore() });
      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({
        config,
        input: runtime.input,
        output: runtime.output,
        provider: wiring.provider,
        tools: stubExecutor,
        providerIdentity: { providerId: "prova", modelKey: "prova/m1", family: "openai", adapterId: wiring.identity!.adapterId, adapterVersion: wiring.identity!.adapterVersion, catalogVersion: wiring.identity!.catalogVersion, authRefKind: "inline" },
        resolveModelSwitch: wiring.resolveModelSwitch,
      });
      host.output.write({ type: "user", text: "first" });
      // The KEY, as a picker row's `value` carries it (R6-I) -- P2b's exact request.
      host.output.write({ type: "control_request", requestId: "m1", subtype: "set_model", payload: { model: "prova/m2" } });
      host.output.write({ type: "user", text: "second" });
      host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
      const frames = await drain(host.input);
      await done;
      expect(fake.requests.map((r) => r.model)).toEqual(["m1", "m2"]);
      const switches = dataMessages(frames).filter((m) => m.type === "system" && (m as { subtype?: string }).subtype === "model_switch") as Array<Record<string, unknown>>;
      expect(switches).toHaveLength(1);
      expect(switches[0]).toMatchObject({ reason: "set_model", from_model: "prova/m1", to_model: "prova/m2", provider: "prova" });
    } finally {
      await fake.close();
    }
  });

  test("a non-string, non-null model is REFUSED with a typed control error rather than parked", async () => {
    const { provider } = recordingProvider([{ kind: "text", text: "one" }]);
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });
    host.output.write({ type: "control_request", requestId: "m1", subtype: "set_model", payload: { model: 7 } });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    const ack = frames.find((f) => f.type === "control_response" && (f as { requestId: string }).requestId === "m1") as { ok: boolean; error?: { code: string } };
    expect(ack.ok).toBe(false);
    expect(ack.error?.code).toBe("invalid_model");
  });
});

describe("R6-17: what a CHILD inherits", () => {
  test("a NON-fork spawn inherits the effective effort/thinking and NO history", async () => {
    // The end-to-end "the child RAN off its own provider" fixture is T10's (the P5 factory-seam
    // lesson: a field declared upstream proves nothing across the seam). This is the SEAM half --
    // the inheritance object the engine actually builds.
    const { registerChildEngineFactory, resetChildEngineFactoryForTest } = await import("../subagents/child-handle.ts");
    const { createFakeChildHandle } = await import("../subagents/test-fakes.ts");
    const { registerTool, unregisterToolForTest } = await import("../tools/registry.ts");
    // A fixture tool that does exactly one thing -- call `ctx.session.spawnChild` -- mirroring
    // engine.test.ts's own spawn-probe precedent. Driving the real `Agent` tool instead would make
    // this fixture depend on that tool's own availability/definition-resolution rules, which are not
    // what is under test here.
    const PROBE = "p6_spawn_probe";
    registerTool({
      descriptor: {
        canonicalName: PROBE,
        advertisedName: PROBE,
        source: "builtin",
        inputSchema: { type: "object" },
        description: "fixture: calls ctx.session.spawnChild",
        exposure: "eager",
        permissionClass: "read",
        availability: {},
        capabilityRequirements: [],
        disposition: "implement-now",
      },
      executor: {
        async execute(input: unknown, ctx) {
          if (!ctx.session.spawnChild) return { output: "no spawnChild capability", isError: true };
          const handle = await ctx.session.spawnChild(input as never);
          return { output: handle.record.id };
        },
      },
    });
    let captured: import("../subagents/child-handle.ts").ChildInheritance | undefined;
    registerChildEngineFactory(() => ({
      async spawn(_req, inherit) {
        captured = inherit;
        return createFakeChildHandle();
      },
    }));
    try {
      const { provider } = recordingProvider([
        { kind: "tool_use", calls: [{ id: "a1", name: PROBE, input: { parentToolUseId: "a1", prompt: "hi", runInBackground: false } }] },
        { kind: "text", text: "done" },
      ]);
      // NO `tools` override: the engine must build its own registry-backed executor, which is the
      // only one that supplies `ctx.session.spawnChild` at all.
      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({
        config: baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, effort: "high", thinking: { type: "adaptive" } }),
        input: runtime.input,
        output: runtime.output,
        provider,
      });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
      await drain(host.input);
      await done;
      expect(captured).toBeDefined();
      expect(captured!.effectiveEffort).toBe("high");
      expect(captured!.effectiveThinking).toEqual({ type: "adaptive" });
      // A NON-fork spawn inherits no history at all -- asserted so the fork fixture below is
      // demonstrably testing the fork branch and not a field that is always populated.
      expect(captured!.messages).toBeUndefined();
      // No provider identity has been RESOLVED in this run (selection is wired in T10), so the field
      // is absent rather than fabricated -- which is exactly the contract.
      expect(captured!.provider).toBeUndefined();
    } finally {
      unregisterToolForTest(PROBE);
      resetChildEngineFactoryForTest();
    }
  });
});

describe("R6-7: the write-ahead path, with a resolved provider identity", () => {
  // WITHOUT `providerIdentity` this whole path is inert -- which is correct for every pre-P6 session,
  // and is exactly why it needs its own fixture: nothing else in the suite ever executes it.
  const IDENTITY = { providerId: "openai", modelKey: "openai/o-test", family: "openai", continuationDomain: "openai:responses" };

  test("the sidecar records are written BEFORE the entry, in itemIndex order, with the same anchor", async () => {
    const calls: Array<{ op: string; kind?: string | undefined; itemIndex?: number | undefined; anchorUuid?: string | undefined; uuid?: string | undefined }> = [];
    const store = {
      recordUserEntry: () => {},
      recordAssistantEntry: (_content: unknown, opts?: { uuid?: string }) => {
        calls.push({ op: "entry", uuid: opts?.uuid });
      },
      recordProviderState: (record: { kind: string; itemIndex: number; anchorUuid: string }) => {
        calls.push({ op: "record", kind: record.kind, itemIndex: record.itemIndex, anchorUuid: record.anchorUuid });
      },
    };
    const provider: Provider = {
      async generate() {
        return {
          kind: "text",
          text: "answer",
          thinking: { summary: "foreign reasoning" },
          nativeState: { family: "openai", continuationDomain: "openai:responses", items: ["OPAQUE-ITEM"] },
        };
      },
    };
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig({ persistSession: true }), input: runtime.input, output: runtime.output, provider, tools: stubExecutor, store, providerIdentity: IDENTITY } as never);
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await done;

    // ORDER IS THE GUARANTEE: three records, then the entry.
    const assistantOps = calls.filter((c) => c.op === "record" || (c.op === "entry" && c.uuid !== undefined));
    expect(assistantOps.map((c) => `${c.op}:${c.kind ?? ""}`)).toEqual(["record:origin", "record:native-state", "record:summary", "entry:"]);
    expect(assistantOps.slice(0, 3).map((c) => c.itemIndex)).toEqual([0, 1, 2]);
    // The anchor the records name IS the uuid the entry was written under.
    const anchor = assistantOps[0]!.anchorUuid;
    expect(anchor).toBeDefined();
    for (const record of assistantOps.slice(0, 3)) expect(record.anchorUuid).toBe(anchor!);
    expect(assistantOps[3]!.uuid).toBe(anchor!);
  });

  test("with NO identity the path is inert -- no records at all, byte-identical to a pre-P6 session", async () => {
    const calls: string[] = [];
    const store = {
      recordUserEntry: () => {},
      recordAssistantEntry: () => calls.push("entry"),
      recordProviderState: () => calls.push("record"),
    };
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig({ persistSession: true }), input: runtime.input, output: runtime.output, provider: recordingProvider([{ kind: "text", text: "x" }]).provider, tools: stubExecutor, store } as never);
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await done;
    expect(calls).not.toContain("record");
    expect(calls).toContain("entry");
  });

  test("the resolved identity also rides the in-memory message as `origin`, and the OPAQUE state never reaches a frame", async () => {
    const { provider, requests } = recordingProvider([
      { kind: "text", text: "one", nativeState: { family: "openai", continuationDomain: "openai:responses", items: ["OPAQUE-ITEM"] } },
      { kind: "text", text: "two" },
    ]);
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor, providerIdentity: IDENTITY } as never);
    const frames: WinterFrame[] = [];
    const reader = (async () => {
      for await (const f of host.input) frames.push(f);
    })();
    host.output.write({ type: "user", text: "first" });
    await new Promise((r) => setTimeout(r, 40));
    host.output.write({ type: "user", text: "second" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await reader;
    await done;

    const secondRequest = requests[1]!;
    const priorAssistant = secondRequest.messages.find((m) => m.role === "assistant");
    expect(priorAssistant?.origin).toEqual(IDENTITY);
    expect(priorAssistant?.nativeState?.items).toEqual(["OPAQUE-ITEM"]);
    // …and it is nowhere in anything the HOST saw.
    expect(JSON.stringify(frames)).not.toContain("OPAQUE-ITEM");
  });
});

describe("R6-C: the pinned refusal frame", () => {
  test("`stopReason: 'refusal'` with no fallback configured emits model_refusal_no_fallback", async () => {
    const provider: Provider = { async generate() { return { kind: "text", text: "I can't help with that.", stopReason: "refusal" }; } };
    const messages = await runTurn({ provider });
    const refusal = messages.find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "model_refusal_no_fallback") as Record<string, unknown> | undefined;
    expect(refusal).toBeDefined();
    expect(refusal!.trigger).toBe("refusal");
    expect(refusal!.original_model).toBe("sonnet");
    expect(refusal!.request_id).toBeNull();
    expect(refusal!.content).toBe("I can't help with that.");
    // The pair's OTHER arm describes a retry that actually happened on a fallback model; a refusal is
    // not a retryable failure, so `engageFallback` never runs here and this path never announces it.
    expect(messages.some((m) => (m as { subtype?: string }).subtype === "model_refusal_fallback")).toBe(false);
  });

  test("an ordinary stop reason emits NO refusal frame", async () => {
    const provider: Provider = { async generate() { return { kind: "text", text: "done", stopReason: "end_turn" }; } };
    const messages = await runTurn({ provider });
    expect(messages.some((m) => String((m as { subtype?: string }).subtype ?? "").startsWith("model_refusal"))).toBe(false);
  });

  test("with a fallback CONFIGURED the frame is withheld -- the swap has not happened yet", async () => {
    const provider: Provider = { async generate() { return { kind: "text", text: "no", stopReason: "refusal" }; } };
    const messages = await runTurn({ provider, config: { fallbackModel: "other" } });
    expect(messages.some((m) => String((m as { subtype?: string }).subtype ?? "").startsWith("model_refusal"))).toBe(false);
  });
});

describe("R6-G: `user_message_uuid` is ABSENT on stream_event, and that is pin-correct", () => {
  test("no stream_event carries it -- Winter has no client-supplied uuid to stamp", async () => {
    // Item (a)'s three-way rule conditions BOTH arms on the turn having a CLIENT-supplied uuid, and
    // capture (F) observed the field on zero frames for exactly that reason. `turnUserMessageUuid` is
    // Winter's OWN minted checkpoint id (R5-11); stamping it here would misrepresent an internal id
    // as the client's. Asserted so a later task that adds a real client-uuid concept has a fixture
    // telling it this is the place to revisit.
    const provider: Provider = {
      async generate(input) {
        input.sink?.onStreamEvent({ type: "message_start" });
        input.sink?.onStreamEvent({ type: "message_stop" });
        return { kind: "text", text: "x" };
      },
    };
    const messages = await runTurn({ provider, config: { includePartialMessages: true } });
    const events = messages.filter((m) => m.type === "stream_event") as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect("user_message_uuid" in e).toBe(false);
  });
});

describe("R6-F: a resolution refusal lands on the result shape too", () => {
  test("a WinterProviderResolutionError thrown from generate() is an api_error, not error_during_execution", async () => {
    // R6-9: "no model + no provider -> a typed WinterProviderResolutionError surfaced in the captured
    // failure shape". It has no HTTP status, so `api_error_status` is null -- exactly capture (I)'s
    // run (i), which failed closed without making a request at all.
    const { WinterProviderResolutionError } = await import("@yanlinglabs/winter-provider-runtime");
    const provider: Provider = {
      async generate() {
        throw new WinterProviderResolutionError("no-provider-for-bare-model", "a bare model id needs a provider");
      },
    };
    const result = (await runTurn({ provider })).find((m) => m.type === "result") as Record<string, unknown>;
    expect(result.subtype).toBe("success");
    expect(result.is_error).toBe(true);
    expect(result.terminal_reason).toBe("api_error");
    expect(result.api_error_status).toBeNull();
  });
});

describe("R6-3 sweep consumer 6: the CHILD FORK MIRROR, through a live fork", () => {
  test("a FORK's inherited history keeps the parent's provider annotations", async () => {
    // The fixture this replaces spread the array itself and asserted the annotations survived --
    // which tests JavaScript's spread operator, not `buildChildInheritance`. A `{role, content}`
    // rebuild of the parent's history left it green while silently stripping `origin`/`nativeState`
    // from every forked message, and a child would then replay a foreign history as if it were its
    // own provider's. A mirror can only be tested through the thing that mirrors, so this drives a
    // real `runEngine` with `fork: true` and reads what the child was actually handed.
    const { registerChildEngineFactory, resetChildEngineFactoryForTest } = await import("../subagents/child-handle.ts");
    const { createFakeChildHandle } = await import("../subagents/test-fakes.ts");
    const { registerTool, unregisterToolForTest } = await import("../tools/registry.ts");
    const PROBE = "p6_fork_probe";
    registerTool({
      descriptor: {
        canonicalName: PROBE,
        advertisedName: PROBE,
        source: "builtin",
        inputSchema: { type: "object" },
        description: "fixture: forks a child",
        exposure: "eager",
        permissionClass: "read",
        availability: {},
        capabilityRequirements: [],
        disposition: "implement-now",
      },
      executor: {
        async execute(input: unknown, ctx) {
          if (!ctx.session.spawnChild) return { output: "no spawnChild capability", isError: true };
          const handle = await ctx.session.spawnChild(input as never);
          return { output: handle.record.id };
        },
      },
    });
    let captured: import("../subagents/child-handle.ts").ChildInheritance | undefined;
    registerChildEngineFactory(() => ({
      async spawn(_req, inherit) {
        captured = inherit;
        return createFakeChildHandle();
      },
    }));
    try {
      const IDENTITY = { providerId: "openai", modelKey: "openai/o-test", family: "openai", continuationDomain: "openai:responses" };
      // Turn 1 produces an assistant message carrying BOTH annotations; turn 2 forks; turn 3 ends.
      const { provider } = recordingProvider([
        { kind: "text", text: "prior answer", nativeState: { family: "openai", continuationDomain: "openai:responses", items: ["OPAQUE-ITEM"] } },
        { kind: "tool_use", calls: [{ id: "f1", name: PROBE, input: { parentToolUseId: "f1", prompt: "go", runInBackground: false, fork: true } }] },
        { kind: "text", text: "done" },
      ]);
      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({
        config: baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }),
        input: runtime.input,
        output: runtime.output,
        provider,
        providerIdentity: IDENTITY,
      } as never);
      const frames: WinterFrame[] = [];
      const reader = (async () => {
        for await (const f of host.input) frames.push(f);
      })();
      host.output.write({ type: "user", text: "first" });
      await new Promise((r) => setTimeout(r, 40));
      host.output.write({ type: "user", text: "second" });
      host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
      await reader;
      await done;

      expect(captured).toBeDefined();
      const inherited = captured!.messages;
      expect(inherited).toBeDefined();
      const priorAssistant = inherited!.find((m) => m.role === "assistant");
      expect(priorAssistant).toBeDefined();
      // THE ASSERTION THAT RED-FAILS ON A `{role, content}` REBUILD.
      expect(priorAssistant!.origin).toEqual(IDENTITY);
      expect(priorAssistant!.nativeState).toEqual({ family: "openai", continuationDomain: "openai:responses", items: ["OPAQUE-ITEM"] });
      // `uuid` is deliberately NOT asserted here: this session is `persistSession: false`, so no entry
      // was ever recorded and there is no anchor to carry -- which is correct, not a gap. The anchor's
      // survival through a persisted session is pinned by provider-state.test.ts's ordering fixture.
      expect(priorAssistant!.uuid).toBeUndefined();
    } finally {
      unregisterToolForTest(PROBE);
      resetChildEngineFactoryForTest();
    }
  });
});

describe("R6-3 / M3: only LOADED deferred tools are advertised to the provider", () => {
  test("a deferred tool that this session has not loaded is ABSENT from the request's `tools`", async () => {
    // WS-09 §8.2's "load != permission" runs both ways. Advertising a schema for a deferred tool the
    // session has not loaded invites the model to call a name the engine's own load-first check will
    // refuse BEFORE permission evaluation even starts -- a wasted round trip and a confusing refusal,
    // every time. The eager control in the same fixture is what proves the filter is a FILTER and not
    // an empty list.
    const { registerTool, unregisterToolForTest } = await import("../tools/registry.ts");
    const EAGER = "p6_eager_probe";
    const DEFERRED = "p6_deferred_probe";
    // The deferred probe is NOT `source: "builtin"`: `resolveDeferral`'s own unconditional override
    // makes a builtin eager whatever its `deferred` flag says (WS-09 §8: core built-ins are never
    // deferred through the public surface), so a builtin probe would be advertised and the fixture
    // would fail for a reason that has nothing to do with the filter under test.
    const descriptor = (name: string, deferred: boolean) => ({
      canonicalName: name,
      advertisedName: name,
      source: (deferred ? "mcp" : "builtin") as "builtin" | "mcp",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      description: `fixture: ${name}`,
      exposure: "eager" as const,
      permissionClass: "read" as const,
      availability: {},
      capabilityRequirements: [],
      disposition: "implement-now" as const,
      ...(deferred ? { deferred: true } : {}),
    });
    registerTool({ descriptor: descriptor(EAGER, false), executor: { async execute() { return { output: "" }; } } });
    registerTool({ descriptor: descriptor(DEFERRED, true), executor: { async execute() { return { output: "" }; } } });
    try {
      const { provider, requests } = recordingProvider([{ kind: "text", text: "done" }]);
      // Tool Search ACTIVE (`toolSearchEnabled`, the host-facing wire boolean that overrides the
      // ambient env var), so the deferral partition is real: without activation every declared
      // deferred tool is advertised eagerly and the fixture would prove nothing.
      await runTurn({ provider, config: { toolSearchEnabled: true } });
      const names = (requests[0]!.tools ?? []).map((t) => t.name);
      expect(names).toContain(EAGER);
      expect(names).not.toContain(DEFERRED);
      // …and the schema that DID ride is the descriptor's real one, not a placeholder.
      expect((requests[0]!.tools ?? []).find((t) => t.name === EAGER)?.inputSchema).toEqual({ type: "object", properties: { q: { type: "string" } } });
    } finally {
      unregisterToolForTest(EAGER);
      unregisterToolForTest(DEFERRED);
    }
  });
});
