// Task 9 (WS-08 §3, §5, §7, §8, §10; P2-A audit recording): the async hook-invocation loop.
// `runHooks` is the ONE entry point: given an event + call info, it (1) asks the registry for the
// merged-order, matcher-filtered participant list (WS-08 §2), (2) invokes each in order through the
// injected `HookInvoker` seam — DIRECT in-process callbacks/test doubles at T9; T10 swaps in a
// bridge-backed implementation (control-RPC `hook` subtype) without touching anything else in this
// file, because the seam's shape is exactly the §10 request/response contract — (3) interprets each
// raw response into a `HookOutcome` per event and the §8 failure matrix, (4) records an audit entry
// per invocation (P2-A) via the injected `HookAuditRecorder` seam, and (5) folds everything through
// reducer.ts's pure `reduceHookOutcomes`.
//
// INVOCATION-TIME vs. COMPOSITE TRANSFORM CHAIN (see reducer.ts's own header for the full
// rationale): WS-08 §4 rule 3's first sentence — "each hook sees the previous hook's transformed
// value" — is THIS file's responsibility, not the reducer's. `currentInput` below advances
// optimistically, forward, as each hook runs, regardless of whether that hook's own decision will
// later be excluded from the reducer's RETROSPECTIVE composite (which needs the final winning rank
// before it can decide what survives). This split means a hook can genuinely be INVOKED with an
// input that differs from what the composite ultimately reports — an inherent consequence of WS-08's
// own rule, not a bug (see the task report's Concerns for the corner case this produces: a
// sanitizing hook's transform can be excluded from the final composite if a LATER hook's decision
// outranks it, even though a still-later hook already evaluated against the sanitized value).
//
// A SECOND, UNMODELED ASYNC MECHANISM (derived-shapes-p2.md Open Question 3): `{async: true,
// asyncTimeout?}` is a top-level alternative to every synchronous hook output, distinct from
// `permissionDecision: "defer"`. This runner treats it as a `{kind:"none"}` contribution (ran, no
// synchronous opinion) — it does NOT wait up to `asyncTimeout` for a later answer. Flagged as an
// open item in the task report; not resolved here.
//
// WS-23 additions, each at the one place it belongs:
//   - FAIL CLOSED (`SourcedHookEntry.failClosed`, `failClosedDenial` below): opt-in per hook, default
//     off. On PreToolUse/PermissionRequest an error, timeout or malformed output from such a hook is a
//     DENY naming the hook -- the posture a security floor needs -- instead of contributing nothing.
//   - AN INVALID `updatedInput` IS A DENY for every hook (was: the hook's contract error, and the
//     ORIGINAL input ran). A hook that rewrites a call is usually narrowing it (a floor adding
//     `blocked_domains`, a sanitiser); silently running the un-narrowed original because the rewrite
//     failed a schema check is the fail-open direction. claude 2.1.282 falls back to the original
//     input here; Winter deliberately does not.
//   - The envelope fields (`continue`/`stopReason`, `systemMessage`, `suppressOutput`) and the
//     `decision: "block"` of UserPromptSubmit/Stop/SubagentStop/PostToolUse now have readers
//     (`applyEnvelope`, the dedicated interpreters below) instead of falling through to "no opinion".
import { randomUUID } from "node:crypto";
import type { HookEvent, HookPermissionDecision, PermissionUpdate } from "@yanlinglabs/winter-agent-sdk";
import { MATCHER_SUBJECT_FIELD, type HookRegistry, type SourcedHookEntry } from "./registry.ts";
import { reduceHookOutcomes, type HookComposite, type HookOutcome, type HookOutcomeEntry } from "./reducer.ts";
import { capHookText } from "./bounds.ts";

// --- HookInvoker — the T10 swap point (WS-08 §10, verbatim request shape) -------------------------

// `policyVersion` is a STRING here (WS-08 §10's own pinned field) even though Winter's internal
// PolicyState.version is a `number` (policy-state.ts) — callers convert with `String(...)`; this is
// the one place that conversion happens (buildRequest below), so it never needs re-deriving.
//
// `hookId`/`hookName` (T10): the ONE addition beyond WS-08 §10's own pinned semantic contract — not
// a divergence from it (that contract is scoped to "what a filesystem hook SCRIPT reads on stdin,"
// where there is never any ambiguity about which script is running, since Winter itself spawned that
// one process). A bridge-backed SDK-callback invoker (bridge-invoker.ts) has no such luxury: many
// `HookCallback` functions can share one process, and this is the field the wrapper's "hook" handler
// uses to route an inbound request back to the exact one to call — protocol/config.ts's own
// `RuntimeHookMatcherGroup` header already anticipates this positional identity
// (`${event}:${source}:${groupIndex}:${hookIndex}`), deterministic on both sides of the wire without
// exchanging anything at config time; this is simply where that identity gets attached to the
// per-invocation request that actually needs it. `hookId` is always present (every SourcedHookEntry
// has a non-optional `.id`); `hookName` mirrors the audit record's own optional field exactly.
//
// §10 REDACTION (WS-08 §10: "opaque provider blobs (encrypted_content / reasoning-item payloads)
// are excluded from every hook payload — their only sink is the transcript store"). Structurally
// true by construction at P2, not by an explicit filter here: `input`/`payload` above are built
// exclusively from `PermissionCall.input` (tool-call input, engine.ts's own plain-object coercion)
// and small literal shapes this runner's callers construct by hand (e.g. `{prompt}`, `{tool_response}`,
// `{error}`, `{reason}` — see engine.ts's own fireObservationalHook call sites). Winter's
// ProviderTurn/ProviderMessage types (engine.ts) carry NO encrypted_content/reasoning_item field at
// all at this phase — that surface belongs to a later provider-integration phase (WS-13-adjacent) —
// so there is nothing of that shape for any code path here to accidentally forward. This comment is
// the structural assertion the task instructions ask for, not a runtime check: the day a future
// phase's ProviderMessage grows such a field, whoever wires it into a hook payload must re-derive
// this guarantee rather than assume this comment still holds.
export interface HookInvocationRequest {
  event: HookEvent;
  matchedMatcher?: string;
  sessionId: string;
  agentID?: string;
  toolUseID?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  payload?: unknown;
  policyVersion: string;
  requestId: string;
  hookId: string;
  hookName?: string;
}

// The pinned HookCallback signature (derived-shapes item (a)) takes `{signal: AbortSignal}` as its
// third argument — this seam mirrors that exactly so a real SDK-callback invoker (T10) and this
// runner's own timeout enforcement compose correctly: the runner always races the invoker's promise
// against its own timer AND aborts the shared signal on timeout, regardless of whether the eventual
// real callback honors abort (a backstop, not a trust assumption).
export interface HookInvoker {
  invoke(request: HookInvocationRequest, opts: { signal: AbortSignal }): Promise<unknown>;
}

