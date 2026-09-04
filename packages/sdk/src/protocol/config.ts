// The wire-adjacent config contract the wrapper serializes as `--config-json` argv (WS-04 §7/§8)
// and the runtime (and, later, the compiled `winter` binary, Task 4) parses back. Lives in the sdk
// per Ruling P1-A: the plan's Task 3 interface block placed this runtime-side, but the sdk builds
// and serializes it while never being allowed to import the runtime (WS-02 §3) — so the contract
// itself has to live on the sdk side of that boundary, with the runtime importing it from here.
//
// Task 2 (this file's origin) only populates/consumes sessionId/cwd/model; the remaining fields
// are the full shape Task 3 (turn engine) and Task 9 (resume/continue/fork) will read — declared
// now so every producer/consumer across tasks compiles against one definition from the start.
//
// Task 5 (WS-07 §3.3 / phase ruling 1): allowedTools/disallowedTools/permissions/settingSources
// mirror Options' own fields (options.ts) exactly — same optional raw-string-grammar shapes, same
// serialize-only posture. The runtime engine (a later task) is the actual consumer.
import type { RuleSource, HookSource } from "../permissions/types.ts";

// Task 9 (WS-08 §1/§2; phase ruling 1: "the config carries the source-tagged registration list"):
// the wire-safe shape of one `{matcher?, hooks: HookHandler[]}` registration group AFTER its actual
// `HookCallback` functions have been stripped (functions are not JSON-safe — see options.ts's own
// `hooks?` field comment for why `Options.hooks` itself is never serialized directly). Only the
// STRUCTURE survives: how many hooks this group holds (`hookCount`), their shared matcher/timeout,
// and which source authored them. A real per-hook identity for routing an inbound `hook`
// control_request back to the correct callback is POSITIONAL — `${event}:${source}:${groupIndex}:
// ${hookIndex}` — deterministic from this shape alone on both sides of the wire, so no per-hook id
// needs to round-trip here. Building this from a real `Options.hooks` (query.ts) and consuming it
// into a `HookRegistry` (packages/runtime/src/hooks/registry.ts) are both later-task wiring; this
// interface only pins the shape both sides will agree on.
export interface RuntimeHookMatcherGroup {
  matcher?: string;
  hookCount: number;
  timeoutSec?: number; // HookCallbackMatcher.timeout's own pinned unit (derived-shapes item (a)/(f)) -- SECONDS, not ms; the runtime converts once, at registry-build time (see hooks/registry.ts's own header).
  source: HookSource;
  // Task 10: per-hook names (index-aligned with the stripped HookCallback array, length ===
  // hookCount when present), sourced from each callback's own JS `.name` (an anonymous/arrow
  // function has one of `""`, threaded through as `null` rather than an empty string so a real,
  // deliberately-blank name and "no name available" stay distinguishable). `Array<string | null>`,
  // NOT `Array<string | undefined>` -- a `HookCallback` array can only ever be built host-side by
  // query.ts, which then JSON-serializes this whole config into `--config-json`; JSON.stringify
  // silently turns an `undefined` array element into `null` on the wire regardless of what TypeScript
  // declares, so typing it `undefined` here would just be a compile-time lie about the runtime's own
  // parsed shape (exactOptionalPropertyTypes catches exactly this class of mismatch for object
  // fields, but not array elements, which is why this needed writing down explicitly rather than
  // relying on the type checker to catch it). Absent entirely (not just an empty array) when no
  // group in this event has any hook name worth carrying — see query.ts's own builder.
  hookNames?: Array<string | null>;
}

// Keyed by an OPEN string, deliberately NOT the closed `HookEvent` union `Options.hooks` itself uses
// (options.ts) — mirrors this file's own `permissionMode?: string` precedent immediately below
// ("the wire stays an open string; the runtime is what interprets it"), except here an unrecognized
// key resolves to INERT-AND-PRESERVED, never a typed startup error (WS-08 §1: "unknown event names
// in configuration are accepted, preserved, and inert — never an error, never silently renamed").
// Without this, "unknown event names accepted" would be untypeable at the wire layer.
export type RuntimeHooksConfig = Partial<Record<string, RuntimeHookMatcherGroup[]>>;

