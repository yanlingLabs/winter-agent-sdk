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
}
