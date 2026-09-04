import { randomUUID } from "node:crypto";
import type { SdkMessage as RuntimeSdkMessage, WinterFrame, InitFrame, ControlRequestFrame, ControlResponseFrame } from "./protocol/frames.ts";
import { PROTOCOL_VERSION } from "./protocol/frames.ts";
import { splitFrames, encodeFrame, ProtocolError } from "./protocol/codec.ts";
import type { RuntimeConfig, RuntimeHooksConfig, RuntimeHookMatcherGroup, McpServerConfigForProcessTransport } from "./protocol/config.ts";
import { isWinterMcpServerInstance, type Options, type McpServerConfig } from "./options.ts";
import type {
  PermissionMode,
  CanUseTool,
  PermissionResult,
  PermissionRequestPayload,
  HookEvent,
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  HookInvocationPayload,
} from "./permissions/types.ts";
import { resolveRuntimeExecutable, defaultSpawn, type SpawnRuntimeOptions, type SpawnedRuntimeProcess } from "./transport.ts";
import { ResultError, CLIConnectionError, ProtocolDecodeError, ProcessError, AbortError, WinterRpcError } from "./errors.ts";

// The runtime's SdkMessage is deliberately open (a trailing `{ type: string; [k: string]: unknown }`
// catch-all for lossless pass-through of unknown message kinds, Task 5). The SDK's public surface
// must be a CLOSED union — like the official SDK's message union (WS-03 §8) — so that consumers can
// discriminate-narrow on `msg.type` and access variant-specific fields (e.g. `assistant`'s `.message`)
// without the catch-all collapsing the narrowed type to `unknown`. Extract drops it: the catch-all's
// `type: string` isn't assignable to any of the three literal targets below.
export type SdkMessage = Extract<RuntimeSdkMessage, { type: "system" } | { type: "assistant" } | { type: "result" }>;

// Task 2 (WS-04 §3.1): a runtime-originated control_request's handler either answers ok:true with
// an optional payload, or ok:false with a structured error — the SAME shape a control_response
// frame carries (frames.ts), kept as its own type here so query.ts's registry doesn't require
// callers to build a whole WinterFrame just to answer one.
export type ControlRequestHandlerResult = { ok: true; payload?: unknown } | { ok: false; error: { code: string; message: string } };
export type ControlRequestHandler = (payload: unknown) => Promise<ControlRequestHandlerResult>;

// Winter-only extension beyond the WS-03 §4 pinned Query surface — never part of the upstream
// drop-in contract (Level 1 compat is measured against interrupt/setPermissionMode/setModel/etc.,
// not this). Task 8 adds `respondPermission` here for the canUseTool `null` escape; Task 2 ships
// the registry this task's own tests exercise directly (permission/hook handlers register through
// query.ts's own production code in Tasks 8/10, not through this method — this is the seam a test
// double, or a not-yet-built subtype, uses to reach the same registry).
export interface QueryInternal {
  registerControlRequestHandler(subtype: string, handler: ControlRequestHandler): void;
  // Task 8 (WS-07 §7.2's "null escape"): sends a `permission` control_response OUT OF BAND,
  // independent of the normal handler-return write path below — the ONLY legitimate way a
  // `canUseTool` callback may resolve to `null` (see makePermissionHandler's own enforcement: an
  // unaccompanied null fails closed instead of silently parking the runtime's permission RPC
  // forever, which has no timeout, WS-04 §3). Transport-compatible low-level API only — a product
  // approval broker always returns a typed PermissionResult from the callback itself (WS-07 §7.2).
  respondPermission(requestId: string, result: PermissionResult): void;
}

export interface Query extends AsyncGenerator<SdkMessage> {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  // Ruling 8 (phase plan): tightened from `string` to the six-value public union. The WIRE payload
  // (sendControlRequest below) stays the bare value — an invalid string can still reach the runtime
  // (e.g. a non-TS caller, or a deliberately-cast test value) and gets a typed `invalid_mode`
  // control-response rejection there, unchanged from before this tightening.
  setPermissionMode(mode: PermissionMode): Promise<void>;
  // Optional (not every hand-built Query-shaped test double needs to carry it) — query() itself
  // always sets it.
  __internal?: QueryInternal;
}

// Provisional pending packages/conformance/compat/anthropic/0.3.250/defaults.json: that file does
// not exist yet in the snapshot (only exports.json/declaration-digests.json/checksums.json do), so
// there is no pinned maxBufferSize default to read. Chosen generous default; revisit once the
// snapshot carries one (WS-02 §2/§6).
const DEFAULT_MAX_BUFFER_SIZE = 1024 * 1024;
// Internal-only, no public knob (Task 2 scope): grace window between the wrapper's own SIGTERM-ish
// kill() and its SIGKILL-ish escalation on abort (WS-04 §6). Kept short for a responsive wrapper
// and a fast test suite; a pinned/configurable value is future work.
const KILL_GRACE_MS = 50;

// --- Task 10 (WS-08 §1/§2/§10): Options.hooks <-> RuntimeConfig.hooks + the "hook" control-request
// handler. `Options.hooks` values are JS functions — never serialized wholesale (options.ts's own
// comment); this section builds the STRUCTURE-ONLY RuntimeHooksConfig the wire actually carries, and
// the reverse: dispatching an inbound "hook" control_request back to the exact SDK-callback it names.

// Positional identity, deterministic on BOTH sides of the wire from the config shape alone (no id
// needs to round-trip at CONFIG-build time — protocol/config.ts's own RuntimeHookMatcherGroup
// header) — this is the SAME formula the runtime side uses when it builds registry entries from this
// exact config shape (packages/runtime/src/hooks -- see that side's own converter).
function hookIdFor(event: string, source: "sdk", groupIndex: number, hookIndex: number): string {
  return `${event}:${source}:${groupIndex}:${hookIndex}`;
}