// --- HookAuditRecorder — the P2-A audit seam (WS-08 §9's Amended text) -----------------------------
//
// Per invocation: {hook_id, hook_name, hook_event, session_id, uuid, toolUseID?, requestId?,
// fine-grained outcome (decision/none/error/timeout/skipped), duration}. T10 routes this to the
// journal/audit stream; this runner only guarantees the data is faithfully recorded, once per
// participant, for every event this phase's engine fires (including `skipped` participants, which
// are recorded WITHOUT ever being invoked — WS-08 §4 rule 2's own short-circuit clause).
export type HookAuditOutcome = "decision" | "none" | "error" | "timeout" | "skipped";

export interface HookAuditRecord {
  hookId: string;
  hookName?: string;
  hookEvent: HookEvent;
  sessionId: string;
  uuid: string;
  toolUseID?: string;
  requestId?: string;
  outcome: HookAuditOutcome;
  decision?: HookPermissionDecision;
  durationMs?: number;
  // Finding 11 (P2 fix-wave, NIT): the invocation request already carries `agentID` (this file's
  // own HookInvocationRequest) and WS-08 §11 makes it the child-call correlator — the audit record
  // itself carried no such field, so P4's subagent audit rows would have been unattributable without
  // this. Sourced from RunHooksContext.agentID (buildAuditRecord below) — the SAME value every
  // participant's own request in this one runHooks() call already receives.
  agentID?: string;
}

export interface HookAuditRecorder {
  record(entry: HookAuditRecord): void | Promise<void>;
}

// --- ToolInputValidator — the P3 schema-validation seam (WS-07 §10.6-2 / WS-08 §3) -----------------
//
// "A transformed input MUST still validate against the tool's input schema." The engine now passes a
// real validator backed by the tool registry's own `inputSchema` (hooks/input-validator.ts, WS-23);
// NO_SCHEMAS_YET_VALIDATOR stays the default for a caller that supplies none (tests, and any runner
// use outside the engine). WS-23 CHANGED WHAT A FAILURE MEANS: it used to be the hook's contract
// error with the ORIGINAL input proceeding; it is now a DENY with a reason (see this file's header).
export interface ToolInputValidator {
  validate(toolName: string, input: Record<string, unknown>): { valid: true } | { valid: false; reason?: string };
}

export const NO_SCHEMAS_YET_VALIDATOR: ToolInputValidator = {
  validate(): { valid: true } {
    return { valid: true };
  },
};

// --- Per-hook timeout (WS-08 §8 / open Q2: "60s gating / 30s observational" proposed defaults,
// config-plumbed, hot-swappable) -----------------------------------------------------------------

export interface HookTimeoutConfig {
  gatingTimeoutMs?: number;
  observationalTimeoutMs?: number;
}

export const DEFAULT_GATING_TIMEOUT_MS = 60_000;
export const DEFAULT_OBSERVATIONAL_TIMEOUT_MS = 30_000;

// WS-08 §8's own failure-matrix row grouping, verbatim: gating = PreToolUse/PermissionRequest/
// UserPromptSubmit/Stop/PreCompact; everything else (PostToolUse family, Notification, SessionStart/
// End, and every other lifecycle event) is observational. Exported so a caller/fixture can assert
// against the exact set without re-deriving it.
export const GATING_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set(["PreToolUse", "PermissionRequest", "UserPromptSubmit", "Stop", "PreCompact"]);

export function isGatingHookEvent(event: HookEvent): boolean {
  return GATING_HOOK_EVENTS.has(event);
}

// WS-08 §7: "Defer is valid for PreToolUse and PermissionRequest; for events that cannot suspend a
// turn... a defer return is a hook contract error." PermissionRequest is T10's own firing
// responsibility, but the check lives here (shared/general) so T10 inherits it for free rather than
// re-deriving it.
//
// SCOPE NOTE (T10, closing the T9 reviewer's own "misleading until the interpreter exists" flag on
// this set's PermissionRequest membership): this set governs ONLY `hasInvalidDefer`'s universal
// check below, which reads the flat `permissionDecision` field -- PreToolUse's shape, not
// PermissionRequest's. PermissionRequest doesn't have a `permissionDecision` field at all (its
// pinned shape is `hookSpecificOutput.decision.behavior`), so this set's practical effect for
// PermissionRequest is narrow: it merely EXEMPTS that event from a flat-field check that could never
// fire true for it on its own real shape anyway. PermissionRequest's actual, stricter defer-rejection
// -- §7's prose notwithstanding -- lives entirely in `interpretPermissionRequest`'s own T9-CARRY-3
// reconciliation below (any `decision.behavior` other than "allow"/"deny", including "defer", is that
// hook's own §8 error). Net effect, documented rather than silently left as an exercise for the next
// reader: a hook that smuggles the WRONG field name -- `permissionDecision: "defer"` instead of
// `decision: { behavior: "defer" }` -- onto a PermissionRequest output is caught by NEITHER check
// (hasInvalidDefer ignores it because this set exempts the event; interpretPermissionRequest ignores
// it because it only ever reads `decision`, never `permissionDecision`) and resolves to a silent
// `{kind:"none"}`, identical to every other interpreter's own absent-field posture. Chosen, not
// missed: consistent with this runner's general lenient-on-absent/strict-on-malformed-present split,
// and no narrower than PreToolUse's own interpreter, which is equally silent on a field it doesn't
// recognize under a name it doesn't expect.
const DEFER_CAPABLE_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set(["PreToolUse", "PermissionRequest"]);

// --- runHooks -----------------------------------------------------------------------------------

export interface RunHooksCallInfo {
  toolUseID?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  payload?: unknown;
}

// --- HookLifecycleSink — the T10 public-lifecycle-stream seam (WS-08 §9, P2-A-pinned public shape) -
//
// Optional: WHETHER a sink exists at all is the caller's own `includeHookEvents` decision (engine.ts
// builds one unconditionally and gates emission INSIDE it, per that file's own comment — the
// SessionStart/Setup unconditional-emission exception from derived-shapes-p2.md item (d) needs to
// see every invocation regardless of the flag, so the gate can't live at the call-site level here).
// Fires ONLY for hooks that are actually INVOKED — never for a `skipped` short-circuited participant
// (WS-08 §9's own "hook_started -> ... -> hook_response" wording describes one real invocation's
// lifecycle; a skipped hook never started at all). The audit stream (HookAuditRecorder) still
// records skipped participants regardless, per its own unconditional "every participant" contract —
// the two seams are deliberately NOT symmetric in this one respect.
export interface HookLifecycleSink {
  started(info: { hookId: string; hookName?: string; hookEvent: HookEvent; sessionId: string }): void;
  // WS-23: `stdout`/`stderr`/`exitCode` are a COMMAND hook's own process output (HOOK_PROCESS_OUTPUT
  // below), absent for a callback hook. `stdout` is already blanked when the hook asked for
  // `suppressOutput` -- the one place that field has a meaning in Winter (the host-visible frame).
  response(info: {
    hookId: string;
    hookName?: string;
    hookEvent: HookEvent;
    sessionId: string;
    outcome: "success" | "error" | "cancelled";
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }): void;
}

