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

// Task 8 / review finding: prompt-stage.ts's PermissionRequestPayload carries its OWN `requestId`
// field (read back by a canUseTool callback and handed to query.__internal.respondPermission for
// the out-of-band escape) — that value MUST become the envelope's own correlation id, or an
// out-of-band response keyed by the payload's id is unroutable (handleResponse only knows the
// envelope id it itself issued). `opts.requestId` is the caller-supplied override that makes the
// two the same value; omitting it keeps the pre-existing freshly-minted-UUID default.
test("opts.requestId lets the caller pin the envelope's correlation id (Task 8 review fix: payload.requestId and the envelope id must be the SAME value)", async () => {
  const { sink, written } = recordingSink();
  const bridge = createRpcBridge(sink);

  const p = bridge.request("permission", { requestId: "caller-chosen-id" }, { requestId: "caller-chosen-id" });
  const req = written[0] as ControlRequestFrame;
  expect(req.requestId).toBe("caller-chosen-id");

  // An out-of-band responder that only ever sees the PAYLOAD's requestId (never the envelope
  // directly, exactly like a canUseTool callback) can still correlate correctly.
  expect(bridge.handleResponse({ type: "control_response", requestId: "caller-chosen-id", ok: true, payload: { behavior: "allow" } })).toBe(true);
  expect(await p).toEqual({ behavior: "allow" });
});

test("rejectAllPending rejects every still-pending request and clears them (Task 8: the pump's true-EOF teardown, no-park-timeout RPCs would otherwise hang forever)", async () => {
  const { sink, written } = recordingSink();
  const bridge = createRpcBridge(sink);

  const p1 = bridge.request("permission", { a: 1 }); // no timeoutMs — would otherwise park forever
  const p2 = bridge.request("permission", { b: 2 });
  const teardownError = new Error("winter: input ended before this control request could be answered");

  bridge.rejectAllPending(teardownError);

  await expect(p1).rejects.toThrow(teardownError.message);
  await expect(p2).rejects.toThrow(teardownError.message);

  // The map is cleared: a response that arrives AFTER teardown for one of those same ids is now
  // "unknown," not "double-settled" — same safe fallback as a late post-timeout response.
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const req1 = written[0] as ControlRequestFrame;
    expect(bridge.handleResponse({ type: "control_response", requestId: req1.requestId, ok: true, payload: {} })).toBe(false);
  } finally {
    errSpy.mockRestore();
  }
});

// T10 (WS-08 §10 lifecycle wiring, controller advisor correction): a request ISSUED AFTER
// rejectAllPending has already fired must reject IMMEDIATELY, never registering in `pending` or
// writing a frame — without this, a hook RPC (e.g. SessionEnd, fired right after the turn loop
// drains but potentially racing the pump's own true-EOF teardown in single-shot mode, where the
// wrapper's readLoop has already stopped reading stdout entirely) would sit unanswered until the
// RUNNER's own 30s observational-hook timeout fires, turning an ordinary single-shot query into a
// 30-second stall whenever ANY hook is configured. A closed bridge behaves exactly like any other
// "no opinion" rejection this whole phase already handles uniformly (prompt-stage.ts's catch, and
// now runner.ts's own invocation-rejection classification) — never a hang, never a crash.
test("T10: request() issued AFTER rejectAllPending rejects immediately, writes nothing, and never registers as pending", async () => {
  const { sink, written } = recordingSink();
  const bridge = createRpcBridge(sink);

  bridge.rejectAllPending(new Error("connection already torn down"));
  expect(written.length).toBe(0); // nothing was ever pending yet — this is just arming the closed flag

  let caught: unknown;
  try {
    await bridge.request("hook", { some: "payload" });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(WinterRpcError);
  expect(written.length).toBe(0); // the post-close request never wrote a frame at all
});

test("T10: rejectAllPending is idempotent — calling it again after the bridge is already closed is a harmless no-op", () => {
  const { sink } = recordingSink();
  const bridge = createRpcBridge(sink);
  bridge.rejectAllPending(new Error("first"));
  expect(() => bridge.rejectAllPending(new Error("second"))).not.toThrow();
});

// Finding 10 (P2 fix-wave, NIT): a runner-timed-out hook RPC leaves its bridge entry parked until
// teardown — cancel() frees the map slot (accumulation over a long flaky-hooks session; a very-late
// answer resolving an ignored promise) WITHOUT settling the caller's promise, which has already
// moved on by the time it calls this (the runner's own timer raced ahead of it).
test("Finding 10: cancel() removes a pending entry — a later response for that requestId is now 'unknown', not double-settled", async () => {
  const { sink, written } = recordingSink();
  const bridge = createRpcBridge(sink);
  const p = bridge.request("hook", {});
  const req = written[0] as ControlRequestFrame;

  bridge.cancel(req.requestId);

  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(bridge.handleResponse({ type: "control_response", requestId: req.requestId, ok: true, payload: {} })).toBe(false);
  } finally {
    errSpy.mockRestore();
  }

  // Never settles -- neither resolved nor rejected -- since nothing (the eventual real host answer,
  // above) was ever allowed to reach it after cancellation.
  let settled = false;
  p.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await sleep(30);
  expect(settled).toBe(false);
});

test("Finding 10: cancel() on an unknown requestId (never issued, or already settled) is a silent no-op", () => {
  const { sink, written } = recordingSink();
  const bridge = createRpcBridge(sink);
  expect(() => bridge.cancel("never-issued")).not.toThrow();

  const p = bridge.request("hook", {});
  p.catch(() => {});
  const req = written[0] as ControlRequestFrame;
  bridge.handleResponse({ type: "control_response", requestId: req.requestId, ok: true, payload: {} });
  // Already settled and removed from `pending` -- cancelling it again is a no-op, not a crash.
  expect(() => bridge.cancel(req.requestId)).not.toThrow();
});
