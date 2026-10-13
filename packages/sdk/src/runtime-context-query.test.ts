import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "./query.ts";
import { ProtocolDecodeError } from "./errors.ts";
import { encodeFrame, splitFrames } from "./protocol/codec.ts";
import { PROTOCOL_VERSION, type ControlRequestFrame, type ControlResponseFrame, type WinterFrame } from "./protocol/frames.ts";
import type { RuntimeConfig } from "./protocol/config.ts";
import type { Options } from "./options.ts";
import type { SpawnedRuntimeProcess } from "./transport.ts";
import { inMemoryProcess } from "@yanlinglabs/winter-agent-runtime/testing";
import type { ProviderRequest } from "@yanlinglabs/winter-agent-runtime";
import { Queue } from "../../runtime/src/protocol/channel.ts";
const snapshot = { revision: "r1", facts: "host facts", instructions: "current guidance" };
const request = (config: RuntimeConfig) => ({ bindingId: config.requiredRuntimeContext!.bindingId, sessionId: config.sessionId,
  cwd: "/current/source", purpose: "generation", attempt: 1 });
const init = (config: RuntimeConfig, supported = true): WinterFrame => ({ type: "init", protocolVersion: PROTOCOL_VERSION,
  sessionId: "guest-init-is-not-authority", cwd: "/guest", model: "sonnet", permissionMode: "default", tools: [],
  ...(supported ? { runtimeContextVersion: 1 } : {}) });
