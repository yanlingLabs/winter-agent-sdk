import { afterEach, expect, test } from "bun:test";
import type { WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createRpcBridge } from "../rpc/bridge.ts";
import type { RuntimeContextChannel } from "../context/runtime-context-channel.ts";
import {
  createGuidedParentBridge, GUIDED_PARENT_PENDING_MAX, GUIDED_READER_FRAME_BYTES,
  GUIDED_READER_SUBTYPE, type GuidedReaderRequest, type GuidedReaderResponse,
} from "./guided-parent-bridge.ts";

// This suite exercises trusted injections and protocol bookkeeping only. It does not
// admit a guest, acquire a native capability, start a helper, or access real homes.
const request = { sessionId: "backend", cwd: "/fixture/source", purpose: "generation" as const, attempt: 1 };
const snapshot = { revision: "r1", facts: "host facts", instructions: "editable guidance" };
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function observe<T>(promise: Promise<T>) {
  let status: "pending" | "fulfilled" | "rejected" = "pending";
  void promise.then(() => { status = "fulfilled"; }, () => { status = "rejected"; });
  return { promise, status: () => status };
}
async function tick() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
function fixture(options: { ids?: string[]; timeoutMs?: number; bind?: boolean; cancelThrows?: boolean; readerWriteThrows?: boolean } = {}) {
  const frames: WinterFrame[] = [], readerWriteAttempts: WinterFrame[] = [], output = { write(frame: WinterFrame) {
    if (frame.type === "control_response") {
      readerWriteAttempts.push(frame);
      if (options.readerWriteThrows) throw new Error("private output failure /fixture/secret");
    }
    frames.push(frame);
  }, end() {} };
  const bridge = createRpcBridge(output);
  let ownerHeld = true, sequence = 1;
  const reads: { request: GuidedReaderRequest; signal: AbortSignal; result: ReturnType<typeof deferred<GuidedReaderResponse>>;
    drain: ReturnType<typeof deferred<void>>; cancels: number }[] = [];
  const binding = { version: 1 as const, bindingId: "binding" };
  const source = createGuidedParentBridge({ binding, backendSessionId: "backend", cwd: request.cwd,
    assertOwnerHeld() { if (!ownerHeld) throw new Error("private owner diagnostic must not escape"); },
    readerPort: { start(readerRequest, { signal }) {
      const read = { request: readerRequest, signal, result: deferred<GuidedReaderResponse>(), drain: deferred<void>(), cancels: 0 };
      reads.push(read);
      return { result: read.result.promise, drained: read.drain.promise, cancel() {
        read.cancels++; if (options.cancelThrows) throw new Error("private cancel diagnostic");
      } };
    } }, output, timeoutMs: options.timeoutMs ?? 1_000, nextRequestId: () => options.ids?.shift() ?? uuid(sequence++) });
  if (options.bind !== false) source.bind(bridge);
  const context = (value = request, signal = new AbortController().signal) => observe(source.resolve(value, { signal }));
  const readerFrame = (contextId: string, readId = uuid(100), bindingId = "binding") => ({
    type: "control_request", requestId: readId, subtype: GUIDED_READER_SUBTYPE,
    payload: { version: 1 as const, bindingId, contextRequestId: contextId, readId },
  });
  const reader = (contextId: string, readId = uuid(100)) => observe(source.handleReaderRequest(readerFrame(contextId, readId)));
  const answer = (id: string, payload: unknown = snapshot) => source.handleResponse({ type: "control_response", requestId: id, ok: true, payload });
  const validResult = (index = 0, frame = "{}\n") => ({ ...reads[index]!.request, frame });
  const clean = () => { source.close(); for (const read of reads) { read.result.resolve(validResult(reads.indexOf(read))); read.drain.resolve(); } bridge.rejectAllPending(new Error("fixture closed")); };
  fixtures.push(clean);
  return { frames, readerWriteAttempts, bridge, source, binding, reads, context, reader, readerFrame, answer, validResult, loseOwner() { ownerHeld = false; } };
}
const fixtures: (() => void)[] = [];
afterEach(async () => { for (const cleanup of fixtures.splice(0)) cleanup(); await tick(); });

