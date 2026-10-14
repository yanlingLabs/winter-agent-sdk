import { expect, test } from "bun:test";
import { query } from "./query.ts";
import { prepareGuidedQuery, consumeGuidedQueryCorrelation, closeGuidedQuery, type GuidedQueryPreparation } from "./guided-query-preparation.ts";
import { readGuidedQueryInstructions } from "./guided-query-reader.ts";
import { encodeFrame, splitFrames } from "./protocol/codec.ts";
import { PROTOCOL_VERSION, type WinterFrame, type ControlRequestFrame, type ControlResponseFrame } from "./protocol/frames.ts";
import type { RuntimeConfig } from "./protocol/config.ts";
import type { Options } from "./options.ts";
import type { SpawnedRuntimeProcess } from "./transport.ts";
import { Queue } from "../../runtime/src/protocol/channel.ts";
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const contextId = uuid(10), snapshot = { revision: "r1", facts: "host facts", instructions: "mapped current guidance" };
const raw = '{"snapshot":{"text":"current source bytes"}}\n';
const result = { type: "data", message: { type: "result", subtype: "success", is_error: false } } as WinterFrame;
async function nextFrame(queue: Queue<WinterFrame>, predicate: (frame: WinterFrame) => boolean): Promise<WinterFrame> {
  for (;;) { const next = await queue[Symbol.asyncIterator]().next(); if (next.done) throw new Error("fixture transport ended"); if (predicate(next.value)) return next.value; }
}
function fixture(callback: NonNullable<Options["onRuntimeContext"]>, scenario: (config: RuntimeConfig, frames: Queue<WinterFrame>, state: {
  preparation(): GuidedQueryPreparation; finish(): void;
}) => AsyncIterable<WinterFrame>, prepared = true) {
  let preparation!: GuidedQueryPreparation, finish!: () => void;
  const writes: WinterFrame[] = [], input = new Queue<WinterFrame>();
  const pair = { onRuntimeContext: callback, spawnClaudeCodeProcess(options: Parameters<NonNullable<Options["spawnClaudeCodeProcess"]>>[0]): SpawnedRuntimeProcess {
    const config: RuntimeConfig = JSON.parse(options.args[2]!);
    if (prepared) consumeGuidedQueryCorrelation(options.guidedQueryClaim!, options.args);
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { finish = () => resolve({ code: 0, signal: null }); });
    return { stdin: { write(bytes) { for (const frame of splitFrames(bytes, "").frames) { writes.push(frame); input.write(frame); } }, end() {} },
      stdout: (async function* () { try { yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: "runtime-lookup-is-not-authority", cwd: "/guest/source", model: "fixture", permissionMode: "default", tools: [], runtimeContextVersion: 1 });
        for await (const frame of scenario(config, input, { preparation: () => preparation, finish: () => finish() })) yield encodeFrame(frame);
      } finally { finish(); } })(), exited, kill() {}, pid: null };
  } };
  if (prepared) preparation = prepareGuidedQuery(pair);
  const options: Options = { ...pair, ...(prepared ? { guidedQueryPreparation: preparation } : {}), requireRuntimeContext: true, sessionId: "backend", cwd: "/host/correlation-only" };
  return { writes, options, preparation: () => preparation, async run() { for await (const _ of query({ prompt: "fixture", options })) {} } };
}
function context(config: RuntimeConfig, change = {}): WinterFrame { return { type: "control_request", subtype: "runtime_context", requestId: contextId,
  payload: { bindingId: config.requiredRuntimeContext!.bindingId, sessionId: config.sessionId, cwd: "/guest/source", purpose: "generation", attempt: 1, ...change } }; }
const isRead = (frame: WinterFrame) => frame.type === "control_request" && frame.subtype === "instruction_reader";
const isContextAnswer = (frame: WinterFrame) => frame.type === "control_response" && frame.requestId === contextId;
function answer(read: ControlRequestFrame, change = {}): WinterFrame { return { type: "control_response", requestId: read.requestId, ok: true,
  payload: { ...(read.payload as object), frame: raw }, ...change }; }

