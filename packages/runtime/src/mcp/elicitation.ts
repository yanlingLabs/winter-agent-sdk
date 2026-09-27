// Phase 4 Task 4 (Lane A), WS-09 §5: elicitation. A connected MCP server can ask the host/user for
// more information mid-call (the real `elicitation/create` MCP request). This file is the RUNTIME
// side of the bridge: it (a) translates a real MCP elicitation request into the wire payload T3's
// `Options.onElicitation` host callback expects (`packages/sdk/src/options.ts`'s own header pins
// that exact shape), (b) sends it over the injected `ElicitationSender` (structurally
// `Pick<RpcBridge, "request">` -- see this file's own header on why the dependency is this narrow),
// and (c) translates the host's answer -- or the no-sender/failure case -- back into a real MCP
// `ElicitResult` (`{action: "accept"|"decline"|"cancel", content?}`).
//
// WS-09 §5's MUST, restated: "When no appropriate callback is supplied, elicitation MUST be
// declined deterministically -- a defined decline result to the server, never a hang and never a
// fabricated answer." This file satisfies that MUST for BOTH of the two ways "no callback" can
// happen at the wire layer T3 already built (`packages/sdk/src/query.ts`):
//   1. No sender at all (this file's own `sender` argument is `undefined`) -- e.g. no MCP lifecycle
//      wiring exists for this run yet, or a test exercising the "absent callback" path directly.
//   2. A sender exists but the round trip itself resolves to "no answer" -- `Options.onElicitation`
//      absent host-side means query.ts's generic `unhandled_subtype` fallback answers
//      `{ok:false, error:{code:"unhandled_subtype",...}}`, which `RpcBridge.request` (rpc/bridge.ts)
//      turns into a REJECTED promise (`WinterRpcError`). Both cases collapse to the identical
//      decline here -- this file does not need to special-case the wire error code, only "did the
//      round trip produce a well-formed accept/decline/cancel answer, or not."
//
// Elicitation is user interaction, not tool authorization (WS-09 §5: "the two pipelines stay
// separate... an elicitation answer never approves a permission request", WS-07 §7.4). This file
// therefore imports NOTHING from permissions/** and never inspects/mutates any permission state --
// its entire contract begins and ends at producing an `ElicitResult`-shaped answer for the MCP
// protocol layer, structurally incapable of feeding a permission decision because it has no import
// path to one.
//
// Why the sender dependency is a narrow structural type, not the concrete `RpcBridge`
// (`../rpc/bridge.ts`): `RpcBridge` is constructed INSIDE `engine.ts`'s own `runEngine` closure
// (`const bridge = createRpcBridge(output)`, ~line 495) from a per-run `FrameSink` -- a lane-A
// module has no access to that closure and `engine.ts` is read-only for this lane (R4-10). Lane A's
// own `mcp/lifecycle.ts` is constructed OUTSIDE that closure (its real wiring into a live session's
// `EngineOptions.mcpServerStateSource`/`mcpControlSeam` is an OWED follow-up, see this task's own
// report). Depending on the narrow `ElicitationSender` shape (just the one method this file
// actually calls) rather than the concrete `RpcBridge` type means whoever performs that future
// wiring can hand this file the SAME `bridge` object `createRpcBridge` already returns -- it already
// structurally satisfies `ElicitationSender` -- without this package needing to import
// `rpc/bridge.ts`'s own types at all, and without constraining the future caller to construct a
// real `RpcBridge` just to satisfy a type this file doesn't otherwise need.
//
// WS-23 (MCP TS SDK v2, protocol revision 2026-07-28): ONE handler now answers BOTH ways a server can
// ask for input. On a 2025-era connection that is the server->client `elicitation/create` request it
// always was. On a 2026-07-28 connection the server instead answers `tools/call` (or
// `resources/read`, `prompts/get`) with an `input_required` result, and the v2 client's
// auto-fulfilment driver dispatches each embedded elicitation to the handler registered here, then
// retries the call -- so the host sees one callback shape whichever era the server negotiated, and
// every decline guarantee in this file holds for both. URL mode reaches the host the same way (the
// client declares it; see mcp/client.ts).
import type { Client, ElicitRequestParams } from "@modelcontextprotocol/client";

// T3's own wire payload shape (`packages/sdk/src/query.ts`'s `McpElicitationRequestPayload`,
// `packages/sdk/src/options.ts`'s `Options.onElicitation` request parameter) -- reproduced here
// rather than imported because the sdk package's own type is a private, unexported interface local
// to query.ts; this is the same field set, verified against that file directly. `title`/
// `displayName`/`description` are carried on the TYPE (matching `Options.onElicitation`'s own
// optional trio, doc-asserted upstream as mirroring `can_use_tool`'s identical three fields) but
// this file's own producer (`buildElicitationPayload` below) never populates them: they are
// display-affordance metadata the OFFICIAL runtime sources from its own internal permission-UI
// layer, which has no equivalent here -- the real MCP `elicitation/create` request this file
// receives carries no such fields at all (verified against the pinned `ElicitRequestParamsSchema`,
// derived-shapes-p4.md item (f)). Absent is an honest "not supplied," never a fabricated value.
export interface ElicitationRequestPayload {
  serverName: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
}

