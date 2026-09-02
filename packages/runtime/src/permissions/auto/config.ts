// Task 12 (WS-07 §10.2/§10.6-6/§10.6-7): AutoModeConfig — the full module policy-state.ts's own
// header invited ("T12 is free to relocate this declaration ... once it lands"). policy-state.ts's
// PolicyState.autoConfig? field now points HERE (a one-line import-path change there, exactly as
// that file's own comment promised — no shape change to PolicyState itself).
//
// RULING (Phase ruling 5, restated by the controller dispatch): this is MECHANICS, not policy. The
// four default lists below are MINIMAL, CLEARLY-MARKED PLACEHOLDERS (2-3 entries each) — never
// Anthropic's prose (WS-07 §10.3: "Winter MUST NOT copy or distribute Anthropic's prose"), never a
// real security corpus. The independently-authored, versioned policy corpus is P6's job (WS-07
// §10.3/§10.6-14). Anything here that LOOKS like a security decision (which command names count as
// "interpreters," which as "package managers") is a placeholder shape proving the mechanism works,
// explicitly extensible, not a claim of completeness.
import type { RuleSource } from "@yanlinglabs/winter-agent-sdk";
import type { ParsedRule } from "../grammar.ts";

// ---------------------------------------------------------------------------------------------
// AutoModeConfig — WS-07 §10.2 verbatim field list
// ---------------------------------------------------------------------------------------------