// Phase 4 Task 2 (WS-09 derived-shapes item (a)): strips the one host-only field (`instance`) an
// in-process SDK server config carries — never JSON-serializable, and per the pinned OFFICIAL SDK's
// OWN wire behavior (derived-shapes-p4.md item (a): a SEPARATE, instance-free union crosses its
// `initialize` frame too) this is the CORRECT wire shape, not a lossy workaround. Every other
// variant (stdio/http/sse) is already structurally identical at both layers (options.ts's own
// header) and passes through completely unchanged.
//
// GAP CLOSED (Phase 4 Task 3, WS-04 addendum): task-2-report.md's own "PLAN GAP" concern named
// exactly this bridging as unbuilt. It is now built in two halves: this function additionally
// populates the wire-safe `tools` array (WireMcpToolDefinition, protocol/config.ts) whenever the
// live `instance` structurally implements `WinterMcpServerInstance` (duck-typed — options.ts's own
// `isWinterMcpServerInstance`), so a spawned runtime process that never sees the live instance
// object still learns what tools the server has; `makeSdkMcpCallHandler` below is the other half —
// the runtime forwards a call for one of those tools back over the wire as an `sdk_mcp_call`
// control_request, and THIS function answers it by invoking the instance directly. An `instance`
// that does NOT implement the interface (e.g. query.test.ts's own wire-stripping fixture,
// `{ notJsonSafe: () => {} }`) produces the EXACT SAME `{type:"sdk", name, timeout}` shape as
// before this task — the tool-discovery gap is closed additively, never by requiring every caller
// to adopt the new interface.
function toWireMcpServers(servers: Record<string, McpServerConfig> | undefined): Record<string, McpServerConfigForProcessTransport> | undefined {
  if (!servers) return undefined;
  const out: Record<string, McpServerConfigForProcessTransport> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    out[name] =
      cfg.type === "sdk"
        ? {
            type: "sdk",
            name: cfg.name,
            ...(cfg.timeout !== undefined ? { timeout: cfg.timeout } : {}),
            ...(isWinterMcpServerInstance(cfg.instance) ? { tools: cfg.instance.listTools() } : {}),
          }
        : cfg;
  }
  return out;
}

// Phase 4 Task 3 (WS-04 addendum): the runtime-originated `sdk_mcp_call` responder — the "other
// half" of the bridge described above. `mcpServers` here is the HOST-facing `Options.mcpServers`
// (never the wire-stripped `RuntimeConfig.mcpServers`): this handler needs the LIVE `instance` the
// wire copy deliberately never carries. Symmetric error taxonomy with makeHookHandler/
// makePermissionHandler above: every failure mode is a structured `{ok:false, error:{code,
// message}}`, never a thrown exception or a dropped request — WS-04 §3.1's own "a structured error,
// never a dropped request."
interface SdkMcpCallRequestPayload {
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}
function makeSdkMcpCallHandler(mcpServers: Record<string, McpServerConfig>): ControlRequestHandler {
  return async (payload: unknown): Promise<ControlRequestHandlerResult> => {
    const req = payload as SdkMcpCallRequestPayload;
    const cfg = req.server !== undefined ? mcpServers[req.server] : undefined;
    if (!cfg || cfg.type !== "sdk") {
      return { ok: false, error: { code: "unknown_sdk_server", message: `no in-process SDK server named '${String(req.server)}' is configured` } };
    }
    if (!isWinterMcpServerInstance(cfg.instance)) {
      return {
        ok: false,
        error: {
          code: "instance_not_callable",
          message: `server '${req.server}'s instance does not implement listTools()/callTool() (WinterMcpServerInstance) -- it is wire-safe but not end-to-end callable`,
        },
      };
    }
    try {
      const result = await cfg.instance.callTool(req.tool ?? "", req.arguments ?? {});
      return { ok: true, payload: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: "sdk_tool_threw", message } };
    }
  };
}

// Phase 4 Task 3 (WS-09 §5): the runtime-originated `mcp_elicitation` responder — registered ONLY
// when `Options.onElicitation` is configured, mirroring makePermissionHandler's/makeHookHandler's
// own "no callback = no handler" posture (from the runtime's point of view, an unregistered subtype
// and "a subtype whose handler never gets a chance to answer" collapse to the identical wire
// outcome: the generic `unhandled_subtype` fallback below). See Options.onElicitation's own header
// for the deliberate, named null-decline safety deviation from the pinned artifact's hang-trap.
interface McpElicitationRequestPayload {
  serverName?: string;
  message?: string;
  mode?: "form" | "url";
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
}
function makeElicitationHandler(onElicitation: NonNullable<Options["onElicitation"]>, abortController: AbortController | undefined): ControlRequestHandler {
  return async (payload: unknown): Promise<ControlRequestHandlerResult> => {
    const req = payload as McpElicitationRequestPayload;
    const controller = new AbortController();
    if (abortController?.signal.aborted) controller.abort();
    else abortController?.signal.addEventListener("abort", () => controller.abort(), { once: true });

    let result: Awaited<ReturnType<NonNullable<Options["onElicitation"]>>>;
    try {
      result = await onElicitation(
        {
          serverName: req.serverName ?? "",
          message: req.message ?? "",
          ...(req.mode !== undefined ? { mode: req.mode } : {}),
          ...(req.url !== undefined ? { url: req.url } : {}),
          ...(req.elicitationId !== undefined ? { elicitationId: req.elicitationId } : {}),
          ...(req.requestedSchema !== undefined ? { requestedSchema: req.requestedSchema } : {}),
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.displayName !== undefined ? { displayName: req.displayName } : {}),
          ...(req.description !== undefined ? { description: req.description } : {}),
        },
        { signal: controller.signal, requestId: randomUUID() },
      );
    } catch (err) {
      // Same posture as makeHookHandler's own callback-throw handling: the runtime still gets a
      // well-formed, deterministic answer -- a decline -- never an ok:false that could be confused
      // with "no handler at all" (WS-09 §5's own MUST: "a defined decline result... never a hang").
      const message = err instanceof Error ? err.message : String(err);
      console.error(`winter: onElicitation callback threw for server '${req.serverName}': ${message} -- declining deterministically`);
      return { ok: true, payload: { action: "decline" } };
    }
    // DELIBERATE SAFETY DEVIATION (Options.onElicitation's own header): a bare `null` here is an
    // automatic decline, never a hang -- this callback has no out-of-band response escape hatch, so
    // there is no "already answered elsewhere" case for a null to legitimately mean here.
    return { ok: true, payload: result ?? { action: "decline" } };
  };
}

