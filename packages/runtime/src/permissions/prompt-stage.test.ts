// Task 8 (WS-07 §7): the REAL PromptStage — bridges evaluate()'s stage-6 seam to a runtime-
// originated "permission" control_request over rpc/bridge.ts's RpcBridge, with NO park timeout
// (WS-04 §3's own row for this subtype). Unit-tested here against a FAKE RpcBridge (no real
// process/transport involved — that end-to-end proof lives in transport-equivalence.test.ts and
// query.test.ts's real-engine integration tests); this file's job is purely "does createBridge
// PromptStage build the right payload and map the right result," independent of the wire.
import { test, expect } from "bun:test";
import type { PermissionResult, PermissionRequestPayload, PermissionUpdate } from "@yanlinglabs/winter-agent-sdk";
import { WinterRpcError } from "@yanlinglabs/winter-agent-sdk";
import type { RpcBridge } from "../rpc/bridge.ts";
import { createBridgePromptStage } from "./prompt-stage.ts";
import type { PermissionCall, EvaluationContext, PromptStageMeta } from "./evaluator.ts";
import { NO_OPINION_HOOK_STAGE, NO_OPINION_PROMPT_STAGE, NO_OPINION_AUTO_ENGINE, NO_SPECIAL_CHECKS } from "./evaluator.ts";
import { emptyRuleSet } from "./ruleset.ts";
import type { PolicyState } from "./policy-state.ts";

function fakeBridge(impl: (subtype: string, payload: unknown, opts?: { timeoutMs?: number; requestId?: string }) => Promise<unknown>): {
  bridge: RpcBridge;
  calls: Array<{ subtype: string; payload: unknown; opts?: { timeoutMs?: number; requestId?: string } }>;
} {
  const calls: Array<{ subtype: string; payload: unknown; opts?: { timeoutMs?: number; requestId?: string } }> = [];
  return {
    calls,
    bridge: {
      request: (async (subtype: string, payload: unknown, opts?: { timeoutMs?: number; requestId?: string }) => {
        calls.push({ subtype, payload, ...(opts !== undefined ? { opts } : {}) });
        return impl(subtype, payload, opts);
      }) as RpcBridge["request"],
      ownsRequest: () => false,
    handleResponse: () => false,
      rejectAllPending: () => {},
      cancel: () => {},
    },
  };
}

function ctx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  const policy: PolicyState = { mode: "default", version: 3, rules: emptyRuleSet() };
  return {
    policy,
    cwd: "/work",
    sessionRoot: "/work",
    home: "/synthetic/home/tester",
    trustedWorkspace: false,
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: NO_OPINION_PROMPT_STAGE,
    autoEngine: NO_OPINION_AUTO_ENGINE,
    specialChecks: NO_SPECIAL_CHECKS,
    ...overrides,
  };
}

const baseCall: PermissionCall = { toolName: "Bash", input: { command: "rm -rf /tmp/x" }, toolUseId: "call-1" };
const baseMeta: PromptStageMeta = { decisionReason: "unmatched action reached the prompt stage" };

test("builds the full WS-07 §7.1 payload: toolName, input, decisionReason, toolUseID, policyVersion, NO timeout", async () => {
  const { bridge, calls } = fakeBridge(async () => ({ behavior: "allow" }) satisfies PermissionResult);
  const stage = createBridgePromptStage(bridge);
  await stage.prompt(baseCall, ctx(), baseMeta);

  expect(calls.length).toBe(1);
  expect(calls[0]!.subtype).toBe("permission");
  expect(calls[0]!.opts?.timeoutMs).toBeUndefined(); // WS-04 §3: no park timeout for this subtype
  const payload = calls[0]!.payload as PermissionRequestPayload;
  expect(payload.toolName).toBe("Bash");
  expect(payload.input).toEqual({ command: "rm -rf /tmp/x" });
  expect(payload.decisionReason).toBe("unmatched action reached the prompt stage");
  expect(payload.toolUseID).toBe("call-1");
  expect(payload.policyVersion).toBe(3);
  expect(payload.agentID).toBeUndefined();
  expect(payload.suggestions).toBeUndefined();
  expect(payload.blockedPath).toBeUndefined();
  expect(payload.matchedAskRule).toBeUndefined();
  expect(typeof payload.requestId).toBe("string");
  expect(payload.requestId.length).toBeGreaterThan(0);
  // Review-caught correlation bug: bridge.request() mints its OWN envelope requestId by default,
  // independent of anything in the payload. A canUseTool callback reads `opts.requestId` (the
  // payload's copy) and hands it straight to query.__internal.respondPermission for the
  // out-of-band escape — if the envelope used a DIFFERENT id, that out-of-band response would be
  // written under an id this bridge never issued and would be silently dropped, parking the
  // request forever (no timeout). createBridgePromptStage MUST force the envelope id to match.
  expect(calls[0]!.opts?.requestId).toBe(payload.requestId);
});

test("agentID/blockedPath thread through verbatim when present on the call/meta", async () => {
  const { bridge, calls } = fakeBridge(async () => ({ behavior: "deny", message: "no" }) satisfies PermissionResult);
  const stage = createBridgePromptStage(bridge);
  await stage.prompt(
    { ...baseCall, agentId: "agent-9" },
    ctx(),
    { ...baseMeta, blockedPath: "/work/.git/config" },
  );
  const payload = calls[0]!.payload as PermissionRequestPayload;
  expect(payload.agentID).toBe("agent-9");
  expect(payload.blockedPath).toBe("/work/.git/config");
});