/**
 * WS-23: the side channel a command hook's own process output rides from the invoker to the lifecycle
 * sink. A SYMBOL-keyed, non-enumerable property on the output object the invoker returns: invisible to
 * every interpreter (which read string keys) and to `JSON.stringify`, so no hook output shape changes.
 * Only a command invoker ever sets it; a callback hook has no process and no stdout.
 */
export const HOOK_PROCESS_OUTPUT: unique symbol = Symbol("winter.hookProcessOutput");
export interface HookProcessOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function processOutputOf(value: unknown): HookProcessOutput | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const carried = (value as { [HOOK_PROCESS_OUTPUT]?: unknown })[HOOK_PROCESS_OUTPUT];
  return typeof carried === "object" && carried !== null ? (carried as HookProcessOutput) : undefined;
}

// WS-08 §9 Open Question 2 (derived-shapes-p2.md): the pinned `outcome` enum (success/error/
// cancelled) is coarser than this runner's own fine-grained HookAuditOutcome (decision/none/error/
// timeout/skipped). This mapping is a DOCUMENTED, NOT spec-resolving, judgment call for what IS
// reachable through a real invocation: decision/none both genuinely "succeeded" (the hook ran to
// completion, with or without an opinion) -> "success"; error/timeout both -> "error" (Open
// Question 2's own speculation: "presumably folded into 'error'?"). "cancelled" has no reachable
// producer at P2 (no mechanism here distinguishes a genuinely aborted invocation from a timed-out
// one) — never emitted, not resolved, exactly like the spec's own open question stays open.
// "skipped" never reaches this function at all (see HookLifecycleSink's own header).
function publicLifecycleOutcomeOf(kind: "decision" | "none" | "error" | "timeout"): "success" | "error" | "cancelled" {
  return kind === "decision" || kind === "none" ? "success" : "error";
}

