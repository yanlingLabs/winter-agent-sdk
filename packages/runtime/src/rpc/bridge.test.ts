import { test, expect, spyOn } from "bun:test";
import type { WinterFrame, ControlRequestFrame } from "@yanlinglabs/winter-agent-sdk";
import { WinterRpcError, WinterRpcTimeoutError } from "@yanlinglabs/winter-agent-sdk";
import type { FrameSink } from "../protocol/channel.ts";
import { createRpcBridge } from "./bridge.ts";

function recordingSink(): { sink: FrameSink; written: WinterFrame[] } {
  const written: WinterFrame[] = [];
  return { sink: { write(f) { written.push(f); }, end() {} }, written };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("request/response correlation: two in-flight requests resolve correctly even when answered out of order", async () => {
  const { sink, written } = recordingSink();
  const bridge = createRpcBridge(sink);

  const p1 = bridge.request<{ x: number }>("subtypeA", { a: 1 });
  const p2 = bridge.request<{ x: number }>("subtypeB", { b: 2 });

  expect(written.length).toBe(2);
  const req1 = written[0] as ControlRequestFrame;
  const req2 = written[1] as ControlRequestFrame;
  expect(req1.type).toBe("control_request");
  expect(req1.subtype).toBe("subtypeA");
  expect(req1.payload).toEqual({ a: 1 });
  expect(req2.subtype).toBe("subtypeB");
  expect(req2.payload).toEqual({ b: 2 });
  expect(req1.requestId).not.toBe(req2.requestId); // distinct correlation ids

  // Answer the SECOND request first — out of order responses must still resolve the right promise.
  expect(bridge.handleResponse({ type: "control_response", requestId: req2.requestId, ok: true, payload: { x: 2 } })).toBe(true);
  expect(bridge.handleResponse({ type: "control_response", requestId: req1.requestId, ok: true, payload: { x: 1 } })).toBe(true);

  expect(await p2).toEqual({ x: 2 });
  expect(await p1).toEqual({ x: 1 });
});

test("ok:false response rejects with a typed WinterRpcError carrying the response's code and message", async () => {
  const { sink, written } = recordingSink();
  const bridge = createRpcBridge(sink);
  const p = bridge.request("permission", { toolName: "Bash" });
  const req = written[0] as ControlRequestFrame;

  bridge.handleResponse({ type: "control_response", requestId: req.requestId, ok: false, error: { code: "denied", message: "nope" } });

  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(WinterRpcError);
  expect((caught as WinterRpcError).code).toBe("denied");
  expect((caught as WinterRpcError).message).toBe("nope");
});

test("timeout fires only when opts.timeoutMs is given; an omitted timeout waits indefinitely (WS-04 permission-RPC rule)", async () => {
  const { sink, written } = recordingSink();
  const bridge = createRpcBridge(sink);

  const timedOut = bridge.request("hook", {}, { timeoutMs: 20 });
  let caught: unknown;
  try {
    await timedOut;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(WinterRpcTimeoutError);
  expect(caught).toBeInstanceOf(WinterRpcError); // a timeout IS an rpc error (code "timeout")

  // No timeoutMs at all: must NOT settle within a window well past the timeout case above.
  const parked = bridge.request("permission", {});
  let settled = false;
  parked.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await sleep(60);
  expect(settled).toBe(false);

  // Clean up: answer it so the test doesn't leave a dangling unhandled rejection.
  const req = written[1] as ControlRequestFrame;
  bridge.handleResponse({ type: "control_response", requestId: req.requestId, ok: true, payload: {} });
  await parked;
});

test("a late response for an already-timed-out request is dropped via the unknown-requestId path (never resolves/rejects twice)", async () => {
  const { sink, written } = recordingSink();
  const bridge = createRpcBridge(sink);
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const p = bridge.request("hook", {}, { timeoutMs: 10 });
    let caught: unknown;
    try {
      await p;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WinterRpcTimeoutError);

    const req = written[0] as ControlRequestFrame;
    // Late answer, arriving after the bridge already gave up and removed the pending entry.
    expect(bridge.handleResponse({ type: "control_response", requestId: req.requestId, ok: true, payload: {} })).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  } finally {
    errSpy.mockRestore();
  }
});

test("an unmatched control_response (no such requestId was ever issued) is dropped, logged to stderr, and returns false", () => {
  const { sink } = recordingSink();
  const bridge = createRpcBridge(sink);
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = bridge.handleResponse({ type: "control_response", requestId: "never-asked", ok: true, payload: {} });
    expect(result).toBe(false);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("never-asked");
  } finally {
    errSpy.mockRestore();
  }
});
