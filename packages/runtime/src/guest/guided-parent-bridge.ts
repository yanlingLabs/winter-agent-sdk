/** Internal injected parent protocol. No native admission, profile activation or read authority. */
import { randomUUID } from "node:crypto";
import { parseRuntimeContextConfig, parseRuntimeContextRequest, parseRuntimeContextSnapshot,
  RUNTIME_CONTEXT_SUBTYPE, type ControlResponseFrame, type RuntimeContextConfig } from "@yanlinglabs/winter-agent-sdk";
import type { FrameSink } from "../protocol/channel.ts";
import type { RpcBridge } from "../rpc/bridge.ts";
import { RequiredContextError } from "../context/required-context.ts";
import type { RuntimeContextChannel } from "../context/runtime-context-channel.ts";
import { checkLinuxHostQueryFrame } from "./linux-host-query-profile.ts";

export const GUIDED_READER_SUBTYPE = "instruction_reader";
export const GUIDED_READER_FRAME_BYTES = 1024 * 1024;
export const GUIDED_PARENT_PENDING_MAX = 16;
export interface GuidedReaderRequest { readonly version: 1; readonly bindingId: string; readonly contextRequestId: string; readonly readId: string; }
export interface GuidedReaderResponse extends GuidedReaderRequest { readonly frame: string; }
export interface GuidedReaderOperation {
  result: Promise<GuidedReaderResponse>; drained: Promise<void>; cancel(): void;
}
export interface GuidedParentBridge extends RuntimeContextChannel {
  bind(bridge: RpcBridge): void;
  handleResponse(frame: unknown): "accept" | "drop";
  handleReaderRequest(frame: unknown): Promise<"accept" | "drop">;
  close(): void;
  diagnostics(): Readonly<{ closed: boolean; pendingContexts: number; readerDebt: number; uncertainReaderDebt: number }>;
}
const unavailable = (): RequiredContextError => new RequiredContextError("required_context_unavailable");
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !names.includes(key)) || names.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(property => !("value" in property))) throw unavailable();
  return Object.fromEntries(Object.entries(descriptors).map(([key, property]) => [key, property.value]));
}
function readerRequest(value: unknown): Readonly<GuidedReaderRequest> {
  const v = fields(value, ["version", "bindingId", "contextRequestId", "readId"]);
  if (v.version !== 1 || typeof v.bindingId !== "string" || !uuid(v.contextRequestId) || !uuid(v.readId) || v.contextRequestId === v.readId) throw unavailable();
  return Object.freeze(v) as unknown as Readonly<GuidedReaderRequest>;
}
function readerResponse(value: unknown, request: GuidedReaderRequest): Readonly<GuidedReaderResponse> {
  const v = fields(value, ["version", "bindingId", "contextRequestId", "readId", "frame"]);
  if (["version", "bindingId", "contextRequestId", "readId"].some(key => v[key] !== request[key as keyof GuidedReaderRequest]) || typeof v.frame !== "string"
    || Buffer.byteLength(v.frame, "utf8") > GUIDED_READER_FRAME_BYTES || !v.frame.endsWith("\n") || v.frame.slice(0, -1).includes("\n")
    || Buffer.from(v.frame, "utf8").toString("utf8") !== v.frame) throw unavailable();
  const object: unknown = JSON.parse(v.frame);
  if (!object || typeof object !== "object" || Array.isArray(object)) throw unavailable();
  // Only the outer correlation and bounded JSON transport are checked here. A future admitted
  // reader adapter must validate RuntimeSDK's owner/view/snapshot frame; these bytes grant nothing.
  return Object.freeze(v) as unknown as Readonly<GuidedReaderResponse>;
}
interface ReadState { request: GuidedReaderRequest; operation: GuidedReaderOperation; done: Promise<void>; cancel(): void; valid: boolean; drained: boolean; uncertain: boolean; }
interface ContextState { id: string; controller: AbortController; stopped: Promise<never>; stop(error: RequiredContextError): void; failure?: RequiredContextError; reader?: ReadState; }
/** All dependencies are trusted injections for internal/source tests. assertOwnerHeld is a
 * liveness callback, NOT a native capability. This module is not registered in any entry/profile. */