const result: WinterFrame = { type: "data", message: { type: "result", subtype: "success", is_error: false } } as WinterFrame;
function transport(config: RuntimeConfig, scenario: (responses: Queue<ControlResponseFrame>) => AsyncIterable<WinterFrame>, writes: WinterFrame[]): SpawnedRuntimeProcess {
  const responses = new Queue<ControlResponseFrame>();
  let finish!: (value: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { finish = resolve; });
  return { stdin: { write(chunk) { for (const frame of splitFrames(chunk, "").frames) { writes.push(frame); if (frame.type === "control_response") responses.write(frame as ControlResponseFrame); } }, end() {} },
    stdout: (async function* () { try { for await (const frame of scenario(responses)) yield encodeFrame(frame); } finally { finish({ code: 0, signal: null }); } })(),
    exited, kill() {}, pid: null };
}
const drain = async (options: Options) => { for await (const _ of query({ prompt: "fixture", options })) {} };
test("required startup pairs host callback and feature; current confined profiles refuse before spawn", async () => {
  let spawns = 0;
  const spawn = () => { spawns++; throw new Error("must not spawn"); };
  for (const options of [{ requireRuntimeContext: true }, { onRuntimeContext: async () => snapshot },
    { requireRuntimeContext: true, onRuntimeContext: async () => snapshot, executionPosture: "confined-guest" as const }]) {
    expect(() => query({ prompt: "fixture", options: { ...options, spawnClaudeCodeProcess: spawn } })).toThrow("required_context_unavailable");
  }
  expect(spawns).toBe(0);
  await expect(drain({ requireRuntimeContext: true, onRuntimeContext: async () => snapshot, spawnClaudeCodeProcess(opts) {
    const config = JSON.parse(opts.args[opts.args.indexOf("--config-json") + 1]!);
    return transport(config, async function* () { yield init(config, false); yield result; }, []);
  } })).rejects.toThrow("required_context_unavailable");
});
test("real query parser binds owning query, preserves lookup identities and strips callbacks from config", async () => {
  const writes: WinterFrame[] = []; let called = 0;
  await drain({ sessionId: "trusted-owner", requireRuntimeContext: true, onRuntimeContext: async (lookup, options) => {
    called++; expect(options.trustedQuerySessionId).toBe("trusted-owner"); expect(options.signal.aborted).toBe(false);
    expect(lookup.sessionId).toBe("trusted-owner"); expect(lookup.agentId).toBe("child"); expect(lookup.cwd).toBe("/current/source");
    expect(Object.isFrozen(lookup)).toBe(true); return snapshot;
  }, spawnClaudeCodeProcess(opts) {
    const raw = opts.args[opts.args.indexOf("--config-json") + 1]!, config: RuntimeConfig = JSON.parse(raw);
    expect(raw).not.toContain("onRuntimeContext"); expect(raw).not.toContain(snapshot.instructions);
    return transport(config, async function* (responses) { yield init(config);
      yield { type: "control_request", subtype: "runtime_context", requestId: "context-1", payload: { ...request(config), agentId: "child" } };
      const response = await responses[Symbol.asyncIterator]().next(); expect(response.value).toEqual({ type: "control_response", requestId: "context-1", ok: true, payload: snapshot }); yield result;
    }, writes);
  } });
  expect(called).toBe(1);
});
test("foreign binding, authority fields and host canonical ownership refusal never leak callback errors", async () => {
  for (const scenario of ["binding", "authority", "foreign-session", "bad-snapshot", "throw"]) {
    let called = 0;
    await drain({ sessionId: "trusted-owner", requireRuntimeContext: true, onRuntimeContext: async (lookup, options) => {
      called++; if (lookup.sessionId !== options.trustedQuerySessionId || scenario === "throw") throw new Error("/protected/path credential-secret");
      if (scenario === "bad-snapshot") return { ...snapshot, credentials: "secret" }; return snapshot;
    }, spawnClaudeCodeProcess(opts) {
      const config: RuntimeConfig = JSON.parse(opts.args[opts.args.indexOf("--config-json") + 1]!);
      const payload = { ...request(config), ...(scenario === "binding" ? { bindingId: "foreign" } : {}),
        ...(scenario === "authority" ? { grants: ["all"] } : {}), ...(scenario === "foreign-session" ? { sessionId: "foreign" } : {}) };
      return transport(config, async function* (responses) { yield init(config);
        yield { type: "control_request", subtype: "runtime_context", requestId: "context-1", payload };
        const response = await responses[Symbol.asyncIterator]().next();
        expect(response.value).toEqual({ type: "control_response", requestId: "context-1", ok: false, error: { code: "required_context_unavailable", message: "required_context_unavailable" } }); yield result;
      }, []);
    } });
    expect(called).toBe(scenario === "binding" || scenario === "authority" ? 0 : 1);
  }
});
test("runtime cancellation aborts actual host callback and drops late response", async () => {
  let ready!: () => void, stopped!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), aborted = new Promise<void>(resolve => { stopped = resolve; });
  const writes: WinterFrame[] = [];
  await drain({ requireRuntimeContext: true, onRuntimeContext: async (_, { signal }) => {
    ready(); await new Promise<void>(resolve => { signal.addEventListener("abort", () => { stopped(); resolve(); }, { once: true }); }); return snapshot;
  }, spawnClaudeCodeProcess(opts) {
    const config: RuntimeConfig = JSON.parse(opts.args[opts.args.indexOf("--config-json") + 1]!);
    return transport(config, async function* () { yield init(config);
      yield { type: "control_request", subtype: "runtime_context", requestId: "context-1", payload: request(config) };
      await started; yield { type: "control_cancel_request", requestId: "context-1" }; await aborted; yield result;
    }, writes);
  } });
  expect(writes.filter(frame => frame.type === "control_response")).toEqual([]);
});
test("malformed dedicated envelope fails parser without invoking host callback", async () => {
  let called = 0;
  await expect(drain({ requireRuntimeContext: true, onRuntimeContext: async () => { called++; return snapshot; }, spawnClaudeCodeProcess(opts) {
    const config: RuntimeConfig = JSON.parse(opts.args[opts.args.indexOf("--config-json") + 1]!);
    return transport(config, async function* () { yield init(config);
      yield { type: "control_request", subtype: "runtime_context", requestId: "/foreign/path", payload: request(config) }; yield result;
    }, []);
  } })).rejects.toThrow("required_context_unavailable"); expect(called).toBe(0);
});
test("normal query runtime adapter sends fresh current guidance to actual model requests", async () => {
  const home = mkdtempSync(join(tmpdir(), "winter-context-rpc-")), observed: ProviderRequest[] = [], bindings: string[] = [];
  writeFileSync(join(home, "WINTER.md"), "stale cached Code guidance");
  try {
    for (const instructions of ["first live guidance", "edited current source guidance"]) {
      await drain({ sessionId: "trusted-owner", cwd: home, env: { WINTER_HOME: home }, persistSession: false, model: "winter-test/echo", settingSources: [], tools: [],
        requireRuntimeContext: true, onRuntimeContext: async (lookup, options) => { expect(options.trustedQuerySessionId).toBe("trusted-owner"); bindings.push(lookup.bindingId); return { ...snapshot, instructions }; },
        spawnClaudeCodeProcess(opts) { return inMemoryProcess(opts.args, { async generate(input) { observed.push(input); return { kind: "text", text: "done" }; } }, undefined, { WINTER_HOME: home }); } });
      const model = JSON.stringify(observed.at(-1)); expect(model).toContain(instructions); expect(model).toContain(snapshot.facts);
      expect(model).not.toContain("stale cached Code guidance"); expect(model).not.toContain(bindings.at(-1)!);
    }
    expect(bindings).toHaveLength(2); expect(bindings[0]).not.toBe(bindings[1]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test("ordinary Code query serializes no context opt-in or handshake requirement", async () => {
  await drain({ spawnClaudeCodeProcess(opts) {
    const raw = opts.args[opts.args.indexOf("--config-json") + 1]!, config: RuntimeConfig = JSON.parse(raw);
    expect(raw).not.toContain("RuntimeContext"); expect(raw).not.toContain("runtime_context");
    return transport(config, async function* () { yield init(config, false); yield result; }, []);
  } });
});

test("required query refuses an invalid owning identity before spawn", () => {
  let spawns = 0;
  expect(() => query({ prompt: "fixture", options: { sessionId: "", requireRuntimeContext: true, onRuntimeContext: async () => snapshot,
    spawnClaudeCodeProcess() { spawns++; throw new Error("must not spawn"); } } })).toThrow("required_context_unavailable");
  expect(spawns).toBe(0);
});

test("real query transport shares one parent bridge across ordinary, specialized and forked child engines", async () => {
  const { registerTool, unregisterToolForTest } = await import("../../runtime/src/tools/registry.ts");
  const { resetChildEngineFactoryForTest } = await import("../../runtime/src/subagents/child-handle.ts");
  const { resetSpawnLimitsForTest } = await import("../../runtime/src/subagents/limits.ts");
  type SpawnChildRequest = import("../../runtime/src/subagents/child-handle.ts").SpawnChildRequest;
  const home = mkdtempSync(join(tmpdir(), "winter-context-child-rpc-")), name = "RuntimeContextChildProbe";
  const actors: string[] = [], nonces = new Set<string>(), children: ProviderRequest[] = [];
  let parentDispatches = 0;
  registerTool({ descriptor: { canonicalName: name, advertisedName: name, source: "builtin", inputSchema: { type: "object" },
    description: "fixture child probe", exposure: "eager", permissionClass: "read", availability: {}, capabilityRequirements: [], disposition: "implement-now" },
    executor: { execute: async (input, context) => { const child = await context.session.spawnChild!(input as SpawnChildRequest); return { output: JSON.stringify(await child.result()) }; } } });
  try {
    await drain({ sessionId: "trusted-owner", cwd: home, env: { WINTER_HOME: home }, persistSession: false, model: "winter-test/echo", settingSources: [], tools: [name],
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, requireRuntimeContext: true,
      onRuntimeContext: async (lookup, options) => {
        expect(options.trustedQuerySessionId).toBe("trusted-owner"); expect(lookup.sessionId).toBe("trusted-owner"); nonces.add(lookup.bindingId);
        if (lookup.agentId !== undefined) actors.push(lookup.agentId);
        // This fixture authorizes only its own synthetic children. A product host must do canonical lookup.
        return { ...snapshot, instructions: lookup.agentId ? "CURRENT-CHILD-RPC" : "CURRENT-PARENT-RPC" };
      }, spawnClaudeCodeProcess(opts) { return inMemoryProcess(opts.args, { async generate(input) {
        if (JSON.stringify(input.messages).includes("CURRENT-CHILD-RPC")) { children.push(input); return { kind: "text", text: "child done" }; }
        if (parentDispatches++ === 0) return { kind: "tool_use", calls: [
          { id: "ordinary", name, input: { parentToolUseId: "ordinary", prompt: "ordinary task", runInBackground: false } },
          { id: "specialized", name, input: { parentToolUseId: "specialized", prompt: "specialized task", runInBackground: false, definition: { description: "specialized", prompt: "persona", omitProjectContext: true } } },
          { id: "fork", name, input: { parentToolUseId: "fork", prompt: "fork task", runInBackground: false, fork: true } },
        ] };
        return { kind: "text", text: "parent done" };
      } }, undefined, { WINTER_HOME: home }); } });
    expect(children).toHaveLength(3); expect(new Set(actors).size).toBe(3); expect(nonces.size).toBe(1);
    for (const child of children) { expect(JSON.stringify(child.messages)).toContain("CURRENT-CHILD-RPC"); expect(JSON.stringify(child.messages)).not.toContain("CURRENT-PARENT-RPC"); }
  } finally { unregisterToolForTest(name); resetChildEngineFactoryForTest(); resetSpawnLimitsForTest(); rmSync(home, { recursive: true, force: true }); }
});

test("resumed query uses a fresh adapter and host-owned query identity, not its saved session descriptor", async () => {
  const home = mkdtempSync(join(tmpdir(), "winter-context-resume-rpc-")), nonces: string[] = [], modelRequests: ProviderRequest[] = [];
  try {
    for (const resumed of [false, true]) {
      let runtime: SpawnedRuntimeProcess | undefined;
      await drain({ sessionId: resumed ? "00000000-0000-4000-8000-000000000002" : "00000000-0000-4000-8000-000000000001", ...(resumed ? { resume: "00000000-0000-4000-8000-000000000001" } : {}),
        cwd: home, env: { WINTER_HOME: home }, model: "winter-test/echo", settingSources: [], tools: [], requireRuntimeContext: true,
        onRuntimeContext: async (lookup, options) => {
          expect(options.trustedQuerySessionId).toBe(resumed ? "00000000-0000-4000-8000-000000000002" : "00000000-0000-4000-8000-000000000001");
          // Canonical fixture relation: this second query is authorized to resume 00000000-0000-4000-8000-000000000001.
          expect(lookup.sessionId).toBe("00000000-0000-4000-8000-000000000001"); nonces.push(lookup.bindingId);
          return { ...snapshot, instructions: resumed ? "RESUMED-CURRENT" : "FIRST-CURRENT" };
        }, spawnClaudeCodeProcess(opts) { runtime = inMemoryProcess(opts.args, { async generate(input) { modelRequests.push(input); return { kind: "text", text: "done" }; } }, undefined, { WINTER_HOME: home }); return runtime; } });
      expect(await runtime!.exited).toEqual({ code: 0, signal: null });
      if (!resumed) {
        const transcripts = readdirSync(home, { recursive: true, encoding: "utf8" }).filter(path => path.endsWith(".jsonl") && path.includes("00000000-0000-4000-8000-000000000001"));
        expect(transcripts.length).toBeGreaterThan(0);
        expect(transcripts.map(path => readFileSync(join(home, path), "utf8")).join("\n")).toContain("done");
      }
    }
    expect(modelRequests[1]!.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("done"))).toBe(true);
    expect(nonces).toHaveLength(2); expect(nonces[0]).not.toBe(nonces[1]);
    expect(JSON.stringify(modelRequests[1])).toContain("RESUMED-CURRENT"); expect(JSON.stringify(modelRequests[1])).not.toContain("FIRST-CURRENT");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("failed host resolution through actual query adapter dispatches no model request or stale Code guidance", async () => {
  const home = mkdtempSync(join(tmpdir(), "winter-context-fail-rpc-")); let dispatched = 0;
  writeFileSync(join(home, "WINTER.md"), "stale fallback");
  try {
    let failure: unknown; const results: unknown[] = [];
    try { for await (const message of query({ prompt: "fixture", options: { cwd: home, env: { WINTER_HOME: home }, model: "winter-test/echo", persistSession: false, settingSources: [], tools: [],
      requireRuntimeContext: true, onRuntimeContext: async () => { throw new Error("/protected/path credential-secret"); },
      spawnClaudeCodeProcess(opts) { return inMemoryProcess(opts.args, { async generate() { dispatched++; return { kind: "text", text: "must not dispatch" }; } }, undefined, { WINTER_HOME: home }); } } })) results.push(message); }
    catch (error) { failure = error; }
    expect(failure).toBeDefined(); expect(JSON.stringify(results)).toContain("required_context_unavailable"); expect(String(failure)).not.toContain("credential-secret"); expect(dispatched).toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("query terminal teardown and actual transport exit abort pending host context without late response", async () => {
  for (const terminal of [false, true]) {
    let ready!: () => void, stop!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; }), aborted = new Promise<void>(resolve => { stop = resolve; });
    const writes: WinterFrame[] = [];
    let failure: unknown;
    try { await drain({ requireRuntimeContext: true, onRuntimeContext: async (_, { signal }) => {
      ready(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { stop(); resolve(); }, { once: true })); return snapshot;
    }, spawnClaudeCodeProcess(opts) {
      const config: RuntimeConfig = JSON.parse(opts.args[opts.args.indexOf("--config-json") + 1]!);
      return transport(config, async function* () { yield init(config);
        yield { type: "control_request", subtype: "runtime_context", requestId: "context-1", payload: request(config) };
        await started; if (terminal) yield result;
      }, writes);
    } }); } catch (error) { failure = error; }
    await aborted;
    if (terminal) expect(failure).toBeUndefined(); else expect(failure).toBeDefined();
    expect(writes.filter(frame => frame.type === "control_response")).toEqual([]);
  }
});

test("opted-in parser redacts malformed wire bytes rather than echoing protected details", async () => {
  let called = 0;
  await expect(drain({ requireRuntimeContext: true, onRuntimeContext: async () => { called++; return snapshot; }, spawnClaudeCodeProcess(opts) {
    const config: RuntimeConfig = JSON.parse(opts.args[opts.args.indexOf("--config-json") + 1]!);
    return { stdin: { write() {}, end() {} }, stdout: (async function* () { yield encodeFrame(init(config)); yield '{"/protected/path credential-secret"\n'; })(),
      exited: new Promise(() => {}), kill() {}, pid: null };
  } })).rejects.toThrow(/^required_context_unavailable$/);
  expect(called).toBe(0);
});

test.each(["permission", "hook"] as const)("active context identity cannot be overwritten by a registered %s request", async subtype => {
  let ready!: () => void, stopped!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), aborted = new Promise<void>(resolve => { stopped = resolve; });
  const writes: WinterFrame[] = [], messages: unknown[] = [];
  let secondCallbacks = 0, postCollisionDispatches = 0, failure: unknown;
  const options: Options = { requireRuntimeContext: true,
    onRuntimeContext: async (_, { signal }) => {
      ready(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped(); resolve(); }, { once: true }));
      return snapshot; // A late successful callback result must never be returned to the runtime.
    },
    canUseTool: async () => { secondCallbacks++; return { behavior: "allow", updatedInput: {} }; },
    hooks: { PreToolUse: [{ hooks: [async () => { secondCallbacks++; return {}; }] }] },
    spawnClaudeCodeProcess(opts) {
      const config: RuntimeConfig = JSON.parse(opts.args[opts.args.indexOf("--config-json") + 1]!);
      const payload = subtype === "permission"
        ? { toolName: "Fixture", input: {}, suggestions: [], toolUseID: "tool-X", requestId: "X", policyVersion: 0 }
        : { hookId: "PreToolUse:sdk:0:0", event: "PreToolUse", sessionId: config.sessionId, toolUseID: "tool-X", toolName: "Fixture", input: {}, requestId: "X", policyVersion: "0" };
      return transport(config, async function* () { yield init(config);
        yield { type: "control_request", subtype: "runtime_context", requestId: "X", payload: request(config) };
        await started;
        yield { type: "control_request", subtype, requestId: "X", payload };
        postCollisionDispatches++;
        yield { type: "control_cancel_request", requestId: "X" };
        yield result;
      }, writes);
    },
  };
  try { for await (const message of query({ prompt: "fixture", options })) messages.push(message); } catch (error) { failure = error; }
  await aborted; await Promise.resolve(); await Promise.resolve();
  expect(failure).toBeInstanceOf(ProtocolDecodeError); expect((failure as Error).message).toBe("required_context_unavailable");
  expect(secondCallbacks).toBe(0); expect(postCollisionDispatches).toBe(0); expect(messages).toEqual([]);
  expect(writes.filter(frame => frame.type === "control_response")).toEqual([]);
});

test("a runtime context request before the feature handshake cannot invoke the host callback", async () => {
  let called = 0; const writes: WinterFrame[] = [];
  let failure: unknown;
  try { await drain({ requireRuntimeContext: true, onRuntimeContext: async () => { called++; return snapshot; }, spawnClaudeCodeProcess(opts) {
    const config: RuntimeConfig = JSON.parse(opts.args[opts.args.indexOf("--config-json") + 1]!);
    return transport(config, async function* () {
      yield { type: "control_request", subtype: "runtime_context", requestId: "X", payload: request(config) };
      yield init(config); yield result;
    }, writes);
  } }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ProtocolDecodeError);
  expect((failure as Error).message).toBe("protocol violation: expected 'init' as the first frame, got 'control_request' (runtime_context)");
  expect(called).toBe(0); expect(writes.filter(frame => frame.type === "control_response")).toEqual([]);
});
