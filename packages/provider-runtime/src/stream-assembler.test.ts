// 0.0.56 (W8): the stream assembler as a HOST uses it -- events in, one turn and one assistant message out.
// The engine's own use of the same code is covered by the runtime's bridge tests, which still pass
// unchanged against this module.
import { describe, expect, test } from "bun:test";
import { createFakeProviderAdapter, fakeErrorTurn, fakeTextTurn, fakeToolCallTurn } from "./fake-adapter.ts";
import { ProviderStreamError, assembledToMessage, foldProviderStream, stampNativeState, type AssembledTurn, type AssemblerStreamEvent } from "./stream-assembler.ts";
import type { MessageOrigin, ProviderEvent } from "./types.ts";

async function* events(list: readonly ProviderEvent[]): AsyncGenerator<ProviderEvent> {
  for (const e of list) yield e;
}

const ANTHROPIC: MessageOrigin = { providerId: "anthropic", modelKey: "anthropic/claude-haiku-5-5", family: "anthropic", continuationDomain: "anthropic/claude-haiku-5-5" };
const OPENROUTER: MessageOrigin = { providerId: "openrouter", modelKey: "openrouter/anthropic/claude-sonnet-5.5", family: "openai" };

describe("foldProviderStream (provider-runtime)", () => {
  test("a text turn: the text, usage with the provider's reported cost, the stop reason and the response id", async () => {
    const turn = await foldProviderStream(events(fakeTextTurn(["Hel", "lo"], { id: "resp-1", usage: { inputTokens: 10, outputTokens: 2, reportedCostUsd: 0.0004 } })));
    expect(turn).toEqual({
      kind: "text",
      text: "Hello",
      usage: { inputTokens: 10, outputTokens: 2, reportedCostUsd: 0.0004 },
      stopReason: "end_turn",
      content: [{ type: "text", text: "Hello" }],
      responseId: "resp-1",
    });
  });

  test("the streaming sink: onTextDelta sees exactly the answer's deltas, in order; onStreamEvent sees the block stream", async () => {
    const deltas: string[] = [];
    const raw: AssemblerStreamEvent[] = [];
    await foldProviderStream(events(fakeTextTurn(["a", "b", "c"])), { sink: { onTextDelta: (t) => deltas.push(t), onStreamEvent: (e) => raw.push(e) } });
    expect(deltas).toEqual(["a", "b", "c"]);
    expect(raw.map((e) => e.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  });

  test("a throwing sink ends the turn (a host stopping early); a throwing progress observer does not", async () => {
    const stopped = (await foldProviderStream(events(fakeTextTurn("ok")), { sink: { onTextDelta: () => { throw new Error("client went away"); } } }).catch((e: unknown) => e)) as ProviderStreamError;
    expect(stopped).toBeInstanceOf(ProviderStreamError);
    expect(stopped.committed).toBe(true);
    const turn = await foldProviderStream(events([{ type: "reasoning_progress", block: "b", phase: "delta", kind: "exposed", text: "t" }, ...fakeTextTurn("ok")]), { sink: { onReasoningProgress: () => { throw new Error("observer down"); } } });
    expect(turn.kind === "text" && turn.text).toBe("ok");
  });

  test("text, reasoning blocks and calls keep their STREAM ORDER; arguments are parsed once", async () => {
    const turn = await foldProviderStream(
      events([
        { type: "message_start" },
        { type: "native_thinking_block", block: { type: "thinking", thinking: "plan", signature: "sig-1" } },
        { type: "text_delta", text: "Looking." },
        { type: "native_thinking_block", block: { type: "redacted_thinking", data: "opaque" } },
        { type: "tool_call_start", id: "c1", name: "read" },
        { type: "tool_call_delta", id: "c1", argumentsJsonDelta: '{"pa' },
        { type: "tool_call_delta", id: "c1", argumentsJsonDelta: 'th":"a"}' },
        { type: "tool_call_end", id: "c1" },
        { type: "native_state", items: [{ opaque: true }] },
        { type: "done", stopReason: "tool_use" },
      ]),
    );
    expect(turn.kind).toBe("tool_use");
    expect(turn.content).toEqual([
      { type: "thinking", thinking: "plan", signature: "sig-1" },
      { type: "text", text: "Looking." },
      { type: "redacted_thinking", data: "opaque" },
      { type: "tool_use", id: "c1", name: "read", input: { path: "a" } },
    ]);
    expect(turn.nativeState).toEqual({ family: "", continuationDomain: "", items: [{ opaque: true }] });
  });

  test("an error EVENT after output is committed; an overflow before any output is not", async () => {
    const committed = foldProviderStream(events([{ type: "message_start" }, { type: "text_delta", text: "x" }, ...fakeErrorTurn({ code: "server", message: "boom", retryable: true })]));
    await expect(committed).rejects.toBeInstanceOf(ProviderStreamError);
    await committed.catch((err: ProviderStreamError) => {
      expect(err.committed).toBe(true);
      expect(err.error.code).toBe("server");
    });
    const overflow = await foldProviderStream(events([{ type: "message_start" }, ...fakeErrorTurn({ code: "bad_request", message: "prompt is too long", retryable: false, contextOverflow: true })])).catch((e: ProviderStreamError) => e);
    expect(overflow).toBeInstanceOf(ProviderStreamError);
    expect((overflow as ProviderStreamError).committed).toBe(false);
    expect((overflow as ProviderStreamError).error.contextOverflow).toBe(true);
  });

  test("a THROW is normalized, its message bounded, the original never attached", async () => {
    async function* throwing(): AsyncGenerator<ProviderEvent> {
      yield { type: "message_start" };
      throw new Error(`${"x".repeat(1000)} secret-body`);
    }
    const err = (await foldProviderStream(throwing()).catch((e: unknown) => e)) as ProviderStreamError;
    expect(err).toBeInstanceOf(ProviderStreamError);
    expect(err.committed).toBe(true);
    expect(err.error.code).toBe("network");
    expect(err.message).not.toContain("secret-body");
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  test("a host's own error mapping replaces the default", async () => {
    const err = await foldProviderStream(events(fakeErrorTurn({ code: "rate_limit", message: "slow down", retryable: true })), { errors: { fromEvent: (e, c) => ({ mine: e.code, c }), fromThrown: (e) => e } }).catch((e: unknown) => e);
    expect(err).toEqual({ mine: "rate_limit", c: false });
  });
});

describe("assembledToMessage / stampNativeState", () => {
  test("Anthropic family: the stream order, the origin, and native state stamped with the domain", async () => {
    const turn = await foldProviderStream(
      events([
        { type: "native_thinking_block", block: { type: "thinking", thinking: "t", signature: "s" } },
        { type: "text_delta", text: "hi" },
        { type: "native_state", items: [1] },
        { type: "done", stopReason: "end_turn" },
      ]),
    );
    expect(assembledToMessage(turn, ANTHROPIC)).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t", signature: "s" },
        { type: "text", text: "hi" },
      ],
      origin: ANTHROPIC,
      nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-haiku-5-5", items: [1] },
    });
  });

  test("any other family: per-kind assembly (text, then calls), and a row with no domain stamps its model key", async () => {
    const turn = await foldProviderStream(events([...fakeToolCallTurn([{ id: "c1", name: "lookup", input: { q: 1 } }], { text: "Checking." }).slice(0, -1), { type: "native_state", items: ["d"] }, { type: "done", stopReason: "tool_use" }]));
    const message = assembledToMessage(turn, OPENROUTER);
    expect(message.content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "c1", name: "lookup", input: { q: 1 } },
    ]);
    expect(message.nativeState).toEqual({ family: "openai", continuationDomain: "openrouter/anthropic/claude-sonnet-5.5", items: ["d"] });
  });

  test("a text-only turn with no reasoning blocks is a plain string, as in the engine's history", async () => {
    const turn = await foldProviderStream(events(fakeTextTurn("plain")));
    expect(assembledToMessage(turn, OPENROUTER).content).toBe("plain");
  });

  test("stamping never fabricates state", () => {
    const turn: AssembledTurn = { kind: "text", text: "x" };
    expect(stampNativeState(turn, ANTHROPIC)).toBe(turn);
  });
});

