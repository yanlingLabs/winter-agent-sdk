// Task 6 (WS-07 §2/§5/§6.1/§6.3/§6.4): the six-stage permission evaluator.
//
// Stage order (WS-07 §2, exact): 1 PreToolUse hooks -> 2 deny rules -> 3 ask rules -> 4 permission
// mode -> 5 allow rules -> 6 canUseTool. Three seams are injected interfaces this task stubs to
// "no opinion" (HookStage: T9/T10 fill it with the real hooks reducer; PromptStage: T8 fills it with
// the real canUseTool RPC; AutoEngine: T12 fills it with the real classifier pipeline) plus a fourth,
// SpecialChecks, this task's own seam that T7 fills with protected-path/critical-removal
// recognition. `evaluate()` runs to completion with all four stubbed (NO_OPINION_HOOK_STAGE,
// NO_OPINION_PROMPT_STAGE, NO_OPINION_AUTO_ENGINE, NO_SPECIAL_CHECKS below).
//
// *** RULING P2-I — the spec-literal flip (SUPERSEDES the former T6 interim decision) ***
// T6 landed the PromptStage stub as GENUINELY no-opinion, but temporarily resolved a null answer at
// the generic bottom-of-pipeline fallback to ALLOW rather than WS-07 §6.1's literal "never
// implicitly allowed" — because at T6 time no real PromptStage existed anywhere yet, and denying by
// default would have flipped Phase 1's existing differential/equivalence goldens for no
// host-visible reason (that decision was advisor-reviewed, not controller-approved, and explicitly
// flagged for T8 to revisit once a real host was reachable). T8 wires the REAL PromptStage
// (bridge-backed canUseTool RPC — prompt-stage.ts) and, per Ruling P2-I, retires that interim
// allow: with a real prompt path reachable, "no applicable prompt handler" (no canUseTool
// configured host-side, or the runtime's own bridge request is rejected for any reason) now means
// exactly what WS-07 §6.1 says — unresolved, denied, never implicitly allowed. The affected
// differential/equivalence scenarios were fixed by adding explicit `allowedTools`/
// `permissions.allow` to their harness configs (see this task's report for the golden ledger),
// never by carving out a second spec exception.
//   - The PromptStage stays GENUINELY no-opinion on a null answer (the REAL implementation,
//     prompt-stage.ts, returns null when the bridge request is rejected — e.g. no handler
//     registered host-side; see that file's own header).
//   - The generic "nothing matched anything, mode is prompt-capable" fallback at the very bottom of
//     evaluate() now resolves a null PromptStage answer to DENY, mechanism "mode" — the identical
//     shape every other "mode"-mechanism denial in this file already has (a normal tool_result,
//     `denied: true`, per engine.ts's own cross-task pin), never a hang.
//   - The ask-rule-matched path (stage 3) already denied on null (a matched ask rule is a
//     RULE-FORCED request, WS-07 §7.1: "auto-approval logic must never silently clear a rule-forced
//     request") — unchanged by this ruling, since it was never the interim-allow branch.
//   - The standing-exception (critical-removal/protected-write/plan-write) "mustPrompt" null branch
//     was ALSO already deny-on-null (T7) — also unchanged by this ruling.
import { resolve } from "node:path";
import type { PermissionBehavior, PermissionMode, PermissionUpdate, RuleSource, PermissionDecisionClassification } from "@yanlinglabs/winter-agent-sdk";
import { FILE_RULE_TOOLS, matchesRule, splitCompound, isRecognizedReadOnly, type ParsedRule } from "./grammar.ts";
import { matchFileRuleAtBothEnds, checkSymlinkBothEnds } from "./paths.ts";
import type { SourcedRuleEntry, SourcedRuleSet } from "./ruleset.ts";
import { effectiveDirectories } from "./ruleset.ts";
import type { PolicyState, AutoModeConfig } from "./policy-state.ts";
// Task 7 (WS-07 §6.2/§6.7/§6.8): the two SpecialChecks-seam primitive modules. Renamed on import --
// their own exported names (`isProtectedWrite`/`isCriticalRemoval`) are identical to this module's
// SEAM method names (SpecialChecks.isProtectedWrite/.isCriticalRemoval) by design (the seam and the
// primitive answer "the same question," just at different granularity -- whole-call vs. bare
// path/command; see REAL_SPECIAL_CHECKS below for the adaptation).
// Task 8 (P3 close-out, RULING P3-E): `fileRulePathField` joins `recognizeEditOperation` in this
// import -- both this module's `extractCandidateWritePaths` and `matchesRuleForCall` consume it so
// neither can independently drift from edit-recognition.ts's own Read/Edit/Write/NotebookEdit path-
// field mapping (see that module's own header for why it lives there, not here).
import { recognizeEditOperation, fileRulePathField, shellCommandOf } from "./edit-recognition.ts";
import { isProtectedWrite as isProtectedPath, isCriticalRemoval as classifyCriticalRemoval, isWorkflowScriptCarveOut, isMemoryCarveOut, type ProtectedBrand } from "./protected.ts";
// P7a fix r1 (Important-2): the reading for an evaluation context that carries no brand -- every
// hand-built one in this package's tests, and a host driving the evaluator directly.
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
// Task 12 (WS-07 §10.1 step 2 / §6.5): the two auto/config.ts primitives evaluator.ts's own `auto`
// mode arm and plan's classifier borrow need. This is the ONLY dependency evaluator.ts takes on
// the auto/ package — the concrete AutoEngine implementation (auto/engine.ts) is never imported
// here at all; it arrives purely through the already-injected `ctx.autoEngine` seam, exactly like
// every other T12-filled stub (REAL_SPECIAL_CHECKS/realPromptStage/realHookStage's own precedent
// in engine.ts, one level up). auto/config.ts itself imports nothing from this file, so there is no
// cycle in either direction.
import { isAutoSuspendedAllowRule, AUTO_MODE_DEFAULT_USE_AUTO_MODE_DURING_PLAN } from "./auto/config.ts";
// Phase 5 Task 8 (rider 18): the ONE matcher for the `Skill(...)` rule family. Imported rather than
// re-derived -- `skills/permission-rules.ts` is where the alias/argument split is decided, and a
// second copy here is exactly the producer/consumer drift R4-2 exists to catch.
import { matchesSkillRule } from "../skills/permission-rules.ts";
const SKILL_RULE_TOOL = "Skill";

export type { AutoModeConfig };

// Task 8: re-exported from its canonical home (sdk/permissions/types.ts, verbatim WS-07 §7.2 pin)
// now that it exists there — this module's own pre-T8 placeholder declaration (byte-identical to
// the pinned union) is retired; every consumer of this file's own `PermissionDecisionClassification`
// export (PermissionDecisionRecord below, evaluator.test.ts) is unaffected by the relocation.
export type { PermissionDecisionClassification };

// The normalized shape every evaluator stage operates on. `toolUseId`/`agentId` are optional at T6
// (the engine has both readily available per call — engine.ts's own `{id, name, input}` — but no
// consumer here needs them yet beyond forwarding into PromptStageMeta for T8's future use).
export interface PermissionCall {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  agentId?: string;
}

// Task 8 (WS-07 §8): the one magic tool name this phase's evaluator recognizes by identity — the
// tool itself (schema, real answer-application via `updatedInput.answers`) is P3's job (WS-06); this
// evaluator only needs to know its NAME to route it through stage 3 as mandatory interaction,
// exactly the way it already knows "AskUserQuestion" is the string a matched ask rule's own
// `toolName` might equally spell. Exported (mirroring PLAN_WRITE_WITHHELD_MESSAGE's own precedent
// for an otherwise-internal literal) so callers/fixtures never need to hand-copy the string.
export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

// --- Stage 1 seam: PreToolUse hooks (T9/T10 fill) --------------------------------------------------

// T10-CARRY 1 (WS-08 §3): widened from the T9-era 3-value union ("allow"|"deny"|"no_opinion") to
// add "ask" — a PreToolUse hook's `ask` now FORCES the interactive path at stage 3, exactly like a
// matched ask rule, instead of failing closed to a synthesized denial. See evaluate()'s own
// stage-1/stage-3 comments for how "ask" threads through: it is captured at stage 1 but NOT
// resolved there — a later, stronger stage-2 deny rule still wins (WS-08 §3's own "allow does not
// override a later deny" floor extends naturally to "ask", which is itself weaker than deny in the
// §4 rank table) before stage 3 ever prompts.
//
// Task 11 (WS-08 §7) widens this AGAIN to add "defer": runner.ts no longer resolves a raw
// PreToolUse `defer` to `ask` (that interim resolution is retired — see runner.ts's own updated
// header). A hook-forced `defer` is captured at stage 1 exactly like `ask` (non-terminal here; a
// stage-2 deny rule still wins first) but resolves DIFFERENTLY once past stage 2: WS-08 §4's own
// rank table (deny > defer > ask > allow > none) generalizes one level up this pipeline, the same
// move T10-CARRY 1 already made for ask — a hook-forced defer OUTRANKS a matched ask rule, so it
// short-circuits directly to a durable-approval park (evaluate()'s own new branch, right after
// stage 2) rather than ever reaching stage 3's prompt machinery. See evaluate()'s own comment at
// that branch for the dontAsk/bypassPermissions treatment (mirrors ask's own precedent).
export interface HookDecision {
  decision: "allow" | "deny" | "ask" | "defer" | "no_opinion";
  transformedInput?: Record<string, unknown>;
  message?: string;
  interrupt?: boolean;
  hookId?: string;
}

// T10 (WS-08 §6): PermissionRequest's own, narrower decision shape — allow/deny only (derived-shapes
// item (b) pins NO "defer" arm on PermissionRequestHookSpecificOutput despite WS-08 §7's prose; see
// runner.ts's interpretPermissionRequest for the T9-CARRY-3 reconciliation). `updatedPermissions`
// mirrors canUseTool's own PromptDecision field (WS-07 §7.2) — reused by evaluate()'s
// buildRecordFromPromptResult-adjacent PermissionRequest handling below via the SAME
// PermissionDecisionRecord shape, mechanism "hook" instead of "canUseTool".
export interface PermissionRequestHookDecision {
  decision: "allow" | "deny";
  transformedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionUpdate[];
  message?: string;
  interrupt?: boolean;
  hookId?: string;
}

export interface HookStage {
  // SEAM CONTRACT: an "allow" result is ADVISORY ONLY for this stage (WS-07 §2.1: "An allow does NOT
  // override later deny/ask rules, interaction-required metadata, ... or the critical-removal
  // circuit breaker") — evaluate() below continues the pipeline regardless of an "allow" here; only
  // "deny" short-circuits everything downstream. An "ask" (T10-CARRY 1) is similarly non-terminal
  // HERE — it is captured and forces stage 3's prompt path, but a stage-2 deny rule reached in
  // between still wins first. A "defer" (Task 11) is ALSO non-terminal here for the identical
  // reason — a stage-2 deny still wins first — but once past stage 2 it resolves to a durable park
  // rather than stage 3's prompt path (see evaluate()'s own comment at that branch).
  // `transformedInput`, if present, becomes the effective call for every later stage (rule matching
  // included), mirroring canUseTool's own updatedInput semantics (WS-07 §7.2). T9's real multi-hook
  // reducer composes several hooks into ONE HookDecision before this seam is even called; this
  // interface is the reducer's OUTPUT shape, not a per-hook shape.
  preToolUse(call: PermissionCall, ctx: EvaluationContext): Promise<HookDecision>;
  // T10 (WS-08 §6): fires immediately before EVERY promptStage.prompt() call site in this file — "a
  // decision is about to be requested." Returns null when no PermissionRequest hook is
  // registered/answers (evaluate() then falls through to ctx.promptStage.prompt() exactly as
  // before, mechanism "canUseTool"); a non-null answer takes canUseTool's place ENTIRELY for that
  // one decision point (mechanism "hook", canUseTool never invoked — WS-08 §6: "can answer it in
  // place"). The §3 non-override floor (a PermissionRequest allow can never retroactively clear a
  // deny/ask rule or the critical-removal breaker) holds STRUCTURALLY, not by a runtime check here:
  // every call site below only ever reaches this method AFTER stage 2's deny rules, the
  // Read-deny-blocks-Edit check, and (at the standing-exception sites) the critical/protected checks
  // have already run and already decided this call needs a prompt — there is no later stage left
  // for an allow returned here to bypass (T7's own structural-guarantee precedent, extended).
  permissionRequest(call: PermissionCall, ctx: EvaluationContext, meta: PromptStageMeta): Promise<PermissionRequestHookDecision | null>;
}

// --- Stage 6 seam: canUseTool (T8 fills) ------------------------------------------------------------

export interface PromptStageMeta {
  decisionReason: string;
  toolUseID?: string;
  agentID?: string;
  matchedAskRule?: { source: RuleSource; toolName: string; ruleContent?: string };
  // Task 8 (WS-07 §7.1): the path boundary that forced this prompt, when T7's protected-write check
  // is what forced it — populated ONLY at the resolveProtectedWrite mustPrompt call site (the first
  // candidate write path, resolved against cwd). Deliberately absent for the critical-removal
  // standing exception: T7's CriticalRemovalResult (protected.ts) exposes only a prose `reason`
  // string (already carried via `decisionReason`), not a structured path — extending that sealed
  // shape is out of this task's scope; see the task report's Deviations.
  blockedPath?: string;
  // The remaining verbatim canUseTool option-object fields (signal, suggestions, title, displayName,
  // description, requestId) are NOT threaded through this meta shape — they are either wrapper-local
  // (signal), constructed by the REAL PromptStage itself from `meta`/`call` (suggestions, requestId),
  // or unavailable at P2 with no tool registry to source them from (title/displayName/description —
  // WS-06's job, P3). See prompt-stage.ts's own header for exactly how each is built.
}
export interface PromptDecision {
  decision: "allow" | "deny";
  transformedInput?: Record<string, unknown>;
  message?: string;
  interrupt?: boolean;
  updatedPermissions?: PermissionUpdate[];
  decisionClassification?: PermissionDecisionClassification;
}
export interface PromptStage {
  // Returns `null` for "no opinion" — see this module's header for exactly how evaluate() resolves
  // a null answer (differently at stage 3's ask-match vs. stage 6's generic fallback).
  prompt(call: PermissionCall, ctx: EvaluationContext, meta: PromptStageMeta): Promise<PromptDecision | null>;
}

// --- Stage 4's `auto` arm seam (T12 fills) -----------------------------------------------------------

export interface AutoEngineVerdict {
  verdict: "allow" | "deny" | "no_verdict";
  category?: string;
  reasonCode?: string;
  // Task 12 (WS-07 §10.5/§10.6-11): true when the 3-consecutive/20-total fallback counters have
  // tripped and this action should route to the SAME human-prompt pathway as any other
  // would-prompt action (PermissionRequest hook, then canUseTool) instead of a classifier
  // consultation. `verdict` is "no_verdict" by convention on this branch (a fallback trip is not
  // itself a classifier opinion) — evaluate() never inspects `verdict` when this flag is true.
  // evaluate() remains the SOLE owner of "when do we call promptStage" (every other seam already
  // follows this rule — see tryPermissionRequestHook's own header); the concrete AutoEngine
  // implementation (auto/engine.ts) signals the NEED here rather than calling ctx.promptStage
  // itself, so mechanism attribution (canUseTool vs. hook vs. autoEngine) stays correct.
  fallbackToPrompt?: boolean;
}
export interface AutoEngine {
  // T6 never calls this (the `auto` mode arm is a placeholder identical to `default`'s own baseline
  // — see evaluateModeStage below) — the seam exists so EvaluationContext's shape is already
  // complete for T12 to wire against, and so "the evaluator runs fully with all four stubbed"
  // (task-6 brief) is true by construction, not by accident.
  classify(call: PermissionCall, ctx: EvaluationContext): Promise<AutoEngineVerdict>;
  // Task 12 (WS-07 §10.5): called by evaluate() after a fallback-routed prompt/hook decision
  // resolves — see AutoEngineVerdict.fallbackToPrompt's own comment. Optional: NO_OPINION_AUTO_ENGINE
  // has no counters to update, so omitting it is a safe no-op there.
  noteFallbackResolution?(outcome: "allow" | "deny"): void;
  // Item 11 (P2 fix-wave): a NARROW, single-purpose seam method — deliberately NOT a widening of
  // noteFallbackResolution's own signature (that method's whole job is the "allow" un-trip counter
  // update per WS-07 §10.5; folding an audit emission into it would conflate two independent
  // concerns behind one boolean-ish outcome). resolveAutoDecision (below) calls this exactly once,
  // at its own headless-fallback SYNTHESIZED deny site — no PermissionRequest hook and no
  // canUseTool answered a fallback-routed prompt at all. That denial previously had NO matching
  // AutoAuditRecord anywhere: classify()'s own "fallback_state" emission fires BEFORE the fallback
  // prompt is even attempted (WS-07 §10.5's own "auto pauses" check, before ANY human involvement),
  // and classify()'s own "permission_denied" emission is scoped to a GENUINE classifier verdict —
  // structurally unreachable for this case, since classify() already returned once fallback tripped.
  // This seam method is what closes that gap; it must live on AutoEngine (not be inlined into
  // evaluator.ts itself) because the audit recorder + sessionId are createAutoEngine's OWN closure
  // state, invisible to evaluator.ts by design (mirrors classify()'s own seam-not-call-site
  // reasoning — see AutoEngineVerdict.fallbackToPrompt's comment for the identical precedent one
  // level up). Optional: NO_OPINION_AUTO_ENGINE has no audit sink to write to, so omitting it is a
  // safe no-op there.
  noteHeadlessFallbackDenial?(call: PermissionCall, ctx: EvaluationContext): void | Promise<void>;
}