test("unbound, foreign parent, wrong directory, children and pre-aborted context refuse with zero wire", async () => {
  const unbound = fixture({ bind: false });
  await expect(unbound.context().promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(unbound.frames).toEqual([]);
  const f = fixture(), abort = new AbortController(); abort.abort();
  for (const scope of [{ ...request, sessionId: "foreign" }, { ...request, cwd: "/fixture/other" }, { ...request, agentId: "child" }]) {
    await expect(f.source.resolve(scope, { signal: new AbortController().signal })).rejects.toThrow(/^required_context_unavailable$/);
  }
  await expect(f.context(request, abort.signal).promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.frames).toEqual([]); expect(f.reads).toEqual([]);
  expect(() => f.source.bind(createRpcBridge({ write() { throw new Error("second bridge must not write"); }, end() {} }))).toThrow(/^required_context_unavailable$/);
});

test("guided bridge is a runtime context channel with immutable captured binding identity", () => {
  const f = fixture();
  const channel: RuntimeContextChannel = f.source;
  expect(channel).toBe(f.source);
  expect(channel.bindingId).toBe("binding");
  expect(Object.getOwnPropertyDescriptor(channel, "bindingId")).toEqual({
    value: "binding", writable: false, enumerable: true, configurable: false,
  });
  f.binding.bindingId = "changed-after-construction";
  expect(Reflect.set(channel, "bindingId", "foreign")).toBe(false);
  expect(Reflect.defineProperty(channel, "bindingId", { value: "foreign" })).toBe(false);
  expect(channel.bindingId).toBe("binding");
  f.context();
  expect(f.frames[0]).toEqual({ type: "control_request", requestId: uuid(1), subtype: "runtime_context", payload: { ...request, bindingId: channel.bindingId } });
  expect(f.reads).toEqual([]);
});

test("wire binding is captured at creation; context requires valid reader result and confirmed drain", async () => {
  const f = fixture(); f.binding.bindingId = "changed-after-construction"; const context = f.context();
  expect(f.frames[0]).toEqual({ type: "control_request", requestId: uuid(1), subtype: "runtime_context", payload: { ...request, bindingId: "binding" } });
  const reader = f.reader(uuid(1));
  expect(f.reads).toHaveLength(1); expect(f.reads[0]!.signal.aborted).toBe(false);
  expect(f.answer(uuid(1))).toBe("accept"); await tick();
  expect(context.status()).toBe("pending");
  f.reads[0]!.result.resolve(f.validResult()); await tick();
  expect(reader.status()).toBe("pending"); expect(context.status()).toBe("pending");
  expect(f.source.diagnostics().readerDebt).toBe(1);
  f.reads[0]!.drain.resolve();
  expect(await reader.promise).toBe("accept"); expect(await context.promise).toEqual(snapshot);
  expect(f.frames.at(-1)).toEqual({ type: "control_response", requestId: uuid(100), ok: true, payload: f.validResult() });
  expect(f.source.diagnostics()).toEqual({ closed: false, pendingContexts: 0, readerDebt: 0, uncertainReaderDebt: 0 });
  expect(f.reads[0]!.cancels).toBe(0);
});

test("drain alone cannot complete context or emit reader response", async () => {
  const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
  f.reads[0]!.drain.resolve(); f.answer(uuid(1)); await tick();
  expect(context.status()).toBe("pending"); expect(reader.status()).toBe("pending"); expect(f.frames).toHaveLength(1);
  f.reads[0]!.result.resolve(f.validResult());
  expect(await reader.promise).toBe("accept"); expect(await context.promise).toEqual(snapshot);
});

test("reader response output failure refuses an already answered context despite confirmed drain", async () => {
  const f = fixture({ readerWriteThrows: true }), context = f.context(), reader = f.reader(uuid(1));
  expect(f.answer(uuid(1))).toBe("accept"); await tick(); expect(context.status()).toBe("pending");
  f.reads[0]!.result.resolve(f.validResult()); await tick();
  expect(context.status()).toBe("pending"); expect(f.readerWriteAttempts).toEqual([]);
  f.reads[0]!.drain.resolve();
  await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(context.status()).toBe("rejected");
  expect(f.readerWriteAttempts).toEqual([{ type: "control_response", requestId: uuid(100), ok: true, payload: f.validResult() }]);
  expect(f.frames.filter(frame => frame.type === "control_response")).toEqual([]);
  expect(f.source.diagnostics()).toEqual({ closed: false, pendingContexts: 0, readerDebt: 0, uncertainReaderDebt: 0 });
  expect(f.reads[0]!.cancels).toBe(1); expect(f.reads[0]!.signal.aborted).toBe(true);
});

test("context reply without its reader refuses and has no cached fallback", async () => {
  const f = fixture(), context = f.context(); f.answer(uuid(1));
  await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.reads).toEqual([]); expect(f.source.diagnostics().pendingContexts).toBe(0);
  expect(await f.source.handleReaderRequest(f.readerFrame(uuid(1)))).toBe("drop");
  expect(f.answer(uuid(1))).toBe("drop");
});

