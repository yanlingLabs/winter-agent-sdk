// Task 9 (WS-08 §3, §5, §7, §8, §10; P2-A audit recording): the async invocation loop's fixture
// corpus. Uses hand-rolled HookInvoker/HookAuditRecorder/HookRegistry doubles (never a real bridge —
// T10's own job) and TINY injected timeouts throughout (never a real 60s/30s wait — the stall
// watchdog killed a predecessor on exactly this class of mistake).
import { describe, test, expect } from "bun:test";
import type { HookEvent } from "@yanlinglabs/winter-agent-sdk";
import type { SourcedHookEntry, HookRegistry } from "./registry.ts";
import {
  runHooks,
  NO_SCHEMAS_YET_VALIDATOR,
  DEFAULT_GATING_TIMEOUT_MS,
  DEFAULT_OBSERVATIONAL_TIMEOUT_MS,
  type HookInvoker,
  type HookInvocationRequest,
  type HookAuditRecorder,
  type HookAuditRecord,
  type ToolInputValidator,
  type RunHooksContext,
} from "./runner.ts";

function fakeRegistry(entries: SourcedHookEntry[]): HookRegistry {
  return { matching: (event: HookEvent) => entries.filter((e) => e.event === event) };
}

function recordingAudit(): { audit: HookAuditRecorder; records: HookAuditRecord[] } {
  const records: HookAuditRecord[] = [];
  return { audit: { record: (entry) => { records.push(entry); } }, records };
}

// Resolves with `raw` for every invocation, recording every request it was called with.
function fixedInvoker(raw: unknown): { invoker: HookInvoker; requests: HookInvocationRequest[] } {
  const requests: HookInvocationRequest[] = [];
  return { invoker: { invoke: async (request) => { requests.push(request); return raw; } }, requests };
}

// One raw response per call, in order (fixture for multi-hook chains).
function sequenceInvoker(raws: unknown[]): { invoker: HookInvoker; requests: HookInvocationRequest[] } {
  const requests: HookInvocationRequest[] = [];
  let i = 0;
  return {
    invoker: {
      invoke: async (request) => {
        requests.push(request);
        const value = raws[i];
        i++;
        return value;
      },
    },
    requests: requests,
  };
}

function neverResolvingInvoker(): { invoker: HookInvoker; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  return {
    invoker: {
      invoke: (_req, opts) => {
        signals.push(opts.signal);
        return new Promise(() => {}); // never settles -- only the runner's own timeout race resolves the test
      },
    },
    signals,
  };
}

function rejectingInvoker(): HookInvoker {
  return { invoke: async () => { throw new Error("transport exploded"); } };
}

const BASE_CTX_FIELDS = { sessionId: "sess-1", policyVersion: 3, timeouts: { gatingTimeoutMs: 20, observationalTimeoutMs: 20 } };

function ctxWith(overrides: Partial<RunHooksContext>): RunHooksContext {
  return { registry: fakeRegistry([]), invoker: rejectingInvoker(), audit: recordingAudit().audit, ...BASE_CTX_FIELDS, ...overrides };
}

function entry(id: string, event: HookEvent, overrides?: Partial<SourcedHookEntry>): SourcedHookEntry {
  return { id, event, source: "sdk", ...overrides };
}

describe("runHooks -- basic shape", () => {
  test("no matched hooks -- empty composite, no lifecycle records", async () => {
    const { audit } = recordingAudit();
    const composite = await runHooks("Stop", {}, ctxWith({ registry: fakeRegistry([]), audit }));
    expect(composite.decision).toBeUndefined();
    expect(composite.lifecycleMessages).toEqual([]);
  });

  test("one hook, allow -- composite reflects it, one audit record with outcome 'decision'", async () => {
    const { audit, records } = recordingAudit();
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: { command: "ls" } }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker, audit }));
    expect(composite.decision).toBe("allow");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ hookId: "h1", hookEvent: "PreToolUse", sessionId: "sess-1", outcome: "decision", decision: "allow" });
    expect(typeof records[0]!.uuid).toBe("string");
  });
});

describe("runHooks -- §10 request payload shape", () => {
  test("built request carries event/sessionId/policyVersion(string)/requestId/toolName/toolUseID/input/matchedMatcher", async () => {
    const { invoker, requests } = fixedInvoker({});
    await runHooks(
      "PreToolUse",
      { toolName: "Bash", toolUseID: "tu-1", input: { command: "ls" } },
      ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse", { matcher: "Bash" })]), invoker, sessionId: "sess-x", policyVersion: 7, agentID: "agent-1" }),
    );
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.event).toBe("PreToolUse");
    expect(req.sessionId).toBe("sess-x");
    expect(req.policyVersion).toBe("7"); // WS-08 §10 pins this as a STRING even though PolicyState.version is a number internally
    expect(req.toolName).toBe("Bash");
    expect(req.toolUseID).toBe("tu-1");
    expect(req.input).toEqual({ command: "ls" });
    expect(req.matchedMatcher).toBe("Bash");
    expect(req.agentID).toBe("agent-1");
    expect(typeof req.requestId).toBe("string");
  });

  test("optional fields absent from the call are absent from the request (not present-as-undefined)", async () => {
    const { invoker, requests } = fixedInvoker({});
    await runHooks("Stop", {}, ctxWith({ registry: fakeRegistry([entry("h1", "Stop")]), invoker }));
    const req = requests[0]!;
    expect("toolName" in req).toBe(false);
    expect("toolUseID" in req).toBe(false);
    expect("input" in req).toBe(false);
    expect("agentID" in req).toBe(false);
    expect("matchedMatcher" in req).toBe(false);
  });
});

