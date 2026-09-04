import { randomUUID } from "node:crypto";
import { WinterRpcError, WinterRpcTimeoutError, type ControlRequestFrame, type ControlResponseFrame } from "@yanlinglabs/winter-agent-sdk";
import type { FrameSink } from "../protocol/channel.ts";

export interface RpcBridge {
  // Writes { type: "control_request", requestId, subtype, payload } to `output` (runtime->host,
  // WS-04 §3.1) and resolves with the correlated response's payload. `requestId` defaults to a
  // fresh randomUUID(); pass `opts.requestId` when the caller's payload ITSELF carries a requestId
  // field the far side will echo back out-of-band (Task 8: PermissionRequestPayload.requestId,
  // read by a canUseTool callback and handed to query.__internal.respondPermission) — the envelope
  // id and the payload's own id must be the SAME value, or a correctly-behaving out-of-band
  // responder writes a control_response keyed by an id this bridge never issued, `handleResponse`
  // drops it as unknown, and this promise never settles (found by review: two independently-minted
  // UUIDs looked fine until a test used a REAL bridge instead of a hand-rolled fake that happened
  // to reuse one id for both). `opts.timeoutMs` omitted means NO park timeout — WS-04 §3's
  // permission-class RPCs wait indefinitely by design; only pass a timeout for a subtype the spec
  // actually pins a bound for.
  request<T = unknown>(subtype: string, payload: unknown, opts?: { timeoutMs?: number; requestId?: string }): Promise<T>;
  // Routes a host->runtime control_response to its correlated pending request. Returns false (and
  // never throws) for a requestId this bridge never issued, or one that already settled (a
  // timed-out request's late answer) — a stale response must never kill the run (WS-04).
  handleResponse(frame: ControlResponseFrame): boolean;
  // NEW-2 (P4 residual round): "is this id one of MY still-pending requests?", answered WITHOUT the
  // side effects of `handleResponse` -- no settle, and no stderr line for a miss. The pump needs to
  // ask that question before it decides whether an answer belongs to this run or to one of its
  // children (RULING P4-I's roster), and asking it through `handleResponse` meant every
  // child-routed answer logged "dropping control_response for unknown or already-settled requestId"
  // on the SUCCESS path -- a misleading diagnostic that also masked the genuine unclaimed case the
  // message exists to report.
  ownsRequest(requestId: string): boolean;
  // Task 8 (termination edge, WS-04 §3's no-park-timeout combined with P2-B's inverted pump
  // direction): rejects every still-pending request. Call this when the underlying transport is
  // PROVABLY dead (the pump's input hit true EOF, not just end_input) — a no-timeout RPC like
  // "permission" would otherwise park runEngine forever, since no control_response can physically
  // arrive once nothing is left to route one. A rejected request already means "no opinion" to its
  // caller (prompt-stage.ts's catch maps ANY rejection to null → deny, WS-07 §6.1), so this turns an
  // unreachable hang into a clean, spec-consistent denial and lets the run exit.
  //
  // T10 addition: also latches the bridge CLOSED — every `request()` call from this point forward
  // rejects immediately instead of registering and parking (see that method's own comment). Once the
  // transport is provably dead, a NEW request issued after this call (e.g. a SessionEnd hook RPC
  // that races the pump's teardown) is exactly as unanswerable as one that was already pending when
  // this fired; there is no reason to make it wait out its own per-hook timeout to find that out.
  // Idempotent — safe to call more than once.
  rejectAllPending(err: unknown): void;
  // Finding 10 (P2 fix-wave, NIT): removes ONE pending entry without settling its promise either
  // way (never resolve, never reject) — the caller has ALREADY moved on by the time it calls this
  // (runner.ts's own per-hook timeout already raced ahead and resolved its own await), so there is
  // nothing left to notify; this exists purely to free the map slot so (a) a long session with many
  // timed-out hooks doesn't accumulate entries forever, and (b) a very-late host answer for this
  // exact requestId resolves via the SAME safe "unknown requestId" path handleResponse already gives
  // every other stale response, rather than quietly resolving/rejecting a promise nobody is awaiting
  // anymore. A requestId that is already unknown (never issued, already settled, or already
  // cancelled) is a silent no-op — never throws.
  cancel(requestId: string): void;
}