test("a matched ask rule yields BOTH matchedAskRule verbatim AND an addRules suggestion shape", async () => {
  const { bridge, calls } = fakeBridge(async () => ({ behavior: "deny", message: "no" }) satisfies PermissionResult);
  const stage = createBridgePromptStage(bridge);
  await stage.prompt(baseCall, ctx(), {
    ...baseMeta,
    matchedAskRule: { source: "sdk", toolName: "Bash", ruleContent: "rm *" },
  });
  const payload = calls[0]!.payload as PermissionRequestPayload;
  expect(payload.matchedAskRule).toEqual({ source: "sdk", toolName: "Bash", ruleContent: "rm *" });
  expect(payload.suggestions).toEqual([
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm *" }], behavior: "allow", destination: "session" },
  ]);
});

test("a matched ask rule with NO ruleContent (a bare tool ask rule) omits ruleContent from the suggestion too", async () => {
  const { bridge, calls } = fakeBridge(async () => ({ behavior: "deny", message: "no" }) satisfies PermissionResult);
  const stage = createBridgePromptStage(bridge);
  await stage.prompt(
    { toolName: "AskUserQuestion", input: {}, toolUseId: "call-2" },
    ctx(),
    { ...baseMeta, matchedAskRule: { source: "sdk", toolName: "AskUserQuestion" } },
  );
  const payload = calls[0]!.payload as PermissionRequestPayload;
  expect(payload.suggestions).toEqual([{ type: "addRules", rules: [{ toolName: "AskUserQuestion" }], behavior: "allow", destination: "session" }]);
});

test("an allow PermissionResult maps to an allow PromptDecision: updatedInput -> transformedInput, verbatim updatedPermissions/decisionClassification", async () => {
  const updatedPermissions: PermissionUpdate[] = [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf /tmp/x" }], behavior: "allow", destination: "session" },
  ];
  const allowResult: PermissionResult = {
    behavior: "allow",
    updatedInput: { command: "rm -rf /tmp/x --safe" },
    updatedPermissions,
    decisionClassification: "user_temporary",
  };
  const { bridge } = fakeBridge(async () => allowResult);
  const stage = createBridgePromptStage(bridge);
  const decision = await stage.prompt(baseCall, ctx(), baseMeta);
  expect(decision).toEqual({
    decision: "allow",
    transformedInput: { command: "rm -rf /tmp/x --safe" },
    updatedPermissions,
    decisionClassification: "user_temporary",
  });
});

test("an allow PermissionResult with no updatedInput/updatedPermissions/decisionClassification maps to a bare allow (no stray undefined-valued keys)", async () => {
  const { bridge } = fakeBridge(async () => ({ behavior: "allow" }) satisfies PermissionResult);
  const stage = createBridgePromptStage(bridge);
  const decision = await stage.prompt(baseCall, ctx(), baseMeta);
  expect(decision).toEqual({ decision: "allow" });
  expect(decision).not.toHaveProperty("transformedInput");
  expect(decision).not.toHaveProperty("updatedPermissions");
});

test("a deny PermissionResult maps to a deny PromptDecision: message/interrupt/decisionClassification verbatim", async () => {
  const denyResult: PermissionResult = { behavior: "deny", message: "no thanks", interrupt: true, decisionClassification: "user_reject" };
  const { bridge } = fakeBridge(async () => denyResult);
  const stage = createBridgePromptStage(bridge);
  const decision = await stage.prompt(baseCall, ctx(), baseMeta);
  expect(decision).toEqual({ decision: "deny", message: "no thanks", interrupt: true, decisionClassification: "user_reject" });
});

test("a rejected bridge request (e.g. no host handler registered) resolves to null — genuinely no opinion, never a throw", async () => {
  const { bridge } = fakeBridge(async () => {
    throw new WinterRpcError("unhandled_subtype", "no handler registered for control subtype 'permission'");
  });
  const stage = createBridgePromptStage(bridge);
  const decision = await stage.prompt(baseCall, ctx(), baseMeta);
  expect(decision).toBeNull();
});

test("a rejected bridge request for ANY reason resolves to null, not just unhandled_subtype", async () => {
  const { bridge } = fakeBridge(async () => {
    throw new Error("connection closed");
  });
  const stage = createBridgePromptStage(bridge);
  const decision = await stage.prompt(baseCall, ctx(), baseMeta);
  expect(decision).toBeNull();
});

test("a RESOLVED but malformed answer (wrong shape crossed the wire) resolves to null — fails closed, never throws", async () => {
  const { bridge } = fakeBridge(async () => ({ nonsense: true }));
  const stage = createBridgePromptStage(bridge);
  const decision = await stage.prompt(baseCall, ctx(), baseMeta);
  expect(decision).toBeNull();
});

test("a RESOLVED deny with a non-string message resolves to null — fails closed, never throws", async () => {
  const { bridge } = fakeBridge(async () => ({ behavior: "deny", message: 42 }));
  const stage = createBridgePromptStage(bridge);
  const decision = await stage.prompt(baseCall, ctx(), baseMeta);
  expect(decision).toBeNull();
});
