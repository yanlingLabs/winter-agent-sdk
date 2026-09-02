// Task 9 (WS-08 §3, §5, §7, §8, §10; P2-A audit recording): the async invocation loop's fixture
// corpus. Uses hand-rolled HookInvoker/HookAuditRecorder/HookRegistry doubles (never a real bridge —
// T10's own job) and TINY injected timeouts throughout (never a real 60s/30s wait — the stall
// watchdog killed a predecessor on exactly this class of mistake).
import { describe, test, expect } from "bun:test";
import type { HookEvent, PermissionUpdate } from "@yanlinglabs/winter-agent-sdk";
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

  // Finding 11 (P2 fix-wave, NIT): the audit record carries agentID -- WS-08 §11's own child-call
  // correlator -- the SAME value every participant's own HookInvocationRequest in this call already
  // receives (the "built request carries ... agentID" fixture below, this file's own precedent).
  test("Finding 11: agentID (when the caller supplies one) is stamped on every audit record", async () => {
    const { audit, records } = recordingAudit();
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker, audit, agentID: "agent-1" }));
    expect(records[0]!.agentID).toBe("agent-1");
  });

  test("Finding 11: agentID is absent (not present-as-undefined) from the audit record when the caller supplies none", async () => {
    const { audit, records } = recordingAudit();
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker, audit }));
    expect("agentID" in records[0]!).toBe(false);
  });
});

describe("runHooks -- §10 request payload shape", () => {
  test("built request carries event/sessionId/policyVersion(string)/requestId/toolName/toolUseID/input/matchedMatcher/hookId", async () => {
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
    // T10: the ONE additive field beyond WS-08 §10's own pinned semantic contract -- Winter's own
    // wire concern (not a divergence, see runner.ts's own comment on this field): the bridge-backed
    // invoker (T10) needs an identity to route an inbound "hook" control_request back to the correct
    // Options.hooks callback, and the pinned request shape has no such field (it targets a
    // filesystem hook SCRIPT's stdin, invoked directly with no ambiguity about which script runs).
    expect(req.hookId).toBe("h1");
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

  test("Task 11: defer flows through as a real, distinct decision (interim ask-resolution retired)", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } });
    const { audit, records } = recordingAudit();
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker, audit }));
    expect(composite.decision).toBe("defer");
    expect(records[0]!.decision).toBe("defer");
  });
});

// Finding 2 (P2 fix-wave, IMPORTANT): the pinned SyncHookJSONOutput.decision top-level legacy
// channel ("approve"/"block") — capture-verified against the pinned 0.3.250 official runtime (see
// interpretPreToolUse's own comment, and the fix-wave report, for the full loopback trace): a
// PreToolUse hook returning `{decision:"block", reason:"…"}` with NO hookSpecificOutput at all IS
// honored (the tool never executes; the denial lands in result.permission_denials).
describe("runHooks -- Finding 2: PreToolUse's legacy top-level {decision} channel (no hookSpecificOutput)", () => {
  test("{decision:\"block\", reason:\"nope\"} composes to a deny, message carries the reason verbatim", async () => {
    const { invoker } = fixedInvoker({ decision: "block", reason: "nope" });
    const { audit, records } = recordingAudit();
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: { command: "rm -rf /" } }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker, audit }));
    expect(composite.decision).toBe("deny");
    expect(composite.message).toBe("nope");
    expect(records[0]).toMatchObject({ outcome: "decision", decision: "deny" });
  });

  test("{decision:\"approve\"} (sibling) composes to an allow-shaped composite — composes with Finding 1's own new hook-allow resolution", async () => {
    const { invoker } = fixedInvoker({ decision: "approve" });
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker }));
    expect(composite.decision).toBe("allow");
  });

  test("permissionDecision wins over the legacy top-level channel when BOTH are present (newer API takes precedence)", async () => {
    const { invoker } = fixedInvoker({ decision: "block", reason: "legacy says no", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker }));
    expect(composite.decision).toBe("allow");
    expect(composite.message).toBeUndefined(); // the legacy reason never surfaces once permissionDecision wins
  });

  test("a malformed top-level decision value (not \"approve\"/\"block\") is a hook contract error, not a silent none", async () => {
    const { invoker } = fixedInvoker({ decision: "yes-please" });
    const { audit, records } = recordingAudit();
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker, audit }));
    expect(composite.decision).toBeUndefined();
    expect(records[0]).toMatchObject({ outcome: "error" });
  });

  test("absent decision entirely (neither top-level nor hookSpecificOutput) stays a genuine no-opinion 'none', unaffected", async () => {
    const { invoker } = fixedInvoker({});
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker }));
    expect(composite.decision).toBeUndefined();
  });

  test("a top-level {decision:\"block\"} still composes correctly alongside a later, stricter hook (WS-08 §4 rank order applies identically)", async () => {
    const { invoker } = sequenceInvoker([
      { decision: "block", reason: "legacy block from h1" },
      { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "h2's own deny" } },
    ]);
    const composite = await runHooks(
      "PreToolUse",
      { toolName: "Bash", input: {} },
      ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse"), entry("h2", "PreToolUse")]), invoker }),
    );
    // both are "deny" rank -- earliest-of-tie wins the scalar slot (reducer.ts's own documented rule).
    expect(composite.decision).toBe("deny");
    expect(composite.message).toBe("legacy block from h1");
  });
});

