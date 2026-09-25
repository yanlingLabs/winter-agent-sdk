// A TOOL'S INNER MODEL CALL -- shared by the two web tools, in a module that REGISTERS NOTHING.
//
// `WebFetch` digests a fetched page against the caller's prompt (ONE generation, no tools).
// `WebSearch` runs a bounded inner pass in which the model calls ONE function tool -- the search
// backend -- up to N times and then answers. Both are the same thing with a different number of
// rounds, so there is one helper, `runInnerModel`, and the presence of `request.tool` picks the shape.
//
// THE `advisor` TOOL IS THE ONLY EARLIER INNER CALL, AND IT HAS TWO DEFECTS THIS MODULE DOES NOT
// COPY. Both are invisible in a unit test of the tool and both matter in production:
//
//   1. ITS USAGE IS NEVER ACCOUNTED. Only the main loop's generations reach the session's cost
//      ledger, so an advisor call is free on paper -- it is missing from `total_cost_usd`, from
//      `modelUsage`, and from `maxBudgetUsd`'s arithmetic. Here EVERY inner generation's usage is
//      handed to the run's own accounting (`WebSessionRuntime.accountUsage`) the moment it returns,
//      so a loop that fails on round three has still paid for rounds one and two.
//   2. ABORT NEVER REACHES IT. It ignores its execution context, so an interrupted turn leaves the
//      reviewer generating to completion behind an abandoned await. Here `ctx.signal` rides every
//      provider request, is handed to the tool handler, and is RACED as well -- a provider (or a
//      scripted double) that ignores the signal still cannot hold an interrupted turn.
//
// NEVER THROWS FOR AN EXPECTED FAILURE. An executor that throws ends the whole turn, so no wiring,
// an unresolvable model, a missing credential, a provider error and an abort are all VALUES
// (`InnerModelFailure`) the executor turns into `isError` text. Only a genuine bug escapes.
//
// NO STREAMING, BY CONSTRUCTION: the request never carries a `sink`, so an auxiliary generation
// emits no `stream_event`s (the same rule the compaction summariser, the classifier and the advisor
// follow). Thinking is disabled -- this is an extraction pass, not a reasoning one.
//
// This module imports only TYPES and the session registry (which registers no tool), so importing it from `impl/web-fetch.ts` or `impl/web-search.ts`
// registers nobody else's tool (`tools/impl-isolation.test.ts`).
import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";
// TYPE-ONLY, and it has to be. `engine.ts` value-imports the advisor's executor (and with it the whole
// descriptor barrel), so a single VALUE import from it here would make importing this helper -- and
// therefore either web tool's impl file -- register every tool in the codebase. That is the exact
// coupling `tools/impl-isolation.test.ts` exists to forbid, and it is invisible in the suite because
// the barrel is always loaded there anyway. The one thing this module needed from the engine at
// runtime (`isProviderTurnError`) is two structural checks, reproduced below.
import type { ContentBlock, Provider, ProviderMessage, ProviderRequest, ProviderTurn, ProviderUsage } from "../../engine.ts";
import type { ToolExecutionContext } from "../registry.ts";
import { webSessionRuntimeFor, type WebSessionRuntime } from "../../web/session-runtime.ts";

/**
 * Which model runs the inner pass.
 *
 * `session` (the default) is the SESSION'S OWN live model: always resolvable, no second credential.
 * `tag` is a STATED model -- a provider-qualified key or a slot name -- resolved under the
 * cross-provider credential rule with `authRef` as the route's own credential. A stated tag that
 * cannot resolve is a typed failure, NEVER a fallback onto the session's model.
 */
export type InnerModelSelector = { kind: "session" } | { kind: "tag"; tag: string; authRef?: CredentialRef };

/** The ONE function tool the inner model may call. */
export interface InnerToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface InnerToolCallInfo {
  /** 1-based index of this handler call within the loop. */
  index: number;
  /** The inner model's own id for the call. */
  toolUseId: string;
  /** The turn's abort signal. A handler doing I/O must honour it. */
  signal?: AbortSignal;
}