// --- SpecialChecks seam (T7 fills) --------------------------------------------------------------------

export interface CriticalRemovalResult {
  critical: boolean;
  reason?: string;
}
export interface SpecialChecks {
  // T7's own standalone primitives (edit-recognition.ts/protected.ts) take a bare path/command
  // string; this seam takes the whole `call` because DIFFERENT tools extract "the path" or "the
  // command" differently — that extraction is exactly what T7's real implementation of this seam is
  // expected to own, adapting its own lower-level primitives.
  isProtectedWrite(call: PermissionCall, ctx: EvaluationContext): boolean;
  isCriticalRemoval(call: PermissionCall, ctx: EvaluationContext): CriticalRemovalResult;
}

// --- The per-evaluation context -----------------------------------------------------------------------

export interface EvaluationContext {
  // A SNAPSHOT, not a live reference — evaluate() reads `ctx.policy` exactly once implicitly (it
  // never re-derives anything from a mutable store mid-flight) so one call's whole evaluation is
  // internally consistent even if a concurrent set_permission_mode / rule update lands elsewhere
  // while this evaluation is in flight. The caller (engine.ts) is responsible for calling
  // PolicyStateStore.getState() fresh before every evaluate() invocation and for comparing the
  // returned record's policyVersion against the store's CURRENT version afterward, re-evaluating on
  // a mismatch (WS-07 §2's stale-policy-rejection contract).
  policy: PolicyState;
  cwd: string;
  // RULING P3-L (fix wave, P3 close-out): the engine-owned session root -- see registry.ts's own
  // ToolExecutionContext.session.getSessionRoot doc comment. Distinct from `cwd` (which drifts with
  // every `cd`): moved only by EnterWorktree/ExitWorktree. Consumed today by CronCreate(durable)'s
  // write-recognition target (RULING P3-K, edit-recognition.ts's own CronCreate case).
  sessionRoot: string;
  home: string;
  trustedWorkspace: boolean;
  allowManagedPermissionRulesOnly?: boolean;
  // Task 7 (WS-07 §6.2): direct, config-sourced acceptEdits bounds, ADDITIONAL to whatever
  // `effectiveDirectories(ctx.policy.rules, ...)` (T5, rule-derived `addDirectories` grants)
  // already contributes -- see `boundedRoots` below, which unions cwd + both sources. No
  // RuntimeConfig/Options wiring exists yet at P2 (engine.ts does not populate this from any wire
  // field) -- it exists here so a direct SDK-level `additionalDirectories` config option has
  // somewhere to land the moment a later task adds that wire field, and so tests can inject bounds
  // without needing a full rule-set/trust setup. Deliberately optional; absent = no extra bounds
  // beyond cwd + rule-derived directories.
  additionalDirectories?: string[];
  // Task 7 (WS-07 §6.4/§6.5): "a session that did not enable bypass at startup cannot casually
  // switch into it later" -- this is that SAME session-level fact (constant for the life of a
  // session, unlike `policy.mode`, which changes on every setPermissionMode), needed by plan mode's
  // own bypass-relaxation carve-out (§6.4: "with bypass enabled, plan mode becomes instructional");
  // NOT the same thing as `policy.mode === "bypassPermissions"` (the session can be bypass-ENABLED
  // while currently sitting in `plan`). Sourced from the SAME `allowDangerouslySkipPermissions`
  // config flag PolicyStateStore's own bypass gate already checks (policy-state.ts) -- engine.ts
  // threads it through unchanged, one level further.
  sessionBypassEnabled?: boolean;
  /**
   * Phase 5 Task 8 (rider 18): every name a skill answers to -- `SkillIndex.identities(name)`.
   *
   * Injected rather than imported for the same reason `requiresInteraction` below is: the evaluator
   * is stateless and holds no session, while the skill index is per-session state
   * (`skills/runtime.ts`'s registry, keyed `agentId ?? sessionId`). engine.ts supplies it; a direct
   * caller may omit it, and a `Skill(...)` rule then matches on the literal name alone -- correct,
   * just blind to the `<projectDir>:<name>` alias a project skill also answers to.
   */
  skillIdentities?: (skillName: string) => readonly string[];
  /**
   * Phase 5 fix wave, I1: the RESOLVED winter root, DISTINCT from `home` (the OS home) above.
   *
   * Two consumers, both of which were silently wrong under a `<PREFIX>HOME` whose basename is not
   * the brand's own dot-dir: the P5-B workflow-script carve-out (which must name the directory
   * `workflows/store.ts` actually persists to) and `isProtectedWrite`'s own carve-out check.
   * Absent = the pre-fix behaviour, `<home>/<homeDirName>/...` only.
   */
  winterHome?: string;
  /**
   * P7a (D19): the session's brand -- the protected-path floor's own dot-dir and instructions file.
   *
   * Optional, `WINTER_BRAND` when absent, so every hand-built evaluation context in this package's
   * tests keeps exactly today's verdicts.
   */
  brand?: ProtectedBrand;
  /**
   * Phase 5 fix wave, B-H1(a): "will this exact call run under the OS sandbox, with
   * `autoAllowBashIfSandboxed` on?" -- WS-12 §1's composition MUST, which had no consumer at all.
   *
   * INJECTED rather than computed here, for the same reason `requiresInteraction` and
   * `skillIdentities` are: the answer depends on the session's resolved `SandboxSettings`, on
   * `sandbox-exec` being available on this host, and on the call's own `dangerouslyDisableSandbox`
   * (P3-J), none of which this module can see. Absent = the pre-fix behaviour, i.e. the setting
   * stays inert for any caller that does not supply it.
   */
  bashRunsSandboxed?: (call: PermissionCall) => boolean;
  hookStage: HookStage;
  promptStage: PromptStage;
  autoEngine: AutoEngine;
  specialChecks: SpecialChecks;
  // Phase 4 Task 3 (WS-09 §6): "a server can mark a tool `_meta['anthropic/requiresUserInteraction']`;
  // Winter forces that call through interactive permission handling... and `dontAsk` denies it."
  // The SIGNAL this seam answers (registry.ts's own `ToolDescriptor.interaction === 'required'`,
  // derived at MCP registration time from that exact `_meta` key) lives on the tool REGISTRY, which
  // this module cannot import directly: registry.ts already imports THIS module's own
  // `ReadAccessProbe` type (type-only today, but registry.ts's own header explicitly notes "no
  // runtime cycle since evaluator.ts never imports this file" as the reason that's safe) -- a real,
  // value-level import in the other direction would create the exact cycle that comment depends on
  // NOT existing. Injected instead, exactly like `specialChecks`/`promptStage`/`hookStage`/
  // `autoEngine` above: engine.ts's own `makeEvalCtx()` builds this from `getRegisteredTool(name)?.
  // descriptor.interaction === "required"`. Optional and OMITTED by every pre-existing
  // EvaluationContext construction (every test file that builds one directly, and every fixture
  // that predates this task) -- absence reads as "nothing requires interaction," byte-identical to
  // before this field existed.
  requiresInteraction?: (toolName: string) => boolean;
}

// --- The decision record (cross-task pin, verbatim shape + one T6 addition) ---------------------------

export interface PermissionDecisionRecord {
  decision: "allow" | "deny" | "ask" | "defer";
  mechanism: "hook" | "rule" | "mode" | "canUseTool" | "autoEngine";
  source?: RuleSource;
  hookId?: string;
  ruleRef?: string;
  transformedInput?: Record<string, unknown>;
  message?: string;
  interrupt?: boolean;
  updatedPermissions?: PermissionUpdate[];
  decisionClassification?: PermissionDecisionClassification;
  policyVersion: number;
  // T6 addition beyond the plan's cross-task pin (task-6 brief's own T5-store-API paragraph): a
  // "deny" whose matched rule is BARE (or `Tool(*)`) is a schema-REMOVAL-class deny at the
  // advertisement layer (WS-07 §1) — P3's tool registry needs to stop advertising the tool
  // altogether, not just reject one invocation. Sourced directly from the matched entry's own
  // ParsedRule.isBareEquivalent (grammar.ts already computes it). At P2 the engine treats a bare and
  // a scoped deny identically (both become the same synthetic denied tool_result) — this marker is
  // forward-looking data only.
  deniedBareSchemaRemoval?: boolean;
}

// --- No-opinion stub seams --------------------------------------------------------------------------

export const NO_OPINION_HOOK_STAGE: HookStage = {
  async preToolUse() {
    return { decision: "no_opinion" };
  },
  async permissionRequest() {
    return null;
  },
};

export const NO_OPINION_PROMPT_STAGE: PromptStage = {
  async prompt() {
    return null;
  },
};

export const NO_OPINION_AUTO_ENGINE: AutoEngine = {
  async classify() {
    return { verdict: "no_verdict" };
  },
};

export const NO_SPECIAL_CHECKS: SpecialChecks = {
  isProtectedWrite: () => false,
  isCriticalRemoval: () => ({ critical: false }),
};

// ---------------------------------------------------------------------------------------------------
// Task 7: acceptEdits path-bounding + the real SpecialChecks seam fill
// ---------------------------------------------------------------------------------------------------

// WS-07 §6.2's "cwd or additionalDirectories" bound — unions THREE sources: the live cwd, T5's
// rule-derived grants (`addDirectories` PermissionUpdate entries, trust-gated exactly like every
// other project/local grant — `effectiveDirectories` already does that gating), and this task's own
// direct `ctx.additionalDirectories` config field (see that field's own EvaluationContext comment
// for why it's separate and currently unwired past this file). Also reused, deliberately, as
// `isCriticalRemoval`'s own "additionalDirectories" input (§6.8's "dangerous additional-directory
// glob shapes") — the two checks share exactly the same notion of "a directory this session may
// freely operate in," so computing it once and threading it to both is structural, not incidental.
// Exported for Task 12's auto/envelope.ts, which needs the IDENTICAL "cwd or additionalDirectories"
// notion for the action envelope's own `roots` field (WS-07 §10.6-1) — reusing this rather than
// re-deriving `effectiveDirectories(...)` a second time keeps the two notions of "in-bounds" from
// ever drifting apart.
export function boundedRoots(ctx: EvaluationContext): string[] {
  const ruleDerived = effectiveDirectories(ctx.policy.rules, { trustedWorkspace: ctx.trustedWorkspace });
  return [ctx.cwd, ...ruleDerived, ...(ctx.additionalDirectories ?? [])];
}

// Is `path` inside cwd or ANY additional directory? Pre-resolves `path` to an absolute string
// against the REAL cwd exactly once — a relative tool-call path (`file_path: "./tmp/x"`) only ever
// means "relative to this session's actual cwd," never "relative to whichever additionalDirectory
// happens to be under consideration" — then checks that one resolved candidate against each root in
// turn via the symlink-aware composition (rider 2): "allow" requires BOTH the path and its resolved
// symlink target to fall inside a root, so a symlink planted in-bounds that points out of every
// granted root is correctly NOT auto-approved.
function isWithinBounds(path: string, ctx: EvaluationContext): boolean {
  const absPath = resolve(ctx.cwd, path);
  return boundedRoots(ctx).some((root) => matchFileRuleAtBothEnds("**", { path: absPath, cwd: root, home: ctx.home, direction: "allow" }));
}

// The whole-call path extraction the SpecialChecks seam contract asks T7 to own (see that
// interface's own comment: "DIFFERENT tools extract 'the path' ... that extraction is exactly what
// T7's real implementation of this seam is expected to own"). Reused by both `isWithinBounds`'s
// acceptEdits caller (evaluateModeStage below) and `REAL_SPECIAL_CHECKS.isProtectedWrite` — a Bash
// call's candidate paths are recognizeEditOperation's UNION of blessed-fs-op paths and redirect
// targets regardless of `kind`, so `echo x > .git/config` surfaces `.git/config` here even though
// `echo` is nowhere near the seven blessed verbs (this task's own instruction: "redirect targets
// count as write paths for the SpecialChecks seam ... but do not widen §6.2's auto-approve set" —
// the "do not widen" half is `evaluateModeStage`'s job, by checking `kind`, not this function's).
// Exported for Task 12's auto/envelope.ts (the action envelope's own resolved-paths field, WS-07
// §10.6-1) — reused rather than duplicated, per this function's own header precedent of being
// shared internally; a second copy would be exactly the kind of drift risk this whole phase's
// review lens exists to catch.
// Task 8 (P3 close-out, RULING P3-E): now a pure delegation to `recognizeEditOperation` for EVERY
// tool shape (Edit/Write/NotebookEdit's own direct single-path case included) — the pre-existing
// hand-rolled `call.input["file_path"]` branch here read a HARDCODED field name that was blind to
// NotebookEdit's own `notebook_path` (edit-recognition.ts's own `fileRulePathField` is the fix); once
// that module gained a real NotebookEdit case, re-implementing the identical logic here a second time
// would only reintroduce the exact drift risk this function's own header already warns about
// ("a second copy would be exactly the kind of drift risk this whole phase's review lens exists to
// catch"). Behavior for Edit/Write/Bash is byte-identical to before this change.
// RULING P3-K (fix wave, P3 close-out): now takes `ctx` too, so CronCreate(durable) can be
// recognized against the real `ctx.sessionRoot` (edit-recognition.ts's own CronCreate case) --
// every pre-existing call site already had `ctx` in scope (isProtectedWrite/resolveProtectedWrite/
// findReadDenyBlockingEdit/auto/envelope.ts's resolveCandidatePaths), so this is a pure widening,
// never a new requirement on a caller that didn't already have one.
export function extractCandidateWritePaths(call: PermissionCall, ctx: EvaluationContext): string[] {
  const recognized = recognizeEditOperation(call, { sessionRoot: ctx.sessionRoot, ...(ctx.brand !== undefined ? { brand: ctx.brand } : {}) });
  return recognized ? recognized.paths : [];
}