// T10 (WS-08 §6): PermissionRequest's OWN narrower pinned shape --
// `hookSpecificOutput.decision.{behavior:"allow"|"deny", ...}` -- structurally different from
// PreToolUse's flat `permissionDecision` field. Without a DEDICATED interpreter this event falls
// through to interpretGeneric (which reads only `additionalContext`, a field this shape doesn't
// even have) and EVERY answer silently becomes {kind:"none"} -- a genuine under-enforcement trap
// caught by T9's own review before this task started wiring PermissionRequest at all.
describe("runHooks -- PermissionRequest decisions (WS-08 §6; T9-CARRY-3 reconciliation)", () => {
  test("allow with updatedInput + updatedPermissions -- both surface on the composite", async () => {
    const suggestion: PermissionUpdate[] = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls *" }], behavior: "allow", destination: "session" }];
    const { invoker } = fixedInvoker({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: { command: "ls -la" }, updatedPermissions: suggestion },
      },
    });
    const composite = await runHooks(
      "PermissionRequest",
      { toolName: "Bash", input: { command: "ls" } },
      ctxWith({ registry: fakeRegistry([entry("h1", "PermissionRequest")]), invoker }),
    );
    expect(composite.decision).toBe("allow");
    expect(composite.transformedInput).toEqual({ command: "ls -la" });
    expect(composite.updatedPermissions).toEqual(suggestion);
  });

  test("allow with neither updatedInput nor updatedPermissions -- bare allow", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    const composite = await runHooks("PermissionRequest", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PermissionRequest")]), invoker }));
    expect(composite.decision).toBe("allow");
    expect(composite.transformedInput).toBeUndefined();
    expect(composite.updatedPermissions).toBeUndefined();
  });

  test("deny with message + interrupt", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no way", interrupt: true } } });
    const { audit, records } = recordingAudit();
    const composite = await runHooks(
      "PermissionRequest",
      { toolName: "Bash", input: {} },
      ctxWith({ registry: fakeRegistry([entry("h1", "PermissionRequest")]), invoker, audit }),
    );
    expect(composite.decision).toBe("deny");
    expect(composite.message).toBe("no way");
    expect(composite.interrupt).toBe(true);
    expect(records[0]!.outcome).toBe("decision");
    expect(records[0]!.decision).toBe("deny");
  });

  test("no hookSpecificOutput at all (pure observer) -- 'none', not an error", async () => {
    const { invoker } = fixedInvoker({});
    const { audit, records } = recordingAudit();
    const composite = await runHooks("PermissionRequest", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PermissionRequest")]), invoker, audit }));
    expect(composite.decision).toBeUndefined();
    expect(records[0]!.outcome).toBe("none");
  });

  test("hookEventName mismatch (e.g. a hook that answered as if it were PreToolUse) -- 'none', not an error, matching every other interpreter's own silent-none posture", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    const composite = await runHooks("PermissionRequest", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PermissionRequest")]), invoker }));
    expect(composite.decision).toBeUndefined();
  });

  test("§11 answer authority negative fixture: decision.behavior:'defer' is a malformed output (that hook's own §8 error), never silently an allow -- PermissionRequest's pinned shape has NO defer arm despite WS-08 §7's prose (T9-CARRY-3)", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "defer" } } });
    const { audit, records } = recordingAudit();
    const composite = await runHooks(
      "PermissionRequest",
      { toolName: "Bash", input: {} },
      ctxWith({ registry: fakeRegistry([entry("h1", "PermissionRequest")]), invoker, audit }),
    );
    expect(composite.decision).toBeUndefined(); // never silently treated as an opinion of any kind
    expect(records[0]!.outcome).toBe("error");
  });

  test("an unrecognized behavior value is likewise a contract error, not silently ignored or allowed", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "maybe" } } });
    const { audit, records } = recordingAudit();
    await runHooks("PermissionRequest", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PermissionRequest")]), invoker, audit }));
    expect(records[0]!.outcome).toBe("error");
  });

  test("decision present but not an object -- malformed, that hook's error (distinct from decision ABSENT, which is 'none')", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: "allow" } });
    const { audit, records } = recordingAudit();
    await runHooks("PermissionRequest", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PermissionRequest")]), invoker, audit }));
    expect(records[0]!.outcome).toBe("error");
  });

  test("allow with a non-object updatedInput -- that hook's error; allow with a non-array updatedPermissions -- that hook's error", async () => {
    const { invoker: badInput } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: "not an object" } } });
    const r1 = await runHooks("PermissionRequest", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PermissionRequest")]), invoker: badInput }));
    expect(r1.decision).toBeUndefined();

    const { invoker: badPerms } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedPermissions: "not an array" } } });
    const r2 = await runHooks("PermissionRequest", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PermissionRequest")]), invoker: badPerms }));
    expect(r2.decision).toBeUndefined();
  });

  test("multiple PermissionRequest hooks reduce deterministically (deny beats allow)", async () => {
    const { invoker } = sequenceInvoker([
      { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } },
      { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "second hook vetoes" } } },
    ]);
    const composite = await runHooks(
      "PermissionRequest",
      { toolName: "Bash", input: {} },
      ctxWith({ registry: fakeRegistry([entry("h1", "PermissionRequest"), entry("h2", "PermissionRequest")]), invoker }),
    );
    expect(composite.decision).toBe("deny");
    expect(composite.message).toBe("second hook vetoes");
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

  // Item 8(b) (P2 fix-wave) reframe: this fixture's OLD title said unknown fields are "preserved
  // losslessly" -- inaccurate, and not what the assertion below actually checks. HookOutcome has no
  // generic passthrough slot for an arbitrary unknown key, so an unknown field is never forwarded
  // anywhere in the composite; it is simply IGNORED, silently, by every interpreter here (which only
  // ever reads the specific field names it recognizes off the raw object). What this fixture
  // actually proves -- and all it is meant to prove -- is narrower: an unrecognized field's mere
  // PRESENCE alongside a well-formed, recognized one does not itself trigger a hook contract error;
  // recognized-field interpretation proceeds exactly as if the unknown field were absent. This is
  // NOT an endorsement that Winter forwards/round-trips unknown fields anywhere (contrast WS-08
  // §1.3's own "unknown EVENT NAMES are accepted, preserved, inert" — a different claim, about a
  // different layer, that this fixture does not test).
  test("Item 8(b): an unrecognized field's mere presence never causes an error -- a known field alongside it still interprets correctly (NOT a claim that unknown fields are forwarded/preserved anywhere)", async () => {
    const { invoker } = fixedInvoker({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", someFutureFieldNobodyKnowsYet: { nested: true } },
      anotherUnknownTopLevelField: 42,
    });
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker }));
    expect(composite.decision).toBe("allow");
    // The unknown fields themselves never surface anywhere on the composite -- there is no slot for
    // them to land in, which is precisely the point this fixture's own reframed title makes.
    expect("someFutureFieldNobodyKnowsYet" in composite).toBe(false);
    expect("anotherUnknownTopLevelField" in composite).toBe(false);
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