interface PendingRpc {
  resolve(payload: unknown): void;
  reject(err: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
}

// Task 2 (WS-04 §3.1, direction inversion): the runtime's half of the bidirectional control-RPC
// envelope. Until this task every control_request flowed host->runtime (interrupt/end_input,
// engine.ts's pump); this is the mirror image — the RUNTIME writes control_request frames to
// `output` and awaits the host's control_response, correlated by requestId. Tasks 8/10 build the
// real permission/hook RPCs on top of this; Task 2's own exercise of it is the rpcprobe
// test-provider arm (see engine.ts's round loop and provider/mock.ts).
//
// query.ts's wrapper has its OWN, separate correlation map for the opposite direction
// (host-originated interrupt/setPermissionMode awaiting the runtime's ack) — not this function.
// The two are never merged: this factory is runtime-side (packages/runtime), and the sdk package
// never imports the runtime (WS-02 §3), even though the shape rhymes.
export function createRpcBridge(output: FrameSink): RpcBridge {
  const pending = new Map<string, PendingRpc>();
  // T10 (WS-08 §10 lifecycle wiring): once rejectAllPending has fired, the transport is PROVABLY
  // dead (per that method's own doc comment) — any request issued AFTER that point (e.g. a
  // SessionEnd hook RPC racing the pump's true-EOF teardown in single-shot mode, where the
  // wrapper's readLoop has already stopped reading stdout entirely once it saw the turn's terminal
  // result) can NEVER be answered no matter how long it waits. Without this flag such a request
  // would sit in `pending` until the RUNNER's own per-hook timeout eventually fires it (up to the
  // 30s observational default) — turning an ordinary single-shot query into a multi-second stall
  // whenever any hook is configured. Rejecting immediately is strictly correct, not just faster:
  // the outcome (a rejected bridge.request) is identical to what would eventually happen anyway.
  let closed = false;

  return {
    request<T = unknown>(subtype: string, payload: unknown, opts?: { timeoutMs?: number; requestId?: string }): Promise<T> {
      if (closed) {
        return Promise.reject(new WinterRpcError("connection_closed", `rpc bridge is closed: cannot issue a '${subtype}' request`));
      }
      const requestId = opts?.requestId ?? randomUUID();
      return new Promise<T>((resolve, reject) => {
        const entry: PendingRpc = { resolve: resolve as (payload: unknown) => void, reject };
        if (opts?.timeoutMs !== undefined) {
          const timeoutMs = opts.timeoutMs;
          entry.timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new WinterRpcTimeoutError(subtype, timeoutMs));
          }, timeoutMs);
          entry.timer.unref?.();
        }
        pending.set(requestId, entry);
        const frame: ControlRequestFrame = { type: "control_request", requestId, subtype, payload };
        output.write(frame);
      });
    },
    ownsRequest(requestId: string): boolean {
      return pending.has(requestId);
    },
    handleResponse(frame: ControlResponseFrame): boolean {
      const entry = pending.get(frame.requestId);
      if (!entry) {
        // Host-originated and possibly STALE (this bridge's own timeout already fired and removed
        // the entry) — dropped, never a crash, never a second response-to-a-response. WS-04: a
        // stale response must never kill the run.
        console.error(`winter: rpc bridge: dropping control_response for unknown or already-settled requestId '${frame.requestId}'`);
        return false;
      }
      pending.delete(frame.requestId);
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      if (frame.ok) {
        entry.resolve(frame.payload);
      } else {
        entry.reject(new WinterRpcError(frame.error?.code ?? "unknown_error", frame.error?.message ?? "control request failed"));
      }
      return true;
    },
    rejectAllPending(err: unknown): void {
      closed = true; // idempotent: a second call finds an already-empty `pending` and is a no-op
      for (const entry of pending.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.reject(err);
      }
      pending.clear();
    },
    cancel(requestId: string): void {
      const entry = pending.get(requestId);
      if (entry === undefined) return; // already unknown -- silent no-op, see this method's own doc comment
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      pending.delete(requestId);
      // Deliberately NEITHER resolve() NOR reject() -- the caller has already moved on by the time
      // it calls cancel() (its own timer raced ahead); settling this promise now would just be
      // resolving/rejecting something nobody is awaiting anymore.
    },
  };
}
