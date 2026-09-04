// Task 10: createBridgeHookInvoker — unit-tested against a FAKE RpcBridge (no real
// process/transport), mirroring prompt-stage.test.ts's own regime for the identical reason: the
// end-to-end wire proof lives in the equivalence suite (transport-equivalence.test.ts), not here.
// This file's job is purely "does the invoker call bridge.request with the right subtype/payload/
// requestId, and does it pass through resolve/reject faithfully."
import { test, expect } from "bun:test";
import { WinterRpcError } from "@yanlinglabs/winter-agent-sdk";
import type { RpcBridge } from "../rpc/bridge.ts";
import { createBridgeHookInvoker } from "./bridge-invoker.ts";
import type { HookInvocationRequest } from "./runner.ts";

function fakeBridge(impl: (subtype: string, payload: unknown, opts?: { timeoutMs?: number; requestId?: string }) => Promise<unknown>): {
  bridge: RpcBridge;
  calls: Array<{ subtype: string; payload: unknown; opts?: { timeoutMs?: number; requestId?: string } }>;
  cancelled: string[];
} {
  const calls: Array<{ subtype: string; payload: unknown; opts?: { timeoutMs?: number; requestId?: string } }> = [];
  const cancelled: string[] = [];
  return {
    calls,
    cancelled,
    bridge: {
      request: (async (subtype: string, payload: unknown, opts?: { timeoutMs?: number; requestId?: string }) => {
        calls.push({ subtype, payload, ...(opts !== undefined ? { opts } : {}) });
        return impl(subtype, payload, opts);
      }) as RpcBridge["request"],
      ownsRequest: () => false,
    handleResponse: () => false,
      rejectAllPending: () => {},
      cancel: (requestId: string) => {
        cancelled.push(requestId);
      },
    },
  };
}

const baseRequest: HookInvocationRequest = {
  event: "PreToolUse",
  sessionId: "s1",
  policyVersion: "3",
  requestId: "req-1",
  hookId: "PreToolUse:sdk:0:0",
  toolName: "Bash",
  input: { command: "ls" },
};

test("invoke() sends the request over the bridge as a 'hook' control_request, with NO timeoutMs (the runner is the sole timeout authority)", async () => {
  const { bridge, calls } = fakeBridge(async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }));
  const invoker = createBridgeHookInvoker(bridge);
  const controller = new AbortController();
  await invoker.invoke(baseRequest, { signal: controller.signal });

  expect(calls.length).toBe(1);
  expect(calls[0]!.subtype).toBe("hook");
  expect(calls[0]!.payload).toEqual(baseRequest);
  expect(calls[0]!.opts?.timeoutMs).toBeUndefined();
});

test("the envelope requestId is forced to match request.requestId (T8's own review-fix precedent, reused)", async () => {
  const { bridge, calls } = fakeBridge(async () => ({}));
  const invoker = createBridgeHookInvoker(bridge);
  await invoker.invoke({ ...baseRequest, requestId: "distinct-req-id" }, { signal: new AbortController().signal });
  expect(calls[0]!.opts?.requestId).toBe("distinct-req-id");
});

test("resolves with whatever the bridge resolves, verbatim (runner.ts's own classifyRawOutput interprets it, not this file)", async () => {
  const raw = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } };
  const { bridge } = fakeBridge(async () => raw);
  const invoker = createBridgeHookInvoker(bridge);
  const result = await invoker.invoke(baseRequest, { signal: new AbortController().signal });
  expect(result).toEqual(raw);
});

test("a rejected bridge request (e.g. no 'hook' handler registered host-side) propagates as a rejection -- runner.ts's own invokeWithTimeout classifies this as {kind:'error'}, never a thrown surprise here", async () => {
  const { bridge } = fakeBridge(async () => {
    throw new WinterRpcError("unhandled_subtype", "no handler registered for control subtype 'hook'");
  });
  const invoker = createBridgeHookInvoker(bridge);
  let caught: unknown;
  try {
    await invoker.invoke(baseRequest, { signal: new AbortController().signal });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(WinterRpcError);
});

// Finding 10 (P2 fix-wave, NIT): the runner's own timeout fires opts.signal's abort event
// (invokeWithTimeout's `controller.abort()`) -- this invoker must free the bridge's own pending
// entry at that exact moment, rather than leaving it parked until run-end teardown.
test("Finding 10: an abort on opts.signal cancels the bridge entry for this exact requestId", async () => {
  const { bridge, cancelled } = fakeBridge(() => new Promise(() => {})); // never resolves -- only the abort matters here
  const invoker = createBridgeHookInvoker(bridge);
  const controller = new AbortController();
  void invoker.invoke(baseRequest, { signal: controller.signal }); // fire-and-forget: never settles
  expect(cancelled).toEqual([]);

  controller.abort();
  expect(cancelled).toEqual(["req-1"]);
});

test("Finding 10: NO abort -- the bridge entry is never cancelled (the happy path is unaffected)", async () => {
  const { bridge, cancelled } = fakeBridge(async () => ({}));
  const invoker = createBridgeHookInvoker(bridge);
  await invoker.invoke(baseRequest, { signal: new AbortController().signal });
  expect(cancelled).toEqual([]);
});