test("each context owns one reader; duplicate cancels rather than launching another operation", async () => {
  const f = fixture(), context = f.context(), first = f.reader(uuid(1));
  await expect(f.reader(uuid(1), uuid(101)).promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(first.promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.reads).toHaveLength(1); expect(f.reads[0]!.cancels).toBe(1); expect(f.reads[0]!.signal.aborted).toBe(true);
  expect(f.source.diagnostics().readerDebt).toBe(1);
  f.reads[0]!.drain.resolve(); await tick(); expect(f.source.diagnostics().readerDebt).toBe(0);
});

test("permission answers stay on their own RPC, foreign subtype and stale ids never settle context", async () => {
  const f = fixture(), context = f.context();
  const permission = f.bridge.request("permission", {}, { requestId: uuid(200) });
  const hook = observe(f.bridge.request("hook", {}, { requestId: uuid(201) }));
  expect(f.source.handleResponse({ type: "control_response", requestId: uuid(200), ok: true, payload: { behavior: "deny", message: "denied" } })).toBe("accept");
  expect(await permission).toEqual({ behavior: "deny", message: "denied" });
  expect(f.answer(uuid(200))).toBe("drop"); expect(f.answer(uuid(201))).toBe("drop"); expect(f.answer(uuid(999))).toBe("drop");
  await tick(); expect(context.status()).toBe("pending"); expect(hook.status()).toBe("pending");
  expect(await f.source.handleReaderRequest(f.readerFrame(uuid(999)))).toBe("drop"); expect(f.reads).toEqual([]);
});

test("context id cannot collide with another context or permission ownership", async () => {
  const f = fixture({ ids: [uuid(1), uuid(1), uuid(200)] }), context = f.context();
  await expect(f.context().promise).rejects.toThrow(/^required_context_unavailable$/);
  const permission = observe(f.bridge.request("permission", {}, { requestId: uuid(200) }));
  await expect(f.context().promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.frames).toHaveLength(2); expect(f.bridge.ownsRequest(uuid(200), "permission")).toBe(true);
  await tick(); expect(context.status()).toBe("pending"); expect(permission.status()).toBe("pending");
});

test("reader id cannot collide with pending permission or context ids", async () => {
  for (const collision of [uuid(200), uuid(2)]) {
    const f = fixture(), context = f.context(), other = f.context();
    const permission = observe(f.bridge.request("permission", {}, { requestId: uuid(200) }));
    await expect(f.reader(uuid(1), collision).promise).rejects.toThrow(/^required_context_unavailable$/);
    await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
    expect(f.reads).toEqual([]); expect(f.bridge.ownsRequest(uuid(2), "runtime_context")).toBe(true);
    expect(f.bridge.ownsRequest(uuid(200), "permission")).toBe(true);
    await tick(); expect(other.status()).toBe("pending"); expect(permission.status()).toBe("pending");
  }
});

test("reader debt id remains unavailable to new context ids after cancellation", async () => {
  const f = fixture({ ids: [uuid(1), uuid(100)] }), abort = new AbortController();
  const context = f.context(request, abort.signal), reader = f.reader(uuid(1)); abort.abort();
  await expect(context.promise).rejects.toThrow(/^required_context_cancelled$/);
  await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
  const frameCount = f.frames.length;
  await expect(f.context().promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.frames).toHaveLength(frameCount); expect(f.source.diagnostics().readerDebt).toBe(1);
});

test("active reader id stays unavailable to context allocation after early confirmed drain", async () => {
  const f = fixture({ ids: [uuid(1), uuid(100)] }), first = f.context(), reader = f.reader(uuid(1));
  f.reads[0]!.drain.resolve(); await tick(); expect(f.source.diagnostics().readerDebt).toBe(0);
  await expect(f.context().promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.frames).toHaveLength(1); expect(first.status()).toBe("pending"); expect(reader.status()).toBe("pending");
});

test("reader id cannot reuse a context id whose RPC settled while reader drain is pending", async () => {
  const f = fixture(), first = f.context(), firstReader = f.reader(uuid(1));
  f.reads[0]!.result.resolve(f.validResult()); f.answer(uuid(1)); await tick();
  expect(f.bridge.ownsRequest(uuid(1))).toBe(false); expect(first.status()).toBe("pending");
  const second = f.context();
  await expect(f.reader(uuid(2), uuid(1)).promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(second.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.reads).toHaveLength(1);
  f.reads[0]!.drain.resolve(); expect(await firstReader.promise).toBe("accept"); expect(await first.promise).toEqual(snapshot);
});

test("undrained reader id cannot be reused by another context reader", async () => {
  const f = fixture(), abort = new AbortController(), first = f.context(request, abort.signal), firstReader = f.reader(uuid(1)); abort.abort();
  await expect(first.promise).rejects.toThrow(/^required_context_cancelled$/); await expect(firstReader.promise).rejects.toThrow(/^required_context_unavailable$/);
  const second = f.context();
  await expect(f.reader(uuid(2)).promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(second.promise).rejects.toThrow(/^required_context_unavailable$/); expect(f.reads).toHaveLength(1);
});

test("reader requests enforce exact binding, envelope correlation and closed plain data", async () => {
  for (const mutate of [
    (frame: ReturnType<ReturnType<typeof fixture>["readerFrame"]>) => ({ ...frame, requestId: uuid(101) }),
    (frame: ReturnType<ReturnType<typeof fixture>["readerFrame"]>) => ({ ...frame, subtype: "other" }),
    (frame: ReturnType<ReturnType<typeof fixture>["readerFrame"]>) => ({ ...frame, payload: { ...frame.payload, bindingId: "foreign" } }),
    (frame: ReturnType<ReturnType<typeof fixture>["readerFrame"]>) => ({ ...frame, extra: true }),
    (frame: ReturnType<ReturnType<typeof fixture>["readerFrame"]>) => ({ ...frame, payload: { ...frame.payload, extra: true } }),
  ]) {
    const f = fixture(), context = f.context();
    await expect(f.source.handleReaderRequest(mutate(f.readerFrame(uuid(1))))).rejects.toThrow(/^required_context_unavailable$/);
    expect(f.reads).toEqual([]);
    // An invalid envelope cannot always be safely correlated with a context. Cleanup
    // is explicit rather than claiming such a frame cancelled a guessed owner.
    f.source.close(); await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  }
});

test("malformed or wrong-correlated reader result cancels context and retains debt until drain", async () => {
  const mutations: ((value: GuidedReaderResponse) => unknown)[] = [
    value => ({ ...value, version: 2 }), value => ({ ...value, bindingId: "foreign" }),
    value => ({ ...value, contextRequestId: uuid(999) }), value => ({ ...value, readId: uuid(999) }),
    value => ({ ...value, extra: true }), value => ({ ...value, frame: "{}" }),
    value => ({ ...value, frame: "{}\n{}\n" }), value => ({ ...value, frame: "invalid\n" }),
    value => ({ ...value, frame: "[]\n" }), value => ({ ...value, frame: "null\n" }),
    value => ({ ...value, frame: "{\"text\":\"\ud800\"}\n" }),
    value => ({ ...value, frame: `{"text":"${"x".repeat(GUIDED_READER_FRAME_BYTES)}"}\n` }),
    value => Object.create(value), value => ({ ...value, get frame() { throw new Error("getter must not execute"); } }),
  ];
  for (const mutate of mutations) {
    const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
    f.reads[0]!.result.resolve(mutate(f.validResult()) as GuidedReaderResponse);
    await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
    await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
    expect(f.reads[0]!.cancels).toBe(1); expect(f.reads[0]!.signal.aborted).toBe(true);
    expect(f.frames.filter(frame => frame.type === "control_response")).toEqual([]);
    expect(f.source.diagnostics().readerDebt).toBe(1);
    f.reads[0]!.drain.resolve(); await tick(); expect(f.source.diagnostics().readerDebt).toBe(0);
  }
});

test("reader result rejection does not forward its diagnostic or claim cancellation drained it", async () => {
  const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
  f.reads[0]!.result.reject(new Error("private diagnostic /fixture/secret"));
  await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.reads[0]!.cancels).toBe(1); expect(f.source.diagnostics().readerDebt).toBe(1);
});

test("failed drain refuses success and preserves uncertain debt", async () => {
  const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
  f.reads[0]!.result.resolve(f.validResult()); f.reads[0]!.drain.reject(new Error("private drain diagnostic"));
  await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.source.diagnostics()).toEqual({ closed: false, pendingContexts: 0, readerDebt: 1, uncertainReaderDebt: 1 });
  expect(f.reads[0]!.cancels).toBe(1);
});

test("failed drain cancels even if reader result has never settled", async () => {
  const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
  f.reads[0]!.drain.reject(new Error("private drain diagnostic")); await tick();
  expect(context.status()).toBe("rejected"); expect(reader.status()).toBe("rejected");
  expect(f.reads[0]!.cancels).toBe(1); expect(f.reads[0]!.signal.aborted).toBe(true);
  expect(f.source.diagnostics().uncertainReaderDebt).toBe(1);
});

test("cancellation failure is uncertainty and repeated closure calls cancel only once", async () => {
  const f = fixture({ cancelThrows: true }), context = f.context(), reader = f.reader(uuid(1));
  f.source.close(); f.source.close();
  await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.reads[0]!.cancels).toBe(1);
  expect(f.source.diagnostics()).toEqual({ closed: true, pendingContexts: 0, readerDebt: 1, uncertainReaderDebt: 1 });
  f.reads[0]!.drain.resolve(); await tick(); expect(f.source.diagnostics().readerDebt).toBe(0);
});

