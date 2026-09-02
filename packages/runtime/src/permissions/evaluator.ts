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
import { recognizeEditOperation } from "./edit-recognition.ts";
import { isProtectedWrite as isProtectedPath, isCriticalRemoval as classifyCriticalRemoval } from "./protected.ts";

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
function boundedRoots(ctx: EvaluationContext): string[] {
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
function extractCandidateWritePaths(call: PermissionCall): string[] {
  if (call.toolName === "Edit" || call.toolName === "Write") {
    const path = call.input["file_path"];
    return typeof path === "string" ? [path] : [];
  }
  if (call.toolName === "Bash") {
    const recognized = recognizeEditOperation(call);
    return recognized ? recognized.paths : [];
  }
  return [];
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
    return extractCandidateWritePaths(call).some((p) => {
      const absPath = resolve(ctx.cwd, p);
      return checkSymlinkBothEnds(absPath, (candidate) => isProtectedPath(candidate, { cwd: ctx.cwd, home: ctx.home })).denyIfEither;
    });
  },
  isCriticalRemoval(call, ctx) {
    // WS-07 §6.8 is scoped to `rm`/`rmdir` — a shell concept; Edit/Write never "remove" anything.
    if (call.toolName !== "Bash") return { critical: false };
    const raw = call.input["command"];
    const command = typeof raw === "string" ? raw : "";
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
  // Lens item 2 (task-6 brief): FILE_RULE_TOOLS (Read/Edit) with a SCOPED pattern specifier route to
  // matchFileRule (paths.ts), never matchesRule. A bare rule or `Tool(*)` (specifier undefined /
  // wildcardAll) skips this branch entirely — matchesRule already resolves those correctly via
  // tool-name matching alone, without ever touching call.input.
  if (FILE_RULE_TOOLS.has(rule.toolName) && rule.specifier?.kind === "pattern") {
    if (rule.toolName !== call.toolName) return false; // literal match only — WS-07 never documents a globbed tool name for this family
    const path = call.input["file_path"]; // WS-06 §"Read"/"Edit" pinned field name (docs/superpowers/specs/winter/WS-06-tool-catalog.md:145,167)
    if (typeof path !== "string") return false;
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
export function findMatchingRuleEntry(rules: SourcedRuleSet, call: PermissionCall, behavior: PermissionBehavior, ctx: EvaluationContext): SourcedRuleEntry | undefined {
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
function findReadDenyBlockingEdit(call: PermissionCall, ctx: EvaluationContext): SourcedRuleEntry | undefined {
  const candidatePaths = extractCandidateWritePaths(call);
  if (candidatePaths.length === 0) return undefined;
  const pool = ctx.allowManagedPermissionRulesOnly ? ctx.policy.rules.entries.filter((e) => e.source === "managed") : ctx.policy.rules.entries;
  for (const entry of pool) {
    if (entry.rule.toolName !== "Read" || entry.behavior !== "deny") continue;
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
  // WS-07 §6.1: "Reads within working ... directories ... run without prompting." Ruling P2-J
  // (Task 7, rider 2): resolved through the symlink TARGET, not just the link path — "a cwd symlink
  // pointing outside cwd is NOT 'routine read-only in cwd'" (this task's own instruction). `"**"` is
  // the same bare-anchor primitive T4 documents as matching the base directory itself and
  // everything beneath it; `matchFileRuleAtBothEnds`'s "allow" direction requires BOTH the link and
  // its resolved target to fall inside cwd.
  return matchFileRuleAtBothEnds("**", { path, cwd: ctx.cwd, home: ctx.home, direction: "allow" });
}

function isBuiltInReadOnly(call: PermissionCall, ctx: EvaluationContext): boolean {
  return isBashCallReadOnly(call) || isReadWithinCwd(call, ctx);
}

// Task 7 extends the T6 two-member union with two new terminal outcomes that, unlike "unresolved",
// NEVER fall through to stage 5's allow-rule lookup — see this type's four members' own uses in
// evaluate() below. "deny"/"mustPrompt" both carry a message so the eventual denial (immediate, or
// the fail-closed synthesized one when the still-stubbed PromptStage answers null) is legible.
type ModeStageResult =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "mustPrompt"; message: string; blockedPath?: string }
  | { kind: "unresolved" };

// WS-07 §6.5 / this task's own phase-ruling-6 instruction, verbatim: "writes withheld ... with a
// plan-specific message." Exported so fixtures can assert the exact string rather than a substring
// guess, mirroring ruleDenialMessage's own callers.
export const PLAN_WRITE_WITHHELD_MESSAGE = "Denied: plan mode withholds file/shell writes until the plan is approved or session bypass is enabled (WS-07 §6.5)";

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
  return { kind: "mustPrompt", message };
}

function resolveProtectedWrite(mode: PermissionMode, ctx: EvaluationContext, call: PermissionCall): ModeStageResult {
  const message = "Denied: protected path write requires approval (WS-07 §6.7)";
  // WS-07 §6.7 matrix, verbatim per mode:
  if (mode === "dontAsk") return { kind: "deny", message };
  if (mode === "bypassPermissions") return { kind: "allow" };
  // "allowed when bypass enabled for that session" — the §6.4/§6.5 relaxation carve-out this
  // task's own instruction names; `plan`'s classifier-active branch never applies at P2 (classifier
  // borrow OFF).
  if (mode === "plan" && ctx.sessionBypassEnabled === true) return { kind: "allow" };
  // Task 8 (WS-07 §7.1's `blockedPath`): the SAME per-tool path extraction driving
  // REAL_SPECIAL_CHECKS.isProtectedWrite itself (this function's own caller already confirmed
  // isProtectedWrite is true, so at least one candidate path exists) — the first candidate is
  // reported; a compound Bash command touching several protected paths at once reports only one,
  // a judgment call (no ordering guarantee is documented anywhere in scope).
  const candidatePaths = extractCandidateWritePaths(call);
  const blockedPath = candidatePaths[0] !== undefined ? resolve(ctx.cwd, candidatePaths[0]) : undefined;
  return { kind: "mustPrompt", message, ...(blockedPath !== undefined ? { blockedPath } : {}) };
}

function isBashRecognizedWrite(call: PermissionCall): boolean {
  // Any write-shaped path at all (a blessed fs-op OR a bare redirect target) counts as a "write"
  // for plan-mode withholding purposes — WS-07 §6.2's narrower "kind" distinction (blessed vs.
  // "other") only matters for acceptEdits' own auto-approve eligibility, not for plan's broader
  // "is this a write" question.
  return recognizeEditOperation(call) !== null;
}

function isPlanWriteShaped(call: PermissionCall): boolean {
  if (call.toolName === "Edit" || call.toolName === "Write") return true;
  if (call.toolName === "Bash") return isBashRecognizedWrite(call);
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

  if (mode === "dontAsk" || mode === "default") {
    // default / dontAsk share the IDENTICAL baseline (WS-07 §6.1/§6.3: both "still permit
    // built-in/read-only operations") — their divergence is the post-allow-stage fallback in
    // evaluate() below, not this baseline check.
    return isBuiltInReadOnly(call, ctx) ? { kind: "allow" } : { kind: "unresolved" };
  }

  if (mode === "acceptEdits") {
    // WS-07 §6.2: auto-approval is path-bounded (cwd/additionalDirectories), AFTER normalization +
    // symlink checks (isWithinBounds composes matchFileRuleAtBothEnds, rider 2) + protected/critical
    // (already excluded above) + Read/Edit deny rules — the latter is enforced generally at STAGE 2
    // now (T6-review obligation), so by the time this arm runs, a Read-deny-blocked path has
    // ALREADY been denied upstream; this arm doesn't need to re-check it.
    if (isBuiltInReadOnly(call, ctx)) return { kind: "allow" };
    const recognized = recognizeEditOperation(call);
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
    if (isPlanWriteShaped(call)) {
      if (ctx.sessionBypassEnabled === true) return { kind: "allow" };
      return { kind: "mustPrompt", message: PLAN_WRITE_WITHHELD_MESSAGE };
    }
    // Non-write, non-read-only exploratory action (e.g. an arbitrary shell command with no
    // filesystem-write shape) — WS-07 §5's plan row: "Prompt or classifier for exploratory shell";
    // classifier borrow is OFF at P2 (this task's own instruction), so this falls to the ordinary
    // pipeline exactly like `default`'s own "other unmatched action" bucket, rather than a THIRD
    // bespoke terminal outcome this task was not asked to invent.
    return { kind: "unresolved" };
  }

  // mode === "auto": T6's own placeholder baseline (identical to default's), UNCHANGED beyond the
  // standing-exceptions check above — T12 owns the real classifier pipeline (WS-07 §6.6). Guarding
  // critical/protected here too (rather than leaving auto exempt) is required by the §6.7/§6.8
  // matrices' own "auto: classifier" cells — never observably "silently allow," even before T12
  // wires the real classifier route.
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

  // Task 7 / T6-review obligation: a Read deny also blocks Edit/Write on the same path (WS-07
  // §3.1), enforced generally at stage 2, for every mode — not merely inside acceptEdits.
  const readBlockEntry = findReadDenyBlockingEdit(effectiveCall, ctx);
  if (readBlockEntry) {
    return {
      decision: "deny",
      mechanism: "rule",
      policyVersion,
      source: readBlockEntry.source,
      ruleRef: formatRuleRef(readBlockEntry),
      message: `Denied: Read deny rule ${formatRuleRef(readBlockEntry)} blocks Edit/Write on this path (WS-07 §3.1)`,
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
  if (askEntry || isMandatoryAskUserQuestion) {
    if (policy.mode === "dontAsk") {
      // WS-07 §6.3: "dontAsk converts all of these into denial." An actual ask-RULE match keeps its
      // own rule-denial message/mechanism; AskUserQuestion with no matching rule gets its own
      // dedicated mode-level denial (mechanism "mode" — no rule was involved).
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
    // `matchedAskRule` is present ONLY when an actual rule matched — AskUserQuestion alone (no rule)
    // is a mandatory-interaction requirement, not a rule-forced one, so it stays absent (§7.1: it
    // "distinguishes an explicit human-required policy from an ordinary safety prompt" — this IS the
    // ordinary-safety-prompt case, just one the tool itself makes unconditional).
    const matchedAskRule = askEntry
      ? {
          source: askEntry.source,
          toolName: askEntry.ruleValue.toolName,
          ...(askEntry.ruleValue.ruleContent !== undefined ? { ruleContent: askEntry.ruleValue.ruleContent } : {}),
        }
      : undefined;
    const decisionReason = askEntry ? `matched ask rule ${formatRuleRef(askEntry)}` : "AskUserQuestion requires mandatory interaction (WS-07 §8)";
    const result = await ctx.promptStage.prompt(effectiveCall, ctx, {
      decisionReason,
      ...(matchedAskRule !== undefined ? { matchedAskRule } : {}),
      ...(effectiveCall.toolUseId !== undefined ? { toolUseID: effectiveCall.toolUseId } : {}),
      ...(effectiveCall.agentId !== undefined ? { agentID: effectiveCall.agentId } : {}),
    });
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
    const result = await ctx.promptStage.prompt(effectiveCall, ctx, {
      decisionReason: modeResult.message,
      ...(modeResult.blockedPath !== undefined ? { blockedPath: modeResult.blockedPath } : {}),
      ...(effectiveCall.toolUseId !== undefined ? { toolUseID: effectiveCall.toolUseId } : {}),
      ...(effectiveCall.agentId !== undefined ? { agentID: effectiveCall.agentId } : {}),
    });
    if (result === null) {
      return { decision: "deny", mechanism: "mode", policyVersion, message: modeResult.message, ...(carriedTransform !== undefined ? { transformedInput: carriedTransform } : {}) };
    }
    return buildRecordFromPromptResult(result, policyVersion, carriedTransform);
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
