// Phase 5 fix wave, B-H1(c) + B-H1(d) — the Notification event, and the hook-audit journal READER.
//
// B-H1(c). `Notification` was in `HOOK_EVENTS` and in the pinned `NotificationHookInput` and fired
// NOWHERE. The P2 conformance matrix's own `WS08-EVT-NOTIFICATION` row records it as the one event
// with no firing fixture -- "a genuine ruling-vs-implementation discrepancy". Three Winter-defined
// points now emit it, and they are Winter's because they have to be: OQ-P5-8 records
// `notification_type` as an OPEN `string` with no declared values, and no emission point fires in
// the canned single-shot run T1 captured, so capture could observe neither the vocabulary nor the
// trigger set.
//
// B-H1(d). WS-08 §9's audit stream has been WRITE-ONLY since P2 -- every hook invocation journalled
// and nothing able to read one back. `readHookAuditJournal` is the read-only half, tested against a
// journal the RUNNER actually wrote rather than a hand-built file.
//
// Every fixture builds mkdtemp roots. Nothing reads a real `~/.winter`.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider, type ProviderTurn } from "../engine.ts";
import { scriptedProvider, stubExecutor } from "../provider/mock.ts";
import { readHookAuditJournal, appendHookAuditJournal } from "../permissions/ruleset.ts";
import { resolveEngineSession } from "../store/dialect.ts";

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "winter-bh1-home-"));
  cwd = mkdtempSync(join(tmpdir(), "winter-bh1-cwd-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/**
 * Drives one turn with a REAL `Options.hooks`-shaped `Notification` registration, answering the
 * hook control_request the way a host would, and returns every `Notification` payload it saw.
 */
async function collectNotifications(turns: ProviderTurn[], extra: Partial<RuntimeConfig> = {}): Promise<Record<string, unknown>[]> {
  // THE WIRE SHAPE, not the pinned `HookInput` shape. A `hook` control_request carries a
  // `HookInvocationRequest` -- `{event, sessionId, payload, hookId, ...}` -- and the host's own
  // wrapper is what assembles a `NotificationHookInput` from it. What this runtime is responsible
  // for, and therefore what these fixtures assert, is the `payload` it hands over.
  const seen: Record<string, unknown>[] = [];
  const { host, runtime } = createInMemoryChannel();
  const config: RuntimeConfig = {
    sessionId: "bh1c",
    cwd,
    model: "sonnet",
    winterHome: home,
    settingSources: [],
    // `RuntimeHooksConfig` is the POST-strip shape query.ts produces: a group carries a COUNT and
    // a source, never the callbacks themselves (those stay host-side and are reached over the bridge
    // by positional id).
    hooks: { Notification: [{ source: "sdk", hookCount: 1 }] } as unknown as NonNullable<RuntimeConfig["hooks"]>,
    ...extra,
  };
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: scriptedProvider(turns), tools: stubExecutor });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  for await (const frame of host.input) {
    if (frame.type !== "control_request") continue;
    const req = frame as { requestId: string; subtype: string; payload?: { event?: string; payload?: Record<string, unknown> } };
    if (req.subtype !== "hook") continue;
    if (req.payload?.event === "Notification" && req.payload.payload !== undefined) seen.push({ hook_event_name: "Notification", ...req.payload.payload });
    // Answer every hook request, or the run stalls on the one it is waiting for.
    host.output.write({ type: "control_response", requestId: req.requestId, ok: true, payload: {} } as WinterFrame);
  }
  await done;
  return seen;
}

