import { expect, test } from "bun:test";
import type { WinterFrame, ControlRequestFrame } from "@yanlinglabs/winter-agent-sdk";
import { createRpcBridge } from "../rpc/bridge.ts";
import { createRuntimeContextChannel } from "./runtime-context-channel.ts";
import { resolveRequiredContext } from "./required-context.ts";
const request = { sessionId: "owner", cwd: "/fixture", purpose: "generation" as const, attempt: 1 };
const snapshot = { revision: "r1", facts: "facts", instructions: "instructions" };
test("unbound adapter refuses; bind once avoids child engines overwriting parent transport", async () => {
  const source = createRuntimeContextChannel({ version: 1, bindingId: "one" });
  await expect(resolveRequiredContext(source, request)).rejects.toThrow("required_context_unavailable");
  const frames: WinterFrame[] = [], bridge = createRpcBridge({ write: frame => frames.push(frame), end() {} });
  source.bind(bridge);
  expect(() => source.bind(createRpcBridge({ write() {}, end() {} }))).toThrow("required_context_unavailable");
  const first = resolveRequiredContext(source, request), second = resolveRequiredContext(source, { ...request, agentId: "child", purpose: "compaction" });
  await Promise.resolve(); await Promise.resolve();
  const requests = frames as ControlRequestFrame[];
  expect(requests.map(frame => frame.subtype)).toEqual(["runtime_context", "runtime_context"]);
  expect(requests[0]!.requestId).not.toBe(requests[1]!.requestId);
  expect(requests.map(frame => frame.payload)).toEqual([{ ...request, bindingId: "one" }, { ...request, agentId: "child", purpose: "compaction", bindingId: "one" }]);
  bridge.handleResponse({ type: "control_response", requestId: requests[1]!.requestId, ok: true, payload: { ...snapshot, revision: "child" } });
  bridge.handleResponse({ type: "control_response", requestId: requests[0]!.requestId, ok: true, payload: snapshot });
  expect(await first).toEqual(snapshot); expect((await second).revision).toBe("child");
  source.close(); await expect(resolveRequiredContext(source, request)).rejects.toThrow("required_context_unavailable");
  expect(() => source.bind(bridge)).toThrow("required_context_unavailable");
});
test("abort and parent teardown cancel pending RPC; stale response never supplies a fallback", async () => {
  for (const close of [false, true]) {
    const frames: WinterFrame[] = [], bridge = createRpcBridge({ write: frame => frames.push(frame), end() {} });
    const source = createRuntimeContextChannel({ version: 1, bindingId: "one" }), abort = new AbortController(); source.bind(bridge);
    const pending = resolveRequiredContext(source, request, abort.signal); void pending.catch(() => {});
    await Promise.resolve(); await Promise.resolve();
    const id = (frames[0] as ControlRequestFrame).requestId;
    if (close) source.close(); else abort.abort();
    await expect(pending).rejects.toThrow(close ? "required_context_unavailable" : "required_context_cancelled");
    expect(frames.at(-1)).toEqual({ type: "control_cancel_request", requestId: id });
    expect(bridge.ownsRequest(id)).toBe(false);
    expect(bridge.handleResponse({ type: "control_response", requestId: id, ok: true, payload: snapshot })).toBe(false);
  }
});
test("host errors and malformed responses normalize without sensitive text", async () => {
  for (const value of [{ ...snapshot, extra: true }, { ...snapshot, revision: "/protected/secret" }, null]) {
    const frames: WinterFrame[] = [], bridge = createRpcBridge({ write: frame => frames.push(frame), end() {} });
    const source = createRuntimeContextChannel({ version: 1, bindingId: "one" }); source.bind(bridge);
    const pending = resolveRequiredContext(source, request); await Promise.resolve(); await Promise.resolve();
    bridge.handleResponse({ type: "control_response", requestId: (frames[0] as ControlRequestFrame).requestId, ok: true, payload: value });
    await expect(pending).rejects.toThrow(/^required_context_unavailable$/);
  }
});
test("bounded resolver timeout signals host cancellation without waiting for a cached result", async () => {
  const frames: WinterFrame[] = [], bridge = createRpcBridge({ write: frame => frames.push(frame), end() {} });
  const source = createRuntimeContextChannel({ version: 1, bindingId: "one" }); source.bind(bridge);
  await expect(resolveRequiredContext({ ...source, timeoutMs: 5 }, request)).rejects.toThrow("required_context_timed_out");
  expect(frames.at(-1)?.type).toBe("control_cancel_request");
});

