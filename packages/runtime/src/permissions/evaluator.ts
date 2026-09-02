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
// *** THE T6 INTERIM DECISION (read before touching stage 6's fallback) ***
// WS-07 §6.1 is explicit: an unmatched action in `default` mode "reach[es] canUseTool when
// supplied; without an applicable prompt handler they remain unresolved/denied — never implicitly
// allowed." Taken literally, a genuinely no-opinion PromptStage (i.e. no real host/canUseTool wired
// at all — every T6 caller, since T8 hasn't landed) would have to DENY every unmatched action. That
// would flip several of Phase 1's existing differential-golden scenarios (e.g. the "tooluse" scenario
// in scripts/differential.ts, and the equivalence scenario at packages/sdk/src/
// transport-equivalence.test.ts:619) from "the tool executes" to "the tool is denied" — and this
// task's own gate is explicit: "the default path with no rules configured must not alter existing
// scenarios' wire" (task-6-brief.md Step 4). The controller-approved resolution (advisor-reviewed):
//   - The PromptStage stub stays GENUINELY no-opinion (returns null) — never secretly opinionated.
//   - ONLY the generic "nothing matched anything, mode is prompt-capable" fallback at the very
//     bottom of evaluate() resolves a null PromptStage answer to ALLOW, so a session with zero
//     permission configuration and no host wired behaves exactly as it did before this task landed.
//   - The ask-rule-matched path (stage 3) does NOT get this treatment: a null answer there resolves
//     to DENY instead, because a matched ask rule is a RULE-FORCED request (WS-07 §7.1: "auto-
//     approval logic must never silently clear a rule-forced request") and no existing golden
//     configures an ask rule, so nothing pins that path to backward-compat.
// T8 inherits this exact tension when it wires the real PromptStage: WS-07 §6.1's literal text is
// still the long-term target, and T8 is free to flip the generic fallback to "deny" once a real host
// is reachable (with a justified `--update` to whichever goldens that touches) — this comment is the
// pointer for that implementer.
import type { PermissionBehavior, PermissionMode, PermissionUpdate, RuleSource } from "@yanlinglabs/winter-agent-sdk";
import { FILE_RULE_TOOLS, matchesRule, splitCompound, isRecognizedReadOnly, type ParsedRule } from "./grammar.ts";
import { matchFileRule } from "./paths.ts";
import type { SourcedRuleEntry, SourcedRuleSet } from "./ruleset.ts";
import type { PolicyState, AutoModeConfig } from "./policy-state.ts";

export type { AutoModeConfig };

// Verbatim WS-07 §7.2 pin. T8's own file-sectioning banner convention (sdk/permissions/types.ts)
// formally owns this; defined here now, byte-identical to the pinned union, purely so
// PermissionDecisionRecord (below) can reference it before T8 lands — T8 either re-exports this or
// relocates the declaration; the literal member set does not change either way.
export type PermissionDecisionClassification = "user_temporary" | "user_permanent" | "user_reject";

// The normalized shape every evaluator stage operates on. `toolUseId`/`agentId` are optional at T6
// (the engine has both readily available per call — engine.ts's own `{id, name, input}` — but no
// consumer here needs them yet beyond forwarding into PromptStageMeta for T8's future use).
export interface PermissionCall {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  agentId?: string;
}

// --- Stage 1 seam: PreToolUse hooks (T9/T10 fill) --------------------------------------------------

export interface HookDecision {
  decision: "allow" | "deny" | "no_opinion";
  transformedInput?: Record<string, unknown>;
  message?: string;
  interrupt?: boolean;
  hookId?: string;
}
export interface HookStage {
  // SEAM CONTRACT: an "allow" result is ADVISORY ONLY for this stage (WS-07 §2.1: "An allow does NOT
  // override later deny/ask rules, interaction-required metadata, ... or the critical-removal
  // circuit breaker") — evaluate() below continues the pipeline regardless of an "allow" here; only
  // "deny" short-circuits everything downstream. `transformedInput`, if present, becomes the
  // effective call for every later stage (rule matching included), mirroring canUseTool's own
  // updatedInput semantics (WS-07 §7.2). T9's real multi-hook reducer composes several hooks into
  // ONE HookDecision before this seam is even called; this interface is the reducer's OUTPUT shape,
  // not a per-hook shape.
  preToolUse(call: PermissionCall, ctx: EvaluationContext): Promise<HookDecision>;
}

// --- Stage 6 seam: canUseTool (T8 fills) ------------------------------------------------------------

