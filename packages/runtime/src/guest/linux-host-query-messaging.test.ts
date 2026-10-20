/** GM1: the host-query guest's coordination tools, host messaging flag, host-answer frames and subtype gates. No native admission is minted. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { assertLinuxHostQueryConfig, checkLinuxHostQueryFrame, hostMessageRequestKind, LINUX_HOST_MESSAGE_SUBTYPES, LINUX_HOST_QUERY_COORDINATION_TOOLS, LINUX_HOST_QUERY_TOOLS } from "./linux-host-query-profile.ts";
import { createRpcBridge } from "../rpc/bridge.ts";
import { buildRegistryToolExecutor, type RegistryToolExecutorDeps } from "../tools/registry.ts";
import "../tools/impl/index.ts";

const config = (change: Record<string, unknown> = {}): RuntimeConfig => ({ executionPosture: "confined-guest", sessionId: "backend", model: "model", cwd: "/workspace/source", winterHome: "/run/winter/conversations/logical", storeHome: "/workspace/.winter/conversations/logical", persistSession: true, tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [], settingSources: [], skills: [], plugins: [], strictMcpConfig: true, mcpServers: {}, permissionMode: "default", permissions: { disableBypassPermissionsMode: true }, allowDangerouslySkipPermissions: false, ...change } as RuntimeConfig);
const REFUSAL = "Linux host-query profile unavailable";

test("the closed guest tool set is the four file/shell tools plus the seven coordination tools; TaskStop and TaskOutput are not in it", () => {
  expect([...LINUX_HOST_QUERY_TOOLS].sort()).toEqual(["AskUserQuestion", "Bash", "Edit", "ListAgents", "Read", "SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "Write"]);
  expect([...LINUX_HOST_QUERY_COORDINATION_TOOLS]).not.toContain("TaskStop");
  expect(LINUX_HOST_QUERY_TOOLS).not.toContain("TaskOutput");
  const all = config({ tools: [...LINUX_HOST_QUERY_TOOLS], hostMessaging: true });
  expect(() => assertLinuxHostQueryConfig(all)).not.toThrow();
  for (const tools of [["SendMessage"], ["ListAgents"], ["AskUserQuestion"], ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"], ["Read", "SendMessage"], []]) expect(() => assertLinuxHostQueryConfig(config({ tools }))).not.toThrow();
  for (const bad of ["TaskStop", "TaskOutput", "Grep", "Glob", "NotebookEdit", "Workflow", "WebFetch", "Agent", "ToolSearch", ""]) {
    expect(() => assertLinuxHostQueryConfig(config({ tools: ["Read", bad] })), bad).toThrow(REFUSAL);
  }
  expect(() => assertLinuxHostQueryConfig(config({ tools: [...LINUX_HOST_QUERY_TOOLS, "Read"] }))).toThrow(REFUSAL);
  expect(() => assertLinuxHostQueryConfig(config({ tools: ["Edit", "SendMessage"] }))).toThrow(REFUSAL);
});

test("hostMessaging is only ever true, and only beside a tool that uses it", () => {
  for (const tools of [["SendMessage"], ["ListAgents"], ["Read", "SendMessage", "ListAgents"]]) expect(() => assertLinuxHostQueryConfig(config({ tools, hostMessaging: true }))).not.toThrow();
  for (const value of [false, 1, "true", null, {}, []]) expect(() => assertLinuxHostQueryConfig(config({ tools: ["SendMessage"], hostMessaging: value })), String(value)).toThrow(REFUSAL);
  for (const tools of [["Read"], [], ["AskUserQuestion", "TaskCreate"]]) expect(() => assertLinuxHostQueryConfig(config({ tools, hostMessaging: true }))).toThrow(REFUSAL);
  expect(() => assertLinuxHostQueryConfig(config({ tools: ["SendMessage"] }))).not.toThrow();
});

const send = { status: "queued" } as const;
const list = { sessions: [{ address: "session:abc", status: "idle", mode: "cowork" }] };
const answer = (requestId: string, payload: unknown, extra: Record<string, unknown> = {}) => ({ type: "control_response", requestId, ok: true, payload, ...extra });
const kindOf = (map: Record<string, "host_message_send" | "host_message_list">) => (id: string) => map[id];

test("an answer to an outstanding host_message_send / host_message_list is ACCEPTED, where it used to be dropped", () => {
  const owns = kindOf({ s1: "host_message_send", l1: "host_message_list" });
  expect(checkLinuxHostQueryFrame(answer("s1", send), () => false, owns)).toBe("accept");
  expect(checkLinuxHostQueryFrame(answer("l1", list), () => false, owns)).toBe("accept");
  expect(checkLinuxHostQueryFrame(answer("l1", { sessions: [] }), () => false, owns)).toBe("accept");
  // Without the predicate (an older call site) the very same answers are dropped: this is the hang the change exists to prevent.
  expect(checkLinuxHostQueryFrame(answer("s1", send), () => false)).toBe("drop");
  expect(checkLinuxHostQueryFrame(answer("l1", list), () => false)).toBe("drop");
});

test("host answers are checked against the closed shape of the request they close; anything else is refused or dropped", () => {
  const owns = kindOf({ s1: "host_message_send", l1: "host_message_list" });
  const refused = (frame: unknown) => expect(() => checkLinuxHostQueryFrame(frame, () => false, owns)).toThrow(REFUSAL);
  refused(answer("s1", list));                                  // a list answer to a send
  refused(answer("l1", send));                                  // a send answer to a list
  refused(answer("s1", { status: "teleported" }));
  refused(answer("s1", { status: "refused" }));                 // refused needs a reason
  refused(answer("s1", undefined));
  refused(answer("s1", "queued"));
  refused(answer("l1", "sessions"));
  refused(answer("l1", { sessions: "x" }));
  refused(answer("s1", send, { error: { code: "x", message: "y" } }));
  refused({ type: "control_response", requestId: "s1", ok: true, payload: send, extra: 1 });
  refused({ type: "control_response", requestId: "s1", ok: false, payload: send, error: { code: "x", message: "y" } });
  refused({ type: "control_response", requestId: "s1", ok: false, error: { code: "x", message: "y", detail: 1 } });
  refused({ type: "control_response", requestId: "s1", ok: false, error: { code: "x".repeat(129), message: "y" } });
  refused({ type: "control_response", requestId: "bad id", ok: true, payload: send });
  // a host error is a legitimate closed answer
  expect(checkLinuxHostQueryFrame({ type: "control_response", requestId: "s1", ok: false, error: { code: "unavailable", message: "later" } }, () => false, owns)).toBe("accept");
  // an id nobody owns is dropped, never accepted as a messaging answer
  expect(checkLinuxHostQueryFrame(answer("other", send), () => false, owns)).toBe("drop");
  expect(checkLinuxHostQueryFrame(answer("other", list), () => false, owns)).toBe("drop");
  // `true` (either kind) accepts either closed shape and still refuses a third
  expect(checkLinuxHostQueryFrame(answer("x", send), () => false, () => true)).toBe("accept");
  expect(checkLinuxHostQueryFrame(answer("x", list), () => false, () => true)).toBe("accept");
  expect(() => checkLinuxHostQueryFrame(answer("x", { nope: 1 }), () => false, () => true)).toThrow(REFUSAL);
});

test("a permission answer is still checked by its own shape, and an id claimed as a messaging request is never read as a permission answer", () => {
  const owns = kindOf({ s1: "host_message_send" });
  const allow = { behavior: "allow" };
  expect(checkLinuxHostQueryFrame(answer("p1", allow), id => id === "p1", owns)).toBe("accept");
  expect(checkLinuxHostQueryFrame(answer("p1", allow), () => false, owns)).toBe("drop");
  expect(() => checkLinuxHostQueryFrame(answer("p1", { behavior: "allow", updatedPermissions: [] }), id => id === "p1", owns)).toThrow(REFUSAL);
  // the same id owned both ways: messaging wins and the permission shape is refused for it
  expect(() => checkLinuxHostQueryFrame(answer("s1", allow), () => true, owns)).toThrow(REFUSAL);
});

test("the engine's predicate reads the run's own bridge: an answer reaches the pending request, a stale or foreign one does not", async () => {
  const written: unknown[] = [];
  const bridge = createRpcBridge({ write: (frame: unknown) => { written.push(frame); }, end() {} } as never, { allowedSubtypes: ["permission", ...LINUX_HOST_MESSAGE_SUBTYPES] });
  bridge.open();
  const owns = hostMessageRequestKind(bridge);
  const pendingSend = bridge.request("host_message_send", { to: "session:abc", message: "hi", messageId: "m1" }, { timeoutMs: 5000 });
  const pendingList = bridge.request("host_message_list", {}, { timeoutMs: 5000 });
  const requests = written.filter((frame): frame is { requestId: string; subtype: string } => (frame as { type?: string }).type === "control_request") as Array<{ requestId: string; subtype: string }>;
  const sendId = requests.find(r => r.subtype === "host_message_send")!.requestId, listId = requests.find(r => r.subtype === "host_message_list")!.requestId;
  expect(owns(sendId)).toBe("host_message_send");
  expect(owns(listId)).toBe("host_message_list");
  expect(owns("nobody")).toBeUndefined();
  // the whole hop the engine pump performs: gate the frame, then settle the request with it
  const sendFrame = { type: "control_response" as const, requestId: sendId, ok: true, payload: { status: "delivered" } };
  expect(checkLinuxHostQueryFrame(sendFrame, () => false, owns)).toBe("accept");
  expect(bridge.handleResponse(sendFrame)).toBe(true);
  await expect(pendingSend).resolves.toEqual({ status: "delivered" });
  expect(owns(sendId)).toBeUndefined();
  expect(checkLinuxHostQueryFrame(sendFrame, () => false, owns)).toBe("drop"); // a second answer to a settled id is harmless
  const listFrame = { type: "control_response" as const, requestId: listId, ok: true, payload: list };
  expect(checkLinuxHostQueryFrame(listFrame, () => false, owns)).toBe("accept");
  bridge.handleResponse(listFrame);
  await expect(pendingList).resolves.toEqual(list);
});

test("the bridge's subtype allowlist admits the messaging subtypes only for the host-query profiles, both of them", () => {
  const out = { write() {}, end() {} } as never;
  const bridge = createRpcBridge(out, { allowedSubtypes: ["permission", ...LINUX_HOST_MESSAGE_SUBTYPES] });
  bridge.open();
  expect(() => bridge.request("host_message_send", {}, { timeoutMs: 100 }).catch(() => {})).not.toThrow();
  const narrow = createRpcBridge(out, { allowedSubtypes: ["permission"] });
  narrow.open();
  return expect(narrow.request("host_message_send", {}, { timeoutMs: 100 })).rejects.toBeDefined();
});

test("engine.ts wires both gates together: the subtype allowlist for both host-query profiles and the frame-checker predicate at its one call site", () => {
  const engine = readFileSync(new URL("../engine.ts", import.meta.url), "utf8");
  expect(engine).toContain('{ allowedSubtypes: ["permission", ...LINUX_HOST_MESSAGE_SUBTYPES] }');
  expect(engine).toContain('{ allowedSubtypes: ["permission", RUNTIME_CONTEXT_SUBTYPE, ...LINUX_HOST_MESSAGE_SUBTYPES] }');
  expect(engine).toContain('checkLinuxSessionFrame(opts.linuxSessionAdmission, config, frame, id => bridge.ownsRequest(id, "permission"), hostMessageRequestKind(bridge))');
  const admission = readFileSync(new URL("./linux-session-admission.ts", import.meta.url), "utf8");
  expect(admission.match(/checkLinuxHostQueryFrame\(frame, ownsPermission, ownsHostRequest\)/g)).toHaveLength(2);
  expect(LINUX_HOST_MESSAGE_SUBTYPES).toEqual(["host_message_send", "host_message_list"]);
});

const deps = (): RegistryToolExecutorDeps => ({ executionPosture: "confined-guest", getCwd: () => "/workspace/source", home: "/home/none", sessionId: "backend" } as unknown as RegistryToolExecutorDeps);
test("the registry's confined-guest gate offers exactly the closed set; everything else is guest_tool_unsupported before any executor", async () => {
  const executor = buildRegistryToolExecutor(deps());
  for (const name of LINUX_HOST_QUERY_TOOLS) {
    const result = await executor.execute({ id: "x", name, input: {} });
    expect(result.output, name).not.toContain("guest_tool_unsupported");
    expect(result.output, name).toContain("guest_file_binding_missing");   // past the allowlist, stopped by the missing helper binding
  }
  for (const name of ["TaskStop", "TaskOutput", "Grep", "Glob", "NotebookEdit", "Workflow", "WebFetch", "LSP", "CronCreate", "Agent", "ToolSearch", "mcp__x__y"]) {
    expect((await executor.execute({ id: "x", name, input: {} })).output, name).toContain("guest_tool_unsupported");
  }
});
