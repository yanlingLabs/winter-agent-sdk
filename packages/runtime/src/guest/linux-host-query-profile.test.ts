import { expect, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { assertLinuxHostQueryConfig, assertLinuxHostQueryRoots, checkLinuxHostQueryFrame, LINUX_SESSION_CHUNK_BYTES, LINUX_SESSION_FRAME_BYTES } from "./linux-host-query-profile.ts";
import { boundedLinuxSessionInput, boundedLinuxSessionOutput, runAdmittedLinuxSession } from "./linux-session-entry.ts";
import { admitHostQueryLinuxSession, linuxSessionProfile, checkLinuxSessionFrame, type LinuxSessionAdmission } from "./linux-session-admission.ts";
import { createRpcBridge } from "../rpc/bridge.ts";
const config = (): RuntimeConfig => ({ executionPosture: "confined-guest", sessionId: "backend", model: "model", cwd: "/workspace/source", winterHome: "/run/winter/conversations/logical", storeHome: "/workspace/.winter/conversations/logical", persistSession: true, tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [], settingSources: [], skills: [], plugins: [], strictMcpConfig: true, mcpServers: {}, permissionMode: "default", permissions: { disableBypassPermissionsMode: true }, allowDangerouslySkipPermissions: false });

test("closed host-query config admits only default and plan with the fixed bypass clamp, and refuses every other mode and pair", () => {
  const clamp = { permissions: { disableBypassPermissionsMode: true }, allowDangerouslySkipPermissions: false };
  for (const mode of ["default", "plan"] as const) {
    const value = { ...config(), permissionMode: mode, ...clamp };
    expect(() => assertLinuxHostQueryConfig(value)).not.toThrow();
    expect(() => assertLinuxHostQueryConfig({ ...value, allowDangerouslySkipPermissions: true })).toThrow();
    expect(() => assertLinuxHostQueryConfig({ ...value, permissions: { disableBypassPermissionsMode: false } })).toThrow();
    expect(() => assertLinuxHostQueryConfig({ ...value, allowDangerouslySkipPermissions: undefined } as unknown as RuntimeConfig)).toThrow();
    expect(() => assertLinuxHostQueryConfig({ ...value, permissions: {} })).toThrow();
    for (const permissions of [undefined, null, [], "x"]) expect(() => assertLinuxHostQueryConfig({ ...value, permissions } as unknown as RuntimeConfig)).toThrow("Linux host-query profile unavailable");
  }
  for (const mode of ["acceptEdits", "dontAsk", "bypassPermissions", "auto", "", undefined]) {
    for (const pair of [clamp, { permissions: { disableBypassPermissionsMode: false }, allowDangerouslySkipPermissions: true }, { permissions: { disableBypassPermissionsMode: !(mode === "bypassPermissions") }, allowDangerouslySkipPermissions: mode === "bypassPermissions" }]) {
      expect(() => assertLinuxHostQueryConfig({ ...config(), permissionMode: mode, ...pair } as RuntimeConfig), String(mode)).toThrow();
    }
  }
  for (const change of [
    { allowedTools: ["Bash"] }, { tools: ["Agent"] }, { tools: ["Read", "Read"] }, { tools: ["Edit"] },
    { permissionMode: "auto" }, { permissions: { disableBypassPermissionsMode: true, allow: ["Bash"] } },
    { profile: "host-query-v1" }, { allowedSubtypes: ["permission"] }, { resume: "foreign" }, { hooks: {} }, { agents: {} }, { env: {} }, { unknown: true },
    { settingSources: ["project"] }, { mcpServers: { x: {} } }, { plugins: ["x"] }, { contextWindowTokens: Infinity },
  ]) expect(() => assertLinuxHostQueryConfig({ ...config(), ...change } as RuntimeConfig)).toThrow();
  expect(() => assertLinuxHostQueryConfig({ ...config(), tools: [], contextWindowTokens: 8192 })).not.toThrow();
});

test("cold resume: `resume` is admitted only as the conversation's own session; continue, fork and resume-at stay refused", () => {
  const value = { ...config(), permissionMode: "default" as const, permissions: { disableBypassPermissionsMode: true }, allowDangerouslySkipPermissions: false };
  expect(() => assertLinuxHostQueryConfig({ ...value, resume: "backend" })).not.toThrow();
  expect(() => assertLinuxHostQueryConfig(value)).not.toThrow();
  for (const change of [{ resume: "foreign" }, { resume: "" }, { resume: undefined, continue: true }, { forkSession: true }, { resume: "backend", forkSession: true }, { resumeSessionAt: "m" }, { resume: "backend", resumeSessionAt: "m" }, { resumeDropsTurn: true }, { resume: "backend", resumeDropsTurn: true }, { resume: "backend", continue: true }]) {
    expect(() => assertLinuxHostQueryConfig({ ...value, ...change } as RuntimeConfig), JSON.stringify(change)).toThrow();
  }
});

test("interrupt admits exactly no payload, {} and the host SDK's { scope: \"turn\" }; every other payload is refused", () => {
  const interrupt = (payload?: unknown) => ({ type: "control_request", requestId: "i", subtype: "interrupt", ...(payload === undefined ? {} : { payload }) });
  for (const payload of [undefined, {}, { scope: "turn" }]) expect(checkLinuxHostQueryFrame(interrupt(payload), () => false)).toBe("accept");
  for (const payload of [{ scope: "session" }, { scope: "Turn" }, { scope: "" }, { scope: "turn ", x: 1 }, { scope: null }, { scope: ["turn"] }, { scope: 1 }, { scope: undefined, extra: true },
    { scope: "turn", extra: 1 }, { extra: "turn" }, { turn: true }, { __proto__: { scope: "turn" }, x: 1 }, null, [], [{ scope: "turn" }], "turn", 1, true]) {
    expect(() => checkLinuxHostQueryFrame(interrupt(payload), () => false), JSON.stringify(payload)).toThrow("Linux host-query profile unavailable");
  }
  // end_input never takes the turn scope; it keeps the empty payload only.
  expect(checkLinuxHostQueryFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: {} }, () => false)).toBe("accept");
  expect(() => checkLinuxHostQueryFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: { scope: "turn" } }, () => false)).toThrow();
  // The turn-scoped frame is the same frame shape otherwise: extra keys, bad ids and other subtypes still refuse.
  expect(() => checkLinuxHostQueryFrame({ ...interrupt({ scope: "turn" }), extra: 1 }, () => false)).toThrow();
  expect(() => checkLinuxHostQueryFrame({ ...interrupt({ scope: "turn" }), requestId: "bad id" }, () => false)).toThrow();
  expect(() => checkLinuxHostQueryFrame({ ...interrupt({ scope: "turn" }), subtype: "set_model" }, () => false)).toThrow();
});

