// Task 5 (WS-07 §3.2/§3.3): sourced rule store — precedence, PermissionUpdate application +
// authority validation, and the permission journal.
//
// ARCHITECTURE:
//   - `sourceRule` is the ONE construct-and-validate primitive every producer of a SourcedRuleEntry
//     goes through: applyPermissionUpdate's addRules/replaceRules, buildSdkSourcedEntries (Options
//     seeding), and P5's future file loader (phase ruling 1: "P2 rule sources are INJECTED,
//     source-tagged inputs — P5's file loader later FEEDS this shape"). Every add-time validation
//     carry (T3's `specifier.kind === "invalid"`, WS-07 §3's unanchored-MCP-allow-glob rejection,
//     Ruling P2-E's Read/Edit glob-depth cap) lives HERE, once, so no producer can bypass it.
//   - `applyPermissionUpdate` is a PURE function (no fs) — it never mutates its `set` argument and
//     performs no I/O. It applies the six WS-07 §3.3 update variants, enforces destination-
//     authority validation, and returns a new SourcedRuleSet. An unrecognized `type` is returned
//     completely unchanged (WS-07 §3.3's lossless-round-trip mandate) — the actual byte-for-byte
//     persistence of that unknown payload is `appendPermissionJournal`'s job, not this function's.
//   - `resolveRules` reports which of the three rule-based WS-07 §2 stages (deny/ask/allow) have a
//     matching entry for one call — independently, with no short-circuit and no specificity
//     comparison between rules (WS-07 §2's evaluation order is a FIXED stage sequence, not "most
//     specific wins"; ask is stage 3 and allow is stage 5, so ask always precedes allow regardless
//     of which rule is narrower). Applying the actual "deny beats allow" / mode-interleaving
//     decision across all six WS-07 §2 stages is a later task's (T6's) evaluator; this function's
//     contract is exactly the brief's given signature — a lookup, not a verdict.
//   - `appendPermissionJournal` is the ONLY fs-touching export here (phase ruling 2) — deliberately
//     a small, standalone function, NOT a SessionStore method (see its own header for why).
//
// DESIGN NOTE — why a SourcedRuleSet entry's `source` is derived from the update's DESTINATION,
// never from the calling `authority`: a live session decision that persists to `projectSettings`
// must take on `source:"project"` immediately, in THIS session's rule set, so the very same trust
// gate resolveRules applies to a rule replayed from disk (P5) also applies to it the moment it is
// added — otherwise live and replayed semantics would diverge (a session could grant itself an
// untrusted-project allow that becomes inert only after a restart). Authority answers a DIFFERENT
// question: who is allowed to author an update destined for a given file/scope at all.
import { parseRule, matchesRule, type ParsedRule } from "./grammar.ts";
import { exceedsDoubleStarCap } from "./paths.ts";
import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  chmodSync,
  mkdirSync,
  lstatSync,
  constants as fsConstants,
} from "node:fs";
import { join } from "node:path";
import type {
  PermissionBehavior,
  PermissionRuleValue,
  PermissionMode,
  PermissionUpdate,
  PermissionUpdateDestination,
  RuleSource,
} from "@yanlinglabs/winter-agent-sdk";

// ---------------------------------------------------------------------------------------------
// SourcedRuleSet
// ---------------------------------------------------------------------------------------------

export interface SourcedRuleEntry {
  rule: ParsedRule;
  behavior: PermissionBehavior;
  source: RuleSource;
  // The original settings-level value this entry was constructed from. ParsedRule alone cannot
  // reconstruct it byte-identically (grammar.ts's parseRule is lossy in the "bare literal on an
  // unrecognized tool" fallback, and normalizes scalar param values) — T8's `matchedAskRule`
  // (WS-07 §7.1) is pinned as exactly `{ source, toolName, ruleContent? }`, so keeping the original
  // value alongside the parsed one lets a future evaluator build that shape directly instead of
  // re-deriving it. It also gives removeRules a clean structural-identity key independent of
  // ParsedRule's own shape.
  ruleValue: PermissionRuleValue;
}

// Extends the brief's one-line `{ entries: [...] }` sketch with `mode`/`directories` — both are
// required to support the setMode/addDirectories/removeDirectories PermissionUpdate variants the
// brief also requires `applyPermissionUpdate` to handle correctly (T4's paths.ts ctx-param
// precedent: extend an illustrative shape when the prose demands more than it shows). Directories
// are source-tagged for the same trust-gating reason entries are (WS-07 §3.2: "additionalDirectories
// grants... require workspace trust" — ungated directories couldn't honor that).
export interface SourcedRuleSet {
  entries: SourcedRuleEntry[];
  mode?: { value: PermissionMode; source: RuleSource };
  directories: Array<{ path: string; source: RuleSource }>;
}

