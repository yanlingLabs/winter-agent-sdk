import { expect, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { assertLinuxHostQueryConfig, assertLinuxHostQueryRoots, checkLinuxHostQueryFrame, LINUX_SESSION_CHUNK_BYTES, LINUX_SESSION_FRAME_BYTES } from "./linux-host-query-profile.ts";
import { boundedLinuxSessionInput, boundedLinuxSessionOutput, runAdmittedLinuxSession } from "./linux-session-entry.ts";
import { admitHostQueryLinuxSession, type LinuxSessionAdmission } from "./linux-session-admission.ts";
import { createRpcBridge } from "../rpc/bridge.ts";
const config = (): RuntimeConfig => ({ executionPosture: "confined-guest", sessionId: "backend", model: "model", cwd: "/workspace/source", winterHome: "/run/winter/conversations/logical", storeHome: "/workspace/.winter/conversations/logical", persistSession: true, tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [], settingSources: [], skills: [], plugins: [], strictMcpConfig: true, mcpServers: {}, permissionMode: "default", permissions: { disableBypassPermissionsMode: true }, allowDangerouslySkipPermissions: false });

test("closed host-query config requires empty preapprovals and matching immutable bypass clamp", () => {
  for (const mode of ["default", "plan", "bypassPermissions"] as const) {
    const value = { ...config(), permissionMode: mode, permissions: { disableBypassPermissionsMode: mode !== "bypassPermissions" }, allowDangerouslySkipPermissions: mode === "bypassPermissions" };
    expect(() => assertLinuxHostQueryConfig(value)).not.toThrow();
    expect(() => assertLinuxHostQueryConfig({ ...value, allowDangerouslySkipPermissions: !value.allowDangerouslySkipPermissions })).toThrow();
    expect(() => assertLinuxHostQueryConfig({ ...value, permissions: { disableBypassPermissionsMode: !value.permissions.disableBypassPermissionsMode } })).toThrow();
  }
  for (const change of [
    { allowedTools: ["Bash"] }, { tools: ["Agent"] }, { tools: ["Read", "Read"] }, { tools: ["Edit"] },
    { permissionMode: "auto" }, { permissions: { disableBypassPermissionsMode: true, allow: ["Bash"] } },
    { resume: "backend" }, { hooks: {} }, { agents: {} }, { env: {} }, { unknown: true },
    { settingSources: ["project"] }, { mcpServers: { x: {} } }, { plugins: ["x"] }, { contextWindowTokens: Infinity },
  ]) expect(() => assertLinuxHostQueryConfig({ ...config(), ...change } as RuntimeConfig)).toThrow();
  expect(() => assertLinuxHostQueryConfig({ ...config(), tools: [], contextWindowTokens: 8192 })).not.toThrow();
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
test("bounded transport preserves fragmented text and permission-after-end-input; actual EOF cancels", async () => {
  const text = JSON.stringify({ type: "user", text: "go😀" }) + "\n";
  expect(await collect([text.slice(0, 12), text.slice(12), '{"type":"control_request","requestId":"e","subtype":"end_input"}\n', '{"type":"control_response","requestId":"p","ok":true,"payload":{"behavior":"allow"}}\n'])).toEqual({ output: [text, '{"type":"control_request","requestId":"e","subtype":"end_input"}\n', '{"type":"control_response","requestId":"p","ok":true,"payload":{"behavior":"allow"}}\n'], cancelled: 1 });
  for (const chunks of [["x".repeat(LINUX_SESSION_CHUNK_BYTES + 1)], Array(5).fill("x".repeat(LINUX_SESSION_CHUNK_BYTES)), ['{"type":"user"}'], ['no-json\n']]) {
    let cancelled = 0;
    const consume = async () => { for await (const _ of boundedLinuxSessionInput((async function* () { yield* chunks; })(), () => { cancelled++; })) {} };
    await expect(consume()).rejects.toThrow(); expect(cancelled).toBe(1);
  }
});

test("closed entry refuses forged native admission before input, writes or ownership callbacks", async () => {
  let touched = 0;
  const fake = Object.freeze({ profile: "host-query-v1", config: config() }) as unknown as LinuxSessionAdmission;
  await expect(runAdmittedLinuxSession({ admission: fake, input: { [Symbol.asyncIterator]() { touched++; throw new Error("not read"); } }, write() { touched++; }, writeErr() { touched++; }, onProtectedStoreOwnershipOutcome() { touched++; } })).rejects.toThrow("admission unavailable");
  expect(touched).toBe(0);
  for (const [a, b] of [[3, 3], [0, 4], [3.5, 4]]) expect(() => admitHostQueryLinuxSession(a!, b!)).toThrow("admission unavailable");
});


test("host-query record binds cwd to roots and plan requires read-only metadata, without claiming mount proof", () => {
  const root = { id: "source", guestPath: "/workspace/source", readOnly: false };
  expect(() => assertLinuxHostQueryRoots(config(), [root])).not.toThrow();
  const plan = { ...config(), permissionMode: "plan" as const };
  expect(() => assertLinuxHostQueryRoots(plan, [root])).toThrow();
  expect(() => assertLinuxHostQueryRoots(plan, [{ ...root, readOnly: true }])).not.toThrow();
  for (const roots of [[], [root, root], [{ ...root, guestPath: "/workspace/.winter" }], [{ ...root, guestPath: "/workspace/source/../other" }], [{ ...root, guestPath: "/workspace/other" }], Array(65).fill(root)]) expect(() => assertLinuxHostQueryRoots(config(), roots)).toThrow();
});

test("fresh profile bounded input preserves ordinary EOF and still cancels malformed input", async () => {
  let cancellations = 0;
  for await (const _ of boundedLinuxSessionInput((async function* () { yield '{"type":"user","text":"go"}\n'; })(), () => { cancellations++; }, false)) {}
  expect(cancellations).toBe(0);
  await expect((async () => { for await (const _ of boundedLinuxSessionInput((async function* () { yield 'bad\n'; })(), () => { cancellations++; }, false)) {} })()).rejects.toThrow();
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
