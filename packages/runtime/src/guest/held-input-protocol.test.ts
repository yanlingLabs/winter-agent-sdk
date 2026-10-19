/** GM2 transport: the frame checker's admission of the four host_input_* verbs, the capability, the SDK Query verbs end to end, and the wiring. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELD_INPUT_CAPABILITY, WinterRpcError, query, type Options, type SDKHeldInputsMessage, type SDKHostInputCommittedMessage } from "@yanlinglabs/winter-agent-sdk";
import { checkLinuxHostQueryFrame } from "./linux-host-query-profile.ts";
import { RUNTIME_EXECUTION_POSTURE_CAPABILITIES } from "./execution-posture.ts";
import { inMemoryProcess } from "../testing.ts";
import { transcriptHostInputIds } from "../store/dialect.ts";
import { EPOCH, gate, journalRecords, sleep, tokenOf } from "./held-input-harness.ts";

const REFUSAL = "Linux host-query profile unavailable";
const request = (subtype: string, payload: unknown, extra: Record<string, unknown> = {}) => ({ type: "control_request", requestId: "r-1", subtype, payload, ...extra });
const hold = { inputId: "m1", holdToken: tokenOf("a"), epoch: EPOCH, text: "hello", clientName: "peer" };
const pair = { inputId: "m1", holdToken: tokenOf("a") };

test("the four host_input_* verbs are admitted with closed payloads only", () => {
  for (const frame of [request("host_input_hold", hold), request("host_input_commit", pair), request("host_input_discard", pair), request("host_input_forget", pair)]) {
    expect(checkLinuxHostQueryFrame(frame, () => false)).toBe("accept");
  }
});

test("a verb with an extra key, a missing key, a wrong type, an oversize body or a bad epoch is refused (a refusal ends the run)", () => {
  const refused = (frame: unknown) => expect(() => checkLinuxHostQueryFrame(frame, () => false), JSON.stringify(frame).slice(0, 120)).toThrow(REFUSAL);
  for (const subtype of ["host_input_commit", "host_input_discard", "host_input_forget"]) {
    refused(request(subtype, { ...pair, extra: 1 }));
    refused(request(subtype, { inputId: "m1" }));
    refused(request(subtype, { holdToken: tokenOf("a") }));
    refused(request(subtype, {}));
    refused(request(subtype, undefined));
    refused(request(subtype, null));
    refused(request(subtype, []));
    refused(request(subtype, { inputId: 1, holdToken: tokenOf("a") }));
    refused(request(subtype, { inputId: "bad id", holdToken: tokenOf("a") }));
    refused(request(subtype, { inputId: "m1", holdToken: "ab" }));
    refused(request(subtype, { inputId: "m1", holdToken: tokenOf("a").toUpperCase() }));
    refused(request(subtype, pair, { extra: true }));
  }
  refused(request("host_input_hold", { ...hold, extra: 1 }));
  for (const key of Object.keys(hold)) refused(request("host_input_hold", Object.fromEntries(Object.entries(hold).filter(([k]) => k !== key))));
  refused(request("host_input_hold", { ...hold, text: "" }));
  refused(request("host_input_hold", { ...hold, text: 5 }));
  refused(request("host_input_hold", { ...hold, text: "x".repeat(64 * 1024 + 1) }));
  refused(request("host_input_hold", { ...hold, clientName: "p".repeat(257) }));
  refused(request("host_input_hold", { ...hold, clientName: 5 }));
  refused(request("host_input_hold", { ...hold, epoch: { incarnationId: "i" } }));
  refused(request("host_input_hold", { ...hold, epoch: { incarnationId: "i", leaseEpoch: 1.5 } }));
  refused(request("host_input_hold", { ...hold, epoch: { incarnationId: "i", leaseEpoch: -1 } }));
  refused(request("host_input_hold", { ...hold, epoch: { incarnationId: "", leaseEpoch: 1 } }));
  refused(request("host_input_hold", { ...hold, epoch: { incarnationId: "i", leaseEpoch: 1, extra: 1 } }));
  refused(request("host_input_hold", { ...hold, epoch: "inc-1" }));
  refused({ type: "control_request", subtype: "host_input_commit", payload: pair });                       // no requestId
  expect(checkLinuxHostQueryFrame(request("host_input_hold", { ...hold, text: "x".repeat(64 * 1024) }), () => false)).toBe("accept");   // the cap is inclusive
});

test("the verbs are the only new control subtypes: every neighbour is still refused", () => {
  for (const subtype of ["host_input_unhold", "host_input", "host_input_commit ", "HOST_INPUT_COMMIT", "set_model", "clear_queued_input", "set_permission_mode", "mcp_reconnect"]) {
    expect(() => checkLinuxHostQueryFrame(request(subtype, pair), () => false), subtype).toThrow(REFUSAL);
  }
});

test("the runtime offers held-input-v1 beside its other posture capability, and the SDK names the same string", () => {
  expect(HELD_INPUT_CAPABILITY).toBe("held-input-v1");
  expect(RUNTIME_EXECUTION_POSTURE_CAPABILITIES.capabilities).toContain("held-input-v1");
  expect(RUNTIME_EXECUTION_POSTURE_CAPABILITIES.capabilities).toContain("confined-guest-posture-v1");
});

test("the transcript scan finds a tagged user entry and a tagged folded attachment, and nothing else", () => {
  const ids = transcriptHostInputIds([
    { type: "user", origin: { kind: "host-input", inputId: "u1" } },
    { type: "attachment", attachment: { type: "queued_command", prompt: "x", inputId: "a1" } },
    { type: "user", origin: { kind: "task-notification", inputId: "n1" } },
    { type: "user", origin: { kind: "host-input" } },
    { type: "user", origin: { kind: "host-input", inputId: 5 } },
    { type: "assistant", origin: { kind: "host-input", inputId: "no" } },
    { type: "attachment", attachment: { type: "queued_command", prompt: "x" } },
    { type: "user" },
  ]);
  expect([...ids].sort()).toEqual(["a1", "u1"]);
});

test("embedded.ts offers the journal only to a host-query admission, with that admission's own epoch; the fresh profile gets none", () => {
  const embedded = readFileSync(new URL("../embedded.ts", import.meta.url), "utf8");
  expect(embedded).toContain("const heldEpoch = opts.linuxSessionAdmission !== undefined ? linuxSessionHeldInputEpoch(opts.linuxSessionAdmission) : undefined;");
  expect(embedded).toContain("heldInputs: heldEpoch !== undefined,");
  expect(embedded).toContain("...(held !== undefined && heldEpoch !== undefined ? { heldInputs: { ...held, epoch: heldEpoch } } : {}),");
  const admission = readFileSync(new URL("./linux-session-admission.ts", import.meta.url), "utf8");
  expect(admission).toContain("if (profile !== LINUX_HOST_QUERY_PROFILE && profile !== LINUX_GUIDED_HOST_QUERY_PROFILE) return undefined;");
  expect(admission).toContain("return { incarnationId: state.record.scope.incarnationId, leaseEpoch: state.record.scope.leaseEpoch };");
  const engine = readFileSync(new URL("../engine.ts", import.meta.url), "utf8");
  expect(engine).toContain("const heldInputs = config.agentId === undefined ? opts.heldInputs : undefined;");   // a subagent never gets a journal
  expect(engine).toContain("hostInputFrames.has(frame) && !journalFrames.has(frame)");                          // clearQueuedInput skips journal inputs
});

// --- the SDK Query verbs, end to end over the in-memory runtime ---------------------------------------------------

async function withQuery<T>(body: (q: Awaited<ReturnType<typeof makeQuery>>["q"], seen: Array<Record<string, any>>) => Promise<T>): Promise<T> {
  const made = await makeQuery();
  try { return await body(made.q, made.seen); } finally { made.finish(); await made.q.return(undefined).catch(() => undefined); rmSync(made.root, { recursive: true, force: true }); }
}
async function makeQuery() {
  const root = mkdtempSync(join(tmpdir(), "winter-held-query-"));
  const home = join(root, "home"), cwd = join(root, "cwd");
  mkdirSync(home); mkdirSync(cwd);
  const finishing = gate();
  async function* prompt(): AsyncGenerator<string> { await finishing.promise; }
  const seen: Array<Record<string, any>> = [];
  const q = query({
    prompt: prompt(),
    options: {
      model: "winter-test/echo", cwd, env: { WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" }, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, sandbox: { enabled: false },
      spawnClaudeCodeProcess: (spawn: Parameters<NonNullable<Options["spawnClaudeCodeProcess"]>>[0]) => inMemoryProcess(spawn.args, { async generate() { return { kind: "text", text: "ok" }; } }, undefined, { WINTER_HOME: home }, EPOCH),
    },
  });
  void (async () => { try { for await (const message of q) seen.push(message as never); } catch { /* ended */ } })();
  for (let i = 0; i < 100 && !seen.some(m => m.subtype === "held_inputs"); i++) { await sleep(50); void q.supportedModels?.().catch(() => undefined); }
  return { q, seen, root, home, finish: finishing.open };
}