describe("runHooks -- PreToolUse decisions + invocation-time transform chaining", () => {
  test("a transform-only ('none') hook feeds its output into the NEXT hook's request input (rule 3 sentence 1, invocation-time)", async () => {
    const { invoker, requests } = sequenceInvoker([
      { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "sanitized" } } },
      { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
    ]);
    await runHooks(
      "PreToolUse",
      { toolName: "Bash", input: { command: "rm -rf /" } },
      ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse"), entry("h2", "PreToolUse")]), invoker }),
    );
    expect(requests[0]!.input).toEqual({ command: "rm -rf /" }); // h1 sees the ORIGINAL input
    expect(requests[1]!.input).toEqual({ command: "sanitized" }); // h2 sees h1's transformed value
  });

  test("PreToolUse deny short-circuits: later hooks are never invoked, recorded 'skipped'", async () => {
    const { invoker, requests } = sequenceInvoker([{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } }]);
    const { audit, records } = recordingAudit();
    const composite = await runHooks(
      "PreToolUse",
      { toolName: "Bash", input: {} },
      ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse"), entry("h2", "PreToolUse"), entry("h3", "PreToolUse")]), invoker, audit }),
    );
    expect(composite.decision).toBe("deny");
    expect(requests).toHaveLength(1); // h2/h3 never invoked at all
    expect(records.map((r) => r.outcome)).toEqual(["decision", "skipped", "skipped"]);
    expect(composite.lifecycleMessages.map((m) => m.outcome)).toEqual(["decision", "skipped", "skipped"]);
  });

  test("defer resolves to 'ask' (controller ruling, TODO(T11))", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } });
    const { audit, records } = recordingAudit();
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker, audit }));
    expect(composite.decision).toBe("ask");
    expect(records[0]!.decision).toBe("ask");
  });
});

describe("runHooks -- schema-validation seam (WS-07 §10.6-2 / WS-08 §3: invalid transform = hook contract error)", () => {
  test("NO_SCHEMAS_YET_VALIDATOR accepts anything (P2: no schemas exist yet)", () => {
    expect(NO_SCHEMAS_YET_VALIDATOR.validate("Bash", { command: "anything" })).toEqual({ valid: true });
  });

  test("a rejecting validator double turns an invalid transform into that hook's contract error -- the ORIGINAL input proceeds to the next hook untouched", async () => {
    const rejecting: ToolInputValidator = { validate: () => ({ valid: false, reason: "does not match tool schema" }) };
    const { invoker, requests } = sequenceInvoker([
      { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "invalid-shape" } } },
      { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
    ]);
    const { audit, records } = recordingAudit();
    const composite = await runHooks(
      "PreToolUse",
      { toolName: "Bash", input: { command: "original" } },
      ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse"), entry("h2", "PreToolUse")]), invoker, validator: rejecting, audit }),
    );
    expect(records[0]!.outcome).toBe("error");
    expect(requests[1]!.input).toEqual({ command: "original" }); // h1's invalid transform never took effect -- h2 sees the ORIGINAL input
    expect(composite.transformedInput).toBeUndefined(); // h1's rejected transform never reaches the composite either
    expect(composite.decision).toBe("allow"); // h2 still ran and contributed normally
  });
});