export interface AutoModeConfig {
  environment?: string[];
  allow?: string[];
  soft_deny?: string[];
  hard_deny?: string[];
  classifyAllShell?: boolean;
  // T12 addition beyond §10.2's own four-field prose block: §6.5's own "useAutoModeDuringPlan
  // (current default)" is a real, named config knob the report cross-references from plan mode's
  // own semantics — it is not one of the four PROSE-LIST fields (no splice/replace mechanics apply
  // to a boolean), so it is modeled as a sibling field here rather than folded into one of the four.
  useAutoModeDuringPlan?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Placeholder default lists (WS-07 §10.3: "independently authored ... versioned separately")
// ---------------------------------------------------------------------------------------------
//
// Real 2.1.251 counts (report §30.3, NOT reproduced here): allow 17 / soft_deny 68 / hard_deny 1 /
// environment 20. These placeholders intentionally do NOT match those counts or categories — P6
// authors the real corpus independently; a coincidental resemblance would be worse than an obvious
// mismatch. Each entry is a short, generic category label, not operational prose.

export const AUTO_MODE_DEFAULT_ENVIRONMENT: readonly string[] = [
  "(placeholder) the working repository and its start-of-session remotes",
  "(placeholder) local filesystem outside any declared secrets directory",
];

export const AUTO_MODE_DEFAULT_ALLOW: readonly string[] = [
  "(placeholder) ordinary local file edits within the working repository",
  "(placeholder) declared dependency installs via the project's own package manager",
  "(placeholder) read-only HTTP requests to already-trusted domains",
];

export const AUTO_MODE_DEFAULT_SOFT_DENY: readonly string[] = [
  "(placeholder) destructive git/history rewrites",
  "(placeholder) piping a network download directly into a shell/interpreter",
  "(placeholder) production deploys or database migrations",
];

export const AUTO_MODE_DEFAULT_HARD_DENY: readonly string[] = ["(placeholder) disabling or removing a security control"];

export const AUTO_MODE_DEFAULT_USE_AUTO_MODE_DURING_PLAN = true; // WS-07 §6.5: "current default"

// ---------------------------------------------------------------------------------------------
// "$defaults" splice-vs-replace mechanics (WS-07 §10.2)
// ---------------------------------------------------------------------------------------------

export const AUTO_MODE_DEFAULTS_TOKEN = "$defaults";

export type AutoModeListField = "environment" | "allow" | "soft_deny" | "hard_deny";

// "The four prose lists support the literal '$defaults', splicing the version's built-ins at that
// position; omitting it REPLACES the full default list for that section — a security-sensitive
// operation the UI must make unmistakable." `input === undefined` (the field was never configured
// at all) is NOT a replace — it is "use the defaults verbatim," the same as `["$defaults"]`; a
// replace requires an ACTUAL array that omits the token.
function spliceOrReplace(input: string[] | undefined, defaults: readonly string[]): { values: string[]; replaced: boolean } {
  if (input === undefined) return { values: [...defaults], replaced: false };
  const idx = input.indexOf(AUTO_MODE_DEFAULTS_TOKEN);
  if (idx === -1) return { values: [...input], replaced: true };
  const values = [...input.slice(0, idx), ...defaults, ...input.slice(idx + 1)];
  return { values, replaced: false };
}

export interface NormalizedAutoModeConfig {
  environment: string[];
  allow: string[];
  soft_deny: string[];
  hard_deny: string[];
  classifyAllShell: boolean;
  useAutoModeDuringPlan: boolean;
  // "a security-sensitive operation the UI must make unmistakable" — surfaced here as DATA (which
  // of the four list fields were replaced wholesale rather than spliced onto the defaults) so a
  // caller (a future settings UI, an audit record) can flag it, rather than the flag being
  // observable only by diffing the input against the module's own defaults by hand.
  securityRelevantReplacements: AutoModeListField[];
}

export function normalizeAutoModeConfig(input: AutoModeConfig | undefined): NormalizedAutoModeConfig {
  const env = spliceOrReplace(input?.environment, AUTO_MODE_DEFAULT_ENVIRONMENT);
  const allow = spliceOrReplace(input?.allow, AUTO_MODE_DEFAULT_ALLOW);
  const softDeny = spliceOrReplace(input?.soft_deny, AUTO_MODE_DEFAULT_SOFT_DENY);
  const hardDeny = spliceOrReplace(input?.hard_deny, AUTO_MODE_DEFAULT_HARD_DENY);
  const securityRelevantReplacements: AutoModeListField[] = [];
  if (env.replaced) securityRelevantReplacements.push("environment");
  if (allow.replaced) securityRelevantReplacements.push("allow");
  if (softDeny.replaced) securityRelevantReplacements.push("soft_deny");
  if (hardDeny.replaced) securityRelevantReplacements.push("hard_deny");
  return {
    environment: env.values,
    allow: allow.values,
    soft_deny: softDeny.values,
    hard_deny: hardDeny.values,
    classifyAllShell: input?.classifyAllShell === true,
    useAutoModeDuringPlan: input?.useAutoModeDuringPlan ?? AUTO_MODE_DEFAULT_USE_AUTO_MODE_DURING_PLAN,
    securityRelevantReplacements,
  };
}

// ---------------------------------------------------------------------------------------------
// Source restriction (WS-07 §3.2 / §10.6-6): "read ONLY from user settings, managed settings, and
// inline SDK/--settings configuration — never from project .winter/settings.json or
// .winter/settings.local.json."
// ---------------------------------------------------------------------------------------------
//
// Conservative reading (judgment call, documented): the spec names exactly THREE safe categories
// ("user", "managed", "inline"). RuleSource has seven members; "user"/"managed" map directly,
// "inline SDK/--settings configuration" maps to "sdk" (an inline options-level blob, the same
// source SDK-level allowedTools/disallowedTools/permissions already use — buildSdkSourcedEntries).
// "project"/"local" are the two spec EXPLICITLY forbids by name. "cliArg" and "session" are
// spec-SILENT for autoMode specifically (never named as either safe or forbidden) — treated as
// REJECTED here too rather than silently widened past the three explicitly-named categories; a
// future task may need to reclassify "cliArg" if a real `--settings` CLI mapping lands on it
// instead of "sdk" (capture-pending, not spec-mandated either way).
export type AutoModeConfigSource = "user" | "managed" | "sdk";

const AUTO_MODE_ALLOWED_SOURCES: ReadonlySet<RuleSource> = new Set<RuleSource>(["user", "managed", "sdk"]);

export class AutoModeConfigSourceError extends Error {
  constructor(source: RuleSource) {
    super(`autoMode configuration may only come from user/managed/inline (sdk) settings, never from source ${JSON.stringify(source)} (WS-07 §3.2/§10.6-6)`);
    this.name = "AutoModeConfigSourceError";
  }
}

export function assertAutoModeConfigSource(source: RuleSource): asserts source is AutoModeConfigSource {
  if (!AUTO_MODE_ALLOWED_SOURCES.has(source)) throw new AutoModeConfigSourceError(source);
}

// ---------------------------------------------------------------------------------------------
// Tier semantics (WS-07 §10.2/§10.6-7): "hard_deny unconditional; soft_deny blocks unless cleared;
// allow supplies exceptions to matching soft blocks."
// ---------------------------------------------------------------------------------------------
//
// NOT implemented here (P6 policy, explicitly out of scope): "explicit, specific user intent can
// clear remaining soft blocks but never hard denial" — WS-07 §10.2's own example ("'clean up the
// repository' is not authorization to force-push; 'force-push this branch' can be") requires
// judging conversational intent, which is exactly the classifier's (an LLM's) job, not a deterministic
// string match. This function only ever resolves the STATIC tier from a `category` string the
// classifier already returned — a same-session "intent-clearing" pass over conversation history is
// P6's to add, layered on top of (never replacing) this deterministic floor.
export type AutoTierVerdict = "hard_denied" | "soft_denied" | "cleared" | "unclassified";

export function resolveAutoTier(category: string | undefined, config: NormalizedAutoModeConfig): AutoTierVerdict {
  if (category === undefined) return "unclassified";
  if (config.hard_deny.includes(category)) return "hard_denied"; // unconditional -- checked FIRST, wins even if the same string also appears in `allow`
  if (config.soft_deny.includes(category)) {
    return config.allow.includes(category) ? "cleared" : "soft_denied";
  }
  return "unclassified";
}

// ---------------------------------------------------------------------------------------------
// Broad-allow suspension matcher (WS-07 §10.1 step 2 / §10.6-7): "Suspended broad allows include
// blanket Bash(*)/PowerShell(*), wildcarded interpreter rules, package-manager run-command grants,
// Agent rules, and Monitor rules; narrow entries like Bash(npm test) survive unless
// classifyAllShell is true."
// ---------------------------------------------------------------------------------------------
//
// PLACEHOLDER, extensible (same posture as the default lists above): the exact set of "interpreter"
// and "package manager" command names is not pinned anywhere in scope. This is a representative,
// clearly-labeled starting set; P6's real corpus work is expected to extend or replace it.
export const AUTO_SUSPENDED_INTERPRETER_COMMANDS: ReadonlySet<string> = new Set([
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
  "php",
  "sh",
  "bash",
  "zsh",
  "osascript",
  "pwsh",
]);

export const AUTO_SUSPENDED_PACKAGE_MANAGER_COMMANDS: ReadonlySet<string> = new Set(["npm", "npx", "yarn", "pnpm", "bun", "cargo", "pip", "pip3", "gem"]);

const SUSPENDED_SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

// A pattern specifier is "wildcarded" in the sense this heuristic cares about when it contains a
// `*` (the general wildcard) OR ends with the `:*` trailing-wildcard sugar (WS-07 §3) -- either
// spelling means "this head command, followed by anything" rather than one fully-specific
// invocation.
function isWildcardedPattern(source: string): boolean {
  return source.includes("*");
}

function headCommand(source: string): string {
  const normalized = source.endsWith(":*") ? source.slice(0, -2) + " *" : source;
  const trimmed = normalized.trimStart();
  const spaceIdx = trimmed.search(/\s/);
  return (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
}

// Exported so evaluator.ts's stage 5 (allow rules) can skip a suspended entry BEFORE it ever
// resolves an auto-mode call -- see that file's own auto-aware `findMatchingRuleEntry` call for how
// this composes with the ordinary rule-matching pipeline (T12 does not re-implement matching here,
// only "does this ALREADY-MATCHED allow rule count as broad").
export function isAutoSuspendedAllowRule(rule: ParsedRule, config: Pick<NormalizedAutoModeConfig, "classifyAllShell">): boolean {
  if (!SUSPENDED_SHELL_TOOL_NAMES.has(rule.toolName)) {
    // Agent/Monitor rules are suspended regardless of specifier -- WS-07 §10.1's list names the
    // TOOL itself, not a narrow/broad distinction within it (unlike Bash/PowerShell).
    return rule.toolName === "Agent" || rule.toolName === "Monitor";
  }
  // Blanket Bash(*)/PowerShell(*) (or a bare rule, grammar.ts's own isBareEquivalent flag already
  // treats the two identically) -- always suspended.
  if (rule.isBareEquivalent) return true;
  if (rule.specifier?.kind !== "pattern") return false; // a param-kind rule (e.g. Bash(run_in_background:true)) is not a "broad allow" in this sense
  const wildcarded = isWildcardedPattern(rule.specifier.source);
  if (wildcarded) {
    const head = headCommand(rule.specifier.source);
    if (AUTO_SUSPENDED_INTERPRETER_COMMANDS.has(head) || AUTO_SUSPENDED_PACKAGE_MANAGER_COMMANDS.has(head)) return true;
  }
  // Narrow shell allow (wildcarded-but-not-interpreter/pkg-manager, e.g. `Bash(ls *)`, or fully
  // literal, e.g. `Bash(npm test)`) -- survives UNLESS classifyAllShell forces every shell command
  // through the classifier (WS-07 §10.1/§10.6-7: "classifyAllShell: false is the parity default").
  return config.classifyAllShell;
}