export function createGuidedParentBridge(options: {
  binding: RuntimeContextConfig; backendSessionId: string; cwd: string; assertOwnerHeld(): void;
  readerPort: { start(request: GuidedReaderRequest, options: { signal: AbortSignal }): GuidedReaderOperation };
  output: FrameSink; timeoutMs?: number; nextRequestId?: () => string;
}): GuidedParentBridge {
  const binding = parseRuntimeContextConfig(options.binding), backendSessionId = options.backendSessionId, cwd = options.cwd;
  parseRuntimeContextRequest({ bindingId: binding.bindingId, sessionId: backendSessionId, cwd, purpose: "generation", attempt: 1 });
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw unavailable();
  const assertOwner = options.assertOwnerHeld, startReader = options.readerPort.start.bind(options.readerPort), write = options.output.write.bind(options.output), nextId = options.nextRequestId ?? randomUUID;
  if (typeof assertOwner !== "function") throw unavailable();
  let bridge: RpcBridge | undefined, bound = false, closed = false;
  const contexts = new Map<string, ContextState>(), debt = new Set<ReadState>();
  const stopAll = (): void => { if (closed) return; closed = true; for (const state of contexts.values()) state.stop(unavailable()); };
  const held = (): void => { if (closed) throw unavailable(); try { assertOwner(); } catch { stopAll(); throw unavailable(); } };
  const reply = (frame: ControlResponseFrame): void => { held(); write(frame); };
  const channel: GuidedParentBridge = {
    bindingId: binding.bindingId,
    timeoutMs,
    bind(value) { held(); if (bound) throw unavailable(); bound = true; bridge = value; },
    close: stopAll,
    diagnostics() { return Object.freeze({ closed, pendingContexts: contexts.size, readerDebt: debt.size, uncertainReaderDebt: [...debt].filter(read => read.uncertain).length }); },
    async resolve(request, { signal }) {
      held();
      const payload = parseRuntimeContextRequest({ ...request, bindingId: binding.bindingId });
      if (payload.agentId !== undefined || payload.sessionId !== backendSessionId || payload.cwd !== cwd || signal.aborted || bridge === undefined
        || contexts.size >= GUIDED_PARENT_PENDING_MAX || debt.size >= GUIDED_PARENT_PENDING_MAX) throw unavailable();
      const id = nextId(); if (!uuid(id) || contexts.has(id) || bridge.ownsRequest(id) || [...contexts.values()].some(context => context.reader?.request.readId === id) || [...debt].some(read => read.request.readId === id)) throw unavailable();
      const controller = new AbortController(); let reject!: (error: RequiredContextError) => void, stopped = false;
      const state: ContextState = { id, controller, stopped: new Promise<never>((_, fail) => { reject = fail; }), stop(error) {
        if (stopped) return; stopped = true; state.failure = error; reject(error); controller.abort(); state.reader?.cancel();
      } };
      void state.stopped.catch(() => {}); contexts.set(id, state);
      const abort = (): void => state.stop(new RequiredContextError("required_context_cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => state.stop(new RequiredContextError("required_context_timed_out")), timeoutMs); timer.unref?.();
      try {
        held();
        const snapshot = await Promise.race([bridge.request(RUNTIME_CONTEXT_SUBTYPE, payload, { requestId: id, signal: controller.signal }), state.stopped]);
        held();
        if (state.reader === undefined) throw unavailable();
        await Promise.race([state.reader.done, state.stopped]); held();
        if (!state.reader.valid || !state.reader.drained || controller.signal.aborted) throw unavailable();
        return parseRuntimeContextSnapshot(snapshot);
      } catch (error) { const failure = state.failure ?? (error instanceof RequiredContextError ? error : unavailable()); state.stop(failure); throw failure; }
      finally { clearTimeout(timer); signal.removeEventListener("abort", abort); contexts.delete(id); }
    },
    handleResponse(value) {
      held(); if (bridge === undefined || !value || typeof value !== "object") throw unavailable();
      if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw unavailable();
      const descriptors = Object.getOwnPropertyDescriptors(value), idProperty = descriptors.requestId;
      if (!idProperty || !("value" in idProperty) || typeof idProperty.value !== "string") throw unavailable();
      const state = contexts.get(idProperty.value);
      let frame: ControlResponseFrame;
      try {
        if (Reflect.ownKeys(value).some(key => typeof key !== "string") || Object.values(descriptors).some(property => !("value" in property))) throw unavailable();
        frame = Object.fromEntries(Object.entries(descriptors).map(([key, property]) => [key, property.value])) as unknown as ControlResponseFrame;
      } catch { state?.stop(unavailable()); throw unavailable(); }
      if (state !== undefined) {
        try {
          if (!bridge.ownsRequest(frame.requestId, RUNTIME_CONTEXT_SUBTYPE)) { state.stop(unavailable()); return "drop"; }
          const response = fields(frame, frame.ok === true ? ["type", "requestId", "ok", "payload"] : ["type", "requestId", "ok", "error"]);
          if (response.type !== "control_response" || typeof response.ok !== "boolean") throw unavailable();
          if (response.ok) parseRuntimeContextSnapshot(response.payload);
          else { const error = fields(response.error, ["code", "message"]); if (error.code !== "required_context_unavailable" || error.message !== error.code) throw unavailable(); }
          held(); bridge.handleResponse(frame); return "accept";
        } catch { state.stop(unavailable()); throw unavailable(); }
      }
      if (!bridge.ownsRequest(frame.requestId, "permission")) return "drop";
      if (checkLinuxHostQueryFrame(frame, id => bridge!.ownsRequest(id, "permission")) === "drop") return "drop";
      held(); bridge.handleResponse(frame); return "accept";
    },
    async handleReaderRequest(value) {
      held(); if (bridge === undefined) throw unavailable();
      let state: ContextState | undefined;
      try {
        const frame = fields(value, ["type", "requestId", "subtype", "payload"]), request = readerRequest(frame.payload);
        state = contexts.get(request.contextRequestId);
        if (state === undefined || state.controller.signal.aborted) return "drop";
        if (frame.type !== "control_request" || frame.subtype !== GUIDED_READER_SUBTYPE || frame.requestId !== request.readId || request.bindingId !== binding.bindingId
          || state.reader !== undefined || contexts.has(request.readId) || bridge.ownsRequest(request.readId) || [...debt].some(read => read.request.readId === request.readId)) throw unavailable();
        held(); const operation = startReader(request, { signal: state.controller.signal });
        if (!operation || typeof operation.cancel !== "function" || !(operation.result instanceof Promise) || !(operation.drained instanceof Promise)) throw unavailable();
        let cancelled = false;
        const read: ReadState = { request, operation, done: Promise.resolve(), valid: false, drained: false, uncertain: false, cancel() {
          if (cancelled) return; cancelled = true; try { operation.cancel(); } catch { read.uncertain = true; }
        } };
        state.reader = read; debt.add(read);
        // Debt survives context cancellation/closure. Only the trusted operation's confirmed
        // drain fulfils it; rejection is uncertainty, never cleanup success.
        const drain = operation.drained.then(() => { read.drained = true; debt.delete(read); }, () => { read.uncertain = true; read.cancel(); state!.stop(unavailable()); throw unavailable(); });
        read.done = (async () => {
          try { const response = await operation.result; if (state!.controller.signal.aborted) throw unavailable(); held(); const result = readerResponse(response, request); read.valid = true; await drain; if (state!.controller.signal.aborted) throw unavailable(); held();
            reply({ type: "control_response", requestId: request.readId, ok: true, payload: result }); }
          catch { read.cancel(); state!.stop(unavailable()); throw unavailable(); }
        })(); void read.done.catch(() => {}); void drain.catch(() => {});
        await Promise.race([read.done, state.stopped]); held();
        return "accept";
      } catch { state?.stop(unavailable()); throw unavailable(); }
    },
  };
  return Object.freeze(channel);
}
