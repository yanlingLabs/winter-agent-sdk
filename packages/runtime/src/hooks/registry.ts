// Task 9 (WS-08 §1, §2, §2.1): the merged-deterministic-order hook registry. Pure/synchronous — a
// registry is just "a sorted, filterable list of source-tagged registrations"; the async invocation
// loop and the precedence math live in runner.ts and reducer.ts respectively.
//
// MATCHER GRAMMAR REUSE (WS-08 §2.1: "Matcher semantics follow the permission rule-name grammar for
// tool identity ([WS-07] §3): exact tool name, and the same full-name glob families accepted
// there") — this file does NOT modify or duplicate grammar.ts (T3/grammar.ts is complete; ruleset.ts
// already established the precedent that later tasks work around it rather than through it, e.g.
// its own isAnchoredMcpAllowGlob comment). Reuse works because grammar.ts's already-EXPORTED
// `parseRule`/`matchesRule` are already exactly "tool-identity matching" for a BARE rule (no
// parenthetical specifier): `parseRule("mcp__server__*")` produces a specifier-less, bare-equivalent
// ParsedRule, and `matchesRule` on such a rule never even looks at `call.input` — it is pure
// tool-name-glob matching. Two composition choices this file makes on top of that reuse:
//   - `direction: "denyAsk"` is used unconditionally (never "allow") — grammar.ts's `direction` only
//     ever matters for (a) Bash wrapper-stripping asymmetry (irrelevant here — hook matchers are
//     tool-identity-only, never Bash-command-pattern) and (b) the "allow globs require a literal mcp
//     server prefix" restriction, which is a capability-GRANT safety rule specific to permission
//     ALLOW rules. A hook matcher does not grant anything by matching broadly — it only SELECTS which
//     calls a hook observes/gates — so the grant-specific anchor restriction does not apply; using
//     "denyAsk" (grammar.ts's unrestricted direction) gives the permissive glob semantics WS-08 §2.1
//     asks for ("mcp__server__*" and friends) without inventing a new code path. Documented judgment
//     call (this task's report).
//   - A matcher string that parses to anything OTHER than a bare-equivalent rule (i.e., it carries an
//     actual parenthetical specifier, like the permission-rule-content grammar "Bash(ls *)") is
//     malformed AS A MATCHER (WS-08 §2.1 pins matchers as pure tool-identity strings, never rule
//     CONTENT) — treated as INERT (matches nothing), never thrown. This mirrors WS-08 §1's own
//     "unknown event names ... accepted, preserved, inert (never an error)" posture for hook
//     configuration generally, rather than permission rules' own add-time-throw precedent
//     (ruleset.ts's `sourceRule`) — hooks config is deliberately lenient/forward-compatible
//     throughout this spec; a malformed matcher silently never firing is judged safer (and more
//     consistent with the rest of WS-08) than crashing engine startup over a host's typo. Documented
//     judgment call.
import { parseRule, matchesRule } from "../permissions/grammar.ts";
import type { HookEvent, HookSource } from "@yanlinglabs/winter-agent-sdk";
import type { HookParticipant } from "./reducer.ts";

// WS-08 §1.3: "Tool-scoped matchers (§2.1) apply to the decision- and contribution-capable rows;
// other events match by event name only unless the pinned declaration says otherwise." These 5 are
// exactly those two rows' events (§1.3's own classification table).
export const TOOL_SCOPED_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PermissionRequest",
]);

export function isToolScopedHookEvent(event: HookEvent): boolean {
  return TOOL_SCOPED_HOOK_EVENTS.has(event);
}

// One flattened, per-hook registration — WS-08 §2's illustrative `{matcher?, hooks: HookHandler[]}`
// shape is flattened to one SourcedHookEntry PER hook callback/command-spec at build time (the
// reducer/runner operate per-hook, not per-matcher-entry group), extending reducer.ts's own minimal
// `HookParticipant` view with the one registry-only field (`timeoutMs` — already unit-converted from
// HookCallbackMatcher's pinned SECONDS to milliseconds by whichever builder constructs this entry;
// see hooks/runner.ts's own header for why that conversion must happen exactly once, here, and never
// again downstream).
export interface SourcedHookEntry extends HookParticipant {
  timeoutMs?: number;
}

export interface HookRegistry {
  // Returns every registration for `event`, in WS-08 §2's merged deterministic order, filtered by
  // matcher (§2.1) when `event` is tool-scoped. `toolName` is ignored for non-tool-scoped events
  // (their matcher, if any is nonsensically present, is never consulted — §1.3) and should be
  // omitted by callers that know the event isn't tool-scoped; if omitted for a tool-scoped event, a
  // matcher-bearing entry is defensively excluded (never crashes, never over-matches).
  matching(event: HookEvent, toolName?: string): SourcedHookEntry[];
}

// WS-08 §2, verbatim order. "project" before "local": the spec's own prose names them together as
// one phrase ("project/local filesystem sources") without stating a sub-order; this resolves the
// ambiguity by following RuleSource's sibling declaration order (project before local) for
// consistency with the permission-rule precedent — a documented judgment call (task report), not a
// spec-pinned fact.
const SOURCE_RANK: Record<HookSource, number> = { managed: 0, user: 1, project: 2, local: 3, sdk: 4 };

function matcherApplies(matcher: string | undefined, toolName: string | undefined): boolean {
  if (matcher === undefined) return true; // WS-08 §2.1: "absent = matches every occurrence."
  if (toolName === undefined) return false; // defensive: a tool-scoped call with no known tool name never matches a SCOPED matcher.
  const parsed = parseRule(matcher);
  if (!parsed.isBareEquivalent) return false; // malformed matcher grammar (has rule CONTENT, not just a tool-identity string) -> inert, see this file's header.
  return matchesRule(parsed, { toolName, input: {} }, { direction: "denyAsk" });
}

export function buildHookRegistry(entries: SourcedHookEntry[]): HookRegistry {
  // Explicit index-tiebreak stable sort (rather than relying on Array.prototype.sort's ES2019+
  // stability guarantee implicitly) — self-documents "registration order within one source" as an
  // intentional invariant, not an accident of engine behavior.
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => SOURCE_RANK[a.entry.source] - SOURCE_RANK[b.entry.source] || a.index - b.index)
    .map(({ entry }) => entry);

  return {
    matching(event, toolName) {
      const forEvent = sorted.filter((e) => e.event === event);
      if (!isToolScopedHookEvent(event)) return forEvent; // §1.3: matcher never consulted for these.
      return forEvent.filter((e) => matcherApplies(e.matcher, toolName));
    },
  };
}