test("abort cancels pending context and reader, drops late responses, and drain alone clears debt", async () => {
  const f = fixture(), abort = new AbortController(), context = f.context(request, abort.signal), reader = f.reader(uuid(1));
  abort.abort(); abort.abort();
  await expect(context.promise).rejects.toThrow(/^required_context_cancelled$/);
  await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.frames.filter(frame => frame.type === "control_cancel_request")).toEqual([{ type: "control_cancel_request", requestId: uuid(1) }]);
  expect(f.bridge.ownsRequest(uuid(1))).toBe(false); expect(f.answer(uuid(1))).toBe("drop");
  expect(await f.source.handleReaderRequest(f.readerFrame(uuid(1), uuid(101)))).toBe("drop");
  f.reads[0]!.result.resolve(f.validResult()); await tick(); expect(f.source.diagnostics().readerDebt).toBe(1);
  f.reads[0]!.drain.resolve(); await tick();
  expect(f.reads[0]!.cancels).toBe(1); expect(f.source.diagnostics().readerDebt).toBe(0);
  expect(f.frames.filter(frame => frame.type === "control_response")).toEqual([]);
});

test("bounded context timeout cancels reader and retains its outstanding drain", async () => {
  for (const contextAlreadyAnswered of [false, true]) {
    const f = fixture({ timeoutMs: 10 }), context = f.context(), reader = f.reader(uuid(1));
    const result = observe(f.reads[0]!.result.promise), drain = observe(f.reads[0]!.drain.promise);
    if (contextAlreadyAnswered) expect(f.answer(uuid(1))).toBe("accept");
    await expect(context.promise).rejects.toThrow(/^required_context_timed_out$/);
    await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
    expect(result.status()).toBe("pending"); expect(drain.status()).toBe("pending");
    expect(f.reads[0]!.cancels).toBe(1); expect(f.reads[0]!.signal.aborted).toBe(true);
    expect(f.frames.filter(frame => frame.type === "control_cancel_request")).toEqual(contextAlreadyAnswered ? [] : [{ type: "control_cancel_request", requestId: uuid(1) }]);
    expect(f.frames.filter(frame => frame.type === "control_response")).toEqual([]);
    expect(f.source.diagnostics().readerDebt).toBe(1); expect(f.answer(uuid(1))).toBe("drop");
    f.reads[0]!.result.resolve(f.validResult()); f.reads[0]!.drain.resolve(); await tick();
    expect(f.readerWriteAttempts).toEqual([]); expect(f.source.diagnostics().readerDebt).toBe(0);
  }
});