test("required startup cannot advertise an RPC feature without its matching adapter; confined route refuses before native admission", async () => {
  const { runEngine } = await import("../engine.ts");
  const { createSystemPromptAssembler } = await import("./assembler.ts");
  const frames: WinterFrame[] = [];
  const config = { sessionId: "owner", cwd: "/fixture", model: "winter-test/echo", requiredRuntimeContext: { version: 1 as const, bindingId: "one" } };
  const base = { config, input: (async function* () {})(), output: { write: (frame: WinterFrame) => { frames.push(frame); }, end() {} },
    provider: { generate: async () => ({ kind: "text" as const, text: "must not dispatch" }) } };
  await expect(runEngine(base)).rejects.toThrow("required_context_unavailable");
  const channel = createRuntimeContextChannel({ version: 1, bindingId: "different" });
  await expect(runEngine({ ...base, runtimeContextChannel: channel, systemPromptAssembler: createSystemPromptAssembler({ requiredContext: channel }) })).rejects.toThrow("required_context_unavailable");
  await expect(runEngine({ ...base, config: { ...config, executionPosture: "confined-guest" } })).rejects.toThrow("required_context_unavailable");
  expect(frames).toEqual([]);
});

test("composed host-query configuration refuses current-context opt-in before admission or bridge access", async () => {
  const { runEngine } = await import("../engine.ts");
  const { assertLinuxHostQueryConfig } = await import("../guest/linux-host-query-profile.ts");
  const config = {
    executionPosture: "confined-guest" as const, sessionId: "backend", model: "winter-test/echo",
    cwd: "/workspace/source", winterHome: "/run/winter/conversations/logical",
    storeHome: "/workspace/.winter/conversations/logical", persistSession: true,
    tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [], settingSources: [], skills: [],
    plugins: [], strictMcpConfig: true, mcpServers: {}, permissionMode: "default" as const,
    permissions: { disableBypassPermissionsMode: true }, allowDangerouslySkipPermissions: false,
  };
  expect(() => assertLinuxHostQueryConfig(config)).not.toThrow();
  const optedIn = { ...config, requiredRuntimeContext: { version: 1 as const, bindingId: "one" } };
  expect(() => assertLinuxHostQueryConfig(optedIn)).toThrow();
  let admissionReads = 0, inputReads = 0, writes = 0, generations = 0;
  await expect(runEngine({
    config: optedIn,
    get linuxSessionAdmission(): never { admissionReads++; throw new Error("native admission must not be read"); },
    input: { [Symbol.asyncIterator]() { inputReads++; throw new Error("input must not be read"); } },
    output: { write() { writes++; }, end() { writes++; } },
    provider: { generate: async () => { generations++; return { kind: "text" as const, text: "must not dispatch" }; } },
  })).rejects.toThrow("required_context_unavailable");
  expect({ admissionReads, inputReads, writes, generations }).toEqual({ admissionReads: 0, inputReads: 0, writes: 0, generations: 0 });
});

test("closing the parent after wire settlement but before snapshot delivery refuses the raced snapshot", async () => {
  const frames: WinterFrame[] = [], bridge = createRpcBridge({ write: frame => frames.push(frame), end() {} });
  const source = createRuntimeContextChannel({ version: 1, bindingId: "one" }); source.bind(bridge);
  const pending = resolveRequiredContext(source, request); await Promise.resolve(); await Promise.resolve();
  bridge.handleResponse({ type: "control_response", requestId: (frames[0] as ControlRequestFrame).requestId, ok: true, payload: snapshot });
  source.close(); await expect(pending).rejects.toThrow("required_context_unavailable");
});
