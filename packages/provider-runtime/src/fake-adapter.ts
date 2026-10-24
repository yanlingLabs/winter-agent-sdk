// 0.0.56: a FAKE `ProviderAdapter` for a host's own tests -- runs under Node and Bun alike.
//
// The package's other fakes are loopback HTTP servers (`startXaiChatFake`, `startXaiOauthFake`) and need
// `Bun.serve`. A host with its own agent loop needs something smaller: an adapter whose `streamTurn`
// plays a SCRIPT of normalized events, records every request it was handed, and honours the request's
// abort signal -- so the host's loop, the stream assembler (`foldProviderStream`) and the history
// renderer can be tested end to end with no network, no credentials and no Bun. Plain `async`
// generators and `setTimeout`, nothing else.
//
// Exported from `@yanlinglabs/winter-provider-runtime/testing`, never from the main barrel.
import type { ProviderProtocol, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import type { CredentialStatus, ModelCatalogResult, ProviderAdapter, ProviderError, ProviderEvent, ProviderFamily, TurnRequest } from "./types.ts";

/** One scripted turn: the events `streamTurn` yields, or a function computing them from the request. */
export type FakeTurnScript = readonly ProviderEvent[] | ((request: TurnRequest, index: number) => readonly ProviderEvent[]);

export interface FakeProviderAdapterOptions {
  /** The scripted turns, played in order -- one per `streamTurn` call. A call past the end yields a typed `bad_request` error. */
  turns: readonly FakeTurnScript[];
  id?: string;
  family?: ProviderFamily;
  protocol?: ProviderProtocol;
  /** A delay before each event, in ms (a streaming UI test). Default 0: events are yielded back to back. */
  eventDelayMs?: number;
}

export interface FakeProviderAdapter extends ProviderAdapter {
  /** Every request `streamTurn` was handed, in order, as handed (the `signal` included). */
  readonly requests: TurnRequest[];
  /** How many scripted turns have been consumed. */
  readonly played: number;
}

/** A complete text turn: `message_start`, the text in the given chunks, `usage`, `done`. */
export function fakeTextTurn(chunks: string | readonly string[], opts: { usage?: { inputTokens: number; outputTokens: number; reportedCostUsd?: number }; id?: string } = {}): ProviderEvent[] {
  const parts = typeof chunks === "string" ? [chunks] : chunks;
  return [
    { type: "message_start", ...(opts.id !== undefined ? { id: opts.id } : {}) },
    ...parts.map((text) => ({ type: "text_delta" as const, text })),
    { type: "usage", inputTokens: opts.usage?.inputTokens ?? 0, outputTokens: opts.usage?.outputTokens ?? 0, ...(opts.usage?.reportedCostUsd !== undefined ? { reportedCostUsd: opts.usage.reportedCostUsd } : {}) },
    { type: "done", stopReason: "end_turn" },
  ];
}

/** A complete tool-calling turn: optional leading text, each call with its JSON arguments, `done` with `tool_use`. */
export function fakeToolCallTurn(calls: ReadonlyArray<{ id: string; name: string; input: unknown }>, opts: { text?: string; usage?: { inputTokens: number; outputTokens: number } } = {}): ProviderEvent[] {
  return [
    { type: "message_start" },
    ...(opts.text !== undefined ? [{ type: "text_delta" as const, text: opts.text }] : []),
    ...calls.flatMap((call) => [
      { type: "tool_call_start" as const, id: call.id, name: call.name },
      { type: "tool_call_delta" as const, id: call.id, argumentsJsonDelta: JSON.stringify(call.input) },
      { type: "tool_call_end" as const, id: call.id },
    ]),
    { type: "usage", inputTokens: opts.usage?.inputTokens ?? 0, outputTokens: opts.usage?.outputTokens ?? 0 },
    { type: "done", stopReason: "tool_use" },
  ];
}

/** A turn that fails with the given provider error before producing anything (a refusal, a 429, an overflow). */
export function fakeErrorTurn(error: ProviderError): ProviderEvent[] {
  return [{ type: "error", error }];
}

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted === true) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * A scripted adapter. `streamTurn` records the request, then yields the next scripted turn's events; an
 * aborted signal ends the stream with an `aborted` error event (as a real adapter does), whether it was
 * aborted before the call or between two events. `capabilities` and `mapEffort` read the descriptor
 * they are handed, so a host's own capability checks run against real catalog rows.
 */
export function createFakeProviderAdapter(options: FakeProviderAdapterOptions): FakeProviderAdapter {
  const requests: TurnRequest[] = [];
  let played = 0;
  const delay = options.eventDelayMs ?? 0;
  const adapter: FakeProviderAdapter = {
    id: options.id ?? "fake.provider-adapter",
    version: "0.0.0-fake",
    family: options.family ?? "openai",
    protocol: options.protocol ?? "openai-chat-completions",
    requests,
    get played() {
      return played;
    },
    async validateCredential(): Promise<CredentialStatus> {
      return { ok: true };
    },
    async listModels(): Promise<ModelCatalogResult> {
      return { models: [], partial: false, cached: false, warnings: [] };
    },
    streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
      requests.push(req);
      const index = played++;
      const script = options.turns[index];
      return (async function* (): AsyncGenerator<ProviderEvent> {
        if (script === undefined) {
          yield { type: "error", error: { code: "bad_request", message: `fake adapter: no scripted turn ${index + 1} (${options.turns.length} scripted)`, retryable: false } };
          return;
        }
        const events = typeof script === "function" ? script(req, index) : script;
        for (const event of events) {
          await sleep(delay, req.signal);
          if (req.signal?.aborted === true) {
            yield { type: "error", error: { code: "aborted", message: "the request was aborted", retryable: false } };
            return;
          }
          yield event;
        }
      })();
    },
    mapEffort(effort: TurnRequest["effort"], model: WinterModelDescriptor) {
      if (effort === undefined) return { ok: true as const, value: undefined };
      const efforts = model.reasoning?.efforts ?? [];
      if (typeof effort === "string" && efforts.includes(effort)) return { ok: true as const, value: effort };
      return { ok: false as const, reason: `effort ${String(effort)} is not among ${model.key}'s listed efforts (${efforts.join(", ") || "none"})` };
    },
    capabilities(model: WinterModelDescriptor) {
      const members = model.reasoning?.continuationDomain?.value;
      const domain = model.reasoning === undefined || model.reasoning.continuation === "none" ? undefined : members !== undefined && members.length > 0 ? [...members].sort()[0]! : model.key;
      return { toolCalling: model.toolCalling.value, ...(domain !== undefined ? { continuationDomain: domain } : {}), readableState: model.reasoning?.readableState?.value ?? "none" };
    },
  };
  return adapter;
}