/** Runs one inner tool call. Must RETURN an error (`isError: true`) rather than throw; a throw is caught and reported to the inner model as an error result. */
export type InnerToolHandler = (input: unknown, info: InnerToolCallInfo) => Promise<{ output: string; isError?: boolean }>;

export interface InnerModelRequest {
  /** Defaults to `{ kind: "session" }`. */
  model?: InnerModelSelector;
  /** The inner pass's own system prompt. Omitted entirely when absent -- never an empty string. */
  system?: string;
  /** The single user message. */
  prompt: string;
  /**
   * PRESENT -> the BOUNDED TOOL LOOP, every round `toolChoice: auto`. ABSENT -> one generation with no
   * tools.
   *
   * WS-23: ROUND 1 IS NO LONGER FORCED. It used to be sent with `toolChoice: {type: "tool", name}` so
   * the model could not answer from memory; Opus 5.5 and Fable 5.1 reject a forced choice (a documented
   * 400, downgraded to `auto` by the Anthropic adapter), so on those models the "guarantee" silently
   * became a suggestion. A caller that needs the tool to run at least once runs it itself before the
   * pass and hands the model the result (WebSearch's seed search does exactly that).
   */
  tool?: InnerToolSpec;
  /** Required with `tool`. */
  handler?: InnerToolHandler;
  /**
   * The most HANDLER calls the loop will make (every call in a parallel tool-use turn counts).
   * Calls beyond it are answered with a limit notice and never reach the handler, and the model gets
   * exactly ONE further generation to write its answer. Required with `tool`; values below 1 read as 1.
   */
  maxToolCalls?: number;
}

/**
 * The inner pass's transcript, IN STREAM ORDER -- what a caller assembles its output from. A
 * `tool_call` step carries the call AND its result, because every consumer needs them together and
 * in the position the call was made.
 */
export type InnerModelStep =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; toolUseId: string; input: unknown; output: string; isError: boolean; executed: boolean };

/**
 *   `not-wired`            no session runtime is registered for this call (a host wiring gap).
 *   `invalid-request`      `tool` without `handler`/`maxToolCalls` -- a CALLER bug, reported not thrown.
 *   `model-unresolvable`   a STATED model tag was refused; `detail` is the resolver's own code.
 *   `no-credential`        the model resolved but no credential exists for its provider.
 *   `provider-error`       the provider failed (HTTP error, refusal to serve, malformed stream).
 *   `aborted`              the turn was interrupted before or during the pass.
 */
export type InnerModelFailureCode = "not-wired" | "invalid-request" | "model-unresolvable" | "no-credential" | "provider-error" | "aborted";

export interface InnerModelFailure {
  ok: false;
  code: InnerModelFailureCode;
  /** Safe to show the model: never a credential, never provider opaque state. */
  message: string;
  /** The underlying typed code where there is one (`unknown-model`, `slot-unservable`, `rate_limit`, ...). */
  detail?: string;
  /** Whatever the pass produced before it failed -- a partial loop's searches are still real. */
  steps: InnerModelStep[];
  toolCalls: number;
}

export interface InnerModelSuccess {
  ok: true;
  /** Every text step joined by a blank line. For the single-shot shape this is simply the answer. */
  text: string;
  steps: InnerModelStep[];
  /** Handler calls actually made. */
  toolCalls: number;
  /** `answer`: the model ended with text. `tool-call-limit`: it was still calling the tool after its closing generation. */
  stoppedBy: "answer" | "tool-call-limit";
  /** The key usage was accounted under. */
  modelKey: string | undefined;
  /** The sum over every generation in the pass (already accounted; reported for the caller's own use). */
  usage: ProviderUsage;
}

export type InnerModelResult = InnerModelSuccess | InnerModelFailure;

/** What the loop needs from the session, narrowed so a test hands in three functions and no engine. */
export type InnerModelRuntime = Pick<WebSessionRuntime, "sessionModel" | "resolveAuxiliaryModel" | "accountUsage" | "budgetExceeded">;