// The real SpecialChecks seam fill (T6's stub, NO_SPECIAL_CHECKS above, was "always no opinion").
// Wired into engine.ts's `makeEvalCtx` in place of NO_SPECIAL_CHECKS; every fixture in this file
// that wants real protected/critical behavior passes this explicitly instead.
export const REAL_SPECIAL_CHECKS: SpecialChecks = {
  isProtectedWrite(call, ctx) {
    // Ruling P2-J (rider 2) applied here too, advisor-flagged gap: `isProtectedPath` itself is
    // pure name/segment matching against the LINK text only (protected.ts has no fs access at
    // all) — without composing checkSymlinkBothEnds here, `Edit(file_path="/work/innocent-link")`
    // where the link resolves into `/work/.git/config` would sail through as "not protected" (the
    // link's own path has no `.git` segment) even though the write lands inside `.git`. "deny if
    // EITHER end classifies protected" mirrors rider 2's own deny-direction semantics — protected
    // is a safety check, not a grant, so the more-restrictive interpretation applies, exactly like
    // deny/ask elsewhere in this phase.
    return extractCandidateWritePaths(call, ctx).some((p) => {
      const absPath = resolve(ctx.cwd, p);
      return checkSymlinkBothEnds(absPath, (candidate) => isProtectedPath(candidate, { cwd: ctx.cwd, home: ctx.home, ...(ctx.winterHome !== undefined ? { winterHome: ctx.winterHome } : {}), ...(ctx.brand !== undefined ? { brand: ctx.brand } : {}) })).denyIfEither;
    });
  },
  isCriticalRemoval(call, ctx) {
    // WS-07 §6.8 is scoped to `rm`/`rmdir` — a shell concept; Edit/Write never "remove" anything.
    // I2 (fix wave, P3 close-out): `shellCommandOf` covers Monitor's command half too (Bash-only
    // before this fix) -- see that function's own header for the full rationale.
    const command = shellCommandOf(call);
    if (command === undefined) return { critical: false };
    return classifyCriticalRemoval(command, { cwd: ctx.cwd, home: ctx.home, additionalDirectories: boundedRoots(ctx) });
  },
};

// ---------------------------------------------------------------------------------------------------
// Rule lookup — deliberately NOT ruleset.ts's resolveRules()
// ---------------------------------------------------------------------------------------------------
//
// resolveRules() (packages/runtime/src/permissions/ruleset.ts:402-446) always dispatches a rule's
// specifier match through grammar.ts's matchesRule(), which cannot correctly evaluate:
//   (a) a FILE_RULE_TOOLS (Read/Edit) "pattern" specifier — matchesRule's "pattern" case reads
//       call.input.command (WS-07 §3's Bash-shaped grammar), which a Read/Edit call never has, so a
//       scoped Read/Edit deny/ask/allow rule would silently NEVER match through that path (fail-open
//       on deny/ask — exactly the class of bug this whole phase's review lens exists to catch).
//   (b) a Bash "pattern" specifier against a COMPOUND command — matchesRule takes the call's raw
//       command string as-is; handing it unsplit text would let a dangerous subcommand hide behind a
//       benign leading one (`ls && rm -rf /`), or let an unparseable string's own literal bytes
//       accidentally match a rule they were never meant to (grammar.ts's own module header: "callers
//       ... call splitCompound FIRST ... then loop per-subcommand").
// findMatchingRuleEntry below duplicates resolveRules' own precedence loop (trust gate +
// allowManagedPermissionRulesOnly filter) — same duplication precedent as ruleset.ts's own
// isAnchoredMcpAllowGlob (there, because grammar.ts doesn't export what's needed; here, because this
// task's edit authorization does not extend to ruleset.ts) — but dispatches each entry through
// matchesRuleForCall, which routes (a) and (b) correctly and falls back to plain matchesRule for
// every other specifier kind (wildcardAll/bare/param/webFetchDomain), which grammar.ts already
// handles correctly on its own.

function matchesRuleForCall(rule: ParsedRule, call: PermissionCall, direction: "allow" | "denyAsk", ctx: EvaluationContext): boolean {
  // Lens item 2 (task-6 brief): FILE_RULE_TOOLS (Task 8, RULING P3-E: Read/Edit/Write/NotebookEdit)
  // with a SCOPED pattern specifier route to matchFileRule (paths.ts), never matchesRule. A bare
  // rule or `Tool(*)` (specifier undefined / wildcardAll) skips this branch entirely — matchesRule
  // already resolves those correctly via tool-name matching alone, without ever touching call.input.
  if (FILE_RULE_TOOLS.has(rule.toolName) && rule.specifier?.kind === "pattern") {
    if (rule.toolName !== call.toolName) return false; // literal match only — WS-07 never documents a globbed tool name for this family
    // Task 8 (RULING P3-E): `fileRulePathField` -- WS-06's own pinned field name per tool
    // (docs/superpowers/specs/winter/WS-06-tool-catalog.md:145,167,179: file_path for Read/Edit/
    // Write, notebook_path for NotebookEdit) -- shared with edit-recognition.ts/
    // extractCandidateWritePaths so this dispatch can never drift from theirs.
    const rawPath = call.input[fileRulePathField(call.toolName)];
    // I1 (fix wave, P3 close-out): Glob/Grep's own `path` field is OPTIONAL on the call (absent ==
    // "scan from cwd", mirroring glob.ts/grep.ts's own `input.path !== undefined ? resolve(ctx.cwd,
    // input.path) : ctx.cwd`) -- an absent path must still resolve to "." here, or a scoped
    // Glob/Grep deny/ask/allow rule could never match the (extremely common) no-`path`-given call
    // shape at all.
    const path = typeof rawPath === "string" ? rawPath : rawPath === undefined && (call.toolName === "Glob" || call.toolName === "Grep") ? "." : undefined;
    if (path === undefined) return false;
    // Ruling P2-J (Task 7, rider 2): symlink-both-ends composed here — deny/ask fire if the LINK OR
    // the resolved TARGET matches; allow requires BOTH. Closes the fail-open T6's report flagged
    // ("deny Read(//etc/passwd) does not fire on a Read of a symlink whose target is /etc/passwd").
    return matchFileRuleAtBothEnds(rule.specifier.source, {
      path,
      cwd: ctx.cwd,
      home: ctx.home,
      direction,
      // sourceDir intentionally omitted: SourcedRuleEntry (ruleset.ts) carries no per-entry
      // settings-source directory at P2 — no settings-file loader exists yet (P5). paths.ts's own
      // documented behavior for an absent sourceDir makes a `/`-anchored rule inert on EITHER
      // direction (MatchFileRuleOptions.sourceDir's own comment) — the same conservative default
      // this whole phase applies to every other unresolvable-anchor case.
    });
  }

  // Phase 5 Task 8 (rider 18, WS-07 §3): a `Skill(...)` rule matches on the skill's own IDENTITIES
  // plus an argument prefix -- routed to `skills/permission-rules.ts`, never to `matchesRule`.
  //
  // TWO INDEPENDENT REASONS THE FALLTHROUGH WAS SILENTLY WRONG, both named in Lane S's report:
  // `matchesRule`'s `"pattern"` case reads `call.input["command"]`, and a Skill call's input is
  // `{skill, args?}` with no `command` at all -- so every pattern-kind Skill rule compared against
  // `""`; and `parseRule` used to classify the same rule shape three different ways depending on
  // whether the skill's name held a hyphen or a leading dot (closed in grammar.ts by the companion
  // half of this rider).
  //
  // `ctx.skillIdentities` is what makes the ALIAS dimension work: a project skill `review` also
  // answers to `.winter:review`, so a rule written against the official branch's qualified spelling
  // must match Winter-native discovery's bare one. Absent (every direct evaluator test, and any host
  // with no skill index) it degrades to the literal name -- correct, just alias-blind.
  if (rule.toolName === SKILL_RULE_TOOL && call.toolName === SKILL_RULE_TOOL && rule.specifier?.kind === "pattern") {
    const rawName = call.input["skill"];
    if (typeof rawName !== "string") return false;
    const rawArgs = call.input["args"];
    return matchesSkillRule(rule.specifier.source, {
      identities: ctx.skillIdentities?.(rawName) ?? [rawName],
      ...(typeof rawArgs === "string" ? { args: rawArgs } : {}),
    });
  }

  // Lens item 1: a Bash "pattern" specifier must never see raw, unsplit compound-command text.
  // Scoped to an EXACT "Bash" rule/call tool name, mirroring grammar.ts's own parseRule dispatch
  // (which only recognizes the Bash specifier family for the literal name "Bash" — a hypothetical
  // glob tool name like "Ba*" never reaches this branch in grammar.ts either, so this inherits that
  // same scope rather than introducing a new one).
  if (rule.toolName === "Bash" && call.toolName === "Bash" && rule.specifier?.kind === "pattern") {
    const raw = call.input["command"];
    const command = typeof raw === "string" ? raw : "";
    const parts = splitCompound(command);
    if (parts === null) return false; // unparseable/over-limit -> route the WHOLE command to permission handling; never fall back to raw-text matching
    // Fix round 1, item 1 (IMPORTANT, reviewer-caught): splitCompound("") returns `[]`, not null —
    // an empty/all-separator/missing command scans OK, it just has zero non-empty subcommands.
    // `[].every(...)` is vacuously TRUE, which would report this rule as matching ANY configured
    // Bash allow rule regardless of its pattern; `[].some(...)` is already vacuously false, so only
    // the allow/"every" direction was ever actually exploitable, but both directions are guarded
    // uniformly here (mirrors isBashCallReadOnly's own `parts.length > 0 && ...` guard immediately
    // below in this file, and matches ruleset.ts's resolveRules(), whose own matchesRule() call —
    // no compound-splitting at all — was already correctly fail-closed on this exact input; see the
    // parity test in evaluator.test.ts).
    if (parts.length === 0) return false;
    const matchesSub = (sub: string): boolean => matchesRule(rule, { toolName: call.toolName, input: { ...call.input, command: sub } }, { direction });
    // WS-07 §3: "every subcommand MUST be independently permitted." Deny/ask are safety checks — ANY
    // dangerous subcommand taints the whole compound. Allow is a grant — this ONE rule only
    // pre-approves the whole compound if it independently covers EVERY subcommand (a conservative,
    // capture-pending reading — see the report — a compound whose parts are covered by DIFFERENT
    // allow rules, or by a mix of an allow rule and stage 4's own built-in read-only recognition, is
    // not treated as rule-allowed by this single-entry check).
    return direction === "denyAsk" ? parts.some(matchesSub) : parts.every(matchesSub);
  }

  // Every other case (wildcardAll/bare/param/webFetchDomain specifiers; any tool outside the two
  // routed families above) is exactly what grammar.ts's matchesRule already handles correctly.
  return matchesRule(rule, call, { direction });
}

// Exported ONLY so evaluator.test.ts's resolveRules-parity table (fix round 1, item 2) can call
// this copy directly and compare it against ruleset.ts's resolveRules() for the same rules/call —
// mirroring PLAN_WRITE_WITHHELD_MESSAGE's own precedent of exporting an otherwise-internal symbol
// purely for fixture use. Not part of any other module's intended surface.
//
// Task 12 addition: the optional `opts.skip` predicate lets a caller treat an otherwise-matching
// entry as though it never matched, WITHOUT duplicating this function's own trust-gate/matching
// loop. The one production caller is evaluate()'s own stage 5, for `policy.mode === "auto"`
// (WS-07 §10.1 step 2: broad-allow suspension) — every OTHER call site (stage 2/3's deny/ask
// lookups, every non-auto mode's stage 5) passes no `opts` at all and is completely unaffected.
export function findMatchingRuleEntry(
  rules: SourcedRuleSet,
  call: PermissionCall,
  behavior: PermissionBehavior,
  ctx: EvaluationContext,
  opts?: { skip?: (entry: SourcedRuleEntry) => boolean },
): SourcedRuleEntry | undefined {
  const direction: "allow" | "denyAsk" = behavior === "allow" ? "allow" : "denyAsk";
  const pool = ctx.allowManagedPermissionRulesOnly ? rules.entries.filter((e) => e.source === "managed") : rules.entries;
  for (const entry of pool) {
    if (entry.behavior !== behavior) continue;
    if (opts?.skip?.(entry)) continue;
    // Mirrors ruleset.ts's resolveRules() trust gate exactly: PROJECT-tier ALLOW rules require
    // workspace trust; local/user allow widen without it, and deny/ask from every tier apply
    // regardless (WS-07 §3.2 as amended by RULING P5-D -- see ruleset.ts's own note for the capture
    // that discriminated it). "Mirrors exactly" is load-bearing: these two gates are hand-mirrored
    // and must move together, which is why the full-tier x behaviour x trust matrix in
    // permissions/p5d-trust-matrix.test.ts drives BOTH.
    if (behavior === "allow" && entry.source === "project" && !ctx.trustedWorkspace) continue;
    if (matchesRuleForCall(entry.rule, call, direction, ctx)) return entry;
  }
  return undefined;
}

// Task 7 (WS-07 §3.1: "a Read deny also blocks current Edit/Write operations on the same path" —
// AND, same section: "Recognized Bash file operations consult these rules") — T6-review obligation,
// extended in fix round 1 (reviewer-caught MAJOR): this lands at STAGE 2 generally (every mode,
// every write-shaped call), not merely inside the acceptEdits arm the original brief text named,
// and not merely Edit/Write tool calls. `matchesRuleForCall`'s FILE_RULE_TOOLS branch above can
// never surface this by itself — a rule entry with `toolName: "Read"` never matches a call with
// `toolName: "Edit"` OR `"Bash"` (`rule.toolName !== call.toolName` returns false immediately, the
// very first check) — so this is a SEPARATE lookup. Pre-fix-round-1, this function only checked
// Edit/Write calls; its own comment claimed a compensating control ("caught by the ordinary Bash
// deny-rule stage instead") that does NOT exist — no rule-matching path ever lets a `Read`-toolName
// entry match a `Bash`-toolName call, so `Read(secrets/**) deny` + acceptEdits + `sed -i 's/x/y/'
// secrets/key.pem` was silently auto-approved. Fixed by reusing `extractCandidateWritePaths`
// (above, the SAME per-tool path extraction driving `REAL_SPECIAL_CHECKS.isProtectedWrite`) instead
// of a bespoke Edit/Write-only `file_path` read: Edit/Write's own path, or a Bash call's
// `recognizeEditOperation(call)?.paths` — the UNION of blessed-fs-op operands AND redirect targets,
// so `sed -i 's/x/y/' secrets/key.pem` and `echo x > secrets/out` are both covered for free, with
// no separate Bash-specific extraction to drift out of sync with `isProtectedWrite`'s own.
// A BARE Read deny (no specifier, or `Tool(*)`) is out of scope by construction (same SCOPE
// BOUNDARY paths.ts's own readDenyBlocksEdit documents) — it is an advertisement-layer schema
// removal (WS-07 §1), not a path-pattern block.
// Fix wave follow-up (7), whole-branch M13: the tool names whose DENY rules block a write to the same
// path. `Read` is the pre-existing WS-07 §3.1 rule ("a Read deny also blocks current Edit/Write
// operations on the same path"); the write family joins it because the same sentence's other half --
// "Recognized Bash file operations consult these rules" -- was only ever true for `Read`. Without
// this, a `Write(~/.winter/projects/**)` deny stops the Write TOOL and lets
// `echo x >> ~/.winter/projects/.../agent-1.jsonl` through, which is the same hole one tool over.
// Strictly tightening: it can only ever turn an allowed Bash write into a denial, and only for a path
// a deny rule already names.
const WRITE_BLOCKING_DENY_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "NotebookEdit"]);

// --- RULING P5-B: the workflow-script carve-out, evaluator side -----------------------------------
//
// `permissions/protected.ts` handles the §6.7 protected-write half. This handles the OTHER half: the
// M13 baseline `Write/Edit/NotebookEdit(~/.winter/projects/**)` DENY rules (engine.ts's
// buildBaselineDenyRules), which a plain allow rule can never beat -- deny wins at stage 2, before
// any allow is consulted, by design.
//
// The carve-out is therefore expressed as a SKIP on those specific entries, using
// `findMatchingRuleEntry`'s existing `opts.skip` seam (Task 12's own broad-allow-suspension
// precedent) rather than by inventing rule negation, which the grammar has no way to express and
// which would be a far larger and more dangerous surface.
//
// TWO CONDITIONS, both required: the entry must be a MANAGED deny naming the projects subtree (so a
// user-authored `Write(~/.winter/projects/**)` deny is NOT skipped -- an explicit human denial still
// wins), and EVERY candidate write path of the call must be inside the carve-out (so a compound Bash
// command touching one script and one transcript is still denied outright).
function isProjectsBaselineDeny(entry: SourcedRuleEntry, ctx: EvaluationContext): boolean {
  if (entry.behavior !== "deny" || entry.source !== "managed") return false;
  const content = entry.ruleValue.ruleContent;
  if (typeof content !== "string") return false;
  // P7a fix r1 (Important-2): the HOME-ANCHORED form, derived rather than spelled.
  //
  // `buildBaselineDenyRules` emits `~/<brand.homeDirName>/projects` + `/**`, and under a rebrand
  // with `<PREFIX>HOME` unset the resolved-root twin below is NOT emitted at all (the two anchors
  // coincide and the dedupe drops it). So a literal `~/.winter/projects` here matched NO baseline
  // entry for a branded session: the managed deny was never skipped, and WS-11 §1.3's documented
  // edit-then-rerun loop -- write the persisted workflow script, re-invoke with `{scriptPath}` --
  // was denied outright. It failed CLOSED, so a break rather than a hole; it still silently removed
  // a documented capability under exactly the feature this lane ships. Byte-identical under the
  // default brand: `WINTER_BRAND.homeDirName` IS the segment the literal spelled.
  const homeAnchor = `~/${(ctx.brand ?? WINTER_BRAND).homeDirName}/projects`;
  if (content === homeAnchor || content.startsWith(`${homeAnchor}/`)) return true;
  // Phase 5 fix wave, I1: the RESOLVED-root twin of the same baseline deny. `buildBaselineDenyRules`
  // now emits `//<winterHome>/projects/**` alongside the home-anchored form, and the P5-B carve-out
  // has to skip BOTH or the new floor closes the one subtree WS-11 §1.3 requires to stay
  // model-writable -- the documented edit-then-rerun loop, broken as collateral damage.
  // `//`-anchored (paths.ts's filesystem-root form), which is why the literal below carries it.
  if (ctx.winterHome === undefined) return false;
  const rootPrefix = `/${resolve(ctx.winterHome)}/projects`;
  return content === rootPrefix || content.startsWith(`${rootPrefix}/`);
}