test("only end_input and interrupt are control subtypes: every other subtype is refused even with an empty payload or none", () => {
  for (const subtype of ["set_model", "set_permission_mode", "set_max_thinking_tokens", "initialize", "delegate", "resume", "mcp_status", "rewind_files", "get_context_usage", "", "Interrupt", "END_INPUT", "interrupt ", "end_input\n"]) {
    for (const extra of [{ payload: {} }, {}] as const) {
      expect(() => checkLinuxHostQueryFrame({ type: "control_request", requestId: "x", subtype, ...extra }, () => false), `${JSON.stringify(subtype)} ${JSON.stringify(extra)}`).toThrow("Linux host-query profile unavailable");
    }
  }
  expect(() => checkLinuxHostQueryFrame({ type: "control_request", requestId: "x", subtype: undefined, payload: {} }, () => false)).toThrow();
});

test("host frames cannot mutate settings, delegate, resume or attach alternate inputs", () => {
  for (const value of [{ type: "user", text: "go" }, { type: "control_request", requestId: "e", subtype: "end_input" }, { type: "control_request", requestId: "i", subtype: "interrupt", payload: {} }]) expect(checkLinuxHostQueryFrame(value, () => false)).toBe("accept");
  for (const value of [null, [], { type: "user", text: " /compact" }, { type: "user", text: "go", images: [] }, { type: "user", text: "go", config: {} }, { type: "user", text: "x".repeat(LINUX_SESSION_FRAME_BYTES) },
    ...["set_permission_mode", "set_model", "initialize", "delegate", "resume", "end_input"].map(subtype => ({ type: "control_request", requestId: "x", subtype, payload: { model: "x" } })),
    { type: "control_response", requestId: "p", ok: true, payload: { behavior: "allow", updatedPermissions: [] } },
    { type: "control_response", requestId: "p", ok: true, payload: { behavior: "allow", unknown: true } },
    { type: "control_response", requestId: "p", ok: true, payload: { behavior: "deny" } },
    { type: "control_response", requestId: "p", ok: "true", payload: { behavior: "allow" } },
  ]) expect(() => checkLinuxHostQueryFrame(value, () => true)).toThrow();
});