test("actual prepared query exposes one scoped reader only through its exact current callback signal", async () => {
  let saved!: AbortSignal, f!: ReturnType<typeof fixture>;
  const foreign = prepareGuidedQuery({ onRuntimeContext: async () => snapshot, spawnClaudeCodeProcess() { throw new Error("not used"); } });
  f = fixture(async (request, options) => {
    saved = options.signal; expect(Object.keys(options).sort()).toEqual(["signal", "trustedQuerySessionId"]);
    expect(request.cwd).toBe("/guest/source"); expect(options.trustedQuerySessionId).toBe("backend");
    for (const prep of [foreign, {} as GuidedQueryPreparation, { ...f.preparation() }]) await expect(readGuidedQueryInstructions(prep, saved)).rejects.toThrow("required_context_unavailable");
    await expect(readGuidedQueryInstructions(f.preparation(), new AbortController().signal)).rejects.toThrow("required_context_unavailable");
    await expect(readGuidedQueryInstructions(f.preparation(), { aborted: false } as AbortSignal)).rejects.toThrow("required_context_unavailable");
    expect(await readGuidedQueryInstructions(f.preparation(), saved)).toBe(raw);
    await expect(readGuidedQueryInstructions(f.preparation(), saved)).rejects.toThrow("required_context_unavailable"); return snapshot;
  }, async function* (config, frames) {
    yield context(config); const read = await nextFrame(frames, isRead) as ControlRequestFrame;
    expect(read.requestId).not.toBe(contextId); expect(read.payload).toEqual({ version: 1, bindingId: config.requiredRuntimeContext!.bindingId, contextRequestId: contextId, readId: read.requestId });
    yield answer(read); expect((await nextFrame(frames, isContextAnswer) as ControlResponseFrame).payload).toEqual(snapshot); yield result;
  });
  await f.run(); closeGuidedQuery(foreign);
  await expect(readGuidedQueryInstructions(f.preparation(), saved)).rejects.toThrow("required_context_unavailable");
  expect(f.writes.filter(isRead)).toHaveLength(1);
});

test("unprepared, child and foreign backend callbacks have no reader handle or extra ordinary traffic", async () => {
  for (const mode of ["ordinary", "child", "foreign"]) {
    let f!: ReturnType<typeof fixture>;
    f = fixture(async (_request, options) => {
      await expect(readGuidedQueryInstructions(f.preparation(), options.signal)).rejects.toThrow("required_context_unavailable"); return snapshot;
    }, async function* (config, frames) {
      yield context(config, mode === "child" ? { agentId: "child" } : mode === "foreign" ? { sessionId: "other-backend" } : {});
      expect((await nextFrame(frames, isContextAnswer) as ControlResponseFrame).ok).toBe(true); yield result;
    }, mode !== "ordinary");
    await f.run(); expect(f.writes.filter(isRead)).toEqual([]);
  }
});

test("wrong subtype payload, owner correlation and malformed reader results fail context without permission settlement", async () => {
  for (const malformed of ["permission", "foreign-context", "foreign-binding", "extra", "bad-json"]) {
    let f!: ReturnType<typeof fixture>;
    f = fixture(async (_request, options) => { await readGuidedQueryInstructions(f.preparation(), options.signal); return snapshot; }, async function* (config, frames) {
      yield context(config); const read = await nextFrame(frames, isRead) as ControlRequestFrame;
      const payload = { ...(read.payload as object), frame: raw };
      if (malformed === "permission") yield answer(read, { payload: { behavior: "allow" } });
      else if (malformed === "foreign-context") yield answer(read, { payload: { ...payload, contextRequestId: uuid(99) } });
      else if (malformed === "foreign-binding") yield answer(read, { payload: { ...payload, bindingId: uuid(99) } });
      else if (malformed === "extra") yield answer(read, { payload: { ...payload, sourceRoot: "/private" } });
      else yield answer(read, { payload: { ...payload, frame: "not JSON\n" } });
      const failure = await nextFrame(frames, isContextAnswer) as ControlResponseFrame;
      expect(failure).toEqual({ type: "control_response", requestId: contextId, ok: false, error: { code: "required_context_unavailable", message: "required_context_unavailable" } }); yield result;
    });
    await f.run(); expect(f.writes.filter(isRead)).toHaveLength(1);
  }
});

test("cross-direction request collision refuses before any permission callback", async () => {
  let f!: ReturnType<typeof fixture>, permissions = 0;
  f = fixture(async (_request, options) => { await readGuidedQueryInstructions(f.preparation(), options.signal); return snapshot; }, async function* (config, frames) {
    yield context(config); const read = await nextFrame(frames, isRead) as ControlRequestFrame;
    yield { type: "control_request", requestId: read.requestId, subtype: "permission", payload: { toolName: "Bash", input: {} } };
  });
  f.options.canUseTool = async () => { permissions++; return { behavior: "allow" }; };
  await expect(f.run()).rejects.toThrow("required_context_unavailable"); expect(permissions).toBe(0);
});

test("abort, preparation close and observed exit revoke pending scoped reader and drop late answers", async () => {
  for (const reason of ["cancel", "preparation", "exit"]) {
    let saved!: AbortSignal, f!: ReturnType<typeof fixture>, rejected = false;
    f = fixture(async (_request, options) => { saved = options.signal; try { await readGuidedQueryInstructions(f.preparation(), saved); } catch { rejected = true; throw new Error("private resolver failure"); } return snapshot; },
      async function* (config, frames, state) {
        yield context(config); const read = await nextFrame(frames, isRead) as ControlRequestFrame;
        if (reason === "cancel") yield { type: "control_cancel_request", requestId: contextId } as WinterFrame;
        else if (reason === "preparation") closeGuidedQuery(state.preparation()); else state.finish();
        yield answer(read); if (reason === "preparation") expect((await nextFrame(frames, isContextAnswer) as ControlResponseFrame).ok).toBe(false);
        yield result;
      });
    await f.run(); expect(rejected).toBe(true);
    await expect(readGuidedQueryInstructions(f.preparation(), saved)).rejects.toThrow("required_context_unavailable");
    if (reason !== "preparation") expect(f.writes.filter(isContextAnswer)).toEqual([]);
  }
});