function callIsEntirelyWorkflowScriptWrite(call: PermissionCall, ctx: EvaluationContext): boolean {
  const paths = extractCandidateWritePaths(call, ctx);
  if (paths.length === 0) return false;
  return paths.every((p) => isWorkflowScriptCarveOut(resolve(ctx.cwd, p), ctx.home, ctx.winterHome, ctx.brand));
}

/** The `skip` predicate the stage-2 deny lookup passes, or `undefined` when this call earns no carve-out at all. */
export function workflowScriptCarveOutSkip(call: PermissionCall, ctx: EvaluationContext): ((entry: SourcedRuleEntry) => boolean) | undefined {
  if (!callIsEntirelyWorkflowScriptWrite(call, ctx)) return undefined;
  return (entry) => isProjectsBaselineDeny(entry, ctx);
}

// --- SDK 0.0.4: the auto-memory carve-out, evaluator side -----------------------------------------
//
// `permissions/protected.ts` handles the §6.7 protected-write half (`isMemoryCarveOut`). This
// handles the other half, exactly as P5-B does one function up: the M13 baseline
// `Write/Edit/NotebookEdit(~/.winter/projects/**)` DENY, which no allow rule and no permission mode
// can ever beat, because stage 2 runs before stages 3-6 by design. That deny is what blocked
// Winter's OWN auto-memory feature -- `context/memory.ts` hands the model
// `<winterHome>/projects/<memory-key>/memory` every turn with "read and write it with the ordinary
// file tools", and every such write was refused by the product's own floor.
//
// THREE CONDITIONS, and the THIRD is what P5-B does not have:
//   1. the entry must be a MANAGED deny naming the projects subtree -- `isProjectsBaselineDeny`,
//      shared verbatim with P5-B, so a user-authored `Write(~/.winter/projects/**)` deny still wins;
//   2. EVERY candidate write path of the call must be inside the memory carve-out, so a compound
//      command touching one memory file and one transcript is denied outright;
//   3. the CALL'S TOOL must be one of the write-class tools. `Bash` is deliberately untouched: its
//      write hole into `projects/**` is closed by `findFileDenyBlockingEdit`'s cross-tool rule, the
//      memory feature never needs a shell to maintain its own directory, and a shell carve-out would
//      hand the model an arbitrary-command door keyed on one operand's path. `echo x >>
//      <memory>/MEMORY.md` therefore stays DENIED, and a test pins that it does.
const MEMORY_CARVE_OUT_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  // `MultiEdit` is named because the carve-out's own definition is "the write-class tools" and a
  // reuser's tool surface may carry it. This runtime implements no such tool today, and
  // `recognizeEditOperation` has no case for the name, so `extractCandidateWritePaths` returns an
  // empty list for it and condition 2 fails first -- the membership is INERT here rather than a
  // silent grant, and deliberately does NOT invent a path field for a tool that does not exist.
  "MultiEdit",
  "NotebookEdit",
]);

function callIsEntirelyMemoryWrite(call: PermissionCall, ctx: EvaluationContext): boolean {
  if (!MEMORY_CARVE_OUT_TOOLS.has(call.toolName)) return false;
  const paths = extractCandidateWritePaths(call, ctx);
  if (paths.length === 0) return false;
  return paths.every((p) => isMemoryCarveOut(resolve(ctx.cwd, p), ctx.home, ctx.winterHome, ctx.brand));
}

/** The auto-memory `skip` predicate, or `undefined` when this call earns no carve-out at all. */
export function memoryCarveOutSkip(call: PermissionCall, ctx: EvaluationContext): ((entry: SourcedRuleEntry) => boolean) | undefined {
  if (!callIsEntirelyMemoryWrite(call, ctx)) return undefined;
  return (entry) => isProjectsBaselineDeny(entry, ctx);
}

/**
 * The ONE skip both stage-2 deny lookups pass: the union of the two `projects/**` carve-outs.
 *
 * A union rather than a third predicate, so each carve-out keeps its own independently-testable
 * entry point (`brand-rebrand.test.ts` pins `workflowScriptCarveOutSkip` by name) and neither can
 * widen the other. Both arms return the identical `isProjectsBaselineDeny` predicate, so which arm
 * produced it is not observable downstream -- only WHETHER this call earns one at all.
 */
export function projectsCarveOutSkip(call: PermissionCall, ctx: EvaluationContext): ((entry: SourcedRuleEntry) => boolean) | undefined {
  return workflowScriptCarveOutSkip(call, ctx) ?? memoryCarveOutSkip(call, ctx);
}

function findFileDenyBlockingEdit(call: PermissionCall, ctx: EvaluationContext): SourcedRuleEntry | undefined {
  const candidatePaths = extractCandidateWritePaths(call, ctx);
  if (candidatePaths.length === 0) return undefined;
  // RULING P5-B (+ SDK 0.0.4's auto-memory arm): the same carve-out the stage-2 lookup applies.
  // Without it here, a `Write` into the scripts subtree -- or into the memory directory -- would walk
  // past the stage-2 skip and be caught by the SIBLING `Edit`/`NotebookEdit` baseline deny through
  // this function's cross-tool rule: a denial from the rule next door. The tool gate on the memory
  // arm is what keeps Bash out of BOTH lookups, which is exactly how `echo x >> <memory>/MEMORY.md`
  // still lands on a denial here.
  const carveOutSkip = projectsCarveOutSkip(call, ctx);
  const pool = ctx.allowManagedPermissionRulesOnly ? ctx.policy.rules.entries.filter((e) => e.source === "managed") : ctx.policy.rules.entries;
  for (const entry of pool) {
    // A rule for the SAME tool the call is already using is left to the ordinary stage-2 lookup
    // above -- reaching it here too would only produce a differently-worded identical denial.
    if (entry.rule.toolName === call.toolName) continue;
    if (carveOutSkip?.(entry) === true) continue;
    if (!WRITE_BLOCKING_DENY_TOOLS.has(entry.rule.toolName) || entry.behavior !== "deny") continue;
    const specifier = entry.rule.specifier;
    if (specifier?.kind !== "pattern") continue;
    const pattern = specifier.source;
    // Ruling P2-J (rider 2): symlink-both-ends composed here too, for the identical reason
    // paths.ts's own readDenyBlocksEdit primitive now is. ANY candidate path matching is enough —
    // deny is a safety check (mirrors isCriticalRemoval/isProtectedWrite's own "any candidate path"
    // looping, and matchesRuleForCall's own "ANY dangerous subcommand taints the whole compound").
    if (candidatePaths.some((path) => matchFileRuleAtBothEnds(pattern, { path, cwd: ctx.cwd, home: ctx.home, direction: "denyAsk" }))) {
      return entry;
    }
  }
  return undefined;
}

function formatRuleRef(entry: SourcedRuleEntry): string {
  const { toolName, ruleContent } = entry.ruleValue;
  return ruleContent !== undefined ? `${toolName}(${ruleContent})` : toolName;
}

function ruleDenialMessage(entry: SourcedRuleEntry): string {
  return `Denied by permission rule: ${formatRuleRef(entry)}`;
}

function ruleAskUnresolvedMessage(entry: SourcedRuleEntry): string {
  return `Denied: ask rule ${formatRuleRef(entry)} requires approval and no prompt handler answered it`;
}

// ---------------------------------------------------------------------------------------------------
// Stage 4: permission mode baseline
// ---------------------------------------------------------------------------------------------------

// I2 (fix wave, P3 close-out): scoped to `call.toolName === "Bash"` EXPLICITLY -- found while adding
// this fix wave's own Monitor fixtures: this check previously read `call.input["command"]" off ANY
// call regardless of toolName, so Monitor's own `command` field (same field name, same shape) was
// ALREADY silently eligible for the read-only pre-approval before this fix wave touched anything
// else here. WS-06 §3.2/WS-07's own framing treats Monitor as a background-process primitive, never
// a read -- see this fix wave's own `shellCommandOf` (edit-recognition.ts) header for why Monitor is
// deliberately excluded from THIS ONE check while joining every other Bash-keyed one.
function isBashCallReadOnly(call: PermissionCall): boolean {
  if (call.toolName !== "Bash") return false;
  const raw = call.input["command"];
  if (typeof raw !== "string") return false;
  const parts = splitCompound(raw);
  if (parts === null) return false; // unparseable -> WS-07 §3's own fallback: never recognized as safe
  return parts.length > 0 && parts.every((sub) => isRecognizedReadOnly(sub));
}

// Finding 7 (P2 fix-wave, MINOR; renamed from isReadWithinCwd): WS-07 §6.1 says "Reads within
// working OR ADDITIONAL directories ... run without prompting" — the pre-fix version hard-coded
// `cwd: ctx.cwd` and checked ONLY cwd, silently ignoring every `addDirectories`/`additionalDirectories`
// grant (live today via `updatedPermissions`, T5; wired via config, Finding 6, same wave). A session
// granted extra directories still prompted/denied for every Read inside them in every mode, while
// acceptEdits already auto-approved an EDIT in the identical directory — a visibly inverted
// asymmetry this fix closes by reusing `isWithinBounds` (below) instead of a bespoke single-cwd
// check: the SAME "cwd or additionalDirectories" notion acceptEdits' own edit-bounding already
// applies, including its symlink-both-ends composition (Ruling P2-J, rider 2 — "a granted-directory
// symlink pointing outside every root is NOT routine read-only," unchanged by this fix).
//
// I1 (fix wave, P3 close-out): renamed IN SPIRIT (name kept for minimal diff) to cover every
// "dedicated read/search tool" WS-07 §6.1 (line 136) names, not only Read — Glob/Grep join here.
// `fileRulePathField` supplies the per-tool field name; Glob/Grep's own field is OPTIONAL (absent ==
// "scan from cwd", i.e. "."), mirroring `matchesRuleForCall`'s own identical default one section up.
function dedicatedReadToolPath(call: PermissionCall): string | undefined {
  if (call.toolName !== "Read" && call.toolName !== "Glob" && call.toolName !== "Grep") return undefined;
  const raw = call.input[fileRulePathField(call.toolName)];
  if (typeof raw === "string") return raw;
  if (raw === undefined && (call.toolName === "Glob" || call.toolName === "Grep")) return ".";
  return undefined;
}

function isReadWithinBounds(call: PermissionCall, ctx: EvaluationContext): boolean {
  const path = dedicatedReadToolPath(call);
  if (path === undefined) return false;
  return isWithinBounds(path, ctx);
}

function isBuiltInReadOnly(call: PermissionCall, ctx: EvaluationContext): boolean {
  return isBashCallReadOnly(call) || isReadWithinBounds(call, ctx);
}

// RULING P3-K (fix wave, controller ruling, P3 close-out): WS-06 §1.4's Manual-mode evidence column
// marks these task/mode-class tools "No" (ordinarily no prompt). EXCLUDES CronCreate as a bare set
// member -- it is conditionally write-shaped (see the dedicated check below): `durable:true` writes
// a real file (`<sessionRoot>/.winter/scheduled_tasks.json`, RULING P3-K's own edit-recognition.ts
// case) and must fall through to the ordinary write pipeline ("prompts like any write," caught
// upstream by `isProtectedWrite`'s own dot-dir coverage before this arm is ever reached); a
// non-durable CronCreate never touches the filesystem at all and belongs in this silent-allow set
// exactly like its siblings. TaskOutput joins only after I5's traversal-guard fix landed (fix wave,
// same commit sequence) -- an unvalidated task_id could otherwise read arbitrary files silently.
//
// RULING P3-K-2 (fix wave round 2, controller ruling, P3 close-out): a no-prompt class must never be
// STRICTER under a more permissive mode -- P3-K originally wired `isTaskModeClassSilentAllow` into
// only the shared default/dontAsk arm, leaving acceptEdits/plan/auto to fall through to stage 6 (a
// denial) for the identical calls, so `acceptEdits` was, perversely, stricter than `default` for
// this whole class. `isTaskModeClassSilentAllow` is now ALSO consulted in the acceptEdits, plan, and
// auto arms (see each arm's own call site, below) -- FOUR arms total cover this set (the shared
// default/dontAsk arm, acceptEdits, plan, auto); `bypassPermissions` needs no explicit check, since
// its own arm already unconditionally allows everything the standing exceptions didn't already
// intercept. Deny/ask rules (stages 2-3) still run before EVERY one of these arms, in every mode,
// completely unaffected by this widening. Durable CronCreate is NOT part of this widening -- it was
// always the named EXCEPTION above, not a class member, and its own write-shaped treatment (via the
// SAME tool-agnostic, mode-position-agnostic `isProtectedWrite` standing exception every other
// a winter-owned write gets) is deliberately UNCHANGED by this ruling; see this file's own P3-K-2 test
// block for the full per-mode proof, including auto's pre-existing (Task 12) classifier-routing for
// ITS OWN mustPrompt outcome, which durable CronCreate now has explicit coverage under too.
//
// capture-pending (per the ruling's own instruction: "mark the whole cell set capture-pending"),
// WIDENED by P3-K-2 to cover all four arms this set now gates, not just the original default/dontAsk
// one -- mirrors grammar.ts's own PARSE_LIMIT/DANGEROUS_ASSIGNMENT_NAMES posture: this SET of tool
// names, and its extension to acceptEdits/plan/auto, is the controller's own considered ruling, not
// itself confirmed against a WS-17 differential capture of the pinned 0.3.250 artifact. A future
// capture that finds a DIFFERENT per-tool-per-mode cell (e.g. a tool here that the real runtime
// actually prompts for under some mode, or a tool absent here that it silently allows) should update
// this set directly, not restructure the mechanism.
const TASK_MODE_CLASS_SILENT_ALLOW: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TodoWrite",
  "CronList",
  "CronDelete",
  "ScheduleWakeup",
  "ReportFindings",
  "PushNotification",
  "TaskOutput",
  "TaskStop",
  "EnterPlanMode",
]);

function isTaskModeClassSilentAllow(call: PermissionCall): boolean {
  if (call.toolName === "CronCreate") return call.input["durable"] !== true;
  return TASK_MODE_CLASS_SILENT_ALLOW.has(call.toolName);
}

// Task 7 extends the T6 two-member union with two new terminal outcomes that, unlike "unresolved",
// NEVER fall through to stage 5's allow-rule lookup — see this type's four members' own uses in
// evaluate() below. "deny"/"mustPrompt" both carry a message so the eventual denial (immediate, or
// the fail-closed synthesized one when the still-stubbed PromptStage answers null) is legible.
// Task 12 addition: `mustPrompt` now carries WHICH standing exception produced it. Required (not
// optional) so every construction site must say so explicitly — evaluate()'s own auto/plan-borrow
// routing (§6.7/§6.8's "auto: classifier" cells; §6.5's plan-write EXCLUSION from the classifier
// borrow) depends on telling these apart, and a silently-omitted origin would be a fail-OPEN bug
// class (a plan write silently gaining classifier review it was never supposed to get).
type MustPromptOrigin = "critical" | "protected" | "planWrite";

