// Task 3 (WS-07 §3.3): the sdk-side pinned-types home for the permissions surface. This file is
// TYPES ONLY (no runtime logic, no fs, no Bun globals) so it stays trivially Node-safe under the
// sdk-fence typecheck (tsconfig.sdk-fence.json) — the fence only matters for files that could
// reference a Bun-only API; a pure `.d.ts`-shaped module can never trip it, but the file still
// lives under packages/sdk/src so the same tsc pass covers it.
//
// SECTIONING: this file grows across three tasks — each section below is a hard boundary future
// tasks extend, never restructure:
//   Task 3  (this task) -- PermissionMode / PermissionBehavior / PermissionRuleValue (WS-07 §3.3
//           / §4, verbatim). Grammar-adjacent types the runtime's pure grammar.ts consumes.
//   Task 5  -- PermissionUpdate (the six-variant union) + PermissionUpdateDestination, verbatim
//           WS-07 §3.3.
//   Task 8  -- CanUseTool + PermissionResult + PermissionDecisionClassification, verbatim WS-07
//           §7.1/§7.2.
// Each addition is its own `// Task N (WS-07 §X):` banner immediately below this comment block —
// do not interleave unrelated fields into an earlier task's banner.

// --- Task 3 (WS-07 §4; derived-shapes-p2.md item (e), the frozen pin-time 0.3.250 declaration) ---
//
// Six-value public union, ARTIFACT ORDER preserved verbatim (derived-shapes-p2.md item (e) quotes
// the pinned declaration's own member order at sdk.d.ts:2234 — WS-07 §4's prose lists the same six
// members in a different order, which is irrelevant for a union type but this file follows the
// artifact's literal spelling+order per this task's shape-authority instruction). `"manual"` is
// deliberately NOT a member: derived-shapes item (e) shows it is a settings/CLI-layer alias that
// resolves to `"default"` before a typed PermissionMode value ever exists — never a seventh value
// here (WS-07 §4).
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

// --- Task 3 (WS-07 §3.3, verbatim) ---
//
// `PermissionRuleValue.ruleContent` is the exact `Tool(specifier)` rule-content grammar this
// package's runtime-side `grammar.ts` (packages/runtime/src/permissions/grammar.ts — deliberately
// NOT in this sdk package; see that file's own header) parses via `parseRule`. `toolName` here is
// the SETTINGS-LEVEL field name and is NOT always identical to a parsed rule's own `toolName`: for
// an MCP rule the settings `toolName` IS the (possibly globbed) `mcp__server__tool` string with no
// separate `ruleContent` at all (WS-07 §3's MCP bullet) — `ruleContent` is only ever present for
// tools that use the parenthetical-specifier grammar.
export type PermissionBehavior = "allow" | "deny" | "ask";
export type PermissionRuleValue = { toolName: string; ruleContent?: string };

// --- Task 5 (WS-07 §3.3, verbatim) ---
//
// The six-variant PermissionUpdate union + its destination enum, quoted verbatim from WS-07 §3.3
// (itself citing report §28.3). `canUseTool` (Task 8) receives these as ready-made `suggestions`
// and may echo selected entries back as `updatedPermissions` — Winter's engine (Task 6) is the only
// intended PRODUCER of a `suggestions` array; this file only pins the shape. Every member's
// `destination` is a `PermissionUpdateDestination` — note there is no "managed" member: managed
// policy is never a live-update destination (it is provisioned wholesale, out of band, and re-fed
// into a `SourcedRuleSet` only as an INJECTED source per ruling 1 below) — this is load-bearing for
// packages/runtime/src/permissions/ruleset.ts's authority-validation design (see that file's own
// header for the consequence).
export type PermissionUpdate =
  | { type: "addRules"; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: "replaceRules"; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: "removeRules"; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: "setMode"; mode: PermissionMode; destination: PermissionUpdateDestination }
  | { type: "addDirectories"; directories: string[]; destination: PermissionUpdateDestination }
  | { type: "removeDirectories"; directories: string[]; destination: PermissionUpdateDestination };

export type PermissionUpdateDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";

// --- Task 5 (WS-07 §3.2 — Winter-original; NOT part of the pinned upstream type surface) ---
//
// Models WS-07 §3.2's prose source list ("managed policy, SDK-managed settings, CLI arguments,
// user settings, project settings, local settings, session updates") as a discriminated string
// union. Deliberately kept in its own block, separate from the verbatim §3.3 shapes just above, so
// a future conformance sweep that treats this file as "everything here is a pinned upstream type"
// never mistakes a Winter-only modeling choice for a divergence from the artifact. Every
// `SourcedRuleSet` entry (packages/runtime/src/permissions/ruleset.ts) carries exactly one of
// these; `PermissionUpdateDestination` above maps onto the five of these it can reach live
// (userSettings->user, projectSettings->project, localSettings->local, session->session,
// cliArg->cliArg) — "managed" and "sdk" are only ever produced by injection (ruling 1: P2 rule
// sources are injected, source-tagged inputs; P5's file loader and Options.allowedTools/
// disallowedTools/permissions respectively feed those two), never by applying a live
// PermissionUpdate.
export type RuleSource = "managed" | "user" | "project" | "local" | "cliArg" | "session" | "sdk";

// --- Task 8 (WS-07 §7.1/§7.2, verbatim; derived-shapes-p2.md item (c) cross-checked field-for-field) ---
//
// `CanUseTool`'s `options` object matches the pinned 0.3.250 declaration EXACTLY: all 11 fields,
// identical names/types/optionality, including the nested `matchedAskRule` shape (derived-shapes
// item (c)'s own verdict: "MATCHES WS-07 §7.1's verbatim block exactly"). Note `matchedAskRule.source`
// is a bare `string` here — NOT `RuleSource` — matching the pinned declaration precisely; the
// runtime's own internal seam (evaluator.ts's PromptStageMeta) is free to be more specific
// (RuleSource narrows to string, so assigning a RuleSource value into this field is always valid).
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;
    displayName?: string;
    description?: string;
    toolUseID: string;
    agentID?: string;
    requestId: string;
    matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
  },
) => Promise<PermissionResult | null>;

// The `null` escape (WS-07 §7.2): valid ONLY after the consumer already sent the matching control
// response out of band (query.__internal.respondPermission, sdk/src/query.ts) echoing `requestId` —
// the SDK then suppresses its own response write. An unaccompanied `null` fails closed (a pending
// permission RPC has no park timeout, WS-04 §3 — an accidental `null` could otherwise block the
// tool indefinitely) rather than hanging.
export type PermissionDecisionClassification = "user_temporary" | "user_permanent" | "user_reject";

export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    };

// --- Task 8 (WS-04 §3's "permission" control-request row; Winter-owned WIRE shape — NOT part of
// the pinned upstream surface, unlike everything above this banner) ---
//
// The full canUseTool argument set, flattened into one JSON-safe control_request payload: every
// CanUseTool `options` field MINUS `signal` (a wrapper-local AbortSignal — never serializable; the
// wrapper mints its own per-request AbortController instead, see query.ts) PLUS `policyVersion`
// (Winter's own addition, WS-07 §2's stale-policy-rejection contract: a permission answer computed
// against a mode/rule snapshot that has since moved on must be discardable and re-evaluated under
// the current policy — every pending decision carries the version it was computed under).
export interface PermissionRequestPayload {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID: string;
  agentID?: string;
  requestId: string;
  matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
  policyVersion: number;
}