export function emptyRuleSet(): SourcedRuleSet {
  return { entries: [], directories: [] };
}

// ---------------------------------------------------------------------------------------------
// Typed errors — never a silent drop (WS-07 §3.3)
// ---------------------------------------------------------------------------------------------

export class PermissionRuleValidationError extends Error {
  constructor(
    message: string,
    public readonly rule: PermissionRuleValue,
    public readonly behavior: PermissionBehavior,
  ) {
    super(message);
    this.name = "PermissionRuleValidationError";
  }
}

export class PermissionUpdateAuthorityError extends Error {
  constructor(
    message: string,
    public readonly authority: RuleSource,
    public readonly destination: string,
  ) {
    super(message);
    this.name = "PermissionUpdateAuthorityError";
  }
}

// ---------------------------------------------------------------------------------------------
// Rule-value <-> raw grammar-string bridge
// ---------------------------------------------------------------------------------------------

// Inverse of grammar.ts's own (private) RULE_SHAPE parse: `{toolName, ruleContent}` -> the raw
// `Tool` / `Tool(specifier)` string parseRule consumes. types.ts's own PermissionRuleValue comment
// already documents this exact reconstruction rule.
function ruleValueToRaw(v: PermissionRuleValue): string {
  return v.ruleContent !== undefined ? `${v.toolName}(${v.ruleContent})` : v.toolName;
}