type ModeStageResult =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "mustPrompt"; message: string; blockedPath?: string; origin: MustPromptOrigin }
  | { kind: "unresolved" };

// WS-07 §6.5 / this task's own phase-ruling-6 instruction, verbatim: "writes withheld ... with a
// plan-specific message." Exported so fixtures can assert the exact string rather than a substring
// guess, mirroring ruleDenialMessage's own callers.
export const PLAN_WRITE_WITHHELD_MESSAGE = "Denied: plan mode withholds file/shell writes until the plan is approved or session bypass is enabled (WS-07 §6.5)";

// Task 12 (WS-07 §10.6-5, VERBATIM, stable): "Model-visible denial is a stable short string
// ('Blocked by classifier')" — deliberately NOT following this file's own house style of a
// "Denied: ... (WS-07 §n)" prefix/suffix: the whole point is that the model cannot distinguish a
// genuine classifier "deny" from a "no_verdict" fail-closed denial from any other classifier
// failure mode. Detailed reasoning goes to the AUDIT stream only (auto/engine.ts's own
// AutoAuditRecord.auditReason, redacted) — never here. Re-exported (not re-defined) from
// auto/engine.ts so there is exactly one source of truth.
export const BLOCKED_BY_CLASSIFIER_MESSAGE = "Blocked by classifier";

// --- Standing exceptions (WS-07 §2 stage 5's own list; §6.7/§6.8 matrices) ---------------------------
//
// Both resolvers are called BEFORE any mode-specific baseline or allow-rule lookup, in EVERY mode
// (T6 review obligation, restated in this task's own dispatch: "stage 5's OWN allow-rule resolution
// must consult them in EVERY mode ... never resolve 'allow' at stage 5"). Returning "mustPrompt" (a
// terminal kind evaluate() never lets reach stage 5) is exactly how that's enforced structurally —
// there is no code path from "critical/protected" back into `findMatchingRuleEntry`.

function resolveCriticalRemoval(mode: PermissionMode, reason: string | undefined): ModeStageResult {
  const message = `Denied: critical removal requires approval${reason ? ` (${reason})` : ""} (WS-07 §6.8)`;
  // WS-07 §6.8 matrix: EVERY mode either denies outright (dontAsk) or prompts/callback — never an
  // auto-allow, not even bypassPermissions ("still prompts/callback", §6.4/§6.8) and not even plan
  // with session bypass enabled (§6.8's plan row carries no bypass carve-out, unlike §6.7's).
  if (mode === "dontAsk") return { kind: "deny", message };
  return { kind: "mustPrompt", message, origin: "critical" };
}

function resolveProtectedWrite(mode: PermissionMode, ctx: EvaluationContext, call: PermissionCall): ModeStageResult {
  const message = "Denied: protected path write requires approval (WS-07 §6.7)";
  // WS-07 §6.7 matrix, verbatim per mode:
  if (mode === "dontAsk") return { kind: "deny", message };
  if (mode === "bypassPermissions") return { kind: "allow" };
  // "allowed when bypass enabled for that session" — the §6.4/§6.5 relaxation carve-out this
  // task's own instruction names. `plan`'s classifier-active branch (Task 12) is handled by
  // evaluate()'s own mustPrompt-routing, below — by the time this function returns "mustPrompt",
  // sessionBypassEnabled is ALREADY guaranteed false for `plan` (this line just intercepted the
  // true case), so evaluate()'s own borrow-gate never needs to re-check bypass for THIS origin.
  if (mode === "plan" && ctx.sessionBypassEnabled === true) return { kind: "allow" };
  // Task 8 (WS-07 §7.1's `blockedPath`): the SAME per-tool path extraction driving
  // REAL_SPECIAL_CHECKS.isProtectedWrite itself (this function's own caller already confirmed
  // isProtectedWrite is true, so at least one candidate path exists) — the first candidate is
  // reported; a compound Bash command touching several protected paths at once reports only one,
  // a judgment call (no ordering guarantee is documented anywhere in scope).
  const candidatePaths = extractCandidateWritePaths(call, ctx);
  const blockedPath = candidatePaths[0] !== undefined ? resolve(ctx.cwd, candidatePaths[0]) : undefined;
  return { kind: "mustPrompt", message, origin: "protected", ...(blockedPath !== undefined ? { blockedPath } : {}) };
}

function isBashRecognizedWrite(call: PermissionCall): boolean {
  // Any write-shaped path at all (a blessed fs-op OR a bare redirect target) counts as a "write"
  // for plan-mode withholding purposes — WS-07 §6.2's narrower "kind" distinction (blessed vs.
  // "other") only matters for acceptEdits' own auto-approve eligibility, not for plan's broader
  // "is this a write" question. `recognizeEditOperation` here needs no `sessionRoot` -- this is only
  // ever called for Bash/Monitor (see isPlanWriteShaped below), never CronCreate.
  return recognizeEditOperation(call) !== null;
}

function isPlanWriteShaped(call: PermissionCall): boolean {
  // Task 8 (RULING P3-E): NotebookEdit joins Edit/Write -- a notebook edit is exactly as much a
  // plan-mode-withheld write as a file edit is (WS-06 §3.1's own "class edit" pin for all three).
  if (call.toolName === "Edit" || call.toolName === "Write" || call.toolName === "NotebookEdit") return true;
  // RULING P3-K (fix wave, P3 close-out): CronCreate(durable:true) is write-shaped -- checked
  // directly via the flag alone (no ctx/sessionRoot needed for THIS yes/no classification question,
  // unlike the exact write-PATH evaluator.ts's extractCandidateWritePaths needs for protected/deny
  // purposes). In practice this branch is likely unreachable in evaluateModeStage's own `plan` arm:
  // the target is always under the brand's dot-dir, which `isProtectedWrite` ALREADY intercepts,
  // unconditionally, before evaluateModeStage ever reaches its per-mode arms -- kept anyway per the
  // ruling's own literal text and as a documented belt-and-suspenders, not dead weight to prune.
  if (call.toolName === "CronCreate") return call.input["durable"] === true;
  // I2 (fix wave, P3 close-out): Monitor's command half joins Bash here too.
  if (call.toolName === "Bash" || call.toolName === "Monitor") return isBashRecognizedWrite(call);
  return false;
}

function evaluateModeStage(call: PermissionCall, ctx: EvaluationContext, mode: PermissionMode): ModeStageResult {
  // Standing exceptions run FIRST, unconditionally, before any mode-specific baseline — see this
  // section's own header. Order (critical before protected) is not observationally load-bearing at
  // P2 (isCriticalRemoval only ever fires for a Bash rm/rmdir; isProtectedWrite fires for
  // Edit/Write/Bash-fs-op/redirect paths — the two are disjoint in practice), critical is checked
  // first as the narrower, stronger circuit breaker.
  const critical = ctx.specialChecks.isCriticalRemoval(call, ctx);
  if (critical.critical) return resolveCriticalRemoval(mode, critical.reason);
  if (ctx.specialChecks.isProtectedWrite(call, ctx)) return resolveProtectedWrite(mode, ctx, call);

  if (mode === "bypassPermissions") {
    // Standing exceptions above already intercepted anything critical/protected; everything else
    // is an unconditional auto-allow under bypass (WS-07 §6.4).
    return { kind: "allow" };
  }

  // --- Phase 5 fix wave, B-H1(a): `autoAllowBashIfSandboxed` (WS-12 §1's composition MUST) ---------
  //
  // The setting had TWO type declarations (`sandbox/profile.ts:47`, `sdk/protocol/config.ts:153`) and
  // ZERO consumers -- a settings key that parses and does nothing, which is the "accepted, preserved,
  // inert" posture applied to a PERMISSIVE feature. The plan never sanctioned that: an inert
  // RESTRICTIVE key is harmless, an inert permissive one silently withholds a capability the host
  // asked for.
  //
  // PLACED AFTER the standing exceptions and BEFORE the mode baselines, so the ordering that makes
  // it safe is structural rather than argued: a critical removal and a protected write are already
  // intercepted above and can never reach this arm, and stage-2/3 deny/ask rules run BEFORE the mode
  // stage in `evaluate()` -- so this can only ever silence a prompt for a call nothing else objected
  // to. `bypassPermissions` returns above and is unaffected; `plan` is deliberately excluded (a plan
  // session's whole contract is that it does not act).
  //
  // THE PREDICATE IS INJECTED, not computed here: whether a given Bash call will ACTUALLY run under
  // the sandbox depends on the session's resolved `SandboxSettings`, on `sandbox-exec` being
  // available on this host, and on the call's own `dangerouslyDisableSandbox` (RULING P3-J -- which
  // must STILL prompt, because a call that opts out of the fence has none of the containment this
  // allow is paying for). `evaluator.ts` knows none of those; `engine.ts` knows all three.
  if ((mode === "default" || mode === "dontAsk" || mode === "acceptEdits" || mode === "auto") && ctx.bashRunsSandboxed?.(call) === true) {
    return { kind: "allow" };
  }

  if (mode === "dontAsk" || mode === "default") {
    // default / dontAsk share the IDENTICAL baseline (WS-07 §6.1/§6.3: both "still permit
    // built-in/read-only operations") — their divergence is the post-allow-stage fallback in
    // evaluate() below, not this baseline check.
    if (isBuiltInReadOnly(call, ctx)) return { kind: "allow" };
    // RULING P3-K (fix wave, controller ruling, P3 close-out): WS-06 §1.4's Manual-mode evidence
    // column marks the task/mode class "No" (ordinarily no prompt) -- these fall to stage 6 today
    // and get denied ("no canUseTool handler answered this unmatched action"), silently diverging
    // from the pinned artifact for every one of these tools in a plain default-mode session. Deny/
    // ask rules (stages 2/3) and the standing exceptions above still apply FIRST -- this arm is only
    // reached once nothing upstream already resolved the call, exactly like isBuiltInReadOnly's own
    // position in this same branch.
    if (isTaskModeClassSilentAllow(call)) return { kind: "allow" };
    return { kind: "unresolved" };
  }

  if (mode === "acceptEdits") {
    // WS-07 §6.2: auto-approval is path-bounded (cwd/additionalDirectories), AFTER normalization +
    // symlink checks (isWithinBounds composes matchFileRuleAtBothEnds, rider 2) + protected/critical
    // (already excluded above) + Read/Edit deny rules — the latter is enforced generally at STAGE 2
    // now (T6-review obligation), so by the time this arm runs, a Read-deny-blocked path has
    // ALREADY been denied upstream; this arm doesn't need to re-check it.
    if (isBuiltInReadOnly(call, ctx)) return { kind: "allow" };
    // RULING P3-K-2 (fix wave round 2): the task/mode-class silent-allow set now applies here too --
    // "acceptEdits must never be stricter than default for a no-prompt class." Durable CronCreate
    // returns false from this check (it's the class's own named exception, not a member), so it
    // falls through unaffected to the write-recognition below, which `isProtectedWrite`'s standing
    // exception already intercepted before this arm was ever reached anyway.
    if (isTaskModeClassSilentAllow(call)) return { kind: "allow" };
    // RULING P3-K: sessionRoot threaded through for CronCreate(durable) -- in practice unreachable
    // here (isProtectedWrite's own dot-dir coverage always intercepts it first, above), kept for
    // consistency with every other recognizeEditOperation call site in this file.
    // I2 (fix wave, P3 close-out): Monitor is EXCLUDED from this arm's auto-approve outcome on
    // purpose -- the review's own I2 text scopes the fix to closing the bypass/allow-rule hole
    // ("acceptEdits: fine (Monitor never auto-approves)"), never to GRANTING Monitor a new
    // auto-approve path it never had (WS-07 §13: "stricter, never looser"). `call.toolName !==
    // "Monitor"` gates the ALLOW outcome only -- recognizeEditOperation itself still runs on Monitor
    // (feeding protected/critical/plan-write detection above and in isPlanWriteShaped, which IS what
    // I2 asked for); only the acceptEdits/auto-mode SILENT ALLOW stays Bash-only.
    const recognized = call.toolName !== "Monitor" ? recognizeEditOperation(call, { sessionRoot: ctx.sessionRoot, ...(ctx.brand !== undefined ? { brand: ctx.brand } : {}) }) : null;
    if (recognized !== null && (recognized.kind === "edit" || recognized.kind === "bashFsOp")) {
      // "other" (a redirect, or a subcommand mixed with an unblessed one) NEVER auto-approves here
      // — it falls through to "unresolved" below, same as an unrecognized command.
      if (recognized.paths.every((p) => isWithinBounds(p, ctx))) return { kind: "allow" };
    }
    // Out-of-root, unrecognized, or "other"-kind: WS-07 §2 stage 5's standing-exceptions list does
    // NOT name "acceptEdits out-of-root" — an explicit allow rule may still rescue it at stage 5,
    // unlike critical/protected/plan-writes. Falls through to the ordinary pipeline.
    return { kind: "unresolved" };
  }

  if (mode === "plan") {
    // WS-07 §6.5 / phase ruling 6: reads proceed; writes withheld; "ordinary allow rules do not
    // silently convert writes into execution" — a write in plan mode is a THIRD standing exception
    // (named explicitly in WS-07 §2 stage 5's own list: "plan-mode write restrictions"), so it must
    // skip stage 5 exactly like critical/protected, UNLESS session bypass relaxes plan entirely
    // (§6.4/§6.5: "session bypass-enabled + plan = writes execute" — this task's own instruction).
    // `allow` here, deliberately, NOT `unresolved`: the §6.7 matrix pins protected writes as
    // "allowed when bypass enabled for that session" (an unconditional allow, not "falls back to
    // the ordinary pipeline") — an ORDINARY write cannot be treated stricter than a protected one,
    // and "writes execute" must survive T8's own future flip of the generic bottom-of-pipeline
    // fallback (an `unresolved` result here would traverse stage 5/6 and could start prompting, or
    // even denying, the moment that fallback changes, silently breaking this relaxation).
    if (isBuiltInReadOnly(call, ctx)) return { kind: "allow" };
    // RULING P3-K-2 (fix wave round 2): the task/mode-class silent-allow set applies under plan too
    // -- none of these thirteen tools is a write, so plan's own write-withholding (below) never had
    // any claim on them; leaving them to fall to "unresolved" (stage 6) was exactly the same
    // stricter-than-default inversion acceptEdits/auto had. Durable CronCreate returns false here
    // (the class's own named exception), so it falls through to isPlanWriteShaped's own independent
    // CronCreate(durable) check below -- moot in practice since isProtectedWrite's standing exception
    // already intercepted it before this arm was ever reached, but kept for consistency.
    if (isTaskModeClassSilentAllow(call)) return { kind: "allow" };
    if (isPlanWriteShaped(call)) {
      if (ctx.sessionBypassEnabled === true) return { kind: "allow" };
      // origin "planWrite" — deliberately EXCLUDED from the plan classifier borrow (Task 12, WS-07
      // §6.5): "source edits are withheld" is unconditional prose, not "withheld unless the
      // classifier says otherwise" — §6.5's own borrow sentence names "exploratory commands," never
      // writes. evaluate() checks this origin tag specifically to skip the borrow for exactly this
      // case (see its own mustPrompt-handling comment).
      return { kind: "mustPrompt", message: PLAN_WRITE_WITHHELD_MESSAGE, origin: "planWrite" };
    }
    // Non-write, non-read-only exploratory action (e.g. an arbitrary shell command with no
    // filesystem-write shape) — WS-07 §5's plan row: "Prompt or classifier for exploratory shell".
    // Task 12: the classifier borrow for THIS bucket is applied by evaluate() itself, at the
    // generic post-stage-5 fallback (this "unresolved" result reaches stage 5's ordinary allow-rule
    // lookup first, unaffected by auto's own suspension matcher since mode !== "auto" here, exactly
    // as before) — never a third bespoke terminal outcome invented in this function.
    return { kind: "unresolved" };
  }

  // mode === "auto" (WS-07 §6.6/§10.1 step 4): built-in read-only PLUS "ordinary in-cwd edits" —
  // the SAME bounded-edit recognition acceptEdits' own arm above uses. Standing exceptions
  // (critical/protected) already ran above and would have returned before this line for anything
  // they flag. Anything else (out-of-root edits, unrecognized/"other"-kind Bash, unmatched actions)
  // is "unresolved" here — stage 5's own auto-aware allow-rule lookup (suspension-filtered, see
  // evaluate()'s own stage-5 comment) and then the real classifier (ctx.autoEngine, via
  // evaluate()'s resolveAutoDecision) get a chance next, never a silent allow.
  if (isBuiltInReadOnly(call, ctx)) return { kind: "allow" };
  // RULING P3-K-2 (fix wave round 2): the task/mode-class silent-allow set applies under auto too --
  // "skips the classifier entirely, exactly like built-in read-only" (the ruling's own words).
  // Without this, an unresolved task-class call falls through to stage 5 (no rule) and then this
  // mode's own post-stage-5 fallback, which for `auto` means the REAL classifier (resolveAutoDecision)
  // gets consulted and fails closed ("Blocked by classifier") for a call that was never supposed to
  // prompt OR be classified at all -- the same stricter-than-default inversion acceptEdits/plan had.
  // Durable CronCreate returns false here (the class's own named exception), so it falls through to
  // the write-recognition below -- moot in practice since isProtectedWrite's standing exception
  // already intercepted it before this arm was ever reached, routing it to auto's own PRE-EXISTING
  // (Task 12) classifier path for a protected-write mustPrompt, not this arm's write-recognition.
  if (isTaskModeClassSilentAllow(call)) return { kind: "allow" };
  // I2 (fix wave, P3 close-out): Monitor excluded from THIS arm's auto-approve outcome too -- see
  // the acceptEdits arm's own identical comment, above, for the full rationale.
  const recognizedForAuto = call.toolName !== "Monitor" ? recognizeEditOperation(call, { sessionRoot: ctx.sessionRoot, ...(ctx.brand !== undefined ? { brand: ctx.brand } : {}) }) : null;
  if (recognizedForAuto !== null && (recognizedForAuto.kind === "edit" || recognizedForAuto.kind === "bashFsOp") && recognizedForAuto.paths.every((p) => isWithinBounds(p, ctx))) {
    return { kind: "allow" };
  }
  return { kind: "unresolved" };
}

