/** Trusted immutable-bootstrap provider proxy. Not RuntimeConfig/env/NDJSON authority.
 * The native supervisor must supply an authenticated task-scoped private channel. */
import { randomUUID } from "node:crypto";
import type { ProviderAdapter, ProviderContext, ProviderEvent, ResolvedModel, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { adapterAsProvider, type AdapterProvider, type AdapterProviderOptions } from "../provider/bridge.ts";

export const GUEST_PROVIDER_LIMITS = Object.freeze({ requestBytes: 2 * 1024 * 1024, eventBytes: 256 * 1024, responseHeadroom: 4096, exchangeMs: 6000, cancelMs: 1000, activeInvocations: 8 });
export interface GuestProviderScope {
  homeId: string; workspaceId: string; sessionId: string; backendSessionId: string; taskId: string;
  incarnationId: string; bootId: string; leaseEpoch: number; grantRevision: number; accountRevision: number; modelRevision: number;
}
export interface GuestProviderSelection {
  providerId: string; modelKey: string; providerModelId: string; family: ProviderAdapter["family"]; protocol: ProviderAdapter["protocol"];
  continuationDomain?: string; capabilities: ReturnType<ProviderAdapter["capabilities"]>;
}
/** Owns bounded framing/channel admission outside the credential daemon. No automatic resend/reconnect. */
export interface GuestProviderPort { exchange(frame: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>; close(): void }
export interface GuestProviderClient { readonly scope: Readonly<GuestProviderScope>; readonly selection: Readonly<GuestProviderSelection>; close(): void }
const clients = new WeakMap<GuestProviderClient, ProviderAdapter>();
const errorEvent = (aborted = false): ProviderEvent => ({ type: "error", error: { code: aborted ? "aborted" : "network", message: aborted ? "guest provider request cancelled" : "guest provider channel unavailable", retryable: false } });
function encode(value: unknown, limit: number): Uint8Array {
  const body = Buffer.from(JSON.stringify(value)); if (body.length > limit) throw new Error("guest provider limit");
  const frame = Buffer.allocUnsafe(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4); return frame;
}
function decode(frame: Uint8Array): Record<string, unknown> {
  if (!(frame instanceof Uint8Array) || frame.byteLength < 5 || frame.byteLength > GUEST_PROVIDER_LIMITS.eventBytes + GUEST_PROVIDER_LIMITS.responseHeadroom + 4) throw new Error("guest provider frame");
  const data = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength); if (data.readUInt32BE(0) !== data.length - 4) throw new Error("guest provider frame");
  const value: unknown = JSON.parse(data.subarray(4).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("guest provider frame"); return value as Record<string, unknown>;
}
class InvocationRefused extends Error { constructor(readonly capacity: boolean) { super("guest provider invocation refused"); } }
const EVENTS = new Set(["message_start", "text_delta", "thinking_summary_delta", "thinking_exposed_delta", "native_thinking_block", "reasoning_progress", "tool_call_start", "tool_call_delta", "tool_call_end", "native_state", "usage", "rate_limit", "retry", "auth_status", "done", "error"]);
export function createGuestProviderClient(input: { scope: GuestProviderScope; selection: GuestProviderSelection; port: GuestProviderPort }): GuestProviderClient {
  const scope = Object.freeze({ ...input.scope }), selection = Object.freeze({ ...input.selection, capabilities: Object.freeze({ ...input.selection.capabilities }) }), port = input.port;
  let closed = false;
  const active = new Map<string, AbortController>();
  const close = (): void => { if (!closed) { closed = true; for (const controller of active.values()) controller.abort(); try { port.close(); } catch { /* No error contents or inferred termination proof. */ } } };
  const adapter: ProviderAdapter = {
    id: "winter-guest-provider-proxy-v1", version: "1", family: selection.family, protocol: selection.protocol,
    validateCredential: async () => ({ ok: false, code: "unsupported", message: "guest credentials unavailable" }),
    listModels: async () => { throw new Error("guest provider discovery unavailable"); },
    capabilities: () => ({ ...selection.capabilities }), mapEffort: effort => ({ ok: true, value: effort }),
    async *streamTurn(request: TurnRequest) {
      if (closed || request.model !== selection.providerModelId) { yield errorEvent(); return; }
      if (active.size >= GUEST_PROVIDER_LIMITS.activeInvocations) { yield { type: "error", error: { code: "rate_limit", message: "guest provider capacity unavailable", retryable: true } }; return; }
      const invocationId = randomUUID(), controller = new AbortController(); let sequence = 0, terminal = false;
      active.set(invocationId, controller);
      const onAbort = (): void => controller.abort(); request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted) controller.abort();
      const exchange = async (operation: "begin" | "next", turn?: Omit<TurnRequest, "signal">): Promise<Record<string, unknown>> => {
        if (controller.signal.aborted || closed) throw new Error("guest provider cancelled");
        const expected = sequence++, frame = encode({ version: 1, operation, invocationId, scope, sequence: expected, ...(turn ? { turn } : {}) }, GUEST_PROVIDER_LIMITS.requestBytes + GUEST_PROVIDER_LIMITS.responseHeadroom);
        let deadline: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
        try {
          const result = await Promise.race([port.exchange(frame, controller.signal), new Promise<never>((_, reject) => {
            abort = () => reject(new Error("guest provider cancelled")); controller.signal.addEventListener("abort", abort, { once: true });
            if (controller.signal.aborted) abort();
            deadline = setTimeout(() => { close(); reject(new Error("guest provider deadline")); }, GUEST_PROVIDER_LIMITS.exchangeMs);
          })]);
          if (closed || controller.signal.aborted) throw new Error("guest provider cancelled");
          const value = decode(result);
          if (value.version !== 1 || value.invocationId !== invocationId || value.sequence !== expected || !["accepted", "event", "pending", "closed", "refused"].includes(String(value.kind))) throw new Error("guest provider binding");
          if (value.kind === "refused" && value.code !== "authority_denied") throw new InvocationRefused(value.code === "capacity_busy" && operation === "begin");
          return value;
        } finally { if (deadline) clearTimeout(deadline); if (abort) controller.signal.removeEventListener("abort", abort); }
      };
      const cancel = async (): Promise<void> => {
        if (closed || sequence === 0) return;
        const expected = sequence++, cancellation = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined, received = false;
        try {
          const frame = encode({ version: 1, operation: "cancel", invocationId, scope, sequence: expected }, GUEST_PROVIDER_LIMITS.responseHeadroom);
          const result = await Promise.race([port.exchange(frame, cancellation.signal), new Promise<undefined>(resolve => { timer = setTimeout(() => { cancellation.abort(); resolve(undefined); }, GUEST_PROVIDER_LIMITS.cancelMs); })]);
          if (result === undefined) return; // Best effort; host retains uncertain invocation ownership.
          received = true; const value = decode(result);
          if (value.version !== 1 || value.invocationId !== invocationId || value.sequence !== expected || !["closed", "refused"].includes(String(value.kind))) close();
        } catch { if (received) close(); /* Transport cancellation failure alone is invocation-local. */ }
        finally { if (timer) clearTimeout(timer); cancellation.abort(); }
      };
      try {
        const { signal: _signal, ...turn } = request;
        const ack = await exchange("begin", turn); if (ack.kind !== "accepted") throw new Error("guest provider admission");
        for (;;) {
          const response = await exchange("next");
          if (response.kind === "pending") continue; // Same invocation/pending adapter operation, never a resend.
          if (response.kind === "closed") { if (!terminal) throw new Error("guest provider incomplete"); break; }
          if (response.kind !== "event" || !response.event || typeof response.event !== "object" || Array.isArray(response.event)) throw new Error("guest provider response");
          const event = response.event as ProviderEvent;
          if (!EVENTS.has(event.type)) throw new Error("guest provider event");
          terminal = event.type === "done" || event.type === "error";
          yield event;
          if (terminal) break;
        }
      } catch (error) {
        if (error instanceof InvocationRefused) { terminal = true; yield { type: "error", error: { code: error.capacity ? "rate_limit" : "network", message: error.capacity ? "guest provider capacity unavailable" : "guest provider invocation unavailable", retryable: error.capacity } }; }
        else { if (!controller.signal.aborted) close(); yield errorEvent(request.signal?.aborted); }
      }
      finally { request.signal?.removeEventListener("abort", onAbort); if (!terminal) { controller.abort(); await cancel(); } active.delete(invocationId); }
    },
  };
  const client: GuestProviderClient = Object.freeze({ scope, selection, close }); clients.set(client, adapter); return client;
}
export function assertGuestProviderClient(client: GuestProviderClient): void { if (!clients.has(client)) throw new Error("guest provider binding unavailable"); }
/** Actual bridge seam: full native_state/signature/thinking fold, no local provider fallback. */
export function guestProviderFor(client: GuestProviderClient, resolved: ResolvedModel, options: Pick<AdapterProviderOptions, "renderer" | "chain"> = {}): AdapterProvider {
  assertGuestProviderClient(client); const selected = client.selection;
  if (resolved.providerId !== selected.providerId || resolved.modelKey !== selected.modelKey || resolved.providerModelId !== selected.providerModelId || resolved.adapter.family !== selected.family || resolved.continuationDomain !== selected.continuationDomain) throw new Error("guest provider selection mismatch");
  const unavailable = async (): Promise<never> => { throw new Error("guest credential operation unavailable"); };
  const context: ProviderContext = { connection: { providerId: selected.providerId }, authRef: { kind: "none" }, credentials: { get: unavailable, set: unavailable, delete: unavailable }, stallTimeoutMs: 60_000, log: () => {} };
  return adapterAsProvider(resolved, context, { ...options, adapter: clients.get(client)! });
}