// T10 (WS-08 §9): the public lifecycle sink -- optional, gating lives entirely in the CALLER's own
// concrete sink (engine.ts), not here; this file only proves runner.ts calls it at the right times
// with the right (coarse, P2-A-pinned) fields.
describe("runHooks -- HookLifecycleSink (WS-08 §9)", () => {
  function recordingLifecycle(): {
    lifecycle: import("./runner.ts").HookLifecycleSink;
    events: Array<{ kind: "started" | "response"; hookId: string; hookName?: string; hookEvent: string; sessionId: string; outcome?: string }>;
  } {
    const events: Array<{ kind: "started" | "response"; hookId: string; hookName?: string; hookEvent: string; sessionId: string; outcome?: string }> = [];
    return {
      events,
      lifecycle: {
        started: (info) => events.push({ kind: "started", ...info }),
        response: (info) => events.push({ kind: "response", ...info }),
      },
    };
  }

  test("started then response fire, in order, for an invoked hook -- decision/none outcomes map to 'success'", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    const { lifecycle, events } = recordingLifecycle();
    await runHooks(
      "PreToolUse",
      { toolName: "Bash", input: {} },
      ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse", { name: "myHook" })]), invoker, lifecycle }),
    );
    expect(events).toEqual([
      { kind: "started", hookId: "h1", hookName: "myHook", hookEvent: "PreToolUse", sessionId: "sess-1" },
      { kind: "response", hookId: "h1", hookName: "myHook", hookEvent: "PreToolUse", sessionId: "sess-1", outcome: "success" },
    ]);
  });

  test("a hook with no name omits hookName from the lifecycle events too (mirrors the audit record's own optionality)", async () => {
    const { invoker } = fixedInvoker({});
    const { lifecycle, events } = recordingLifecycle();
    await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker, lifecycle }));
    expect("hookName" in events[0]!).toBe(false);
    expect("hookName" in events[1]!).toBe(false);
  });

  test("error and timeout outcomes both map to the public 'error' outcome (WS-08 §9 Open Question 2's own speculation)", async () => {
    const { lifecycle, events } = recordingLifecycle();
    await runHooks(
      "PreToolUse",
      { toolName: "Bash", input: {} },
      ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker: rejectingInvoker(), lifecycle }),
    );
    expect(events[1]!.outcome).toBe("error");

    const { lifecycle: lifecycle2, events: events2 } = recordingLifecycle();
    await runHooks(
      "PreToolUse",
      { toolName: "Bash", input: {} },
      ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker: neverResolvingInvoker().invoker, timeouts: { gatingTimeoutMs: 10, observationalTimeoutMs: 10 }, lifecycle: lifecycle2 }),
    );
    expect(events2[1]!.outcome).toBe("error");
  });

  test("a SKIPPED hook (deny short-circuit) never fires started/response at all -- it was never invoked", async () => {
    const { invoker } = sequenceInvoker([
      { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } },
      { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
    ]);
    const { lifecycle, events } = recordingLifecycle();
    await runHooks(
      "PreToolUse",
      { toolName: "Bash", input: {} },
      ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse"), entry("h2", "PreToolUse")]), invoker, lifecycle }),
    );
    // h1 (the deny) fires started+response; h2 (skipped) fires NEITHER.
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.hookId === "h1")).toBe(true);
  });

  test("omitted lifecycle sink is a complete no-op -- runHooks behaves identically with or without one", async () => {
    const { invoker } = fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: {} }, ctxWith({ registry: fakeRegistry([entry("h1", "PreToolUse")]), invoker }));
    expect(composite.decision).toBe("allow"); // no throw, no behavior change from the absent sink
  });
});