describe("B-H1(c): the Notification event actually fires", () => {
  test("IDLE: the session announces that it is waiting for input, at startup and after each turn", async () => {
    const seen = await collectNotifications([{ kind: "text", text: "done" }]);
    const idle = seen.filter((n) => (n as { notification_type?: string }).notification_type === "idle");
    // TWO: one at `SessionStart` (the state machine's first entry into `idle`) and one after the
    // turn's terminal result (its return to it). An observer polling for "is it my turn" has no
    // other signal -- `result` also fires for a turn that immediately continues a streaming input.
    expect(idle.length).toBe(2);
    expect((idle[0] as { message?: string }).message).toBe("Waiting for input.");
  });

  test("PERMISSION PROMPT: the notification is emitted BEFORE the request goes out, not after it resolves", async () => {
    // The observer's whole use for this event is "something is waiting on you", which is worthless
    // once the wait is over -- so the ORDER is the assertion, not merely the presence.
    const order: string[] = [];
    const { host, runtime } = createInMemoryChannel();
    const config: RuntimeConfig = {
      sessionId: "bh1c-perm",
      cwd,
      model: "sonnet",
      winterHome: home,
      settingSources: [],
      // `RuntimeHooksConfig` is the POST-strip shape query.ts produces: a group carries a COUNT and
    // a source, never the callbacks themselves (those stay host-side and are reached over the bridge
    // by positional id).
    hooks: { Notification: [{ source: "sdk", hookCount: 1 }] } as unknown as NonNullable<RuntimeConfig["hooks"]>,
    };
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider: scriptedProvider([{ kind: "tool_use", calls: [{ id: "c1", name: "mystery_tool", input: {} }] }, { kind: "text", text: "done" }]),
      tools: stubExecutor,
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    for await (const frame of host.input) {
      if (frame.type !== "control_request") continue;
      const req = frame as { requestId: string; subtype: string; payload?: { event?: string; payload?: { notification_type?: string } } };
      if (req.subtype === "hook" && req.payload?.event === "Notification" && req.payload.payload?.notification_type === "permission_prompt") {
        order.push("notification");
      }
      if (req.subtype === "permission") order.push("permission");
      host.output.write({
        type: "control_response",
        requestId: req.requestId,
        ok: true,
        payload: req.subtype === "permission" ? { behavior: "deny", message: "no" } : {},
      } as WinterFrame);
    }
    await done;
    expect(order[0], "the announcement precedes the request it announces").toBe("notification");
    expect(order).toContain("permission");
  });

  test("the payload carries the three pinned fields, and `title` only where there is one", async () => {
    const seen = await collectNotifications([{ kind: "text", text: "done" }]);
    const idle = seen.find((n) => (n as { notification_type?: string }).notification_type === "idle") as Record<string, unknown>;
    expect(idle["hook_event_name"]).toBe("Notification");
    expect(typeof idle["message"]).toBe("string");
    expect(typeof idle["notification_type"]).toBe("string");
    // `title` is OPTIONAL on the pin, and an idle announcement has nothing worth putting in one --
    // absent rather than an empty string, matching every other optional field in this codebase.
    expect("title" in idle).toBe(false);
  });

  test("a session with NO Notification hook registered is unaffected -- nothing is emitted to nobody", async () => {
    // The discriminating control: the emission is observational and fire-and-forget, so a session
    // that registers nothing must behave exactly as it did before this landed.
    const { host, runtime } = createInMemoryChannel();
    const config: RuntimeConfig = { sessionId: "bh1c-none", cwd, model: "sonnet", winterHome: home, settingSources: [] };
    const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: scriptedProvider([{ kind: "text", text: "done" }]), tools: stubExecutor });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    let hookRequests = 0;
    for await (const frame of host.input) {
      if (frame.type === "control_request" && (frame as { subtype: string }).subtype === "hook") hookRequests++;
    }
    expect(await done).toBe(0);
    expect(hookRequests).toBe(0);
  });
});