export interface RunHooksContext {
  registry: HookRegistry;
  invoker: HookInvoker;
  audit: HookAuditRecorder;
  sessionId: string;
  policyVersion: string | number;
  agentID?: string;
  timeouts?: HookTimeoutConfig;
  validator?: ToolInputValidator;
  lifecycle?: HookLifecycleSink;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

type ClassifiedOutput = { kind: "malformed" } | { kind: "async" } | { kind: "sync"; value: Record<string, unknown> };

function classifyRawOutput(raw: unknown): ClassifiedOutput {
  if (!isObject(raw)) return { kind: "malformed" };
  if ((raw as { async?: unknown }).async === true) return { kind: "async" };
  return { kind: "sync", value: raw };
}

function hookSpecificOutputOf(sync: Record<string, unknown>): Record<string, unknown> | undefined {
  const hso = sync["hookSpecificOutput"];
  return isObject(hso) ? hso : undefined;
}

// §7's contract-error check, applied UNIVERSALLY (any event) rather than only inside the PreToolUse
// interpreter — a hook is host code and can return whatever bytes it wants regardless of which
// event's shape it was actually invoked for; this defensively catches a `permissionDecision:"defer"`
// value appearing anywhere it structurally shouldn't. PreToolUse itself is exempted (defer-capable).
function hasInvalidDefer(hso: Record<string, unknown> | undefined, event: HookEvent): boolean {
  if (hso === undefined) return false;
  return hso["permissionDecision"] === "defer" && !DEFER_CAPABLE_HOOK_EVENTS.has(event);
}

const VALID_PERMISSION_DECISIONS: ReadonlySet<string> = new Set(["allow", "ask", "deny", "defer"]);

// PreToolUse (WS-08 §3, derived-shapes item (b)): decision-capable, transform-capable, context-
// capable. Task 11 (WS-08 §7): a raw `defer` now flows through UNRESOLVED — it is a real, distinct
// HookOutcome decision, exactly like allow/ask/deny, all the way to the reducer and beyond
// (hook-stage.ts's own adapter, evaluator.ts's stage 1). Durable-approval parking is engine.ts's
// job once evaluate() reports "defer"; this function's only remaining responsibility for the value
// is the malformed-shape/invalid-defer checks already above/below it (unchanged).
function interpretPreToolUse(sync: Record<string, unknown>, opts: { validator: ToolInputValidator; toolName: string; hookLabel: string; originalInput?: Record<string, unknown> }): HookOutcome {
  const hso = hookSpecificOutputOf(sync);
  const pre = hso !== undefined && hso["hookEventName"] === "PreToolUse" ? hso : undefined;

  const rawDecision = pre?.["permissionDecision"];
  if (rawDecision !== undefined && (typeof rawDecision !== "string" || !VALID_PERMISSION_DECISIONS.has(rawDecision))) {
    return { kind: "error", reason: `malformed permissionDecision: ${JSON.stringify(rawDecision)}` };
  }
  const decision = rawDecision as HookPermissionDecision | undefined;

  const rawUpdatedInput = pre?.["updatedInput"];
  let transformedInput: Record<string, unknown> | undefined;
  if (rawUpdatedInput !== undefined) {
    if (!isObject(rawUpdatedInput)) return { kind: "error", reason: "updatedInput is not an object" };
    const check = opts.validator.validate(opts.toolName, rawUpdatedInput);
    if (!check.valid) {
      // WS-23 (was WS-07 §10.6-2's "the ORIGINAL input proceeds"): a DENY naming the hook. See this
      // file's header for why running the un-rewritten original is the wrong direction. The denial
      // carries no transform, so nothing of the invalid input reaches an executor either way.
      //
      // Fix round 1 (M1): ONLY when the original was itself valid. A rewrite that merely carried the
      // MODEL's own mistake along (the daemon's WebSearch floor copies `query` verbatim, so a
      // `{query: "x"}` stays one character short) is not the hook's failure: the transform is dropped
      // and the call runs with the original, so the tool reports its own error to the model instead
      // of a policy denial it cannot act on.
      if (!originalIsValid(opts)) return withoutTransform(sync, pre, opts);
      return { kind: "decision", decision: "deny", message: invalidUpdatedInputMessage(opts.hookLabel, opts.toolName, check.reason) };
    }
    transformedInput = rawUpdatedInput;
  }

  const extraContext = typeof pre?.["additionalContext"] === "string" ? (pre["additionalContext"] as string) : undefined;
  const message = typeof pre?.["permissionDecisionReason"] === "string" ? (pre["permissionDecisionReason"] as string) : undefined;

  if (decision === undefined) {
    // Finding 2 (P2 fix-wave, IMPORTANT): the pinned `SyncHookJSONOutput.decision?: "approve" |
    // "block"` top-level channel — the classic pre-hookSpecificOutput legacy API, still a typed
    // member of the envelope every event shares (sdk/src/permissions/types.ts). `permissionDecision`
    // (above) wins when both are present — this branch is reached ONLY on its absence, so there is
    // no runtime conflict to resolve, just a fallback.
    //
    // Capture-verified, not assumed (P2 fix-wave capture check — a RUN_OFFICIAL_CAPTURE loopback
    // probe against the pinned 0.3.250 release, results in the fix-wave report): a PreToolUse hook
    // returning `{decision:"block", reason:"…"}` with NO hookSpecificOutput at all IS honored by the
    // official runtime — the tool never executes, its tool_result carries the hook's own `reason`
    // string verbatim (tagged `non_execution_kind:"permission-rule"` on the wire), and the denial
    // lands in `result.permission_denials` (Finding 3's own ledger — the SAME capture independently
    // confirmed that array's 3-field shape). Pre-fix, Winter's silence here resolved this exact
    // input toward permission (a well-formed, typed, present field whose absent reader compiles
    // clean and executes the call) — the phase's signature fail-open shape, now closed.
    //
    // Distinct from interpretGeneric's own exhaustiveness guard (a SEPARATE fix-wave item covering
    // FUTURE decision-capable events falling through to the generic interpreter, never wired here):
    // this is a pinned envelope field on an event that already has its own dedicated interpreter.
    const rawLegacyDecision = sync["decision"];
    if (rawLegacyDecision !== undefined) {
      if (rawLegacyDecision !== "approve" && rawLegacyDecision !== "block") {
        return { kind: "error", reason: `malformed top-level decision: ${JSON.stringify(rawLegacyDecision)}` };
      }
      const legacyMessage = typeof sync["reason"] === "string" ? sync["reason"] : undefined;
      return {
        kind: "decision",
        decision: rawLegacyDecision === "block" ? "deny" : "allow",
        ...(transformedInput !== undefined ? { transformedInput } : {}),
        ...(extraContext !== undefined ? { extraContext } : {}),
        ...(legacyMessage !== undefined ? { message: legacyMessage } : {}),
      };
    }
    return { kind: "none", ...(transformedInput !== undefined ? { transformedInput } : {}), ...(extraContext !== undefined ? { extraContext } : {}) };
  }
  return {
    kind: "decision",
    decision,
    ...(transformedInput !== undefined ? { transformedInput } : {}),
    ...(extraContext !== undefined ? { extraContext } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

function originalIsValid(opts: { validator: ToolInputValidator; toolName?: string; originalInput?: Record<string, unknown> }): boolean {
  return opts.originalInput === undefined || opts.validator.validate(opts.toolName ?? "", opts.originalInput).valid;
}

// M1's "run with the original": the SAME output re-read with its `updatedInput` removed, so the hook's
// decision, reason and context all still count -- only the rewrite (which would carry the model's own
// invalid input into a policy denial) is gone.
function withoutTransform(sync: Record<string, unknown>, pre: Record<string, unknown> | undefined, opts: { validator: ToolInputValidator; toolName: string; hookLabel: string }): HookOutcome {
  const { updatedInput: _dropped, ...rest } = pre ?? {};
  return interpretPreToolUse({ ...sync, hookSpecificOutput: rest }, opts);
}

// PostToolUse (WS-08 §5, derived-shapes item (b)): contribution-capable ONLY — structurally, this
// interpreter never returns `{kind:"decision"}`, because PostToolUse's pinned output shape has no
// decision-shaped field at all. This IS the "a PostToolUse hook can never un-run the tool" property,
// enforced by construction rather than by a runtime check (runner.test.ts pins it even against a
// hook that tries to smuggle a `permissionDecision` field in anyway).
function interpretPostToolUse(sync: Record<string, unknown>): HookOutcome {
  const hso = hookSpecificOutputOf(sync);
  const post = hso !== undefined && hso["hookEventName"] === "PostToolUse" ? hso : undefined;
  const transformedOutput = post?.["updatedToolOutput"] ?? post?.["updatedMCPToolOutput"];
  const extraContext = postToolFeedback(sync, post);
  const classifierContext = typeof post?.["classifierContext"] === "string" ? (post["classifierContext"] as string) : undefined;
  return {
    kind: "none",
    ...(transformedOutput !== undefined ? { transformedOutput } : {}),
    ...(extraContext !== undefined ? { extraContext } : {}),
    ...(classifierContext !== undefined ? { classifierContext } : {}),
  };
}

function interpretPostToolUseFailure(sync: Record<string, unknown>): HookOutcome {
  const hso = hookSpecificOutputOf(sync);
  const post = hso !== undefined && hso["hookEventName"] === "PostToolUseFailure" ? hso : undefined;
  const extraContext = postToolFeedback(sync, post);
  return { kind: "none", ...(extraContext !== undefined ? { extraContext } : {}) };
}

// WS-23: a post-tool hook's `decision: "block"` cannot un-run the tool (this interpreter still never
// returns a decision -- WS-08 §5's property holds), so the only thing it can mean is what claude
// documents for it: the reason goes to the MODEL. It rides the same channel as additionalContext,
// after it. This is also where a command hook's exit 2 lands (command-invoker.ts maps exit 2 to the
// legacy `{decision: "block", reason: <stderr>}` envelope), i.e. "stderr is shown to the model".
function postToolFeedback(sync: Record<string, unknown>, hso: Record<string, unknown> | undefined): string | undefined {
  const parts: string[] = [];
  if (typeof hso?.["additionalContext"] === "string" && hso["additionalContext"].length > 0) parts.push(hso["additionalContext"]);
  if (sync["decision"] === "block" && typeof sync["reason"] === "string" && sync["reason"].length > 0) parts.push(sync["reason"]);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// WS-23: UserPromptSubmit gains a real interpreter. `decision: "block"` drops the prompt (the engine
// never records it or sends it); the reason is what the HOST is shown. `additionalContext` is model
// context delivered with the prompt. Both ride as contributions, never a permission decision -- the
// strictness rank is a PreToolUse concept and this event has no call to allow or deny.
function interpretUserPromptSubmit(sync: Record<string, unknown>): HookOutcome {
  const hso = hookSpecificOutputOf(sync);
  const own = hso !== undefined && hso["hookEventName"] === "UserPromptSubmit" ? hso : undefined;
  const extraContext = typeof own?.["additionalContext"] === "string" ? (own["additionalContext"] as string) : undefined;
  const block = blockReasonOf(sync);
  if (block === "malformed") return { kind: "error", reason: `malformed top-level decision: ${JSON.stringify(sync["decision"])}` };
  return { kind: "none", ...(extraContext !== undefined ? { extraContext } : {}), ...(block !== undefined ? { blockReason: block } : {}) };
}

// WS-23: Stop and SubagentStop share one interpreter. `decision: "block"` KEEPS THE TURN GOING with
// the reason fed to the model (engine.ts's stop site, loop-guarded by `stop_hook_active` and a cap).
// `additionalContext` is claude 2.1.282's softer twin of the same thing ("non-error feedback delivered
// to the model; the conversation continues"), so it rides the same continuation.
function interpretStopLike(event: "Stop" | "SubagentStop"): HookInterpreterFn {
  return (sync) => {
    const hso = hookSpecificOutputOf(sync);
    const own = hso !== undefined && hso["hookEventName"] === event ? hso : undefined;
    const extraContext = typeof own?.["additionalContext"] === "string" ? (own["additionalContext"] as string) : undefined;
    const block = blockReasonOf(sync);
    if (block === "malformed") return { kind: "error", reason: `malformed top-level decision: ${JSON.stringify(sync["decision"])}` };
    return { kind: "none", ...(extraContext !== undefined ? { extraContext } : {}), ...(block !== undefined ? { blockReason: block } : {}) };
  };
}

// `decision: "block"` needs a reason to mean anything (a block with nothing to tell the model or the
// user is an instruction nobody can act on), so a reasonless block reads as a block with a generic
// one rather than as nothing. `approve` is the other legal value and says nothing on these events.
function blockReasonOf(sync: Record<string, unknown>): string | undefined | "malformed" {
  const decision = sync["decision"];
  if (decision === undefined || decision === "approve") return undefined;
  if (decision !== "block") return "malformed";
  const reason = sync["reason"];
  return typeof reason === "string" && reason.trim().length > 0 ? reason : "Blocked by hook";
}

// Every other event (UserPromptSubmit/Stop/SessionStart/SessionEnd/Notification and the 21 never
// fired at P2): declaration-owned, observational (WS-08 §1.3) — this runner forwards `additionalContext`
// losslessly (every one of these events' own pinned shape carries that one field) and invents no
// further semantics, per §1.3's own instruction ("Winter forwards those payloads losslessly and MUST
// NOT invent field-level semantics this spec does not state").
function interpretGeneric(sync: Record<string, unknown>): HookOutcome {
  const hso = hookSpecificOutputOf(sync);
  const extraContext = typeof hso?.["additionalContext"] === "string" ? (hso["additionalContext"] as string) : undefined;
  return { kind: "none", ...(extraContext !== undefined ? { extraContext } : {}) };
}

// PermissionRequest (T10, WS-08 §6): decision-capable with its OWN NARROWER pinned shape --
// `hookSpecificOutput.decision.{behavior:"allow"|"deny", ...}` -- structurally DIFFERENT from
// PreToolUse's flat `permissionDecision` field. REQUIRED as a dedicated interpreter: without one,
// this event falls through to interpretGeneric (reads only `additionalContext`, a field this shape
// doesn't even have) and every hook's real answer would silently resolve to {kind:"none"} -- no
// error, no audit distinction, a genuine under-enforcement bug caught by T9's own review before this
// task wired PermissionRequest at all (a hook that means to ANSWER would be silently ignored, and
// evaluate() would fall through to canUseTool as though no hook had opined).
function interpretPermissionRequest(sync: Record<string, unknown>, opts: { validator: ToolInputValidator; toolName?: string; hookLabel: string; originalInput?: Record<string, unknown> }): HookOutcome {
  const hso = hookSpecificOutputOf(sync);
  const pr = hso !== undefined && hso["hookEventName"] === "PermissionRequest" ? hso : undefined;
  // Mismatched/absent hookEventName -- "none", matching every other interpreter's own silent-none
  // posture for this case (PreToolUse/PostToolUse/PostToolUseFailure above all do the identical
  // `hso["hookEventName"] === "X" ? hso : undefined` gate).
  //
  // Item 8(d) (P2 fix-wave) pairing note: this "none" is NOT the same shape as registry.ts's own
  // malformed-matcher posture, though both are "inert" in the loose sense. A malformed TOOL matcher
  // (registry.ts's own matcherApplies) excludes the entry from `matching()`'s returned list
  // entirely -- the hook is never invoked at all, and carries NO audit record for this call, not
  // even "skipped" (runHooks never iterates over it). A mismatched hookEventName, by contrast, means
  // the hook WAS invoked (it passed the tool-matcher check and ran) and DOES get an audit record
  // (outcome:"none", via buildAuditRecord/runHooks) -- only its response's event-specific fields are
  // ignored. So: a malformed matcher is invisible to the audit trail by construction; a mismatched
  // hookEventName is audit-surfaced (the fact "this hook ran and said nothing usable" is always
  // preserved), even though neither one influences the composite decision.
  if (pr === undefined) return { kind: "none" };

  const rawDecision = pr["decision"];
  // ABSENT `decision` -- a pure observer, legitimate per WS-08 §3's own "(none) no opinion" (a hook
  // that wants to observe PermissionRequest without answering simply omits hookSpecificOutput's
  // `decision`, matching the pattern every other event uses for "no opinion"). PRESENT but not an
  // object is a different, stronger claim: the hook clearly TRIED to answer with a malformed shape
  // -- that hook's own §8 contract error, mirroring interpretPreToolUse's identical
  // present-but-wrong-type-is-an-error / absent-is-none split for `permissionDecision`.
  if (rawDecision === undefined) return { kind: "none" };
  if (!isObject(rawDecision)) return { kind: "error", reason: "PermissionRequest decision is not an object" };

  const behavior = rawDecision["behavior"];
  if (behavior === "allow") {
    const rawUpdatedInput = rawDecision["updatedInput"];
    let transformedInput: Record<string, unknown> | undefined;
    if (rawUpdatedInput !== undefined) {
      if (!isObject(rawUpdatedInput)) return { kind: "error", reason: "PermissionRequest decision.updatedInput is not an object" };
      // WS-23: the same schema gate PreToolUse's transform passes through, and the same answer on
      // failure -- a deny naming the hook, never the allow running an input nobody validated.
      const check = opts.validator.validate(opts.toolName ?? "", rawUpdatedInput);
      if (!check.valid) {
        // Fix round 1 (M1): as for PreToolUse -- deny only when the original was valid; otherwise the
        // allow stands on the ORIGINAL input and the tool reports the model's own mistake.
        if (originalIsValid(opts)) return { kind: "decision", decision: "deny", message: invalidUpdatedInputMessage(opts.hookLabel, opts.toolName ?? "", check.reason) };
      } else {
        transformedInput = rawUpdatedInput;
      }
    }
    const rawUpdatedPermissions = rawDecision["updatedPermissions"];
    let updatedPermissions: PermissionUpdate[] | undefined;
    if (rawUpdatedPermissions !== undefined) {
      if (!Array.isArray(rawUpdatedPermissions)) return { kind: "error", reason: "PermissionRequest decision.updatedPermissions is not an array" };
      updatedPermissions = rawUpdatedPermissions as PermissionUpdate[];
    }
    return {
      kind: "decision",
      decision: "allow",
      ...(transformedInput !== undefined ? { transformedInput } : {}),
      ...(updatedPermissions !== undefined ? { updatedPermissions } : {}),
    };
  }
  if (behavior === "deny") {
    const rawMessage = rawDecision["message"];
    const rawInterrupt = rawDecision["interrupt"];
    return {
      kind: "decision",
      decision: "deny",
      ...(typeof rawMessage === "string" ? { message: rawMessage } : {}),
      ...(typeof rawInterrupt === "boolean" ? { interrupt: rawInterrupt } : {}),
    };
  }
  // T9-CARRY 3 reconciliation (task-9-report.md Concern 3 / types.ts's own PermissionRequestHookSpecificOutput
  // comment): the PINNED PermissionRequestHookSpecificOutput (derived-shapes item (b)) has ONLY
  // "allow"/"deny" -- no "defer" arm -- despite WS-08 §7's prose ("Defer is valid for PreToolUse AND
  // PermissionRequest"). Per Ruling P2-A's own precedent (the pinned declaration amends spec prose
  // where the two disagree), an unrecognized `behavior` (including "defer", or "ask" -- this event's
  // pinned union has neither) is a MALFORMED output -- that hook's own §8 error, never silently an
  // allow, a deny, or a no-opinion. This is also WS-08 §11's own "answer authority" floor made
  // concrete: a hook cannot smuggle a decision shape this event's pinned contract doesn't recognize
  // and have it treated as legitimate input. PreToolUse's OWN separate ask/defer machinery (T10-CARRY
  // 1; runner.ts's own defer->ask resolution above) is untouched by this -- this is PermissionRequest's
  // narrower, independently-pinned surface, reconciled on its own terms.
  return { kind: "error", reason: `PermissionRequest decision.behavior is not "allow" or "deny": ${JSON.stringify(behavior)}` };
}

type HookInterpreterFn = (sync: Record<string, unknown>, opts: { validator: ToolInputValidator; toolName?: string; hookLabel: string; originalInput?: Record<string, unknown> }) => HookOutcome;

function invalidUpdatedInputMessage(hookLabel: string, toolName: string, reason: string | undefined): string {
  return `Denied: hook ${hookLabel} returned an updatedInput that does not match ${toolName.length > 0 ? `${toolName}'s` : "the tool's"} input schema (${reason ?? "schema validation failed"}), so the call was not run with it.`;
}

// Item 9 (P2 fix-wave): a structural exhaustiveness guard at the interpretGeneric boundary. Distinct
// from Finding 2 (a PINNED envelope field on an event — PreToolUse's legacy top-level `decision` —
// that already HAS a dedicated interpreter; that fix lives inside interpretPreToolUse itself, not
// here): this guards against a FUTURE event type gaining decision-capable (or otherwise
// specially-shaped) semantics with NO dedicated interpreter written for it at all, which would
// otherwise silently fall through to interpretGeneric (reads only `additionalContext`) — the
// identical fail-open shape, one dispatch layer up.
//
// This table IS the dispatch (interpretSyncOutput below just calls into it) — not a separate,
// independently-maintained `if` chain a future reader would have to remember to keep in sync. Being
// a full, non-partial `Record<HookEvent, HookInterpreterFn>` (checked via `satisfies`, mirroring the
// codebase's own subagent-transcript.ts precedent for SessionEvent variants) means adding a 32nd
// member to HOOK_EVENTS without ALSO adding a row here fails core's own `tsc` — a future author is
// FORCED to make a deliberate choice (a new dedicated interpreter, or an explicit `interpretGeneric`
// entry) rather than silently inheriting the fallback by omission. Every event not named
// individually below maps EXPLICITLY to `interpretGeneric`, recorded once, here — never an implicit
// "whatever's left" default.
const HOOK_EVENT_INTERPRETERS = {
  PreToolUse: (sync, opts) => interpretPreToolUse(sync, { validator: opts.validator, toolName: opts.toolName ?? "", hookLabel: opts.hookLabel, ...(opts.originalInput !== undefined ? { originalInput: opts.originalInput } : {}) }),
  PostToolUse: interpretPostToolUse,
  PostToolUseFailure: interpretPostToolUseFailure,
  PermissionRequest: interpretPermissionRequest,
  // WS-23: the block-capable lifecycle events get their own readers (see each).
  UserPromptSubmit: interpretUserPromptSubmit,
  Stop: interpretStopLike("Stop"),
  SubagentStop: interpretStopLike("SubagentStop"),
  // WS-08 §1.3: declaration-owned, observational -- forwards `additionalContext` losslessly and
  // invents no further semantics for every one of these (the 21 "typed but inert" events HOOK_EVENTS
  // also carries, plus the few that fire). SessionStart/SubagentStart's `additionalContext` now
  // REACHES the model (engine.ts, WS-23) -- through this same lossless forward, no new semantics here.
  SubagentStart: interpretGeneric,
  PreCompact: interpretGeneric,
  Notification: interpretGeneric,
  PostToolBatch: interpretGeneric,
  UserPromptExpansion: interpretGeneric,
  MessageDisplay: interpretGeneric,
  StopFailure: interpretGeneric,
  PostCompact: interpretGeneric,
  PermissionDenied: interpretGeneric,
  SessionStart: interpretGeneric,
  SessionEnd: interpretGeneric,
  Setup: interpretGeneric,
  TeammateIdle: interpretGeneric,
  TaskCreated: interpretGeneric,
  TaskCompleted: interpretGeneric,
  Elicitation: interpretGeneric,
  ElicitationResult: interpretGeneric,
  ConfigChange: interpretGeneric,
  InstructionsLoaded: interpretGeneric,
  WorktreeCreate: interpretGeneric,
  WorktreeRemove: interpretGeneric,
  CwdChanged: interpretGeneric,
  FileChanged: interpretGeneric,
  DirectoryAdded: interpretGeneric,
} satisfies Record<HookEvent, HookInterpreterFn>;

function interpretSyncOutput(event: HookEvent, sync: Record<string, unknown>, opts: { validator: ToolInputValidator; toolName?: string; hookLabel: string; originalInput?: Record<string, unknown> }): HookOutcome {
  if (hasInvalidDefer(hookSpecificOutputOf(sync), event)) {
    return { kind: "error", reason: `defer is invalid on ${event} (non-suspendable event, WS-08 §7)` };
  }
  return applyEnvelope(HOOK_EVENT_INTERPRETERS[event](sync, opts), sync);
}

// WS-23: the four SyncHookJSONOutput envelope fields every event shares, read ONCE here rather than
// in each interpreter (they mean the same thing on every event; what the ENGINE does with them is
// event-specific and lives at each firing site). Only a well-formed outcome carries them: an
// error/timeout contributes nothing, per the §8 failure matrix. Wrong-typed fields are ignored rather
// than turned into the hook's error -- none of them is a decision, and a hook that sends
// `systemMessage: 42` should not lose the permission answer it also sent.
//
// Fix round 1 (C1): also the ONE place every text contribution is BOUNDED (hooks/bounds.ts says why
// and how much) -- the interpreters above read the fields, this caps what they read, so no event's
// reader can forget. `transformedOutput` is capped where it becomes a tool result (engine.ts).
function applyEnvelope(outcome: HookOutcome, sync: Record<string, unknown>): HookOutcome {
  if (outcome.kind !== "decision" && outcome.kind !== "none") return outcome;
  const stopReason = typeof sync["stopReason"] === "string" && sync["stopReason"].length > 0 ? capHookText(sync["stopReason"]) : undefined;
  const systemMessage = typeof sync["systemMessage"] === "string" && sync["systemMessage"].length > 0 ? capHookText(sync["systemMessage"]) : undefined;
  return {
    ...outcome,
    ...(typeof outcome.extraContext === "string" ? { extraContext: capHookText(outcome.extraContext) } : {}),
    ...(outcome.classifierContext !== undefined ? { classifierContext: capHookText(outcome.classifierContext) } : {}),
    ...(outcome.blockReason !== undefined ? { blockReason: capHookText(outcome.blockReason) } : {}),
    ...(outcome.message !== undefined ? { message: capHookText(outcome.message) } : {}),
    ...(sync["continue"] === false ? { preventContinuation: true, ...(stopReason !== undefined ? { stopReason } : {}) } : {}),
    ...(systemMessage !== undefined ? { systemMessage } : {}),
    ...(sync["suppressOutput"] === true ? { suppressOutput: true } : {}),
  };
}

function mismatchedEventName(sync: Record<string, unknown>, event: HookEvent): boolean {
  const hso = hookSpecificOutputOf(sync);
  return hso !== undefined && hso["hookEventName"] !== event;
}

// WS-23: the events on which FAIL CLOSED means anything -- the two that decide whether a call runs.
// Every other event is observational (or, for Stop/UserPromptSubmit, blocks through an explicit
// `decision`, never through the absence of one), so a failing fail-closed hook there stays the
// ordinary non-blocking error.
export const FAIL_CLOSED_EVENTS: ReadonlySet<HookEvent> = new Set(["PreToolUse", "PermissionRequest"]);

function hookLabelOf(entry: SourcedHookEntry): string {
  return entry.name !== undefined && entry.name.length > 0 ? `"${entry.name}" (${entry.id})` : `"${entry.id}"`;
}

// Fix round 1 (M3): the denial names the hook and a failure CODE -- never the failure's own text. A
// host callback's error message and a command hook's error (which embeds the command line) are not
// ours to put in front of the model: they can carry paths, arguments, or whatever the thrower chose.
// The full reason stays on the audit/diagnostic side (`HookOutcome.reason`), where it always was.
function failClosedDenial(entry: SourcedHookEntry, event: HookEvent, failure: { kind: "error"; code?: string } | { kind: "timeout" }): HookOutcome {
  const code = failure.kind === "timeout" ? "timeout" : (failure.code ?? "hook_error");
  return { kind: "decision", decision: "deny", message: `Denied: the ${event} hook ${hookLabelOf(entry)} failed (${code}), and it is fail-closed, so the call was not allowed to proceed without its answer.` };
}

/** A machine-readable class for a rejected invocation: the RPC error's own code, a command hook's exit status, or `hook_error`. */
function failureCodeOf(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code;
    const exitCode = (err as { exitCode?: unknown }).exitCode;
    if (typeof exitCode === "number") return `exit_code_${exitCode}`;
    if (exitCode === null && (err as { name?: unknown }).name === "CommandHookError") return "terminated";
  }
  return "hook_error";
}

function buildRequest(entry: SourcedHookEntry, event: HookEvent, call: RunHooksCallInfo, ctx: RunHooksContext, currentInput: Record<string, unknown> | undefined): HookInvocationRequest {
  return {
    event,
    ...(entry.matcher !== undefined ? { matchedMatcher: entry.matcher } : {}),
    sessionId: ctx.sessionId,
    ...(ctx.agentID !== undefined ? { agentID: ctx.agentID } : {}),
    ...(call.toolUseID !== undefined ? { toolUseID: call.toolUseID } : {}),
    ...(call.toolName !== undefined ? { toolName: call.toolName } : {}),
    ...(currentInput !== undefined ? { input: currentInput } : {}),
    ...(call.payload !== undefined ? { payload: call.payload } : {}),
    policyVersion: String(ctx.policyVersion),
    requestId: randomUUID(),
    hookId: entry.id,
    ...(entry.name !== undefined ? { hookName: entry.name } : {}),
  };
}

type InvocationResult = { kind: "resolved"; value: unknown } | { kind: "rejected"; reason?: string; code: string; processOutput?: HookProcessOutput } | { kind: "timeout" };

// Races the invoker against a hard timer that ALWAYS resolves (never rejects) — the invoker's own
// promise is defensively `.catch()`-ed into a determinate value too, so this function itself never
// throws; a caller that ignores an eventual real answer arriving after the timeout does so safely
// (mirrors engine.ts's own raceInterrupt/rejectAllPending "abandoned promise" precedent). The signal
// is aborted on timeout regardless of whether the real invoker respects AbortSignal — a backstop,
// not a trust assumption (see HookInvoker's own header).
async function invokeWithTimeout(invoker: HookInvoker, request: HookInvocationRequest, timeoutMs: number): Promise<InvocationResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<InvocationResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
    timer.unref?.();
  });
  const invokePromise: Promise<InvocationResult> = invoker
    .invoke(request, { signal: controller.signal })
    .then((value): InvocationResult => ({ kind: "resolved", value }))
    // WS-23: the rejection's own message is kept -- a fail-closed denial names WHY the hook failed.
    // A command hook's failure also carries its process output (command-invoker.ts), for the
    // lifecycle frame.
    .catch((err: unknown): InvocationResult => {
      const reason = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
      const processOutput = processOutputOf(err);
      return { kind: "rejected", code: failureCodeOf(err), ...(reason !== undefined ? { reason } : {}), ...(processOutput !== undefined ? { processOutput } : {}) };
    });
  try {
    return await Promise.race([invokePromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function defaultTimeoutMsFor(event: HookEvent, entry: SourcedHookEntry, timeouts: HookTimeoutConfig | undefined): number {
  if (entry.timeoutMs !== undefined) return entry.timeoutMs; // per-hook override always wins (HookCallbackMatcher.timeout, already ms — see registry.ts)
  const gating = timeouts?.gatingTimeoutMs ?? DEFAULT_GATING_TIMEOUT_MS;
  const observational = timeouts?.observationalTimeoutMs ?? DEFAULT_OBSERVATIONAL_TIMEOUT_MS;
  return isGatingHookEvent(event) ? gating : observational;
}

function buildAuditRecord(entry: SourcedHookEntry, event: HookEvent, ctx: RunHooksContext, call: RunHooksCallInfo, fields: { outcome: HookAuditOutcome; decision?: HookPermissionDecision; requestId?: string; durationMs?: number }): HookAuditRecord {
  return {
    hookId: entry.id,
    ...(entry.name !== undefined ? { hookName: entry.name } : {}),
    hookEvent: event,
    sessionId: ctx.sessionId,
    uuid: randomUUID(),
    ...(call.toolUseID !== undefined ? { toolUseID: call.toolUseID } : {}),
    // Finding 11 (P2 fix-wave): the SAME agentID every participant's own HookInvocationRequest in
    // this runHooks() call already receives (buildRequest, above) — see HookAuditRecord's own comment.
    ...(ctx.agentID !== undefined ? { agentID: ctx.agentID } : {}),
    ...(fields.requestId !== undefined ? { requestId: fields.requestId } : {}),
    outcome: fields.outcome,
    ...(fields.decision !== undefined ? { decision: fields.decision } : {}),
    ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
  };
}

// WS-23: what a lifecycle event's matcher is tested against (registry.ts's MATCHER_SUBJECT_FIELD) --
// the named field of the payload the engine already passes, never a second channel.
function matcherSubjectOf(event: HookEvent, call: RunHooksCallInfo): string | undefined {
  if (call.toolName !== undefined) return call.toolName;
  const field = MATCHER_SUBJECT_FIELD[event];
  if (field === undefined || typeof call.payload !== "object" || call.payload === null) return undefined;
  const value = (call.payload as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

export async function runHooks(event: HookEvent, call: RunHooksCallInfo, ctx: RunHooksContext): Promise<HookComposite> {
  const matched = ctx.registry.matching(event, matcherSubjectOf(event, call));
  const validator = ctx.validator ?? NO_SCHEMAS_YET_VALIDATOR;
  const results: HookOutcomeEntry[] = [];
  let denied = false;
  // Invocation-time chaining (rule 3 sentence 1) -- see this file's own header for the split from
  // the reducer's retrospective discard.
  let currentInput = call.input;

  for (const entry of matched) {
    if (denied) {
      // WS-08 §4 rule 2: a committed deny short-circuits — never invoked, recorded `skipped`.
      results.push({ participant: entry, outcome: { kind: "skipped" } });
      await ctx.audit.record(buildAuditRecord(entry, event, ctx, call, { outcome: "skipped" }));
      continue;
    }

    const request = buildRequest(entry, event, call, ctx, currentInput);
    const timeoutMs = defaultTimeoutMsFor(event, entry, ctx.timeouts);
    // T10 (WS-08 §9): "hook_started" fires for every hook actually invoked (never a skipped one,
    // handled above) — BEFORE the invocation, so a slow/hanging hook shows up in-flight on the
    // public stream, not just retroactively once it settles.
    ctx.lifecycle?.started({ hookId: entry.id, ...(entry.name !== undefined ? { hookName: entry.name } : {}), hookEvent: event, sessionId: ctx.sessionId });
    const started = Date.now();
    const invocation = await invokeWithTimeout(ctx.invoker, request, timeoutMs);
    const durationMs = Date.now() - started;

    // Fix round 1 (I2): a fail-closed hook on a gating event is held to a STRICTER shape. Shapes
    // that are merely "no opinion" for an ordinary hook -- an `async` answer, a `hookSpecificOutput`
    // naming another event (so its deny is silently ignored), a command hook's non-JSON stdout
    // (command-invoker.ts refuses it for such a hook) -- are MALFORMED here: a security hook that
    // answers in a shape the runner cannot read has not answered. `{}` stays a valid allow: it is
    // exactly how a floor with nothing to object to answers.
    const strict = entry.failClosed === true && FAIL_CLOSED_EVENTS.has(event);
    let outcome: HookOutcome;
    if (invocation.kind === "timeout") {
      outcome = { kind: "timeout" };
    } else if (invocation.kind === "rejected") {
      outcome = { kind: "error", code: invocation.code, ...(invocation.reason !== undefined ? { reason: invocation.reason } : {}) };
    } else {
      const classified = classifyRawOutput(invocation.value);
      if (classified.kind === "malformed") outcome = { kind: "error", code: "malformed_output", reason: "malformed hook output" };
      else if (classified.kind === "async") outcome = strict ? { kind: "error", code: "malformed_output", reason: "async answer from a fail-closed gating hook" } : { kind: "none" }; // Open Question 3 -- see this file's own header
      else if (strict && mismatchedEventName(classified.value, event)) outcome = { kind: "error", code: "malformed_output", reason: "hookSpecificOutput names another event" };
      else {
        outcome = interpretSyncOutput(event, classified.value, {
          validator,
          ...(call.toolName !== undefined ? { toolName: call.toolName } : {}),
          hookLabel: hookLabelOf(entry),
          ...(call.input !== undefined ? { originalInput: call.input } : {}),
        });
        if (outcome.kind === "error" && outcome.code === undefined) outcome = { ...outcome, code: "malformed_output" };
      }
    }
    // The lifecycle frame reports what the hook actually DID -- an error stays an error there even
    // when fail-closed turns it into a deny below (the deny is the policy's answer, not the hook's).
    const lifecycleKind = outcome.kind === "decision" || outcome.kind === "none" || outcome.kind === "error" || outcome.kind === "timeout" ? outcome.kind : "error";
    // WS-23: FAIL CLOSED. Converted HERE, before the audit record and the reducer, so the deny is a
    // real decision everywhere downstream: it ranks, short-circuits every later hook (`denied` below),
    // and attributes to this hook (hook-stage.ts's winningHookId).
    if (entry.failClosed === true && FAIL_CLOSED_EVENTS.has(event) && (outcome.kind === "error" || outcome.kind === "timeout")) {
      outcome = failClosedDenial(entry, event, outcome);
    }
    const processOutput = invocation.kind === "resolved" ? processOutputOf(invocation.value) : invocation.kind === "rejected" ? invocation.processOutput : undefined;
    const suppressStdout = (outcome.kind === "decision" || outcome.kind === "none") && outcome.suppressOutput === true;

    if ((outcome.kind === "decision" || outcome.kind === "none") && outcome.transformedInput !== undefined) {
      currentInput = outcome.transformedInput; // invocation-time chain advances regardless of the reducer's later, retrospective decision
    }

    await ctx.audit.record(
      buildAuditRecord(entry, event, ctx, call, {
        outcome: outcome.kind,
        ...(outcome.kind === "decision" ? { decision: outcome.decision } : {}),
        requestId: request.requestId,
        durationMs,
      }),
    );
    // T10 (WS-08 §9): "hook_response" closes the row this hook's own "hook_started" opened, with
    // the P2-A-pinned coarse outcome (see publicLifecycleOutcomeOf's own header for the mapping).
    ctx.lifecycle?.response({
      hookId: entry.id,
      ...(entry.name !== undefined ? { hookName: entry.name } : {}),
      hookEvent: event,
      sessionId: ctx.sessionId,
      outcome: publicLifecycleOutcomeOf(lifecycleKind),
      ...(processOutput !== undefined
        ? { stdout: suppressStdout ? "" : processOutput.stdout, stderr: processOutput.stderr, ...(processOutput.exitCode !== null ? { exitCode: processOutput.exitCode } : {}) }
        : {}),
    });

    results.push({ participant: entry, outcome });
    if (outcome.kind === "decision" && outcome.decision === "deny") denied = true;
  }

  return reduceHookOutcomes(results);
}