test("close is terminal, idempotent and cannot be revived by late work or another bind", async () => {
  const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
  f.source.close(); f.source.close();
  await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
  const frameCount = f.frames.length;
  await expect(f.context().promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(f.source.handleReaderRequest(f.readerFrame(uuid(1)))).rejects.toThrow(/^required_context_unavailable$/);
  expect(() => f.answer(uuid(1))).toThrow(/^required_context_unavailable$/);
  expect(() => f.source.bind(f.bridge)).toThrow(/^required_context_unavailable$/);
  f.reads[0]!.result.resolve(f.validResult()); f.reads[0]!.drain.resolve(); await tick();
  expect(f.frames).toHaveLength(frameCount); expect(f.reads[0]!.cancels).toBe(1);
  expect(f.source.diagnostics()).toEqual({ closed: true, pendingContexts: 0, readerDebt: 0, uncertainReaderDebt: 0 });
});

test("owner loss after reader-result await closes bridge without reader reply or snapshot", async () => {
  const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
  f.reads[0]!.result.resolve(f.validResult()); f.loseOwner();
  await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.source.diagnostics().closed).toBe(true); expect(f.reads[0]!.cancels).toBe(1);
  expect(f.frames.filter(frame => frame.type === "control_response")).toEqual([]);
});