// Mirrors grammar.ts's own private RULE_SHAPE regex (duplicated rather than imported: T3/grammar.ts
// is complete and this task's edit authorization does not extend to it — see isAnchoredMcpAllowGlob
// below for the same posture). Only needed for buildSdkSourcedEntries, whose inputs
// (Options.allowedTools etc.) are raw strings, not PermissionRuleValue objects.
const RAW_RULE_SHAPE = /^([^\s(]+)\((.*)\)$/s;

function rawToRuleValue(raw: string): PermissionRuleValue {
  const trimmed = raw.trim();
  const m = RAW_RULE_SHAPE.exec(trimmed);
  if (!m) return { toolName: trimmed };
  return { toolName: m[1]!, ruleContent: m[2]! };
}

// ---------------------------------------------------------------------------------------------
// Add-time validation (T3 carry + Ruling P2-E)
// ---------------------------------------------------------------------------------------------

// WS-07 §3: "allow-side tool-name globs are deliberately narrower and require a literal server
// prefix... an unanchored allow glob is rejected." Mirrors grammar.ts's private
// isAnchoredMcpAllowGlob exactly (same 3-line structural check) — duplicated rather than imported
// because grammar.ts does not export it and T3 is complete (this task's brief authorizes exactly
// one probe export, on paths.ts, not grammar.ts). A stable, spec-pinned one-liner; low drift risk.
function isAnchoredMcpAllowGlob(toolName: string): boolean {
  const starIdx = toolName.indexOf("*");
  const prefix = starIdx === -1 ? toolName : toolName.slice(0, starIdx);
  const rest = prefix.slice("mcp__".length);
  return rest.includes("__");
}

// The shared rule-add-time gate every SourcedRuleEntry producer routes through. Throws
// PermissionRuleValidationError (naming the offending rule) rather than silently accepting content
// that would be inert at match time — the exact hazard grammar.ts's own Specifier-type comment
// flags for this task, plus Ruling P2-E's glob-cap carry.
function validateNewRule(value: PermissionRuleValue, behavior: PermissionBehavior): ParsedRule {
  const raw = ruleValueToRaw(value);
  const parsed = parseRule(raw);

  // (a) T3 carry: a syntactically-parsed-but-forbidden rule (today: an MCP tool with ANY
  // parenthetical specifier, WS-07 §3) is silently inert at match time (matchesRule's "invalid"
  // case just returns false) — reject it here instead, at the moment it's added.
  if (parsed.specifier?.kind === "invalid") {
    throw new PermissionRuleValidationError(
      `rule ${JSON.stringify(raw)} is syntactically invalid: ${parsed.specifier.reason}`,
      value,
      behavior,
    );
  }

  // (a) T3 carry, second documented rejection: an unanchored MCP allow-side glob. Direction-
  // conditional in grammar.ts (match-time `false` for "allow" only; legal for deny/ask, WS-07 §3:
  // "deny/ask may use full-name globs") — not representable as `specifier.kind === "invalid"`, so
  // it needs its own add-time check, scoped to allow only.
  if (behavior === "allow" && parsed.toolName.startsWith("mcp__") && parsed.toolName.includes("*") && !isAnchoredMcpAllowGlob(parsed.toolName)) {
    throw new PermissionRuleValidationError(
      `allow rule ${JSON.stringify(raw)} is an unanchored MCP glob — allow-side globs require a literal server prefix (WS-07 §3)`,
      value,
      behavior,
    );
  }

  // (b) Ruling P2-E: a Read/Edit pattern over the glob-depth cap silently compiles to a
  // never-matching regex at match time (paths.ts's compileFsGlobToRegex returns null), a fail-open
  // gap for deny/ask. Checked on the RAW ruleContent string directly — never on
  // parsed.specifier.source — as defense-in-depth: this check's correctness must never depend on
  // which Specifier `kind` grammar.ts's own parseRule happens to classify a Read/Edit rule into;
  // reading the untouched original string is no harder and stays correct regardless of any future
  // change to that classification. (Fix round 1, item 5 — stale-prose correction: earlier prose
  // here justified this by describing a colon-bearing Read/Edit pattern being misclassified as a
  // generic "param" specifier. Fix round 2's Ruling P2-G has since fixed that misclassification
  // directly in grammar.ts — FILE_RULE_TOOLS now dispatches Read/Edit content to `pattern` always —
  // so that specific claim is no longer current behavior. This check was never actually reliant on
  // it: it was, and remains, keyed on toolName===Read/Edit + the raw ruleContent string alone.)
  // Read/Edit only (Ruling P2-E's own scope; paths.ts's module boundary is Read/Edit-only by
  // construction) and only when a ruleContent exists at all (a bare Read/Edit rule has no pattern to
  // measure — out of scope by construction, matching paths.ts's own module-header note).
  if ((parsed.toolName === "Read" || parsed.toolName === "Edit") && value.ruleContent !== undefined) {
    if (exceedsDoubleStarCap(value.ruleContent)) {
      throw new PermissionRuleValidationError(
        `rule ${JSON.stringify(raw)} exceeds the glob depth cap (Ruling P2-E, MAX_DOUBLE_STARS)`,
        value,
        behavior,
      );
    }
  }

  return parsed;
}

// The one construct-and-validate primitive every SourcedRuleEntry producer uses (see module
// header). Exported: this is the exact seam phase ruling 1 names for P5's future file loader.
export function sourceRule(value: PermissionRuleValue, behavior: PermissionBehavior, source: RuleSource): SourcedRuleEntry {
  const parsed = validateNewRule(value, behavior);
  return { rule: parsed, behavior, source, ruleValue: value };
}

// ---------------------------------------------------------------------------------------------
// Destination <-> source mapping
// ---------------------------------------------------------------------------------------------

// WS-07 §3.3's PermissionUpdateDestination union has no "managed" member — managed policy is never
// a live-update destination (see types.ts's own comment on PermissionUpdate). This mapping is total
// over the 5 pinned destinations; DESTINATION_TO_SOURCE[d] is therefore NEVER "managed", which is
// exactly what makes replaceRules/addRules/setMode/addDirectories structurally unable to ever touch
// a managed-sourced entry (see applyPermissionUpdate's own per-case comments).
const DESTINATION_TO_SOURCE: Record<PermissionUpdateDestination, RuleSource> = {
  userSettings: "user",
  projectSettings: "project",
  localSettings: "local",
  session: "session",
  cliArg: "cliArg",
};

function isKnownDestination(d: string): d is PermissionUpdateDestination {
  return Object.prototype.hasOwnProperty.call(DESTINATION_TO_SOURCE, d);
}

// Defensive, wire-input-facing check: even though every KNOWN PermissionUpdate variant types its
// own `destination` as PermissionUpdateDestination, that guarantee is a compile-time one — an
// update arriving over the actual host<->runtime wire has already gone through JSON.parse by the
// time it reaches this function, so a forged/corrupt destination string is a real runtime
// possibility, not just a type-system exercise. Judgment call: applies uniformly to all six known
// update types (not just the ones the brief's own fixture list names) for a single, simple,
// consistently-enforced rule rather than a per-variant carve-out.
function assertKnownDestination(destination: string, authority: RuleSource): asserts destination is PermissionUpdateDestination {
  if (!isKnownDestination(destination)) {
    throw new PermissionUpdateAuthorityError(`unrecognized PermissionUpdateDestination ${JSON.stringify(destination)}`, authority, destination);
  }
}

// Judgment call (flagged in the report): a minimal authority -> destination matrix. `cliArg` is a
// startup-only bootstrap destination — the CLI's own flag parser is the only plausible author of a
// cliArg-sourced rule, so no other authority may retroactively author one. Every other destination
// is open to any authority: this is the sanctioned "approve and remember" live-decision flow
// (WS-07 §3.3's localSettings echo; §6.1's persisted don't-ask-again decisions) — including
// projectSettings, whose untrusted-workspace overreach risk is independently neutralized at
// RESOLUTION time by resolveRules' trust gate on `source:"project"` allow entries (see this
// module's design note above), not by blocking the write here.
function assertAuthorityMayWriteDestination(destination: PermissionUpdateDestination, authority: RuleSource): void {
  if (destination === "cliArg" && authority !== "cliArg") {
    throw new PermissionUpdateAuthorityError(
      `authority ${JSON.stringify(authority)} may not author a cliArg-destined update (cliArg is startup-bootstrap only)`,
      authority,
      destination,
    );
  }
}

// WS-07 §3.2: "Managed rules cannot be weakened by CLI or lower settings." Enforced at the one place
// it is actually reachable: removeRules/removeDirectories can name (and therefore attempt to
// delete) a currently-managed-sourced entry by structural identity, regardless of the update's own
// destination (see applyPermissionUpdate's removeRules case for why that matching is deliberately
// cross-source). addRules/replaceRules/setMode/addDirectories can never reach a managed entry at
// all — they only ever ADD/REPLACE entries tagged via DESTINATION_TO_SOURCE, which never yields
// "managed" — so this guard is only invoked from the two removal paths.
function assertMayTouchManagedSource(currentSource: RuleSource, authority: RuleSource, describeTarget: () => string): void {
  if (currentSource === "managed" && authority !== "managed") {
    throw new PermissionUpdateAuthorityError(
      `authority ${JSON.stringify(authority)} may not remove or weaken a managed-sourced ${describeTarget()}`,
      authority,
      "managed",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Structural rule identity (removeRules' matching key)
// ---------------------------------------------------------------------------------------------

// ParsedRule is a plain, JSON-safe tree (toolName/specifier?/isBareEquivalent — grammar.ts's own
// type, no functions/Maps/Sets anywhere in it) produced by the SAME parseRule function on both
// sides of every comparison this module makes, so key insertion order always matches for
// structurally-identical rules. JSON.stringify equality is therefore a safe, simpler stand-in for a
// hand-written field-by-field comparison.
function sameRule(a: ParsedRule, b: ParsedRule): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------------------------
// applyPermissionUpdate — pure, no I/O (see module header)
// ---------------------------------------------------------------------------------------------

export function applyPermissionUpdate(set: SourcedRuleSet, update: PermissionUpdate, opts: { authority: RuleSource }): SourcedRuleSet {
  switch (update.type) {
    case "addRules":
    case "replaceRules":
    case "removeRules":
    case "setMode":
    case "addDirectories":
    case "removeDirectories":
      break;
    default:
      // WS-07 §3.3: "Winter MUST round-trip unknown future update variants losslessly" and keep
      // them "inert in the live set." This function's contract for that case is simply: return the
      // set completely unchanged. Byte-for-byte PERSISTENCE of the unknown payload is
      // appendPermissionJournal's separate responsibility (it journals regardless of what this
      // function does) — no authority/destination validation is attempted here, deliberately: an
      // unrecognized shape cannot be safely interpreted, so it is never rejected for being unknown.
      return set;
  }

  assertKnownDestination(update.destination, opts.authority);
  assertAuthorityMayWriteDestination(update.destination, opts.authority);
  const source = DESTINATION_TO_SOURCE[update.destination];

  switch (update.type) {
    case "addRules": {
      const added = update.rules.map((r) => sourceRule(r, update.behavior, source));
      return { ...set, entries: [...set.entries, ...added] };
    }

    case "replaceRules": {
      // Destination-scoped: replaceRules reassigns ONE file's whole array for (behavior,
      // destination) — matching real settings.json semantics (`permissions.deny = [...]` replaces
      // THAT FILE's array, never another file's). Validate the NEW rules before touching anything,
      // so an invalid replacement rule leaves the set untouched rather than partially applied.
      const added = update.rules.map((r) => sourceRule(r, update.behavior, source));
      const kept = set.entries.filter((e) => !(e.source === source && e.behavior === update.behavior));
      return { ...set, entries: [...kept, ...added] };
    }

    case "removeRules": {
      // Cross-source structural match: removeRules deletes specific NAMED rules wherever they
      // currently live, not just within one destination's own array — a destination-scoped removal
      // would be meaningless (the caller may not know which source currently holds a rule it wants
      // gone) and would also make the managed-unweakenable invariant below unreachable/untestable.
      // This asymmetry with replaceRules (destination-scoped) is a deliberate judgment call —
      // flagged in the report.
      const targets = update.rules.map((r) => parseRule(ruleValueToRaw(r)));
      // Review fix round 1, CRITICAL: for EACH target, ask "does a MANAGED entry match this?"
      // directly — never "grab whichever entry .find() returns first, then check ITS source".
      // The `kept` filter below removes EVERY structurally-matching entry regardless of source, so
      // checking only the first hit let a non-managed duplicate of a managed rule's exact content
      // (in either array position) mask the managed entry entirely: the authority check would pass
      // against the non-managed "hit" while the managed entry was silently swept away by the same
      // filter. Mirrors removeDirectories' own predicate below (a `source === "managed"` term
      // INSIDE the find/some call), which never had this bug because it already asks the direct
      // question instead of inspecting one arbitrary match's source after the fact.
      for (let i = 0; i < update.rules.length; i++) {
        const matchesManagedEntry = set.entries.some(
          (e) => e.behavior === update.behavior && e.source === "managed" && sameRule(e.rule, targets[i]!),
        );
        if (matchesManagedEntry) {
          assertMayTouchManagedSource("managed", opts.authority, () => `rule ${JSON.stringify(ruleValueToRaw(update.rules[i]!))}`);
        }
      }
      const kept = set.entries.filter((e) => {
        if (e.behavior !== update.behavior) return true;
        return !targets.some((t) => sameRule(e.rule, t));
      });
      return { ...set, entries: kept };
    }

    case "setMode":
      return { ...set, mode: { value: update.mode, source } };

    case "addDirectories": {
      const added = update.directories.map((path) => ({ path, source }));
      return { ...set, directories: [...set.directories, ...added] };
    }

    case "removeDirectories": {
      // Symmetry with removeRules: reject before mutating if any named path currently carries
      // source:"managed" and the caller isn't managed itself.
      for (const path of update.directories) {
        const hit = set.directories.find((d) => d.path === path && d.source === "managed");
        if (hit) assertMayTouchManagedSource("managed", opts.authority, () => `directory grant ${JSON.stringify(path)}`);
      }
      return { ...set, directories: set.directories.filter((d) => !update.directories.includes(d.path)) };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// resolveRules — precedence lookup (WS-07 §2/§3.2). A lookup, not a verdict: see module header.
// ---------------------------------------------------------------------------------------------

export function resolveRules(
  set: SourcedRuleSet,
  call: { toolName: string; input: Record<string, unknown> },
  opts: { trustedWorkspace: boolean; allowManagedPermissionRulesOnly?: boolean },
): { deny?: SourcedRuleEntry; ask?: SourcedRuleEntry; allow?: SourcedRuleEntry } {
  // `allowManagedPermissionRulesOnly` (WS-07 §3.2) "limits EFFECTIVE RULES to managed policy" — a
  // total filter over every behavior, applied once, before any of the three lookups below (not an
  // allow-only restriction).
  const pool = opts.allowManagedPermissionRulesOnly ? set.entries.filter((e) => e.source === "managed") : set.entries;

  function firstMatch(behavior: PermissionBehavior, direction: "allow" | "denyAsk"): SourcedRuleEntry | undefined {
    for (const entry of pool) {
      if (entry.behavior !== behavior) continue;
      // WS-07 §3.2: project ALLOW rules require workspace trust; project deny/ask "restrict and
      // apply without it" — so the trust gate applies to the allow behavior only, never deny/ask.
      // Fix round 1, Ruling P2-H: `local` is gated identically to `project` (not just `project`
      // alone) — `.winter/settings.local.json` is repo-committable, carrying the same
      // untrusted-clone self-grant risk WS-07 §3.2 explicitly calls out for project settings; the
      // spec's silence on local's own trust posture resolves to the safe (gated) direction here,
      // per controller ruling — see the report's fix-round section (this supersedes the original
      // report's Open Question 2, which had left `local` ungated).
      if (behavior === "allow" && (entry.source === "project" || entry.source === "local") && !opts.trustedWorkspace) continue;
      if (matchesRule(entry.rule, call, { direction })) return entry;
    }
    return undefined;
  }

  // deny and ask share grammar.ts's conservative "denyAsk" matching direction (wrapper-stripping
  // asymmetry, MCP anchor requirement — both are allow-only concerns); allow uses "allow".
  const deny = firstMatch("deny", "denyAsk");
  const ask = firstMatch("ask", "denyAsk");
  const allow = firstMatch("allow", "allow");

  // Independent slots, no short-circuit (advisor-confirmed judgment call): resolveRules reports
  // WHICH categories match; applying "deny beats allow" across WS-07 §2's full six-stage order
  // (hooks, deny, ask, mode, allow, canUseTool) is the evaluator's (a later task's) job, not this
  // lookup's. exactOptionalPropertyTypes: conditional spread rather than `deny: deny` (which would
  // assign a statically `SourcedRuleEntry | undefined` value into an optional-but-not-undefined
  // property).
  return {
    ...(deny !== undefined ? { deny } : {}),
    ...(ask !== undefined ? { ask } : {}),
    ...(allow !== undefined ? { allow } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// effectiveDirectories — same trust-gating principle applied to additionalDirectories grants
// ---------------------------------------------------------------------------------------------

// WS-07 §3.2: "Project .winter/ ... additionalDirectories grant capability and require workspace
// trust." resolveRules' call-shaped signature has no room for a directory-grant lookup (a grant
// isn't about one tool call), so this is a small sibling helper — the ready-made consumption point
// a later task's evaluator (checking whether a path falls inside cwd/additionalDirectories) can use
// directly, rather than leaving `SourcedRuleSet.directories`' source-tagging inert and untested.
// Fix round 1, Ruling P2-H: `local` is gated exactly like `project`, for the identical reason
// resolveRules' own trust gate now covers both (see that function's comment).
export function effectiveDirectories(set: SourcedRuleSet, opts: { trustedWorkspace: boolean }): string[] {
  return set.directories.filter((d) => (d.source !== "project" && d.source !== "local") || opts.trustedWorkspace).map((d) => d.path);
}

// ---------------------------------------------------------------------------------------------
// buildSdkSourcedEntries — Options.{allowedTools,disallowedTools,permissions} seed builder
// ---------------------------------------------------------------------------------------------

export interface SdkOptionsRuleInputs {
  allowedTools?: string[];
  disallowedTools?: string[];
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
}

// Converts the raw-string Options fields (options.ts/protocol/config.ts) into source:"sdk"
// SourcedRuleEntry values, running the SAME add-time validation (via sourceRule) every other rule
// source gets — an invalid rule here fails loud at seeding time, rather than reproducing the exact
// silently-inert hazard this whole module exists to close off for live updates. Not wired into the
// engine by this task (that is a later task's job, per WS-07 §7's PolicyState integration) — this
// is the pure, standalone conversion function that consumer will call.
export function buildSdkSourcedEntries(opts: SdkOptionsRuleInputs): SourcedRuleEntry[] {
  const entries: SourcedRuleEntry[] = [];
  const addAll = (raws: string[] | undefined, behavior: PermissionBehavior): void => {
    for (const raw of raws ?? []) entries.push(sourceRule(rawToRuleValue(raw), behavior, "sdk"));
  };
  addAll(opts.allowedTools, "allow");
  addAll(opts.disallowedTools, "deny");
  addAll(opts.permissions?.allow, "allow");
  addAll(opts.permissions?.ask, "ask");
  addAll(opts.permissions?.deny, "deny");
  return entries;
}

// ---------------------------------------------------------------------------------------------
// appendPermissionJournal — phase ruling 2 (the only fs-touching export in this module)
// ---------------------------------------------------------------------------------------------

const KNOWN_UPDATE_TYPES = new Set(["addRules", "replaceRules", "removeRules", "setMode", "addDirectories", "removeDirectories"]);
const FILE_DESTINATIONS = new Set(["userSettings", "projectSettings", "localSettings"]);

// A minimal, locally-owned safety net mirroring session-store.ts's assertSafeSingleSegment (that
// function lives in the sdk package's store module, not reachable here without a deep import the
// sdk's own package.json "exports" is closed against — see the module header on writeAllSync for
// the same reachability note). Small and duplicated deliberately, not because the logic is complex.
function assertSafePathSegment(value: string, label: string): void {
  if (value === "" || value === "." || value === ".." || value.includes("/")) {
    throw new Error(`${label} must be a single, non-empty, non-traversal path segment: ${JSON.stringify(value)}`);
  }
}

// Fully writes `buf` to `fd`, looping on the rare partial-write return from a single writeSync call
// — mirrors packages/sdk/src/store/leases.ts's own writeAllSync exactly (that function is not
// reachable from this package: the sdk's package.json "exports" is closed to "." with no subpath,
// and no runtime file does a deep import today — see leases.ts for the original). A small,
// deliberate duplication of a ~6-line loop.
function writeAllSync(fd: number, buf: Buffer): void {
  let written = 0;
  while (written < buf.length) {
    written += writeSync(fd, buf, written, buf.length - written);
  }
}

const APPEND_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;

export class PermissionJournalDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionJournalDirError";
  }
}

// Fix round 1, MINOR: mirrors session-store.ts's own ensureSecureDir exactly (per-level symlink
// lstat + ownership check + idempotent chmod) for the SAME <winterHome>/projects/<projectKey>/
// chain the session store itself creates and validates — a plain recursive mkdir (this function's
// pre-fix-round-1 behavior) has none of these checks, leaving the journal's own directory levels
// open to a planted symlink or a foreign-uid directory the way the store's own module explicitly
// guards against for every OTHER file under this same tree. Reimplemented locally rather than
// imported: session-store.ts's ensureSecureDir/realUid are private (unexported) even within the
// sdk package's own barrel, and the sdk's package.json "exports" has no subpath for a deep import
// either — see writeAllSync's own comment for the identical reachability note.
function realUid(): number {
  return process.getuid!(); // POSIX-only, Bun-only + macOS-first runtime (session-store.ts's own precedent)
}

function ensureSecureJournalDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (err) {
    if ((err as { code?: unknown }).code !== "EEXIST") throw err;
  }
  const stat = lstatSync(path); // lstat, never stat — a symlink (dangling or not) must be caught
  if (stat.isSymbolicLink()) throw new PermissionJournalDirError(`refusing a symlink at a level the permission journal must own: ${path}`);
  if (!stat.isDirectory()) throw new PermissionJournalDirError(`expected a directory, found something else at: ${path}`);
  if (stat.uid !== realUid()) throw new PermissionJournalDirError(`refusing a directory owned by a different uid: ${path}`);
  chmodSync(path, 0o700); // idempotent self-heal, umask-proof
}

function projectDir(location: { winterHome: string; projectKey: string }): string {
  assertSafePathSegment(location.projectKey, "projectKey");
  return join(location.winterHome, "projects", location.projectKey);
}

function journalPath(location: { winterHome: string; projectKey: string; sessionId: string }): string {
  assertSafePathSegment(location.sessionId, "sessionId");
  return join(projectDir(location), `${location.sessionId}.permission-journal.jsonl`);
}

// Validates+creates every directory LEVEL top-down (winterHome itself, its projects/ child, and
// the specific projectKey/ grandchild) — mirrors session-store.ts's own locateResource/dirLevels
// walk exactly, applying ensureSecureJournalDir to each rather than a single opaque
// `mkdirSync(dir, {recursive:true})` call, which validates nothing about any level it silently
// creates or reuses.
function ensureJournalDirChain(location: { winterHome: string; projectKey: string }): void {
  const projectsDir = join(location.winterHome, "projects");
  const projDir = projectDir(location);
  for (const level of [location.winterHome, projectsDir, projDir]) ensureSecureJournalDir(level);
}

// Appends one JSONL line, mirroring session-store.ts's own appendLinesAtomically discipline exactly
// (O_APPEND|O_CREAT|O_WRONLY|O_NOFOLLOW, full write, fsync, close, then a self-healing chmod 0600 —
// see that function for the identical shape). Directory creation/validation happens separately, in
// ensureJournalDirChain, before this is ever called.
function appendJsonLine(path: string, value: unknown): void {
  const data = Buffer.from(JSON.stringify(value) + "\n", "utf8");
  const fd = openSync(path, APPEND_FLAGS, 0o600);
  try {
    writeAllSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

// Fix round 1, MAJOR: every journal line is an ENVELOPE, never the bare update. Serializing the
// bare update destroys WHO authored it — P5's replay would then have nothing but the update's own
// `destination` field to infer provenance from, and destination alone is not authority (this
// module's design note above: source is destination-derived, but authority is a separate
// question). Concretely, without this envelope: a session-authored "remember this" targeting
// `userSettings` would replay identically to one a real user-settings FILE EDIT produced, silently
// promoting a one-off live decision into durable, globally-trusted `source:"user"` policy on every
// future session. `authority` is a SIBLING field, never spread into `update` — a future
// PermissionUpdate variant that happens to define its own `authority` key must never be shadowed
// or corrupted by the envelope's own; the payload inside `update` stays byte-preserved no matter
// what wraps around it (see the "never shadowed" fixture in ruleset.test.ts).
export interface PermissionJournalEnvelope {
  authority: RuleSource;
  at: string; // ISO 8601, via Date.prototype.toISOString()
  update: PermissionUpdate;
}

// Phase ruling 2: "a PermissionUpdate with a file destination (userSettings/projectSettings/
// localSettings) applies session-effective immediately AND appends to
// <sessionId>.permission-journal.jsonl... for P5 replay." A `session`/`cliArg`-destined update is
// never persisted (ephemeral by construction — nothing to replay). An UNRECOGNIZED update `type` is
// always journaled regardless of its claimed destination (including a missing/malformed one): WS-07
// §3.3's lossless mandate means Winter cannot safely interpret an unknown shape well enough to
// decide it does NOT need persisting, so the conservative default — always record it — is the only
// one that cannot silently drop a future host's real update. `opts.authority` identifies who is
// making THIS call (the same provenance `applyPermissionUpdate`'s own `opts.authority` carries —
// a caller wiring both together passes the identical value to each).
export function appendPermissionJournal(
  location: { winterHome: string; projectKey: string; sessionId: string },
  update: PermissionUpdate,
  opts: { authority: RuleSource },
): void {
  const isKnownType = typeof (update as { type?: unknown }).type === "string" && KNOWN_UPDATE_TYPES.has((update as { type: string }).type);
  if (isKnownType) {
    const destination = (update as { destination?: unknown }).destination;
    if (typeof destination !== "string" || !FILE_DESTINATIONS.has(destination)) return;
  }
  ensureJournalDirChain(location);
  const envelope: PermissionJournalEnvelope = { authority: opts.authority, at: new Date().toISOString(), update };
  appendJsonLine(journalPath(location), envelope);
}

// ---------------------------------------------------------------------------------------------
// appendHookAuditJournal — Task 10 (WS-08 §9 Amended text / P2-A: "the AUDIT stream ... MUST carry
// all of it per invocation")
// ---------------------------------------------------------------------------------------------
//
// The SAME journal file (<sessionId>.permission-journal.jsonl) also carries hook audit records, as
// a DISTINGUISHABLE line kind (`kind: "hookAudit"`) — a SIBLING shape to PermissionJournalEnvelope's
// own `{authority, at, update}`, never spread into it, so a future P5 replay reading this file for
// PermissionUpdate history can trivially skip audit lines (`kind !== "hookAudit"`, or simply "no
// `update` field") without misinterpreting one as an update, and vice versa. Reuses this module's
// same directory-hardening/atomic-append machinery (ensureJournalDirChain/journalPath/appendJsonLine)
// — deliberately NOT a second file: the brief's own instruction is "journaled to the audit line OF
// THE PERMISSION JOURNAL," not a new sidecar.
//
// A minimal, LOCAL mirror of hooks/runner.ts's own HookAuditRecord field shape, rather than an
// import of that type: permissions/ruleset.ts has never imported from hooks/ (hooks/hook-stage.ts
// and hooks/registry.ts both import FROM permissions/, the opposite direction), and this is
// deliberately not the place that starts that coupling — engine.ts (which already depends on both
// packages) is where the real HookAuditRecord value gets produced and handed in here; this type is
// intentionally WIDER (plain `string` where runner.ts's own type has a literal union) so passing a
// real HookAuditRecord value here type-checks with no cast (a narrower source type is always
// assignable to this wider parameter shape).
export interface HookAuditJournalRecord {
  hookId: string;
  hookName?: string;
  hookEvent: string;
  sessionId: string;
  uuid: string;
  toolUseID?: string;
  requestId?: string;
  outcome: string;
  decision?: string;
  durationMs?: number;
  // Finding 11 (P2 fix-wave, NIT): mirrors hooks/runner.ts's own HookAuditRecord.agentID — this
  // type's wider-string typing (its own header: "intentionally WIDER... so passing a real
  // HookAuditRecord value here type-checks with no cast") already absorbs it with no further change.
  agentID?: string;
}

export interface HookAuditJournalEnvelope {
  kind: "hookAudit";
  at: string; // ISO 8601, via Date.prototype.toISOString()
  entry: HookAuditJournalRecord;
}

export function appendHookAuditJournal(location: { winterHome: string; projectKey: string; sessionId: string }, entry: HookAuditJournalRecord): void {
  ensureJournalDirChain(location);
  const envelope: HookAuditJournalEnvelope = { kind: "hookAudit", at: new Date().toISOString(), entry };
  appendJsonLine(journalPath(location), envelope);
}