// ---------------------------------------------------------------------------------------------------
// The main evaluator
// ---------------------------------------------------------------------------------------------------

// T10 (WS-08 §6): fires immediately before EVERY ctx.promptStage.prompt() call site below (stage
// 3's ask-match/mandatory-interaction/hook-forced-ask gate; the mustPrompt standing-exception site;
// stage 6's generic fallback) — "a decision is about to be requested." A non-null answer here takes
// canUseTool's place ENTIRELY for that one decision point (mechanism "hook", canUseTool never
// invoked); a null answer (no PermissionRequest hook registered, or every matched hook stayed
// silent) means the CALLER falls through to its own existing ctx.promptStage.prompt() call,
// unchanged, mechanism "canUseTool" — the two mechanisms normalize into the SAME
// PermissionDecisionRecord shape (T6's own cross-task pin), provenance preserved via `mechanism`.
//
// The §3 non-override floor ("a PermissionRequest allow is subject to the same non-override floor
// as any hook allow") holds STRUCTURALLY here, not via a runtime check: every call site below only
// ever reaches this helper AFTER stage 2's deny rules, the Read-deny-blocks-Edit check, and (at the
// standing-exception site) the critical-removal/protected-write checks have already run and already
// decided this exact call needs a prompt — there is no later stage left for an allow returned here
// to retroactively bypass (T7's own structural-guarantee precedent for stage-5's standing
// exceptions, extended one seam further).
async function tryPermissionRequestHook(
  call: PermissionCall,
  ctx: EvaluationContext,
  meta: PromptStageMeta,
  policyVersion: number,
  carriedTransform: Record<string, unknown> | undefined,
): Promise<PermissionDecisionRecord | undefined> {
  const hookResult = await ctx.hookStage.permissionRequest(call, ctx, meta);
  if (hookResult === null) return undefined;
  const transformedInput = hookResult.transformedInput ?? carriedTransform;
  if (hookResult.decision === "deny") {
    return {
      decision: "deny",
      mechanism: "hook",
      policyVersion,
      ...(hookResult.hookId !== undefined ? { hookId: hookResult.hookId } : {}),
      ...(hookResult.message !== undefined ? { message: hookResult.message } : {}),
      ...(hookResult.interrupt !== undefined ? { interrupt: hookResult.interrupt } : {}),
      ...(transformedInput !== undefined ? { transformedInput } : {}),
    };
  }
  return {
    decision: "allow",
    mechanism: "hook",
    policyVersion,
    ...(hookResult.hookId !== undefined ? { hookId: hookResult.hookId } : {}),
    ...(transformedInput !== undefined ? { transformedInput } : {}),
    // WS-07 §7.2 / WS-08 §6: a PermissionRequest allow's updatedPermissions applies through the
    // IDENTICAL downstream machinery as canUseTool's own (engine.ts's updatedPermissions loop reads
    // `decision.updatedPermissions` off the record regardless of `mechanism` — reuse, not a new
    // code path) — policy-state.ts's own authority gate (applyUpdate) still governs whether a
    // suggested destination is actually permitted, exactly as it does for a canUseTool answer
    // (WS-08 §11: "a hook response ... can never ... change permission settings beyond its
    // documented output shape").
    ...(hookResult.updatedPermissions !== undefined ? { updatedPermissions: hookResult.updatedPermissions } : {}),
  };
}

function buildRecordFromPromptResult(
  result: PromptDecision,
  policyVersion: number,
  carriedTransform: Record<string, unknown> | undefined,
): PermissionDecisionRecord {
  const transformedInput = result.transformedInput ?? carriedTransform;
  return {
    decision: result.decision,
    mechanism: "canUseTool",
    policyVersion,
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(transformedInput !== undefined ? { transformedInput } : {}),
    ...(result.interrupt !== undefined ? { interrupt: result.interrupt } : {}),
    ...(result.updatedPermissions !== undefined ? { updatedPermissions: result.updatedPermissions } : {}),
    ...(result.decisionClassification !== undefined ? { decisionClassification: result.decisionClassification } : {}),
  };
}

// Task 12 (WS-07 §6.5): "when auto is available and useAutoModeDuringPlan is enabled (current
// default)". `ctx.policy.autoConfig` is `undefined` in the overwhelming majority of P2 fixtures/
// callers (no settings-file loader exists to populate it yet) — absence reads as "use the §6.5
// default," never as "the borrow is off," so every pre-Task-12 plan-mode fixture that never set
// autoConfig at all keeps attempting the borrow (and, with the only classifier P2 ships being
// alwaysNoVerdictClassifier, keeps falling through to the identical pre-existing prompt path —
// see resolveAutoDecision's own two call sites in evaluate() for exactly where "wiring" and
// "practical outcome" diverge).
function isAutoModeDuringPlanEnabled(ctx: EvaluationContext): boolean {
  return ctx.policy.autoConfig?.useAutoModeDuringPlan ?? AUTO_MODE_DEFAULT_USE_AUTO_MODE_DURING_PLAN;
}

// Task 12 (WS-07 §10.1 steps 5-8 / §6.6): the ONLY place evaluate() ever calls ctx.autoEngine for
// a genuine `auto`-mode decision. Shared by TWO call sites below: the standing-exception
// "mustPrompt" branch (critical removal / protected write under `auto` — the §6.7/§6.8 "auto:
// classifier" cells) and the generic post-stage-5 fallback (everything else `auto` never
// auto-approved above, and no surviving narrow allow rescued at stage 5).
//
// `fallbackToPrompt` reuses the EXACT hook-then-canUseTool pathway every other mode's own
// mustPrompt/stage-6 branches already use — mechanism ends up "hook" or "canUseTool" (never
// "autoEngine") when a human genuinely answers, which is the CORRECT attribution (a human, not the
// classifier, made this call); `ctx.autoEngine.noteFallbackResolution` is invoked afterward so an
// allowed action here can un-trip a purely-consecutive-triggered fallback (WS-07 §10.5), the SAME
// place a real host's canUseTool answer would naturally land for any other mode. Otherwise `allow`
// and `deny`/`no_verdict` map directly, the latter with the stable model-visible string (§10.6-5) —
// evaluate() never invents a richer message for a classifier-driven denial.
async function resolveAutoDecision(
  call: PermissionCall,
  ctx: EvaluationContext,
  policyVersion: number,
  carriedTransform: Record<string, unknown> | undefined,
): Promise<PermissionDecisionRecord> {
  const verdict = await ctx.autoEngine.classify(call, ctx);

  if (!verdict.fallbackToPrompt) {
    if (verdict.verdict === "allow") {
      return { decision: "allow", mechanism: "autoEngine", policyVersion, ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}) };
    }
    // "deny" or "no_verdict" — both fail closed with the IDENTICAL stable string (WS-07 §10.6-5:
    // the model must never be able to distinguish a genuine block from a classifier failure mode).
    return {
      decision: "deny",
      mechanism: "autoEngine",
      policyVersion,
      message: BLOCKED_BY_CLASSIFIER_MESSAGE,
      ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
    };
  }

  // Fallback active (WS-07 §10.5): route through the SAME hook-then-canUseTool pathway every other
  // would-prompt call uses — a null promptStage answer still fails closed here, exactly like every
  // other mode's own generic fallback (headless = denied-and-continue, never a hang).
  const meta: PromptStageMeta = {
    decisionReason: "auto-mode fallback: the classifier is paused after repeated blocks (WS-07 §10.5)",
    ...(call.toolUseId !== undefined ? { toolUseID: call.toolUseId } : {}),
    ...(call.agentId !== undefined ? { agentID: call.agentId } : {}),
  };
  const hookAnswer = await tryPermissionRequestHook(call, ctx, meta, policyVersion, carriedTransform);
  let record: PermissionDecisionRecord;
  if (hookAnswer !== undefined) {
    record = hookAnswer;
  } else {
    const result = await ctx.promptStage.prompt(call, ctx, meta);
    if (result === null) {
      // Item 11 (P2 fix-wave): the headless-fallback synthesized deny — no PermissionRequest hook
      // (checked above) and no canUseTool answered this fallback-routed prompt at all. See
      // AutoEngine.noteHeadlessFallbackDenial's own header for why this must be a seam call, not an
      // audit record built inline here (evaluator.ts has no access to createAutoEngine's own audit
      // recorder/sessionId closure state).
      await ctx.autoEngine.noteHeadlessFallbackDenial?.(call, ctx);
      record = {
        decision: "deny",
        mechanism: "autoEngine",
        policyVersion,
        message: "Denied: auto-mode fallback requires human approval and no prompt handler answered (WS-07 §10.5)",
        ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
      };
    } else {
      record = buildRecordFromPromptResult(result, policyVersion, carriedTransform);
    }
  }
  ctx.autoEngine.noteFallbackResolution?.(record.decision === "allow" ? "allow" : "deny");
  return record;
}