describe("runHooks -- §8 failure matrix, row by row", () => {
  test("gating hook error: no contribution, recorded, evaluation CONTINUES with remaining hooks -- NEVER a tool denial by itself", async () => {
    // h1 rejects outright (transport/host failure); h2 answers normally -- a single invoker that
    // throws on the first call and resolves normally after.
    let calls = 0;
    const mixedInvoker: HookInvoker = {
      invoke: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
      },
    };
    const { audit, records } = recordingAudit();
    const composite = await runHooks(
      "PreToolUse",
      { toolName: "Bash", input: {} },
      ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse"), entry("h2", "PreToolUse")]), invoker: mixedInvoker, audit }),
    );
    expect(records[0]!.outcome).toBe("error");
    expect(records[1]!.outcome).toBe("decision"); // h2 still ran
    expect(composite.decision).toBe("allow"); // h1's error contributed nothing but did NOT deny anything
  });

  test("gating hook timeout: distinct outcome kind from 'error', no contribution, evaluation continues", async () => {
    const { invoker: slow, signals } = neverResolvingInvoker();
    const fast = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }).invoker;
    let calls = 0;
    const combined: HookInvoker = { invoke: (req, opts) => { calls++; return calls === 1 ? slow.invoke(req, opts) : fast.invoke(req, opts); } };
    const { audit, records } = recordingAudit();
    const composite = await runHooks(
      "PreToolUse",
      { toolName: "Bash", input: {} },
      ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse"), entry("h2", "PreToolUse")]), invoker: combined, audit, timeouts: { gatingTimeoutMs: 15, observationalTimeoutMs: 15 } }),
    );
    expect(records[0]!.outcome).toBe("timeout");
    expect(records[1]!.outcome).toBe("decision");
    expect(composite.decision).toBe("allow");
    expect(signals[0]!.aborted).toBe(true); // the runner aborts the pinned HookCallback signal on timeout
  });

  test("observational (PostToolUse) hook error: logged, never affects the composite -- structurally cannot deny (PostToolUse's interpreter never produces a 'decision' outcome)", async () => {
    const { audit, records } = recordingAudit();
    const composite = await runHooks(
      "PostToolUse",
      { toolName: "Bash", input: {}, payload: { tool_response: "ok" } },
      ctxWith({ registry: fakeRegistry([entry("h1", "PostToolUse")]), invoker: rejectingInvoker(), audit }),
    );
    expect(records[0]!.outcome).toBe("error");
    expect(composite.decision).toBeUndefined();
  });

  test("no-retroactive-denial, structurally: even a MALICIOUS/buggy PostToolUse hook trying to smuggle a permissionDecision is ignored -- composite carries no decision", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny", additionalContext: "trying to deny after the fact" } });
    const composite = await runHooks("PostToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PostToolUse")]), invoker }));
    expect(composite.decision).toBeUndefined();
    expect(composite.extraContext).toEqual([{ hookId: "h1", context: "trying to deny after the fact" }]); // the legitimate field still comes through
  });

  test("malformed output (not an object at all) = that hook's error", async () => {
    const { invoker } = fixedInvoker("just a string, not a HookJSONOutput shape");
    const { audit, records } = recordingAudit();
    await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker, audit }));
    expect(records[0]!.outcome).toBe("error");
  });

  test("unknown fields on an otherwise well-formed output are preserved losslessly -- i.e. never cause an error, and known fields still interpret correctly", async () => {
    const { invoker } = fixedInvoker({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", someFutureFieldNobodyKnowsYet: { nested: true } },
      anotherUnknownTopLevelField: 42,
    });
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker }));
    expect(composite.decision).toBe("allow");
  });

  test("invalid defer on a non-suspendable event (Notification) = hook contract error", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "Notification", permissionDecision: "defer" } });
    const { audit, records } = recordingAudit();
    const composite = await runHooks("Notification", { payload: { message: "hi" } }, ctxWith({ registry: fakeRegistry([entry("h1", "Notification")]), invoker, audit }));
    expect(records[0]!.outcome).toBe("error");
    expect(composite.decision).toBeUndefined();
  });
});

describe("runHooks -- per-hook timeout defaults (WS-08 §8 / open Q2)", () => {
  test("DEFAULT_GATING_TIMEOUT_MS is 60s, DEFAULT_OBSERVATIONAL_TIMEOUT_MS is 30s (proposed defaults, never exercised via a real wait in this suite)", () => {
    expect(DEFAULT_GATING_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_OBSERVATIONAL_TIMEOUT_MS).toBe(30_000);
  });

  test("an entry's own timeoutMs overrides the event-classification default", async () => {
    const { invoker: slow, signals } = neverResolvingInvoker();
    const { audit, records } = recordingAudit();
    // PostToolUse is observational (default 30s in production) but this entry pins 10ms -- proves
    // the PER-ENTRY override wins over the per-classification default, and that observational
    // events use the SAME timeout mechanism as gating ones (only the default differs).
    await runHooks("PostToolUse", { toolName: "Bash" }, ctxWith({ registry: fakeRegistry([entry("h1", "PostToolUse", { timeoutMs: 10 })]), invoker: slow, audit, timeouts: {} }));
    expect(records[0]!.outcome).toBe("timeout");
    expect(signals[0]!.aborted).toBe(true);
  });
});

describe("runHooks -- classifierContext accumulation (WS-08 §5, T12-consumed)", () => {
  test("a PostToolUse hook's classifierContext reaches the composite's dedicated bucket", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PostToolUse", classifierContext: "wrote outside the workspace" } });
    const composite = await runHooks("PostToolUse", { toolName: "Bash" }, ctxWith({ registry: fakeRegistry([entry("h1", "PostToolUse")]), invoker }));
    expect(composite.classifierContext).toEqual([{ hookId: "h1", context: "wrote outside the workspace" }]);
  });
});
