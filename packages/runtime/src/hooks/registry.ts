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

// WS-23: claude's matcher SUBJECTS for the lifecycle events that have one -- a `SessionStart` group
// written `"matcher": "startup|resume"` is filtered on the input's `source`, a `SubagentStop` group on
// its `agent_type`, and so on. Before WS-23 Winter never consulted a matcher on these (§1.3's "match
// by event name only"), which was harmless while nothing fired SessionStart with `source: "compact"`;
// now that something does, a claude-format `startup`-only hook would otherwise start running after
// every compaction. The subject is read from the invocation payload (runner.ts); a caller that
// supplies none keeps the old "every group matches" answer, so nothing that never passed a subject
// changes.
export const MATCHER_SUBJECT_FIELD: Readonly<Partial<Record<HookEvent, string>>> = {
  SessionStart: "source",
  SubagentStart: "agent_type",
  SubagentStop: "agent_type",
  PreCompact: "trigger",
  PostCompact: "trigger",
  Notification: "notification_type",
};

// One flattened, per-hook registration — WS-08 §2's illustrative `{matcher?, hooks: HookHandler[]}`
// shape is flattened to one SourcedHookEntry PER hook callback/command-spec at build time (the
// reducer/runner operate per-hook, not per-matcher-entry group), extending reducer.ts's own minimal
// `HookParticipant` view with the one registry-only field (`timeoutMs` — already unit-converted from
// HookCallbackMatcher's pinned SECONDS to milliseconds by whichever builder constructs this entry;
// see hooks/runner.ts's own header for why that conversion must happen exactly once, here, and never
// again downstream).
export interface SourcedHookEntry extends HookParticipant {
  timeoutMs?: number;
  // Phase 5 Task 2 (WS-08 OQ3, absorbed into P5): the shell command a SETTINGS-FILE hook block
  // declares (`{ type: "command", command, timeout? }` -- see from-config.ts's
  // buildHookEntriesFromSettings). Absent on every callback-registered entry, which is every entry
  // that existed before this field: an `Options.hooks` registration is a JS function reached over
  // the control bridge (hooks/bridge-invoker.ts) and has no command to carry.
  //
  // TYPED AND CARRIED, NOT YET EXECUTED. Winter has exactly one HookInvoker today
  // (createBridgeHookInvoker), which dispatches to a host CALLBACK by positional id; nothing spawns
  // a process for a hook. A command-hook executor is downstream work (T3/lane), and this field is
  // what makes the entry it will need survive the settings loader instead of being parsed and
  // thrown away -- the alternative was a builder that produces entries no executor could ever run.
  command?: string;
  /**
   * WS-23: fail CLOSED on PreToolUse/PermissionRequest -- an error, a timeout or a malformed output
   * from THIS hook denies the call (runner.ts's `failClosedDenial`) instead of contributing nothing.
   * Absent = the long-standing non-blocking default. Set from `HookCallbackMatcher.failClosed` (per
   * callback matcher, riding the wire as `RuntimeHookMatcherGroup.failClosed`) or from a settings /
   * plugin command handler's own `failClosed: true`.
   */
  failClosed?: boolean;
  /**
   * WS-23: the plugin's own root directory, for a plugin-sourced command hook -- what
   * `${CLAUDE_PLUGIN_ROOT}` is substituted with in `command` and exported as in the hook's
   * environment (command-invoker.ts). Absent on every non-plugin entry.
   */
  pluginRoot?: string;
}

export interface HookRegistry {
  // Returns every registration for `event`, in WS-08 §2's merged deterministic order, filtered by
  // matcher (§2.1) when `event` is tool-scoped. If `toolName` is omitted for a tool-scoped event, a
  // matcher-bearing entry is defensively excluded (never crashes, never over-matches).
  //
  // WS-23: for an event in MATCHER_SUBJECT_FIELD the second argument is that event's SUBJECT
  // (`source`, `agent_type`, ...) instead, and a matcher filters on it; OMITTED, every group matches
  // (the pre-WS-23 answer). For every other event the matcher is still never consulted (§1.3).
  matching(event: HookEvent, toolName?: string): SourcedHookEntry[];
}