// Builds the wire-safe RuntimeConfig.hooks shape from a real Options.hooks value — undefined when
// there is nothing to send at all (an absent/empty hooks option must serialize to an ABSENT
// `hooks` key, never `{}`, so the runtime's own "hooks default-off, byte-identical wire trace" claim
// holds for every existing scenario that never touches this option). Only ever produces
// `source: "sdk"` groups: filesystem-configured (managed/user/project/local) hooks have no
// representation in `Options.hooks` at all — they are P5's settings-loader territory (phase ruling
// 1) and this function has nothing to build for them.
function buildRuntimeHooksConfig(hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined): RuntimeHooksConfig | undefined {
  if (!hooks) return undefined;
  const out: RuntimeHooksConfig = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!groups || groups.length === 0) continue;
    out[event] = groups.map((group): RuntimeHookMatcherGroup => {
      // `.name || null`, not `?? null`: an anonymous/arrow function's own `.name` is `""` (never
      // undefined) — `||` normalizes that to `null` too, so "no name available" is represented
      // uniformly regardless of which falsy form produced it. See RuntimeHookMatcherGroup's own
      // comment for why this is `string | null`, not `string | undefined`.
      const hookNames = group.hooks.map((hook) => hook.name || null);
      return {
        ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
        hookCount: group.hooks.length,
        ...(group.timeout !== undefined ? { timeoutSec: group.timeout } : {}),
        source: "sdk",
        // Omitted entirely when every hook in this group is unnamed — matches this whole file's own
        // conditional-spread convention (never send a key whose value carries no information).
        ...(hookNames.some((n) => n !== null) ? { hookNames } : {}),
      };
    });
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Reconstructs a proper per-event HookInput (the shape a real HookCallback receives as its first
// argument) from the runtime's own wire payload. Generic construction covers every one of the 31
// events without 31 per-event builders: BaseHookInput's shared envelope + the discriminant + tool
// identity (tool-scoped events) + whatever event-specific fields the runtime already placed in
// `payload` (already exactly the extra-input shape WS-08 §10's own payload field carries per event —
// e.g. PermissionRequest's permission_suggestions, UserPromptSubmit's prompt, Notification's
// message/title/notification_type) — lossless forward-compatible construction, matching WS-08 §1.3's
// own "forwards payloads losslessly, never invents field-level semantics" instruction.
function buildHookInput(req: HookInvocationPayload, cwd: string): HookInput {
  const payload = (req.payload ?? {}) as Record<string, unknown>;
  return {
    session_id: req.sessionId,
    // No transcript-path synthesis at P2: nothing consumes it yet (filesystem hook scripts are
    // typed-but-inert until P5, phase ruling 1; a JS HookCallback is free to ignore a field it
    // doesn't need) — "" rather than widening this pinned non-optional wire field to optional,
    // matching prompt-stage.ts's own toolUseID precedent (runtime/src/permissions/prompt-stage.ts's
    // header: "an absent id ... falls back to \"\" rather than widening the wire type to optional").
    transcript_path: "",
    cwd,
    ...(req.agentID !== undefined ? { agent_id: req.agentID } : {}),
    hook_event_name: req.event,
    ...(req.toolName !== undefined ? { tool_name: req.toolName } : {}),
    ...(req.input !== undefined ? { tool_input: req.input } : {}),
    ...(req.toolUseID !== undefined ? { tool_use_id: req.toolUseID } : {}),
    ...payload,
  } as unknown as HookInput;
}

// Task 10 (WS-08 §10): the "hook" control-request handler — registered ONLY when Options.hooks is
// non-empty (mirroring makePermissionHandler's own "no callback = no handler" posture: an
// unrecognized subtype and "a subtype whose handler never gets a chance to answer" collapse to the
// identical wire outcome). Locates the target callback by `req.hookId`'s deterministic positional
// identity, built ONCE from the SAME Options.hooks the runtime independently derived its own
// registry entries from (hookIdFor above == the runtime side's own formula).
function makeHookHandler(hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>, cwd: string, abortController: AbortController | undefined): ControlRequestHandler {
  const byId = new Map<string, HookCallback>();
  for (const [event, groups] of Object.entries(hooks)) {
    (groups ?? []).forEach((group, groupIndex) => {
      group.hooks.forEach((hook, hookIndex) => {
        byId.set(hookIdFor(event, "sdk", groupIndex, hookIndex), hook);
      });
    });
  }

  return async (payload: unknown): Promise<ControlRequestHandlerResult> => {
    const req = payload as HookInvocationPayload;
    const callback = byId.get(req.hookId);
    if (!callback) {
      // A config/registry drift this handler cannot itself cause (the runtime derives its own
      // registry from the SAME RuntimeHooksConfig this file builds) — defended anyway rather than
      // crashing the wrapper or leaving the runtime's request unanswered.
      return { ok: false, error: { code: "unknown_hook_id", message: `no SDK-callback hook registered for hookId '${req.hookId}'` } };
    }

    const controller = new AbortController();
    if (abortController?.signal.aborted) controller.abort();
    else abortController?.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const input = buildHookInput(req, cwd);
    let output: HookJSONOutput;
    try {
      output = await callback(input, req.toolUseID, { signal: controller.signal });
    } catch (err) {
      // WS-08 §8: "a hook error is not a tool denial unless this spec says so" — a gating hook's
      // error contributes NO decision and NO transformation, evaluation continues; it does NOT
      // itself deny anything. This is DELIBERATELY DIFFERENT from makePermissionHandler's own
      // throw-handling just below (a typed deny PermissionResult): a canUseTool callback answers a
      // decision that has nowhere else to go, so "the host answered, badly" must still resolve as
      // an explainable denial; a hook callback's failure is instead THAT HOOK's own contract error
      // (§8's own row), and ok:false — the bridge rejects, runner.ts's invokeWithTimeout classifies
      // it as {kind:"error"}, and evaluation continues with whatever OTHER hooks/stages apply —
      // exactly like an unhandled-subtype or a transport failure would.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`winter: hook callback threw for '${req.event}' (hookId '${req.hookId}'): ${message}`);
      return { ok: false, error: { code: "hook_threw", message } };
    }
    return { ok: true, payload: output };
  };
}

export function query(args: { prompt: string | AsyncIterable<string>; options: Options }): Query {
  const { prompt, options } = args;

  // Task 8 (WS-07 §7.3): the shadow warning — a STATIC, ONE-TIME check at query() CONSTRUCTION
  // time, independent of whether the process ever spawns/connects or a single tool call is ever
  // made. Two "obviously shadowed" cases only, per the spec's own scope: `bypassPermissions` (the
  // engine auto-allows nearly everything under it, WS-07 §6.4 — canUseTool is reached only for
  // PreToolUse-hook denial, explicit deny/ask rules, AskUserQuestion, and the critical-rm circuit
  // breaker) and a BARE-OR-BARE-EQUIVALENT `allowedTools` entry (an unscoped tool name, OR a
  // wildcard specifier of exactly `(*)` — WS-07 §3 pins `Bash(*)` as "treated like bare Bash,
  // including schema removal," so it pre-approves at stage 5 exactly like the bare form, before
  // canUseTool is ever reached at stage 6; found missing by review). No promise of catching every
  // runtime/path-specific case (WS-07 §7.3's own text) — e.g. a genuinely scoped entry like
  // `Bash(ls:*)` still lets other Bash invocations reach the callback, so it does not warn.
  if (options.canUseTool) {
    const isBareOrBareEquivalent = (rule: string): boolean => !rule.includes("(") || /\(\*\)$/.test(rule);
    const hasBareAllowedTool = options.allowedTools?.some(isBareOrBareEquivalent) ?? false;
    if (options.permissionMode === "bypassPermissions" || hasBareAllowedTool) {
      const cause = options.permissionMode === "bypassPermissions" ? "permissionMode is 'bypassPermissions'" : "an allowedTools entry is bare (unscoped)";
      console.error(`winter: WINTER_SDK_CAN_USE_TOOL_SHADOWED: canUseTool is configured but ${cause} — some or all tool calls will never reach it`);
    }
  }

  // Task 10: computed once, ahead of `config`, so it can be conditionally spread into it below.
  const runtimeHooksConfig = buildRuntimeHooksConfig(options.hooks);
  // Phase 4 Task 2: same "computed once, ahead of `config`" convention, for the identical reason —
  // toWireMcpServers's own undefined-in/undefined-out shape lets the spread below stay a plain
  // `!== undefined` check like every other field.
  const wireMcpServers = toWireMcpServers(options.mcpServers);

  const config: RuntimeConfig = {
    // Task 9: a caller-supplied sessionId wins over the default auto-generated uuid — this is what
    // lets a pre-allocated id round-trip into the init frame and the transcript filename (WS-05
    // §7). Resume/continue targets are a SEPARATE concept (config.resume/config.continue below):
    // this field is always "what this RUN's own session id is," which the runtime overrides to the
    // resolved target when continue/resume actually resolves one (dialect.ts's resolveEngineSession).
    sessionId: options.sessionId ?? randomUUID(),
    cwd: options.cwd ?? process.cwd(),
    model: options.model ?? "sonnet",
    permissionMode: options.permissionMode ?? "default",
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.resume !== undefined ? { resume: options.resume } : {}),
    ...(options.continue !== undefined ? { continue: options.continue } : {}),
    ...(options.forkSession !== undefined ? { forkSession: options.forkSession } : {}),
    ...(options.resumeSessionAt !== undefined ? { resumeSessionAt: options.resumeSessionAt } : {}),
    ...(options.resumeDropsTurn !== undefined ? { resumeDropsTurn: options.resumeDropsTurn } : {}),
    ...(options.persistSession !== undefined ? { persistSession: options.persistSession } : {}),
    // Task 5 (WS-07 §3.3 / phase ruling 1): pure passthrough, same conditional-spread convention as
    // every field above — query.ts never interprets these, it only serializes them.
    ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
    ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
    ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
    ...(options.settingSources !== undefined ? { settingSources: options.settingSources } : {}),
    // Finding 6 (P2 fix-wave): pure passthrough, same conditional-spread convention as every field
    // above -- query.ts never interprets either field, it only serializes them (options.ts's own
    // comment on each field for what does/doesn't consume it runtime-side).
    ...(options.permissionPromptToolName !== undefined ? { permissionPromptToolName: options.permissionPromptToolName } : {}),
    ...(options.additionalDirectories !== undefined ? { additionalDirectories: options.additionalDirectories } : {}),
    // Task 8 (P3 close-out, "Settings threading" MUST): same pure-passthrough convention as every
    // field above.
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
    ...(options.outputsDir !== undefined ? { outputsDir: options.outputsDir } : {}),
    // Part B item 1 (fix wave, P3 close-out): same pure-passthrough convention as every field above.
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    ...(options.toolSearchEnabled !== undefined ? { toolSearchEnabled: options.toolSearchEnabled } : {}),
    ...(options.insideSubagent !== undefined ? { insideSubagent: options.insideSubagent } : {}),
    ...(options.familyMetadata !== undefined ? { familyMetadata: options.familyMetadata } : {}),
    // Task 6 (WS-07 §6.4): same pure-passthrough convention as every field above.
    ...(options.allowDangerouslySkipPermissions !== undefined ? { allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions } : {}),
    // Task 10 (WS-08 §1/§2/§9): the hooks structure-only wire shape (functions stripped -- see
    // buildRuntimeHooksConfig's own header) + the public-lifecycle-stream gate. An absent/empty
    // Options.hooks serializes to an ABSENT `hooks` key (never `{}`), keeping every existing
    // hooks-free scenario's wire trace byte-identical to before this task.
    ...(runtimeHooksConfig !== undefined ? { hooks: runtimeHooksConfig } : {}),
    ...(options.includeHookEvents !== undefined ? { includeHookEvents: options.includeHookEvents } : {}),
    // Phase 4 Task 2 (WS-09 derived-shapes item (a)/(c)/(d)): same pure-passthrough convention as
    // every field above -- query.ts never interprets these itself (see options.ts's own comment on
    // each field for the real runtime consumer). `agents` needs no conversion function the way
    // `mcpServers` does: AgentDefinition carries no live-instance field anywhere in its own shape
    // (its own `mcpServers` sub-field already uses the wire-safe McpServerConfigForProcessTransport
    // union, per protocol/config.ts's own RuntimeAgentDefinition), and its one TIGHTENED field
    // (permissionMode: PermissionMode, a subtype of RuntimeAgentDefinition's own bare `string`) is
    // structurally assignable with no runtime transformation at all.
    ...(wireMcpServers !== undefined ? { mcpServers: wireMcpServers } : {}),
    ...(options.strictMcpConfig !== undefined ? { strictMcpConfig: options.strictMcpConfig } : {}),
    ...(options.toolAliases !== undefined ? { toolAliases: options.toolAliases } : {}),
    ...(options.agents !== undefined ? { agents: options.agents } : {}),
    ...(options.forwardSubagentText !== undefined ? { forwardSubagentText: options.forwardSubagentText } : {}),
  };

  // A custom spawnClaudeCodeProcess hook owns process creation entirely (containers, VMs, remote
  // runtimes, a supervising daemon — WS-04 §8): resolving a LOCAL platform binary would be wrong
  // (and often impossible) in those cases, so executable resolution — including its typed throw
  // when nothing is configured — only runs on the defaultSpawn path.
  const command = options.spawnClaudeCodeProcess
    ? (options.pathToClaudeCodeExecutable ?? "winter")
    : resolveRuntimeExecutable(options);
  const spawnOptions: SpawnRuntimeOptions = {
    command,
    args: ["--run", "--config-json", JSON.stringify(config)],
    cwd: config.cwd,
    // Options.env semantics (WS-03 §5, controller Ruling P1-D): an EXPLICITLY supplied env
    // REPLACES the child environment entirely (consumers spread ...process.env themselves if they
    // want to extend it); an OMITTED env means the child INHERITS the wrapper's own process.env —
    // never a silently empty environment (the prior `?? {}` produced exactly that bug).
    env: options.env ?? (process.env as Record<string, string>),
    ...(options.abortController ? { signal: options.abortController.signal } : {}),
  };
  const proc: SpawnedRuntimeProcess = (options.spawnClaudeCodeProcess ?? defaultSpawn)(spawnOptions);
  const maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;

  // Task 2 (WS-04 §3.1, direction inversion): HOST-originated control requests (interrupt,
  // setPermissionMode today; setModel/taskStop/mcp_*/rewindFiles in later tasks) awaiting the
  // runtime's ack, correlated by requestId. This is the wrapper's OWN, separate mirror of
  // packages/runtime/src/rpc/bridge.ts's createRpcBridge (same shape, opposite direction) — never
  // imported from the runtime package (WS-02 §3: the sdk never imports the runtime), even though
  // the correlation idea is identical. No timeout support here: nothing in this task's scope needs
  // one (interrupt/setPermissionMode both just await their ack).
  const pendingHostRequests = new Map<string, { resolve(payload: unknown): void; reject(err: unknown): void }>();
  // Item 1 (P2 fix-wave): mirrors rpc/bridge.ts's own `closed` latch on the runtime side (a
  // deliberate parity, not a coincidence — the two are the SAME correlation idea in opposite
  // directions, see this const's own header). Set once, in iterate()'s own `finally` below,
  // reached by every generator-completion path (return, throw, or an external early
  // `.return()`/`.throw()`). Pre-fix, a control call issued AFTER completion (e.g. a consumer that
  // kept a `Query` reference and called `.interrupt()` well after its `for await` loop had already
  // ended) registered a fresh promise in `pendingHostRequests` and wrote to a stdin that may already
  // be silently no-op-ing post-`.end()` — nothing left could ever settle it, hanging the caller
  // forever with no diagnostic.
  let generatorTerminated = false;
  function sendControlRequest(subtype: string, payload: unknown): Promise<unknown> {
    if (generatorTerminated) {
      return Promise.reject(new WinterRpcError("connection_closed", `query() has already completed: cannot issue a '${subtype}' control request`));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      pendingHostRequests.set(requestId, { resolve, reject });
      proc.stdin.write(encodeFrame({ type: "control_request", requestId, subtype, payload }));
    });
  }

  // Task 8 (WS-07 §7.2's "null escape"): requestIds ALREADY answered out of band via
  // query.__internal.respondPermission — checked (and consumed) immediately before every
  // control_response write below so a legitimate null response from a subtype handler never
  // produces a duplicate frame for the same requestId. Generic (keyed only by requestId, not
  // subtype) because the mechanism itself is generic in WS-07 §7.2's own wording ("the consumer
  // already sent the matching control response out of band") — `respondPermission` is currently
  // the only producer, but nothing here assumes that.
  const respondedOutOfBand = new Set<string>();
  function writeControlResponse(frame: ControlResponseFrame): void {
    if (respondedOutOfBand.delete(frame.requestId)) return; // already answered out of band -- suppress the duplicate
    proc.stdin.write(encodeFrame(frame));
  }

  // RUNTIME-originated control requests (permission/hook RPCs in Tasks 8/10; this task ships only
  // the registry + the fallback below) dispatch to a handler registered by subtype. An
  // unrecognized subtype — including every subtype at T2, since nothing registers one in
  // production yet — is auto-answered ok:false so the runtime never parks forever waiting on a
  // host that doesn't understand it (WS-04 §3.1).
  const controlRequestHandlers = new Map<string, ControlRequestHandler>();
  async function handleIncomingControlRequest(cf: ControlRequestFrame): Promise<void> {
    // The whole body is wrapped, not just the handler invocation: every proc.stdin.write below
    // (including the no-handler-registered answer) can throw on a real child whose stdin has
    // already closed (e.g. the process exited while this handler — possibly a slow permission
    // prompt, Tasks 8/10 — was still running). Same swallow policy as the sender IIFE above ("a
    // write after the child has already exited: swallow here... the ONE place a real failure must
    // surface is the stdout-side WS-04 §6.1 lifecycle mapping, not a second, competing rejection
    // from this side") — this function is invoked fire-and-forget (`void handleIncomingControlRequest(...)`
    // in the read loop below), so an uncaught throw here would be an unhandled rejection.
    try {
      const handler = controlRequestHandlers.get(cf.subtype);
      if (!handler) {
        writeControlResponse({
          type: "control_response",
          requestId: cf.requestId,
          ok: false,
          error: { code: "unhandled_subtype", message: `no handler registered for control subtype '${cf.subtype}'` },
        });
        return;
      }
      try {
        const result = await handler(cf.payload);
        if (result.ok) {
          writeControlResponse({
            type: "control_response",
            requestId: cf.requestId,
            ok: true,
            ...(result.payload !== undefined ? { payload: result.payload } : {}),
          });
        } else {
          writeControlResponse({ type: "control_response", requestId: cf.requestId, ok: false, error: result.error });
        }
      } catch (err) {
        // A throwing handler fails closed — ok:false, never a dropped request or a wrapper crash.
        const message = err instanceof Error ? err.message : String(err);
        writeControlResponse({ type: "control_response", requestId: cf.requestId, ok: false, error: { code: "handler_threw", message } });
      }
    } catch {
      /* see policy note above: a stdin write after the child has already exited is swallowed */
    }
  }

  // Task 8 (WS-07 §7.1): registered ONLY when a callback is configured — from the runtime's point
  // of view, "no callback" and "a callback that never gets a chance to answer" collapse to the
  // identical wire outcome (the generic "unhandled_subtype" fallback above), which is exactly what
  // the real PromptStage's own null-on-rejection handling expects (packages/runtime/src/
  // permissions/prompt-stage.ts). `signal` is a fresh AbortController per request, forwarded from
  // the query's own abortController if one exists (P2: no other cancellation source reaches a
  // pending permission prompt — WS-04 §3's own no-park-timeout rule means only the callback
  // resolving, or the whole query aborting, ever ends the wait).
  function makePermissionHandler(canUseTool: CanUseTool): ControlRequestHandler {
    return async (payload: unknown): Promise<ControlRequestHandlerResult> => {
      const req = payload as PermissionRequestPayload;
      const controller = new AbortController();
      if (options.abortController?.signal.aborted) controller.abort();
      else options.abortController?.signal.addEventListener("abort", () => controller.abort(), { once: true });

      let result: PermissionResult | null;
      try {
        result = await canUseTool(req.toolName, req.input, {
          signal: controller.signal,
          ...(req.suggestions !== undefined ? { suggestions: req.suggestions } : {}),
          ...(req.blockedPath !== undefined ? { blockedPath: req.blockedPath } : {}),
          ...(req.decisionReason !== undefined ? { decisionReason: req.decisionReason } : {}),
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.displayName !== undefined ? { displayName: req.displayName } : {}),
          ...(req.description !== undefined ? { description: req.description } : {}),
          toolUseID: req.toolUseID,
          ...(req.agentID !== undefined ? { agentID: req.agentID } : {}),
          requestId: req.requestId,
          ...(req.matchedAskRule !== undefined ? { matchedAskRule: req.matchedAskRule } : {}),
        });
      } catch (err) {
        // Callback THROW = fail-closed deny (task instruction, verbatim) — a typed PermissionResult,
        // not an RPC-level ok:false: the runtime's real PromptStage treats any bridge rejection as
        // "no opinion" (packages/runtime/src/permissions/prompt-stage.ts), which is the WRONG
        // semantics for "the host answered, badly" — a genuine typed deny is what actually reaches
        // the model as a normal, explainable tool_result.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`winter: canUseTool callback threw for '${req.toolName}': ${message} — failing closed (deny)`);
        const deny: PermissionResult = { behavior: "deny", message: `canUseTool callback threw: ${message}` };
        return { ok: true, payload: deny };
      }

      if (result === null) {
        // The ONLY legitimate reason to see this: the callback already answered out of band via
        // respondPermission (checked/consumed by writeControlResponse above) — this handler's own
        // return value is then irrelevant, since the write it would produce is suppressed. Anything
        // else is an ACCIDENTAL null (WS-07 §7.2) — fails closed rather than leaving the runtime's
        // permission RPC parked forever (no park timeout, WS-04 §3).
        if (respondedOutOfBand.has(req.requestId)) {
          return { ok: true }; // suppressed by writeControlResponse's own guard; payload is moot
        }
        console.error(`winter: canUseTool callback for '${req.toolName}' returned null with no prior out-of-band response — failing closed (deny)`);
        const deny: PermissionResult = {
          behavior: "deny",
          message: "canUseTool callback returned null with no prior out-of-band response (accidental null fails closed, WS-07 §7.2)",
        };
        return { ok: true, payload: deny };
      }
      return { ok: true, payload: result };
    };
  }
  if (options.canUseTool) {
    controlRequestHandlers.set("permission", makePermissionHandler(options.canUseTool));
  }
  // Task 10 (WS-08 §1/§2): registered ONLY when there is at least one real SDK-callback hook to
  // dispatch to — an empty/absent Options.hooks means "no handler," collapsing to the SAME
  // generic "unhandled_subtype" fallback every other unregistered subtype already gets (no
  // observable difference from the runtime's point of view, mirroring the "permission" handler's
  // own registration guard immediately above).
  if (options.hooks && Object.keys(options.hooks).length > 0) {
    controlRequestHandlers.set("hook", makeHookHandler(options.hooks, config.cwd, options.abortController));
  }
  // Phase 4 Task 3 (WS-04 addendum): registered whenever AT LEAST ONE configured server is
  // `type: "sdk"` -- regardless of whether ITS OWN instance turns out callable, since
  // makeSdkMcpCallHandler's own per-request lookup already reports a more specific
  // `instance_not_callable` error than the generic `unhandled_subtype` fallback would.
  if (options.mcpServers && Object.values(options.mcpServers).some((cfg) => cfg.type === "sdk")) {
    controlRequestHandlers.set("sdk_mcp_call", makeSdkMcpCallHandler(options.mcpServers));
  }
  if (options.onElicitation) {
    controlRequestHandlers.set("mcp_elicitation", makeElicitationHandler(options.onElicitation, options.abortController));
  }

  // Stderr is diagnostics only, never frames (WS-04 §6) — forwarded eagerly, independent of
  // whether/when the consumer iterates the returned Query.
  if (proc.stderr) {
    const stderrIterable = proc.stderr;
    (async () => {
      try {
        for await (const chunk of stderrIterable) options.stderr?.(chunk);
      } catch {
        /* diagnostics only; never fail the query over a stderr read error */
      }
    })();
  }

  async function* iterate(): AsyncGenerator<SdkMessage> {
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      proc.kill();
      killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    options.abortController?.signal.addEventListener("abort", onAbort);

    try {
      if (options.abortController?.signal.aborted) onAbort();

      // Task 3: a string prompt sends one `user` frame then `end_input`; an AsyncIterable<string>
      // prompt sends each item as a `user` frame AS IT ARRIVES — not waiting for that turn's
      // result first, true streaming input (WS-04 §3: "stream stays open; end-of-input is
      // explicit") — then `end_input` once the iterable itself completes. Runs concurrently with
      // the read loop below (not awaited before it): sequencing it first would serialize "send one
      // prompt, read its whole response" instead of allowing overlap, defeating streaming input.
      // Replaces the P0 `firstOf` stub, which sent only the iterable's first item and silently
      // discarded the rest.
      //
      // Policy for a throwing iterable / a write after the child has already exited: swallow here,
      // matching the stderr-forwarding task above — this detached task cannot itself correct
      // anything in the read loop, and the ONE place a real failure must surface is the stdout-side
      // WS-04 §6.1 lifecycle mapping (unexpected death / nonzero exit), not a second, competing
      // rejection from this side.
      (async () => {
        try {
          if (typeof prompt === "string") {
            proc.stdin.write(encodeFrame({ type: "user", text: prompt }));
          } else {
            for await (const text of prompt) {
              proc.stdin.write(encodeFrame({ type: "user", text }));
            }
          }
          // Task 2: routed through sendControlRequest (rather than a raw encodeFrame write, as
          // before) so its ack is correlated like any other host-originated request instead of
          // arriving as an "unmatched" control_response — the swallowed catch is deliberate: this
          // detached sender task has nowhere useful to surface a rejection (e.g. the connection
          // closing before the ack arrives), matching the policy note above for the writes just above.
          sendControlRequest("end_input", undefined).catch(() => {});
          // Ruling P2-B (WS-04 §1, wrapper side — see the engine-side half in packages/runtime/src/
          // engine.ts's pump): stdin no longer closes HERE, immediately after sending. Closing it
          // this early made single-shot mode structurally unable to ANSWER a runtime-originated
          // control_request (a permission RPC, T8) that arrives after end_input — the child's read
          // side would have nothing left to read (a real pipe EOFs; the in-memory leg's own wrapping
          // generator, testing.ts's `input`, ends its own `for await (const chunk of stdin)` the
          // moment the Queue itself ends, REGARDLESS of whether the runtime-side pump would still
          // want more) — no answer could ever land no matter how fast the host replied. stdin now
          // closes at `iterate()`'s own `finally` below (this generator's teardown): the same point
          // for every prompt shape (single-shot or streaming), reached only once the whole exchange
          // — including any permission RPC the runtime still needed answered — is truly over.
        } catch {
          /* see policy note above */
        }
      })();

      let sawInit = false;
      let sawTerminal = false;
      let terminalError: Extract<SdkMessage, { type: "result" }> | null = null;
      let carry = "";

      // Controller Ruling P1-I (Task 4 fix round 1): termination is MODE-AWARE. A single-shot
      // string prompt is exactly one turn — stopping at its one terminal result is correct and
      // UNCHANGED below. A streaming-input (AsyncIterable) prompt can carry MULTIPLE user
      // envelopes, each producing its own terminal result (WS-04 §4.1: idle -> turn_active ->
      // idle, once per envelope) — unconditionally breaking at the FIRST result silently dropped
      // every subsequent turn's frames (confirmed empirically: a real two-turn streaming session
      // through this function yielded only turn 1, with no error, before this fix). In streaming
      // mode the loop instead runs to the transport's own natural end (stdout EOF, which the
      // runtime produces only after `end_input` and its last in-flight turn's result — WS-04 §6),
      // yielding EVERY result along the way.
      const isStreamingInput = typeof prompt !== "string";

      // A plain, unraced drain (review Finding 5): racing `stdout` against an independently
      // resolving `exited` structurally favors `exited` (an already-settled promise's `.then`
      // enqueues before a fresh async-generator resumption), which can cut off frames that are
      // ALREADY available to read — silently losing a backlog on abort. WS-04 §1.1 makes this
      // loop's simplicity safe: a compliant transport (real child or in-memory) MUST end its
      // stdout by the time `exited` resolves, so trusting stdout to end on its own — never bailing
      // out early via a side-channel race — is both simpler and correct. `aborted` still decides
      // WHICH lifecycle error applies once the loop ends; it no longer decides WHEN it ends.
      readLoop: for await (const chunk of proc.stdout) {
        let frames: WinterFrame[];
        try {
          const split = splitFrames(chunk, carry);
          frames = split.frames;
          carry = split.carry;
        } catch (e) {
          throw new ProtocolDecodeError(e instanceof ProtocolError ? e.message : String(e));
        }

        for (const frame of frames) {
          if (!sawInit) {
            if (frame.type !== "init") {
              throw new ProtocolDecodeError(`protocol violation: expected 'init' as the first frame, got '${frame.type}'`);
            }
            const init = frame as InitFrame;
            const runtimeMajor = init.protocolVersion.split(".")[0];
            const sdkMajor = PROTOCOL_VERSION.split(".")[0];
            if (runtimeMajor !== sdkMajor) {
              throw new CLIConnectionError(
                `protocol version mismatch: runtime speaks ${init.protocolVersion}, sdk expects ${PROTOCOL_VERSION}`,
              );
            }
            sawInit = true;
            continue; // internal handshake; the SDK system/init arrives as a data frame
          }
          if (frame.type === "control_response") {
            // Task 2 direction inversion: the ACK for a request THIS WRAPPER originated
            // (sendControlRequest — interrupt/setPermissionMode/end_input today), correlated by
            // requestId. Unmatched (stale, or a response for a requestId this process no longer
            // tracks — e.g. after the finally-block teardown below already rejected it) is dropped
            // silently: a response is host-facing library plumbing, not a user-visible diagnostic,
            // and every query() call's own routine end_input ack would otherwise never match
            // anything here worth telling the consumer about.
            const cf = frame as ControlResponseFrame;
            const pendingReq = pendingHostRequests.get(cf.requestId);
            if (pendingReq) {
              pendingHostRequests.delete(cf.requestId);
              if (cf.ok) pendingReq.resolve(cf.payload);
              else pendingReq.reject(new WinterRpcError(cf.error?.code ?? "unknown_error", cf.error?.message ?? "control request failed"));
            }
            continue;
          }
          if (frame.type === "control_request") {
            // Runtime-originated (WS-04 §3.1 direction inversion) — dispatched to the handler
            // registry. Fire-and-forget: answering it (a permission prompt may wait on a human)
            // must never block this loop from continuing to read/yield the turn's other frames.
            void handleIncomingControlRequest(frame as ControlRequestFrame);
            continue;
          }
          if (frame.type !== "data") continue; // other frame kinds: still lossless pass-through, no-op for now
          const message = (frame as { message: SdkMessage }).message;
          yield message; // yield EVERY message, including every terminal result…
          if (message.type === "result") {
            sawTerminal = true;
            // An is_error result still ultimately drives error-result-then-throw below (report
            // §9) — in streaming mode that throw is deferred until the transport's natural EOF
            // (never mid-stream), so it can never silently cut off a later, still-pending turn's
            // frames the way an immediate break would. Overwritten on each error result seen, so
            // with multiple erroring turns the LAST one is what's thrown — a defensible, documented
            // choice where the spec is silent on which of several errors should win.
            // PROVISIONAL (Ruling P1-J, capture-pending): the whole throw-at-EOF-in-streaming-mode
            // semantic — including last-error-wins — awaits differential capture against the
            // official runtime, which plausibly does NOT throw in streaming mode at all (it may
            // yield erroring results and end cleanly, leaving inspection to the caller). Same
            // pending-capture class as the interrupted-result shape; pinned or revised at the
            // capture phase (P1 T11 carries the check).
            if ((message as { is_error?: boolean }).is_error) terminalError = message as Extract<SdkMessage, { type: "result" }>;
            if (!isStreamingInput) break readLoop; // single-shot prompt: exactly one turn, unchanged
          }
        }

        // Bounds the unterminated (no-newline-yet) buffer — the hang vector for a line that never
        // completes or a single already-huge line (WS-04 §2's maxBufferSize option). Checked AFTER
        // yielding this chunk's already-decoded complete frames (review Finding 2): a chunk can
        // legitimately carry complete frames followed by an oversized unterminated tail, and those
        // complete frames must still be delivered before the wrapper surfaces the error.
        if (carry.length > maxBufferSize) {
          throw new ProtocolDecodeError(`protocol line exceeds maxBufferSize (${maxBufferSize} bytes)`);
        }
      }

      // WS-04 §6.1: each row below is one code path. A seen terminal result (success or error)
      // takes priority over `aborted` (review Finding 6) — a turn that genuinely completed must
      // complete cleanly (or via ResultError) even if a cancellation happened to land in the same
      // tick; only the ABSENCE of a terminal result falls through to the abort/death distinction.
      if (terminalError) throw new ResultError(terminalError); // …then throw (error-result-then-throw, report §9)
      if (sawTerminal) return;
      if (aborted) throw new AbortError("query aborted: runtime process killed");
      if (!sawInit) throw new CLIConnectionError("runtime exited before init");
      const exitInfo = await proc.exited;
      throw new ProcessError("unexpected process death: runtime exited without a terminal result", exitInfo.code, exitInfo.signal);
    } finally {
      // Item 1 (P2 fix-wave): set FIRST, before anything else in this finally block — every control
      // call issued from this point forward (including one racing this very teardown) sees the
      // generator as terminated and fails fast instead of registering a promise nothing will ever
      // settle.
      generatorTerminated = true;
      options.abortController?.signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      // Ruling P2-B (wrapper side): stdin closes HERE — at this generator's own teardown — for
      // every prompt shape alike, reached only via return (sawTerminal), throw (every error path
      // above), or an external `.return()`/`.throw()` (a consumer walking away early via `break`/
      // `for await` early exit). By this point either the whole exchange is genuinely over, or the
      // consumer has stopped caring — either way it is now safe to stop writing. Never called any
      // earlier (see the sender IIFE's own comment on the call site this replaced) so a runtime-
      // originated permission RPC arriving after end_input can still be answered while this
      // generator is still actively being iterated. Swallowed like every other write/end on a
      // possibly-already-exited child (established policy throughout this file).
      try {
        proc.stdin.end();
      } catch {
        /* see policy note above */
      }
      // Task 2: a still-pending host-originated request (interrupt/setPermissionMode) whose ack
      // will now never arrive — the connection is torn down — must not hang its caller forever.
      if (pendingHostRequests.size > 0) {
        const err = new WinterRpcError("connection_closed", "runtime connection closed before this control request was acknowledged");
        for (const pendingReq of pendingHostRequests.values()) pendingReq.reject(err);
        pendingHostRequests.clear();
      }
    }
  }

  const gen = iterate() as Query;
  // Task 2: real control requests, replacing the P0/P1 stubs (previously `proc.stdin.end()` for
  // interrupt; both setters were no-ops) — both now send a real control_request and resolve/reject
  // on the runtime's ack via sendControlRequest/pendingHostRequests above. The engine already acks
  // interrupt at P1 (its own state machine — abort the in-flight round, provisional interrupted
  // result — is unchanged, see engine.test.ts); this task only wires the WRAPPER side of that
  // exchange. A consumer must be actively iterating (or have iterated far enough to have read the
  // ack) for either promise to ever settle — true of any control response (WS-03 §4: "control calls
  // during active iteration are legal").
  gen.interrupt = async () => {
    await sendControlRequest("interrupt", { scope: "turn" });
  };
  // Still a stub: no engine-side `set_model` control-request handler exists yet (a future task adds
  // it — the correlation plumbing this stub would need now exists, unlike at P1).
  gen.setModel = async () => {};
  gen.setPermissionMode = async (mode: PermissionMode) => {
    await sendControlRequest("set_permission_mode", mode); // WS-04 §3.1: bare PermissionMode value
  };
  gen.__internal = {
    registerControlRequestHandler(subtype, handler) {
      controlRequestHandlers.set(subtype, handler);
    },
    // Task 8 (WS-07 §7.2's "null escape"): marks `requestId` answered BEFORE writing, so a
    // concurrently-resolving handler's own (suppressed) write can never race ahead of this one —
    // writeControlResponse's guard checks/consumes this same set. Swallow-on-write-failure matches
    // this file's established policy (a write after the child has already exited is never a second,
    // competing failure — see handleIncomingControlRequest's own header comment).
    respondPermission(requestId, result) {
      respondedOutOfBand.add(requestId);
      try {
        proc.stdin.write(encodeFrame({ type: "control_response", requestId, ok: true, payload: result }));
      } catch {
        /* see policy note above */
      }
    },
  };
  return gen;
}