test("actual RpcBridge correlation only admits pending permission replies, then drops duplicate/foreign/late replies", async () => {
  const emitted: WinterFrame[] = [], bridge = createRpcBridge({ write: frame => { emitted.push(frame); }, end() {} });
  const pending = bridge.request("permission", {}, { requestId: "p" });
  const unrelated = bridge.request("credential_resolve", {}, { requestId: "c" }); void unrelated.catch(() => {});
  const reply = { type: "control_response", requestId: "p", ok: true, payload: { behavior: "allow", updatedInput: { file_path: "source" } } } as const;
  const owns = (id: string) => bridge.ownsRequest(id, "permission");
  expect(checkLinuxHostQueryFrame({ ...reply, requestId: "c" }, owns)).toBe("drop");
  expect(checkLinuxHostQueryFrame(reply, owns)).toBe("accept"); bridge.handleResponse(reply);
  expect(await pending).toEqual(reply.payload);
  expect(checkLinuxHostQueryFrame(reply, owns)).toBe("drop");
  const abort = new AbortController(), cancelled = bridge.request("permission", {}, { requestId: "late", signal: abort.signal }); void cancelled.catch(() => {}); abort.abort();
  await expect(cancelled).rejects.toThrow();
  expect(checkLinuxHostQueryFrame({ ...reply, requestId: "late" }, owns)).toBe("drop");
  expect(emitted.some(frame => frame.type === "control_cancel_request")).toBe(true);
  bridge.rejectAllPending(new Error("transport ended")); await expect(unrelated).rejects.toThrow();
});

async function collect(chunks: string[]): Promise<{ output: string[]; cancelled: number }> {
  let cancelled = 0; const output: string[] = [];
  for await (const chunk of boundedLinuxSessionInput((async function* () { yield* chunks; })(), () => { cancelled++; })) output.push(chunk);
  return { output, cancelled };
}
test("bounded transport preserves fragmented text and permission-after-end-input; clean EOF does not cancel", async () => {
  const text = JSON.stringify({ type: "user", text: "go😀" }) + "\n";
  expect(await collect([text.slice(0, 12), text.slice(12), '{"type":"control_request","requestId":"e","subtype":"end_input"}\n', '{"type":"control_response","requestId":"p","ok":true,"payload":{"behavior":"allow"}}\n'])).toEqual({ output: [text, '{"type":"control_request","requestId":"e","subtype":"end_input"}\n', '{"type":"control_response","requestId":"p","ok":true,"payload":{"behavior":"allow"}}\n'], cancelled: 0 });
  for (const chunks of [["x".repeat(LINUX_SESSION_CHUNK_BYTES + 1)], Array(5).fill("x".repeat(LINUX_SESSION_CHUNK_BYTES)), ['{"type":"user"}'], ['no-json\n']]) {
    let cancelled = 0;
    const consume = async () => { for await (const _ of boundedLinuxSessionInput((async function* () { yield* chunks; })(), () => { cancelled++; })) {} };
    await expect(consume()).rejects.toThrow(); expect(cancelled).toBe(1);
  }
});

test("closed entry refuses forged native admission before input, writes or ownership callbacks", async () => {
  let touched = 0;
  const fake = Object.freeze({ profile: "host-query-v1", config: config() }) as unknown as LinuxSessionAdmission;
  expect(() => linuxSessionProfile(fake)).toThrow("admission unavailable");
  expect(() => checkLinuxSessionFrame(fake, config(), { type: "user", text: "go" }, () => { touched++; return true; })).toThrow("admission unavailable");
  await expect(runAdmittedLinuxSession({ admission: fake, input: { [Symbol.asyncIterator]() { touched++; throw new Error("not read"); } }, write() { touched++; }, writeErr() { touched++; }, onProtectedStoreOwnershipOutcome() { touched++; } })).rejects.toThrow("admission unavailable");
  expect(touched).toBe(0);
  for (const [a, b] of [[3, 3], [0, 4], [3.5, 4]]) expect(() => admitHostQueryLinuxSession(a!, b!)).toThrow("admission unavailable");
});