// WS-08 §2, verbatim order. "project" before "local": the spec's own prose names them together as
// one phrase ("project/local filesystem sources") without stating a sub-order; this resolves the
// ambiguity by following RuleSource's sibling declaration order (project before local) for
// consistency with the permission-rule precedent — a documented judgment call (task report), not a
// spec-pinned fact.
// Phase 5 Task 8 (rider 19): `plugin` ranks LAST -- see HookSource's own declaration for why (a
// plugin ships defaults every more-specific source may override), and note it is deliberately
// NOT in the untrusted-workspace exclusion below, for the same reason `pluginAgents` is not
// trust-gated.
const SOURCE_RANK: Record<HookSource, number> = { managed: 0, user: 1, project: 2, local: 3, sdk: 4, plugin: 5 };

// --- WS-23: REGEX MATCHERS ---------------------------------------------------------------------------
//
// The glob grammar above was the WHOLE matcher language, and claude's own matcher language is a
// regular expression: a claude-format plugin or settings hook written `Edit|Write`, `mcp__.*` or `.*`
// matched NOTHING here, silently -- so a user's deny hook never fired (inv-hooks-mcp A2, measured).
// Both languages are honoured now, in this order, compiled ONCE per entry at registry build:
//
//   1. absent or ""                   -> every occurrence (claude's own "" = all).
//   2. no regex-only metacharacter    -> the WS-08 §2.1 glob path above, UNCHANGED: an exact name,
//      (letters, digits, `_`, `-`, `*`;  `*`, `mcp__srv__*`, `Tool(*)`. Deliberately first: read as a regex,
//      a trailing `(*)` is allowed)
//                                        `mcp__srv__*` would mean "mcp__srv_" plus any run of `_`,
//                                        which is not what anyone who wrote it meant.
//   3. anything else                  -> a RegExp over the WHOLE tool name, `^(?:<pattern>)$`.
//
// ANCHORED, a stated divergence: claude tests an unanchored `new RegExp(pattern)`, under which
// `Write` inside a larger pattern also matches `NotebookWrite`-style names nobody listed. A hook
// matcher SELECTS which calls a hook gates, so "matches exactly the names the pattern spells" is the
// predictable reading; `.*` and `mcp__.*` mean the same either way.
//
// A pattern that will not compile logs ONE warning (at build, so once per registry, never per call)
// and matches NOTHING -- the same inert posture a malformed glob always had, now said out loud.
const REGEX_ONLY_METACHARACTERS = /[.()[\]{}+?^$|\\]/;

type CompiledMatcher = (toolName: string) => boolean;