// Task 8 (P3 close-out, "Settings threading" MUST; WS-12 §2): the CC-shaped sandbox configuration
// surface, mirrored HERE rather than imported from packages/runtime/src/sandbox/profile.ts's own
// `SandboxSettings` -- WS-02 §3's one-directional import rule ("the sdk never imports the runtime")
// forbids the reverse. Kept structurally IDENTICAL to that module's own type (same optional fields,
// same shapes) on purpose: engine.ts assigns a `RuntimeConfig.sandbox` value straight into a
// `SandboxSettings`-typed field with no remapping function, which only type-checks at all because
// TypeScript's structural typing treats the two independently-declared interfaces as interchangeable
// so long as they stay in sync. If `packages/runtime/src/sandbox/profile.ts`'s own `SandboxSettings`
// ever grows/renames a field, this declaration needs the identical edit.
export interface SandboxSettingsConfig {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  filesystem?: { allowWrite?: string[]; denyWrite?: string[]; denyRead?: string[] };
  network?: { allowedDomains?: string[]; deniedDomains?: string[]; [key: string]: unknown };
}

// --- Phase 4 Task 2 (WS-09 derived-shapes item (a)/(d)): MCP server config + AgentDefinition -------
//
// These are the WIRE-CROSSING shapes options.ts's own host-facing types are built FROM (see that
// file's own header for the full rationale). Defined here, not options.ts, so config.ts stays the
// single source of truth for every field the two layers share unchanged -- mirroring
// SandboxSettingsConfig's own precedent immediately above (one declaration, reused as-is where no
// layer needs to diverge).
//
// `McpServerConfigForProcessTransport` deliberately excludes the one variant options.ts's own
// `McpServerConfig` union adds on top (`McpSdkServerConfigWithInstance`, carrying a live,
// non-serializable `@modelcontextprotocol/sdk` object) -- exactly matching the pinned OFFICIAL SDK's
// own twin-union split for the identical reason (derived-shapes-p4.md item (a)): a live instance can
// never cross this package's own process/wire boundary (query.ts's `--config-json` argv). This is
// the type RuntimeConfig.mcpServers below actually carries, and the type Lane A (Task 4)/Task 3
// consume runtime-side (imported via this package's index.ts, never options.ts, which the runtime
// package never imports -- WS-02 §3).
export interface McpServerToolPolicy {
  name: string;
  permission_policy?: "always_allow" | "always_ask" | "always_deny";
  org_max_permission?: "allow" | "ask" | "blocked"; // doc-asserted: drives the auto-mode isOrgAskCeiling gate
}
export interface McpStdioServerConfig {
  type?: "stdio"; // the ONLY optional discriminant of the four transport variants (derived-shapes item (a))
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number; // milliseconds; values below 1000ms are doc-asserted ignored (derived-shapes item (a))
  alwaysLoad?: boolean;
}
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  tools?: McpServerToolPolicy[]; // present on http/sse only -- absent from stdio (no remote-admin-policy surface for a local child process)
  timeout?: number;
  alwaysLoad?: boolean;
}
export interface McpSSEServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  tools?: McpServerToolPolicy[];
  timeout?: number;
  alwaysLoad?: boolean;
}
// Phase 4 Task 3 (WS-04 addendum -- "sdk_mcp_call host-side bridge", ledgered in T2's own report
// concern 1 "PLAN GAP"): a JSON-safe mirror of registry.ts's own McpToolDefinition, WINTER-OWNED and
// NOT part of the pinned official declaration (which has no `tools[]` field on this variant at all --
// see McpSdkServerConfig's own comment). This is what closes the actual gap T2 flagged: an
// `Options.mcpServers` entry of `type: "sdk"` has its live `instance` stripped before crossing this
// package's OWN --config-json wire (query.ts's toWireMcpServers, unchanged behavior for that field),
// but with NO tool list at all the spawned runtime process (the child/compiled legs, which never see
// the live instance object) had no way to know the server has any tools to register in the first
// place -- `sdk_mcp_call` alone bridges the CALL, never the DISCOVERY. `inputSchema`/`outputSchema`
// are loosely typed (`Record<string, unknown>`) rather than importing registry.ts's own JSONSchema
// type -- WS-02 §3 forbids this package from importing the runtime package, and a JSON Schema
// object's own shape needs no runtime-side type to cross a wire losslessly.
export interface WireMcpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; title?: string; idempotentHint?: boolean };
  _meta?: Record<string, unknown>;
}
export interface McpSdkServerConfig {
  type: "sdk";
  name: string;
  timeout?: number; // no alwaysLoad, no tools[] on the PINNED official shape -- an in-process SDK server's own "always load" knob is a per-tool _meta mechanism instead (see registry.ts's own ToolDescriptor.alwaysLoad)
  // Phase 4 Task 3, WINTER-OWNED EXTENSION (see WireMcpToolDefinition's own comment just above) --
  // absent whenever the host's own `instance` doesn't structurally implement `listTools()` (see
  // options.ts's own WinterMcpServerInstance), so every existing wire trace that carries a
  // `type: "sdk"` entry with a non-conforming `instance` (e.g. query.test.ts's own stripping fixture)
  // stays byte-identical to before this field existed.
  tools?: WireMcpToolDefinition[];
}
export type McpServerConfigForProcessTransport = McpStdioServerConfig | McpHttpServerConfig | McpSSEServerConfig | McpSdkServerConfig;