describe("B-H1(d): the hook-audit journal can be READ back", () => {
  const location = () => ({ winterHome: home, projectKey: "proj", sessionId: "audit-1" });

  test("an absent journal is an EMPTY history, never a throw", () => {
    expect(readHookAuditJournal(location())).toEqual([]);
  });

  test("records round-trip, oldest first, carrying the envelope's own timestamp", () => {
    appendHookAuditJournal(location(), { hookId: "PreToolUse" + ":sdk:0:0", hookEvent: "PreToolUse", sessionId: "audit-1", uuid: "u1", outcome: "success", decision: "allow", durationMs: 12 });
    appendHookAuditJournal(location(), { hookId: "PostToolUse" + ":sdk:0:0", hookEvent: "PostToolUse", sessionId: "audit-1", uuid: "u2", outcome: "error" });
    const entries = readHookAuditJournal(location());
    expect(entries.map((e) => e.hookEvent)).toEqual(["PreToolUse", "PostToolUse"]);
    expect(entries[0]!.decision).toBe("allow");
    expect(entries[0]!.durationMs).toBe(12);
    expect(entries[0]!.at.length, "the envelope's ISO timestamp is what makes a listing orderable").toBeGreaterThan(0);
  });

  test("the filter narrows by event and by outcome", () => {
    appendHookAuditJournal(location(), { hookId: "PreToolUse" + ":sdk:0:0", hookEvent: "PreToolUse", sessionId: "audit-1", uuid: "u1", outcome: "success" });
    appendHookAuditJournal(location(), { hookId: "PreToolUse" + ":sdk:0:0", hookEvent: "PreToolUse", sessionId: "audit-1", uuid: "u2", outcome: "error" });
    appendHookAuditJournal(location(), { hookId: "Stop" + ":sdk:0:0", hookEvent: "Stop", sessionId: "audit-1", uuid: "u3", outcome: "success" });
    expect(readHookAuditJournal(location(), { event: "PreToolUse" }).length).toBe(2);
    expect(readHookAuditJournal(location(), { outcome: "error" }).map((e) => e.uuid)).toEqual(["u2"]);
    expect(readHookAuditJournal(location(), { event: "PreToolUse", outcome: "error" }).length).toBe(1);
  });

  test("a PERMISSION-update line in the SAME journal is not a hook record", () => {
    // The one thing that makes this a hook reader rather than a journal dumper: the two kinds are
    // distinguishable sibling lines in one file, and a permission envelope has no `kind` at all.
    appendHookAuditJournal(location(), { hookId: "PreToolUse" + ":sdk:0:0", hookEvent: "PreToolUse", sessionId: "audit-1", uuid: "u1", outcome: "success" });
    const path = join(home, "projects", "proj", "audit-1.permission-journal.jsonl");
    writeFileSync(path, `${JSON.stringify({ authority: "session", at: new Date().toISOString(), update: { type: "addRules", rules: [], behavior: "allow", destination: "session" } })}\n`, { flag: "a" });
    const entries = readHookAuditJournal(location());
    expect(entries.length).toBe(1);
    expect(entries[0]!.hookEvent).toBe("PreToolUse");
  });

  test("a TORN final line is skipped -- every whole record before it still reads", () => {
    appendHookAuditJournal(location(), { hookId: "PreToolUse" + ":sdk:0:0", hookEvent: "PreToolUse", sessionId: "audit-1", uuid: "u1", outcome: "success" });
    const path = join(home, "projects", "proj", "audit-1.permission-journal.jsonl");
    writeFileSync(path, '{"kind":"hookAudit","at":"2026-0', { flag: "a" });
    expect(readHookAuditJournal(location()).map((e) => e.uuid)).toEqual(["u1"]);
  });

  test("END TO END: a journal the RUNNER wrote reads back through this API", async () => {
    // The assertion a hand-built file cannot make -- that the WRITER and the READER agree about the
    // envelope, not just that the reader parses what this test wrote.
    const sessionId = "audit-live";
    const { config, store } = await resolveEngineSession({
      config: { sessionId, cwd, model: "sonnet", winterHome: home, hooks: { PreToolUse: [{ source: "sdk", hookCount: 1 }] } as unknown as NonNullable<RuntimeConfig["hooks"]> },
      resolveWinterHome: () => home,
      env: {},
    });
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider: scriptedProvider([{ kind: "tool_use", calls: [{ id: "c1", name: "test_tool", input: {} }] }, { kind: "text", text: "done" }]),
      tools: stubExecutor,
      ...(store !== undefined ? { store } : {}),
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    for await (const frame of host.input) {
      if (frame.type !== "control_request") continue;
      const req = frame as { requestId: string; subtype: string };
      host.output.write({ type: "control_response", requestId: req.requestId, ok: true, payload: req.subtype === "permission" ? { behavior: "allow" } : {} } as WinterFrame);
    }
    await done;
    const projectKey = (await import("@yanlinglabs/winter-agent-sdk")).compatibilityKeys(cwd).transcriptProjectKey;
    const entries = readHookAuditJournal({ winterHome: home, projectKey, sessionId });
    expect(entries.length, "the runner journalled at least the PreToolUse invocation").toBeGreaterThan(0);
    expect(entries.every((e) => typeof e.hookEvent === "string" && typeof e.outcome === "string")).toBe(true);
  });
});