export async function evaluate(call: PermissionCall, ctx: EvaluationContext): Promise<PermissionDecisionRecord> {
  // Snapshot discipline: policyVersion is stamped from ctx.policy NOW (evaluation start), not at
  // completion — see EvaluationContext.policy's own comment for why, and engine.ts's re-evaluation
  // loop for how the caller uses this stamp.
  const { policy } = ctx;
  const policyVersion = policy.version;

  // --- Stage 1: PreToolUse hooks --------------------------------------------------------------
  const hookResult = await ctx.hookStage.preToolUse(call, ctx);
  if (hookResult.decision === "deny") {
    return {
      decision: "deny",
      mechanism: "hook",
      policyVersion,
      ...(hookResult.hookId !== undefined ? { hookId: hookResult.hookId } : {}),
      ...(hookResult.message !== undefined ? { message: hookResult.message } : {}),
      ...(hookResult.interrupt !== undefined ? { interrupt: hookResult.interrupt } : {}),
    };
  }
  // See HookStage's own interface comment: "allow"/"ask" are advisory-in-POSITION only here --
  // "allow" never overrides a later stage (unchanged). T10-CARRY 1 (WS-08 §3): "ask" is captured
  // but NOT resolved yet -- it forces stage 3's prompt path below UNLESS stage 2's deny rules (next)
  // fire first, mirroring the §4 reducer's own deny > ask rank one level up this pipeline. A
  // hook-forced ask reaching stage 3 is checked BEFORE stage 4's standing exceptions (critical
  // removal / protected write) by construction — both paths only ever end in a genuine prompt or a
  // fail-closed denial, never an auto-allow, so there is no security gap in letting stage 3's
  // (textually earlier) ask-handling claim it first; WS-07 §2's own stage order already places "ask"
  // ahead of "mode" (stage 4), which is exactly where a hook's forced ask semantically belongs.
  const hookForcedAsk = hookResult.decision === "ask";
  const hookAskId = hookForcedAsk ? hookResult.hookId : undefined;
  const hookAskMessage = hookForcedAsk ? hookResult.message : undefined;
  // Task 11 (WS-08 §7): a hook-forced "defer" is captured the SAME way "ask" is (non-terminal here
  // — a stage-2 deny rule, checked next, still wins first) but is resolved on ITS OWN, stronger
  // terms once past stage 2 — see the new branch immediately after stage 2 below.
  const hookForcedDefer = hookResult.decision === "defer";
  const hookDeferId = hookForcedDefer ? hookResult.hookId : undefined;
  const hookDeferMessage = hookForcedDefer ? hookResult.message : undefined;
  // Finding 1 (P2 fix-wave, CRITICAL): captured the SAME way ask/defer are -- non-terminal here, a
  // stage-2 deny rule (and the defer branch, immediately below) still win first -- but "allow" is
  // resolved much later than ask/defer, right after stage 3's gate, once the standing exceptions
  // have ALSO been consulted (see the new branch below stage 3 for the full rationale).
  const hookAllow = hookResult.decision === "allow";
  const hookAllowId = hookAllow ? hookResult.hookId : undefined;
  const effectiveCall: PermissionCall = hookResult.transformedInput !== undefined ? { ...call, input: hookResult.transformedInput } : call;
  const carriedTransform = hookResult.transformedInput;

  // --- Stage 2: deny rules ---------------------------------------------------------------------
  // RULING P5-B (+ SDK 0.0.4's auto-memory arm): the ONE skip applied here -- see
  // projectsCarveOutSkip. `undefined` for every call that is not entirely a write into a session's
  // own persisted-workflow-script directory or into a project's own auto-memory directory, which is
  // every call in every pre-P5 fixture, so stage 2 is byte-identical for them.
  const carveOutSkip = projectsCarveOutSkip(effectiveCall, ctx);
  const denyEntry = findMatchingRuleEntry(policy.rules, effectiveCall, "deny", ctx, carveOutSkip !== undefined ? { skip: carveOutSkip } : undefined);
  if (denyEntry) {
    return {
      decision: "deny",
      mechanism: "rule",
      policyVersion,
      source: denyEntry.source,
      ruleRef: formatRuleRef(denyEntry),
      message: ruleDenialMessage(denyEntry),
      ...(denyEntry.rule.isBareEquivalent ? { deniedBareSchemaRemoval: true } : {}),
      ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
    };
  }

  // Task 7 / T6-review obligation: a Read deny also blocks Edit/Write on the same path (WS-07
  // §3.1), enforced generally at stage 2, for every mode — not merely inside acceptEdits.
  const readBlockEntry = findFileDenyBlockingEdit(effectiveCall, ctx);
  if (readBlockEntry) {
    return {
      decision: "deny",
      mechanism: "rule",
      policyVersion,
      source: readBlockEntry.source,
      ruleRef: formatRuleRef(readBlockEntry),
      message: `Denied: deny rule ${formatRuleRef(readBlockEntry)} blocks writes to this path (WS-07 §3.1)`,
      ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
    };
  }

  // --- A hook-forced "defer" resolves HERE, between stage 2 and stage 3 (Task 11, WS-08 §7) -------
  //
  // No stage-2 deny rule fired (this function would already have returned above) — defer's own
  // rank (WS-08 §4: deny > defer > ask > allow > none) generalizes one level up this pipeline, the
  // SAME move T10-CARRY 1 already made for "ask": a hook-forced defer OUTRANKS a matched ask rule
  // (stage 3, next), so it is resolved HERE, unconditionally, rather than joining stage 3's
  // askEntry/isMandatoryAskUserQuestion/hookForcedAsk gate. Judgment call (documented, not spec-
  // literal — WS-08 §4's rank table is scoped to composing several hooks for ONE event into one
  // decision; nothing in WS-07/WS-08 states how a stage-1 hook decision ranks against a stage-3
  // RULE decision) — consistent with the ask precedent one stage earlier and with "never silently
  // under-enforce a stronger signal with a weaker one."
  //
  // `dontAsk` converts this into an immediate denial, mirroring its own "ask" precedent (T10-CARRY
  // 1) one level further: WS-07 §6.3's "every would-prompt outcome becomes a denial... canUseTool is
  // NEVER called" applies at least as strongly to defer as to ask — defer's whole purpose is a LATER
  // synchronous resolution, which is fundamentally incompatible with dontAsk's "resolve everything
  // now, deterministically" contract (WS-07 §6.3: "never a pending approval nobody can answer" is
  // closer to verbatim support for this than to a stretch). Critically, this happens BEFORE any
  // durable record is ever created — a dontAsk session must never park an approval nobody in that
  // mode is ever allowed to answer.
  //
  // `bypassPermissions` does NOT exempt a hook-forced defer (mirrors the identical ask-under-bypass
  // precedent below in stage 3) — it still parks; only the mode-4/5 auto-allow arms this call would
  // otherwise reach are what bypass widens, and those are never reached here at all.
  //
  // The actual durable-approval RECORD (persistence, lifecycle/audit events, the synthetic
  // `[deferred]` tool_result) is engine.ts's job, not this pure decision function's — mirrors how
  // this function never itself builds a denied tool_result either; it only ever reports what
  // *decision* was reached. `mechanism: "hook"` mirrors deny/ask's own hook-mechanism attribution.
  if (hookForcedDefer) {
    if (policy.mode === "dontAsk") {
      return {
        decision: "deny",
        mechanism: "hook",
        policyVersion,
        ...(hookDeferId !== undefined ? { hookId: hookDeferId } : {}),
        message: hookDeferMessage ?? "Denied: dontAsk mode denies a PreToolUse hook's forced durable approval (WS-07 §6.3/WS-08 §7)",
        ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
      };
    }
    return {
      decision: "defer",
      mechanism: "hook",
      policyVersion,
      ...(hookDeferId !== undefined ? { hookId: hookDeferId } : {}),
      ...(hookDeferMessage !== undefined ? { message: hookDeferMessage } : {}),
      ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
    };
  }

  // --- Stage 3: ask rules + mandatory interaction -----------------------------------------------
  const askEntry = findMatchingRuleEntry(policy.rules, effectiveCall, "ask", ctx);
  // Task 8 (WS-07 §8): AskUserQuestion is MANDATORY interaction in every prompt-capable mode, with
  // or without a configured ask rule — "allow rules, acceptEdits, auto, and bypassPermissions never
  // invent an answer" (checked here, at stage 3, strictly BEFORE stage 4's mode baseline and stage
  // 5's allow-rule lookup, so no allow rule or mode-level auto-approval can ever reach it first) and
  // "dontAsk denies it" (the SAME dontAsk-converts-to-denial branch below already covers this, since
  // it's keyed on `policy.mode`, not on `askEntry` specifically). A DENY rule targeting the tool
  // still wins outright — stage 2 already returned before this stage ever runs.
  const isMandatoryAskUserQuestion = effectiveCall.toolName === ASK_USER_QUESTION_TOOL_NAME;
  // RULING P3-J (Task 8, P3 close-out; WS-12 §4/§11): "the call is always surfaced for approval,
  // under every policy, and no permission rule may silence it" — a Bash call carrying
  // `dangerouslyDisableSandbox: true` joins AskUserQuestion as mandatory interaction, for the
  // IDENTICAL structural reason: checked here, at stage 3, strictly before stage 4's mode baseline
  // (so acceptEdits/auto never auto-approve it) and stage 5's allow-rule lookup (so a `Bash(*)`
  // allow — or any other Bash allow rule — never silences it). "Under every policy" is true by
  // CONSTRUCTION once this line is added: stage 3 runs unconditionally, for every mode including
  // `bypassPermissions` (mirroring how AskUserQuestion is already mandatory under bypass, WS-07
  // §6.4's own "does NOT override ... AskUserQuestion" carve-out) — the only mode that converts this
  // into an outright denial is `dontAsk` (the SAME dontAsk-converts-to-denial branch below, keyed on
  // `policy.mode` alone, already covers it). CAPTURE-PENDING (WS-12 §4's own text): a future
  // differential capture MAY show the real product loosens the bypass cell specifically for this
  // override; until then this is the spec-literal reading, not a guess, and the override's own
  // request flag is preserved verbatim in `effectiveCall.input` regardless of how this resolves (a
  // PreToolUse hook's `transformedInput` is the only thing that could ever change it, exactly like
  // any other field) — engine.ts still records it as "override-requested" on the sandbox posture
  // whenever bash.ts's own executor eventually runs (see registry.ts's ToolExecutionContext.session
  // and WS-12 §4's "the result MUST record the sandbox-override state"), never silently normalized
  // away by this stage regardless of allow/deny outcome.
  const isMandatoryDangerousBashOverride = effectiveCall.toolName === "Bash" && effectiveCall.input["dangerouslyDisableSandbox"] === true;
  // Phase 4 Task 3 (WS-09 §6): a FIFTH mandatory-interaction reason, structurally identical to
  // RULING P3-J immediately above (same stage-3 placement, same "never rule-silenced, never
  // auto-approved by acceptEdits/auto, dontAsk denies it" shape) -- see EvaluationContext.
  // requiresInteraction's own header for why this is an injected seam rather than a direct registry
  // lookup. `?.` + `=== true` mirrors this file's own established "exact boolean, never a
  // truthy-coercion" posture for a descriptor-derived signal (registry.ts's own `_meta['anthropic/
  // requiresUserInteraction'] === true` check for the identical reason).
  const isMandatoryMcpInteraction = ctx.requiresInteraction?.(effectiveCall.toolName) === true;
  // T10-CARRY 1: a hook-forced ask (no rule matched) joins this gate as a reason to reach the
  // prompt path — priority among the five, when more than one applies simultaneously, is askEntry >
  // isMandatoryAskUserQuestion > isMandatoryDangerousBashOverride > isMandatoryMcpInteraction >
  // hookForcedAsk (a documented judgment call: the more specific attribution's own message/mechanism
  // wins; every case still ends in the identical "prompt, then fail closed on no answer" behavior
  // regardless of which one is picked). In practice the first four are mutually exclusive (a call
  // cannot simultaneously BE AskUserQuestion and Bash and an MCP tool), so this ordering is a
  // tie-break with no live ambiguity today.
  if (askEntry || isMandatoryAskUserQuestion || isMandatoryDangerousBashOverride || isMandatoryMcpInteraction || hookForcedAsk) {
    if (policy.mode === "dontAsk") {
      // WS-07 §6.3: "dontAsk converts all of these into denial." An actual ask-RULE match keeps its
      // own rule-denial message/mechanism; AskUserQuestion / a hook-forced ask with no matching rule
      // each get their own dedicated denial (mechanism "mode" / "hook" respectively — no rule was
      // involved).
      if (askEntry) {
        return {
          decision: "deny",
          mechanism: "rule",
          policyVersion,
          source: askEntry.source,
          ruleRef: formatRuleRef(askEntry),
          message: ruleDenialMessage(askEntry),
          ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
        };
      }
      if (isMandatoryDangerousBashOverride) {
        // RULING P3-J: dontAsk denies the override outright — "every would-prompt outcome becomes a
        // denial" (WS-07 §6.3) applies here exactly as it does to AskUserQuestion just below; the
        // message names the flag by name so the transcript records WHAT was refused, not just that
        // something was.
        return {
          decision: "deny",
          mechanism: "mode",
          policyVersion,
          message: "Denied: dontAsk mode denies a Bash call requesting dangerouslyDisableSandbox (WS-07 §6.3; WS-12 §4/§11, RULING P3-J)",
          ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
        };
      }
      if (isMandatoryMcpInteraction) {
        // Phase 4 Task 3 (WS-09 §6): mechanism "mode" — mirrors isMandatoryDangerousBashOverride's
        // own dontAsk branch exactly (no rule was involved; the descriptor's own metadata forced
        // this, and dontAsk's own §6.3 "every would-prompt outcome becomes a denial" applies
        // identically here).
        return {
          decision: "deny",
          mechanism: "mode",
          policyVersion,
          message: `Denied: dontAsk mode denies '${effectiveCall.toolName}' -- marked requiresUserInteraction (WS-07 §6.3; WS-09 §6)`,
          ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
        };
      }
      if (hookForcedAsk) {
        // mechanism "hook" (not "mode"): a hook is the actual, attributable reason this needed
        // asking, unlike AskUserQuestion's tool-identity-driven mandate just below, which has no
        // more specific mechanism to point to.
        return {
          decision: "deny",
          mechanism: "hook",
          policyVersion,
          ...(hookAskId !== undefined ? { hookId: hookAskId } : {}),
          message: hookAskMessage ?? "Denied: dontAsk mode denies a PreToolUse hook's forced interactive approval (WS-07 §6.3/WS-08 §3)",
          ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
        };
      }
      return {
        decision: "deny",
        mechanism: "mode",
        policyVersion,
        message: "Denied: dontAsk mode denies AskUserQuestion (WS-07 §6.3/§8)",
        ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
      };
    }
    // "a matching ask forces human/application approval even when a narrower allow also matches and
    // even in auto/bypassPermissions" (WS-07 §2) — skip stages 4/5 entirely, straight to the prompt.
    // `matchedAskRule` is present ONLY when an actual rule matched — AskUserQuestion/the Bash-override
    // mandate alone (no rule) and a hook-forced ask (no rule) are all mandatory-interaction
    // requirements, not rule-forced ones, so it stays absent for all three (§7.1: it "distinguishes an
    // explicit human-required policy from an ordinary safety prompt" — these ARE the ordinary-safety-
    // prompt case, just forced unconditionally by the tool's own identity/input shape or by a hook's
    // own decision, rather than by a rule).
    const matchedAskRule = askEntry
      ? {
          source: askEntry.source,
          toolName: askEntry.ruleValue.toolName,
          ...(askEntry.ruleValue.ruleContent !== undefined ? { ruleContent: askEntry.ruleValue.ruleContent } : {}),
        }
      : undefined;
    const decisionReason = askEntry
      ? `matched ask rule ${formatRuleRef(askEntry)}`
      : isMandatoryAskUserQuestion
        ? "AskUserQuestion requires mandatory interaction (WS-07 §8)"
        : isMandatoryDangerousBashOverride
          ? "Bash dangerouslyDisableSandbox requires mandatory interaction (WS-12 §4/§11, RULING P3-J)"
          : isMandatoryMcpInteraction
            ? `'${effectiveCall.toolName}' is marked requiresUserInteraction and requires mandatory interaction (WS-09 §6)`
            : (hookAskMessage ?? "a PreToolUse hook requested interactive approval (WS-08 §3)");
    const meta: PromptStageMeta = {
      decisionReason,
      ...(matchedAskRule !== undefined ? { matchedAskRule } : {}),
      ...(effectiveCall.toolUseId !== undefined ? { toolUseID: effectiveCall.toolUseId } : {}),
      ...(effectiveCall.agentId !== undefined ? { agentID: effectiveCall.agentId } : {}),
    };
    const hookAnswer = await tryPermissionRequestHook(effectiveCall, ctx, meta, policyVersion, carriedTransform);
    if (hookAnswer !== undefined) return hookAnswer;
    const result = await ctx.promptStage.prompt(effectiveCall, ctx, meta);
    if (result === null) {
      // No real host answered a mandatory/rule-forced request — fails CLOSED, unlike stage 6's
      // generic fallback (WS-07 §7.1: "never silently clear a rule-forced request"; §6.1: "never
      // implicitly allowed" applies just as much to a mandatory interaction with no rule behind it).
      if (askEntry) {
        return {
          decision: "deny",
          mechanism: "rule",
          policyVersion,
          source: askEntry.source,
          ruleRef: formatRuleRef(askEntry),
          message: ruleAskUnresolvedMessage(askEntry),
          ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
        };
      }
      if (isMandatoryDangerousBashOverride) {
        return {
          decision: "deny",
          mechanism: "mode",
          policyVersion,
          message: "Denied: a Bash call requesting dangerouslyDisableSandbox requires interaction and no prompt handler answered it (WS-12 §4/§11, RULING P3-J)",
          ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
        };
      }
      if (isMandatoryMcpInteraction) {
        return {
          decision: "deny",
          mechanism: "mode",
          policyVersion,
          message: `Denied: '${effectiveCall.toolName}' requires interaction (requiresUserInteraction, WS-09 §6) and no prompt handler answered it`,
          ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
        };
      }
      if (hookForcedAsk) {
        return {
          decision: "deny",
          mechanism: "hook",
          policyVersion,
          ...(hookAskId !== undefined ? { hookId: hookAskId } : {}),
          message: "Denied: a PreToolUse hook requested interactive approval and no prompt handler answered it (WS-08 §3)",
          ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
        };
      }
      return {
        decision: "deny",
        mechanism: "mode",
        policyVersion,
        message: "Denied: AskUserQuestion requires interaction and no prompt handler answered it (WS-07 §8)",
        ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
      };
    }
    return buildRecordFromPromptResult(result, policyVersion, carriedTransform);
  }

  // --- Finding 1 (P2 fix-wave, CRITICAL): a hook-forced "allow" resolves HERE ---------------------
  //
  // WS-08 §3's table pins `allow` as "pre-approves — but does NOT override later deny rules, ask
  // rules, interaction-required metadata, organization-required approval, or the critical-removal
  // circuit breaker." WS-07 §2.1: hooks "may … pre-approve"; §6.3 (dontAsk), verbatim: "Still
  // permits: … PreToolUse `allow` provided later deny/ask/critical checks don't block." Every gate
  // between here and stage 1 has already run and NOT overridden it by the time this line is
  // reached: stage 2's deny rules and the Read-deny-blocks-Edit check already returned above if
  // either fired; a hook-forced defer already resolved above too; and stage 3's own
  // askEntry/isMandatoryAskUserQuestion/hookForcedAsk gate — immediately above — did NOT fire (this
  // line is unreached otherwise, since that block always returns). What remains before a hook allow
  // may actually resolve the call is consulting the SAME standing exceptions stage 4 is about to
  // consult on its own: critical-removal (§6.8's circuit breaker — a hook allow must never clear it,
  // exactly like an ordinary allow rule never does), protected-write (§6.7: "an ordinary settings
  // allow rule does NOT clear this check" — extended here to a hook's own allow, treated with the
  // identical conservative posture), and plan-mode write withholding (§6.5's unconditional prose —
  // a hook allow is not a documented carve-out any more than a rule-level allow is). When NONE of
  // the three applies, the hook's own pre-approval is exactly what WS-07 §2.1/§6.3 promise: an
  // allow, mechanism "hook", BEFORE stage 4's mode baseline is ever consulted — so `dontAsk`,
  // `default`, and `auto` all resolve to allow here without ever reaching a prompt handler or the
  // classifier (the canonical headless "PreToolUse auto-approver" pattern §6.1/§7.3 direct hosts
  // toward). When one DOES apply, the hook's allow contributes nothing further — the call falls
  // through to the ordinary stage-4 pipeline immediately below, which already resolves
  // critical/protected/planWrite correctly and completely independently of any hook ever having
  // opined (evaluateModeStage's own standing-exception checks run first, unconditionally, in every
  // mode) — this is what makes the non-override floor structural rather than a runtime special case
  // duplicated in two places.
  if (hookAllow) {
    const criticalForHookAllow = ctx.specialChecks.isCriticalRemoval(effectiveCall, ctx);
    const protectedForHookAllow = !criticalForHookAllow.critical && ctx.specialChecks.isProtectedWrite(effectiveCall, ctx);
    const planWriteWithheldForHookAllow = policy.mode === "plan" && isPlanWriteShaped(effectiveCall) && ctx.sessionBypassEnabled !== true;
    if (!criticalForHookAllow.critical && !protectedForHookAllow && !planWriteWithheldForHookAllow) {
      return {
        decision: "allow",
        mechanism: "hook",
        policyVersion,
        ...(hookAllowId !== undefined ? { hookId: hookAllowId } : {}),
        ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
      };
    }
  }

  // --- Stage 4: permission mode ------------------------------------------------------------------
  const modeResult = evaluateModeStage(effectiveCall, ctx, policy.mode);
  if (modeResult.kind === "allow") {
    return { decision: "allow", mechanism: "mode", policyVersion, ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}) };
  }
  if (modeResult.kind === "deny") {
    // dontAsk's own standing-exception denial (critical/protected) — "canUseTool is NEVER called"
    // (WS-07 §6.3) applies here exactly as it does to dontAsk's generic post-allow-stage fallback
    // below; this is that SAME rule, just reached one step earlier for a standing exception.
    return { decision: "deny", mechanism: "mode", policyVersion, message: modeResult.message, ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}) };
  }
  if (modeResult.kind === "mustPrompt") {
    // Task 7's own standing-exception terminal outcome (critical/protected/plan-write): a genuine
    // "this must be asked" request — NEVER reaches stage 5's allow-rule lookup below (WS-07 §2's
    // own "standing exceptions" list for stage 5; §6.7/§6.8: "an ordinary settings allow rule does
    // NOT clear this check" / "even if an allow rule ... approves it"). Mirrors stage 3's own
    // ask-rule-null handling: a null PromptStage answer fails CLOSED here (mechanism "mode", not
    // "canUseTool" — this evaluator is the one making the fallback call, not a real host) — since
    // Ruling P2-I, this is now the SAME direction as stage 6's own generic bottom-of-pipeline
    // fallback (both deny on null), not the opposite T6-era pairing this comment used to describe.
    // A non-null answer here (T8's real PromptStage) is used exactly like any other prompt result
    // (mechanism "canUseTool").

    // Task 12 (WS-07 §6.7/§6.8's own "auto: classifier" cells): under `auto`, a standing exception
    // is the ONLY way this branch is reached (evaluateModeStage's own auto arm never returns
    // "mustPrompt" for anything else) — route to the classifier instead of the generic canUseTool
    // path below.
    if (policy.mode === "auto") {
      return await resolveAutoDecision(effectiveCall, ctx, policyVersion, carriedTransform);
    }

    // Task 12 (WS-07 §6.5's plan classifier borrow, applied to its own §6.7/§6.8 table rows):
    // "classifier when plan-auto active, otherwise prompt" (protected write) / "prompt, or
    // classifier when plan-auto is active and bypass unavailable" (critical removal). `origin
    // !== "planWrite"` is the §6.5 exclusion (source edits are withheld unconditionally — the
    // borrow sentence names "exploratory commands," never writes; see evaluateModeStage's own
    // plan-write branch). `sessionBypassEnabled !== true` covers §6.8's own explicit
    // bypass-unavailable gate for critical removal; it is a no-op (already vacuously true) for
    // protected-write's own mustPrompt case, since resolveProtectedWrite already returned "allow"
    // directly, above this branch, whenever plan + session bypass was already true.
    if (policy.mode === "plan" && modeResult.origin !== "planWrite" && ctx.sessionBypassEnabled !== true && isAutoModeDuringPlanEnabled(ctx)) {
      const verdict = await ctx.autoEngine.classify(effectiveCall, ctx);
      if (verdict.verdict === "allow") {
        return { decision: "allow", mechanism: "autoEngine", policyVersion, ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}) };
      }
      if (verdict.verdict === "deny") {
        return {
          decision: "deny",
          mechanism: "autoEngine",
          policyVersion,
          message: BLOCKED_BY_CLASSIFIER_MESSAGE,
          ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
        };
      }
      // "no_verdict" (P2's ONLY shipped classifier, alwaysNoVerdictClassifier, always lands here,
      // as does a genuine fallback signal) — falls through to the EXACT pre-existing hook/prompt
      // code below, unchanged. This is what makes the borrow's PRACTICAL P2 outcome "prompt"
      // (Ruling/controller dispatch) even though the WIRING above is real (fixtured with a
      // scripted classifier double).
    }

    const mustPromptMeta: PromptStageMeta = {
      decisionReason: modeResult.message,
      ...(modeResult.blockedPath !== undefined ? { blockedPath: modeResult.blockedPath } : {}),
      ...(effectiveCall.toolUseId !== undefined ? { toolUseID: effectiveCall.toolUseId } : {}),
      ...(effectiveCall.agentId !== undefined ? { agentID: effectiveCall.agentId } : {}),
    };
    const hookAnswer = await tryPermissionRequestHook(effectiveCall, ctx, mustPromptMeta, policyVersion, carriedTransform);
    if (hookAnswer !== undefined) return hookAnswer;
    const result = await ctx.promptStage.prompt(effectiveCall, ctx, mustPromptMeta);
    if (result === null) {
      return { decision: "deny", mechanism: "mode", policyVersion, message: modeResult.message, ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}) };
    }
    return buildRecordFromPromptResult(result, policyVersion, carriedTransform);
  }

  // --- Stage 5: allow rules ------------------------------------------------------------------
  // Task 12 (WS-07 §10.1 steps 2/3): under `auto`, a broad allow (blanket Bash(*)/PowerShell(*),
  // wildcarded interpreter/package-manager rules, any Agent/Monitor rule) is SUSPENDED — treated as
  // though it never matched — so it can never resolve this call; a surviving NARROW allow still
  // resolves here exactly like every other mode (mechanism "rule", unchanged attribution).
  // `classifyAllShell` widens suspension to every shell allow, narrow ones included
  // (auto/config.ts's own isAutoSuspendedAllowRule owns the exact matcher). Every other mode is
  // entirely unaffected — `opts` is only ever supplied for `policy.mode === "auto"`.
  const allowEntry = findMatchingRuleEntry(
    policy.rules,
    effectiveCall,
    "allow",
    ctx,
    policy.mode === "auto" ? { skip: (entry) => isAutoSuspendedAllowRule(entry.rule, { classifyAllShell: policy.autoConfig?.classifyAllShell === true }) } : undefined,
  );
  if (allowEntry) {
    return {
      decision: "allow",
      mechanism: "rule",
      policyVersion,
      source: allowEntry.source,
      ruleRef: formatRuleRef(allowEntry),
      ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
    };
  }

  // --- Post-allow-stage fallback (mode-specific) --------------------------------------------------
  // Task 12 (WS-07 §10.1 steps 5-8): nothing else resolved this `auto` call — not built-in-read-
  // only/bounded-edit at stage 4, no surviving (unsuspended) narrow allow at stage 5 — send it to
  // the classifier.
  if (policy.mode === "auto") {
    return await resolveAutoDecision(effectiveCall, ctx, policyVersion, carriedTransform);
  }

  if (policy.mode === "dontAsk") {
    // WS-07 §6.3: "Every would-prompt outcome becomes a denial ... canUseTool is NEVER called."
    return {
      decision: "deny",
      mechanism: "mode",
      policyVersion,
      message: "Denied: dontAsk mode denies unmatched actions",
      ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
    };
  }

  // Task 12 (WS-07 §6.5): plan's own classifier borrow for the "exploratory shell" bucket —
  // evaluateModeStage's own plan arm already returned "unresolved" here for exactly this case (a
  // non-write, non-read-only action; a plan-mode WRITE never reaches this point at all — it is
  // ALWAYS a "mustPrompt" from that same arm, handled above, never "unresolved"). `no_verdict`
  // falls through to the identical stage-6 canUseTool path below, unchanged — see resolveAutoDecision's
  // own sibling call site (above) for the fuller "wiring vs. practical outcome" framing, which
  // applies here identically. No `sessionBypassEnabled` gate here (judgment call, documented):
  // unlike §6.8's critical-removal row, WS-07 §6.5's own exploratory-shell sentence names no
  // bypass carve-out for this specific bucket.
  if (policy.mode === "plan" && isAutoModeDuringPlanEnabled(ctx)) {
    const verdict = await ctx.autoEngine.classify(effectiveCall, ctx);
    if (verdict.verdict === "allow") {
      return { decision: "allow", mechanism: "autoEngine", policyVersion, ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}) };
    }
    if (verdict.verdict === "deny") {
      return {
        decision: "deny",
        mechanism: "autoEngine",
        policyVersion,
        message: BLOCKED_BY_CLASSIFIER_MESSAGE,
        ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
      };
    }
    // "no_verdict" -- falls through to stage 6 below, unchanged.
  }

  // --- Stage 6: canUseTool -------------------------------------------------------------------
  const stage6Meta: PromptStageMeta = {
    decisionReason: "unmatched action reached the prompt stage",
    ...(effectiveCall.toolUseId !== undefined ? { toolUseID: effectiveCall.toolUseId } : {}),
    ...(effectiveCall.agentId !== undefined ? { agentID: effectiveCall.agentId } : {}),
  };
  const stage6HookAnswer = await tryPermissionRequestHook(effectiveCall, ctx, stage6Meta, policyVersion, carriedTransform);
  if (stage6HookAnswer !== undefined) return stage6HookAnswer;
  const result = await ctx.promptStage.prompt(effectiveCall, ctx, stage6Meta);
  if (result === null) {
    // *** Ruling P2-I — see this module's header comment for the full rationale ***
    // WS-07 §6.1: "without an applicable prompt handler they remain unresolved/denied — never
    // implicitly allowed." mechanism "mode" (not "canUseTool") because this evaluator is the one
    // making the fallback call, not a real host that actually answered — mirrors the ask-rule-null
    // and mustPrompt-null branches above, both of which already denied on a null answer.
    return {
      decision: "deny",
      mechanism: "mode",
      policyVersion,
      message: "Denied: no canUseTool handler answered this unmatched action (WS-07 §6.1 — never implicitly allowed)",
      ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}),
    };
  }
  return buildRecordFromPromptResult(result, policyVersion, carriedTransform);
}

