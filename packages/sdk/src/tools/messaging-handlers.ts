// WINTER'S THREE MESSAGING HANDLERS — the ones the official branch's `toolAliases` redirect the
// model's native `SendMessage`/`ListAgents` into, and the ones the Winter branch registers under its
// own canonical names (WS-14 §11's "registered identically into BOTH SDK branches").
//
// THE ALIAS IS THE WHOLE REASON THE SCHEMAS ARE MIRRORED EXACTLY. "Aliasing does not change the
// model-visible schema": with `SendMessage` aliased, the runtime still advertises the NATIVE
// `SendMessage` schema and the model emits a native block — which arrives HERE. So "handlers MUST
// accept the native argument schemas exactly", and a handler that quietly accepted an extra field
// would be a second, undocumented schema reachable only through the alias.
//
// WHAT THESE HANDLERS ARE NOT: the router. They validate, they name the caller, they render the
// outcome. Resolution, policy, the ledger and the adapters are all behind the PORT, once, for both
// hosts — which is what makes the two branches' behaviour the same behaviour rather than the same
// intention.
//
// THE RESULT SHAPE IS `{ text, isError? }` AND EACH HOST WRAPS IT (ruling P-4). The Winter runtime
// wants `{ output, isError }`; the router's in-process MCP server wants `{ content: [{type:"text"}] }`.
// Returning either one here would make the other host unwrap and rewrap a shape it never wanted.
import type { DeliveryOutcome } from "../messaging/index.ts";
// The listing renderer is the core's own (WS-10 §10.2's exact line format), reached directly rather
// than re-implemented: a second formatter is a second answer to "what does the model see".
import { formatListing } from "../messaging/router.ts";

import { acceptNativeListAgentsArgs, acceptNativeReadNotificationsArgs, acceptNativeSendMessageArgs, deriveSendMessageSummary } from "./accept.ts";
import { callerAddress, type MessagingToolPort } from "./port.ts";

/**
 * WHO IS CALLING — bound at registration, never read out of the arguments.
 *
 * The standing MCP server is materialized per session (WS-14 §11), so the caller is known when the
 * handler is built. Taking it from the ARGUMENTS instead would make the sender's identity something
 * a model could write, and every fence in the messaging core — the owning-parent rule, the
 * self-target refusal, WS-10 §13's sender class, WS-15 §6.2's dedupe key — is keyed on it.
 *
 * `toolUseId` is the second half of WS-10 §12's retry key, and it is OPTIONAL because a host that
 * cannot supply one exists: it gets no dedupe, stated at the door rather than faked with a
 * stable-looking key that would make two different messages one.
 */
export interface WinterToolCaller {
  sessionId: string;
  agentId?: string;
  toolUseId?: string;
}

/** The host-neutral tool result: one text body, plus whether the model should read it as a failure. */
export interface WinterToolResult {
  text: string;
  isError?: boolean;
}

export type WinterToolHandler = (args: unknown, extra?: unknown) => Promise<WinterToolResult>;

export interface MessagingToolHandlers {
  sendMessage: WinterToolHandler;
  listAgents: WinterToolHandler;
  readNotifications: WinterToolHandler;
}

/**
 * WS-10 §12's RETRY KEY, on the official branch — and it exists, which was not known until it was
 * measured.
 *
 * §12 wants a message id derived from (sender session, TOOL-CALL id) so "a retry allocates the SAME
 * id" and returns the stored outcome instead of starting a second turn. On the Winter branch the
 * caller binds `toolUseId` at registration. On the official branch the handler is inside the
 * vendor's in-process MCP server, where the only per-call channel is the second argument the vendor
 * passes — and the reasonable expectation was that it carries MCP request context (a JSON-RPC
 * request id, `_meta`) rather than an Anthropic-API `tool_use_id`, which is one layer up.
 *
 * THE PINNED RUNTIME BRIDGES THEM. Measured on 0.3.250: `extra._meta["claudecode/toolUseId"]` is the
 * exact id the model emitted. So the official branch gets a real §12 key rather than depending on
 * the rapid-repeat guard, and the vendor's own namespaced `_meta` name is read rather than guessed.
 *
 * A VENDOR-NAMESPACED KEY IS NEVER REBRANDED (WS-01 §5): `claudecode/toolUseId` is the vendor's name
 * for the vendor's field, exactly like `CLAUDE_CONFIG_DIR`. It is read defensively — an absent or
 * non-string value simply falls back to the bound caller's id — because a future pin may move it,
 * and losing the key must degrade to today's behaviour rather than to a crash.
 */