test("owner loss after drain await refuses a result that was already validated", async () => {
  const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
  f.reads[0]!.result.resolve(f.validResult()); f.answer(uuid(1)); await tick();
  f.reads[0]!.drain.resolve(); f.loseOwner();
  await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.source.diagnostics().closed).toBe(true);
  expect(f.frames.filter(frame => frame.type === "control_response")).toEqual([]);
});

test("owner loss after context wire settlement refuses snapshot delivery", async () => {
  const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
  f.reads[0]!.result.resolve(f.validResult()); f.reads[0]!.drain.resolve(); expect(await reader.promise).toBe("accept");
  f.answer(uuid(1)); f.loseOwner();
  await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.source.diagnostics().closed).toBe(true);
});

test("malformed context answers stop the correlated reader without settling permissions", async () => {
  for (const value of [{ ...snapshot, extra: true }, { ...snapshot, revision: "/fixture/private" }, null]) {
    const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
    const permission = observe(f.bridge.request("permission", {}, { requestId: uuid(200) }));
    expect(() => f.answer(uuid(1), value)).toThrow(/^required_context_unavailable$/);
    await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
    await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
    expect(f.reads[0]!.cancels).toBe(1); expect(f.source.diagnostics().readerDebt).toBe(1);
    expect(f.bridge.ownsRequest(uuid(200), "permission")).toBe(true); expect(permission.status()).toBe("pending");
  }
});

test("known context response ok accessor never runs and cancels reader while retaining drain debt", async () => {
  const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
  const permission = observe(f.bridge.request("permission", {}, { requestId: uuid(200) }));
  let getterCalls = 0;
  const malformed = { type: "control_response", requestId: uuid(1), get ok() { getterCalls++; return true; }, payload: snapshot };
  expect(() => f.source.handleResponse(malformed)).toThrow(/^required_context_unavailable$/);
  expect(getterCalls).toBe(0);
  await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.reads[0]!.cancels).toBe(1); expect(f.reads[0]!.signal.aborted).toBe(true);
  expect(f.bridge.ownsRequest(uuid(1))).toBe(false); expect(f.bridge.ownsRequest(uuid(200), "permission")).toBe(true);
  expect(permission.status()).toBe("pending");
  expect(f.source.diagnostics()).toEqual({ closed: false, pendingContexts: 0, readerDebt: 1, uncertainReaderDebt: 0 });
  f.reads[0]!.result.resolve(f.validResult()); await tick(); expect(f.source.diagnostics().readerDebt).toBe(1);
  f.reads[0]!.drain.resolve(); await tick();
  expect(f.source.diagnostics().readerDebt).toBe(0); expect(f.readerWriteAttempts).toEqual([]); expect(getterCalls).toBe(0);
});