// ---------------------------------------------------------------------------------------------------
// P3 (WS-06 tool registry): probeReadAccess -- a SIDE-EFFECT-FREE probe
// ---------------------------------------------------------------------------------------------------
//
// The read-before-edit ladder (P3 Lane B, WS-06 §3.1) needs to ask "what would a real Read of this
// path do RIGHT NOW, without actually doing it?" This function answers exactly that, consulting ONLY
// the live policy's mode + rules (the same deny/ask/mode/allow stages evaluate() itself runs for a
// synthetic `Read` call), and deliberately stops short of every stage that could have a side effect
// or depend on a live answer:
//   - no ctx.hookStage (stage 1's preToolUse, and every permissionRequest call site) -- a probe must
//     never fire a PreToolUse/PermissionRequest hook;
//   - no ctx.promptStage.prompt (stage 3's ask-match, the mustPrompt standing-exception site, stage
//     6's canUseTool) -- a probe must never invoke canUseTool;
//   - no ctx.autoEngine.classify (the `auto`-mode and plan-classifier-borrow branches) -- the
//     concrete AutoEngine may itself write an audit record when consulted (this file's own
//     AutoEngine.noteHeadlessFallbackDenial/noteFallbackResolution seam comments), so calling it
//     would violate "no audit" even though it is not, strictly, `promptStage`;
//   - it never constructs a PermissionDecisionRecord -- only the bare 3-state answer the caller needs.
// Synchronous by construction (unlike evaluate(), which is async): every seam this function is
// forbidden from touching is exactly the set of async seams evaluate() has, so a synchronous
// signature is itself a structural proof this probe cannot reach any of them.
//
// RULING P3-B (fix round 1): widened from a boolean (`wouldPrompt`) to this 3-state result. The old
// boolean's `false` was ambiguous between two genuinely different outcomes -- "resolves silently, no
// decision needed" (mode-allow, an allow-rule match) and "an interactive decision WOULD be needed,
// but this policy denies it without ever prompting" (dontAsk's own posture) -- which the
// read-before-edit ladder cannot treat the same way (a caller safe-to-skip on a genuinely silent
// read is NOT safe-to-skip on a read this policy would actually reject). `"deny"` now names that
// second case explicitly, everywhere it arises, including under a mode other than dontAsk (an
// ordinary rule/mode deny is also never a prompt, and was already reported `false` before this
// widening -- see each branch below for which of the two `"deny"` covers).
//
// The one cell every mode-baseline branch must agree on: dontAsk NEVER prompts -- ANY outcome that
// would otherwise need interaction (a matched ask rule, a mode mustPrompt, or the generic
// post-allow-stage fallback that would otherwise reach canUseTool) is a SILENT DENIAL under dontAsk,
// never `"silent"` and never `"prompt"`. This mirrors evaluate()'s own stage-3/post-allow-stage
// dontAsk handling exactly (this module's header comment: "dontAsk converts every would-prompt
// outcome to silent denial"), applied at every interaction exit in this function, not just one.
//
// A branch this probe cannot resolve without one of the excluded seams (the `auto`/plan-classifier-
// active "unresolved past every rule/mode check" case) is answered `"prompt"` -- NEVER `"silent"` --
// so a caller like the read-before-edit ladder never treats a call this probe could not actually
// clear as silently pre-approved.
export type ReadAccessProbe = "silent" | "prompt" | "deny";

export function probeReadAccess(filePath: string, ctx: EvaluationContext): ReadAccessProbe {
  const call: PermissionCall = { toolName: "Read", input: { file_path: filePath } };

  // Stage 2: a deny rule is a hard rejection, never a prompt.
  if (findMatchingRuleEntry(ctx.policy.rules, call, "deny", ctx)) return "deny";

  // Stage 3: a matched ask rule forces interaction UNLESS dontAsk converts it to a silent denial
  // (evaluate()'s own stage-3 dontAsk branch, mirrored here) -- RULING P3-B's own named cell:
  // interaction-needed-but-suppressed is "deny", never "silent". AskUserQuestion/hook-forced-ask are
  // not reachable for a bare `Read` call (no hooks are ever consulted by this probe).
  const askEntry = findMatchingRuleEntry(ctx.policy.rules, call, "ask", ctx);
  if (askEntry) return ctx.policy.mode === "dontAsk" ? "deny" : "prompt";

  // Stage 4: the mode baseline. Critical-removal/protected-write/plan-write standing exceptions
  // never fire for a bare `Read` call (they are Bash-rm/Edit/Write/Bash-fs-op-shaped checks) -- kept
  // generic/defensive here rather than assuming that, so this stays correct if that ever changes.
  const modeResult = evaluateModeStage(call, ctx, ctx.policy.mode);
  if (modeResult.kind === "allow") return "silent";
  if (modeResult.kind === "deny") return "deny";
  if (modeResult.kind === "mustPrompt") {
    // Unreachable for a plain Read today: dontAsk/default's own baseline (evaluateModeStage's shared
    // arm) only ever returns `allow` or `unresolved` for a call that clears isBuiltInReadOnly (Read
    // always does) -- it cannot produce `mustPrompt` at all, under ANY mode, for this probe's call
    // shape. Mapped per RULING P3-B's general dontAsk-never-prompts rule anyway (mirroring, not
    // assuming, the invariant): if this ever became reachable under dontAsk, it must still deny, not
    // prompt or silently pass. Every other mode's mustPrompt is a genuine, resolvable-only-by-
    // prompting request.
    return ctx.policy.mode === "dontAsk" ? "deny" : "prompt";
  }

  // Stage 5: an allow rule resolves silently (mirrors evaluate()'s own `auto`-suspension filter).
  const allowEntry = findMatchingRuleEntry(
    ctx.policy.rules,
    call,
    "allow",
    ctx,
    ctx.policy.mode === "auto" ? { skip: (entry) => isAutoSuspendedAllowRule(entry.rule, { classifyAllShell: ctx.policy.autoConfig?.classifyAllShell === true }) } : undefined,
  );
  if (allowEntry) return "silent";

  // Post-allow-stage fallback: dontAsk denies unmatched actions SILENTLY -- interaction-needed
  // (stage 6's canUseTool would otherwise be consulted) but suppressed, so RULING P3-B's own named
  // cell applies again: "deny", never "silent". `auto` and a plan-with-the-classifier-borrow-enabled
  // call would both consult ctx.autoEngine.classify in evaluate() itself -- excluded here, so
  // answered conservatively as "prompt"; every other mode falls straight to stage 6's canUseTool,
  // which is genuinely a prompt.
  if (ctx.policy.mode === "dontAsk") return "deny";
  return "prompt";
}
