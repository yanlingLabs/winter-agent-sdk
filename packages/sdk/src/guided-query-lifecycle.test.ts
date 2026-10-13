import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { query } from "./query.ts";
import type { Options } from "./options.ts";
import type { SpawnRuntimeOptions, SpawnedRuntimeProcess } from "./transport.ts";
import { prepareGuidedQuery, claimGuidedQuery, closeGuidedQuery, consumeGuidedQueryCorrelation, assertGuidedQueryCorrelation,
  type GuidedQueryPreparation, type GuidedQueryClaim, type GuidedQueryCorrelation } from "./guided-query-preparation.ts";
import { encodeFrame, splitFrames } from "./protocol/codec.ts";
import { PROTOCOL_VERSION, type WinterFrame, type ControlResponseFrame } from "./protocol/frames.ts";
import type { RuntimeConfig } from "./protocol/config.ts";
import { Queue } from "../../runtime/src/protocol/channel.ts";
import { inMemoryProcess } from "@yanlinglabs/winter-agent-runtime/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const snapshot = { revision: "r1", facts: "host facts", instructions: "current guidance" };
const init = (config: RuntimeConfig): WinterFrame => ({ type: "init", protocolVersion: PROTOCOL_VERSION,
  sessionId: config.sessionId, cwd: config.cwd, model: config.model, permissionMode: "default", tools: [], runtimeContextVersion: 1 });
const result: WinterFrame = { type: "data", message: { type: "result", subtype: "success", is_error: false } } as WinterFrame;
const request = (config: RuntimeConfig): WinterFrame => ({ type: "control_request", subtype: "runtime_context", requestId: "context-1",
  payload: { bindingId: config.requiredRuntimeContext!.bindingId, sessionId: config.sessionId, cwd: config.cwd, purpose: "generation", attempt: 1 } });
