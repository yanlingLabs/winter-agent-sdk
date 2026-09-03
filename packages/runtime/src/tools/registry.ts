// WS-06 §1: the ToolDescriptor registry -- the one object every consumer (ToolSearch, permissions,
// hooks, telemetry, execution) operates on (report §85). This module owns:
//   - the ToolDescriptor/RegisteredTool/ToolExecutionContext/ToolExecutor shapes (§1.1, verbatim,
//     plus the seams Phase 3's task-1 brief pins on top of it),
//   - the module-level registry index (a singleton -- see "Why a singleton" below),
//   - availability resolution + buildAdvertisedSet (§1.5),
//   - the ENGINE-FACING adapter (buildRegistryToolExecutor) that lets engine.ts dispatch a tool_use
//     call through this registry while its own pre-existing ToolExecutor seam (`{id,name,input} ->
//     {output}`) stays byte-for-byte untouched -- see that function's own header for the wrap
//     contract, and engine.ts's own comment at its call site for how the two are stitched together.
//
// Ownership boundary (R3-5): this file (the "index") is edited ONLY by this task, forever. Every
// descriptors/*.ts file registers exactly one stub via `registerTool` at module load; every later
// lane's REAL executor lives in a SIBLING `tools/impl/*.ts` file that imports `replaceExecutor` --
// lanes never edit a descriptor file or this one.
//
// Why a singleton (not a per-run instance): the registry is a CATALOG (which tools Winter knows how
// to describe/execute), not session data -- every engine run in one process shares the identical
// set of tool DEFINITIONS, and `registerTool`/`replaceExecutor` are specified as free top-level
// functions, not methods on a constructed instance (task-1 brief's own Interfaces block). Per-session
// state (cwd, permission mode, read history, background tasks) lives on ToolExecutionContext
// instead, built fresh per call by buildRegistryToolExecutor below. Verified empirically that bun's
// test runner shares ONE module registry across every test file in a `bun test` invocation (a
// module's top-level side effects run exactly once; state persists across files) -- so registry
// MUTATION in tests (replaceExecutor) MUST target throwaway, invented canonical names, never a real
// WS-06 entry, or one test file's mutation would leak into another's assertions. registry.test.ts
// follows that rule throughout.
//
// Deviation note (report this in task-1-report.md): WS-06 §1.1 types `disposition` as a 4-member
// union (`implement-now | implement-later | correctly-absent | winter-backed-equivalent`), but §2's
// own table uses a 5th literal value, `winter-backed-later`, for SendUserFile and
// ShareOnboardingGuide (Artifact's "winter-backed-later" appears only as a prose NOTE about a
// possible future product decision, not as its actual disposition column, which reads
// "correctly-absent (v1)"). Per-tool ground truth (§2/§3) is treated as authoritative over §1.1's
// introductory type sketch; `ToolDisposition` below widens to 5 members rather than silently
// mis-filing those two tools under an existing value.
import type { PermissionMode, BackgroundTaskMessage } from "@yanlinglabs/winter-agent-sdk";
import { parseRule } from "../permissions/grammar.ts";
// Fix round 1, RULING P3-B: probeReadWouldPrompt's boolean widened to this named 3-state result --
// imported (type-only, erased at build time; no runtime cycle since evaluator.ts never imports this
// file) rather than hand-copying the `"silent" | "prompt" | "deny"` literal union in two places.
import type { ReadAccessProbe } from "../permissions/evaluator.ts";
import type { SessionReadState } from "./read-state.ts";
// Task 8 (P3 close-out, "Settings threading" MUST): type-only, erased at build time -- no runtime
// cycle (../sandbox/profile.ts imports only node:path and ../permissions/paths.ts, never this file).
// ToolExecutionContext.sandboxSettings below is what lets Bash/Monitor's real executors read the
// session's EFFECTIVE sandbox config instead of the DEFAULT_SANDBOX_SETTINGS module constant every
// lane shipped against (Lane C's own report, "documented scope gaps": "no `sandbox` field exists
// anywhere in packages/sdk/src").
import type { SandboxSettings } from "../sandbox/profile.ts";