function compileMatcher(matcher: string, warn: (line: string) => void): CompiledMatcher {
  // `Tool(*)` is the permission grammar's own bare-equivalent spelling (WS-07 §3), not a regex group
  // -- read as a regex `(*)` does not even compile -- so its trailing `(*)` is not evidence of regex.
  if (!REGEX_ONLY_METACHARACTERS.test(matcher.replace(/\(\*\)$/, ""))) {
    const parsed = parseRule(matcher);
    if (!parsed.isBareEquivalent) return () => false; // unreachable without `(`, kept as the grammar's own inert answer
    return (toolName) => matchesRule(parsed, { toolName, input: {} }, { direction: "denyAsk" });
  }
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${matcher})$`);
  } catch (err) {
    warn(`winter: hook matcher ${JSON.stringify(matcher)} is not a valid regular expression, so its hooks will never run: ${err instanceof Error ? err.message : String(err)}`);
    return () => false;
  }
  return (toolName) => re.test(toolName);
}

function matcherApplies(compiled: CompiledMatcher | undefined, toolName: string | undefined): boolean {
  if (compiled === undefined) return true; // WS-08 §2.1: "absent = matches every occurrence."
  if (toolName === undefined) return false; // defensive: a tool-scoped call with no known tool name never matches a SCOPED matcher.
  return compiled(toolName);
}

// Finding 4 (P2 fix-wave, IMPORTANT): WS-08 §2's own table binds project-sourced hooks to "the same
// settingSources/trust discipline as project rules" — for RULES, Ruling P2-H put that gate
// structurally INSIDE the engine (resolveRules/effectiveDirectories/evaluator.ts's own
// findMatchingRuleEntry), precisely so a future loader can feed entries without being trusted to
// remember the gate itself. Hooks had the opposite architecture at P2: no gate at registration, none
// at matching, none at invocation — the entire §2 trust obligation rode on a P5 loader that phase
// ruling 1 describes as a pure FEEDER ("does not reshape" what it feeds), and from-config.ts's own
// header used to steer that future loader AWAY from adding one ("no changes needed here"). This is
// the untrusted-clone self-grant shape one level up from rules: a checked-in project `settings.json`
// PreToolUse hook in an untrusted clone would otherwise be host-machine code execution PLUS a
// permission-gating participant, fed by a loader with no gate to hit.
//
// Unlike rules, there is no safe "deny-side stays active" half here: a permission rule's deny/ask
// direction is a SAFETY CHECK that applies without trust by design (WS-07 §3.2), but every hook —
// including a purely observational one — is configured CODE EXECUTION (WS-08 §2's own note) that can
// exfiltrate whatever payload it observes; there is no hook "direction" that is safe to leave active
// for an untrusted source. So `project`/`local` sourced entries are excluded WHOLESALE (every hook
// kind, not just decision-capable ones) when the workspace is untrusted — never partially gated the
// way rules are. `managed`/`user`/`sdk` are unaffected either way (WS-08 §2's own two-source-family
// table: only the filesystem project/local pair carries this obligation at all).
//
// Filtered ONCE, at build time (not per `matching()` call) — a registry is immutable for the life of
// a run (engine.ts builds it once, outside the per-call EvaluationContext factory), so there is
// nothing to gain from re-deriving the same exclusion on every lookup. Unreachable today (only
// `source:"sdk"` groups have a real producer — from-config.ts's own header; `trustedWorkspace` is
// hard-false at engine.ts's one call site) — this closes the gate structurally BEFORE P5's
// settings-file loader exists, so that loader inherits a wired gate instead of an unwritten
// obligation, exactly like P2-H's own rule-side precedent.
export interface HookRegistryOptions {
  trustedWorkspace?: boolean;
  /** WS-23: where a matcher that will not compile is reported, once. Defaults to stderr. */
  warn?: (line: string) => void;
}

export function buildHookRegistry(entries: SourcedHookEntry[], opts?: HookRegistryOptions): HookRegistry {
  const trustedWorkspace = opts?.trustedWorkspace === true;
  const warn = opts?.warn ?? ((line: string) => console.error(line));
  // WS-23: `""` is claude's spelling of "every occurrence", so it is normalised to ABSENT here -- the
  // one spelling everything downstream already reads that way (engine.ts's alias-identity probe
  // counts only `matcher !== undefined` entries as tool-SCOPED, and a match-all hook must not count).
  const normalised = entries.map((e): SourcedHookEntry => {
    if (e.matcher !== "") return e;
    const rest: SourcedHookEntry = { ...e };
    delete rest.matcher;
    return rest;
  });
  const gated = trustedWorkspace ? normalised : normalised.filter((e) => e.source !== "project" && e.source !== "local");
  // Explicit index-tiebreak stable sort (rather than relying on Array.prototype.sort's ES2019+
  // stability guarantee implicitly) — self-documents "registration order within one source" as an
  // intentional invariant, not an accident of engine behavior.
  const sorted = gated
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => SOURCE_RANK[a.entry.source] - SOURCE_RANK[b.entry.source] || a.index - b.index)
    .map(({ entry }) => entry);
  // Compiled once per DISTINCT pattern (so a bad one warns once, however many entries share it).
  const compiledByPattern = new Map<string, CompiledMatcher>();
  const compiledFor = (matcher: string | undefined): CompiledMatcher | undefined => {
    if (matcher === undefined) return undefined;
    let compiled = compiledByPattern.get(matcher);
    if (compiled === undefined) {
      compiled = compileMatcher(matcher, warn);
      compiledByPattern.set(matcher, compiled);
    }
    return compiled;
  };
  for (const entry of sorted) if (isToolScopedHookEvent(entry.event) || MATCHER_SUBJECT_FIELD[entry.event] !== undefined) compiledFor(entry.matcher);

  return {
    matching(event, toolName) {
      const forEvent = sorted.filter((e) => e.event === event);
      if (isToolScopedHookEvent(event)) return forEvent.filter((e) => matcherApplies(compiledFor(e.matcher), toolName));
      // WS-23: a lifecycle event with a subject, and the caller named one -- see MATCHER_SUBJECT_FIELD.
      if (MATCHER_SUBJECT_FIELD[event] !== undefined && toolName !== undefined) return forEvent.filter((e) => matcherApplies(compiledFor(e.matcher), toolName));
      return forEvent; // §1.3: matcher never consulted for these.
    },
  };
}