function virtual(scenario?: (responses: Queue<ControlResponseFrame>) => AsyncIterable<WinterFrame>) {
  const responses = new Queue<ControlResponseFrame>(), writes: WinterFrame[] = [], kills: (string | undefined)[] = [];
  let ends = 0, resolve!: (x: { code: number | null; signal: string | null }) => void, reject!: (error: Error) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>((yes, no) => { resolve = yes; reject = no; });
  const proc: SpawnedRuntimeProcess = {
    stdin: { write(chunk) { for (const frame of splitFrames(chunk, "").frames) { writes.push(frame);
      if (frame.type === "control_response") responses.write(frame as ControlResponseFrame);
    } }, end() { ends++; } },
    stdout: (async function* () { if (scenario) for await (const frame of scenario(responses)) yield encodeFrame(frame); })(),
    exited, kill(signal) { kills.push(signal); }, pid: null,
  };
  return { proc, writes, kills, ends: () => ends, finish: () => resolve({ code: 0, signal: null }), reject };
}
const drain = async (options: Options) => { for await (const _ of query({ prompt: "fixture", options })) {} };
const refusal = (call: () => unknown) => expect(call).toThrow("required_context_unavailable");
function prepared(spawn: (opts: SpawnRuntimeOptions) => SpawnedRuntimeProcess, callback: NonNullable<Options["onRuntimeContext"]> = async () => snapshot) {
  let observed: { claim: GuidedQueryClaim; expected: GuidedQueryCorrelation; args: string[] } | undefined;
  const pair = { spawnClaudeCodeProcess(opts: SpawnRuntimeOptions) {
    if (opts.guidedQueryClaim) observed = { claim: opts.guidedQueryClaim, expected: JSON.parse(opts.args[2]!).requiredRuntimeContext, args: opts.args };
    return spawn(opts);
  }, onRuntimeContext: callback };
  const preparation = prepareGuidedQuery(pair);
  const options: Options = { ...pair, guidedQueryPreparation: preparation, requireRuntimeContext: true, sessionId: "owner" };
  return { pair, preparation, options,
    active: () => { expect(observed).toBeDefined(); assertGuidedQueryCorrelation(observed!.claim, observed!.expected); },
    closed: () => { refusal(() => claimGuidedQuery(preparation, pair));
      const state = observed;
      if (state) { refusal(() => assertGuidedQueryCorrelation(state.claim, state.expected)); refusal(() => consumeGuidedQueryCorrelation(state.claim, state.args)); }
    } };
}
test("actual query owns one hook/nonce and never serializes opaque tokens", async () => {
  let callbacks = 0, spawns = 0, handle!: ReturnType<typeof virtual>;
  const f = prepared(opts => {
    spawns++; expect(opts.guidedQueryClaim).toBeDefined();
    expect(JSON.stringify(opts.args) + JSON.stringify(opts.env)).not.toContain("guidedQuery");
    const config: RuntimeConfig = JSON.parse(opts.args[2]!);
    expect(Object.keys(config)).not.toContain("guidedQueryPreparation");
    consumeGuidedQueryCorrelation(opts.guidedQueryClaim!, opts.args);
    handle = virtual(async function* (responses) { yield init(config); yield request(config);
      expect((await responses[Symbol.asyncIterator]().next()).value).toEqual({ type: "control_response", requestId: "context-1", ok: true, payload: snapshot }); yield result;
    }); return handle.proc;
  }, async () => { callbacks++; return snapshot; });
  await drain({ ...f.options }); // Options spread preserves the SAME opaque identity and functions.
  f.closed(); handle.finish(); expect(spawns).toBe(1); expect(callbacks).toBe(1); expect(handle.ends()).toBe(1);
  refusal(() => query({ prompt: "retry", options: f.options })); expect(spawns).toBe(1);
});
test("forged/copied tokens, mismatched functions and incomplete opt-in refuse before hook", () => {
  let spawns = 0, callbacks = 0;
  const make = () => prepared(() => { spawns++; throw new Error("hook tripwire"); }, async () => { callbacks++; return snapshot; });
  for (const kind of ["forged", "spread", "clone", "assign", "callback", "hook", "missing-hook", "missing-callback", "required-false", "confined"]) {
    const f = make(), options = { ...f.options };
    if (kind === "forged") options.guidedQueryPreparation = {} as GuidedQueryPreparation;
    if (kind === "spread") options.guidedQueryPreparation = { ...f.preparation };
    if (kind === "clone") options.guidedQueryPreparation = structuredClone(f.preparation);
    if (kind === "assign") options.guidedQueryPreparation = Object.assign({}, f.preparation);
    if (kind === "callback") options.onRuntimeContext = async () => snapshot;
    if (kind === "hook") options.spawnClaudeCodeProcess = () => { spawns++; throw new Error("foreign hook"); };
    if (kind === "missing-hook") delete options.spawnClaudeCodeProcess;
    if (kind === "missing-callback") delete options.onRuntimeContext;
    if (kind === "required-false") options.requireRuntimeContext = false;
    if (kind === "confined") options.executionPosture = "confined-guest";
    refusal(() => query({ prompt: "fixture", options })); closeGuidedQuery(f.preparation);
  }
  expect(spawns).toBe(0); expect(callbacks).toBe(0);
});
test("callback/hook accessors refuse without invocation", () => {
  for (const field of ["onRuntimeContext", "spawnClaudeCodeProcess"] as const) {
    let reads = 0; const f = prepared(() => { throw new Error("unexpected hook"); });
    Object.defineProperty(f.options, field, { get() { reads++; return f.pair[field]; } });
    refusal(() => query({ prompt: "fixture", options: f.options })); expect(reads).toBe(0); f.closed();
  }
});
test("prototype-inherited confined posture cannot be masked; inherited accessor is never read", () => {
  let hooks = 0, callbacks = 0, getters = 0;
  for (const accessor of [false, true]) {
    const f = prepared(() => { hooks++; throw new Error("hook tripwire"); }, async () => { callbacks++; return snapshot; });
    const prototype = accessor ? Object.defineProperty({}, "executionPosture", { get() { getters++; return "confined-guest"; } })
      : { executionPosture: "confined-guest" };
    Object.setPrototypeOf(f.options, prototype);
    refusal(() => query({ prompt: "fixture", options: f.options })); f.closed();
  }
  expect(hooks).toBe(0); expect(callbacks).toBe(0); expect(getters).toBe(0);
});
test("own local posture wins over inherited confined posture", async () => {
  let hooks = 0, handle!: ReturnType<typeof virtual>;
  const f = prepared(opts => { hooks++; consumeGuidedQueryCorrelation(opts.guidedQueryClaim!, opts.args);
    const config: RuntimeConfig = JSON.parse(opts.args[2]!); expect(config.executionPosture).toBe("local");
    handle = virtual(async function* () { yield init(config); yield result; }); return handle.proc;
  });
  Object.setPrototypeOf(f.options, { executionPosture: "confined-guest" }); f.options.executionPosture = "local";
  await drain(f.options); f.closed(); handle.finish(); expect(hooks).toBe(1);
});
test("captured pair survives hook mutation; foreign callback and fallback hook never run", async () => {
  let callbacks = 0, foreign = 0, spawns = 0, handle!: ReturnType<typeof virtual>;
  const f = prepared(opts => {
    spawns++; consumeGuidedQueryCorrelation(opts.guidedQueryClaim!, opts.args);
    f.options.onRuntimeContext = async () => { foreign++; return snapshot; };
    f.options.spawnClaudeCodeProcess = () => { foreign++; throw new Error("foreign hook"); };
    f.options.requireRuntimeContext = false;
    const config: RuntimeConfig = JSON.parse(opts.args[2]!);
    handle = virtual(async function* (responses) { yield init(config); yield request(config);
      expect(((await responses[Symbol.asyncIterator]().next()).value as ControlResponseFrame).ok).toBe(true); yield result;
    }); return handle.proc;
  }, async () => { callbacks++; return snapshot; });
  await drain(f.options); handle.finish(); expect(callbacks).toBe(1); expect(spawns).toBe(1); expect(foreign).toBe(0);
});
test("missing/foreign/closed correlation refuses before prompt or context callback and tears down", () => {
  for (const kind of ["missing", "foreign", "closed"]) {
    const handle = virtual(); let callbacks = 0;
    const f = prepared(opts => {
      if (kind === "foreign") { const config = JSON.parse(opts.args[2]!); config.requiredRuntimeContext.bindingId = randomUUID(); consumeGuidedQueryCorrelation(opts.guidedQueryClaim!, ["--run", "--config-json", JSON.stringify(config)]); }
      if (kind === "closed") { consumeGuidedQueryCorrelation(opts.guidedQueryClaim!, opts.args); closeGuidedQuery(f.preparation); }
      return handle.proc;
    }, async () => { callbacks++; return snapshot; });
    refusal(() => query({ prompt: "fixture", options: f.options }));
    expect(handle.writes).toEqual([]); expect(callbacks).toBe(0); expect(handle.ends()).toBe(1); expect(handle.kills).toEqual([undefined]); f.closed(); handle.finish();
  }
});
test("setup and hook throws close separately; setup throw after a valid hook return requests cleanup", () => {
  const early = prepared(() => { throw new Error("hook throw"); });
  expect(() => query({ prompt: "fixture", options: early.options })).toThrow("hook throw"); early.closed();
  const before = prepared(() => { throw new Error("must not hook"); });
  Object.defineProperty(before.options, "brand", { get() { throw new Error("setup before hook"); } });
  expect(() => query({ prompt: "fixture", options: before.options })).toThrow("setup before hook"); before.closed();
  const controller = prepared(() => { throw new Error("must not hook"); });
  Object.defineProperty(controller.options, "abortController", { get() { throw new Error("setup controller"); } });
  expect(() => query({ prompt: "fixture", options: controller.options })).toThrow("setup controller"); controller.closed();
  const handle = virtual(), after = prepared(opts => { consumeGuidedQueryCorrelation(opts.guidedQueryClaim!, opts.args); return handle.proc; });
  Object.defineProperty(after.options, "maxBufferSize", { get() { throw new Error("setup after hook"); } });
  expect(() => query({ prompt: "fixture", options: after.options })).toThrow("setup after hook"); after.closed();
  expect(handle.writes).toEqual([]); expect(handle.ends()).toBe(1); expect(handle.kills).toEqual([undefined]); handle.finish();
});
test("pre-abort closes an authentic preparation without hook; forged still refuses", async () => {
  const abortController = new AbortController(); abortController.abort(); let spawns = 0;
  const f = prepared(() => { spawns++; throw new Error("hook tripwire"); });
  await expect(drain({ ...f.options, abortController })).rejects.toThrow("query aborted"); f.closed(); expect(spawns).toBe(0);
  refusal(() => query({ prompt: "fixture", options: { ...f.options, guidedQueryPreparation: {} as GuidedQueryPreparation, abortController } }));
});
test("mid-abort closes synchronously before iteration and preserves process kill discipline", () => {
  const handle = virtual(), abortController = new AbortController();
  const f = prepared(opts => { consumeGuidedQueryCorrelation(opts.guidedQueryClaim!, opts.args); return handle.proc; });
  query({ prompt: "fixture", options: { ...f.options, abortController } }); abortController.abort();
  f.closed(); expect(handle.writes).toEqual([]); expect(handle.kills).toEqual([undefined]); handle.finish();
});
test("hook cannot substitute the query's original abort controller", () => {
  const handle = virtual(), abortController = new AbortController(), foreign = new AbortController();
  const f = prepared(opts => { consumeGuidedQueryCorrelation(opts.guidedQueryClaim!, opts.args);
    f.options.abortController = foreign; return handle.proc; });
  f.options.abortController = abortController;
  query({ prompt: "fixture", options: f.options }); f.active(); abortController.abort();
  f.closed(); expect(handle.kills).toEqual([undefined]); expect(handle.writes).toEqual([]); handle.finish();
});
test("both observed exit resolution and rejection close without interpreting success", async () => {
  for (const kind of ["resolve", "reject"]) {
    const handle = virtual(), f = prepared(opts => { consumeGuidedQueryCorrelation(opts.guidedQueryClaim!, opts.args); return handle.proc; });
    const gen = query({ prompt: "fixture", options: f.options });
    if (kind === "resolve") handle.finish(); else handle.reject(new Error("injected exit rejection"));
    await Promise.resolve(); f.closed(); await gen.return(undefined); expect(handle.writes).toEqual([]);
  }
});
test("return and throw before first next close and request teardown, without prompt", async () => {
  for (const kind of ["return", "throw"]) {
    const handle = virtual(), f = prepared(opts => { consumeGuidedQueryCorrelation(opts.guidedQueryClaim!, opts.args); return handle.proc; });
    const gen = query({ prompt: "fixture", options: f.options });
    if (kind === "return") { const done = gen.return(undefined); f.closed(); await done; }
    else { try { await gen.throw(new Error("consumer throw")); throw new Error("throw missing"); }
      catch (error) { expect((error as Error).message).toBe("consumer throw"); } f.closed(); }
    expect(handle.writes).toEqual([]); expect(handle.ends()).toBe(1); expect(handle.kills).toEqual([undefined]); handle.finish();
  }
});
test("closed preparation cannot start a late callback or answer a callback closed while awaiting", async () => {
  for (const kind of ["before", "during"]) {
    let callbacks = 0, handle!: ReturnType<typeof virtual>;
    const f = prepared(opts => { consumeGuidedQueryCorrelation(opts.guidedQueryClaim!, opts.args); const config: RuntimeConfig = JSON.parse(opts.args[2]!);
      handle = virtual(async function* (responses) { yield init(config);
        if (kind === "before") closeGuidedQuery(f.preparation); yield request(config);
        const response = (await responses[Symbol.asyncIterator]().next()).value as ControlResponseFrame;
        expect(response.ok).toBe(false); expect(response.error?.code).toBe("required_context_unavailable"); yield result;
      }); return handle.proc;
    }, async () => { callbacks++; closeGuidedQuery(f.preparation); await Promise.resolve(); return snapshot; });
    await drain(f.options); handle.finish(); expect(callbacks).toBe(kind === "before" ? 0 : 1);
  }
});
test("ordinary no-opt-in spawn/config shape remains unchanged and owns no claim", async () => {
  let handle!: ReturnType<typeof virtual>;
  await drain({ sessionId: "ordinary", cwd: "/fixture/source", env: { PATH: "/bin" }, model: "fixture/model", spawnClaudeCodeProcess(opts) {
    expect(Object.hasOwn(opts, "guidedQueryClaim")).toBe(false);
    expect(Object.keys(opts)).toEqual(["command", "args", "cwd", "env", "hostPidEnv"]);
    const config: RuntimeConfig = JSON.parse(opts.args[2]!);
    expect(opts.args).toEqual(["--run", "--config-json", JSON.stringify(config)]);
    expect(Object.hasOwn(config, "requiredRuntimeContext")).toBe(false);
    expect(Object.hasOwn(config, "guidedQueryPreparation")).toBe(false);
    handle = virtual(async function* () { yield init(config); yield result; }); return handle.proc;
  } }); handle.finish();
});
test("real SDK/engine model callbacks stay zero on failed correlation and run only after consumed correlation", async () => {
  for (const consume of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), "winter-guided-lifecycle-"));
    let models = 0, contexts = 0, proc!: SpawnedRuntimeProcess;
    const f = prepared(opts => {
      if (consume) consumeGuidedQueryCorrelation(opts.guidedQueryClaim!, opts.args);
      proc = inMemoryProcess(opts.args, { async generate() { models++; return { kind: "text", text: "done" }; } }, undefined, { WINTER_HOME: home });
      return proc;
    }, async () => { contexts++; return snapshot; });
    const options = { ...f.options, cwd: home, model: "winter-test/echo", env: { WINTER_HOME: home }, tools: [], settingSources: [], persistSession: false };
    try {
      if (consume) await drain(options); else refusal(() => query({ prompt: "fixture", options }));
      await proc.exited; f.closed(); expect(models).toBe(consume ? 1 : 0); expect(contexts).toBe(consume ? 1 : 0);
    } finally { proc?.kill(); rmSync(home, { recursive: true, force: true }); }
  }
});