// --- §1.1: ToolDescriptor + supporting types -----------------------------------------------------

// No canonical JSONSchema type exists anywhere in this monorepo (verified before writing this file)
// -- a minimal, self-describing structural type is enough for a registry that stores/serves schema
// DATA; it is not a validator. Deliberately permissive (an index signature) so a descriptor's schema
// can carry whatever JSON Schema keywords its own WS-06 §3 shape needs without fighting this type.
export interface JSONSchema {
  type?: string | readonly string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema | readonly JSONSchema[];
  required?: readonly string[];
  enum?: readonly unknown[];
  const?: unknown;
  description?: string;
  additionalProperties?: boolean | JSONSchema;
  oneOf?: readonly JSONSchema[];
  anyOf?: readonly JSONSchema[];
  allOf?: readonly JSONSchema[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  [key: string]: unknown;
}

// report §54.
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

// §1.4 table, verbatim set of classes. A descriptor pins exactly ONE -- two §2 rows document a dual
// class in prose (Monitor "execute/network", EnterWorktree/ExitWorktree "mode/edit"); each such
// descriptor file picks the PRIMARY one and records the choice in its own comment (a documented
// judgment call, not a silent one) rather than widening this type to a set.
export type PermissionClass = "read" | "edit" | "execute" | "network" | "interaction" | "messaging" | "task" | "mode" | "mcp" | "hosted";

// §1.5 + hard requirement 6: declarative gates ONLY -- every field here is plain data (strings,
// booleans, arrays), never a closure, so WS-17's capability matrix can be GENERATED by enumerating
// this shape rather than executing code. Absent field = "no restriction on that axis."
export interface AvailabilityPredicate {
  modes?: readonly PermissionMode[];
  platforms?: readonly NodeJS.Platform[];
  requiresFeatures?: readonly string[];
  // WS-09: WaitForMcpServers is advertised only when ToolSearch is disabled.
  requiresToolSearchDisabled?: true;
  // R3-4 (WS-06 open question 3, provisional default): the task graph + TodoWrite are HIDDEN when
  // the resolved model family is marked task-native; absent familyMetadata (no catalog populated
  // yet, P6) reads as "not task-native" -- i.e. SHOWN by default, matching CC's own "older models
  // keep them" behavior this ruling mirrors.
  hiddenWhenFamilyTaskNative?: true;
  // AskUserQuestion: "Not available inside Agent-tool subagents" (WS-06 §3.3). `false` here means
  // "never shown when the caller's own AdvertisedSetInputs.insideSubagent is true" -- a fixed
  // literal (not a boolean) so a descriptor can only ever assert this one direction, matching how
  // every other field above is a plain gate rather than an arbitrary predicate.
  insideSubagent?: false;
}

// See this file's header "Deviation note."
export type ToolDisposition = "implement-now" | "implement-later" | "correctly-absent" | "winter-backed-equivalent" | "winter-backed-later";

export interface ToolDescriptor {
  canonicalName: string;
  advertisedName: string;
  source: "builtin" | "mcp" | "sdk" | "plugin" | "host";
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  description: string;
  searchHint?: string;
  annotations?: ToolAnnotations;
  exposure: "eager" | "deferred" | "hidden";
  permissionClass: PermissionClass;
  availability: AvailabilityPredicate;
  capabilityRequirements: string[];
  disposition: ToolDisposition;
  versionIntroduced?: string;
}

// --- Per-tool execution seams (task-1 brief's Interfaces block, verbatim) --------------------------

// Minimal by design: T1 is the spine, not the wire format. `output` is the model-visible tool_result
// text (folds directly into engine.ts's own pre-existing ContentBlock.tool_result.content); `isError`
// is a structured flag a real executor MAY set so a future task (T2/T8) can surface it more richly
// on the wire -- at T1 the adapter below folds it into `output` itself (see foldResult), since
// engine.ts's existing ToolExecutor contract has no separate per-call error channel to hand it to
// without touching dispatch (forbidden -- "wrap, do not rewrite").
export interface ToolResultPayload {
  output: string;
  isError?: boolean;
}

export interface ToolExecutionContext {
  cwd: string;
  home: string;
  sessionId: string;
  readState: SessionReadState;
  // Phase 3 Task 2 (WS-06 §3.5): narrowed from Task 1's placeholder `unknown` now that the real,
  // closed background-task message union exists (packages/sdk/src/protocol/frames.ts) -- a lane's
  // real tool executor now gets full compile-time checking on what it emits, and engine.ts's own
  // emitFrame closure can hand the value straight to `output.write` with no unchecked cast (see that
  // closure's own header comment, and this field's sibling on RegistryToolExecutorDeps below).
  emitFrame: (frame: BackgroundTaskMessage) => void;
  permissions: { probeReadAccess(filePath: string): ReadAccessProbe };
  tempDir: string;
  // Task 8 (P3 close-out, "Settings threading" MUST): the session's EFFECTIVE sandbox configuration
  // (RuntimeConfig.sandbox, resolved once per run against DEFAULT_SANDBOX_SETTINGS by engine.ts --
  // see buildDefaultToolExecutor's own comment). Non-optional: every ToolExecutionContext this
  // registry ever builds carries a real, resolved value, never `undefined`, so a real executor
  // (bash.ts, monitor.ts) never needs its own fallback-to-default branch.
  sandboxSettings: SandboxSettings;
  // Task 8 (P3 close-out, "Settings threading" MUST; WS-12 §5.3): the session's configured outputs
  // directory (RuntimeConfig.outputsDir), when one was configured -- a Winter product extension, not
  // a CC-pinned field. Optional (most sessions configure none): absent means "no $OUTDIR export, no
  // extra writable root," byte-identical to before this field existed.
  outDir?: string;
  session: {
    setCwd(p: string): void;
    addBoundedRoot(p: string): void;
    setPermissionMode(mode: PermissionMode): void;
    // Task 8 (P3 close-out, "Settings threading" MUST): the identical "cwd or additionalDirectories"
    // notion permissions/evaluator.ts's own boundedRoots() already computes for the STANDING
    // evaluator (rule-derived addDirectories grants + RuntimeConfig.additionalDirectories +
    // EnterWorktree's own addBoundedRoot calls) -- reused here, not re-derived, so a tool executor's
    // notion of "which directories this session may freely write to" can never drift from the
    // permission engine's own. See engine.ts's own session-seam construction for the real wiring.
    getBoundedRoots(): string[];
    // RULING P3-H (Task 8, P3 close-out): the getter half of the write-only posture-mutation seam
    // above -- Lane E's own reviewer found that ExitPlanMode's unconditional `setPermissionMode
    // ("default")` clobbers a mode the HOST already applied via a canUseTool `updatedPermissions`
    // suggestion (engine.ts applies suggested updates BEFORE calling tools.execute() for the
    // approved call), because ExitPlanMode had no way to observe "is the live mode still actually
    // 'plan'" before deciding whether to flip it. Reads the SAME live PolicyStateStore
    // `setPermissionMode` itself mutates -- never a separate, potentially-stale snapshot.
    getPermissionMode(): PermissionMode;
  };
}

export interface ToolExecutor {
  execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload>;
}

// RULING P3-F (Task 8, P3 close-out): the `extractPaths` seam CONTRACT, made explicit here rather
// than left implicit in each lane's own file. Established by Lane A's own review finding (RULING
// P3-F, task-4 report): a lane's `extractPaths` function returns RAW, UNRESOLVED candidate strings
// straight out of the tool's own input (e.g. a `Read` call's literal, un-normalized `file_path` --
// relative or absolute, whatever the caller typed) -- it MUST NOT resolve against `process.cwd()`,
// bake in any other daemon-process-level default, or otherwise assume a cwd of its own. Rationale:
// this function signature (`(input: unknown) => {...}`, no `ctx`/cwd parameter at all) has no
// session context to resolve against in the first place, and baking the WRONG cwd in either
// direction (the daemon's own vs. the session's) would be a silent correctness bug the seam's own
// caller could never detect. The CONSUMER (today: permissions/approvals.ts's own durable-approval
// "normalized paths" revalidation axis, RULING P3-F's other half -- see that file's own
// extractNormalizedTargets) is responsible for resolving each raw candidate against ITS OWN session
// ctx (cwd/home) before comparing or matching. Every current implementation (read.ts/glob.ts/
// grep.ts/bash.ts) already follows this contract as of Lane A's own fix round 1 and Lane C's
// original submission; this comment is what pins it as a REQUIREMENT for every future one too.
export interface RegisteredTool {
  descriptor: ToolDescriptor;
  executor?: ToolExecutor;
  extractPaths?: (input: unknown) => { reads: string[]; writes: string[] };
}

// --- The index --------------------------------------------------------------------------------------

const registry = new Map<string, RegisteredTool>();

// Stubs pre-registered by descriptors/*.ts; lanes call replaceExecutor (never this) once their real
// executor exists. Throws on a duplicate name -- every WS-06 §2 name is registered EXACTLY once, by
// EXACTLY one descriptor file; a second registration under the same canonicalName is always a bug
// (a copy-paste name collision, or a lane accidentally re-declaring a stub instead of calling
// replaceExecutor), never a legitimate update path.
export function registerTool(t: RegisteredTool): void {
  if (registry.has(t.descriptor.canonicalName)) {
    throw new Error(`tools/registry: "${t.descriptor.canonicalName}" is already registered -- each WS-06 name is registered exactly once, by exactly one descriptors/*.ts file`);
  }
  registry.set(t.descriptor.canonicalName, t);
}

// A lane's OWN, permanent way to install its real executor over T1's stub -- called once, at module
// load, from the lane's own tools/impl/*.ts file. Throws when no stub exists yet under that name
// (a lane file targeting the wrong canonicalName, or racing ahead of the descriptor that registers
// it) rather than silently creating a fresh, descriptor-less entry.
export function replaceExecutor(canonicalName: string, executor: ToolExecutor, extractPaths?: RegisteredTool["extractPaths"]): void {
  const existing = registry.get(canonicalName);
  if (!existing) {
    throw new Error(`tools/registry: replaceExecutor("${canonicalName}") -- no stub is registered under that name yet (descriptors/*.ts must register it first)`);
  }
  registry.set(canonicalName, { ...existing, executor, ...(extractPaths !== undefined ? { extractPaths } : {}) });
}

export function getRegisteredTool(canonicalName: string): RegisteredTool | undefined {
  return registry.get(canonicalName);
}

export function listRegisteredTools(): readonly RegisteredTool[] {
  return Array.from(registry.values());
}

// Test-only escape hatch: registry.test.ts (and any future test) uses this ONLY on throwaway,
// invented canonical names it registered itself -- never on a real WS-06 entry (see this file's
// header for why: the registry is a shared, process-wide singleton under bun's test runner).
export function unregisterToolForTest(canonicalName: string): void {
  registry.delete(canonicalName);
}

// --- §1.5: availability resolution + buildAdvertisedSet ---------------------------------------------

// Deliberately NOT wired into engine.ts's init frame at T1 (advisor-reviewed correction): engine.ts's
// two init frames pin `tools: []` and the differential goldens pin those exact bytes. Fix round 1
// (reviewer item 4): as of the executor flip below, main.ts DOES consult this registry by default for
// dispatch -- but advertising is a separate concern from dispatch, and `system/init.tools` still has
// no populated `AdvertisedSetInputs` to call this with (mode/platform/features/capabilities/
// familyMetadata all need a real resolution story no lane has built yet). This function ships as a
// pure, fully-tested function now; wiring it into `system/init.tools` is T8's own job (WS-06 §6
// obligation 1), once every lane's real executor/capability story exists to describe.
export interface AdvertisedSetInputs {
  mode: PermissionMode;
  platform?: NodeJS.Platform;
  features?: Readonly<Record<string, boolean>>;
  // Resolved runtime capability tokens (e.g. "winter.search-backend", "pwsh", "mcp:<server>") --
  // matched 1:1 against each descriptor's own `capabilityRequirements` (ToolDescriptor, above).
  capabilities?: readonly string[];
  familyMetadata?: { taskNative?: boolean };
  toolSearchEnabled?: boolean;
  insideSubagent?: boolean;
  // §1.5 "requested tool config": an explicit allowlist of canonical names to advertise. Absent =
  // no restriction on this axis (every other gate still applies).
  tools?: readonly string[];
  // Recorded on this input shape for documentation/completeness ONLY -- §1.3 pins allowedTools as
  // PRE-APPROVAL, never a visibility allowlist ("an eager tool may still require approval; a
  // deferred tool may already be pre-approved"). buildAdvertisedSet below MUST NOT filter on this
  // field; a test in registry.test.ts pins that a call site cannot use allowedTools to hide a tool.
  allowedTools?: readonly string[];
  // Raw config-grammar strings (the SAME shapes RuntimeConfig.disallowedTools/Options.disallowedTools
  // carry). A BARE entry (`"Bash"`, or `"Bash(*)"` wildcardAll -- grammar.ts's own isBareEquivalent)
  // removes the schema; a SCOPED entry (`"Bash(rm:*)"`) leaves it visible (§1.3) -- reusing
  // grammar.ts's parseRule here is what keeps this bare/scoped split from drifting out of sync with
  // permissions/ruleset.ts's own identical parsing of the same strings.
  disallowedTools?: readonly string[];
}

function isAvailable(descriptor: ToolDescriptor, cfg: AdvertisedSetInputs): boolean {
  const a = descriptor.availability;
  if (a.modes !== undefined && !a.modes.includes(cfg.mode)) return false;
  if (a.platforms !== undefined && cfg.platform !== undefined && !a.platforms.includes(cfg.platform)) return false;
  if (a.requiresFeatures !== undefined && !a.requiresFeatures.every((f) => cfg.features?.[f] === true)) return false;
  if (a.requiresToolSearchDisabled === true && cfg.toolSearchEnabled !== false) return false;
  if (a.hiddenWhenFamilyTaskNative === true && cfg.familyMetadata?.taskNative === true) return false;
  if (a.insideSubagent === false && cfg.insideSubagent === true) return false;
  if (!descriptor.capabilityRequirements.every((c) => cfg.capabilities?.includes(c) === true)) return false;
  return true;
}

function isBareDenied(canonicalName: string, disallowedTools: readonly string[] | undefined): boolean {
  if (!disallowedTools) return false;
  return disallowedTools.some((raw) => {
    const parsed = parseRule(raw);
    return parsed.toolName === canonicalName && parsed.isBareEquivalent;
  });
}

// The §1.5 pipeline: requested tool config -> resolve runtime capabilities -> final active registry.
// `correctly-absent` entries are excluded unconditionally, regardless of every other input (their
// whole point is that no config can ever surface them -- WS-06 §2's own definition: "not registered,
// not advertised... the absence is itself a conformance assertion"); every other exposure==="hidden"
// entry (the deliberately-never-advertised-yet-registered kind, if a future lane ever adds one) is
// excluded the same way.
export function buildAdvertisedSet(cfg: AdvertisedSetInputs): ToolDescriptor[] {
  const requested = cfg.tools;
  return listRegisteredTools()
    .map((t) => t.descriptor)
    .filter((d) => d.disposition !== "correctly-absent")
    .filter((d) => d.exposure !== "hidden")
    .filter((d) => requested === undefined || requested.includes(d.canonicalName))
    .filter((d) => isAvailable(d, cfg))
    .filter((d) => !isBareDenied(d.canonicalName, cfg.disallowedTools));
}

// --- The engine-facing adapter: wraps the registry behind engine.ts's PRE-EXISTING ToolExecutor -----
//
// engine.ts's own `ToolExecutor` (defined there, unchanged by this task) is call-shaped:
// `execute(call: {id,name,input}): Promise<{output: string}>`. This adapter satisfies that EXACT
// shape structurally (engine.ts never imports this file's types to check -- TS structural typing
// does the work) so `runEngine` can use it as a drop-in `tools` value without engine.ts's own
// dispatch loop (`tools.execute(executedCall)`, ~L886/~L1259) changing by one character -- "wrap the
// existing tools.execute seam, do not rewrite dispatch."
//
// A call for a name with no registered descriptor at all, a `correctly-absent` name, or a stub with
// no executor yet all resolve to a NORMAL (non-throwing) result with `isError` folded into the text
// -- never a thrown error. Throwing here would surface as engine.ts's own whole-ROUND
// `error_during_execution` (Ruling P1-H), which is the wrong severity for "this stub isn't wired up
// yet"; a tool_result the model can read and react to is what WS-06's own "typed not-yet-executable
// errors" phrasing (phase plan self-review) calls for. The three cases are kept textually distinct
// (unknown / correctly-absent / not-yet-executable) because T8's own conformance sweep (WS-06 §6
// obligation 2) needs to tell "never existed" apart from "exists but is intentionally never
// advertised" apart from "exists, ships later."
export interface EngineToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface EngineToolResult {
  output: string;
}
export interface EngineFacingToolExecutor {
  execute(call: EngineToolCall): Promise<EngineToolResult>;
}

function unknownToolResult(name: string): ToolResultPayload {
  return { output: `Error: unknown tool "${name}" -- no descriptor is registered under that name`, isError: true };
}
function correctlyAbsentResult(name: string): ToolResultPayload {
  return {
    output: `Error: "${name}" is correctly absent from this Winter session (WS-06 §2) -- it is never callable, matching the official branch`,
    isError: true,
  };
}
function notYetExecutableResult(name: string): ToolResultPayload {
  return {
    output: `Error: "${name}" is registered but not yet executable in this phase -- its executor ships in a later Winter phase (WS-06 §2/§3)`,
    isError: true,
  };
}

// The adapter's own result -> engine-wire fold. Deliberately a pass-through (never a text prefix
// mangle) -- `isError` is informational for a future richer wire surface (T2/T8); every constructor
// above already writes complete, human/model-legible text into `output` itself, so folding never
// needs to invent additional prefixing here.
function foldResult(result: ToolResultPayload): EngineToolResult {
  return { output: result.output };
}

export interface RegistryToolExecutorDeps {
  sessionId: string;
  home: string;
  // A getter, not a snapshot: the session posture-mutation seam (`session.setCwd`) mutates the
  // SAME live value this reads, so a tool call made after a worktree switch sees the new cwd.
  getCwd: () => string;
  probeReadAccess: (filePath: string) => ReadAccessProbe;
  // Phase 3 Task 2: same narrowing as ToolExecutionContext.emitFrame above -- this is the deps-level
  // value that field is built from, just below.
  emitFrame: (frame: BackgroundTaskMessage) => void;
  session: ToolExecutionContext["session"];
  readState: SessionReadState;
  // A getter, not a string: see this module's own `ToolExecutionContext.tempDir` field and
  // engine.ts's call site for why this MUST stay lazy (resolving it eagerly on every call would
  // create real `/tmp/winter-<uid>/...` directories for every tool_use, including ones that never
  // touch tempDir at all -- e.g. the differential/query.test.ts equivalence stand-ins below).
  getTempDir: () => string;
  // Task 8 (P3 close-out, "Settings threading" MUST): resolved ONCE per run by engine.ts (config.
  // sandbox ?? DEFAULT_SANDBOX_SETTINGS) -- see ToolExecutionContext.sandboxSettings's own comment.
  sandboxSettings: SandboxSettings;
  outDir?: string;
}

export function buildRegistryToolExecutor(deps: RegistryToolExecutorDeps): EngineFacingToolExecutor {
  return {
    async execute(call: EngineToolCall): Promise<EngineToolResult> {
      const registered = getRegisteredTool(call.name);
      if (!registered) return foldResult(unknownToolResult(call.name));
      if (registered.descriptor.disposition === "correctly-absent") return foldResult(correctlyAbsentResult(call.name));
      if (!registered.executor) return foldResult(notYetExecutableResult(call.name));

      // A getter-backed object literal: satisfies `ToolExecutionContext.tempDir: string`
      // structurally (every consumer just reads `ctx.tempDir`) while keeping resolution lazy -- see
      // `getTempDir`'s own doc comment above.
      const ctx: ToolExecutionContext = {
        cwd: deps.getCwd(),
        home: deps.home,
        sessionId: deps.sessionId,
        readState: deps.readState,
        emitFrame: deps.emitFrame,
        permissions: { probeReadAccess: deps.probeReadAccess },
        get tempDir() {
          return deps.getTempDir();
        },
        session: deps.session,
        sandboxSettings: deps.sandboxSettings,
        ...(deps.outDir !== undefined ? { outDir: deps.outDir } : {}),
      };
      const result = await registered.executor.execute(call.input, ctx);
      return foldResult(result);
    },
  };
}

// --- Fix round 1, RULING P3-C: the fallback-composed adapter main.ts uses -------------------------
//
// main.ts (the real child/compiled entrypoint) cannot itself build a RegistryToolExecutorDeps -- that
// requires engine-internal live state (currentCwd, the running PolicyState, output.write, the
// session's own readState/tempDir resolver) that only exists once runEngine is already executing, so
// main.ts can only ever supply `tools` from OUTSIDE the call, or omit it and let engine.ts's own
// `buildDefaultToolExecutor` build `deps` internally. Omitting `tools` alone is not enough on its
// own, though: `buildRegistryToolExecutor` above deliberately returns a typed, non-throwing
// unknownToolResult for any name with NO registered descriptor at all (by design -- see that
// function's own header) -- correct for a genuine WS-06 name that simply has no `impl/*.ts` yet
// (`notYetExecutableResult`), but wrong for the pre-existing scripted test-double names
// ("test_tool"/"mystery_tool"/"long_task") that every child/compiled transport-equivalence scenario
// and differential-adjacent test already depends on echoing exactly like stubExecutor always has --
// those names have NO WS-06 descriptor at all and never will.
//
// `buildRegistryToolExecutorWithFallback` composes the two: a name absent from the registry
// ENTIRELY (`getRegisteredTool(name) === undefined`, checked directly -- never by matching
// `unknownToolResult`'s own text) delegates to `fallback` instead of producing the registry's own
// "unknown tool" error; every other outcome (correctly-absent, not-yet-executable, or a real
// dispatch) is untouched, so a genuine WS-06 stub without an executor yet STILL reports
// not-yet-executable rather than silently echoing -- that distinction is exactly what T8's
// conformance sweep (this file's own header, "unknown / correctly-absent / not-yet-executable") and
// the phase ledger's own "typed not-yet-executable errors" phrasing both depend on staying real.
// `fallback` is typed `EngineFacingToolExecutor` (not, say, engine.ts's own `ToolExecutor` by name)
// so any value structurally matching `{id,name,input} -> {output}` -- stubExecutor included --
// satisfies it with no cast.
export function buildRegistryToolExecutorWithFallback(deps: RegistryToolExecutorDeps, fallback: EngineFacingToolExecutor): EngineFacingToolExecutor {
  const registryExecutor = buildRegistryToolExecutor(deps);
  return {
    async execute(call: EngineToolCall): Promise<EngineToolResult> {
      if (getRegisteredTool(call.name) === undefined) return fallback.execute(call);
      return registryExecutor.execute(call);
    },
  };
}