export type ElicitationAction = "accept" | "decline" | "cancel";

// Mirrors the real MCP `ElicitResult` shape (`content` only meaningful on "accept") and
// `Options.onElicitation`'s own return type exactly -- one shape for both the wire-round-trip
// answer and the final MCP-protocol response this file hands back to the connected server.
export interface ElicitationResultPayload {
  action: ElicitationAction;
  content?: Record<string, unknown>;
}

export const MCP_ELICITATION_SUBTYPE = "mcp_elicitation";

// The narrow dependency (see this file's own header) -- structurally satisfied by the real
// `RpcBridge` (rpc/bridge.ts) without importing it, and trivially fake-able in tests.
export interface ElicitationSender {
  request<T = unknown>(subtype: string, payload: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
}

/**
 * WS-27: `opts.signal` aborts when the elicitation stops mattering -- the MCP server cancelled its request,
 * or the tool call that raised it ended. The asker then stops waiting at once: the bridge sends the host a
 * `control_cancel_request` (which aborts `Options.onElicitation`'s own `options.signal`), a host answer that
 * arrives afterwards is dropped as an unknown request id, and the server is answered `cancel`.
 */
export type ElicitationAsker = (payload: ElicitationRequestPayload, opts?: { signal?: AbortSignal }) => Promise<ElicitationResultPayload>;

const DETERMINISTIC_DECLINE: ElicitationResultPayload = { action: "decline" };
// WS-27: the answer for an elicitation that was CANCELLED before the user decided -- not a decline, which
// would claim the user refused. The server that cancelled it ignores the answer anyway.
const CANCELLED: ElicitationResultPayload = { action: "cancel" };

function isElicitationAction(value: unknown): value is ElicitationAction {
  return value === "accept" || value === "decline" || value === "cancel";
}

// The single, deterministic decline shape every "no answer" path in this file returns -- WS-09 §5's
// MUST, satisfied structurally (one literal object, never synthesized ad hoc at each call site).
function toResultPayload(raw: unknown): ElicitationResultPayload {
  if (typeof raw !== "object" || raw === null) return DETERMINISTIC_DECLINE;
  const candidate = raw as { action?: unknown; content?: unknown };
  // Never a fabricated answer (WS-09 §5): a malformed/garbage host response (wrong action literal,
  // or none at all) declines rather than guessing or forwarding it verbatim to the server.
  if (!isElicitationAction(candidate.action)) return DETERMINISTIC_DECLINE;
  if (candidate.action !== "accept") return { action: candidate.action };
  const content = typeof candidate.content === "object" && candidate.content !== null ? (candidate.content as Record<string, unknown>) : undefined;
  return content !== undefined ? { action: "accept", content } : { action: "accept" };
}

// Builds the one function that answers every elicitation request THIS server connection receives.
// `sender` absent (case 1 of this file's own header) short-circuits to the decline literal with no
// round trip at all -- deterministic in the strongest sense: it can never hang, throw, or race a
// timeout, because there is nothing to await.
export function createElicitationAsker(sender: ElicitationSender | undefined): ElicitationAsker {
  if (!sender) {
    return async () => DETERMINISTIC_DECLINE;
  }
  return async (payload: ElicitationRequestPayload, opts?: { signal?: AbortSignal }): Promise<ElicitationResultPayload> => {
    const signal = opts?.signal;
    const cancelled = (): boolean => signal?.aborted === true;
    if (cancelled()) return CANCELLED;
    let raw: unknown;
    try {
      raw = await sender.request(MCP_ELICITATION_SUBTYPE, payload, signal !== undefined ? { signal } : undefined);
    } catch {
      if (cancelled()) return CANCELLED;
      // Case 2 of this file's own header: `unhandled_subtype` (no host callback registered),
      // `handler_threw` (the host callback threw), a timeout, or a dead transport -- every one of
      // these is "the round trip did not produce an answer," and every one declines identically.
      // Never inspect the error's own code/message: WS-09 §5 asks for ONE deterministic outcome
      // here, not a taxonomy of reasons to (still) decline.
      return DETERMINISTIC_DECLINE;
    }
    return toResultPayload(raw);
  };
}

// The narrowest possible view of the two ElicitRequest param shapes this file actually reads. Every
// optional field's own union explicitly includes `| undefined` (rather than the bare `field?: T`
// shorthand): the SDK's zod-inferred type renders an optional field as `{ field: T | undefined }`
// (key always present, value possibly undefined), not `{ field?: T }` (key possibly absent) -- under
// this package's `exactOptionalPropertyTypes: true` those two are NOT structurally assignable to each
// other, so the explicit `| undefined` is load-bearing, not stylistic.
interface RawElicitParams {
  message: string;
  mode?: "form" | "url" | undefined;
  url?: string | undefined;
  elicitationId?: string | undefined;
  requestedSchema?: Record<string, unknown> | undefined;
}

export function buildElicitationPayload(serverName: string, params: RawElicitParams): ElicitationRequestPayload {
  return {
    serverName,
    message: params.message,
    ...(params.mode !== undefined ? { mode: params.mode } : {}),
    ...(params.url !== undefined ? { url: params.url } : {}),
    ...(params.elicitationId !== undefined ? { elicitationId: params.elicitationId } : {}),
    ...(params.requestedSchema !== undefined ? { requestedSchema: params.requestedSchema } : {}),
  };
}

// The v2 params type is a form|url UNION (`requestedSchema` exists only on form, `url` only on URL
// mode), so the fields this file reads are narrowed here, once, by key presence -- never by trusting
// `mode` alone, which a form request may omit (the v2 client defaults it to "form" before this
// handler runs, but the raw union does not say so).
function rawElicitParamsOf(params: ElicitRequestParams): RawElicitParams {
  const p = params as { message: string; mode?: "form" | "url"; url?: string; elicitationId?: string; requestedSchema?: Record<string, unknown> };
  return {
    message: p.message,
    ...(p.mode !== undefined ? { mode: p.mode } : {}),
    ...(typeof p.url === "string" ? { url: p.url } : {}),
    ...(typeof p.elicitationId === "string" ? { elicitationId: p.elicitationId } : {}),
    ...(p.requestedSchema !== undefined ? { requestedSchema: p.requestedSchema } : {}),
  };
}

// Registers `ask` as the handler for every `elicitation/create` a connected `Client` receives from
// `serverName` -- a real server->client request (2025 era) or an embedded `input_required` request
// the v2 client auto-fulfils (2026-07-28; see this file's WS-23 note). v2 keys handlers by METHOD
// STRING rather than by v1's `ElicitRequestSchema` object, and wraps this one with request/result
// validation of its own. The caller (mcp/client.ts) is responsible for constructing `client` with an
// `elicitation` capability -- omitting it makes `setRequestHandler` throw synchronously ("Client
// does not support elicitation capability"), unchanged from v1. Installed UNCONDITIONALLY (never
// gated on whether a sender was configured) so a connected server is NEVER left without a registered
// handler at the protocol level -- the deterministic-decline behavior lives inside `ask` itself (via
// `createElicitationAsker`), not in whether a handler exists at all; this is what guarantees "never a
// hang" all the way down to the wire, regardless of session configuration.
//
// WS-27: CANCELLATION reaches the asker as one signal, aborted by whichever comes first --
//   - the MCP request's own (`ctx.mcpReq.signal`): the server sent `notifications/cancelled` for its
//     `elicitation/create`, or -- a 2026-07-28 `input_required` elicitation, which the v2 client fulfils
//     inside `callTool` -- the originating call's signal, which the SDK links to it;
//   - `callScope()`, when the caller gives one: the tool calls in flight on this connection when the
//     elicitation arrived (mcp/client.ts). A 2025-era server->client request carries no link to the call
//     that raised it, and a server need not cancel its own elicitation when its call is cancelled, so the
//     signal aborts once EVERY call that could have raised it has ended -- exact with one call in flight,
//     and never early with several.
export function installElicitationHandler(client: Client, serverName: string, ask: ElicitationAsker, callScope?: () => AbortSignal | undefined): void {
  client.setRequestHandler("elicitation/create", async (request, ctx) => {
    const payload = buildElicitationPayload(serverName, rawElicitParamsOf(request.params));
    const signals = [ctx?.mcpReq?.signal, callScope?.()].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    const result = await ask(payload, signal !== undefined ? { signal } : undefined);
    if (result.content === undefined) return { action: result.action };
    const content = toWireElicitContent(result.content);
    // The same "never forward garbage" rule `toResultPayload` applies to the action: content the
    // protocol cannot carry declines deterministically instead of reaching the server.
    return content !== undefined ? { action: result.action, content } : { action: DETERMINISTIC_DECLINE.action };
  });
}

type WireElicitValue = string | number | boolean | string[];

// WS-23: the spec's accepted-content values are FLAT -- a string, number, boolean or string array
// per field. The v2 SDK now types the handler's RETURN that way (v1's handler signature accepted the
// looser record this file used to pass through) and validates the result against it before sending.
// The host's answer arrives as an untyped record, so it is checked here rather than cast: one nested
// object from a host callback would otherwise surface to the server as an SDK validation error in
// place of an answer.
function toWireElicitContent(content: Record<string, unknown>): Record<string, WireElicitValue> | undefined {
  const out: Record<string, WireElicitValue> = {};
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) out[key] = value;
    else return undefined;
  }
  return out;
}