export const VENDOR_TOOL_USE_ID_META_KEY = "claudecode/toolUseId";

export function toolUseIdFromExtra(extra: unknown): string | undefined {
  if (typeof extra !== "object" || extra === null) return undefined;
  const meta = (extra as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const id = (meta as Record<string, unknown>)[VENDOR_TOOL_USE_ID_META_KEY];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Outcomes that mean "this did not happen, and the model should do something else" (ruling P-4).
 *
 * Both branches now mark these `isError: true`. The Winter runtime used to return every outcome as
 * an ordinary success and let the model infer failure from the JSON — which is exactly the reading a
 * model skips when the tool result looks like it worked.
 */
const MODEL_FACING_FAILURES: ReadonlySet<DeliveryOutcome["status"]> = new Set(["refused", "ambiguous", "not_found", "unavailable"]);

function text(body: string, isError = false): WinterToolResult {
  // `isError` is OMITTED on success rather than set to `false`: a host that spreads this into its own
  // result shape must not have an explicit `false` overwrite its own default.
  return { text: body, ...(isError ? { isError: true } : {}) };
}

export function createMessagingToolHandlers(port: MessagingToolPort, caller: WinterToolCaller | (() => WinterToolCaller)): MessagingToolHandlers {
  const identity = (): WinterToolCaller => (typeof caller === "function" ? caller() : caller);

  return {
    async sendMessage(rawArgs, extra) {
      const accepted = acceptNativeSendMessageArgs(rawArgs);
      if (!accepted.ok) return text(accepted.reason, true);
      const bound = identity();
      // THE PER-CALL TOOL-USE ID WINS. On the official branch the caller is bound once at
      // registration and cannot know it; the vendor's `extra` carries the id of THIS call, which is
      // exactly what §12's retry key is derived from. On the Winter branch there is no `extra` and
      // the bound value is already the right one, so this is additive in both directions.
      const perCall = toolUseIdFromExtra(extra);
      const who: WinterToolCaller = perCall === undefined ? bound : { ...bound, toolUseId: perCall };
      const summary = deriveSendMessageSummary(accepted.args.summary, accepted.args.message);
      const result = await port.sendDetailed({
        from: callerAddress(who),
        to: accepted.args.to,
        body: accepted.args.message,
        ...(summary === undefined ? {} : { summary }),
        ...(accepted.args.notify_when_idle === undefined ? {} : { notifyWhenIdle: accepted.args.notify_when_idle }),
        ...(who.toolUseId === undefined ? {} : { originToolCallId: who.toolUseId }),
      });
      // WS-10 §10.1: the result "reports success/message and MAY include a message ID, routing/receipt
      // information … or a CLASSIFIED FAILURE" — so the typed outcome IS the result, rendered whole.
      // The supplementary `notify` fact rides beside it rather than as an eleventh outcome status,
      // which is the shape the shared core already chose for a combined call.
      const payload = result.notify === undefined ? result.outcome : { ...result.outcome, notify: result.notify };
      return text(JSON.stringify(payload), MODEL_FACING_FAILURES.has(result.outcome.status));
    },

    async listAgents(rawArgs) {
      const accepted = acceptNativeListAgentsArgs(rawArgs);
      if (!accepted.ok) return text(accepted.reason, true);
      const rows = await port.listReachable({ from: callerAddress(identity()) });
      // WS-10 §10.2: "Output is EXACTLY `{ listing: string }`" — one string field, and nothing else.
      // The rows behind it are never enumerated as structured output here, and an exited transcript
      // is never among them: the listing view drops exited sessions by construction. The caller's own
      // row is dropped by the PORT (both hosts' `listReachable` do it), never re-filtered here.
      return text(JSON.stringify({ listing: formatListing(rows) }));
    },

    async readNotifications(rawArgs) {
      const accepted = acceptNativeReadNotificationsArgs(rawArgs);
      if (!accepted.ok) return text(accepted.reason, true);
      const { notifications, remaining } = port.readNotifications(identity().sessionId);
      return text(JSON.stringify({ notifications, remaining }));
    },
  };
}