// derived-shapes item (d): AgentDefinition.mcpServers is a heterogeneous ARRAY (a bare string
// referencing an already-configured session-level server BY NAME, or an inline name-keyed record) --
// never a flat Record like the session-level Options.mcpServers/RuntimeConfig.mcpServers above.
// Always the process-transport-only union, even at the OPTIONS layer (options.ts): a filesystem/
// frontmatter-defined agent can never embed a live JS instance.
export type AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>;

// The WIRE twin of options.ts's own (bare-named) `AgentDefinition` -- identical on every field
// EXCEPT `permissionMode`, which stays an OPEN string here for the exact reason RuntimeConfig's own
// top-level `permissionMode` field does (Ruling 8, this file's own precedent: "the wire stays an open
// string; the runtime is what interprets it") -- this value crosses the SAME `--config-json` JSON
// boundary, nested inside `RuntimeConfig.agents` below, so an invalid string arriving over the wire
// must degrade to a typed startup error at the RUNTIME layer, not be assumed pre-validated by a
// compile-time union that JSON cannot itself enforce. `memory`/`effort` are ALSO closed unions at
// this pinned shape (derived-shapes item (d)) but carry no equivalent established precedent forcing
// them open at the wire layer -- a wrong string surviving there is a narrow semantic-choice bug, not
// a capability/security gate the way an invalid `permissionMode` would be, so only `permissionMode`
// is widened here.
export interface RuntimeAgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string; // bare string, no literal union at all (derived-shapes item (d): materially looser than AgentInput.model's 4-member alias union)
  mcpServers?: AgentMcpServerSpec[];
  criticalSystemReminder_EXPERIMENTAL?: string;
  skills?: string[];
  initialPrompt?: string;
  maxTurns?: number;
  background?: boolean;
  memory?: "user" | "project" | "local";
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | number;
  permissionMode?: string;
  observer?: string;
  observerMessage?: string;
}