test("Query.holdInput/commitInput/discardInput/forgetInput drive the journal, and the runtime's typed error codes reach the caller", async () => {
  await withQuery(async (q, seen) => {
    const held = seen.find(m => m.subtype === "held_inputs") as SDKHeldInputsMessage | undefined;
    expect(held?.inputs).toEqual([]);
    expect(await q.holdInput!({ inputId: "q1", holdToken: tokenOf("a"), epoch: EPOCH, text: "via query", clientName: "peer" })).toEqual({ held: true });
    expect(await q.holdInput!({ inputId: "q1", holdToken: tokenOf("b"), epoch: EPOCH, text: "via query", clientName: "peer" })).toEqual({ held: true, again: true });
    await expect(q.commitInput!("q1", tokenOf("a"))).rejects.toMatchObject({ code: "superseded" });
    expect(await q.discardInput!("q1", tokenOf("a"))).toEqual({ discarded: false, reason: "superseded" });
    await expect(q.holdInput!({ inputId: "q1", holdToken: tokenOf("c"), epoch: EPOCH, text: "another body", clientName: "peer" })).rejects.toBeInstanceOf(WinterRpcError);
    await expect(q.holdInput!({ inputId: "q2", holdToken: tokenOf("c"), epoch: { incarnationId: "other", leaseEpoch: 9 }, text: "x", clientName: "peer" })).rejects.toMatchObject({ code: "epoch" });
    await expect(q.commitInput!("ghost", tokenOf("a"))).rejects.toMatchObject({ code: "unknown_input" });
    expect(await q.commitInput!("q1", tokenOf("b"))).toEqual({ outcome: "started" });
    expect((seen.find(m => m.subtype === "host_input_committed") as SDKHostInputCommittedMessage | undefined)).toMatchObject({ inputId: "q1", outcome: "started" });
    for (let i = 0; i < 80 && !seen.some(m => m.type === "result"); i++) await sleep(50);
    expect(seen.some(m => m.type === "result")).toBe(true);
    expect(await q.commitInput!("q1", tokenOf("b"))).toEqual({ outcome: "already" });
    expect(await q.forgetInput!("q1", tokenOf("b"))).toEqual({ forgotten: true });
    await expect(q.discardInput!("never", "not-a-token")).rejects.toMatchObject({ code: "invalid" });
  });
});