export interface PromptStageMeta {
  decisionReason: string;
  toolUseID?: string;
  agentID?: string;
  matchedAskRule?: { source: RuleSource; toolName: string; ruleContent?: string };
  // T8 (WS-07 §7.1) extends this with the remaining verbatim canUseTool option-object fields this
  // task cannot populate yet: signal, suggestions, blockedPath, title, displayName, description,
  // requestId — none of those exist without the real bridge/T7-blockedPath-classification wiring.
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
}
export interface AutoEngine {
  // T6 never calls this (the `auto` mode arm is a placeholder identical to `default`'s own baseline
  // — see evaluateModeStage below) — the seam exists so EvaluationContext's shape is already
  // complete for T12 to wire against, and so "the evaluator runs fully with all four stubbed"
  // (task-6 brief) is true by construction, not by accident.
  classify(call: PermissionCall, ctx: EvaluationContext): Promise<AutoEngineVerdict>;
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
  home: string;
  trustedWorkspace: boolean;
  allowManagedPermissionRulesOnly?: boolean;
  hookStage: HookStage;
  promptStage: PromptStage;
  autoEngine: AutoEngine;
  specialChecks: SpecialChecks;
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
  // Lens item 2 (task-6 brief): FILE_RULE_TOOLS (Read/Edit) with a SCOPED pattern specifier route to
  // matchFileRule (paths.ts), never matchesRule. A bare rule or `Tool(*)` (specifier undefined /
  // wildcardAll) skips this branch entirely — matchesRule already resolves those correctly via
  // tool-name matching alone, without ever touching call.input.
  if (FILE_RULE_TOOLS.has(rule.toolName) && rule.specifier?.kind === "pattern") {
    if (rule.toolName !== call.toolName) return false; // literal match only — WS-07 never documents a globbed tool name for this family
    const path = call.input["file_path"]; // WS-06 §"Read"/"Edit" pinned field name (docs/superpowers/specs/winter/WS-06-tool-catalog.md:145,167)
    if (typeof path !== "string") return false;
    return matchFileRule(rule.specifier.source, {
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

function findMatchingRuleEntry(rules: SourcedRuleSet, call: PermissionCall, behavior: PermissionBehavior, ctx: EvaluationContext): SourcedRuleEntry | undefined {
  const direction: "allow" | "denyAsk" = behavior === "allow" ? "allow" : "denyAsk";
  const pool = ctx.allowManagedPermissionRulesOnly ? rules.entries.filter((e) => e.source === "managed") : rules.entries;
  for (const entry of pool) {
    if (entry.behavior !== behavior) continue;
    // Mirrors ruleset.ts's resolveRules() trust gate exactly: project/local ALLOW rules require
    // workspace trust; deny/ask apply without it (WS-07 §3.2; Ruling P2-H extends this to `local`).
    if (behavior === "allow" && (entry.source === "project" || entry.source === "local") && !ctx.trustedWorkspace) continue;
    if (matchesRuleForCall(entry.rule, call, direction, ctx)) return entry;
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

function isBashCallReadOnly(call: PermissionCall): boolean {
  const raw = call.input["command"];
  if (typeof raw !== "string") return false;
  const parts = splitCompound(raw);
  if (parts === null) return false; // unparseable -> WS-07 §3's own fallback: never recognized as safe
  return parts.length > 0 && parts.every((sub) => isRecognizedReadOnly(sub));
}

function isReadWithinCwd(call: PermissionCall, ctx: EvaluationContext): boolean {
  if (call.toolName !== "Read") return false;
  const path = call.input["file_path"];
  if (typeof path !== "string") return false;
  // WS-07 §6.1: "Reads within working ... directories ... run without prompting." additionalDirectories
  // (WS-07 §3.2) is a T7 config field not yet plumbed at T6 — cwd only, for now. `matchFileRule("**", ...)`
  // is the same primitive T4 documents as matching the base directory itself and everything beneath it.
  return matchFileRule("**", { path, cwd: ctx.cwd, home: ctx.home, direction: "allow" });
}

function isBuiltInReadOnly(call: PermissionCall, ctx: EvaluationContext): boolean {
  return isBashCallReadOnly(call) || isReadWithinCwd(call, ctx);
}

type ModeStageResult = { kind: "allow" } | { kind: "unresolved" };

function evaluateModeStage(call: PermissionCall, ctx: EvaluationContext, mode: PermissionMode): ModeStageResult {
  if (mode === "bypassPermissions") {
    // WS-07 §6.4: bypass auto-allows virtually everything (incl. protected-path writes) EXCEPT the
    // critical-rm/rmdir circuit breaker, which "still prompts/callback" even under bypass (§6.8) —
    // T7's SpecialChecks seam owns that classification; T6's stub never flags anything critical, so
    // this arm always resolves "allow" until T7 lands.
    const critical = ctx.specialChecks.isCriticalRemoval(call, ctx);
    return critical.critical ? { kind: "unresolved" } : { kind: "allow" };
  }
  // default / dontAsk share the IDENTICAL baseline (WS-07 §6.1/§6.3: both "still permit built-in/
  // read-only operations") — their divergence is the post-allow-stage fallback in evaluate() below,
  // not this baseline check.
  //
  // acceptEdits / plan / auto: T6 PLACEHOLDER arm, deliberately identical to default's own baseline
  // (never auto-approves MORE than default would). T7 replaces acceptEdits (WS-07 §6.2, path-bounded
  // recognized-edit auto-approval) and plan (§6.5, write-withholding); T12 replaces auto (§6.6, the
  // classifier pipeline). evaluator.test.ts pins this placeholder explicitly so a future replacement
  // is a deliberate, reviewed diff, not a silent regression.
  return isBuiltInReadOnly(call, ctx) ? { kind: "allow" } : { kind: "unresolved" };
}

// ---------------------------------------------------------------------------------------------------
// The main evaluator
// ---------------------------------------------------------------------------------------------------

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
  // See HookStage's own interface comment: "allow" is advisory only; downstream stages still run.
  const effectiveCall: PermissionCall = hookResult.transformedInput !== undefined ? { ...call, input: hookResult.transformedInput } : call;
  const carriedTransform = hookResult.transformedInput;

  // --- Stage 2: deny rules ---------------------------------------------------------------------
  const denyEntry = findMatchingRuleEntry(policy.rules, effectiveCall, "deny", ctx);
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

  // --- Stage 3: ask rules + mandatory interaction -----------------------------------------------
  const askEntry = findMatchingRuleEntry(policy.rules, effectiveCall, "ask", ctx);
  if (askEntry) {
    if (policy.mode === "dontAsk") {
      // WS-07 §6.3: "dontAsk converts all of these into denial."
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
    // "a matching ask forces human/application approval even when a narrower allow also matches and
    // even in auto/bypassPermissions" (WS-07 §2) — skip stages 4/5 entirely, straight to the prompt.
    const matchedAskRule = {
      source: askEntry.source,
      toolName: askEntry.ruleValue.toolName,
      ...(askEntry.ruleValue.ruleContent !== undefined ? { ruleContent: askEntry.ruleValue.ruleContent } : {}),
    };
    const result = await ctx.promptStage.prompt(effectiveCall, ctx, {
      decisionReason: `matched ask rule ${formatRuleRef(askEntry)}`,
      matchedAskRule,
      ...(effectiveCall.toolUseId !== undefined ? { toolUseID: effectiveCall.toolUseId } : {}),
      ...(effectiveCall.agentId !== undefined ? { agentID: effectiveCall.agentId } : {}),
    });
    if (result === null) {
      // No real host answered a RULE-FORCED request (WS-07 §7.1: "never silently clear a
      // rule-forced request") — fails CLOSED, unlike stage 6's generic fallback below. No existing
      // golden configures an ask rule, so this carve-out never touches the byte-unchanged gate; see
      // this module's header for the contrasting generic-fallback decision.
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
    return buildRecordFromPromptResult(result, policyVersion, carriedTransform);
  }

  // --- Stage 4: permission mode ------------------------------------------------------------------
  const modeResult = evaluateModeStage(effectiveCall, ctx, policy.mode);
  if (modeResult.kind === "allow") {
    return { decision: "allow", mechanism: "mode", policyVersion, ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}) };
  }

  // --- Stage 5: allow rules ------------------------------------------------------------------
  const allowEntry = findMatchingRuleEntry(policy.rules, effectiveCall, "allow", ctx);
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

  // --- Stage 6: canUseTool -------------------------------------------------------------------
  const result = await ctx.promptStage.prompt(effectiveCall, ctx, {
    decisionReason: "unmatched action reached the prompt stage",
    ...(effectiveCall.toolUseId !== undefined ? { toolUseID: effectiveCall.toolUseId } : {}),
    ...(effectiveCall.agentId !== undefined ? { agentID: effectiveCall.agentId } : {}),
  });
  if (result === null) {
    // *** T6 INTERIM DECISION — see this module's header comment for the full rationale ***
    return { decision: "allow", mechanism: "mode", policyVersion, ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}) };
  }
  return buildRecordFromPromptResult(result, policyVersion, carriedTransform);
}