/** The notice an over-limit call is answered with. Exported so a caller can recognise (and not re-report) it. */
export const INNER_TOOL_LIMIT_NOTICE = "The tool-call limit for this request has been reached. Do not call the tool again; answer now from the results you already have.";

/**
 * The `detail` a SESSION-BUDGET stop carries. A budget crossing is reported under the existing
 * `aborted` code (the pass was stopped BY the session, not by a failure -- and the code union the two
 * tools switch on does not grow), so this string is the ONLY thing that tells it from a genuine
 * interrupt. Exported so a consumer matches the constant, never its own spelling of it.
 */
export const INNER_MODEL_BUDGET_EXCEEDED_DETAIL = "budget-exceeded";

const ZERO_USAGE: ProviderUsage = { inputTokens: 0, outputTokens: 0 };

function addUsage(total: ProviderUsage, usage: ProviderUsage): ProviderUsage {
  const cacheRead = (total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  const cacheWrite = (total.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/**
 * The assistant message an inner tool round is replayed as.
 *
 * WS-23: IT CARRIES THE ROUND'S THINKING, in the order the model produced it. This used to be
 * `[text, ...calls]` alone, which dropped every thinking block -- harmless while thinking was off,
 * and a hard 400 on a row whose thinking cannot be turned off (Opus 5.5, Fable 5/5.1: the request's
 * `disabled` is rewritten to adaptive there, see the Anthropic adapter's `buildThinking`), where a
 * tool loop's last assistant turn must replay its thinking blocks unmodified. The stream order
 * (`turn.content`) is used when the provider reported one and it names exactly these calls -- the
 * same check `engine.ts`'s `inStreamOrder` makes, reproduced here because this module may not
 * value-import the engine (see the import note above); otherwise the thinking blocks lead, then the
 * text, then the calls.
 */
function replayedContent(turn: Extract<ProviderTurn, { kind: "tool_use" }>, text: string, calls: ReadonlyArray<{ id: string; name: string; input: unknown }>): ContentBlock[] {
  const content = Array.isArray(turn.content) ? turn.content : [];
  const orderedIds = content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
  if (content.length > 0 && orderedIds.length === calls.length && orderedIds.every((id, i) => id === calls[i]!.id)) return content;
  return [
    ...(turn.thinking?.blocks ?? []),
    ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
    ...calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
  ];
}

const ABORTED = Symbol("inner-model-aborted");

/** Resolves when `signal` aborts. The returned `dispose` removes the listener so a finished pass leaks nothing onto a long-lived turn signal. */
function abortRace(signal: AbortSignal | undefined): { aborted: Promise<typeof ABORTED>; dispose(): void } {
  if (signal === undefined) return { aborted: new Promise<typeof ABORTED>(() => {}), dispose() {} };
  let listener: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    listener = () => resolve(ABORTED);
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    aborted,
    dispose() {
      if (listener !== undefined) signal.removeEventListener("abort", listener);
    },
  };
}

/**
 * `engine.ts`'s `isProviderTurnError`, structurally (see the import note above for why it is not
 * imported): the engine's own failure class carries a marker so it is recognised across a package
 * boundary. Recognising it buys the HTTP STATUS and the typed CODE -- and nothing else. Its message
 * is NOT relayed: construction sites redact what they know to redact, but a transport-level failure's
 * text is whatever the network stack wrote, and that has been seen to carry a proxy URL with its
 * userinfo (`http://user:password@proxy:3128`). This value is shown to the MODEL and lands in the
 * transcript, so the rule is the same as for any other throw: a fixed sentence and the error's NAME.
 */
function isProviderFailure(err: unknown): err is Error & { status?: number } {
  return typeof err === "object" && err !== null && (err as { winterProviderFailure?: unknown }).winterProviderFailure === true && err instanceof Error;
}

/** Only an identifier-shaped name is quoted: `name` is a writable property, so it is not trusted to be one. */
function safeErrorName(err: unknown): string | undefined {
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  return typeof name === "string" && /^[A-Za-z_$][\w$]{0,63}$/.test(name) ? name : undefined;
}

/**
 * A failure as text the inner caller may show the model. NO thrown error's `.message` is relayed,
 * with ONE exception: a `WinterProviderResolutionError`, whose message is composed by this codebase's
 * own resolver from catalog ids (never from a network response) and is the only thing that tells the
 * user WHICH provider has no credential.
 */
function describeFailure(err: unknown): { code: InnerModelFailureCode; message: string; detail?: string } {
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  const detail = typeof code === "string" ? code : undefined;
  if (name === "WinterProviderResolutionError") {
    const message = err instanceof Error ? err.message : "the inner model's provider could not be resolved";
    return detail === "no-credential-for-provider" ? { code: "no-credential", message, detail } : { code: "model-unresolvable", message, ...(detail !== undefined ? { detail } : {}) };
  }
  const safeName = safeErrorName(err);
  if (isProviderFailure(err)) {
    const status = typeof err.status === "number" && Number.isFinite(err.status) ? `HTTP ${err.status}` : undefined;
    const facts = [status, safeName].filter((part): part is string => part !== undefined).join(", ");
    return { code: "provider-error", message: `the inner model's provider failed${facts.length > 0 ? ` (${facts})` : ""}`, ...(detail !== undefined ? { detail } : {}) };
  }
  return { code: "provider-error", message: `the inner model call failed with ${safeName ?? "an unknown error"}` };
}

/**
 * Runs a tool's inner model pass. See the module header for the contract; in one line: resolves the
 * model, threads the abort signal, accounts every generation's usage, and never throws for an
 * expected failure.
 *
 * `runtime` is for tests; an executor passes only `ctx` and the session's own registration is used.
 */
export async function runInnerModel(ctx: Pick<ToolExecutionContext, "sessionId" | "agentId" | "signal">, request: InnerModelRequest, runtime?: InnerModelRuntime): Promise<InnerModelResult> {
  const steps: InnerModelStep[] = [];
  let toolCalls = 0;
  const fail = (code: InnerModelFailureCode, message: string, detail?: string): InnerModelFailure => ({ ok: false, code, message, ...(detail !== undefined ? { detail } : {}), steps, toolCalls });

  const session = runtime ?? webSessionRuntimeFor(ctx);
  if (session === undefined) return fail("not-wired", "no web session runtime is registered for this session, so there is no model to run the inner pass on (a host wiring gap, not an input error)");
  if (request.tool !== undefined && (request.handler === undefined || request.maxToolCalls === undefined)) {
    return fail("invalid-request", "an inner tool loop needs a `handler` and a `maxToolCalls` bound alongside its `tool`");
  }

  // --- the model ------------------------------------------------------------------------------------
  const selector = request.model ?? { kind: "session" as const };
  let provider: Provider;
  let requestModel: string | undefined;
  let usageKey: string | undefined;
  let origin: ProviderMessage["origin"];
  // GUARDED, both arms. The production resolver deliberately RETHROWS anything that is not a typed
  // resolution refusal (a bug must not be dressed as one), and this function's contract is that
  // nothing expected-or-not escapes as a throw from HERE -- a throw ends the user's whole turn. Only
  // the error's NAME is exposed: its message is unvetted and has been seen to carry material.
  try {
    if (selector.kind === "session") {
      const live = session.sessionModel();
      provider = live.provider;
      requestModel = live.model;
      usageKey = live.model;
      origin = live.origin;
    } else {
      if (session.resolveAuxiliaryModel === undefined) {
        return fail("model-unresolvable", `the model "${selector.tag}" cannot be resolved: this session has no provider catalog to resolve a stated model against`, "no-catalog");
      }
      const resolution = session.resolveAuxiliaryModel(selector.tag, selector.authRef !== undefined ? { authRef: selector.authRef } : {});
      if (!resolution.ok) return fail("model-unresolvable", `the model "${selector.tag}" could not be resolved (${resolution.code}): ${resolution.message}`, resolution.code);
      provider = resolution.provider;
      // No `model` on the request: the built provider already IS this model, and its bridge sends the
      // provider's own model id when the request names none.
      requestModel = undefined;
      usageKey = resolution.modelKey;
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "an unknown error";
    return fail("model-unresolvable", `the inner model could not be resolved: the resolver failed with ${name}`, "resolver-threw");
  }

  const signal = ctx.signal;
  // A FUNCTION, not an inline read: `aborted` flips asynchronously, and TypeScript narrows an inline
  // property read across awaits as if it could not.
  const isAborted = (): boolean => signal?.aborted === true;
  const race = abortRace(signal);
  let usage: ProviderUsage = ZERO_USAGE;
  const messages: ProviderMessage[] = [{ role: "user", content: request.prompt }];
  const tool = request.tool;
  const maxToolCalls = Math.max(1, Math.floor(request.maxToolCalls ?? 1));

  const generate = async (): Promise<ProviderTurn | typeof ABORTED | { failure: InnerModelFailure }> => {
    if (isAborted()) return ABORTED;
    // THE SESSION'S BUDGET, checked before EVERY inner generation. The main loop checks
    // `maxBudgetUsd` only before its own requests, so without this an inner pass is the one place a
    // session could keep spending after crossing its ceiling -- up to the whole generation bound.
    // Reported as `aborted` (the pass was stopped by the session, not by a failure) with its own
    // `detail`, so the code union the two tools switch on does not grow.
    let overBudget = false;
    try {
      overBudget = session.budgetExceeded?.() === true;
    } catch {
      overBudget = false;
    }
    if (overBudget) return { failure: fail("aborted", "the inner model pass was stopped: this session has reached its spending limit", INNER_MODEL_BUDGET_EXCEEDED_DETAIL) };
    const input: ProviderRequest = {
      messages: [...messages],
      ...(request.system !== undefined && request.system.length > 0 ? { system: request.system } : {}),
      ...(tool !== undefined ? { tools: [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }], toolChoice: { type: "auto" as const } } : {}),
      ...(requestModel !== undefined ? { model: requestModel } : {}),
      thinking: { type: "disabled" },
      ...(signal !== undefined ? { signal } : {}),
    };
    try {
      const pending = provider.generate(input);
      // The losing side of the race is abandoned; without this its later rejection would surface as
      // an unhandled rejection long after the executor returned.
      pending.catch(() => {});
      const turn = await Promise.race([pending, race.aborted]);
      if (turn === ABORTED) return ABORTED;
      if (turn.usage !== undefined) {
        usage = addUsage(usage, turn.usage);
        // Accounted PER GENERATION, immediately: a pass that fails later has still spent this.
        session.accountUsage(usageKey, turn.usage);
      }
      return turn;
    } catch (err) {
      if (isAborted()) return ABORTED;
      const described = describeFailure(err);
      return { failure: fail(described.code, described.message, described.detail) };
    }
  };

  const textOf = (): string =>
    steps
      .filter((s): s is Extract<InnerModelStep, { kind: "text" }> => s.kind === "text")
      .map((s) => s.text)
      .join("\n\n");
  const succeed = (stoppedBy: InnerModelSuccess["stoppedBy"]): InnerModelSuccess => ({ ok: true, text: textOf(), steps, toolCalls, stoppedBy, modelKey: usageKey, usage });
  const abortedFailure = (): InnerModelFailure => fail("aborted", "the inner model pass was interrupted");

  try {
    // --- the single-shot shape ----------------------------------------------------------------------
    if (tool === undefined) {
      const turn = await generate();
      if (turn === ABORTED) return abortedFailure();
      if ("failure" in turn) return turn.failure;
      const text = turn.kind === "text" ? turn.text : (turn.text ?? "");
      if (text.length > 0) steps.push({ kind: "text", text });
      return succeed("answer");
    }

    // --- the bounded tool loop ----------------------------------------------------------------------
    const handler = request.handler!;
    let closing = false; // the ONE generation granted after the limit was reached
    // THE HARD BOUND ON GENERATIONS. `maxToolCalls` bounds HANDLER calls, and a handler call happens
    // only for a correctly-named call -- so a model that names an unknown tool every round never
    // advances that counter, and each of its rounds is a real, accounted generation. The bound is
    // N rounds of at least one call each, the closing generation, and one round of slack for a
    // mis-named call; past it the pass stops exactly as it does on a too-eager closing generation.
    const maxGenerations = maxToolCalls + 2;
    for (let round = 1; ; round++) {
      const turn = await generate();
      if (turn === ABORTED) return abortedFailure();
      if ("failure" in turn) return turn.failure;

      const text = turn.kind === "text" ? turn.text : (turn.text ?? "");
      if (text.length > 0) steps.push({ kind: "text", text });
      if (turn.kind === "text") return succeed("answer");
      // A tool-call turn that calls NOTHING is terminal: there is no result to feed back, so another
      // generation would be the same request again -- forever, for a model that keeps doing it.
      //
      // `calls` UNDEFINED (or any non-array) is the same case, reached by a TYPE VIOLATION a real
      // adapter can still commit -- a `tool_use` turn assembled from a stream that ended before any
      // call block closed. Read defensively: unguarded, `.length` throws a `TypeError` out of this
      // function (the `try` below has a `finally` and, by design, no blanket `catch`), and a throw
      // from an executor ends the user's whole turn.
      const calls = Array.isArray(turn.calls) ? turn.calls : [];
      if (calls.length === 0) return succeed("answer");
      // Still calling the tool on its closing generation, or at the generation bound: stop here. The
      // calls are NOT recorded as steps -- nothing ran and nothing was answered.
      if (closing || round >= maxGenerations) return succeed("tool-call-limit");

      const toolUse: ContentBlock[] = replayedContent(turn, text, calls);
      // `nativeState` rides with the assistant message so a family that needs its own opaque items
      // replayed beside a function call (and stamps them with its continuation domain) gets them;
      // `origin` lets the session's own renderer treat the message as in-domain.
      messages.push({ role: "assistant", content: toolUse, ...(origin !== undefined ? { origin } : {}), ...(turn.nativeState !== undefined ? { nativeState: turn.nativeState } : {}) });

      const results: ContentBlock[] = [];
      for (const call of calls) {
        let output: string;
        let isError: boolean;
        let executed = false;
        if (call.name !== tool.name) {
          output = `Error: unknown tool "${call.name}". The only tool available is "${tool.name}".`;
          isError = true;
        } else if (toolCalls >= maxToolCalls) {
          output = INNER_TOOL_LIMIT_NOTICE;
          isError = true;
        } else {
          if (isAborted()) return abortedFailure();
          toolCalls += 1;
          executed = true;
          try {
            const pending = handler(call.input, { index: toolCalls, toolUseId: call.id, ...(signal !== undefined ? { signal } : {}) });
            pending.catch(() => {});
            const answered = await Promise.race([pending, race.aborted]);
            if (answered === ABORTED) return abortedFailure();
            output = answered.output;
            isError = answered.isError === true;
          } catch (err) {
            if (isAborted()) return abortedFailure();
            // A handler is told to return its errors; one that throws anyway costs the inner model
            // this call, never the whole turn. The NAME only -- a handler's message is not vetted.
            output = `Error: the tool call failed (${err instanceof Error ? err.name : "unknown error"}).`;
            isError = true;
          }
        }
        steps.push({ kind: "tool_call", toolUseId: call.id, input: call.input, output, isError, executed });
        results.push({ type: "tool_result", tool_use_id: call.id, content: output, ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "tool", content: results });
      if (toolCalls >= maxToolCalls) closing = true;
    }
  } finally {
    race.dispose();
  }
}