test("requestId accessor never runs or identifies an owner and cannot settle context or permission", async () => {
  for (const claimedId of [uuid(1), uuid(200)]) {
    const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
    const permission = observe(f.bridge.request("permission", {}, { requestId: uuid(200) }));
    let getterCalls = 0;
    const malformed = { type: "control_response", get requestId() { getterCalls++; return claimedId; }, ok: true,
      payload: claimedId === uuid(1) ? snapshot : { behavior: "deny", message: "denied" } };
    expect(() => f.source.handleResponse(malformed)).toThrow(/^required_context_unavailable$/);
    await tick(); expect(getterCalls).toBe(0);
    expect(context.status()).toBe("pending"); expect(reader.status()).toBe("pending"); expect(permission.status()).toBe("pending");
    expect(f.bridge.ownsRequest(uuid(1), "runtime_context")).toBe(true); expect(f.bridge.ownsRequest(uuid(200), "permission")).toBe(true);
    expect(f.reads[0]!.cancels).toBe(0); expect(f.reads[0]!.signal.aborted).toBe(false);
    expect(f.frames.filter(frame => frame.type === "control_cancel_request")).toEqual([]);
    expect(f.source.diagnostics()).toEqual({ closed: false, pendingContexts: 1, readerDebt: 1, uncertainReaderDebt: 0 });
    f.reads[0]!.result.resolve(f.validResult()); f.reads[0]!.drain.resolve();
    expect(await reader.promise).toBe("accept"); expect(f.answer(uuid(1))).toBe("accept"); expect(await context.promise).toEqual(snapshot);
    expect(f.source.handleResponse({ type: "control_response", requestId: uuid(200), ok: true, payload: { behavior: "deny", message: "denied" } })).toBe("accept");
    expect(await permission.promise).toEqual({ behavior: "deny", message: "denied" }); expect(getterCalls).toBe(0);
  }
});

test("lost RPC subtype ownership stops context and drops response without settling the new owner", async () => {
  const f = fixture(), context = f.context(), reader = f.reader(uuid(1));
  f.bridge.cancel(uuid(1));
  const permission = observe(f.bridge.request("permission", {}, { requestId: uuid(1) }));
  expect(f.answer(uuid(1))).toBe("drop");
  await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.bridge.ownsRequest(uuid(1), "permission")).toBe(true); expect(permission.status()).toBe("pending");
  expect(f.reads[0]!.cancels).toBe(1); expect(f.source.diagnostics().readerDebt).toBe(1);
});

test("pending contexts bound admission before a reader exists", async () => {
  const f = fixture(), contexts = Array.from({ length: GUIDED_PARENT_PENDING_MAX }, () => f.context());
  await expect(f.context().promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.frames).toHaveLength(GUIDED_PARENT_PENDING_MAX); expect(f.reads).toEqual([]);
  expect(f.source.diagnostics().pendingContexts).toBe(GUIDED_PARENT_PENDING_MAX);
  f.source.close();
  for (const context of contexts) await expect(context.promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.source.diagnostics().pendingContexts).toBe(0);
});

test("reader debt bounds admission after cancelled contexts disappear; confirmed drain frees capacity", async () => {
  const f = fixture();
  for (let n = 1; n <= GUIDED_PARENT_PENDING_MAX; n++) {
    const abort = new AbortController(), context = f.context(request, abort.signal), reader = f.reader(uuid(n), uuid(100 + n)); abort.abort();
    await expect(context.promise).rejects.toThrow(/^required_context_cancelled$/);
    await expect(reader.promise).rejects.toThrow(/^required_context_unavailable$/);
  }
  expect(f.source.diagnostics()).toEqual({ closed: false, pendingContexts: 0, readerDebt: GUIDED_PARENT_PENDING_MAX, uncertainReaderDebt: 0 });
  const frameCount = f.frames.length; await expect(f.context().promise).rejects.toThrow(/^required_context_unavailable$/);
  expect(f.frames).toHaveLength(frameCount);
  f.reads[0]!.drain.resolve(); await tick(); const admitted = f.context();
  expect(f.frames).toHaveLength(frameCount + 1); expect(admitted.status()).toBe("pending");
});