test("host-query record binds cwd to roots and plan requires read-only metadata, without claiming mount proof", () => {
  const root = { id: "source", guestPath: "/workspace/source", readOnly: false };
  expect(() => assertLinuxHostQueryRoots(config(), [root])).not.toThrow();
  expect(() => assertLinuxHostQueryRoots(config(), Array.from({ length: 16 }, (_, index) => ({ ...root, id: `source-${index}`, guestPath: index === 0 ? root.guestPath : `/workspace/source-${index}` })))).not.toThrow();
  const plan = { ...config(), permissionMode: "plan" as const };
  expect(() => assertLinuxHostQueryRoots(plan, [root])).toThrow();
  expect(() => assertLinuxHostQueryRoots(plan, [{ ...root, readOnly: true }])).not.toThrow();
  for (const roots of [[], [root, root], [{ ...root, guestPath: "/workspace/.winter" }], [{ ...root, guestPath: "/workspace/source/../other" }], [{ ...root, guestPath: "/workspace/other" }], Array(17).fill(root)]) expect(() => assertLinuxHostQueryRoots(config(), roots)).toThrow();
});

test("the plan view is admitted only under plan, writable, once, for this conversation, at a canonical epoch of at most nine digits", () => {
  const source = { id: "source", guestPath: "/workspace/source", readOnly: true };
  const sid = "conversation", view = (epoch: string, readOnly = false) => ({ id: "plan", guestPath: `/workspace/plan/${sid}/${epoch}`, readOnly });
  const plan = { ...config(), permissionMode: "plan" as const, winterHome: `/run/winter/conversations/${sid}` };
  const live = { ...config(), winterHome: plan.winterHome };
  for (const epoch of ["0", "4", "123456789"]) expect(() => assertLinuxHostQueryRoots(plan, [source, view(epoch)]), epoch).not.toThrow();
  // Only the plan view may be writable under plan; any other writable root still refuses.
  expect(() => assertLinuxHostQueryRoots(plan, [{ ...source, readOnly: false }, view("4")])).toThrow();
  for (const bad of [view("4", true), view("04"), view("1234567890"), view("-1"), view("4/x"), { ...view("4"), guestPath: `/workspace/plan/other/4` }, { ...view("4"), guestPath: `/workspace/plan/${sid}` }, { ...view("4"), guestPath: "/workspace/plan" }, { ...view("4"), guestPath: "/workspace/plan/" }])
    expect(() => assertLinuxHostQueryRoots(plan, [source, bad]), bad.guestPath).toThrow();
  expect(() => assertLinuxHostQueryRoots(plan, [source, view("4"), { ...view("3"), id: "plan2" }])).toThrow();
  // Outside plan it is refused for every writable or read-only spelling.
  for (const readOnly of [false, true]) expect(() => assertLinuxHostQueryRoots(live, [{ ...source, readOnly: false }, view("4", readOnly)])).toThrow();
});

test("a root carries no host source: any `source` key, equal to the guest path or not, is refused (the supervisor admits only source === guestPath for host-query roots)", () => {
  const root = { id: "source", guestPath: "/workspace/source", readOnly: false };
  for (const source of [root.guestPath, "/workspace/other", "/workspace/source/", "/tmp/x", "/workspace/.winter/store", "", 1, null, undefined]) {
    expect(() => assertLinuxHostQueryRoots(config(), [{ ...root, source } as never]), String(source)).toThrow("Linux host-query profile unavailable");
  }
  expect(() => assertLinuxHostQueryRoots(config(), [root])).not.toThrow();
});

test("fresh profile bounded input preserves ordinary EOF and still cancels malformed input", async () => {
  let cancellations = 0;
  for await (const _ of boundedLinuxSessionInput((async function* () { yield '{"type":"user","text":"go"}\n'; })(), () => { cancellations++; })) {}
  expect(cancellations).toBe(0);
  await expect((async () => { for await (const _ of boundedLinuxSessionInput((async function* () { yield 'bad\n'; })(), () => { cancellations++; })) {} })()).rejects.toThrow();
  expect(cancellations).toBe(1);
});


test("output framing bounds each chunk without splitting Unicode; writer errors cancel without retry", () => {
  let cancellations = 0; const chunks: string[] = [];
  const write = boundedLinuxSessionOutput(chunk => { chunks.push(chunk); }, () => { cancellations++; });
  const text = "x".repeat(65535) + "😀".repeat(80000) + "\n";
  write(text);
  expect(chunks.join("")).toBe(text);
  expect(chunks.every(chunk => Buffer.byteLength(chunk) <= LINUX_SESSION_CHUNK_BYTES)).toBe(true);
  expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  expect(() => write("x".repeat(LINUX_SESSION_FRAME_BYTES + 1))).toThrow();
  expect(cancellations).toBe(1);
  let effects = 0;
  const failing = boundedLinuxSessionOutput(() => { effects++; throw new Error("transport unavailable"); }, () => { cancellations++; });
  expect(() => failing("one frame")).toThrow("transport unavailable");
  expect(effects).toBe(1); expect(cancellations).toBe(2);
});
