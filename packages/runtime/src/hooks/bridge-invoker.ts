// Task 10 (WS-08 §10): the bridge-backed `HookInvoker` — the swap point runner.ts's own header
// names ("T10 swaps in a bridge-backed implementation... without touching anything else in this
// file, because the seam's shape is exactly the §10 request/response contract"). Mirrors
// permissions/prompt-stage.ts's createBridgePromptStage exactly: same bridge, same "the caller's own
// requestId must become the envelope's correlation id" discipline (bridge.ts's own header — a
// mismatch here would mean handleResponse never finds this pending entry, and the promise would
// never settle).
//
// Unlike the "permission" RPC, there is no out-of-band "null now, answer later" escape for hooks
// (`HookCallback` returns `Promise<HookJSONOutput>`, never a nullable result) — so this invoker is
// simpler than createBridgePromptStage in one respect: no result-validation/null-handling branch is
// needed here at all. runner.ts's own `classifyRawOutput`/`interpretSyncOutput` already treat
// whatever comes back (including a malformed shape, or a rejected promise) exactly per WS-08 §8's
// failure matrix — this file's only job is "get the bytes there and back."
//
// NO opts.timeoutMs is passed to bridge.request here, deliberately: runner.ts's own
// `invokeWithTimeout` already races this call against its own hard timer (60s gating / 30s
// observational default) and aborts the SAME AbortSignal on timeout regardless of whether the real
// host-side callback honors it (runner.ts's own HookInvoker interface comment: "a backstop, not a
// trust assumption"). Adding a SECOND, bridge-level timeout here would just be a redundant,
// independently-tuned duplicate of that same policy — the runner is the sole timeout authority for
// hook invocations, exactly as its own seam contract already promises T10.
import type { HookInvocationRequest, HookInvoker } from "./runner.ts";
import type { RpcBridge } from "../rpc/bridge.ts";

export function createBridgeHookInvoker(bridge: RpcBridge): HookInvoker {
  return {
    async invoke(request: HookInvocationRequest, opts: { signal: AbortSignal }): Promise<unknown> {
      // `opts.signal` is a COURTESY only (see this file's own header) — nothing here needs to wire
      // it into bridge.request, which has no abort parameter of its own; the runner's hard timer is
      // what actually bounds this call, on both the invoker's promise and (via `signal.aborted`) the
      // far side, if it's listening.
      void opts;
      return bridge.request("hook", request, { requestId: request.requestId });
    },
  };
}
