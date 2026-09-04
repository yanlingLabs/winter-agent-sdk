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
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

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
  request<T = unknown>(subtype: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

export type ElicitationAsker = (payload: ElicitationRequestPayload) => Promise<ElicitationResultPayload>;

const DETERMINISTIC_DECLINE: ElicitationResultPayload = { action: "decline" };

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
  return async (payload: ElicitationRequestPayload): Promise<ElicitationResultPayload> => {
    let raw: unknown;
    try {
      raw = await sender.request(MCP_ELICITATION_SUBTYPE, payload);
    } catch {
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

// The narrowest possible view of the two ElicitRequest param shapes this file actually reads --
// avoids importing the real SDK's own (non-exported-by-name) inferred zod type just to destructure
// four optional fields. Every optional field's own union explicitly includes `| undefined` (rather
// than the bare `field?: T` shorthand): the real SDK's zod-inferred type renders an optional field
// as `{ field: T | undefined }` (key always present, value possibly undefined), not
// `{ field?: T }` (key possibly absent) -- under this package's `exactOptionalPropertyTypes: true`
// those two are NOT structurally assignable to each other, so the explicit `| undefined` is load-
// bearing, not stylistic (found by the typechecker at this file's own call site, `params.mode` et
// al. below).
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

// Registers `ask` as the handler for every real `elicitation/create` request a connected `Client`
// receives from `serverName`. The caller (mcp/client.ts) is responsible for constructing `client`
// with `capabilities: { elicitation: {} }` -- omitting that capability makes the real SDK's own
// `setRequestHandler` throw synchronously ("Client does not support elicitation capability"),
// verified empirically against @modelcontextprotocol/sdk@1.30.0 before writing this file. Installed
// UNCONDITIONALLY (never gated on whether a sender was configured) so a connected server is NEVER
// left without a registered handler at the protocol level -- the deterministic-decline behavior
// lives inside `ask` itself (via `createElicitationAsker`), not in whether a handler exists at all;
// this is what guarantees "never a hang" all the way down to the wire, regardless of session
// configuration.
export function installElicitationHandler(client: Client, serverName: string, ask: ElicitationAsker): void {
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const payload = buildElicitationPayload(serverName, request.params);
    const result = await ask(payload);
    return result.content !== undefined ? { action: result.action, content: result.content } : { action: result.action };
  });
}