test("callback returning without awaiting its started read cannot publish successful cached context", async () => {
  let f!: ReturnType<typeof fixture>, pending!: Promise<string>;
  f = fixture(async (_request, options) => { pending = readGuidedQueryInstructions(f.preparation(), options.signal); void pending.catch(() => {}); return snapshot; },
    async function* (config, frames) { yield context(config); await nextFrame(frames, isRead);
      expect((await nextFrame(frames, isContextAnswer) as ControlResponseFrame).ok).toBe(false); yield result;
    });
  await f.run(); await expect(pending).rejects.toThrow("required_context_unavailable");
});

test("callback catching a failed read cannot fall back to successful cached guidance", async () => {
  let f!: ReturnType<typeof fixture>;
  f = fixture(async (_request, options) => {
    try { await readGuidedQueryInstructions(f.preparation(), options.signal); } catch { /* A caller cannot turn this into cached success. */ }
    return snapshot;
  }, async function* (config, frames) {
    yield context(config); const read = await nextFrame(frames, isRead) as ControlRequestFrame;
    yield answer(read, { payload: { behavior: "allow" } });
    expect((await nextFrame(frames, isContextAnswer) as ControlResponseFrame).ok).toBe(false); yield result;
  });
  await f.run(); expect(f.writes.filter(isRead)).toHaveLength(1);
});

test("actual SDK reader handle and real guided bridge keep permission input moving during reader wait", async () => {
  const { createGuidedParentBridge } = await import("../../runtime/src/guest/guided-parent-bridge.ts");
  const { dispatchGuidedParentControl } = await import("../../runtime/src/guest/guided-parent-input.ts");
  const { createRpcBridge } = await import("../../runtime/src/rpc/bridge.ts");
  let preparation!: GuidedQueryPreparation, reads = 0, permissionSettled = false;
  const runtimeFrames = new Queue<WinterFrame>();
  let channel!: ReturnType<typeof createGuidedParentBridge>;
  let finish!: () => void;
  const pair = { onRuntimeContext: async (_request: unknown, options: { signal: AbortSignal }) => {
    expect(await readGuidedQueryInstructions(preparation, options.signal)).toBe(raw); expect(permissionSettled).toBe(true); return snapshot;
  }, spawnClaudeCodeProcess(options: Parameters<NonNullable<Options["spawnClaudeCodeProcess"]>>[0]): SpawnedRuntimeProcess {
    consumeGuidedQueryCorrelation(options.guidedQueryClaim!, options.args);
    const config: RuntimeConfig = JSON.parse(options.args[2]!);
    const output = { write(frame: WinterFrame) { runtimeFrames.write(frame); }, end() {} };
    const bridge = createRpcBridge(output, { allowedSubtypes: ["permission", "runtime_context"] });
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    // This is trusted injected protocol DATA, not native owner/reader evidence.
    channel = createGuidedParentBridge({ binding: config.requiredRuntimeContext!, backendSessionId: config.sessionId, cwd: "/guest/source",
      assertOwnerHeld() {}, output, readerPort: { start(request) { reads++; return { result: ready.then(() => ({ ...request, frame: raw })), drained: ready, cancel() {} }; } } });
    channel.bind(bridge);
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { finish = () => resolve({ code: 0, signal: null }); });
    return { stdin: { write(bytes) { for (const frame of splitFrames(bytes, "").frames) {
      if (frame.type === "control_request" && typeof frame.subtype === "string" && ["end_input", "interrupt"].includes(frame.subtype)) continue;
      if (frame.type === "user") continue;
      dispatchGuidedParentControl(channel, frame, () => { throw new Error("reader routing failed"); });
    } }, end() {} }, stdout: (async function* () {
      yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: config.sessionId, cwd: "/guest/source", model: "fixture", permissionMode: "default", tools: [], runtimeContextVersion: 1 });
      const context = channel.resolve({ sessionId: config.sessionId, cwd: "/guest/source", purpose: "generation", attempt: 1 }, { signal: new AbortController().signal });
      const permission = bridge.request("permission", { toolName: "Bash", input: {} }, { requestId: uuid(77) });
      void permission.then(() => { permissionSettled = true; release(); });
      void context.then(value => { expect(value).toEqual(snapshot); runtimeFrames.write(result); runtimeFrames.end(); });
      try { for await (const frame of runtimeFrames) yield encodeFrame(frame); } finally { channel.close(); finish(); }
    })(), exited, kill() {}, pid: null };
  } };
  preparation = prepareGuidedQuery(pair);
  for await (const _ of query({ prompt: "fixture", options: { ...pair, sessionId: "backend", requireRuntimeContext: true, guidedQueryPreparation: preparation,
    canUseTool: async () => ({ behavior: "allow" }) } })) {}
  expect(reads).toBe(1); expect(permissionSettled).toBe(true);
});
