import { randomUUID } from "node:crypto";
import { WinterRpcError, WinterRpcTimeoutError, type ControlRequestFrame, type ControlResponseFrame } from "@yanlinglabs/winter-agent-sdk";
import type { FrameSink } from "../protocol/channel.ts";

export interface RpcBridge {
  // Writes { type: "control_request", requestId: randomUUID(), subtype, payload } to `output`
  // (runtime->host, WS-04 §3.1) and resolves with the correlated response's payload. `opts.timeoutMs`
  // omitted means NO park timeout — WS-04 §3's permission-class RPCs wait indefinitely by design;
  // only pass a timeout for a subtype the spec actually pins a bound for.
  request<T = unknown>(subtype: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  // Routes a host->runtime control_response to its correlated pending request. Returns false (and
  // never throws) for a requestId this bridge never issued, or one that already settled (a
  // timed-out request's late answer) — a stale response must never kill the run (WS-04).
  handleResponse(frame: ControlResponseFrame): boolean;
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

  return {
    request<T = unknown>(subtype: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<T> {
      const requestId = randomUUID();
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
  };
}