describe("createFakeProviderAdapter (Node-usable)", () => {
  test("plays scripted turns in order and records each request", async () => {
    const adapter = createFakeProviderAdapter({ turns: [fakeToolCallTurn([{ id: "c1", name: "t", input: {} }]), (req) => fakeTextTurn(`saw ${req.messages.length}`)] });
    const first = await foldProviderStream(adapter.streamTurn({ model: "m", messages: [{ role: "user", content: "go" }] }, {} as never));
    expect(first.kind).toBe("tool_use");
    const second = await foldProviderStream(adapter.streamTurn({ model: "m", messages: [{ role: "user", content: "go" }, assembledToMessage(first, OPENROUTER)] }, {} as never));
    expect(second.kind === "text" && second.text).toBe("saw 2");
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.played).toBe(2);
  });

  test("past the script: a typed bad_request; an aborted signal: a typed aborted error", async () => {
    const adapter = createFakeProviderAdapter({ turns: [fakeTextTurn(["a", "b"])], eventDelayMs: 5 });
    const controller = new AbortController();
    const pending = foldProviderStream(adapter.streamTurn({ model: "m", messages: [], signal: controller.signal }, {} as never), { signal: controller.signal });
    controller.abort();
    const aborted = (await pending.catch((e: unknown) => e)) as ProviderStreamError;
    expect(aborted.error.code).toBe("aborted");
    const past = (await foldProviderStream(adapter.streamTurn({ model: "m", messages: [] }, {} as never)).catch((e: unknown) => e)) as ProviderStreamError;
    expect(past.error.code).toBe("bad_request");
  });
});