export interface RuntimeConfig {
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode?: string;
  maxTurns?: number;
  resume?: string;
  continue?: boolean;
  forkSession?: boolean;
  resumeSessionAt?: string;
  resumeDropsTurn?: boolean;
  persistSession?: boolean;
  winterHome?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  // Task 6 (WS-07 §6.4): disableBypassPermissionsMode nests inside `permissions`, mirroring
  // Options' own field exactly (see options.ts's comment for the naming rationale) — a plain
  // boolean at P2; managed source-tagging arrives at P5.
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[]; disableBypassPermissionsMode?: boolean };
  settingSources?: RuleSource[];
  // Task 6 (WS-07 §6.4, Ruling 8): the wire's own permissionMode field ABOVE stays an open string —
  // only this new field is added here. Selecting/switching into "bypassPermissions" requires this to
  // be `true`; the runtime engine gates both the initial config value and every later
  // set_permission_mode control request against it (packages/runtime/src/permissions/
  // policy-state.ts).
  allowDangerouslySkipPermissions?: boolean;
  // Task 9 (WS-08 §1/§2): see RuntimeHooksConfig's own header for the shape and why it is
  // open-keyed. Absent (as it always is until a later task wires query.ts's own Options.hooks ->
  // RuntimeHooksConfig conversion) means "no hook registrations at all" -- a registry built from an
  // absent/empty config behaves byte-identically to the pre-hooks engine (every event resolves
  // no-opinion), which is what keeps hooks default-off from touching any existing wire trace.
  hooks?: RuntimeHooksConfig;
  // Task 10 (WS-08 §9): Options.includeHookEvents's own wire mirror -- see that field's comment
  // (options.ts) for the gate's exact semantics and the SessionStart/Setup exemption.
  includeHookEvents?: boolean;
  // Finding 6 (P2 fix-wave): Options.permissionPromptToolName's own wire mirror -- serialized,
  // read by nothing (phase ruling 7; see options.ts's own comment).
  permissionPromptToolName?: string;
  // Finding 6 (P2 fix-wave): Options.additionalDirectories's own wire mirror -- engine.ts threads
  // this into EvaluationContext.additionalDirectories (see options.ts's own comment for the real
  // behavior this unlocks via evaluator.ts's boundedRoots()).
  additionalDirectories?: string[];
  // Task 8 (P3 close-out, "Settings threading" MUST; WS-12 §2): pure passthrough, same conditional-
  // spread convention as every field above -- query.ts never interprets this, it only serializes it.
  // engine.ts is the actual consumer: an absent value keeps the pre-existing behavior every lane
  // shipped against (packages/runtime/src/sandbox/profile.ts's own DEFAULT_SANDBOX_SETTINGS) byte-
  // identical; a present value threads through ToolExecutionContext.sandboxSettings into Bash/
  // Monitor's real executors instead of that hardcoded module constant.
  sandbox?: SandboxSettingsConfig;
  // Task 8 (P3 close-out, "Settings threading" MUST; WS-12 §5.3): a Winter product extension, not a
  // CC-pinned field -- the session's own configured "outputs" directory. Pure passthrough (like
  // `additionalDirectories`): this package creates nothing and validates nothing about the path; the
  // caller is responsible for it existing. Absent means "no OUTDIR export, no extra writable root,"
  // byte-identical to every session before this field existed.
  outputsDir?: string;
  // Part B item 1 (fix wave, P3 close-out): Options.capabilities/toolSearchEnabled/insideSubagent/
  // familyMetadata's own wire mirrors -- see options.ts's own comment for the full rationale
  // (registry.ts's buildAdvertisedSet has carried these input fields since T1; engine.ts's one
  // production call site never had a wire field to read a real value from, so every
  // capability-gated descriptor -- WebSearch/LSP/advisor and I4's twelve executorless tools -- was
  // unconditionally excluded regardless of what a host might supply). Pure passthrough, same
  // convention as `additionalDirectories`/`sandbox`/`outputsDir` above.
  capabilities?: string[];
  toolSearchEnabled?: boolean;
  insideSubagent?: boolean;
  familyMetadata?: { taskNative?: boolean };
  // Phase 4 Task 2 (WS-09 item (a)/(c)/(d)): pure passthrough, same conditional-spread convention as
  // every field above -- query.ts never interprets these. Lane A (Task 4)/Lane C (Task 6)/[WS-14]
  // (toolAliases' official-branch redirection)/T3 (engine wiring, forwardSubagentText's forwarding
  // gate) are the real consumers.
  mcpServers?: Record<string, McpServerConfigForProcessTransport>;
  strictMcpConfig?: boolean;
  toolAliases?: Record<string, string>;
  agents?: Record<string, RuntimeAgentDefinition>;
  forwardSubagentText?: boolean;
  // Phase 4 Task 3 (WS-10 §7/§9, WS-07 §11): set ONLY on a CHILD engine's own RuntimeConfig -- a
  // child is, per R4-4, an in-process `runEngine` instance built by Lane C's own ChildEngineDeps.spawn
  // implementation from the spine's `buildChildInheritance`; these two fields are what let that child
  // run identify itself AS a child to everything already keyed on `insideSubagent` (this field's own
  // pre-existing sibling, above) plus the two things `insideSubagent` alone cannot express: WHICH
  // child (for hook-audit/permission-call correlation, WS-07 §11's own "an agentID" precedent already
  // threaded through HookStageDeps/RunHooksContext/PermissionCall/PromptStageMeta) and whether its
  // filesystem root is pinned to an isolation workspace (WS-10 §8's `isolation: "worktree"` case) --
  // absent for the main (non-child) engine, byte-identical to every session before these fields
  // existed. Both are pure passthrough at the wire layer (query.ts never sets these for its own
  // top-level `query()` call -- only Lane C's own child-spawn path would construct a RuntimeConfig
  // carrying them).
  agentId?: string;
  isolationPinnedCwd?: boolean;
}
