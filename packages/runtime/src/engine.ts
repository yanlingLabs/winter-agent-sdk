import { randomUUID } from "node:crypto";
import { homedir, release as osRelease } from "node:os";
// Phase 5 fix wave, I1: `buildBaselineDenyRules` compares the resolved winter root against the
// literal default, so it needs path resolution.
import { join, resolve } from "node:path";
import {
  PROTOCOL_VERSION,
  type RuntimeConfig,
  type ControlRequestFrame,
  type ControlResponseFrame,
  type UserFrame,
  type WinterFrame,
  type ProtocolSdkMessage as SdkMessage,
  type PermissionUpdate,
  type RuleSource,
  type HookEvent,
  type SDKPermissionDenial,
  type PermissionMode,
  type BackgroundTaskMessage,
  compatibilityKeys,
  // Phase 5 Task 2 (R5-3/R5-4): the session defaults are exported CONSTANTS, resolved here when the
  // corresponding RuntimeConfig field is absent -- never baked into the wire by query.ts.
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_OUTPUT_STYLE,
  type InitPluginInfo,
  // Phase 6 Task 3 (R6-D): the wire vocabularies are declared ONCE, in the sdk. `ProviderRawStreamEvent`
  // below is an alias of `WireStreamEvent`, and `RetryInfo.error` is the pinned 11-member taxonomy --
  // a second structural copy in this file is exactly the drift R6-D exists to avoid.
  type SDKAssistantMessageError,
  type WireStreamEvent,
} from "@yanlinglabs/winter-agent-sdk";
// Phase 6 Task 3 (R6-3): `MessageOrigin`/`ProviderNativeState` are CANONICAL in provider-runtime's
// `types.ts` -- this file imports and re-exports them rather than declaring twins. The dependency runs
// runtime -> provider-runtime only (R6-4: provider-runtime never imports the runtime), so the seam
// types can live down there while `ProviderTurn`/`ProviderMessage`/`ContentBlock` stay up here.
// `TurnRequest` is imported for its `toolChoice`/`effort`/`thinking` member types, so the engine's
// request and an adapter's request cannot drift apart on the three fields they share.
import type { MessageOrigin, ProviderNativeState, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
export type { MessageOrigin, ProviderNativeState };
// R6-7: the sidecar record types the persistence seam carries. `store/provider-state.ts` imports
// NOTHING from this file (its own types come from provider-runtime), so this is not the circular
// direction `store/dialect.ts` has to avoid.
import { PROVIDER_STATE_FILE_SUFFIX, type ProviderStateRecord, type ProviderStateRecordInput } from "./store/provider-state.ts";
// Review round 1 (M8): the two pure clusters this file used to inline. Both are plain functions of
// their inputs -- `provider/stream-frames.ts` imports only the `ProviderStreamSink` TYPE from here, and
// `store/continuation-attach.ts` imports nothing from here at all (its message shape is structural,
// which is what keeps the `store/` -> `engine.ts` direction closed).
import { createStreamFrameSink } from "./provider/stream-frames.ts";
import { attachContinuationChain } from "./store/continuation-attach.ts";
import type { FrameSource, FrameSink } from "./protocol/channel.ts";
import { Queue } from "./protocol/channel.ts";
import { createRpcBridge } from "./rpc/bridge.ts";
// Phase 4 Task 3 (MUST 4): the host->runtime MCP control-request handlers, as pure functions --
// this file's own pump (below) becomes a thin per-subtype dispatcher over these.
import { handleMcpStatus, handleMcpReconnect, handleMcpToggle, handleMcpSetServers, mcpServerStatesToWire } from "./rpc/mcp-control.ts";
import type { McpServerStateSource } from "./mcp/state.ts";
import type { McpControlSeam } from "./mcp/control-seam.ts";
// Phase 4 Task 2/3 (WS-09 §2/§7/§8.1): the unbranded MCP/Tool-Search env controls, parsed once per
// run (mirrors how every other env-derived value in this file is resolved exactly once at startup).
import { parseMcpEnvConfig } from "./mcp/env.ts";
// Phase 5 Task 3 (spine): the lane seams. `import type` throughout -- context/seam.ts imports
// nothing from this module, and a value import in either direction would make the pair a runtime
// cycle the compiled binary resolves differently from the dev leg.
import type { AssembledPrompt, SkillListing, SystemPromptAssembler, SystemPromptInput } from "./context/seam.ts";
import type { CompactBoundaryRecord, CompactBoundaryWriteResult, CompactionController, CompactionResult } from "./compaction/seam.ts";
import { STRUCTURED_OUTPUT_TOOL_NAME, resolveMaxStructuredOutputAttempts, type StructuredOutputSeam } from "./structured/seam.ts";
import { isCheckpointedTool, type CheckpointedTool, type FileCheckpointSink } from "./checkpoint/seam.ts";
import { resolveBuiltinCommand, looksLikeCommand, type CommandResolver } from "./commands/seam.ts";
// Phase 4 Task 8 (rider 11): Lane A's real MCP client/lifecycle/control stack, wired into a live
// session for the first time. Lane A shipped all of it as a self-contained subsystem with the exact
// integration recipe in its own report, and could not perform the integration itself: the
// elicitation sender it needs is `bridge`, which is a closure-local value inside THIS function --
// there is no seam exposing it outward, so main.ts structurally cannot construct one.
import { createMcpLifecycle, resolveMcpServerSources, registerSessionMcpLifecycle, type McpLifecycle, type McpServerSource } from "./mcp/lifecycle.ts";
import { createElicitationAsker } from "./mcp/elicitation.ts";
// Phase 4 Task 3 (MUST 5/8): the child-spawn seam + host-stream correlation transform, and the
// messaging router seam's own engine-side hook (children() from the live child roster).
import { getChildEngineFactory, transformChildFrame, type ChildHandle, type ChildInheritance, type ParentMcpState, type ParentRuleMirror, type SpawnChildRequest } from "./subagents/child-handle.ts";
// Phase 4 Task 8: the process-level default messaging runtime Lane D's three tool executors read --
// see that function's own header for why it is process-level and why the roster is contributed
// per-run rather than the runtime being rebuilt per-run.
import { ensureDefaultMessagingRuntimeRegistered } from "./messaging/reference-adapter.ts";
// Phase 4 Task 3 (WS-07 §11 / RULING P2-M): the child permission-policy comparator.
import { computeChildPolicy } from "./permissions/auto/inheritance.ts";
import { PolicyStateStore, WinterPermissionError, assertKnownPermissionMode, isPermissionMode } from "./permissions/policy-state.ts";
import { emptyRuleSet, buildSdkSourcedEntries, sourceRule, type SourcedRuleEntry } from "./permissions/ruleset.ts";
import { createBridgePromptStage } from "./permissions/prompt-stage.ts";
import {
  evaluate,
  probeReadAccess,
  REAL_SPECIAL_CHECKS,
  // Task 8 (P3 close-out, "Settings threading" MUST): reused for the session seam's own
  // `getBoundedRoots()` (registry.ts) -- the IDENTICAL "cwd or additionalDirectories" notion the
  // standing evaluator already computes for acceptEdits/critical-removal, never re-derived.
  boundedRoots,
  // Fix wave (RULING P4-E amended): the pure rule-matching lookup the alias-identity probes at the
  // dispatch loop reuse -- the IDENTICAL matcher `evaluate()`'s own stages 2/3/5 run, never a second
  // implementation of the deny/ask grammar living in the alias layer.
  findMatchingRuleEntry,
  // Phase 5 Task 3 (R5-11): the SAME write-path extraction the permission layer uses -- see the
  // checkpoint call site for why a second extraction would be a correctness bug, not a duplication nit.
  extractCandidateWritePaths,
  type PermissionCall,
  type EvaluationContext,
} from "./permissions/evaluator.ts";
// Task 12 (WS-07 §6.6/§10): the real AutoEngine (T6's NO_OPINION_AUTO_ENGINE stub retired here —
// the one production call site, exactly like T7/T8/T10 retired their own stubs above; every other
// reference left in the codebase is test-only). `createInMemoryAutoCounterStore` is the fallback
// for a non-persistent session (autoStateStore undefined below), mirroring how `approvalStore`
// being undefined already means "no durable approval machinery this run."
import { createAutoEngine, NO_OP_AUTO_AUDIT_RECORDER, type ClassifierInterface } from "./permissions/auto/engine.ts";
import { createInMemoryAutoCounterStore, computePolicyHash, type AutoCounterStore } from "./permissions/auto/caches.ts";
// T9's PostToolUse-accumulated classifierContext (WS-07 §10.4/§10.6-8) — reducer.ts's own
// AttributedContext type, threaded into the auto engine's getClassifierContext closure below.
import type { AttributedContext } from "./hooks/reducer.ts";
// Task 10 (WS-08 §1/§2/§6/§9/§10): the real hooks engine wiring — registry+invoker+audit build,
// the real HookStage (retiring T6's NO_OPINION_HOOK_STAGE stub, the one production call site,
// exactly like T7/T8 retired their own stubs above), and the direct runHooks() call sites this
// engine owns itself for the events that are NOT stage-1 PreToolUse/PermissionRequest (those two
// flow through createHookStage; everything else here fires ad hoc, at its own lifecycle point).
import { createHookStage } from "./hooks/hook-stage.ts";
import { buildHookRegistry, type SourcedHookEntry } from "./hooks/registry.ts";
// The advertised name of the Skill tool, so the withheld-listing check below cannot drift from
// the descriptor it is about.
const SKILL_TOOL_ADVERTISED_NAME = "Skill";
// Phase 5 Task 8 (rider 21): the workflow session registration -- see its call site below for why
// it lives inside this closure rather than in production-wiring.ts.
import { registerWorkflowSession, clearWorkflowSession } from "./workflows/host-registry.ts";
import { resolveProjectDirName } from "./paths/project-dir-name.ts";
import { loadAgentDefinitions, type PluginAgentDefinition } from "./subagents/definitions.ts";
import { getPluginAgents } from "./subagents/plugin-agents.ts";
import { getSkillSessionRuntime } from "./skills/runtime.ts";
import { buildHookEntriesFromConfig } from "./hooks/from-config.ts";
// Phase 5 Task 8 (rider 5): a `{type:"command"}` hook entry from a settings file or a plugin manifest
// has a real executor now -- see the `allHookEntries` block below for why the invoker and the
// registry must be built from ONE array.
import { createCommandHookInvoker } from "./hooks/command-invoker.ts";
// Phase 5 Task 2 (R5-6 -> RULING P5-A): the seam that replaces this file's own P2-era
// `const trustedWorkspace = false`. See settings/trust.ts's header for what capture (1) actually
// found and why the per-tier permissive filter deliberately does NOT live here.
import { defaultTrustSource } from "./settings/trust.ts";
import { createBridgeHookInvoker } from "./hooks/bridge-invoker.ts";
import { runHooks, type HookAuditRecord, type HookAuditRecorder, type HookInvoker, type RunHooksCallInfo } from "./hooks/runner.ts";
// Task 11 (WS-07 §9 / WS-08 §7): the durable approval store a `defer` decision parks into, and the
// pure revalidation function the resume-consumption step (this file, below) uses.
import {
  revalidateApproval,
  WINTER_RUNTIME_KIND,
  type DurableApprovalStore,
  type DurableApprovalRecord,
} from "./permissions/approvals.ts";
// Task 1 (P3, WS-06 §1): the tool registry -- forcing this side-effect import registers every WS-06
// §2 stub (descriptors/index.ts's own header explains why registry.ts itself never imports it back,
// avoiding a cycle) before this module's own buildDefaultToolExecutor (below) can ever be called.
import "./tools/descriptors/index.ts";
// Task 8 (P3 close-out, production wiring MUST): every lane's own real executor now reaches live
// sessions too -- see tools/impl/index.ts's own header for why this second barrel exists and why
// import ORDER relative to the descriptors barrel above does not matter (every impl file is
// self-sufficient: it imports its own descriptor before calling replaceExecutor).
import "./tools/impl/index.ts";
import {
  buildRegistryToolExecutor,
  buildRegistryToolExecutorWithFallback,
  replaceExecutor,
  getRegisteredTool,
  registerMcpServerTools,
  unregisterMcpServerTools,
  // Phase 4 Task 3 (RULING P4-A): the single "Tool Search on" activation authority + the
  // eager/deferred/hidden partition wired on top of buildAdvertisedSet's own output.
  isDeferralActive,
  partitionAdvertisedTools,
  createLoadedToolSet,
  // Phase 5 Task 3 (R5-4 / WS-09 §8.5): the deferred loaded-set reset a committed compaction fires.
  onCompaction,
  // Phase 5 Task 3 (R5-10): the per-session, host-generated `StructuredOutput` registration.
  registerHostGeneratedTool,
  type JSONSchema,
  isLoadFirstBlocked,
  // Phase 4 Task 8 (rider 27): the availability predicate, applied at the execution boundary.
  isToolAvailable,
  // Phase 4 Task 8 (rider 1): the runtime-derived capability tokens (winter.mcp/winter.subagents/
  // winter.global-messaging), unioned with whatever the host supplied -- see that function's own
  // header in registry.ts.
  resolveSessionCapabilities,
  type RegistryToolExecutorDeps,
  type McpToolDefinition,
  type DeferralActivation,
  type LoadedToolSet,
} from "./tools/registry.ts";
// M6 (fix wave, P3 close-out): RULING R3-2's own "T8 wires the REAL source, from wherever the
// engine's real turn history... actually lives" instruction -- this IS that wiring. A specific,
// scoped cross-module dependency (engine.ts -> one lane's own tools/impl/*.ts file), unlike every
// OTHER tool this engine dispatches through the generic registry -- deliberate, and named as such
// here rather than left looking like an oversight against R3-5's "lanes never edit registry.ts"
// boundary (this is the opposite direction: the engine reaching INTO a lane's own file, not a lane
// reaching into the registry).
import { createAdvisorExecutor, ADVISOR_TOOL_NAME, type TranscriptEntry } from "./tools/impl/advisor.ts";
import { createSessionReadState } from "./tools/read-state.ts";
import { configureBackgroundTaskRoot } from "./tools/background-tasks.ts";
import { sessionTempDir, type SessionTempDirPaths } from "./paths/temp.ts";
// Task 8 (P3 close-out, "Settings threading" MUST): the resolved-once-per-run fallback every real
// executor (bash.ts, monitor.ts) used to hardcode as a module constant -- see
// RegistryToolExecutorDeps.sandboxSettings's own comment (registry.ts) for the seam this feeds.
import { DEFAULT_SANDBOX_SETTINGS } from "./sandbox/profile.ts";
// B-H1(a): whether this HOST can actually sandbox -- a session that asked for one on a machine
// without `sandbox-exec` gets no containment, and therefore earns no auto-allow.
import { isSandboxAvailable } from "./sandbox/spawn.ts";
// Phase 4 Task 8 (rider 3, WS-09 §10): Lane B's pure alias helpers -- single-hop canonical-identity
// resolution for the permission/hook axis, and duplicate suppression over the advertised partition.
// Both shipped as pure functions with no engine call site (R4-10 forbade Lane B from adding one);
// this file is that call site.
import { aliasExclusionReasons, effectiveAliasTable, resolvePermissionIdentity, suppressAliasedDuplicates } from "./toolsearch/aliases.ts";
// Phase 4 Task 8 (rider 2, WS-09 §8): Lane B's session-keyed ToolSearch/WaitForMcpServers runtime
// registry. Both of that lane's executors answer a typed "no session runtime registered" error until
// a live run registers one -- this file is the one production registrar.
import { registerToolSearchSessionRuntime } from "./toolsearch/search.ts";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  // Phase 4 Task 3 (MUST 6, WS-09 §8.2/§8.3): "successful selection returns tool_reference blocks
  // making the tools callable next step." WINTER-OWNED shape -- T1's own item (c) finding is that
  // `tool_reference` is declaration-absent from the pinned official artifact entirely (sourced there
  // only from a runtime capture, never a .d.ts line), so there is nothing to mirror byte-for-byte;
  // `tool_names` is this shape's own, most direct rendering of "which names just became callable."
  | { type: "tool_reference"; tool_names: string[] }
  // `interrupted`/`error`/`denied`/`deferred`/`loadFirst` are optional and set ONLY on a synthetic
  // tool_result the engine manufactures instead of actually executing the call — `interrupted` for
  // an abandoned-mid-interrupt call (Ruling P1-G), `error` for a call whose tool executor threw
  // (Ruling P1-H), `denied` for a call the six-stage permission evaluator (Task 6, WS-07 §2)
  // refused to execute at all, `deferred` for a call a PreToolUse hook parked into a durable
  // approval record instead of resolving now (Task 11, WS-08 §7) (cross-task pin: "a normal
  // tool_result ... same provisional-marker class as interrupted/error/denied"). `loadFirst`
  // (Phase 4 Task 3, WS-09 §8.5) marks a call for a tool this session's own registry marked
  // DEFERRED that is NOT (yet) in the session's LoadedToolSet -- WS-09 §8.2's own "load ≠
  // permission": this check runs BEFORE permission evaluation even starts (an unloaded deferred
  // tool is not yet ELIGIBLE to run at all, independent of whether it would otherwise be allowed),
  // so a load-first rejection never consumes a canUseTool prompt. All five are provisional shapes
  // pending official capture. Never set on a real tool_result; never two of the five set on the
  // same block (a single call reaches at most one of load-first-before-evaluation,
  // denied-before-execution, deferred-before-execution, interrupted-during-execution, or
  // errored-during-execution).
  //
  // Phase 6 Task 3 (R6-3): `content` WIDENS to `string | ContentBlock[]`. Established from the pin's
  // own prose about its own tool, not from an external declaration -- `Read`'s output notes
  // (`sdk-tools.d.ts:334`, `:338`) describe extracted page images delivered SOLELY as image blocks in
  // the model-facing `tool_result` content. This is the ONE compile-forced edit in the R6-3 sweep:
  // every `return block.content` fallthrough in this repo stops type-checking, which is exactly why
  // the three variants below need FIXTURES instead of trusting the build.
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; interrupted?: boolean; error?: boolean; denied?: boolean; deferred?: boolean; loadFirst?: boolean }
  // --- Phase 6 Task 3 (R6-3, derived-shapes-p6.md item (f)): the variants a real provider produces --
  //
  // NOT declared by the pinned artifact: `redacted_thinking`, a `type: 'thinking'` literal and
  // `signature`-as-a-block-field have ZERO occurrences across all six `.d.ts` files, because every
  // block shape is delegated to a floating `@anthropic-ai/sdk` peer. These shapes are Winter's own,
  // mirrored from capture (F)'s observed runtime behaviour and structurally identical to
  // provider-runtime's `ContentBlockLike` (seam-contracts-p6.test.ts asserts assignability BOTH ways).
  //
  // `signature` is a REQUIRED plain string that MAY be `""`: capture (F) shows the pinned runtime
  // materialising exactly that when a stream carries none, and replaying it byte-for-byte into the
  // next request. Typing it optional would let a producer omit it and break the signature chain
  // silently -- and R6-8 exists because a FOREIGN summary written here would ride a fabricated one.
  //
  // OPAQUE FIELD DISCIPLINE (Global Constraints): `signature` and `redacted_thinking.data` ride
  // IN-DIALECT (the dialect itself defines them) and NOWHERE else -- never the advisor transcript,
  // never the compaction summariser's input, never a log line, never an error message. The seam
  // contract test asserts each of those negatives rather than trusting the comment.
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

// The engine's own turn-history record fed back to Provider.generate() on every call. Distinct
// from the WIRE shape (assistant/user data frames, below): the wire has no "tool" role (tool
// results ride a "user" message, matching WS-03 §8 / the official SDK), but keeping tool results
// on their own role here keeps accumulation/tool-round assertions simple and unambiguous.
export interface ProviderMessage {
  role: "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  // --- Phase 6 Task 3 (R6-3): the per-message continuation annotations -----------------------------
  //
  // All four OPTIONAL and ADDITIVE: every pre-existing `{role, content}` literal in this repo (and
  // every test double, and every rebuilt resume history) keeps satisfying this interface unchanged.
  //
  // `uuid` is the assistant entry's own dialect uuid, PRE-ALLOCATED by the engine and passed through
  // `recordAssistantEntry(content, { uuid })` so the sidecar record can be appended BEFORE its entry
  // (R6-7's write-ahead). It is what `anchorUuid` on a `ProviderStateRecord` points at.
  uuid?: string;
  /** Which provider/model produced this message. The input to R6-9's continuation-domain check on resume, fallback and handoff. */
  origin?: MessageOrigin;
  /**
   * OPAQUE, adapter-owned continuation state. Its ONLY sink is the provider-state sidecar (R6-7).
   * Never logged, never model-readable, never in a frame or an error message -- `items` is
   * `unknown[]` precisely so nothing is tempted to inspect it.
   */
  nativeState?: ProviderNativeState;
  /**
   * A Winter-authored annotation shown to the model -- a handoff note, or a foreign model's reasoning
   * summary carried across a family boundary. Carried PLAINLY, never dressed as signed thinking
   * (R6-8): `door` says which channel Lane C's renderer places it on, and neither door produces a
   * `thinking` block with a fabricated signature.
   */
  decoration?: { text: string; door: "tag" | "thinking-channel" };
}

// M6 (fix wave, P3 close-out): the advisor's own TranscriptSource wants plain {role, text} entries
// (tools/impl/advisor.ts's own TranscriptEntry) -- a ProviderMessage's `content` can be a bare
// string OR a ContentBlock[]; this is the one place that flattens the latter into text for that
// consumer. Deliberately conservative per-block: a text block contributes its own text verbatim, a
// tool_use block contributes a short, human-legible summary (never `JSON.stringify`-ing the raw
// `input`, which could itself contain large/opaque values a review channel has no need of), and a
// tool_result block contributes its own `content` string (already plain text by construction --
// ContentBlock's own tool_result.content field, never a nested block). This function has NO
// awareness of RULING R3-3's own opaque-marker stripping (advisor.ts's own stripOpaqueMarkers runs
// AFTER this, per-entry, on whatever text comes back from here) -- it only flattens shape, never
// filters content.
export function providerMessageContentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `[called ${block.name}]`;
      // Phase 4 Task 3: tool_reference is a streaming-only block (emitToolReference below writes it
      // straight to `output`, never into this engine's own `messages` turn history) -- reachable
      // here only if a future caller ever DOES push one into `messages`; a short, human-legible
      // summary rather than a `.content` access that (unlike tool_result) this variant has none of.
      if (block.type === "tool_reference") return `[tools now callable: ${block.tool_names.join(", ")}]`;
      // --- Phase 6 Task 3 (R6-3's by-meaning sweep) -----------------------------------------------
      //
      // Before this task the function ended in a bare `return block.content`, and THAT is the defect
      // this sweep exists to catch: on a `thinking`/`redacted_thinking`/`image` block the field does
      // not exist, so the map produced `undefined` and `join` rendered the literal string
      // "undefined" straight into a review channel -- silently, with nothing failing to compile.
      //
      // Each new variant now renders a SUMMARY that names the shape and carries NO opaque field.
      // `thinking.thinking` is model-authored prose and is not on the opaque list (only `signature`,
      // `redacted_thinking.data` and `nativeState.items` are), so it is summarised by LENGTH rather
      // than reproduced: this function feeds the advisor's review channel, whose own
      // `stripOpaqueMarkers` drops any line containing "signature" -- reproducing reasoning text here
      // would leak whatever the model happened to think about into a second channel for no benefit
      // the reviewer asked for. The blocking constraint is the opaque fields; the length summary is
      // the conservative choice on top of it, and the seam contract test asserts the negatives.
      if (block.type === "thinking") return `[thinking: ${block.thinking.length} chars]`;
      if (block.type === "redacted_thinking") return "[redacted thinking]";
      if (block.type === "image") return `[image: ${block.source.media_type}]`;
      // `tool_result.content` widened to `string | ContentBlock[]` (R6-3). A blocks-valued result
      // recurses through this same function rather than stringifying the array -- `String([{...}])`
      // is "[object Object]", which is worse than useless in a review channel.
      return typeof block.content === "string" ? block.content : providerMessageContentToText(block.content);
    })
    .join("\n");
}

// --- Phase 5 Task 2 (R5-3): the provider seam extension -------------------------------------------
//
// P1 fixed `Provider.generate` at `{ messages }`. Two things P5 needs cross that boundary and had
// nowhere to ride: the assembled SYSTEM PROMPT (WS-11 §6 -- and, per R5-3, the channel that RETIRES
// P4-J's first-turn concatenation of `AgentDefinition.prompt` into the message history) and the
// per-generation TOKEN USAGE the compaction trigger reads (R5-4).
//
// Both are OPTIONAL and both are ADDITIVE: every pre-existing Provider implementation -- the mock
// family, every test double, every scripted fixture -- keeps satisfying this interface unchanged,
// and a producer that has nothing to say omits the key entirely rather than sending `undefined`
// (`exactOptionalPropertyTypes`). P6's real provider adapters CONSUME this seam and must never
// redefine it.
export interface ProviderRequest {
  messages: ProviderMessage[];
  /**
   * The assembled system prompt for this generation.
   *
   * ONE PRODUCER, deliberately. At Task 2 nothing in runEngine sets it -- Task 3 owns prompt
   * assembly, and a second producer here is exactly the failure mode a new optional field invites
   * (nothing fails to compile when a producer simply doesn't set it, so the sweep has to be by
   * MEANING, not by build breakage). A consumer must therefore treat an absent `system` as "this
   * host supplied no system prompt", never as an error.
   */
  system?: string;
  // --- Phase 6 Task 3 (R6-3): everything a REAL adapter needs, all optional, all additive ----------
  /**
   * The session's ADVERTISED tool set with real JSON Schemas -- what an adapter puts in the request's
   * own `tools` array. Only tools this session actually advertises reach here, and a DEFERRED tool
   * appears only once it has been LOADED (WS-09 §8.2's "load != permission"): advertising a schema
   * for a tool the engine would refuse to dispatch invites the model to call it.
   */
  tools?: ProviderToolSpec[];
  toolChoice?: TurnRequest["toolChoice"];
  /** The resolved model for THIS generation. Present once selection is wired; absent means "the provider's own configured default", which is what every pre-P6 double sees. */
  model?: string;
  effort?: TurnRequest["effort"];
  thinking?: TurnRequest["thinking"];
  /**
   * R6-6: TRUE cancellation. Aborted when this turn is interrupted, so an adapter can cancel
   * pre-header and mid-stream instead of running to completion behind an abandoned await. The same
   * signal reaches `ToolExecutor` through `ToolExecutionContext.signal`, so an interrupt stops the
   * generation AND kills the in-flight Bash process group.
   */
  signal?: AbortSignal;
  /**
   * R6-5: where live observations go. A provider that streams calls these as the stream arrives; the
   * engine turns them into frames under the gating each frame carries (`stream_event` only under
   * `includePartialMessages`, `rate_limit_event` only for subscription-shaped quota per R6-B).
   *
   * ABSENT for an AUXILIARY generation (R6-G): the compaction summariser, the classifier, the advisor
   * and `countTokens` never emit `stream_event`s -- capture (F) observed the pinned runtime
   * suppressing exactly that call's stream events, and a Winter emitter that streamed every provider
   * call would emit frames the pin does not.
   */
  sink?: ProviderStreamSink;
}

/** One advertised tool as an adapter serialises it. `inputSchema` is the tool's real JSON Schema, never a placeholder. */
export interface ProviderToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * R6-5: the pinned Anthropic-shaped raw stream-event vocabulary every adapter normalises into.
 *
 * ALIASED, never re-declared. The declaration home is `packages/sdk/src/protocol/frames.ts`
 * (`WireStreamEvent`), because the sdk is where a wire shape a host decodes belongs and because a
 * second structural copy here is exactly the drift R6-D exists to avoid.
 */
export type ProviderRawStreamEvent = WireStreamEvent;

/**
 * The live observations a streaming provider reports. Every method is fire-and-forget: a sink
 * implementation that throws must never break a generation, so the engine's own implementation
 * catches and drops.
 */
export interface ProviderStreamSink {
  onStreamEvent(event: ProviderRawStreamEvent): void;
  onRetry(info: RetryInfo): void;
  /**
   * R6-B: SUBSCRIPTION-QUOTA states ONLY, and the payload's own `kind` says so. An HTTP 429 is NOT
   * this callback -- capture (G) proved the pinned runtime emits zero `rate_limit_event` frames for a
   * 429 carrying a full `anthropic-ratelimit-*` header set; the pinned 429 path is `api_retry`.
   */
  onRateLimit(info: { kind: "subscription-quota"; info: Record<string, unknown> }): void;
  /** R6-F: a LOGIN-FLOW progress channel (codex-oauth login/refresh only), never the credential-failure channel. */
  onAuthStatus(info: { isAuthenticating: boolean; output?: string[]; error?: string }): void;
  /** R6-8: a FOREIGN model's readable reasoning summary. It rides the sidecar and the Winter-only `system/reasoning_summary` frame -- never `assistant.message.content`. */
  onReasoningSummary(text: string): void;
}

/** The `api_retry` payload minus its frame envelope (`uuid`/`session_id`, which the engine stamps). Mirrors provider-runtime's own `retry` event. */
export interface RetryInfo {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  /** ABSENT, never `null`, for a connection error with no HTTP response -- the engine maps absence to the frame's pinned `error_status: null`. */
  errorStatus?: number;
  error: SDKAssistantMessageError;
}

/** R6-8: what a turn reports about its own reasoning. `blocks` are IN-DIALECT Anthropic-family blocks, complete and in order, carrying their REAL signatures; `summary`/`exposed` are foreign and never enter `assistant.message.content`. */
export interface ProviderThinkingOutput {
  summary?: string;
  exposed?: string;
  blocks?: ContentBlock[];
}

/** Why the provider stopped. Mirrors provider-runtime's `done` event so the bridge folds one into the other without a mapping table. */
export type ProviderStopReason = "end_turn" | "tool_use" | "max_tokens" | "aborted" | "refusal";

/**
 * Phase 6 Task 3 (R6-F): the ONE error class the engine recognises as a PROVIDER failure.
 *
 * A provider failure that ends a turn does not get its own result subtype. Capture (I) observed the
 * pinned runtime landing an API failure on `subtype: "success"` with `is_error: true`,
 * `terminal_reason: "api_error"` and `api_error_status: <status | null>` -- so the engine has to be
 * able to TELL a provider failure from any other throw, which would otherwise stay
 * `error_during_execution` exactly as before this phase.
 *
 * DECLARED HERE, not in `provider/bridge.ts`, for the same structural reason `ProviderTurn` is
 * (R6-4): the engine must recognise the type without importing the bridge, and a value import from
 * engine.ts into bridge.ts and back would be a runtime cycle whose compiled and dev resolutions can
 * differ. `bridge.ts` re-exports it, so a lane reads it from the module it is working in.
 *
 * `status` is ABSENT -- never `null` -- for a connection error with no HTTP response; the frame
 * producer maps absence to the pinned `api_error_status: null`. (Declared with `declare` and assigned
 * conditionally because `useDefineForClassFields` would otherwise EMIT an own `status` key holding
 * `undefined`, making `"status" in err` true for exactly the case the pin distinguishes -- Task 2 hit
 * this same trap on `ProviderRequestError`.)
 *
 * `message` is REDACTED BY CONSTRUCTION at every construction site: no credential material, no
 * opaque provider state, no raw response body (Global Constraints).
 */
export class ProviderTurnError extends Error {
  /** The structural marker the engine matches on, so an error crossing a package boundary is still recognised. */
  readonly winterProviderFailure = true as const;
  declare readonly status?: number;
  readonly providerCode: string | undefined;
  constructor(message: string, opts: { status?: number; providerCode?: string; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ProviderTurnError";
    if (opts.status !== undefined) Object.assign(this, { status: opts.status });
    this.providerCode = opts.providerCode;
  }
}

/**
 * True for a provider failure that must land on R6-F's result shape.
 *
 * STRUCTURAL for `ProviderTurnError` (the error may have been constructed in another package's copy
 * of this module), and by NAME for `WinterProviderResolutionError` -- which is Task 2's frozen class
 * and carries no marker of its own. R6-9 is explicit that "no model + no provider" is surfaced in
 * R6-F's captured failure shape, so a resolution refusal thrown from `generate()` must not fall
 * through to `error_during_execution` the way an ordinary bug does. It has no HTTP status, so
 * `api_error_status` is `null` -- exactly capture (I)'s run (i), where the runtime failed closed
 * without making a request at all.
 */
export function isProviderTurnError(err: unknown): err is ProviderTurnError {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { winterProviderFailure?: unknown }).winterProviderFailure === true) return true;
  return (err as { name?: unknown }).name === "WinterProviderResolutionError";
}

/**
 * P1 carry: the per-message input byte cap on provider input.
 *
 * A DISCLOSED DEFAULT WITH A TYPED ERROR, never a silent truncation -- truncating a message would
 * hand the model a conversation it never had, and the failure would surface as a confusing answer
 * rather than as an error. 4 MiB is far above any real message and far below anything that would
 * stall a serializer.
 */
export const DEFAULT_MAX_PROVIDER_MESSAGE_BYTES = 4 * 1024 * 1024;

/**
 * Per-generation token accounting (R5-3). `inputTokens`/`outputTokens` are required because a
 * provider that reports usage at all always knows both; the cache counters are optional because not
 * every provider family exposes them.
 */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// Phase 6 Task 3 (R6-3): both production kinds gain `usage`/`stopReason`/`thinking`/`nativeState`,
// and `tool_use` gains `text?`.
//
// `text?` on `tool_use` is not a convenience -- a real model returns TEXT AND CALLS in one turn, and
// before this field the text had nowhere to go and was silently discarded, losing a whole assistant
// utterance from the transcript with nothing failing anywhere. It persists as a LEADING text block
// ahead of the tool_use blocks, which is the order the model produced it in.
export type ProviderTurn =
  | { kind: "text"; text: string; usage?: ProviderUsage; stopReason?: ProviderStopReason; thinking?: ProviderThinkingOutput; nativeState?: ProviderNativeState }
  | { kind: "tool_use"; calls: Array<{ id: string; name: string; input: unknown }>; text?: string; usage?: ProviderUsage; stopReason?: ProviderStopReason; thinking?: ProviderThinkingOutput; nativeState?: ProviderNativeState };
  // Phase 6 Task 10 (R6-13): THE `rpc_probe` TURN KIND IS GONE.
  //
  // It was a P1-only scaffold whose whole purpose was to prove the runtime-originated control-RPC
  // bridge round-trips on every transport leg, at a time when no REAL runtime-originated RPC
  // existed. R6-13 made its removal conditional on that no longer being true, and the condition is
  // met: `transport-equivalence.test.ts`'s "Ruling P2-B" scenario drives a genuine permission
  // control_request the host answers, and the hooked-tool-round scenario drives a genuine `hook`
  // one -- both inside `registerEquivalenceScenarios`, so both run on the in-memory leg, a real
  // spawned child AND the compiled binary. A scaffold that duplicates a shipped path is a second
  // implementation of it.

export interface Provider {
  generate(input: ProviderRequest): Promise<ProviderTurn>;
}

/**
 * The session's running context-window accounting (R5-3), and the input R5-4's compaction trigger
 * reads: compact when `contextTokens() >= compactionThreshold * limit()`.
 *
 * `contextTokens()` is the LAST generation's input + output, not a running total -- an accumulated
 * sum would grow without bound across a conversation and cross any threshold regardless of how much
 * context actually survives, which is the opposite of what the trigger means. Cache read/write
 * counters are informational and deliberately excluded: they describe how the same input was BILLED,
 * not how much of the window it occupies.
 *
 * `limit()` is `contextWindowTokens` -- a DISCLOSED Winter session option, default 200000, until P6's
 * model catalogue supplies real per-model values. The pin has no per-session equivalent at all (its
 * nearest relative is the `autoCompactWindow` SETTING, `sdk.d.ts:7599`).
 */
export interface ContextAccountant {
  contextTokens(): number;
  limit(): number;
  record(usage: ProviderUsage): void;
  /**
   * RULING P5-J (Phase 5 fix wave): the session's CUMULATIVE token spend, monotonically increasing.
   *
   * DELIBERATELY NOT `contextTokens()`, and the difference is the whole ruling.
   * `contextTokens()` is the LAST provider call's context SIZE -- an overwrite, not an accumulation.
   * It goes DOWN after a compaction and it says nothing about what a session has spent, so a budget
   * ceiling read off it would be un-reached by a smaller call and un-reached again by a compaction.
   * `spentTokens()` only ever grows, which is the only shape a ceiling can be built on.
   *
   * CHILD USAGE ROLLS UP. A child engine records into its own accountant for its own context
   * arithmetic AND adds the same usage here, so a workflow's `budget` bounds the work its agents do
   * rather than only the parent's own turns -- which was the gap that made `budget.spent()` report
   * an honest but useless 0.
   */
  spentTokens(): number;
  /**
   * P5-J: fold a DESCENDANT's usage into this accountant's cumulative total WITHOUT touching
   * `contextTokens()`.
   *
   * Two counters, one call, and they must not be conflated: a child's tokens are spend the session
   * is responsible for, and they are NOT part of the parent's own next request, so adding them to
   * the context reading would make the parent compact on a window it does not have.
   */
  recordDescendantUsage(usage: ProviderUsage): void;
}

// Re-exported so a lane reads the seam's default from the SAME module the seam itself lives in
// rather than reaching for the sdk barrel for one number (the value is declared once, in
// packages/sdk/src/options.ts).
export { DEFAULT_CONTEXT_WINDOW_TOKENS };

export interface ContextAccountantOptions {
  /** Defaults to DEFAULT_CONTEXT_WINDOW_TOKENS. A non-positive value is ignored (the default stands) rather than producing a limit no session could ever sit under. */
  limit?: number;
}

export function createContextAccountant(opts: ContextAccountantOptions = {}): ContextAccountant {
  const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_CONTEXT_WINDOW_TOKENS;
  let last = 0;
  // P5-J: the SECOND counter. `last` is overwritten per call (the context reading); `spent` only
  // ever accumulates. Every generation touches both; a descendant's usage touches only `spent`.
  let spent = 0;
  return {
    contextTokens: () => last,
    limit: () => limit,
    spentTokens: () => spent,
    record(usage: ProviderUsage) {
      last = usage.inputTokens + usage.outputTokens;
      spent += usage.inputTokens + usage.outputTokens;
    },
    recordDescendantUsage(usage: ProviderUsage) {
      spent += usage.inputTokens + usage.outputTokens;
    },
  };
}

export interface ToolExecutor {
  /**
   * Phase 6 Task 3 (R6-6, P4 carry): `opts.signal` is ABORTED when the turn is interrupted.
   *
   * OPTIONAL on both sides, and additive: every pre-existing executor keeps satisfying this
   * interface unchanged, and an executor that ignores the signal behaves exactly as before. What
   * changes is that an executor which HONOURS it stops the work rather than merely being abandoned --
   * "a stopped child starts nothing new AND its in-flight Bash is killed" (R6-6), which was
   * previously impossible because the interrupt was a raced Promise with no channel into the tool.
   */
  execute(call: { id: string; name: string; input: unknown }, opts?: { signal?: AbortSignal }): Promise<{ output: string }>;
}

// Ruling P1-B: the minimal, data-shaped interface the engine needs to record a session (blocks/text
// in, void/promise out — no store types). Task 8 implements this over the Claude-dialect
// TranscriptWriter (WS-05 §5.2 / task-8 brief): user envelopes AND tool results both route through
// recordUserEntry (the dialect has only user/assistant roles — the "tool" role above is internal to
// this engine's own history, never persisted as such); assistant text/tool_use both route through
// recordAssistantEntry as content blocks. Entirely optional — the engine runs fine without a store.
export interface SessionPersistence {
  recordUserEntry(content: string | ContentBlock[]): void | Promise<void>;
  /**
   * Phase 6 Task 3 (R6-7): `opts.uuid` PRE-ALLOCATES the entry's own dialect uuid.
   *
   * The engine mints the uuid, appends the sidecar `origin` record naming it as `anchorUuid`, and
   * only THEN calls this -- write-ahead, so a crash can leave a record without an entry (ignorable,
   * garbage-collectable) but never an entry without a record it needed. Omitted by every pre-P6
   * caller, in which case the writer mints its own exactly as before.
   */
  recordAssistantEntry(content: ContentBlock[], opts?: { uuid?: string }): void | Promise<void>;
  /**
   * R6-7: one provider-state record. MUST be called BEFORE `recordAssistantEntry` for the same
   * `anchorUuid` -- that ordering is the whole guarantee, and provider-state.ts's crash-pair fixture
   * asserts the file order rather than trusting this comment.
   *
   * Optional, matching every other method here: a store that predates this field (or a bare test
   * double) simply never gets asked, and the session keeps an in-memory chain only.
   */
  recordProviderState?(record: ProviderStateRecordInput): void | Promise<void>;
  /** R6-7: the chain, oldest-first, for a resumed session. `undefined`/absent means "no durable chain", which degrades every resumed assistant message to summary-level with a `continuity_warning`. */
  loadProviderState?(): Promise<ProviderStateRecord[]>;
  /**
   * R6-9 / WS-16 §4: the resolved provider identity every subsequent dialect record carries
   * (`providerId`/`modelKey`/`adapterId`/`adapterVersion`/`catalogVersion`/`authRef`/`classifierPin`).
   *
   * A SEAM ADDITION beyond the brief's literal block, and it has to be one: the identity fields are
   * named as this task's deliverable and `SessionPersistence` is the only channel the engine has to
   * the store. `authRef` is the credential ref's KIND, never its material (R6-10).
   */
  setProviderIdentity?(identity: { providerId: string; modelKey: string; adapterId?: string; adapterVersion?: string; catalogVersion?: string; authRefKind?: string; classifierPin?: string }): void;
  /**
   * Review round 1 (I1): did this session ever RECORD a provider identity?
   *
   * `undefined` means "no identity block" -- a pre-P6 transcript, or one written before selection was
   * wired. That is the ONLY thing distinguishing R6-7's two silent-looking resumes: a session with no
   * records and no identity has nothing to degrade from, while one with an identity and no records
   * had its sidecar DELETED and every message is degraded.
   */
  loadProviderIdentity?(): Promise<{ providerId: string; modelKey: string } | undefined>;
  /** R6-C: records a model swap in the dialect record's `providerHistory`, alongside the Winter-only `system/model_switch` frame. */
  recordProviderSwitch?(entry: { from: string; to: string; reason: "fallback" | "set_model" | "interrupt" }): void;
  flush?(): void | Promise<void>;
  // Task 8 (WS-07 §3.3 / phase ruling 2): "a PermissionUpdate with a file destination applies
  // session-effective immediately AND appends to <sessionId>.permission-journal.jsonl for P5
  // replay." Optional, matching this whole interface's own "entirely optional" contract — the
  // engine runs fine without a store, and a store that predates this field (or a bare test double)
  // simply never gets asked. `authority` is always "session" from this engine's own call site (a
  // canUseTool answer is a live session interaction, never a direct settings-file edit) — typed as
  // the general RuleSource anyway so a future non-"session" caller isn't foreclosed.
  recordPermissionUpdate?(update: PermissionUpdate, authority: RuleSource): void | Promise<void>;
  // Task 10 (WS-08 §9 Amended text / P2-A: "Winter's AUDIT stream ... MUST carry all of it per
  // invocation"). Optional, matching every other method on this interface's own "entirely
  // optional" contract — a store that predates this field (or a bare test double) simply never
  // gets asked, and the audit recorder this engine builds (below) still exists and is still passed
  // to every hooks call site regardless; it just has nowhere durable to write without a store.
  // dialect.ts's withPermissionJournal is the one production implementation (same journal file as
  // recordPermissionUpdate, a distinguishable sibling line kind — see that file's own comment).
  recordHookAudit?(entry: HookAuditRecord): void | Promise<void>;
  /**
   * Phase 5 Task 8 (rider 16): Lane S's `invoked_skills` attachment. Optional, like every other
   * method here. The engine never calls it -- `skills/runtime.ts`'s `onInvoked` sink does, wired by
   * `production-wiring.ts` -- but it lives on this interface because it is a DURABLE session record
   * and this is the one seam the engine's storage-agnostic contract exposes for those.
   */
  recordInvokedSkills?(attachment: { type: string; skills: unknown[] }): void | Promise<void>;
  /**
   * Phase 5 Task 8 (riders 9/16): one of Lane K's checkpoint records, as a transcript-visible entry.
   * See `store/dialect.ts`'s `FILE_HISTORY_ENTRY_TYPE_BY_KIND` for what this closes (a transcript
   * reader can see that a rewind is possible) and what it does not (the `backups/index.jsonl`
   * sidecar remains the rewind's own read authority).
   */
  recordFileHistory?(record: { kind: "snapshot" | "delta"; userMessageUuid: string; path: string; pathHash: string; tool: string; at: string; version: number; absent?: boolean; parentRealPath?: string; anchorPath?: string; anchorRealPath?: string }): void | Promise<void>;
  // Phase 5 Task 3 (R5-4): "the summary and boundary persist as a `compact_boundary` system entry +
  // summary in the dialect". Optional, matching every other method on this interface's own "entirely
  // optional" contract -- a store that predates this field (or a bare test double) simply never gets
  // asked, and compaction still runs, emits its frame, and swaps the in-memory history; only the
  // DURABLE half is absent, exactly as a session with no store has no durable anything.
  //
  // Deliberately NOT expressed as a pair of recordUserEntry/recordAssistantEntry calls: the boundary
  // must name the preserved entries BY UUID (the pinned `preserved_messages` relink), and uuids are
  // minted inside the store layer -- the engine has no way to name them. See dialect.ts's own
  // implementation for how the writer identifies them from its own append log.
  //
  // RETURNS the minted uuids (fix round 1, M3): the emitted frame's `preserved_messages` can only be
  // built from them, and they exist nowhere else -- the engine cannot mint them. A store predating
  // this returns nothing, and the frame then simply omits the field.
  recordCompactBoundary?(record: CompactBoundaryRecord): CompactBoundaryWriteResult | void | Promise<CompactBoundaryWriteResult | void>;
}

export interface EngineOptions {
  config: RuntimeConfig;
  input: FrameSource;
  output: FrameSink;
  provider: Provider;
  // Task 1 (P3, WS-06 §1): now OPTIONAL -- WRAP, don't rewrite dispatch (both `tools.execute(...)`
  // call sites below are byte-for-byte unchanged). A caller that supplies its own ToolExecutor
  // (every one of this engine's ~1272 pre-existing tests, runtime.ts) gets EXACTLY the same behavior
  // as before this task, unconditionally -- the registry is never even imported by those paths' own
  // reasoning, let alone consulted. Omitting `tools` is what makes the registry "live behind the
  // engine seam": runEngine builds a registry-backed ToolExecutor internally (see
  // `buildDefaultToolExecutor` below) from THIS run's own PolicyState/cwd/readState/tempDir -- state
  // only reachable from inside this closure, which is why the adapter cannot be built by a caller
  // like testing.ts and merely passed in.
  //
  // Fix round 1 (RULING P3-C): main.ts is no longer in the "supplies its own ToolExecutor" list
  // above -- it now omits `tools` too, and supplies `unregisteredToolExecutor` instead (below).
  tools?: ToolExecutor;
  // Fix round 1 (RULING P3-C): main.ts's own fallback for a tool name with NO registered descriptor
  // at all -- the pre-existing scripted test doubles ("test_tool"/"mystery_tool"/"long_task") have no
  // WS-06 entry and never will, so they need to keep echoing exactly as stubExecutor always has, even
  // though main.ts now dispatches through the registry by default. Ignored entirely when `tools` is
  // explicitly supplied (this run never calls `buildDefaultToolExecutor` at all in that case); has no
  // effect on a REGISTERED-but-executor-less name (a genuine WS-06 stub still reports its own typed
  // not-yet-executable error -- see registry.ts's buildRegistryToolExecutorWithFallback for exactly
  // which case triggers this fallback and which doesn't).
  unregisteredToolExecutor?: ToolExecutor;
  store?: SessionPersistence;
  // Task 9 (WS-05 §7): the resumed/continued/forked conversation's prior turns, already rebuilt
  // into this engine's own ProviderMessage shapes by the store layer (dialect.ts's
  // resolveEngineSession, via resume.ts's rebuildProviderMessages) — seeded into `messages` before
  // the turn loop starts, so the FIRST provider.generate() call of this run already sees the
  // resumed history exactly as if the conversation had never left memory. Omitted (or empty) for a
  // fresh, non-resumed session — byte-identical to pre-Task-9 behavior.
  //
  // engine.ts cannot resolve this itself: dialect.ts already imports types from this module, so the
  // reverse import (this module reading SessionStore/resume.ts) would be circular. Resolution
  // happens once, before runEngine is even called, at the two call sites that already own store
  // construction (main.ts, testing.ts) — Ruling P1-B's storage-agnostic engine holds exactly as
  // before; it just gains one more plain-data input.
  initialMessages?: ProviderMessage[];
  // Task 11 (WS-07 §9): where a `defer` decision parks (record/respond/pendingFor/revalidate/...)
  // and where this run's own resume-consumption step (below) looks for a matching allowed/denied/
  // expired/cancelled record to fold back into a deferred marker it finds in `initialMessages`.
  // Passed as a CONCRETE value-level interface (like `provider`/`tools`), not routed through the
  // storage-agnostic `SessionPersistence` seam: unlike recordPermissionUpdate/recordHookAudit (pure
  // auxiliary write sinks with no read/query surface a caller here would ever need back),
  // DurableApprovalStore's own methods (pendingFor/get/revalidate/respond) are things THIS
  // function's own resume-consumption logic actively calls, and `permissions/approvals.ts` has no
  // dependency on this module — no circularity concern the way dialect.ts's own SessionPersistence
  // indirection exists to avoid. Constructed by dialect.ts's resolveEngineSession (it already
  // resolves winterHome/projectKey/sessionId) and threaded here by main.ts/testing.ts exactly like
  // `store`/`initialMessages` already are. Omitted (or a non-persistent session) means no durable
  // approval store exists — see this task's report for what a `defer` does in that case.
  approvalStore?: DurableApprovalStore;
  // Task 12 (WS-07 §10.5): the SAME precedent as `approvalStore` immediately above, for the auto-
  // mode 3-consecutive/20-total fallback counters — constructed by dialect.ts's resolveEngineSession
  // against the identical (winterHome, projectKey, sessionId) triple. Omitted (or a non-persistent
  // session) falls back to an in-memory AutoCounterStore (createAutoEngine's own call site below) —
  // the fallback still counts correctly for the life of THIS process, it just does not survive a
  // restart, exactly as WS-07 §10.5 says a non-persistent session need not.
  autoStateStore?: AutoCounterStore;
  // Phase 4 Task 3 (WS-09 §2/§7/§8.1): the environment the MCP/Tool-Search unbranded env controls
  // (ENABLE_TOOL_SEARCH et al.) are parsed from -- defaults to the real `process.env` (main.ts's own
  // production posture) but a caller (a test) may inject a controlled snapshot, mirroring
  // dialect.ts's own resolveEngineSession `env` parameter precedent ("every caller states explicitly
  // which environment governs" env-derived resolution) one level up.
  env?: Record<string, string | undefined>;
  // Phase 4 Task 3 (RULING P4-A): the "provider predicate seam defaulting per the catalog carry" the
  // brief names -- WS-13's own provider capability catalog (which surface would compute this for
  // real, per WS-09 §8.1's "Winter models these as provider-capability predicates in the catalog")
  // does not exist yet at this phase. Defaults to `true` (assume Tool Search is supported) when
  // omitted -- CAPTURE-PENDING (R4-8 class, same posture as mcp/env.ts's own documented gaps):
  // recorded as a concern in this task's own report, one line to correct once a real catalog exists.
  providerSupportsToolSearch?: boolean;
  // Phase 4 Task 3 (RULING P4-A): "the deferrable-context share" the brief names -- a real
  // computation needs an actual token-counting pass against the live provider's own context window
  // (WS-13/provider-layer scope, not this spine task's). Defaults to `0` (percent) when omitted --
  // the SAFE, conservative default: `auto`/`unset` activation never crosses the 10% threshold on a
  // fabricated number, so Tool Search activation stays off until a real share computation exists,
  // rather than silently deferring tools based on an invented figure. CAPTURE-PENDING, same class as
  // `providerSupportsToolSearch` above.
  deferrableContextShare?: number;
  // Phase 4 Task 3 (WS-09 §2.1/§3): the live MCP server connection-state source -- populates
  // `system/init.mcp_servers` and answers the `mcp_status` control subtype. Absent for every session
  // with no MCP servers configured at all, and for every session before Lane A's own real transports
  // exist -- `mcp_servers` is then omitted from both init frames entirely (conditional presence,
  // never an unconditional `[]`), keeping every pre-existing differential golden byte-identical.
  mcpServerStateSource?: McpServerStateSource;
  // Phase 4 Task 3 (WS-09 §3): the live MCP server MUTATION seam (reconnect/toggle/setServers) --
  // Lane A's own real implementation; a fake for this task's own contract tests. Absent means the
  // three mutating subtypes answer a structured `mcp_unavailable` error (the subtype IS recognized;
  // it just has nothing to dispatch to yet) rather than the pump's generic `unknown_subtype`.
  mcpControlSeam?: McpControlSeam;
  // Phase 5 Task 2 (R5-3): this run's context accounting. Caller-supplied always wins (the same
  // "I own this stack" precedence `mcpServerStateSource`/`mcpControlSeam` above already have);
  // otherwise the engine builds one from `config.contextWindowTokens` (absent = the disclosed
  // 200000 default). Task 3/Lane K are the consumers -- the engine itself only RECORDS into it.
  contextAccountant?: ContextAccountant;
  // Phase 4 Task 3 (MUST 8): called ONCE, synchronously, near the start of the run, handing the
  // caller a live getter over this run's own child roster -- the ONE exposure point
  // MessagingRouterSeam.children() (messaging/adapter.ts) is meant to be built from. No routing
  // logic lives in the engine; this is purely "here is where the children actually are."
  onChildRosterReady?: (getChildren: () => readonly ChildHandle[]) => void;
  // NEW-3 (P4 residual round): the same shape as `onChildRosterReady` above, over the set of
  // still-running FOREGROUND children an interrupt must take down (fix wave I5). Its own exposure
  // point, because the invariant it carries -- entries are removed when the child SETTLES, not only
  // when an interrupt clears the whole set -- has no other observable: a settled child's `stop()` is
  // a no-op, so a stale entry is invisible right up until a long-lived session has accumulated one
  // per foreground spawn.
  onForegroundChildrenReady?: (getForeground: () => readonly ChildHandle[]) => void;
  // --- Phase 5 Task 3: the lane seams ------------------------------------------------------------
  //
  // All five follow the `mcpServerStateSource`/`contextAccountant` precedent exactly: an optional
  // injection point, absent by default, whose absence reproduces pre-P5 behaviour byte-for-byte.
  // The seams are INERT until a lane (or T8's production wiring) supplies a real implementation --
  // which is what lets four lanes build against a frozen engine without touching this file.

  /**
   * R5-16: prompt assembly (Lane C). Called once per user envelope; its `system` goes on the live
   * `ProviderRequest`, its `userContextBlocks` are prepended to that envelope's own user message on
   * the request only. ABSENT => the engine sends `agentSystemPrompt` (or nothing) and authors no
   * text of its own -- see context/seam.ts.
   */
  systemPromptAssembler?: SystemPromptAssembler;
  /**
   * R5-3 / P4-J retirement: the child persona a subagent runs with (`AgentDefinition.prompt`
   * composed over any inherited base). Reaches the assembler as `SystemPromptInput.agentPrompt`, and
   * IS the system prompt when no assembler is registered. Set by subagents/child-engine.ts; never by
   * a top-level host.
   */
  agentSystemPrompt?: string;
  /**
   * R5-14: slash-command resolution (Lane S owns the filesystem half; the engine owns the built-ins
   * and the ordering between them). Consulted BEFORE the model sees a prompt. ABSENT => only the
   * built-ins resolve and every other prompt passes through verbatim.
   */
  commandResolver?: CommandResolver;
  /**
   * R5-4: the compaction vehicle (Lane K). Consulted before every provider call of a turn (the AUTO
   * trigger) and by `/compact` (the MANUAL one). ABSENT => no auto-compaction happens and `/compact`
   * says so -- the engine never summarizes on its own.
   */
  compactionController?: CompactionController;
  /**
   * R5-10: structured output (Lane K). REQUIRED for `config.outputFormat` to do anything -- the
   * engine registers the host-generated `StructuredOutput` descriptor this seam builds and validates
   * every call through it. `outputFormat` set with NO seam is reported as a configuration error on
   * the first turn rather than silently ignored: a session that believes it will get a structured
   * result and instead gets prose has no way to tell that from a model failure.
   */
  structuredOutput?: StructuredOutputSeam;
  /**
   * R5-11: file checkpointing (Lane K). Consulted before every Write/Edit/NotebookEdit when
   * `config.enableFileCheckpointing` is on, and by the `rewind_files` control request. ABSENT with
   * checkpointing enabled means nothing is backed up and `rewind_files` answers `canRewind: false` --
   * never a throw, and never a silent "success" that restores nothing.
   */
  fileCheckpointSink?: FileCheckpointSink;

  // --- Phase 5 Task 8: the production-wiring inputs ----------------------------------------------
  //
  // Every field below is plain data resolved ONCE PER SESSION by `production-wiring.ts` (the shared
  // helper both entrypoints call, so all three transport legs derive from one piece of code) and
  // handed here because the engine is where it is consumed. None of them can be resolved inside this
  // closure: they need `resolveSettings` (async, and needed before the run starts), the plugin
  // loader, and the skill index -- all of which several other consumers share.
  //
  // ABSENT reproduces pre-P5 behaviour byte-for-byte, exactly like the five seams above.

  /**
   * The resolved `~/.winter` root for THIS session (`config.winterHome ?? resolveWinterHome(env)`).
   * Passed rather than re-derived so this file and `store/dialect.ts` can never disagree about where
   * a session lives -- and because `dialect.ts` imports types from this module, so the reverse import
   * would be circular. Consumed by the workflow session registration below.
   */
  winterHome?: string;
  /**
   * Hook entries from SETTINGS FILES and PLUGIN MANIFESTS, already parsed by
   * `buildHookEntriesFromSettings` (the one parser for that block shape). Concatenated with this
   * session's own `config.hooks` entries; the WHOLE array feeds both `buildHookRegistry` (which
   * applies the workspace-trust filter) and `createCommandHookInvoker` (which dispatches
   * `{type:"command"}` entries BY ID -- so it must be built from the same array, or an id will not
   * be found).
   */
  extraHookEntries?: readonly SourcedHookEntry[];
  /**
   * MCP server sources beyond the host's own `config.mcpServers`: the settings tiers,
   * `.winter/mcp.json`, and plugin manifests. Appended AFTER the explicit source, so an explicitly
   * configured server still wins; `resolveMcpServerSources` owns precedence, duplicate names, the
   * reserved `winter` name and the project-origin trust gate, exactly as before.
   *
   * "PROJECT-ORIGIN", NOT "STDIO" (rd-1, residual round 2). P4's gate was stdio-literal because
   * process execution was the visible danger; RULING P5-K widened it to every transport, and
   * `lifecycle.ts`'s own header has said so since. This sentence kept the old name -- a stale
   * summary of a rule that had moved, which is exactly how a reader concludes an http server from a
   * clone connects freely.
   */
  extraMcpServerSources?: readonly McpServerSource[];
  /**
   * `system/init.slash_commands`. Produced by `slashCommandNames(resolver, cwd)`, which ALREADY
   * includes the engine's own `/compact` -- the engine must not prepend it a second time.
   */
  initSlashCommands?: readonly string[];
  /** `system/init.skills` -- this session's EFFECTIVE set (the `skills` filter applied), not the whole index. */
  initSkills?: readonly string[];
  /** `system/init.plugins` -- `pluginInitInfo(bundles)`, with resolved absolute paths. */
  initPlugins?: readonly InitPluginInfo[];
  /** `system/init.output_style` -- the CONFIGURED name (`config.outputStyle ?? settings.outputStyle ?? "default"`). */
  initOutputStyle?: string;
  /**
   * The POST-TRUNCATION model-facing skill listing (R5-17). Lane S produces it; Lane C's assembler
   * places it; neither re-derives the other's caps.
   *
   * The engine's own contribution is the one thing neither lane can see: it withholds the listing
   * whenever `Skill` is NOT in this session's advertised set. Lane C's NEEDS_CONTEXT 3 named that
   * gap exactly -- a listing tells the model to "call the `Skill` tool", and a session with a
   * restricted `tools` list would be instructed to call a tool it does not have. `Skill` is in the
   * pinned default 24 (capture (g)), so the default path is unaffected.
   */
  skillListing?: SkillListing;
  /**
   * Phase 5 fix wave, C1: the settings-file `permissions` block, per tier.
   *
   * Before this the engine seeded its rule set from `config.{allowedTools,disallowedTools,permissions}`
   * ALONE, so the only `project`/`local`/`user`-sourced entry a live session could hold came from a
   * `canUseTool` answer carrying `addRules`. A `deny` in `~/.winter/settings.json` was silently not a
   * deny; the whole P5-A/P5-D trust matrix guarded a path a settings file never entered.
   *
   * PLAIN DATA, resolved once by `production-wiring.ts` (both entrypoints), so a spawned or compiled
   * child gets the identical seed. Folded into `initialRules` AFTER the managed baseline denies and
   * BEFORE the `sdk` entries -- which is the pinned precedence: managed floor, then files
   * (`perSource`'s own highest-first order), then the host's own `Options`.
   */
  settingsRules?: EngineSettingsRuleSeed;
  /**
   * Phase 6 Task 3 (P1 carry): the per-message input byte cap on provider input, overridable for
   * tests and for a host that knows its own provider's real limit.
   *
   * An ENGINE OPTION rather than a `RuntimeConfig`/`Options` field, deliberately and disclosed: the
   * default is a Winter-authored safety bound with no pinned counterpart, and adding an `Options`
   * field would put an un-pinned knob on the public compatibility surface for a value no host has
   * asked to tune. Absent -> `DEFAULT_MAX_PROVIDER_MESSAGE_BYTES`.
   */
  maxProviderMessageBytes?: number;
  /**
   * Phase 6 Task 3 (R6-9): the session's RESOLVED provider identity.
   *
   * The one input that makes the write-ahead sidecar path live: with no identity there is nothing to
   * name in an `origin` record, so `recordAssistant` writes none and the session behaves exactly as
   * it did before this phase. `provider/selection.ts` produces this and T10's wiring passes it in --
   * an ENGINE OPTION rather than something the engine resolves itself, for the same reason the
   * provider is (the engine must stay driveable by a plain double).
   */
  providerIdentity?: {
    providerId: string;
    modelKey: string;
    family: string;
    continuationDomain?: string;
    // WIDENED in review round 1 (I1). The `MessageOrigin`-shaped version could not carry the catalog
    // and credential half of R6-9's identity, so `setProviderIdentity` -- declared, implemented and
    // unit-tested -- had NO production caller and no session ever wrote an identity block. Optional,
    // so every existing caller is unaffected and a caller that knows only the origin still writes the
    // block that the resume side reads.
    adapterId?: string;
    adapterVersion?: string;
    catalogVersion?: string;
    authRefKind?: string;
  };
  /**
   * Phase 6 Task 10: the pinned `system/init.apiKeySource` (`sdk.d.ts:4860`, REQUIRED).
   *
   * An ENGINE OPTION rather than something derived here, for the same reason `providerIdentity` is:
   * the mapping from Winter's own `CredentialRef` kinds onto the pin's four-member vocabulary is the
   * WIRING's decision (`provider/session-provider.ts`'s `apiKeySourceFor`, which documents why every
   * non-`ANTHROPIC_API_KEY` shape reports `'none'`), and the engine must stay driveable by a plain
   * double that has no credential model at all.
   *
   * Absent -> `"none"`, which is the honest value for a session with no credential ref and is what
   * every pre-P6 golden's init frame is regenerated against.
   */
  apiKeySource?: string;
  /**
   * Phase 6 Task 10 (R6-I): the session's model catalogue and account surface, as the control
   * handlers below answer them.
   *
   * BOTH ARE FUNCTIONS, not values, and both come from the WIRING rather than being computed here:
   * the engine has no registry and no credential model, and giving it one would be a second
   * resolution path that could disagree with the session's own.
   *
   * `supportedModels` answers the pinned payload-free `list_models` control request
   * (`sdk.d.ts:3855`), whose own JSDoc frames it as "ask the worker" — a table inside the binary, per
   * capture (J), never a `/v1/models` fetch. Absent -> the handler answers an empty array, which is
   * the honest answer for a session running a scripted double.
   */
  supportedModels?: () => unknown[];
  /**
   * `account_info` is a WINTER-ONLY control subtype, disclosed.
   *
   * The pin carries `AccountInfo` on the `initialize`/`reinitialize` RESPONSE (`sdk.d.ts:3804`), and
   * derived-shapes-p6 item (d) is explicit that `system/init` must NOT grow an `account` field for
   * parity. Winter's protocol has no `initialize` control request to hang it on, so the surface it
   * does expose (`Query.accountInfo()`) needs a subtype of its own rather than a field on a frame the
   * pin does not put it on.
   */
  accountInfo?: () => unknown;
  /**
   * Phase 6 Task 10 (R6-14): the session's REAL classifier, or absent for a Manual fallback.
   *
   * P2 shipped `createAutoEngine`'s own `alwaysNoVerdictClassifier` default and said the real
   * model-routed classifier was P6's job. This is that wire. ABSENCE IS MEANINGFUL and is not the
   * same as a classifier that abstains: R6-14's Manual fallback is a session that was never given a
   * reviewer it had evidence for, and `selectClassifierRoute` records WHY.
   */
  classifier?: ClassifierInterface;
}

/**
 * The settings seed as the ENGINE consumes it -- named and exported by the residual round (NEW-4)
 * because a CHILD engine needs the identical value and the chain that carries it
 * (`production-wiring.ts` -> `register-default-factory.ts` -> `child-engine.ts`) would otherwise
 * have re-declared this shape three more times. `production-wiring.ts`'s `SettingsRuleSeed` is the
 * producer's view (mutable arrays plus its own `warnings`); this is the consumer's.
 */
export interface EngineSettingsRuleSeed {
  entries: readonly SourcedRuleEntry[];
  directories: ReadonlyArray<{ path: string; source: RuleSource }>;
  defaultMode?: string;
  disableBypassPermissionsMode?: boolean;
}

type RaceOutcome<T> = { kind: "ok"; value: T } | { kind: "interrupted" };

// Races `p` against the current turn's interrupt signal. `p` is given a no-op catch so that if it
// is abandoned (interrupted) and later settles anyway, that settlement never surfaces as an
// unhandled rejection — Provider/ToolExecutor take no AbortSignal at P1, so "abort" here means
// "the engine stops waiting," not "the underlying call actually stops" (WS-04 §5).
function raceInterrupt<T>(p: Promise<T>, interrupted: Promise<void>): Promise<RaceOutcome<T>> {
  p.catch(() => {});
  return Promise.race([
    p.then((value): RaceOutcome<T> => ({ kind: "ok", value })),
    interrupted.then((): RaceOutcome<T> => ({ kind: "interrupted" })),
  ]);
}

/**
 * The turn engine (WS-04 §4.1 state machine: `initializing → idle → turn_active → draining →
 * closing`). A "turn" is one user envelope through its terminal result; a "tool round" is one
 * provider tool_use → execute → results-appended → provider-again cycle. Always terminates when
 * input ends (stdin EOF or an explicit `end_input` control request) — the P0 dangling-loop bug
 * class is structurally impossible here, though the SHAPE of that guarantee inverted under Ruling
 * P2-B: `end_input` no longer ends the pump's own read (it only ends `userFrames`, so a runtime-
 * originated permission RPC arriving after end_input can still be answered) — engine completion now
 * explicitly cancels the pump instead, once the turn loop has fully drained. See the pump's own
 * definition further down for the full re-argued termination guarantee.
 */
// --- The managed product floor (WS-07 §3.2) ------------------------------------------------------
//
// Lifted out of `runEngine` (fix wave follow-up 6/7) so a test can drive the EXACT entries production
// seeds, against a synthetic `home`, instead of re-typing them -- the alternative is a second copy of
// a security-relevant list, which is the drift class R4-2 exists to catch. Nothing here closes over
// run state; it never did.
//
// `source: "managed"` is what makes these bind under `bypassPermissions` too: stage 2's deny lookup
// runs before stage 4's bypass auto-allow, and `allowManagedPermissionRulesOnly` narrows the pool to
// exactly this source rather than dropping it.
export function buildBaselineDenyRules(resolvedWinterHome?: string): SourcedRuleEntry[] {
  // --- Phase 5 fix wave, I1: the floors follow the RESOLVED winter home --------------------------
  //
  // Every entry below is written `~/.winter/...`, and `~` resolves through `permissionHome =
  // homedir()` (permissions/paths.ts). The checkpoint SINK resolves its root with
  // `resolveWinterHome(env)` and `workflows/store.ts` persists under `<winterHome>/projects/...` --
  // so under a `WINTER_HOME` whose basename is not `.winter`, the fences and the things they exist to
  // fence pointed at DIFFERENT directories, and the M13 transcript floor and the rider-25 backups
  // floor were both silently absent in a documented, common configuration.
  //
  // ADDED, NEVER SWAPPED. The `~/.winter/...` entries stay exactly as they were: the user tier, the
  // carried seatbelt corpus and every default-home session still assume the literal default, and a
  // swap would unprotect all of them to protect one. A resolved root that IS the default emits no
  // duplicate (the two anchors coincide and the dedupe below drops the second).
  const absolute: SourcedRuleEntry[] = [];
  if (resolvedWinterHome !== undefined && resolve(resolvedWinterHome) !== resolve(join(homedir(), ".winter"))) {
    // `//`-ANCHORED, not a bare absolute path. WS-07 §3.1's own grammar (permissions/paths.ts's
    // `resolveAnchor`) reads a SINGLE leading `/` as "relative to the rule's own settings-file
    // directory", which is `undefined` for an engine-seeded rule and therefore makes the whole rule
    // INERT -- silently. `//` is the filesystem-root anchor. Found by the fixture: the rule list was
    // right and nothing was denied.
    const root = `/${resolve(resolvedWinterHome)}`;
    for (const dir of ["run"]) {
      for (const tool of ["Read", "Glob", "Grep"]) {
        absolute.push(sourceRule({ toolName: tool, ruleContent: `${root}/${dir}` }, "deny", "managed"));
        absolute.push(sourceRule({ toolName: tool, ruleContent: `${root}/${dir}/**` }, "deny", "managed"));
      }
    }
    for (const dir of ["projects", "backups"]) {
      for (const tool of ["Write", "Edit", "NotebookEdit"]) {
        absolute.push(sourceRule({ toolName: tool, ruleContent: `${root}/${dir}` }, "deny", "managed"));
        absolute.push(sourceRule({ toolName: tool, ruleContent: `${root}/${dir}/**` }, "deny", "managed"));
      }
    }
    // Phase 6 Task 3 (R6-7's P4-M MUST): the resolved-root twin of the provider-state read deny
    // below. Same reason every absolute rule in this block exists -- the floors follow the RESOLVED
    // winter root, or they protect a directory that does not exist while the real one stays open.
    for (const tool of PROVIDER_STATE_DENY_TOOLS) {
      for (const pattern of providerStateDenyPatterns(`${root}/projects`)) {
        absolute.push(sourceRule({ toolName: tool, ruleContent: pattern }, "deny", "managed"));
      }
    }
  }
  return [
    ...absolute,
    // The daemon's own runtime directory -- sockets, pidfiles, credentials-adjacent state.
    sourceRule({ toolName: "Read", ruleContent: "~/.winter/run" }, "deny", "managed"),
    sourceRule({ toolName: "Read", ruleContent: "~/.winter/run/**" }, "deny", "managed"),
    sourceRule({ toolName: "Glob", ruleContent: "~/.winter/run" }, "deny", "managed"),
    sourceRule({ toolName: "Glob", ruleContent: "~/.winter/run/**" }, "deny", "managed"),
    sourceRule({ toolName: "Grep", ruleContent: "~/.winter/run" }, "deny", "managed"),
    sourceRule({ toolName: "Grep", ruleContent: "~/.winter/run/**" }, "deny", "managed"),

    // --- Whole-branch review M13 (fix wave follow-up item 7): durable session state is READ-ONLY ---
    //
    // `~/.winter/projects/**` holds every session's own durable history: the JSONL transcript a
    // session and each of its children resume from, the `.meta.json` roster sidecars, and the
    // provider-state sidecars. `permissions/protected.ts` already protects `.winter/**` WRITES in
    // prompting modes -- but `resolveProtectedWrite` returns `allow` under `bypassPermissions` (WS-07
    // §6.7's matrix, verbatim), and WS-07 §11 FORCES bypass on every descendant of a bypass parent.
    // So a forced-bypass child could rewrite the very transcript its own `resume()` rebuilds from,
    // injecting turns into durable history, and `tools/impl/agent.ts`'s `.output` stub hands the
    // model that exact absolute path with "Read that file directly". A managed deny binds where the
    // protected-write check does not.
    //
    // WRITE-SIDE ONLY, deliberately, and this is the load-bearing scoping decision: the `.output`
    // stub path is a MODEL-FACING contract (Lane C's M1 fix, WS-12 §7.2 "return the durable
    // transcript path through the tool result"), so denying READS here would regress a shipped
    // behaviour to close a write hole. `Read`/`Glob`/`Grep` on `~/.winter/projects/**` therefore stay
    // allowed, and a test pins that they do.
    //
    // "Read/Glob/Grep stay allowed", NOT "reads stay allowed" (NEW-7): a Bash `cp`/`mv` naming a
    // protected path as its SOURCE is denied too, because `recognizeEditOperation` reports every
    // operand of a blessed fs-op as a write-path candidate and cannot tell a source from a
    // destination. Erring strict is right -- the same command with its operands swapped IS a write --
    // but it is a deliberate consequence, pinned in baseline-projects-deny.test.ts rather than left
    // to be discovered. A plain `cat` of the same file is unaffected, which is what actually keeps
    // the `.output` stub's contract alive.
    //
    // Bash-shaped writes to the same paths are covered too, through `findFileDenyBlockingEdit`
    // (evaluator.ts), which extends the pre-existing "a Read deny also blocks Edit/Write on the same
    // path" rule (WS-07 §3.1) to the whole FILE_RULE_TOOLS write family -- otherwise
    // `echo x >> ~/.winter/projects/.../agent-1.jsonl` would walk straight past a `Write` deny.
    //
    // Two entries per tool for the same reason as `~/.winter/run` above: the bare pattern covers the
    // directory itself, `/**` covers its contents.
    sourceRule({ toolName: "Write", ruleContent: "~/.winter/projects" }, "deny", "managed"),
    sourceRule({ toolName: "Write", ruleContent: "~/.winter/projects/**" }, "deny", "managed"),
    sourceRule({ toolName: "Edit", ruleContent: "~/.winter/projects" }, "deny", "managed"),
    sourceRule({ toolName: "Edit", ruleContent: "~/.winter/projects/**" }, "deny", "managed"),
    sourceRule({ toolName: "NotebookEdit", ruleContent: "~/.winter/projects" }, "deny", "managed"),
    sourceRule({ toolName: "NotebookEdit", ruleContent: "~/.winter/projects/**" }, "deny", "managed"),

    // --- Phase 5 Task 8 rider 25 (SECURITY): the checkpoint BACKUP STORE is write-denied too ------
    //
    // `~/.winter/backups/<session>/` holds the pre-image bytes a `rewind_files` writes back over the
    // user's own files, plus the `index.jsonl` that says WHICH files those bytes go to. Both halves
    // are attacker-useful: writing the index names an arbitrary path for the next rewind to write or
    // DELETE; writing a blob chooses the bytes that land on a path the session legitimately tracked.
    //
    // The M13 reasoning applies verbatim -- `permissions/protected.ts` protects `.winter/**` writes,
    // but `resolveProtectedWrite` returns `allow` under `bypassPermissions` (WS-07 §6.7's matrix) and
    // WS-07 §11 FORCES bypass on every descendant of a bypass parent -- plus one this block does not
    // have: `protected.ts` matches the literal directory NAME `.winter`, so a `WINTER_HOME` pointing
    // at a differently-named root was never covered there at all. A `managed` deny binds where the
    // protected-write check does not, because stage 2's deny lookup runs before stage 4's bypass
    // auto-allow, and `findFileDenyBlockingEdit` extends it to Bash-shaped writes.
    //
    // WRITE-SIDE ONLY, for M13's own stated reason: reads on `~/.winter` are otherwise unrestricted
    // (the sole baseline read denial is `~/.winter/run`), and a backup blob is a copy of a file the
    // model could already read in place -- denying reads would buy nothing and regress nothing.
    // `checkpoint/rewind.ts` carries the complementary half: a record naming a path outside the
    // session's own writable roots is refused even if the index says otherwise.
    sourceRule({ toolName: "Write", ruleContent: "~/.winter/backups" }, "deny", "managed"),
    sourceRule({ toolName: "Write", ruleContent: "~/.winter/backups/**" }, "deny", "managed"),
    sourceRule({ toolName: "Edit", ruleContent: "~/.winter/backups" }, "deny", "managed"),
    sourceRule({ toolName: "Edit", ruleContent: "~/.winter/backups/**" }, "deny", "managed"),
    sourceRule({ toolName: "NotebookEdit", ruleContent: "~/.winter/backups" }, "deny", "managed"),
    sourceRule({ toolName: "NotebookEdit", ruleContent: "~/.winter/backups/**" }, "deny", "managed"),

    // --- Phase 6 Task 3 (R6-7's P4-M MUST): the provider-state sidecars are READ-DENIED -----------
    //
    // These files are the ONLY sink for opaque provider continuation state -- `encrypted_content`,
    // thinking signatures, `thoughtSignature`, xAI opaque items. The whole architecture rests on that
    // state never being model-readable, and a model that can `Read` the sidecar reads back exactly
    // what its own transcript was structurally prevented from carrying.
    //
    // READ-SIDE, WHICH INVERTS M13's OWN SCOPING DECISION IMMEDIATELY ABOVE -- and the inversion is
    // the interesting part. M13 deliberately kept `Read`/`Glob`/`Grep` on `~/.winter/projects/**`
    // ALLOWED, because `tools/impl/agent.ts`'s `.output` stub hands the model a durable transcript
    // path with "Read that file directly", so a blanket read deny would regress a shipped
    // model-facing contract. That reasoning is untouched: this deny names the sidecar FILENAME, never
    // the tree. A transcript, a `.meta.json` roster sidecar and every other neighbour stay readable,
    // and provider-state-read-deny.test.ts pairs every denial with that positive control.
    //
    // The write side needs nothing new: the M13 block above already denies Write/Edit/NotebookEdit
    // across all of `~/.winter/projects/**`, which contains these files.
    ...PROVIDER_STATE_DENY_TOOLS.flatMap((tool) => providerStateDenyPatterns("~/.winter/projects").map((pattern) => sourceRule({ toolName: tool, ruleContent: pattern }, "deny", "managed"))),
  ];
}

/** The read tools the sidecar deny binds. Mirrors the `~/.winter/run` baseline's own trio -- the sole other baseline READ denial in this product. */
const PROVIDER_STATE_DENY_TOOLS = ["Read", "Glob", "Grep"] as const;

/**
 * The deny patterns for one projects root.
 *
 * TWO patterns, and both are needed. WS-07 §3.1's glob grammar (permissions/paths.ts) compiles `**`
 * to "cross directories" and `*` to "within one segment", so `<root>/**` + `/*.provider-state.jsonl`
 * matches a NESTED sidecar (`<root>/<projectKey>/sess-1.provider-state.jsonl`,
 * `<root>/<projectKey>/sess-1/subagents/agent-1.provider-state.jsonl`) -- but a `**` segment matches
 * ZERO OR MORE directories, so the direct-child form is covered by the same pattern. The second
 * pattern exists for the degenerate `<root>/x.provider-state.jsonl` shape a future layout change
 * could introduce; two overlapping denies cost nothing and a missing one is silent.
 */
function providerStateDenyPatterns(projectsRoot: string): string[] {
  return [`${projectsRoot}/**/*${PROVIDER_STATE_FILE_SUFFIX}`, `${projectsRoot}/*${PROVIDER_STATE_FILE_SUFFIX}`];
}

export async function runEngine(opts: EngineOptions): Promise<number> {
  // Task 1 (P3): `tools` renamed to `providedTools` at the destructuring site ONLY -- every existing
  // reference to the bare name `tools` further down this function (both `tools.execute(...)` call
  // sites) is deliberately left untouched; `const tools: ToolExecutor = providedTools ?? ...` is
  // declared once, below, right where its own dependencies (makeEvalCtx, cancelPendingApprovalsOn
  // ModeSwitch) already exist, so the two call sites shadow right back onto this new binding without
  // a single further textual change to either of them.
  const {
    config,
    input,
    output,
    provider,
    tools: providedTools,
    unregisteredToolExecutor,
    store,
    initialMessages,
    approvalStore,
    autoStateStore,
    env: engineEnv,
    providerSupportsToolSearch,
    deferrableContextShare,
    mcpServerStateSource,
    mcpControlSeam,
    contextAccountant: injectedContextAccountant,
    systemPromptAssembler,
    agentSystemPrompt,
    commandResolver,
    compactionController,
    structuredOutput,
    fileCheckpointSink,
    winterHome: wiredWinterHome,
    extraHookEntries,
    extraMcpServerSources,
    initSlashCommands,
    initSkills,
    initPlugins,
    initOutputStyle,
    skillListing,
    settingsRules,
    maxProviderMessageBytes,
    providerIdentity,
    apiKeySource,
    classifier,
    supportedModels,
    accountInfo,
  } = opts;

  // Task 6 (WS-07 §2/§6.4, Ruling 8): permission startup validation — deliberately the very FIRST
  // thing runEngine does, before any `await` and before the `init` frame is written. A throw here
  // (an unrecognized permissionMode, an invalid allowedTools/disallowedTools/permissions rule, or
  // selecting bypassPermissions without allowDangerouslySkipPermissions/against a managed
  // disableBypassPermissionsMode veto) takes the SAME "exited before init" path a pre-init
  // resolution failure already does (e.g. store/resume.ts's ResumeTargetError, via
  // testing.ts's/main.ts's own pre-runEngine try/catch) — never a parse failure, never a silently
  // wrong default.
  // C1: an explicit `config.permissionMode` still WINS -- a settings file supplies a DEFAULT, not an
  // override, and a host that asked for a mode must get it. The file's value has already been through
  // the pinned `filterEscalatingDefaultMode` in the wiring, so a repo-committed `bypassPermissions`
  // can never arrive here at all.
  const initialMode = assertKnownPermissionMode(config.permissionMode ?? settingsRules?.defaultMode);
  // Task 8 (P3 close-out, "Baseline read denial" MUST; WS-12 §2 / D6): the sole baseline read
  // denial -- `~/.winter/run` -- enforced at the TOOL-FENCE layer (the standing evaluator's own
  // Read-deny machinery, WS-07 §3.1), independent of whether a call ever reaches the OS sandbox at
  // all. This is the PERMISSIONS-layer half of D6's tool-surface parity; the sandbox-PROFILE half
  // (a `(deny file-read* (subpath "<home>/.winter/run"))` SBPL rule, enforced only for a SANDBOXED
  // Bash/Monitor child process) already landed in Lane C (sandbox/profile.ts's own `home` field,
  // threaded through spawn.ts) -- neither half substitutes for the other (WS-12 §1's own layer-
  // separation invariant): the tool-fence rule below is what stops a direct `Read`/`Glob`/`Grep` of
  // the path (no sandbox involved at all -- see the I1 correction a few lines down for the
  // NON-coverage of a "recognized-Bash-read" of the same path, which this sentence used to overclaim
  // was also stopped here), while the SBPL rule is what stops an UNRECOGNIZED subprocess (a
  // compiler, a language runtime, anything the model's own shell command spawns) from reading it
  // once inside the sandbox.
  //
  // `source: "managed"` -- an unconditional product floor, never weakened by a lower-priority
  // settings source (WS-07 §3.2: "Deny from any source beats allow from every source... Managed
  // rules cannot be weakened by CLI or lower settings").
  //
  // CORRECTION (fix wave, P3 close-out, I1 finding 3): the paragraph above overclaimed. The
  // tool-fence rule is a `Read`/`Glob`/`Grep`-toolName rule matched against each of those tools' own
  // PATH FIELD -- it does NOT stop a "recognized-Bash-read" of the identical path at all.
  // `Bash({command:"cat ~/.winter/run/pidfile"})` passes `isBashCallReadOnly` at stage 4 (allowed,
  // built-in read-only) and is never even a CANDIDATE for this rule set: `findReadDenyBlockingEdit`
  // (evaluator.ts) only ever consults WRITE-shaped candidates (`extractCandidateWritePaths`), never
  // a Bash call's own read-only recognition. With `sandbox.enabled: false` (no SBPL layer either)
  // nothing in this layered defense catches that read at all -- a genuine, config-shaped hole, not
  // merely an incomplete-but-safe comment. Fixed here only to the extent of naming it honestly;
  // closing it (extending `isBashCallReadOnly`'s own recognition to consult
  // `ctx.permissions.probeReadAccess` per read-shaped path, mirroring glob.ts/grep.ts's own I1 fix)
  // is out of this fix wave's scope and is ledgered as a named carry, not silently left mis-described.
  //
  // TWO entries, verified empirically to both
  // be necessary (not merely defensive): Ruling P2-D's "a bare `~`-anchored segment reaches any
  // depth on deny" special case (paths.ts's own `isSingleSegmentDirectoryPattern`) is scoped to a
  // pattern with EXACTLY ONE segment after the anchor (`~/secrets`, paths.test.ts's own fixture) --
  // `.winter/run` is TWO segments, so it does NOT qualify and instead compiles through the general,
  // exact-match-only glob path (a first draft of this fix used only the bare pattern and a RED test
  // caught it immediately: it matched the literal `~/.winter/run` path but NOT anything nested
  // beneath it, e.g. `~/.winter/run/core.sock`). The bare entry covers the path itself; `/**`
  // covers its contents (gitignore-style `dir/**` does not itself match bare `dir`) -- both are
  // required for full coverage, not redundant. The `~` anchor itself is resolved against `ctx.home`
  // at MATCH time (paths.ts), never baked in here, so this constant is correct regardless of which
  // OS user's home a given session actually resolves.
  // I1 (fix wave, P3 close-out): emitted for Read, Glob, AND Grep -- `matchesRuleForCall`
  // (evaluator.ts) requires an EXACT `rule.toolName === call.toolName` match for the FILE_RULE_TOOLS
  // pattern family (a `Read(...)` rule can never cover a `Grep`/`Glob` call "by extension" the way a
  // reader might assume from the shared bounds-check machinery) -- so the baseline denial must be
  // its own three entries, one per dedicated read tool, or a bare `Grep`/`Glob` allow rule (or
  // bypass) would leave `~/.winter/run` readable through either search tool even though `Read` on
  // the identical path is denied. Before this fix, Glob/Grep were not FILE_RULE_TOOLS members at
  // all, so this rule set never stopped a search-tool read of the same path -- one of two gaps this
  // header's own overclaimed "stops a direct Read/recognized-Bash-read" sentence covered up (the
  // OTHER gap -- "recognized-Bash-read" was never actually true -- is corrected in place above,
  // where that sentence lives).
  // I1: the same resolved root every other fence in this run uses. `wiredWinterHome` is what
  // `production-wiring.ts` computed (`config.winterHome ?? resolveWinterHome(env)`); the fallback
  // keeps a host that drives `runEngine` directly on exactly its pre-fix behaviour.
  const resolvedWinterHome = wiredWinterHome ?? config.winterHome;
  const BASELINE_DENY_RULES = buildBaselineDenyRules(resolvedWinterHome);
  // Task 5 (WS-07 §3.3 / phase ruling 1) seeding: Options.{allowedTools,disallowedTools,permissions}
  // become source:"sdk" rule entries via T5's own builder — this is the wiring T5's own header
  // called "not wired into the engine by this task (that is a later task's job)". Runs the SAME
  // add-time grammar validation every other rule source gets, so an invalid rule fails loud at
  // startup (PermissionRuleValidationError) rather than being silently inert at match time.
  const initialRules = {
    ...emptyRuleSet(),
    entries: [
      ...BASELINE_DENY_RULES,
      // C1: the settings FILES, in `perSource`'s own highest-precedence-first order. Between the
      // managed baseline above and the host's own `Options` below -- the pinned layering. Each entry
      // carries the TIER that asserted it, which is the whole input to the P5-A gate downstream
      // (`findMatchingRuleEntry` skips a project-sourced `allow` without `trustedWorkspace`); the
      // filter is implemented once, there, and never re-derived here.
      ...(settingsRules?.entries ?? []),
      ...buildSdkSourcedEntries({
        ...(config.allowedTools !== undefined ? { allowedTools: config.allowedTools } : {}),
        ...(config.disallowedTools !== undefined ? { disallowedTools: config.disallowedTools } : {}),
        ...(config.permissions !== undefined ? { permissions: config.permissions } : {}),
      }),
    ],
    // `permissions.additionalDirectories` from the files, tagged the same way -- `effectiveDirectories`
    // applies the identical project-tier gate to a directory GRANT that `resolveRules` applies to an
    // allow rule.
    directories: [...(settingsRules?.directories ?? [])],
  };
  const policyStateStore = new PolicyStateStore(
    { mode: initialMode, rules: initialRules },
    {
      allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions === true,
      // C1: WS-07 §6.4's veto binds from ANY tier, not only from `Options`. Restrictive, so no trust
      // question arises and `true` anywhere wins.
      disableBypassPermissionsMode: config.permissions?.disableBypassPermissionsMode === true || settingsRules?.disableBypassPermissionsMode === true,
    },
  );
  // Task 6: the resolved, fixed-at-startup home directory used for `~`-anchored file rules
  // (WS-07 §3.1). A plain `os.homedir()` read — no WINTER_HOME-style override exists for this at P2
  // (it is the invoking OS user's real home, exactly like every other tool would see it; tests that
  // need a synthetic home construct an EvaluationContext directly against evaluator.ts instead of
  // exercising this real value).
  const permissionHome = homedir();

  // Task 2 (WS-04 §3.1, direction inversion): the runtime's own half of the control-RPC envelope —
  // declared here (moved up from its original T2 spot, further down this function, so T8's
  // makeEvalCtx below can close over it) so it's reachable by the pump (which routes incoming
  // control_response frames to it), makeEvalCtx's real PromptStage (T8: permission RPCs), and the
  // round loop further down (rpc_probe). Exactly one bridge instance per run, built from the SAME
  // `output` every other runtime->host frame goes through — there is no second writer to race
  // against.
  const bridge = createRpcBridge(output);
  // Task 8: one stateless instance for the whole run — createBridgePromptStage's own closure only
  // ever reads `bridge` (constant for the run), so there is nothing to gain from rebuilding it on
  // every evaluate() call the way makeEvalCtx's own per-call PolicyState snapshot must be.
  const bridgePromptStage = createBridgePromptStage(bridge);
  // B-H1(c) point 1: a permission prompt is being shown to a human. Emitted BEFORE the request is
  // sent, not after it resolves -- the observer's whole use for this event is "something is waiting
  // on you", which is worthless once the wait is over.
  const realPromptStage: typeof bridgePromptStage = {
    async prompt(call, evalCtx, meta) {
      emitNotification("permission_prompt", `Permission requested for ${call.toolName}.`, "Permission required");
      return bridgePromptStage.prompt(call, evalCtx, meta);
    },
  };

  // Task 10 (WS-08 §1/§2/§10): the hooks engine's three shared, run-lifetime pieces — a registry
  // built ONCE from config.hooks (source:"sdk" groups only have a real producer at P2; filesystem
  // sources are typed-but-inert, phase ruling 1 — buildHookEntriesFromConfig is source-agnostic and
  // will pick those up for free the moment a P5 loader exists), the SAME bridge every other
  // runtime->host RPC uses, and an audit recorder that forwards to the store's optional
  // recordHookAudit (auxiliary — see recordHookAudit's own definition below, alongside
  // recordUser/recordAssistant/recordPermissionUpdate).
  // Finding 4 (P2 fix-wave): the SAME trust signal makeEvalCtx's own `trustedWorkspace` field
  // (below) already threads to the permission-rule side — declared once, here, so the hook registry
  // and the evaluation context can never independently drift on what "this session's workspace
  // trust" means.
  //
  // Phase 5 Task 2 (R5-6 -> RULING P5-A): this used to be a hard `false` with a comment promising
  // "P5 is the one that wires a real signal in, at both call sites" — this is that wiring, and it is
  // still ONE value feeding all four consumers (evaluator context, hook registry, MCP source
  // resolver, child-rule mirror). The signal is `RuntimeConfig.trustedWorkspace`, read through
  // settings/trust.ts's `defaultTrustSource` rather than inline, so the fail-closed default and the
  // "never inferred from settingSources" rule live in one testable place. Absent/false is
  // byte-identical to the P2 constant.
  //
  // What this is NOT: the pinned per-TIER filter on permissive rules (capture (1)). That lives in
  // the settings layer (`applyWorkspaceTrust`), never here — deriving it from this bit would leave
  // an untrusted repository's project-tier `deny` silently unenforced.
  const trustedWorkspace = defaultTrustSource(config).verdict(config.cwd).trusted;
  // Phase 5 Task 2 (R5-3): this run's context accounting. A CALLER-SUPPLIED accountant always wins
  // -- that is how Task 3's contract tests inject a fake, and how a host that owns cross-session
  // accounting (a daemon) hands one in; otherwise the engine builds its own from the session's own
  // `contextWindowTokens` (absent = the disclosed 200000 default, resolved here rather than on the
  // wire). Same precedence convention as `mcpServerStateSource`/`mcpControlSeam` below.
  const contextAccountant: ContextAccountant =
    injectedContextAccountant ?? createContextAccountant(config.contextWindowTokens !== undefined ? { limit: config.contextWindowTokens } : {});
  // Phase 5 Task 8 (rider 5 / T2's rider): `SourcedHookEntry.command` EXECUTES now (T3's
  // `createCommandHookInvoker`), so settings-file and plugin-manifest hook blocks are real behaviour
  // rather than typed-but-inert declarations. `production-wiring.ts` parses both through
  // `buildHookEntriesFromSettings` -- never a second parser, and never straight into a runner (T2's
  // divergence 8) -- and hands the entries here.
  //
  // ONE ARRAY, TWO CONSUMERS, and that is the load-bearing part. `buildHookRegistry` applies the
  // workspace-trust filter and the source ranking; `createCommandHookInvoker` builds `commandsById`
  // from the SAME entries. An invoker built from a different array than the registry would look up a
  // hook id the registry emitted and not find it, falling through to the host bridge -- a settings
  // hook that silently never runs.
  const allHookEntries: SourcedHookEntry[] = [...buildHookEntriesFromConfig(config.hooks), ...(extraHookEntries ?? [])];
  const hookRegistry = buildHookRegistry(allHookEntries, { trustedWorkspace });
  // The bridge invoker stays the fallback for every entry with no `command` (an SDK callback the
  // host answers), so a session with no command hooks behaves exactly as it did before this wiring.
  const bridgeHookInvoker: HookInvoker = createBridgeHookInvoker(bridge);
  const hookInvoker: HookInvoker = allHookEntries.some((e) => e.command !== undefined && e.command.length > 0)
    ? createCommandHookInvoker(allHookEntries, { next: bridgeHookInvoker, cwd: config.cwd, ...(engineEnv !== undefined ? { env: engineEnv } : {}) })
    : bridgeHookInvoker;
  // Auxiliary, exactly like recordUser/recordAssistant/recordPermissionUpdate further down (same
  // "a store failure never fails the turn or blocks the hook it accompanies" policy) — defined here
  // rather than alongside its siblings because hookAuditRecorder (right below) needs it before
  // makeEvalCtx is built. dialect.ts's withPermissionJournal is the one production implementation
  // (same journal file as recordPermissionUpdate, a distinguishable sibling line kind).
  const recordHookAudit = async (entry: HookAuditRecord): Promise<void> => {
    if (!store?.recordHookAudit) return;
    try {
      await store.recordHookAudit(entry);
    } catch {
      /* auxiliary — never fails the hook invocation it accompanies */
    }
  };
  const hookAuditRecorder: HookAuditRecorder = { record: recordHookAudit };

  // Task 10 (WS-08 §9 Amended / Ruling P2-A): the public lifecycle sink — ALWAYS constructed and
  // ALWAYS passed to every hooks call site below; the includeHookEvents GATE lives entirely inside
  // this closure (never at a call site), because the doc-asserted SessionStart/Setup exception
  // (derived-shapes-p2.md item (d): those two events' own hook_started/hook_progress/hook_response
  // messages emit UNCONDITIONALLY, regardless of the flag) needs to see every invocation's event
  // name to decide whether to honor the gate or bypass it — a call-site-level "only pass a sink when
  // the flag is on" design could never express that per-event exception. `hook_name` falls back to
  // "" for an unnamed hook (frames.ts's own SDKHookStartedMessage/SDKHookResponseMessage comment);
  // `stdout`/`stderr`/`output` are always "" (no SDK-callback hook has a concept of subprocess
  // stdio — those fields exist on the wire only for a future filesystem command-hook, P5).
  const includeHookEvents = config.includeHookEvents === true;
  function shouldEmitHookLifecycle(hookEvent: HookEvent): boolean {
    return includeHookEvents || hookEvent === "SessionStart" || hookEvent === "Setup";
  }
  const hookLifecycleSink = {
    started(info: { hookId: string; hookName?: string; hookEvent: HookEvent; sessionId: string }): void {
      if (!shouldEmitHookLifecycle(info.hookEvent)) return;
      output.write({
        type: "data",
        message: {
          type: "system",
          subtype: "hook_started",
          hook_id: info.hookId,
          hook_name: info.hookName ?? "",
          hook_event: info.hookEvent,
          session_id: info.sessionId,
          uuid: randomUUID(),
        },
      });
    },
    response(info: { hookId: string; hookName?: string; hookEvent: HookEvent; sessionId: string; outcome: "success" | "error" | "cancelled" }): void {
      if (!shouldEmitHookLifecycle(info.hookEvent)) return;
      output.write({
        type: "data",
        message: {
          type: "system",
          subtype: "hook_response",
          hook_id: info.hookId,
          hook_name: info.hookName ?? "",
          hook_event: info.hookEvent,
          output: "",
          stdout: "",
          stderr: "",
          outcome: info.outcome,
          session_id: info.sessionId,
          uuid: randomUUID(),
        },
      });
    },
  };

  // Task 6: builds a FRESH EvaluationContext — always reading policyStateStore.getState() at the
  // moment of the call, never cached — so every evaluate() call sees the live mode/rules/version.
  // `trustedWorkspace` (STALE COMMENT CORRECTED, Phase 5 Task 3): this was a hard-`false` constant
  // through P2-P4 and the comment here still said so. It is now the ONE value this run derives from
  // `WorkspaceTrustSource` (P5 Task 2, `defaultTrustSource(config)` above) and shares with all four
  // consumers -- this evaluation context, the hook registry, the MCP source resolver and the
  // child-rule mirror. The direction of the gate is also narrower than this comment claimed: per
  // RULING P5-D, only PROJECT-tier `allow`/`additionalDirectories` require trust; `local` and `user`
  // permissive rules widen without it, and deny/ask from every tier apply regardless (WS-07 §3.2 as
  // amended by P5-A).
  //
  // Task 7: `specialChecks` is now the REAL protected-path/critical-removal seam fill (T6's
  // NO_SPECIAL_CHECKS stub retired here — this is the one production call site; every other
  // reference to NO_SPECIAL_CHECKS left in the codebase is test-only). `sessionBypassEnabled`
  // threads the SAME `allowDangerouslySkipPermissions` flag PolicyStateStore's own bypass gate
  // (above) already checked at startup one level further, unchanged — WS-07 §6.4's "a session that
  // did not enable bypass at startup cannot casually switch into it later" fact, needed by plan
  // mode's own bypass-relaxation carve-out (§6.4/§6.5), which is a SESSION-scoped constant, not the
  // CURRENT policy.mode (a session can be bypass-enabled while sitting in `plan` right now).
  // `additionalDirectories` (Finding 6, P2 fix-wave): now threaded straight from
  // `config.additionalDirectories` — the RuntimeConfig/Options wire field this comment used to say
  // did not exist yet. `boundedRoots()` (evaluator.ts) already unions cwd + T5's rule-derived grants
  // (`effectiveDirectories(ctx.policy.rules, ...)`) + this field; real behavior lands for free
  // through every one of boundedRoots' existing consumers (acceptEdits/auto edit bounding,
  // critical-removal input, and Finding 7's Read-bounding fix, same wave) with no changes needed at
  // any of those call sites. Task 8: `promptStage` is now the
  // REAL bridge-backed implementation (T6's NO_OPINION_PROMPT_STAGE stub retired here — the one
  // production call site, exactly like T7 retired NO_SPECIAL_CHECKS above; every other reference
  // left in the codebase is test-only). Task 10: `hookStage` is now the REAL registry+bridge-backed
  // implementation (T6's NO_OPINION_HOOK_STAGE stub retired here — the one production call site;
  // every other reference left in the codebase is test-only) — stateless across calls (the registry
  // never changes mid-run; `runHooks` itself is what reads the live policy version fresh per
  // invocation via `ctx.policy.version` below), so it is built ONCE, outside this factory, unlike
  // the fresh-per-call EvaluationContext this factory itself produces. Task 12: `autoEngine` is now
  // the REAL createAutoEngine implementation (T6's NO_OPINION_AUTO_ENGINE stub retired here — the
  // one production call site; every other reference left in the codebase is test-only) — stateless
  // across calls (its own counters/cache live inside the closure below, session-scoped, exactly
  // like realHookStage's own registry), so it too is built ONCE, outside this factory.
  const realHookStage = createHookStage({
    registry: hookRegistry,
    invoker: hookInvoker,
    audit: hookAuditRecorder,
    sessionId: config.sessionId,
    lifecycle: hookLifecycleSink,
    // Phase 4 Task 3 (MUST 9): populated for a child engine's own hook runs (config.agentId is set
    // ONLY on a child's own RuntimeConfig, per that field's own comment), absent for the main
    // engine -- HookStageDeps.agentID already existed as a seam (createHookStage's own header) with
    // no production caller supplying it until now.
    ...(config.agentId !== undefined ? { agentID: config.agentId } : {}),
  });
  // Task 12 (WS-07 §10.4/§10.6-8): T9's PostToolUse-accumulated classifierContext, threaded to the
  // auto engine below. Appended to, never cleared, for the life of this run (reducer.ts's own
  // "accumulate unconditionally" posture) — see the PostToolUse call site further down for where
  // this actually gets pushed to.
  // Fix round 1: growth is UNBOUNDED today — harmless at P2 only because the ONE shipped classifier
  // (alwaysNoVerdictClassifier) never reads `context` at all; MUST be bounded before P6/D13 wires a
  // real classifier that actually consumes it (§10.4: "a BOUNDED portion").
  const accumulatedClassifierContext: AttributedContext[] = [];
  // Task 12 (WS-07 §10.5): P2 ships ONLY alwaysNoVerdictClassifier (createAutoEngine's own default
  // when `classifier` is omitted) — the real model-routed classifier is P6/D13's job. Audit
  // PERSISTENCE is intentionally NOT wired to any store yet: WS-07 §10.6-12 itself says "public-
  // stream variants are NOT P2's; the projector work is WS-15's" — the seam is real and fully
  // unit-tested (auto/engine.test.ts) but has no durable sink at P2, mirroring how this run's own
  // hookAuditRecorder ALSO simply drops everything when `store.recordHookAudit` is absent. Flagged
  // in this task's report as a deliberate, scoped deviation from full T11 parity (T11's approval
  // journal DOES have a durable sink; this audit trail does not, yet).
  const realAutoEngine = createAutoEngine({
    sessionId: config.sessionId,
    runtimeKind: WINTER_RUNTIME_KIND,
    counters: autoStateStore ?? createInMemoryAutoCounterStore(),
    audit: NO_OP_AUTO_AUDIT_RECORDER,
    getClassifierContext: () => accumulatedClassifierContext,
    // Phase 6 Task 10 (R6-14): the P2 counters go LIVE. Conditionally spread, so a session with a
    // Manual route keeps `createAutoEngine`'s own always-no-verdict default byte-identically --
    // which is the point of the distinction: "no reviewer we have evidence for" and "a reviewer that
    // abstained" are different session states and must stay separable in the audit.
    ...(classifier !== undefined ? { classifier } : {}),
  });
  // Task 1 (P3, WS-06 §1.1 ToolExecutionContext.session): the session posture-mutation seam's own
  // live state. `currentCwd` starts at `config.cwd` and `extraBoundedRoots` starts empty -- for
  // EVERY pre-existing caller (nothing before this task could ever mutate either one; the only
  // mutator is the `session` object handed to a REGISTRY-DISPATCHED tool call, below), both stay at
  // their starting values for the run's entire lifetime, so `makeEvalCtx`'s own cwd/
  // additionalDirectories fields below are byte-identical to before this task whenever neither is
  // ever touched -- which is always, for every one of this engine's ~1272 pre-existing tests (they
  // supply their own `tools` and never reach the registry's `session` seam at all).
  let currentCwd = config.cwd;
  const extraBoundedRoots: string[] = [];
  // RULING P3-L (fix wave, P3 close-out): the engine-owned session root -- see registry.ts's own
  // ToolExecutionContext.session.getSessionRoot doc comment for the exact contract. Starts at
  // `config.cwd`, exactly like `currentCwd`, but is moved ONLY by EnterWorktree/ExitWorktree
  // (tools/impl/{enter,exit}-worktree.ts), never by a plain `cd` (bash.ts's own cwd-carry).
  let sessionRoot = config.cwd;
  // Phase 4 Task 3 (MUST 5): the current session's own advertised tool pool (canonical names, eager
  // + deferred -- computed once the deferral partition exists, below) -- `buildChildInheritance`
  // closes over this BY REFERENCE (declared here, assigned later) exactly like `currentCwd`/
  // `sessionRoot` above: it is only ever READ when a real Agent-tool call actually spawns a child,
  // long after the assignment below has already run.
  let currentAdvertisedCanonicalNames: string[] = [];
  // --- Phase 6 Task 3: the session's live provider state ------------------------------------------
  //
  // `currentModel` is what goes on the REQUEST; `config.model` stays the pinned bare string the
  // caller passed and is what `system/init.model` reports (R6-9: the goldens byte-compare init), and
  // it is also the reset target for `set_model`'s three-way reset spelling.
  let currentModel = config.model;
  // The RESOLVED identity, once selection has run. `undefined` until then -- which is every pre-P6
  // session and every test double, and is why the sidecar writes nothing for them rather than
  // fabricating a provider name.
  let currentProviderIdentity: { providerId: string; modelKey: string; family: string; continuationDomain?: string } | undefined = providerIdentity;
  // Review round 1 (I1): THE PRODUCTION CALL. Without it `setProviderIdentity` was a fully
  // implemented, unit-tested seam that nothing invoked -- so no session wrote R6-9's identity fields
  // to its dialect record, and the resume side had no way to tell a DELETED sidecar from one that
  // never existed. Made once, at startup, because the identity is the session's and the writer
  // restamps it on every append of its own accord.
  if (providerIdentity !== undefined) {
    store?.setProviderIdentity?.({
      providerId: providerIdentity.providerId,
      modelKey: providerIdentity.modelKey,
      ...(providerIdentity.adapterId !== undefined ? { adapterId: providerIdentity.adapterId } : {}),
      ...(providerIdentity.adapterVersion !== undefined ? { adapterVersion: providerIdentity.adapterVersion } : {}),
      ...(providerIdentity.catalogVersion !== undefined ? { catalogVersion: providerIdentity.catalogVersion } : {}),
      ...(providerIdentity.authRefKind !== undefined ? { authRefKind: providerIdentity.authRefKind } : {}),
    });
  }
  // R6-I: a `set_model` arriving mid-turn is PARKED here and applied at the quiescent boundary. The
  // value is the request's own three-way payload, carried verbatim so the reset spelling is resolved
  // in exactly one place.
  let pendingModelSwitch: { model: string | null | undefined } | undefined;
  // Phase 4 Task 3 (MUST 8): the live child roster this run's own spawns append to -- what
  // `MessagingRouterSeam.children()` (messaging/adapter.ts) is defined to read from. No routing
  // logic lives here (WS-10 §15's own split); `onChildRosterReady` (EngineOptions) is this run's own
  // ONE exposure point, called once below, for whichever host-level code constructs Lane D's own
  // real MessagingRouterSeam to wire its `children()` against.
  const childRoster: ChildHandle[] = [];
  // Phase 4 Task 8 (rider 19, RULING P4-I): the pump-side child-bridge roster. Every child engine
  // spawned by THIS run registers its own `RpcBridge.handleResponse` here; the pump consults them,
  // in registration order, for any `control_response` this run's OWN bridge did not claim. The child
  // engine stays entirely unaware of the parent pump (P4-I's own wording) -- it only ever hands over
  // a function that answers "was this requestId mine?", which is exactly what `handleResponse`
  // already returns.
  const childResponseHandlers: Array<(frame: ControlResponseFrame) => boolean> = [];
  // Phase 4 fix wave (I5, whole-branch review): the FOREGROUND children this run has spawned. A
  // foreground child is awaited by the Agent tool call that spawned it -- so when that call is
  // ABANDONED by an interrupt (`raceInterrupt` stops waiting; Provider/ToolExecutor take no abort
  // signal, P1-G), nothing else bounds the child: it is an unbounded engine loop that keeps
  // executing tools, can spawn further children of its own, and -- unlike a background spawn -- has
  // no task id for `TaskStop` to reach. The stall watchdog never fires either, because a child
  // making real progress is not stalled. Interrupting the parent's turn therefore stops them.
  const foregroundChildren = new Set<ChildHandle>();
  function abortForegroundChildren(): void {
    for (const child of foregroundChildren) {
      // `stop()` is idempotent and routes through the child's own gated settle (child-engine.ts) --
      // a child that already finished is a silent no-op, never a status overwrite.
      if (child.status() === "running") void child.stop().catch(() => {});
    }
    foregroundChildren.clear();
  }
  opts.onChildRosterReady?.(() => childRoster);
  opts.onForegroundChildrenReady?.(() => [...foregroundChildren]);
  // Phase 4 Task 8: contribute THIS run's roster to the process-level messaging runtime, so Lane D's
  // SendMessage/ListAgents can actually resolve this session's own children (WS-10 §11 rules 2/3).
  // `ensureDefaultMessagingRuntimeRegistered` builds the in-process reference runtime once per
  // process and leaves any host-registered runtime alone -- see its own header for why the runtime
  // is process-level while the roster contribution is per-run. Withdrawn at teardown.
  const removeChildRosterSource = ensureDefaultMessagingRuntimeRegistered().addChildRosterSource(() => childRoster);
  // --- Phase 5 fix wave, B-H1(a): the sandboxed-posture predicate ---------------------------------
  //
  // WS-12 §1's composition MUST, which had two type declarations and no consumer. Three conditions,
  // ALL required, and each one is a separate reason the allow would otherwise be unearned:
  //
  //   1. the setting is ON for this session (`sandbox.autoAllowBashIfSandboxed`);
  //   2. the sandbox is ENABLED and genuinely AVAILABLE on this host -- a session that asked for a
  //      sandbox on a machine with no `sandbox-exec` gets no containment, so it gets no allow;
  //   3. the call is a Bash-family call that has NOT opted out. RULING P3-J's
  //      `dangerouslyDisableSandbox: true` still prompts, because a call that switches the fence off
  //      has none of the containment this allow is paying for -- which is the whole composition.
  //
  // Monitor is deliberately EXCLUDED alongside Bash's inclusion, matching the acceptEdits arm's own
  // I2 scoping ("stricter, never looser"): the setting names Bash and nothing else.
  const sandboxSettingsForSession = config.sandbox ?? DEFAULT_SANDBOX_SETTINGS;
  const bashRunsSandboxed = (call: PermissionCall): boolean => {
    if (sandboxSettingsForSession.autoAllowBashIfSandboxed !== true) return false;
    if (sandboxSettingsForSession.enabled === false) return false;
    if (call.toolName !== "Bash") return false;
    if (call.input["dangerouslyDisableSandbox"] === true) return false;
    return isSandboxAvailable();
  };

  const makeEvalCtx = (): EvaluationContext => {
    // Preserves the EXACT pre-existing "include the key only when config.additionalDirectories
    // itself was ever set" contract (Finding 6, P2 fix-wave) — union in extraBoundedRoots WITHOUT
    // making an untouched `extraBoundedRoots` (the common case) start including the key on its own.
    const additionalDirectories =
      config.additionalDirectories !== undefined || extraBoundedRoots.length > 0
        ? [...(config.additionalDirectories ?? []), ...extraBoundedRoots]
        : undefined;
    return {
      policy: policyStateStore.getState(),
      cwd: currentCwd,
      sessionRoot,
      home: permissionHome,
      trustedWorkspace,
      sessionBypassEnabled: config.allowDangerouslySkipPermissions === true,
      ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
      // Phase 5 Task 8 (rider 18): every name a skill answers to, out of THIS session's own skill
      // runtime -- keyed exactly as the Skill executor reads it, so a `Skill(...)` rule and the
      // invocation it is about always agree on the identity set. Absent for a session with no skill
      // runtime registered; the evaluator then matches on the literal name.
      skillIdentities: (skillName: string) => getSkillSessionRuntime(config.agentId ?? config.sessionId)?.index.identities(skillName) ?? [skillName],
      // I1: the resolved root, so the P5-B carve-out and its stage-2 deny skip name the SAME
      // directory `workflows/store.ts` persists to.
      ...(resolvedWinterHome !== undefined ? { winterHome: resolvedWinterHome } : {}),
      // B-H1(a) / WS-12 §1: "will this exact Bash call run under the OS sandbox, with
      // `autoAllowBashIfSandboxed` on?" -- the three facts the evaluator cannot see, answered here.
      bashRunsSandboxed: bashRunsSandboxed,
      hookStage: realHookStage,
      promptStage: realPromptStage,
      autoEngine: realAutoEngine,
      specialChecks: REAL_SPECIAL_CHECKS,
      // Phase 4 Task 3 (WS-09 §6): the real fill for evaluator.ts's own injected
      // `requiresInteraction` seam (that field's own header explains why this can't be a direct
      // import instead) -- reads the SAME module-level registry `buildDefaultToolExecutor`'s own
      // dispatch consults, so a live MCP registration (registerMcpServerTools) is reflected on the
      // very next evaluate() call with no engine-side caching to go stale.
      requiresInteraction: (toolName: string): boolean => getRegisteredTool(toolName)?.descriptor.interaction === "required",
    };
  };

  // WS-07 §2's stale-policy-rejection contract: evaluate() stamps `policyVersion` from the SNAPSHOT
  // it was handed (evaluator.ts's own EvaluationContext.policy comment) — if a mode/rule change
  // lands (via a concurrent set_permission_mode/applyUpdate control request, processed by the pump
  // below WHILE this call's evaluation is in flight) before this decision is actually used, the
  // decision is stale and must be discarded, never executed against a policy that has since moved
  // on. Re-evaluating under the now-current snapshot is the correct recovery (not merely rejecting):
  // the call still needs an answer under WHATEVER policy is active now.
  async function evaluateWithFreshPolicy(call: PermissionCall) {
    let record = await evaluate(call, makeEvalCtx());
    while (record.policyVersion !== policyStateStore.getState().version) {
      record = await evaluate(call, makeEvalCtx());
    }
    return record;
  }

  // Task 10 (T9-CARRY 2, reassigned; WS-08 §1.3): fires an event OBSERVATIONALLY through the SAME
  // registry/invoker/audit/lifecycle trio realHookStage itself is built from — used for every
  // engine-lifecycle event that is NOT stage-1 PreToolUse/PermissionRequest (those two flow through
  // evaluate()'s own HookStage seam because their composite genuinely GATES the pipeline; every
  // event fired here is "declaration-owned... observational at P2" per §1.3's own classification —
  // fired, audited, and streamed if includeHookEvents is on, but its own SyncHookJSONOutput fields
  // (additionalContext, sessionTitle, etc.) are read by NOBODY downstream yet. Consuming those is
  // real future work (§13 Open Question 4 for the turn-lifecycle events specifically), not silently
  // assumed here — this comment is the flag). Always AWAITED, never raced against a turn's own
  // interrupt signal — the SAME deliberate choice engine.ts's own pre-existing rpc_probe turn kind
  // makes ("a real permission/hook RPC will need to decide its own interrupt-during-wait semantics,
  // which may differ from this"); a future task may revisit.
  //
  // `policyVersion` is read fresh, once, per call — these events don't participate in
  // evaluateWithFreshPolicy's own stale-policy retry loop (there is no DECISION here to go stale;
  // an observational hook's audit record is a historical fact about whatever policy was live the
  // moment it fired, not a pending answer that can be invalidated by a later mode switch).
  // Task 12: now RETURNS the composite (was `Promise<void>`, discarding it) — every existing call
  // site below still just `await`s this without using the result (unaffected, a widening); the
  // PostToolUse call site is the one new consumer (its own `classifierContext` accumulation).
  async function fireObservationalHook(event: HookEvent, call: RunHooksCallInfo) {
    return runHooks(event, call, {
      registry: hookRegistry,
      invoker: hookInvoker,
      audit: hookAuditRecorder,
      sessionId: config.sessionId,
      policyVersion: policyStateStore.getState().version,
      lifecycle: hookLifecycleSink,
      // Phase 4 Task 3 (MUST 9): same posture as realHookStage's own construction above --
      // RunHooksContext.agentID populated for a child engine's own observational hook firings only.
      ...(config.agentId !== undefined ? { agentID: config.agentId } : {}),
    });
  }

  // --- Phase 5 fix wave, B-H1(c): R5-13's Notification emission ----------------------------------
  //
  // `Notification` was in `HOOK_EVENTS` and in the pinned `NotificationHookInput` and fired NOWHERE:
  // the P2 conformance matrix's own WS08-EVT-NOTIFICATION row records it as the one event with no
  // firing fixture, "a genuine ruling-vs-implementation discrepancy". This is the emission.
  //
  // THREE WINTER-DEFINED POINTS, and they are Winter's because they have to be: OQ-P5-8 records that
  // `notification_type` is an OPEN `string` with no declared values (`sdk.d.ts:1333`), and no
  // emission point fires in the canned single-shot run T1 captured -- so capture could observe
  // neither the vocabulary nor the trigger set. The three below are the ones an observer can
  // actually act on, and each is named in R5-13's own text: a permission prompt is on screen, the
  // session has gone idle waiting for input, a background task finished.
  //
  // OBSERVATIONAL ONLY. `Notification` has no hook-specific output type that could decide anything,
  // and `runHooks` is fire-and-forget here -- a slow or throwing notification hook must never delay
  // the prompt it is announcing.
  const emitNotification = (notificationType: string, message: string, title?: string): void => {
    void fireObservationalHook("Notification", {
      payload: { message, notification_type: notificationType, ...(title !== undefined ? { title } : {}) },
    }).catch(() => {
      /* observational -- a notification hook's failure is never the session's problem */
    });
  };

  // Store failures are auxiliary, never turn-fatal (WS-03 §11 — a mirror failure becomes a
  // `mirror_error` event, not a retroactive turn failure). P1 has no such event to emit yet, so
  // this just swallows; a future WS-03 §11/WS-16 mirror-layer task is expected to route the catch
  // body to that event (T8 fix-wave: this comment previously, and now stale-ly, said "Task 8 is
  // expected to" — Task 8 shipped without adding it; re-pointed at its real future owner).
  const recordUser = async (content: string | ContentBlock[]): Promise<void> => {
    if (!store) return;
    try {
      await store.recordUserEntry(content);
    } catch {
      /* auxiliary — see comment above */
    }
  };
  /**
   * Phase 6 Task 3 (R6-7): the WRITE-AHEAD assistant record.
   *
   * ORDER IS THE WHOLE GUARANTEE. The uuid is minted HERE, the sidecar records naming it as
   * `anchorUuid` are appended and fsync'd, and only then does the transcript entry go down. A crash
   * between the two leaves a record with no entry -- ignorable and garbage-collectable
   * (`buildContinuationChain` drops it) -- and never an entry whose provider state was lost.
   *
   * `origin` is MANDATORY for every assistant entry once a provider identity is known; `native-state`
   * and `summary` ride the same anchor when the turn produced them. A session with no identity yet
   * (every pre-P6 double, and any run before selection is wired in T10) writes no records at all and
   * behaves byte-identically to before this task.
   */
  const recordAssistant = async (content: ContentBlock[], provenance?: { nativeState?: ProviderNativeState; summary?: string }): Promise<string | undefined> => {
    if (!store) return undefined;
    const uuid = randomUUID();
    const identity = currentProviderIdentity;
    if (identity !== undefined && store.recordProviderState !== undefined) {
      const base = {
        sessionId: config.sessionId,
        anchorUuid: uuid,
        provider: identity.providerId,
        model: identity.modelKey,
        family: identity.family,
        ...(identity.continuationDomain !== undefined ? { continuationDomain: identity.continuationDomain } : {}),
      };
      // itemIndex ORDERS the records under one anchor: 0 is always the mandatory `origin`.
      const records: ProviderStateRecordInput[] = [{ ...base, itemIndex: 0, kind: "origin", payload: {} }];
      if (provenance?.nativeState !== undefined) records.push({ ...base, itemIndex: records.length, kind: "native-state", payload: { items: provenance.nativeState.items } });
      if (provenance?.summary !== undefined) records.push({ ...base, itemIndex: records.length, kind: "summary", payload: { text: provenance.summary } });
      for (const record of records) {
        try {
          await store.recordProviderState(record);
        } catch {
          // Auxiliary, exactly like every other record* call here: a sidecar write failing must never
          // fail the turn. The consequence is a DEGRADED resume for that message, which the
          // continuity warning already exists to report -- not a lost turn.
        }
      }
    }
    try {
      await store.recordAssistantEntry(content, { uuid });
    } catch {
      /* auxiliary — see comment above */
    }
    // RETURNED so the IN-MEMORY message can carry the same anchor the sidecar record names. Without
    // it a live session's history and the same session's RESUMED history would disagree on every
    // assistant message's `uuid` -- and the continuous-vs-resumed fidelity that resume.test.ts pins
    // is exactly the property the continuation chain depends on.
    return uuid;
  };
  const flushStore = async (): Promise<void> => {
    if (!store?.flush) return;
    try {
      await store.flush();
    } catch {
      /* auxiliary — see comment above */
    }
  };
  // Task 8 (WS-07 §3.3 / phase ruling 2): same auxiliary-failure policy as recordUser/recordAssistant
  // above — a journal write failing must never fail the turn or block the tool call it accompanies
  // (the live PolicyStateStore.applyUpdate already succeeded by the time this runs; the journal is a
  // durability side channel for P5 replay, not the source of truth for THIS run's own live policy).
  const recordPermissionUpdate = async (update: PermissionUpdate, authority: RuleSource): Promise<void> => {
    if (!store?.recordPermissionUpdate) return;
    try {
      await store.recordPermissionUpdate(update, authority);
    } catch {
      /* auxiliary — see comment above */
    }
  };

  // Task 11 (WS-07 §2's mode-switch semantics): "a mode switch mid-park discards incompatible
  // pending records." A durable approval is issued under a specific policyMode/policyVersion
  // (evaluate()'s own stamp) — ANY genuine mode switch invalidates every record still "pending" for
  // this session (they were never going to revalidate cleanly against the new mode anyway; this is
  // a proactive cleanup, not a correctness requirement the resume-revalidation step doesn't already
  // enforce on its own). Called from BOTH mode-switch doors this engine has (policy-state.ts's own
  // header names the equivalence explicitly: "a SECOND DOOR into the same room" — `updatedPermissions`
  // can carry a `type:"setMode"` update mid-turn just as easily as a direct `set_permission_mode`
  // control request) — see both call sites below. `previousMode === nextMode` is a no-op (a
  // same-mode setMode call, or a rejected/gated switch that left the mode unchanged, is not a
  // "switch" at all). Auxiliary — a cancellation failure never fails the mode switch itself, same
  // policy as every other store side effect in this function.
  const cancelPendingApprovalsOnModeSwitch = (previousMode: string, nextMode: string): void => {
    if (!approvalStore || previousMode === nextMode) return;
    try {
      approvalStore.cancelPendingFor({ sessionId: config.sessionId }, `permission mode switched from ${previousMode} to ${nextMode}`);
    } catch {
      /* auxiliary — see comment above */
    }
  };

  // Task 1 (P3, WS-06 §1): the tools seam becomes registry-backed. Built ONLY when the caller omits
  // `tools` (buildDefaultToolExecutor, below) -- everything in this block is unreachable, and
  // therefore inert, for a caller that supplies its own ToolExecutor (every pre-existing test,
  // runtime.ts): `providedTools ?? buildDefaultToolExecutor()` short-circuits before this function's
  // body ever runs whenever `providedTools` is defined. Fix round 1 (RULING P3-C): main.ts now omits
  // `tools`, so it DOES run this block -- see `unregisteredToolExecutor`'s own doc comment
  // (EngineOptions, above) for how it still keeps its pre-existing scripted test doubles working.
  //
  // `session`: the posture-mutation seam Lane E's plan/worktree tools mutate through, wired to this
  // run's own PolicyState/cwd owners declared above (`currentCwd`/`extraBoundedRoots`,
  // `policyStateStore`) -- see ToolExecutionContext.session's own doc comment (registry.ts) for the
  // exact contract. `setPermissionMode` reuses the SAME bypass-gated `policyStateStore.setMode` path
  // + `cancelPendingApprovalsOnModeSwitch` door 1/2 precedent every other mode-switch caller in this
  // file already goes through (set_permission_mode control request; canUseTool/hook
  // updatedPermissions) -- a THIRD door into the identical room, never a parallel implementation of
  // the switch itself. A rejected switch (the bypass gate) throws -- this executes INSIDE a tool
  // executor's own async function, so it rejects that call's promise and surfaces as this round's
  // ordinary error_during_execution (Ruling P1-H), the same severity any other executor-thrown error
  // gets; it is not expected to be reachable via EnterPlanMode/EnterWorktree (neither ever requests
  // "bypassPermissions", the only mode the gate can reject).
  //
  // `getTempDir`/`configureBackgroundTaskRoot`: memoized ONCE per run, lazily -- `sessionTempDir`
  // creates real `/tmp/winter-<uid>/...` directories (D18), so this must never run just because a
  // tool call happened; only a REAL executor that actually reads `ctx.tempDir` (or calls
  // createBackgroundTask) triggers it (see registry.ts's own ToolExecutionContext.tempDir comment
  // and background-tasks.ts's own header for the one-live-engine assumption this accepts).
  // `tempProjectKey` is derived from `config.cwd` (the session's STARTING cwd), deliberately never
  // `currentCwd` -- D18's session-temp identity is fixed for the run's whole lifetime, the same way
  // `permissionHome`/`policyStateStore`'s own initial mode are; it must not drift if a tool later
  // switches worktrees mid-session.
  let cachedSessionTempPaths: SessionTempDirPaths | undefined;
  function resolveSessionTempPaths(): SessionTempDirPaths {
    if (!cachedSessionTempPaths) {
      cachedSessionTempPaths = sessionTempDir({
        tempProjectKey: compatibilityKeys(config.cwd).tempProjectKey,
        backendUuid: config.sessionId,
      });
    }
    return cachedSessionTempPaths;
  }

  // Phase 4 Task 3 (MUST 5, WS-10 §3.1/§3.5): the STRUCTURAL model precedence chain --
  // WINTER_SUBAGENT_MODEL -> per-invocation -> definition -> session, "inherit" meaning "continue
  // resolving," a fork ignoring an override BY CONTRACT. Real alias resolution against a provider
  // catalog (org `availableModels` substitution, an unresolvable-alias typed error) is WS-13/Lane
  // C's own deeper scope -- no such catalog exists in this codebase yet, so this chain operates on
  // plain strings only, exactly the base layer Lane C's own spawn() implementation is expected to
  // compose with (it already receives BOTH `req` and this function's own `inherit.model`, so it can
  // re-derive the identical chain with real alias resolution layered on top without this function
  // needing to know about that layer at all).
  function resolveChildModel(req: SpawnChildRequest): string {
    if (req.fork === true) return config.model; // WS-10 §3.5: fork ignores a model override by contract
    const envModel = (engineEnv ?? process.env)["WINTER_SUBAGENT_MODEL"];
    if (envModel !== undefined && envModel !== "" && envModel !== "inherit") return envModel;
    if (req.model !== undefined && req.model !== "inherit") return req.model;
    const defModel = req.definition?.model;
    if (defModel !== undefined && defModel !== "inherit") return defModel;
    return config.model;
  }

  // Phase 4 Task 3 (MUST 5, WS-10 §3.5/§9, WS-07 §11): the live-session-state inheritance builder --
  // `ctx.session.spawnChild` (below) calls this immediately before handing the result to the
  // registered ChildEngineDeps.spawn(). A fork copies live state (messages, by value); a
  // definition-backed (or bare) child gets the definition's own restrictions where declared, falling
  // back to this session's own current pool otherwise.
  function buildChildInheritance(req: SpawnChildRequest): ChildInheritance {
    const parentState = policyStateStore.getState();
    const requestedMode = req.definition?.permissionMode;
    const validMode = requestedMode !== undefined && isPermissionMode(requestedMode) ? requestedMode : undefined;
    // RULING P2-M (permissions/auto/inheritance.ts): computeChildPolicy needs no per-axis change of
    // its own for this call site -- WS-07 §11's forced-mode table is a fixed set-membership check,
    // not a "which is stricter" comparison; the per-axis comparator only matters at RESUME
    // (resolveChildResumeMode), Lane C's own future call site once children durably persist across
    // restarts.
    const policyResult = computeChildPolicy(
      parentState,
      { ...(validMode !== undefined ? { permissionMode: validMode } : {}) },
      {
        // R-1 (residual round 2): the veto binds from ANY TIER here too. Reading `config.permissions`
        // alone made the managed-tier veto fail-closed by CRASHING rather than by degrading: a child
        // whose definition asks for `permissionMode: "bypassPermissions"` was GRANTED bypass at
        // inheritance, and then its own `PolicyStateStore` -- which since NEW-4 carries the seed's
        // veto -- threw `bypassPermissions is disabled by managed configuration`. The safety
        // direction was right and the experience was not: every spawn of such a definition failed
        // opaquely under a managed policy, while the identical Options-level veto degraded the same
        // child to the parent's mode and ran.
        //
        // THE FIFTH HAND-MIRRORED COPY of this predicate, and they move together or a tier's veto
        // binds in some places and not others: `engine.ts:987` (the parent's own PolicyStateStore),
        // `register-default-factory.ts` (the child's), `production-wiring.ts`'s seed builder (which
        // computes it from the tiers), and this one.
        disableBypassPermissionsMode: config.permissions?.disableBypassPermissionsMode === true || settingsRules?.disableBypassPermissionsMode === true,
      },
    );
    return {
      policy: policyResult,
      // WS-10 §2: AgentDefinition.tools restricts availability when declared; a fork (WS-10 §3.5
      // "exact tool pool") and a bare/unrestricted definition both inherit this session's own
      // CURRENT advertised pool (eager + deferred canonical names -- see currentAdvertisedCanonicalNames's
      // own header for why this is safe to read here, well after assignment).
      // Phase 4 fix wave (C1 CRITICAL, whole-branch review): a definition's own `tools` list
      // NARROWS the parent's pool, it never REPLACES it. Before this fix the `??` handed the
      // definition's list through verbatim, so a definition naming a tool the PARENT had
      // bare-denied (`disallowedTools:["t"]` -> `t` is absent from `currentAdvertisedCanonicalNames`)
      // put that tool back into `inherit.tools`, out of the child's complement-deny, and -- under
      // WS-07 §11's forced bypass -- straight into execution. Probe-confirmed, not hypothetical.
      // An intersection is also the only reading consistent with WS-10 §2 ("AgentDefinition.tools
      // RESTRICTS availability"): a restriction that can widen is not a restriction.
      tools: req.definition?.tools !== undefined ? req.definition.tools.filter((name) => currentAdvertisedCanonicalNames.includes(name)) : [...currentAdvertisedCanonicalNames],
      model: resolveChildModel(req),
      // WS-10 §3.2: AgentInput/SpawnChildRequest carry no effort field at all; definition effort
      // overrides the session's own. No session-level effort CONCEPT is surfaced on RuntimeConfig
      // anywhere in this codebase yet (a genuine WS-13/provider-layer gap, disclosed rather than
      // papered over) -- "inherit" is the honest base value Lane C's own resolution applies
      // definition.effort on top of.
      effort: req.definition?.effort !== undefined ? String(req.definition.effort) : "inherit",
      // WS-10 §3.3: non-fork children inherit whether extended thinking is enabled -- RuntimeConfig
      // carries no such flag yet either (same disclosed gap) -- `undefined` is an honest "not
      // configured," never a fabricated value.
      thinking: undefined,
      // WS-10 §2's real per-child system prompt is AgentDefinition.prompt (Lane C's own resolution);
      // no session-level system-prompt concept is surfaced on RuntimeConfig at P1-P4 either -- ""
      // is the honest base a definition's own prompt is expected to be layered onto, never a guess.
      systemPrompt: "",
      // Phase 5 Task 8 (rider 12, WS-11 §6.5): the parent's own configured output style, so a
      // dispatch-child renders under the same one.
      //
      // CORRECTED IN THE FIX WAVE (B-low). This used to read `config.outputStyle` alone and justify
      // it with "production-wiring.ts already folded the settings value into the session's effective
      // config path" -- a mechanism that does not exist. The wiring resolves
      // `config.outputStyle ?? effective.outputStyle ?? DEFAULT` into `initOutputStyle` and hands it
      // to the engine as an ENGINE OPTION; it never writes back into `config`. So `config.outputStyle`
      // stayed `undefined` whenever the style came from a settings file, and a dispatch-child
      // silently rendered under the default while its parent used the user's chosen style. The
      // comment asserted the gap was closed, which is worse than the gap: it told the next reader
      // not to look.
      //
      // `initOutputStyle` IS that resolution, so reading it here is not a second producer -- it is
      // the first one, finally consulted. Still omitted when it resolves to the default, so a
      // session that configured nothing keeps handing children an absent field rather than a newly
      // fabricated `"default"`.
      ...(initOutputStyle !== undefined && initOutputStyle !== DEFAULT_OUTPUT_STYLE
        ? { outputStyle: initOutputStyle }
        : config.outputStyle !== undefined
          ? { outputStyle: config.outputStyle }
          : {}),
      // WS-10 §3.5: "a fork inherits EVERYTHING... conversation." Copied BY VALUE (a fresh array of
      // the same message objects) so a child can never mutate the parent's own live turn history.
      //
      // Phase 6 Task 3 (R6-3's sweep, consumer 6): a SHALLOW array copy, deliberately -- the elements
      // are the same `ProviderMessage` objects, so `origin`/`nativeState`/`uuid` ride along. A copy
      // that rebuilt each element as `{role, content}` would strip exactly the annotations that tell
      // the child which provider produced the history it inherited, and it would do so silently.
      ...(req.fork === true ? { messages: [...messages] } : {}),
      // Phase 6 Task 3 (R6-17): the parent's RESOLVED provider identity and its EFFECTIVE reasoning
      // configuration. `model`/`effort`/`thinking` above are the REQUESTED values (a definition's own
      // override, or the placeholder base); these are what a bare child model id resolves against and
      // what the child's own provider-state records identify themselves with.
      ...(currentProviderIdentity !== undefined ? { provider: { ...currentProviderIdentity } } : {}),
      ...(config.effort !== undefined ? { effectiveEffort: config.effort } : {}),
      ...(config.thinking !== undefined ? { effectiveThinking: config.thinking } : {}),
      sessionRoot,
    };
  }

  function buildDefaultToolExecutor(): ToolExecutor {
    // Whole-branch M3(a), partially resolved by the fix wave's I1 and recorded here rather than
    // left implicit: this process-global re-point used to hand the PARENT's background-task root to
    // the CHILD's temp dir for the rest of the session, because a child's session id (and hence its
    // `sessionTempDir` key) was its own agentId. A child now SHARES its parent's session id and,
    // when it is not worktree-isolated, its cwd -- so both derive the identical temp root and the
    // re-point is a no-op. It remains a real re-point for an `isolation:"worktree"` child (different
    // cwd -> different tempProjectKey); keying the root per session rather than per process is the
    // residual carry.
    configureBackgroundTaskRoot(resolveSessionTempPaths);
    const deps: RegistryToolExecutorDeps = {
      sessionId: config.sessionId,
      home: permissionHome,
      // I1: the RESOLVED winter root, so `tools/impl/agent.ts` finds the user agent tier where the
      // skills index and the command resolver already look, and any tool naming Winter's own storage
      // uses one address.
      ...(resolvedWinterHome !== undefined ? { winterHome: resolvedWinterHome } : {}),
      getCwd: () => currentCwd,
      probeReadAccess: (filePath: string) => probeReadAccess(filePath, makeEvalCtx()),
      // Task 2 (P3, WS-06 §3.5) completes this seam's engine plumbing. registry.ts's own
      // ToolExecutionContext.emitFrame is now typed `(frame: BackgroundTaskMessage) => void` (narrowed
      // from Task 1's placeholder `unknown`), so `frame` here is already one of the six real, closed
      // shapes -- wrapping it in a "data" envelope and hand it to `output.write` needs no cast at all;
      // TS itself proves `{type:"data", message: frame}` satisfies `WinterFrame` structurally, since
      // BackgroundTaskMessage's six members are now part of SdkMessage's own union (frames.ts).
      // Synchronous, like every other output.write call in this file -- three emitFrame calls made
      // back-to-back inside one executor land on the wire in that exact call order (WS-06 §3.5
      // "delivers these frames onto the wire in order").
      emitFrame: (frame: BackgroundTaskMessage): void => {
        output.write({ type: "data", message: frame });
        // B-H1(c) point 3: a background task finished. HERE rather than in each tool, because
        // `task_notification` has THREE producers today (bash, agent, workflow) and a per-tool
        // emission is three places to forget the fourth. `status` carries the pinned
        // completed/failed/stopped union straight into `notification_type`, which is an open string
        // on the pin (OQ-P5-8) -- so the vocabulary is Winter's, and it is at least the runtime's own
        // word for what happened rather than a second invented one.
        if (frame.subtype === "task_notification") {
          const status = typeof frame.status === "string" ? frame.status : "completed";
          emitNotification(`task_${status}`, `Background task ${frame.task_id} ${status}.`, "Task finished");
        }
      },
      // Phase 4 Task 3 (MUST 6, WS-09 §8.2/§8.3): the real fill for ToolExecutionContext.
      // emitToolReference -- see that field's own comment for why this bundles BOTH marking
      // `names` loaded (closing the load-first execution-boundary check, isDeferredAndUnloaded
      // above) and the wire emission into one call. `loadedToolSet` is referenced here by
      // CLOSURE-BINDING, not by value -- this callback only ever runs when a real executor (Lane
      // B's future ToolSearch tool) actually invokes it, well after `loadedToolSet` is assigned
      // below (the identical "declared later, read at call time" pattern buildChildInheritance's
      // own `messages` reference already uses in this same function).
      emitToolReference: (names: string[]): void => {
        loadedToolSet.load(names);
        output.write({ type: "data", message: { type: "assistant", message: { content: [{ type: "tool_reference", tool_names: names }] } } });
      },
      session: {
        setCwd(p: string): void {
          currentCwd = p;
        },
        addBoundedRoot(p: string): void {
          extraBoundedRoots.push(p);
        },
        // M5 (fix wave, P3 close-out): see registry.ts's own doc comment. Exact-match removal only
        // (splice at the found index) -- `extraBoundedRoots` can carry duplicate entries in
        // principle (nothing dedupes `addBoundedRoot`'s own pushes), so this removes the FIRST
        // matching occurrence, mirroring the ordinary semantics of "undo one add" rather than every
        // occurrence at once.
        removeBoundedRoot(p: string): void {
          const idx = extraBoundedRoots.indexOf(p);
          if (idx !== -1) extraBoundedRoots.splice(idx, 1);
        },
        // RULING P3-L: see registry.ts's own doc comment. `getSessionRoot` is a plain read of this
        // closure's own `sessionRoot` (never re-derived from `currentCwd`, which is exactly the
        // value it must stay independent of); `setSessionRoot` is called ONLY by EnterWorktree/
        // ExitWorktree.
        getSessionRoot(): string {
          return sessionRoot;
        },
        setSessionRoot(p: string): void {
          sessionRoot = p;
        },
        setPermissionMode(mode: PermissionMode): void {
          const previousMode = policyStateStore.getState().mode;
          const result = policyStateStore.setMode(mode);
          if (!result.ok) {
            throw new WinterPermissionError(result.error.message);
          }
          cancelPendingApprovalsOnModeSwitch(previousMode, result.effectiveMode);
        },
        // Task 8 (P3 close-out, "Settings threading" MUST): `makeEvalCtx()` is cheap and side-
        // effect-free (built fresh per call throughout this file already, e.g. the probeReadAccess
        // line above) -- reusing evaluator.ts's own boundedRoots() here is what keeps a tool
        // executor's notion of "writable roots" from ever drifting from the standing evaluator's.
        getBoundedRoots(): string[] {
          return boundedRoots(makeEvalCtx());
        },
        // RULING P3-H: reads the SAME live PolicyStateStore `setPermissionMode` (above) mutates --
        // never a separate, potentially-stale snapshot. See registry.ts's own
        // ToolExecutionContext.session.getPermissionMode comment for why this exists.
        getPermissionMode(): PermissionMode {
          return policyStateStore.getState().mode;
        },
        // Phase 4 Task 3 (MUST 5, R4-4): the Agent tool's own spawn seam -- registry.ts's own
        // ToolExecutionContext.session.spawnChild doc comment for the full contract. Builds this
        // run's own ChildEngineRunContext (the correlation closure Lane C's real child-engine.ts
        // needs to reach the ACTUAL host connection this run owns) fresh per call -- cheap,
        // side-effect-free until a factory is actually registered and invoked.
        async spawnChild(req: SpawnChildRequest): Promise<ChildHandle> {
          const factory = getChildEngineFactory();
          if (!factory) {
            throw new Error(
              "winter: Agent spawn requested but no child engine factory is registered (registerChildEngineFactory, subagents/child-handle.ts) -- Lane C's own child-engine.ts must register one before any Agent tool call can succeed",
            );
          }
          const deps = factory({
            parentSessionId: config.sessionId,
            // Phase 4 fix wave (I1): this run's OWN agent key -- present only when THIS engine is
            // itself a child. `config.sessionId` is the owning session at every nesting level now
            // (a child shares its parent's), so it can no longer identify the spawner; the spawn
            // DEPTH table (subagents/limits.ts) is keyed on this instead.
            ...(config.agentId !== undefined ? { parentAgentId: config.agentId } : {}),
            // Handoff note (fix round 1, T3 review minor, item 4) -- CLOSED, and corrected here
            // because it asserted the opposite of what is now true (P4 fix wave, KNOWN item 8's
            // stale-comment sweep). A real ChildEngineFactory IS registered on every leg
            // (subagents/register-default-factory.ts, called by main.ts AND testing.ts), and this
            // closure runs through real spawned/compiled processes in three committed
            // cross-transport scenarios: `subagent-spawn-round`, `sendmessage-child-round`, and the
            // fix wave's own `subagent-permission-round` (which is also the one that pins
            // `parent_tool_use_id` on the wire).
            forwardChildFrame: (frame: WinterFrame, correlation: { parentToolUseId: string; agentId: string }): void => {
              const forwarded = transformChildFrame(frame, correlation, config.forwardSubagentText === true);
              if (forwarded !== null) output.write(forwarded);
            },
            // Phase 4 Task 8 (rider 19, RULING P4-I): see childResponseHandlers' own declaration.
            registerChildResponseHandler: (handle: (frame: ControlResponseFrame) => boolean): (() => void) => {
              childResponseHandlers.push(handle);
              return () => {
                const idx = childResponseHandlers.indexOf(handle);
                if (idx !== -1) childResponseHandlers.splice(idx, 1);
              };
            },
            // RULING P5-J (fix wave): a descendant's provider usage folds into the OWNING session's
            // cumulative spend, and into nothing else. A per-run accessor, not a construction-time
            // mirror -- the accountant belongs to a RUN and a registered factory is built once.
            recordDescendantUsage: (usage: { inputTokens: number; outputTokens: number }): void => {
              contextAccountant.recordDescendantUsage(usage);
            },
            // Phase 4 Task 8 (rider 26, RULING P4-J(e)): the parent's CURRENT live policy, read
            // fresh on every call (never a spawn-time snapshot) -- WS-10 §9's stricter-of comparison
            // is only meaningful against the policy in force at RESUME time. `computePolicyHash` is
            // the same function the durable-approval path already stamps records with, so a child's
            // recorded `parentPolicyHash` and this value are directly comparable by construction.
            getParentPolicy: () => {
              const st = policyStateStore.getState();
              return { mode: st.mode, version: st.version, hash: computePolicyHash(st) };
            },
            // Phase 4 fix wave (C1 + I6): the parent's CURRENT LIVE rule set, read fresh on every
            // call (never a spawn-time or factory-construction-time snapshot) -- see
            // ChildEngineRunContext.getParentRules for the two escapes this closes. The live
            // `PolicyStateStore` is the ONE authority: it already carries the config-seeded `sdk`
            // entries (allowedTools/disallowedTools/permissions.* alike, WS-07 §3.3), WS-07 §9's
            // journal-restored rules, and every mid-session `PermissionUpdate` -- so a child cannot
            // observe a different rule set from the one the parent's own next tool call would.
            getParentRules: (): ParentRuleMirror => {
              const mirror: ParentRuleMirror = { allow: [], ask: [], deny: [] };
              for (const entry of policyStateStore.getState().rules.entries) {
                // KEPT, and the reason is no longer the one originally written here (residual round,
                // NEW-4). The old note said `managed` meant only the hardcoded `BASELINE_DENY_RULES`,
                // which every `runEngine` seeds for itself. The fix wave falsified that: C1 seeds
                // managed-TIER settings rules as `managed` and I1 emits the resolved-root floor twins
                // as `managed`, so for a while this skip was silently dropping real policy on the way
                // into every child.
                //
                // WIDENING THE MIRROR WOULD NOT HAVE FIXED IT, and this is the part worth keeping:
                // a mirrored rule arrives in the child re-tagged `sdk`, and a forced-bypass child --
                // which is every descendant of a bypass parent -- honours ONLY `managed` denies at
                // stage 2. A managed deny mirrored as `sdk` would be inert in exactly the case that
                // matters most. The child therefore seeds the SAME `SettingsRuleSeed` its parent did,
                // tags intact (`child-engine.ts` passes `deps.settingsRules` straight through), which
                // also keeps the P5-A/P5-D per-tier gates identical on both sides. With that in place
                // this skip is correct again: mirroring would now be a strictly weaker DUPLICATE of
                // something the child already has.
                if (entry.source === "managed") continue;
                // WS-07 §3.2 as amended by RULING P5-D, and the ONE way this accessor could WIDEN
                // rather than bind: a `project`-sourced ALLOW entry is INERT in an untrusted workspace
                // (evaluator.ts's own `findMatchingRuleEntry` skips it, exactly as ruleset.ts's
                // resolveRules does). Mirroring it here would re-tag it `sdk` in the child, where
                // that gate no longer applies -- a child auto-approving what its own parent still
                // gates, which is the C1 class in the opposite direction, inside C1's own fix. The
                // write path makes this reachable today, not just after P5: only `cliArg` is
                // authority-restricted (ruleset.ts's assertAuthorityMayWriteDestination), so a
                // host's `canUseTool` can already return `{type:"addRules", destination:
                // "projectSettings", behavior:"allow", ...}` under `session` authority. DENY/ASK
                // entries from those same sources apply WITHOUT trust and are mirrored unchanged --
                // the skip is allow-side only, matching the evaluator's own predicate verbatim.
                //
                // P5-D narrowed it from `project`/`local` to `project` alone: capture (1) shows the
                // pinned runtime lets local/user permissive rules widen without trust. "Matching the
                // evaluator's own predicate verbatim" is the invariant -- this is the fourth of four
                // hand-mirrored copies of one gate (evaluator.ts's findMatchingRuleEntry,
                // ruleset.ts's resolveRules and effectiveDirectories are the others), and they move
                // together or a child ends up with a different permission surface than its parent.
                if (entry.behavior === "allow" && entry.source === "project" && !trustedWorkspace) continue;
                const raw = entry.ruleValue.ruleContent === undefined ? entry.ruleValue.toolName : `${entry.ruleValue.toolName}(${entry.ruleValue.ruleContent})`;
                mirror[entry.behavior].push(raw);
              }
              return mirror;
            },
            // Phase 4 fix wave (I2): this run's RESOLVED MCP state, handed down so a child is not
            // an MCP island (see ChildEngineRunContext.getParentMcpState). Read at CALL time, not
            // capture time -- `effectiveMcpStateSource`/`effectiveMcpControlSeam` are declared
            // below this function and are always assigned long before any Agent tool call can run,
            // the same "declared later, read at call time" closure binding `emitToolReference`
            // already uses for `loadedToolSet`.
            getParentMcpState: (): ParentMcpState => ({
              ...(effectiveMcpStateSource !== undefined ? { stateSource: effectiveMcpStateSource } : {}),
              ...(effectiveMcpControlSeam !== undefined ? { controlSeam: effectiveMcpControlSeam } : {}),
              ...(config.mcpServers !== undefined ? { declaredServers: config.mcpServers } : {}),
            }),
            // Fix wave follow-up (8), whole-branch M7: this session's own programmatic agents map,
            // so a grandchild can resolve a `subagent_type` the host declared (see
            // ChildEngineRunContext.getParentAgents).
            getParentAgents: () => config.agents,
          });
          const inheritance = buildChildInheritance(req);
          const handle = await deps.spawn(req, inheritance);
          childRoster.push(handle);
          // Fix wave (I5): a BACKGROUND child deliberately outlives the call that spawned it (it is
          // tracked by the background-task registry and reachable by TaskStop); a FOREGROUND child
          // is owned by this turn, so an interrupt must take it down with the call that was
          // awaiting it.
          if (req.runInBackground !== true) {
            foregroundChildren.add(handle);
            // NEW-3 (residual round): PRUNED ON SETTLE, not merely cleared by an interrupt. The set
            // exists so an interrupt can stop the children a turn still owns; a child that has
            // already finished is not one of those, and keeping it only grew the set by one per
            // foreground spawn for the life of the session. `result()` is a memoized promise
            // (child-engine.ts), so observing it here costs nothing and cannot double-settle
            // anything -- `agent.ts` awaits the same promise for its own result.
            void handle
              .result()
              .catch(() => undefined)
              .finally(() => foregroundChildren.delete(handle));
          }
          return handle;
        },
      },
      // Ruling P3-D carry (task-1 report, spine amendment section): `config.cwd` -- the run's own
      // STARTING cwd -- was in scope here all along; passing it is what lets the read-before-edit
      // ladder's canonicalization resolve a RELATIVE file_path/notebook_path the same way for every
      // caller in this run, instead of silently defaulting to `process.cwd()` (the daemon's own
      // process-wide cwd, never a per-session concept). Deliberately `config.cwd`, not the live
      // `currentCwd` -- SessionReadStateOptions.cwd is fixed at CONSTRUCTION time by design (its own
      // header: "never per-call, so one session's keying stays internally consistent"), and this
      // call site runs exactly once, before any tool call could have switched worktrees, so the two
      // would read identically here regardless; `config.cwd` names the invariant this actually is.
      readState: createSessionReadState({ cwd: config.cwd }),
      getTempDir: () => resolveSessionTempPaths().root,
      sandboxSettings: config.sandbox ?? DEFAULT_SANDBOX_SETTINGS,
      // M11 (fix wave follow-up 6): the SAME `trustedWorkspace` constant the permission evaluator's
      // EvaluationContext and the hook registry already read -- one producer, three consumers, so a
      // P5 trust signal cannot reach two of them and miss the third.
      trustedWorkspace,
      ...(config.outputsDir !== undefined ? { outDir: config.outputsDir } : {}),
      // Phase 4 Task 3 (MUST 5): threaded straight from this child (or main) run's own RuntimeConfig
      // -- see ToolExecutionContext's own comments on each field for the full rationale.
      ...(config.insideSubagent !== undefined ? { insideSubagent: config.insideSubagent } : {}),
      ...(config.isolationPinnedCwd !== undefined ? { isolationPinnedCwd: config.isolationPinnedCwd } : {}),
      ...(config.agentId !== undefined ? { agentId: config.agentId } : {}),
      // Phase 4 Task 8 (Lane C Gap #3): the programmatic Options.agents map, straight from this
      // run's own RuntimeConfig -- see ToolExecutionContext.agents (registry.ts) for why.
      ...(config.agents !== undefined ? { agents: config.agents } : {}),
      // Phase 4 Task 8 (rider 27): dispatch-time availability enforcement. A FUNCTION, not a
      // snapshot, for two independent reasons: (1) `advertisedCfg` (below) is assigned AFTER this
      // one runs -- the same "declared later, read at call time" closure binding `emitToolReference`
      // already uses for `loadedToolSet`; (2) `mode` must be read LIVE on every call, never the
      // frozen startup value `advertisedCfg` captured (a mid-session setPermissionMode must be able
      // to make a mode-gated tool refuse, exactly like `isDeferredAndUnloaded` already reads mode
      // live at the same execution boundary).
      // Fix wave follow-up (3): `capabilities` is re-resolved LIVE here, not taken from the frozen
      // startup snapshot -- a server added mid-run by `mcp_set_servers` must make the winter.mcp
      // family dispatchable, or M2's "a session can gain its first server" would stop one step short
      // (rider 27's availability check would still refuse every call).
      getAvailabilityInputs: () => ({ ...advertisedCfg, mode: policyStateStore.getState().mode, capabilities: resolveLiveSessionCapabilities() }),
    };
    // Fix round 1 (RULING P3-C): main.ts is the one caller that supplies `unregisteredToolExecutor`
    // (stubExecutor) -- every OTHER caller of this default (testing.ts's inMemoryProcess, when ITS
    // OWN `tools` param is also omitted) has none, and keeps the registry's plain, typed "unknown
    // tool" error for an unregistered name exactly as before this fix round.
    return unregisteredToolExecutor !== undefined ? buildRegistryToolExecutorWithFallback(deps, unregisteredToolExecutor) : buildRegistryToolExecutor(deps);
  }
  const tools: ToolExecutor = providedTools ?? buildDefaultToolExecutor();

  // Phase 4 Task 3 (WS-04 addendum, "sdk_mcp_call host-side bridge"): registers an in-process SDK
  // server's own tools directly from RuntimeConfig.mcpServers (populated by query.ts's own
  // toWireMcpServers whenever the host's `instance` implements WinterMcpServerInstance.listTools())
  // -- closes T2's own report "PLAN GAP": the child/compiled legs never see the live `instance`
  // object, so without this the runtime would have no way to know an SDK server has any tools at
  // all. Each tool's own executor forwards the call back over the wire as `sdk_mcp_call`
  // (bridge.request, per-server `timeout` else MCP_TOOL_TIMEOUT) -- the runtime side of the bridge;
  // query.ts's makeSdkMcpCallHandler is the host side that actually invokes the live instance.
  // Unregistered in this run's own teardown (below) so a leaked registration never survives into
  // the next in-memory-leg run sharing this process's module-level registry singleton.
  const mcpEnvConfig = parseMcpEnvConfig(engineEnv ?? process.env);
  const sdkMcpServerNames: string[] = [];
  // Robustness note (Phase 4 Task 3, refreshed fix round 1 item 3): this run's own teardown (below,
  // right before `output.end()`) only executes on NORMAL completion of this function -- there is no
  // top-level try/finally around the rest of runEngine's body. Without this try/catch, a
  // registerMcpServerTools throw (e.g. a genuine, permanent canonical-name collision with a static
  // WS-06 descriptor -- registry.ts's own "already registered by a non-live-MCP mechanism" guard,
  // which is a real, PERMANENT possibility a host can always trigger, not merely a transient bug)
  // would abort runEngine before the teardown loop ever runs, permanently leaking any EARLIER server
  // in this same config.mcpServers that had already registered successfully into the process-wide
  // registry singleton (tools/registry.ts's own header) -- corrupting every subsequent in-memory-leg
  // run sharing this process.
  //
  // T2's own fix round (bc601b0) landed VALIDATE-THEN-COMMIT atomicity inside registerMcpServerTools
  // itself: a single call now either fully succeeds or leaves the registry byte-identical to its
  // pre-call state -- there is no longer any "internal partial-registration orphan" scenario for
  // this catch to worry about at all (that class of bug -- T2's own bug (a) -- no longer exists).
  // What THIS try/catch still does, and is now the WHOLE of its job: when server N's own
  // registerMcpServerTools call throws (atomically, per T2's fix -- server N itself leaves no
  // trace), unregister whatever servers 1..N-1 in THIS SAME loop had already fully registered and
  // been pushed to sdkMcpServerNames, before rethrowing -- a pure blast-radius reducer across
  // MULTIPLE servers in one run, not a defense against any single call's own internal state.
  if (config.mcpServers) {
    try {
      for (const [serverName, serverCfg] of Object.entries(config.mcpServers)) {
        if (serverCfg.type !== "sdk" || !serverCfg.tools || serverCfg.tools.length === 0) continue;
        const toolDefs: McpToolDefinition[] = serverCfg.tools;
        // Phase 4 Task 8 (rider 12, RULING P4-G "custom SDK-server tools are deferred by default when
        // activation is on"): `deferredDefault` flips false -> true, aligning this sdk-wire path with
        // Lane A's own transport-connected registrations (which always used `true`) and closing the
        // asymmetry that lane disclosed as "a real, disclosed asymmetry with T3's own sdk-path choice
        // that nothing in this phase reconciles". A per-tool `_meta["anthropic/alwaysLoad"]` still
        // forces eager (registry.ts's buildMcpToolDescriptor, rider 13), and with Tool Search
        // INACTIVE resolveDeferral collapses `deferred: true` to "eager" anyway -- so a default
        // session's advertised set is byte-identical either way; this only becomes observable once
        // activation is genuinely on, which is exactly when WS-09 §8 says these tools should defer.
        registerMcpServerTools(serverName, toolDefs, { deferredDefault: true });
        sdkMcpServerNames.push(serverName);
        const perServerTimeoutMs = serverCfg.timeout;
        for (const tool of toolDefs) {
          const canonicalName = `mcp__${serverName}__${tool.name}`;
          replaceExecutor(canonicalName, {
            async execute(input: unknown) {
              const timeoutMs = perServerTimeoutMs ?? mcpEnvConfig.toolTimeoutMs ?? 120_000;
              try {
                const result = await bridge.request<{ content?: Array<{ type?: string; text?: string; [k: string]: unknown }>; isError?: boolean }>(
                  "sdk_mcp_call",
                  { server: serverName, tool: tool.name, arguments: input && typeof input === "object" ? input : {} },
                  { timeoutMs },
                );
                const text = (result.content ?? [])
                  .map((block) => (typeof block.text === "string" ? block.text : JSON.stringify(block)))
                  .join("\n");
                return { output: text, ...(result.isError === true ? { isError: true } : {}) };
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { output: `Error: sdk_mcp_call failed for '${canonicalName}': ${message}`, isError: true };
              }
            },
          });
        }
      }
    } catch (err) {
      for (const serverName of sdkMcpServerNames) unregisterMcpServerTools(serverName);
      throw err;
    }
  }

  // --- Phase 4 Task 8 (rider 11): the REAL MCP lifecycle, for a live session ----------------------
  //
  // Lane A's own OWED item #1, verbatim: "runEngine (or a wrapper one layer up) constructing
  // createMcpLifecycle({ servers: resolveMcpServerSources([...]).resolved, envConfig:
  // parseMcpEnvConfig(env), elicitationAsk: createElicitationAsker(bridge), ... }) and calling
  // .start() before the first turn, then threading .stateSource/.controlSeam into the SAME
  // EngineOptions object." It lands HERE rather than in main.ts for the structural reason that
  // report named: `bridge` is a closure-local inside this function, and `ElicitationSender` is
  // deliberately the narrow structural type `{request(...)}` precisely so `bridge` satisfies it with
  // zero adaptation from inside this closure. main.ts could never build one.
  //
  // SOURCE SCOPE (RULING P4-F): Options-level `mcpServers` only -- the `.winter/mcp.json`,
  // settings-declared, and plugin-contributed loaders are WS-11/Phase 5's, and no loader for any of
  // them exists anywhere in this codebase (Lane A verified this by search before building
  // `resolveMcpServerSources` as a pure function over already-supplied sources). Phase 4 ships the
  // precedence/duplicate-name/strictMcpConfig/trust-gate machinery over whatever inputs it is given;
  // this call supplies the one input that exists.
  //
  // PRECEDENCE over the EngineOptions fields: a CALLER-SUPPLIED `mcpServerStateSource`/
  // `mcpControlSeam` always wins. Those are how T3's own contract tests inject fakes, and how a
  // future host that owns its own MCP stack (a daemon managing connections across sessions) hands
  // one in. The engine only builds its own when the caller supplied none AND this session actually
  // declares servers -- so a session with no MCP config is byte-identical to before this wiring
  // (no lifecycle object, `mcp_servers` still absent from both init frames, no golden churn).
  //
  // `trustedWorkspace` is the SAME constant the permission evaluator and hook registry already share
  // (declared once, far above) -- WS-09 §1.2's project-trust gate can never disagree with WS-07
  // §3.2's, because there is exactly one value.
  // Phase 4 fix wave (I1/I2): the key for this run's own SESSION-KEYED side registries (the MCP
  // lifecycle registry and the ToolSearch session runtime). A child engine now shares its parent's
  // `config.sessionId` (WS-10 addressing -- see child-engine.ts's own baseConfig comment), so
  // keying its own registrations by the session id would OVERWRITE the parent's entry at spawn and
  // DELETE it again at the child's teardown. Keyed by the child's own agent key instead, which is
  // also what makes the intended I2 behaviour fall out: a bridge tool executing INSIDE a child
  // looks its lifecycle up by `ctx.sessionId` -- the owning session's -- and therefore sees the
  // PARENT's real MCP state instead of a child-local void.
  const sessionStateKey = config.agentId ?? config.sessionId;
  let mcpLifecycle: McpLifecycle | undefined;
  let disposeSessionMcpLifecycle: (() => void) | undefined;
  // Fix wave follow-up (3), whole-branch review M2: the lifecycle is now built UNCONDITIONALLY, from
  // whatever this session declared -- including nothing at all. Before, a session that declared no
  // servers got no lifecycle, hence no control seam, hence `mcp_set_servers` answering
  // `mcp_unavailable` FOREVER: WS-09 §3's "setMcpServers replaces the configured set live" was
  // unreachable from an empty set, and `winter.mcp` was frozen false at startup with no way back.
  // An empty server list is cheap -- `createMcpLifecycle` allocates a state board and `start()`
  // iterates zero slots.
  //
  // Fix wave follow-up (4), T8-review N2: the gate tests BOTH caller injection points, not just the
  // state source. "Caller-supplied always wins" was documented but half-implemented -- a caller
  // supplying only `mcpControlSeam` alongside declared servers got the engine building and
  // `start()`-ing its own lifecycle (real connections, real child processes) whose control seam was
  // then discarded in favour of the caller's, so the seam a host operated and the connections that
  // actually existed belonged to two different stacks. Supplying either injection point now means
  // "I own the MCP stack" and the engine dials nothing.
  if (mcpServerStateSource === undefined && mcpControlSeam === undefined) {
    // Phase 5 Task 8 (Lane S's "What T8 must wire" item 4): the explicit host source FIRST, then the
    // settings tiers, `.winter/mcp.json`, and plugin manifests -- assembled by `production-wiring.ts`
    // in that order and appended here. `resolveMcpServerSources` breaks a within-origin tie by array
    // order, so the ordering inside `extraMcpServerSources` is load-bearing and lives with the code
    // that documents it. RULING P4-F's "Options-level `mcpServers` only" scope is what this closes.
    const sources: McpServerSource[] = [{ origin: "explicit", servers: config.mcpServers ?? {} }, ...(extraMcpServerSources ?? [])];
    const resolvedSources = resolveMcpServerSources(sources, {
      ...(config.strictMcpConfig !== undefined ? { strictMcpConfig: config.strictMcpConfig } : {}),
      trustedWorkspace,
    });
    // `rejected`/`shadowed` are deliberately NOT surfaced on the wire: no frame shape exists for
    // "this server declaration lost" (WS-09 §1.2's "the losing declaration is reported" needs a
    // reporting channel Phase 4 does not have), and with a single explicit source `shadowed` is
    // empty by construction. A rejected entry simply never becomes a slot -- it is absent from
    // `mcp_servers`, which is itself an observable signal. Recorded as a P5 carry.
    mcpLifecycle = createMcpLifecycle({
      servers: resolvedSources.resolved,
      envConfig: mcpEnvConfig,
      elicitationAsk: createElicitationAsker(bridge),
    });
    // WS-09 §2's three-deadline model lives entirely inside `start()`: an ordinary server connects
    // in the background and this returns immediately; `MCP_CONNECTION_NONBLOCKING=0` or an
    // `alwaysLoad` server makes it wait, bounded by MCP_CONNECT_TIMEOUT_MS. Awaited BEFORE the init
    // frame is written so `mcp_servers` reflects the batch snapshot the spec describes.
    await mcpLifecycle.start();
    // The four WS-09 §1.4 bridge tools resolve their lifecycle out of this session-keyed registry
    // (see mcp/lifecycle.ts's own header for why it is session-keyed rather than a module singleton
    // or a per-run replaceExecutor). Cleared in teardown, below.
    disposeSessionMcpLifecycle = registerSessionMcpLifecycle(sessionStateKey, mcpLifecycle);
  }
  // From here on, ONE resolved pair for the whole run -- the pump's own MCP control dispatch and the
  // init frames both read these, never `opts.*` directly, so caller-supplied and engine-built are
  // indistinguishable downstream.
  const effectiveMcpStateSource: McpServerStateSource | undefined = mcpServerStateSource ?? mcpLifecycle?.stateSource;
  const effectiveMcpControlSeam: McpControlSeam | undefined = mcpControlSeam ?? mcpLifecycle?.controlSeam;

  // Fix wave follow-up (3): "does this session actually HAVE MCP", re-derived LIVE.
  //
  // THE TRAP this exists for, stated plainly because getting it wrong is invisible in a unit test and
  // loud in the golden corpus: the first round's B-M1 derived `hasMcpServers` from
  // `effectiveMcpStateSource !== undefined`, which was exactly right while the lifecycle was
  // conditional. Building it unconditionally (above) makes that predicate ALWAYS true, which would
  // advertise the whole `winter.mcp` family in every session and churn every committed `init.tools`
  // golden -- contradicting the 24-tool capture that gated the family in the first place. So the fact
  // is the LIVE SLOT COUNT instead: a caller-supplied state source (a host that owns its own MCP
  // stack -- B-M1's case, preserved) or at least one real slot on the state board.
  //
  // A FUNCTION, not a value: `mcp_set_servers` can add the session's first server mid-run, and every
  // consumer that can honour a live answer does (the dispatch-time availability check and the
  // ToolSearch session runtime, both below). `system/init.tools` cannot -- it is written once, before
  // the turn loop, and no re-init frame exists in this protocol (rider 5's recorded gap) -- so the
  // startup snapshot keeps the value it had, which is what keeps the goldens byte-identical.
  //
  // RULING P4-N (residual round): the predicate is the LIVE SLOT COUNT ALONE, at every nesting level.
  // The previous form also short-circuited on "a caller supplied a state source", on the heuristic
  // that such a caller owns an MCP stack. Lane X's I2 made that heuristic false for the commonest
  // caller there is: a PARENT engine hands its own board down through `getParentMcpState()`, and
  // after M2 every parent has one -- so a child of a ZERO-MCP session derived `winter.mcp` from an
  // empty board. Harmless in practice (the child's inherited-pool deny complement bare-denies the
  // family three separate ways) but wrong in principle, and exactly the kind of "true for a reason
  // that no longer holds" the capture-driven gate exists to prevent. Counting slots is uniform:
  // a host that owns its stack and has servers still reports them, and an empty board is an empty
  // board whoever owns it.
  const sessionHasMcp = (): boolean => (effectiveMcpStateSource?.snapshot().length ?? 0) > 0;

  // `init` MUST be the first runtime→host frame (WS-04 §4.1 `initializing`), from resolved runtime
  // state. T8 (WS-06 §6 obligation 1): the advertised tool list is no longer hardcoded empty --
  // buildAdvertisedSet's own header comment named this exact wiring as "T8's own job... once every
  // lane's real executor/capability story exists to describe", which is now true (all five P3 lanes
  // merged).
  //
  // Part B item 1 (fix wave, P3 close-out): `familyMetadata`/`capabilities`/`toolSearchEnabled`/
  // `insideSubagent` are now threaded from `config` (RuntimeConfig's own wire mirrors, options.ts's
  // own header for the full rationale) rather than left permanently unset -- a session with none of
  // these configured sees byte-identical behavior to before this fix (every field's own documented
  // absent-default: no capabilities supplied -> every capability-gated descriptor stays excluded,
  // exactly as it always was; absent familyMetadata reads as "not task-native", i.e. shown; absent
  // toolSearchEnabled/insideSubagent are simply not known-true). A real CATALOG-DERIVED resolution
  // story for any of these (the provider catalog's family metadata [WS-13]; MCP-server-derived
  // capability tokens [WS-09]) is still a LATER phase's own job -- this is only the wire-to-
  // buildAdvertisedSet plumbing a host can already use directly (e.g. supplying
  // `capabilities: ["winter.reviewer-model"]` today makes `mcp__winter__advisor` advertisable, per
  // I4's own capability-token precedent). `disallowedTools` threads the run's own deny-grammar
  // config straight through, matching what the permissions engine already sees from the same
  // `config` object -- RuntimeConfig carries no separate "requested tool config" allowlist distinct
  // from `allowedTools` (which stays OUT of this call by design: AdvertisedSetInputs.allowedTools
  // exists for documentation only, and a test in registry.test.ts pins that buildAdvertisedSet must
  // never filter on it -- §1.3's pre-approval-is-not-a-visibility-allowlist rule), so `cfg.tools` is
  // left unset here (its documented default: "no restriction on this axis").
  // Phase 4 Task 3 (RULING P4-A): ONE resolved DeferralActivation is the single "Tool Search on"
  // authority for this whole run -- `config.toolSearchEnabled` (the pre-existing P3 host-facing wire
  // boolean) folds in as an EXPLICIT OVERRIDE of `enableToolSearch` when the host set it, taking
  // precedence over the ambient `ENABLE_TOOL_SEARCH` env var; when the host left it unset, the env
  // var (or its own "unset" default) governs. This closes T2's own report Concern 8 (two
  // independent, un-reconciled "is Tool Search on" signals) by making the wire boolean ONE INPUT
  // INTO the single activation resolution, never a second, independently-consulted gate.
  const enableToolSearch: DeferralActivation["enableToolSearch"] =
    config.toolSearchEnabled === true ? "true" : config.toolSearchEnabled === false ? "false" : mcpEnvConfig.enableToolSearch;
  const deferralActivation: DeferralActivation = {
    enableToolSearch,
    providerSupportsToolSearch: providerSupportsToolSearch ?? true,
    deferrableContextShare: deferrableContextShare ?? 0,
  };
  // The SAME activation value derives BOTH readings from here on -- resolveDeferral's own per-
  // descriptor verdicts (via partitionAdvertisedTools, below) and this session-wide boolean can
  // never disagree, because both are, structurally, calls into isDeferralActive (registry.ts).
  const toolSearchEnabledDerived = isDeferralActive(deferralActivation);

  // Phase 4 Task 3 (WS-09 §8.5): per-session Tool Search bookkeeping -- which deferred tools have
  // been materialized this session (ToolSearch's own successful-selection consequence, Lane B's
  // future tool executor). Declared here (not module-level) since it is genuinely per-session state,
  // mirroring LoadedToolSet's own "NOT a singleton" header.
  // --- Phase 5 Task 3 (R5-10): structured output ----------------------------------------------------
  //
  // Registered ONLY when `outputFormat` is set, and unregistered at teardown -- the descriptor
  // registry is a process-wide singleton (registry.ts's own header), so a per-session,
  // per-caller-schema descriptor that outlived its run would advertise another session's schema.
  // Capture (4) is the pin for the gating: the default advertised set is 24 tools and
  // `StructuredOutput` is NOT among them; capture (6) observed 25 with it, once `outputFormat` was set.
  //
  // `outputFormat` with no seam is a hard, VISIBLE failure rather than a silent degrade -- see
  // EngineOptions.structuredOutput.
  // Registered HERE, ahead of `loadedToolSet`/`advertisedCfg`, because the advertised set that feeds
  // the `system/init` frame is computed from the registry a few lines below -- a registration placed
  // with the rest of the P5 turn-loop helpers advertised nothing on the first turn (observed, not
  // reasoned: the contract test's own init-frame assertion caught it).
  // Phase 5 Task 3 (R5-11): read once, here, so every consumer (the interception check, the terminal
  // result's `user_message_uuid`, the `rewind_files` handler) agrees about whether this session is
  // checkpointing at all.
  const enableFileCheckpointing = config.enableFileCheckpointing === true;

  const outputFormatSchema = config.outputFormat?.schema as JSONSchema | undefined;
  const structuredOutputActive = outputFormatSchema !== undefined;
  const maxStructuredOutputAttempts = resolveMaxStructuredOutputAttempts(engineEnv ?? process.env);
  let disposeStructuredOutputTool: (() => void) | undefined;
  if (structuredOutputActive && structuredOutput !== undefined) {
    disposeStructuredOutputTool = registerHostGeneratedTool({ descriptor: structuredOutput.buildDescriptor(outputFormatSchema) });
  }

  // --- Phase 5 Task 8 (rider 21): THE WORKFLOW SESSION REGISTRATION ------------------------------
  //
  // Lane W's second NEEDS_CONTEXT item, and the second of the three legs its report says must land
  // together. Without it the Workflow tool answers a typed "no workflow runtime is configured for
  // this session" -- installed, advertised, and inert.
  //
  // IT LIVES HERE AND NOT IN `production-wiring.ts` because three of its five ingredients are
  // closure-local to this function and unreachable from one level up: `resolveSessionTempPaths()`
  // (memoized per run against this session's own cwd/id -- the SAME memo `ToolExecutionContext.
  // tempDir` reads, so a workflow journal and a tool's scratch land under one root),
  // `contextAccountant` (caller-supplied or built here), and `structuredOutput` (the session's own
  // seam instance, shared so the workflow's `agent({schema})` uses one compiled-validator cache).
  //
  // `resolveAgentType` mirrors `tools/impl/agent.ts:296` exactly, INCLUDING its `home: permissionHome`
  // -- the OS home, never `winterHome`, because `loadAgentDefinitions` joins `.winter/agents` itself.
  // Handing it the resolved winter root would silently find an empty user tier. (Fix-wave item 6 is
  // the deliberate, separate change that moves BOTH call sites onto the resolved root; doing it here
  // alone would make the Workflow tool and the Agent tool disagree about which definitions exist.)
  //
  // `spentTokens` is DELIBERATELY OMITTED: RULING P5-J's cumulative counter does not exist yet, and
  // `contextAccountant.contextTokens()` is the last call's context SIZE -- an overwrite, not an
  // accumulation, and blind to a workflow's own child agents. `budget.spent()` therefore reports an
  // honest 0 rather than a plausible wrong number, exactly as Lane W's own disclosure states.
  const workflowWinterHome = structuredOutput !== undefined ? (wiredWinterHome ?? config.winterHome) : undefined;
  // I5: held so teardown withdraws THIS registration and not whichever one is current.
  let disposeWorkflowSession: (() => void) | undefined;
  if (workflowWinterHome !== undefined && structuredOutput !== undefined) {
    // I5 (Lane Y, fix wave): the registry is SESSION-KEYED now, and the registration returns an
    // IDENTITY-CHECKED disposer. Both matter, for different reasons:
    //
    //   * `sessionId` -- without it every session lands in one legacy slot, so in a daemon serving
    //     two live sessions B's workflows run against A's `projectKey`/accountant/seam and A's
    //     teardown disables B.
    //   * the DISPOSER, never `clearWorkflowSession(config.sessionId)`. A child engine reaches this
    //     site with its PARENT's `config.sessionId` (it is handed the parent's structured seam,
    //     which is exactly what this site gates on), so a by-key clear at a child's teardown would
    //     delete its still-running parent's entry. First-wins protects the registration; only the
    //     identity-checked disposer protects the withdrawal.
    //
    disposeWorkflowSession = registerWorkflowSession({
      sessionId: config.sessionId,
      winterHome: workflowWinterHome,
      projectKey: resolveProjectDirName(compatibilityKeys(config.cwd).transcriptProjectKey, engineEnv ?? process.env),
      sessionTempDir: resolveSessionTempPaths().root,
      structured: structuredOutput,
      accountant: contextAccountant,
      // RULING P5-J (fix wave): the cumulative counter now EXISTS, so `budget.spent()` reads a real
      // number instead of the honest 0 Lane W had to ship. It is the whole tree's spend -- a child
      // engine rolls its own generations up through `ChildEngineRunContext.recordDescendantUsage` --
      // which is what makes a workflow `budget` bound the work its AGENTS do rather than only the
      // parent's own turns.
      spentTokens: () => contextAccountant.spentTokens(),
      resolveAgentType: (agentType, ctx) =>
        loadAgentDefinitions({
          home: permissionHome,
          cwd: ctx.cwd,
          trustedWorkspace: ctx.trustedWorkspace,
          ...(config.agents !== undefined ? { programmatic: config.agents as Record<string, PluginAgentDefinition> } : {}),
          ...(getPluginAgents(config.sessionId) !== undefined ? { pluginAgents: getPluginAgents(config.sessionId) as Record<string, PluginAgentDefinition> } : {}),
        }).get(agentType),
    });
  }

  const loadedToolSet: LoadedToolSet = createLoadedToolSet();

  // T8 (WS-06 §6 obligation 1): the advertised tool list is no longer hardcoded empty --
  // buildAdvertisedSet's own header comment named this exact wiring as "T8's own job... once every
  // lane's real executor/capability story exists to describe", which is now true (all five P3 lanes
  // merged).
  //
  // Part B item 1 (fix wave, P3 close-out): `familyMetadata`/`capabilities`/`insideSubagent` are
  // threaded from `config` (RuntimeConfig's own wire mirrors, options.ts's own header for the full
  // rationale) rather than left permanently unset -- a session with none of these configured sees
  // byte-identical behavior to before this fix (every field's own documented absent-default: no
  // capabilities supplied -> every capability-gated descriptor stays excluded, exactly as it always
  // was; absent familyMetadata reads as "not task-native", i.e. shown; absent insideSubagent is
  // simply not known-true). `toolSearchEnabled` is now DERIVED (RULING P4-A, above) rather than a
  // raw config passthrough -- WaitForMcpServers is advertised iff activation is OFF, by construction.
  // `disallowedTools` threads the run's own deny-grammar config straight through, matching what the
  // permissions engine already sees from the same `config` object -- RuntimeConfig carries no
  // separate "requested tool config" allowlist distinct from `allowedTools` (which stays OUT of this
  // call by design: AdvertisedSetInputs.allowedTools exists for documentation only, and a test in
  // registry.test.ts pins that buildAdvertisedSet must never filter on it -- §1.3's
  // pre-approval-is-not-a-visibility-allowlist rule), so `cfg.tools` is left unset here (its
  // documented default: "no restriction on this axis").
  // Phase 4 Task 8 (rider 1): the three P4 family tokens (winter.mcp / winter.subagents /
  // winter.global-messaging) are now RUNTIME-DERIVED rather than host-supplied -- see
  // registry.ts's own RUNTIME_DERIVED_CAPABILITIES header for the full argument (they were I4-era
  // placeholders for "no executor exists yet", and Phase 4's lanes shipped every one of those
  // executors). Host-supplied tokens union on top, never replaced: `winter.reviewer-model`, `pwsh`,
  // `mcp:<server>` and anything else a host knows about keep working exactly as before, and a
  // derived token cannot be turned off by omitting it (suppressing a tool the runtime genuinely has
  // is `disallowedTools`' job, WS-07 §3). Computed ONCE here and reused by the dispatch-time
  // availability check (buildDefaultToolExecutor's getAvailabilityInputs, which spreads this same
  // object) and by the ToolSearch session runtime below -- one authority, never three derivations.
  // T8-review M1 (fix wave): the fact is derived from the EFFECTIVE state source, the very same
  // value `init.mcp_servers` is built from a few lines below -- never from `config.mcpServers` alone.
  // Those two disagreed for exactly one input: a host that injects `mcpServerStateSource` WITHOUT
  // declaring servers (the daemon-owns-the-MCP-stack case the precedence block above exists for) got
  // a populated `mcp_servers` on the wire while every winter.mcp tool stayed unadvertised AND was
  // refused at dispatch by rider 27's availability check. Equivalent to the old predicate for every
  // other input by construction: the engine builds `mcpLifecycle` (hence a state source) exactly when
  // no source was supplied and `config.mcpServers` is non-empty.
  const resolveLiveSessionCapabilities = (): string[] => resolveSessionCapabilities(config.capabilities, { hasMcpServers: sessionHasMcp() });
  // The STARTUP snapshot, for `init.tools` and the advertised partition (see sessionHasMcp above for
  // why this one cannot be live).
  const sessionCapabilities = resolveLiveSessionCapabilities();
  // Phase 4 Task 8 (rider 3, WS-09 §10 / RULING P4-E): the Winter branch's own canonical alias pair.
  // WS-10 §15 names it verbatim -- [WS-14] redirects the model-visible `SendMessage`/`ListAgents`
  // built-ins at `mcp__winter__send_message`/`mcp__winter__list_agents`. On the WINTER branch those
  // canonical names are real, registered descriptors (descriptors/winter-*.ts, `deferred: true` at
  // the source) backed by the SAME executor objects as the native names, so WS-09 §10's
  // "the model normally sees ONE SendMessage" is a Winter-branch obligation that holds whether or not
  // a host configured `Options.toolAliases` at all.
  //
  // *** SUPERSEDED, fix wave / RULING P4-E AMENDED (2026-09-04). *** T8 shipped a deliberate SPLIT
  // here: the default table fed duplicate suppression ONLY and was kept out of permission/hook
  // identity, on the argument that folding it in would silently stop `disallowedTools:
  // ["SendMessage"]` from matching. The whole-branch review found the split's own escape hatch
  // (CRITICAL C2): suppression keyed on the NATIVE name being advertised, so denying the native
  // DISABLED suppression and `mcp__winter__send_message` surfaced eager, executing the same executor
  // with no deny rule and no hook matcher matching it. The argument was right about the hazard and
  // wrong about the remedy -- the fix is not to withhold identity mapping but to make it
  // BIDIRECTIONAL and strictest-of (`resolvePermissionIdentity`, toolsearch/aliases.ts): a rule
  // naming EITHER spelling governs both, so `disallowedTools: ["SendMessage"]` keeps matching AND
  // the twin can no longer be the way around it. The table itself now lives in `toolsearch/aliases.ts`
  // (`WINTER_CANONICAL_ALIASES`), read by three consumers -- this partition, ToolSearch's own
  // candidate pool, and the identity resolution at the dispatch loop below.
  //
  // Dispatch still never redirects: `call.name` alone drives registry lookup, execution and the
  // load-first predicate (P4-E, unamended).
  //
  // Host entries win on collision (a host that redirects `SendMessage` somewhere else means it).
  const suppressionAliasTable: Record<string, string> = effectiveAliasTable(config.toolAliases);
  // Phase 4 Task 8 (rider 5) -- the init.tools-vs-live-mode freeze, INVESTIGATED and recorded rather
  // than "fixed", because there is nothing here to fix without a protocol addition.
  //
  // Lane B observed that `advertisedCfg.mode` is captured ONCE, here, while its own
  // `ToolSearchDeps.getMode()` and this engine's own `isDeferredAndUnloaded`/`isToolAvailable` checks
  // all read the mode LIVE per call -- so a mid-session `setPermissionMode`/ExitPlanMode makes a live
  // ToolSearch result diverge from the frozen `init.tools` snapshot. Confirmed by reading the code:
  // `system/init` (and its `data`-wrapped twin) is written exactly ONCE per runEngine, before the
  // turn loop, and NOTHING in this runtime emits a second one -- there is no re-init/refresh frame in
  // the protocol at all (WS-09 §11 item 2's own "the next turn's system/init.tools reflects the
  // mutation" has the same missing observable; mcp/conformance.test.ts's row WS09-2c defers it for
  // exactly this reason).
  //
  // So the asymmetry is not a bug in either half -- it is "a startup SNAPSHOT vs. a live CHECK", and
  // the live side is the one that must stay honest, because it governs what actually executes. A
  // frozen live check would let a tool excluded by the CURRENT mode still run; a live init frame has
  // nowhere to be delivered. Freezing the live readers to match the snapshot would be strictly worse.
  // The real fix is a re-init/refresh frame, which is a protocol addition a later phase owns.
  const advertisedCfg = {
    mode: policyStateStore.getState().mode,
    platform: process.platform,
    ...(config.disallowedTools !== undefined ? { disallowedTools: config.disallowedTools } : {}),
    capabilities: sessionCapabilities,
    toolSearchEnabled: toolSearchEnabledDerived,
    ...(config.insideSubagent !== undefined ? { insideSubagent: config.insideSubagent } : {}),
    ...(config.familyMetadata !== undefined ? { familyMetadata: config.familyMetadata } : {}),
  };
  // RULING P4-A: resolveDeferral wired into buildAdvertisedSet's own output -- the advertised set is
  // partitioned into EAGER (always advertised), DEFERRED (searchable; callable only after
  // LoadedToolSet.load), and HIDDEN. Every EXISTING static WS-06 descriptor sets no `deferred` field
  // at all (only a LIVE MCP registration does, via registerMcpServerTools's own factory), so for
  // every scenario that registers no MCP server, `partition.eager` is EXACTLY `buildAdvertisedSet`'s
  // own pre-existing output and `partition.deferred`/`partition.hidden` are empty -- byte-identical
  // to every committed differential golden by construction, not by coincidence.
  //
  // Phase 4 Task 8 (rider 3, WS-09 §10 "Duplicate suppression"): the partition is post-processed so
  // the model "normally sees ONE SendMessage and ONE ListAgents". `suppressAliasedDuplicates` moves
  // an alias TARGET that is currently eager into `deferred` whenever its SOURCE name is also
  // advertised -- never removes it (WS-09 §10: "keeps the canonical entry deferred", not hidden; a
  // model that already knows the exact canonical name can still ToolSearch-select it).
  //
  // Fix wave (C2): `disallowedTools` is now threaded in as well, so the same call ALSO runs the
  // alias-EXCLUSION pass -- a twin whose native spelling this session denied/excluded is moved to
  // `hidden` (never eager, never searchable) rather than left to surface because suppression's own
  // "is the source advertised?" precondition failed. See hideAliasExcludedTwins for both directions.
  const advertisedPartition = suppressAliasedDuplicates(
    partitionAdvertisedTools(advertisedCfg, deferralActivation),
    suppressionAliasTable,
    config.disallowedTools,
  );
  currentAdvertisedCanonicalNames = [...advertisedPartition.eager, ...advertisedPartition.deferred].map((d) => d.canonicalName);
  // Phase 4 Task 3 (MUST 6, WS-09 §8.2/§8.5): the execution-boundary "load ≠ permission" check --
  // registry.ts's own exported isLoadFirstBlocked (re-derived from the LIVE registry per call, never
  // a frozen startup snapshot, so a server registered/reconnected mid-session is covered too;
  // exported specifically so the seam contract tests exercise this IDENTICAL code path, not a
  // re-implementation).
  // NEW-5 (residual round): "was this name taken away by the ALIAS-EXCLUSION pass, and why" --
  // recomputed live against the CURRENT mode, exactly like `isDeferredAndUnloaded` below, so a
  // mid-session mode switch is reflected on the very next call. Recomputing the partition here is
  // the point: asking the same function the advertisement path asks is what keeps the dispatch
  // refusal and the advertised set from ever disagreeing about why a name is missing.
  function aliasExclusionLive(toolName: string): string | undefined {
    const live = partitionAdvertisedTools({ ...advertisedCfg, mode: policyStateStore.getState().mode }, deferralActivation);
    const exclusion = aliasExclusionReasons(live, suppressionAliasTable, config.disallowedTools).get(toolName);
    // ONLY the twin-of-an-excluded-native direction is refused here. The other direction (a source
    // whose alias TARGET is bare-denied) deliberately falls through to the permission pipeline,
    // where a real rule denies it -- that produces a `permission_denied` frame and a
    // `result.permission_denials` entry, which is strictly more informative than an
    // availability-class refusal and is what the C2 fixtures pin.
    return exclusion?.cause === "native-excluded" ? exclusion.reason : undefined;
  }
  function isDeferredAndUnloaded(toolName: string): boolean {
    return isLoadFirstBlocked(toolName, policyStateStore.getState().mode, deferralActivation, loadedToolSet);
  }
  // WS-09 §8.5 "Ground truth... the live request's tools array": `system/init.tools` = eager PLUS
  // whichever deferred names are ALREADY loaded this session (none, at startup -- a fresh
  // LoadedToolSet.snapshot() is always `[]`, so this composition is presently equivalent to `eager`
  // alone; it becomes observable once a later system/init-refresh reflects a ToolSearch selection,
  // Lane B's own future wiring).
  // Phase 4 Task 8 (rider 2, WS-09 §8.2/§8.4): register THIS run's own ToolSearch/WaitForMcpServers
  // session runtime. Lane B's executors read a session-keyed side registry rather than a
  // ToolExecutionContext field, because (unlike "one child-engine implementation for the whole
  // process") MCP state and deferral activation are genuinely per-session -- see
  // toolsearch/search.ts's own header. Placed HERE, not inside `buildDefaultToolExecutor`, for the
  // ordering hazard Lane B's own report named: that function is CALLED before `deferralActivation`
  // and `mcpServerStateSource` are in scope. `getMode` reads the LIVE policy on every call (a
  // ToolSearch result must never be computed against a stale mode); `capabilities` is the SAME
  // resolved token set the advertised partition used, never a second derivation.
  //
  // Unregistered in this run's own teardown (below): the registry is keyed by session id in a
  // process-wide module singleton, so a long-lived host running many sessions would otherwise leak
  // one entry per run.
  const disposeToolSearchSessionRuntime = registerToolSearchSessionRuntime(sessionStateKey, {
    getMode: () => policyStateStore.getState().mode,
    activation: deferralActivation,
    platform: process.platform,
    // Fix wave follow-up (3): a GETTER, so ToolSearch ranges over a pool that reflects a server added
    // mid-run -- the same live-vs-frozen argument as `getAvailabilityInputs` above, and the same trick
    // registry.ts already uses for `ToolExecutionContext.tempDir`. Satisfies `capabilities?: readonly
    // string[]` structurally, so no interface changes.
    get capabilities() {
      return resolveLiveSessionCapabilities();
    },
    ...(config.disallowedTools !== undefined ? { disallowedTools: config.disallowedTools } : {}),
    ...(config.insideSubagent !== undefined ? { insideSubagent: config.insideSubagent } : {}),
    ...(config.familyMetadata !== undefined ? { familyMetadata: config.familyMetadata } : {}),
    // Fix wave, follow-up (1) / RULING P4-E amended: the HOST's own alias table, so ToolSearch's
    // candidate pool runs the SAME alias-exclusion pass `init.tools` does. Without it, a
    // host-configured alias edge whose native is denied was suppressed from `init.tools` and still
    // returned by `select:` -- one hop from callable. (The Winter-branch DEFAULT canonical pair was
    // never exposed this way: `hideAliasExcludedTwins` applies it unconditionally.)
    ...(config.toolAliases !== undefined ? { toolAliases: config.toolAliases } : {}),
    ...(effectiveMcpStateSource !== undefined ? { stateSource: effectiveMcpStateSource } : {}),
  });

  const loadedNames = new Set(loadedToolSet.snapshot());
  const advertisedToolNames = [
    ...advertisedPartition.eager.map((d) => d.advertisedName),
    ...advertisedPartition.deferred.filter((d) => loadedNames.has(d.canonicalName)).map((d) => d.advertisedName),
  ];
  // WS-09 §2.1/§3: the live MCP server connection-state snapshot, wire-mapped (T1's Open Question 5
  // spelling: needsAuth -> 'needs-auth'). Conditionally present -- absent whenever no state source
  // is configured for this run (every session before Lane A's own real transports exist, and every
  // pre-existing test/golden), keeping every committed differential golden byte-identical.
  //
  // Handoff note (fix round 1, T3 review minor, item 4) -- CLOSED, corrected in the P4 fix wave's
  // stale-comment sweep (KNOWN item 8): an SDK MCP server DOES produce an entry here now. RULING
  // P4-C's state-only feed path (`feedSdkSlotConnected`, mcp/lifecycle.ts) reports an in-process
  // SDK server as `connected` with no transport at all, and the decision this note said was owed is
  // made and proven: `mcp_servers: [{name, status:"connected"}]` is asserted on every leg by the
  // rider-6 equivalence scenario and pinned in the `mcp-tool-round` golden.
  // Fix wave follow-up (3): gated on `sessionHasMcp()`, not on the state source merely EXISTING --
  // an unconditionally-built empty lifecycle must not start putting `mcp_servers: []` on a wire that
  // omitted the key entirely. (A caller-supplied state source always reports, even when its snapshot
  // is empty: that is a host declaring it owns the MCP stack.)
  const mcpServersWire = sessionHasMcp() && effectiveMcpStateSource ? mcpServerStatesToWire(effectiveMcpStateSource.snapshot()) : undefined;
  output.write({
    type: "init",
    protocolVersion: PROTOCOL_VERSION,
    sessionId: config.sessionId,
    cwd: config.cwd,
    model: config.model,
    permissionMode: policyStateStore.getState().mode,
    tools: advertisedToolNames,
    ...(mcpServersWire !== undefined ? { mcp_servers: mcpServersWire } : {}),
  });
  // Phase 5 Task 2 (derived-shapes-p5.md item (b), `sdk.d.ts:4853-4913`): the loaded-surface fields.
  // Emitted with WINTER DEFAULTS, unconditionally -- `output_style` and `skills` are REQUIRED on the
  // pin, so a conditional spread (the convention `mcp_servers` above uses precisely to keep goldens
  // byte-identical) would leave the frame diverging on shape.
  //
  // PHASE 5 TASK 8 (rider 4) POPULATES ALL FOUR from `production-wiring.ts`'s real producers --
  // Lane S's `slashCommandNames(resolver, cwd)` / skill index / `pluginInitInfo(bundles)`, and Lane
  // C's resolved style. Each falls back to its T2 default when the wiring is absent (every
  // engine-level unit test, and any host driving `runEngine` directly), so those callers stay
  // byte-identical.
  //
  // `slash_commands` is taken WHOLE from the producer and never prepended to: `slashCommandNames`
  // already emits the engine's own built-in `/compact` first, and prepending it here would advertise
  // it twice. `terminal_slash_commands` is optional on the pin and stays absent: it is the subset of
  // commands bound to a local terminal, which Winter has no surface for.
  const initLoadedSurface = {
    slash_commands: initSlashCommands !== undefined ? [...initSlashCommands] : ([] as string[]),
    output_style: initOutputStyle ?? config.outputStyle ?? DEFAULT_OUTPUT_STYLE,
    skills: initSkills !== undefined ? [...initSkills] : ([] as string[]),
    plugins: initPlugins !== undefined ? [...initPlugins] : ([] as InitPluginInfo[]),
  };
  output.write({
    type: "data",
    message: {
      type: "system",
      subtype: "init",
      session_id: config.sessionId,
      cwd: config.cwd,
      model: config.model,
      permissionMode: policyStateStore.getState().mode,
      tools: advertisedToolNames,
      // Phase 6 Task 10 (derived-shapes-p6 item (d)): the pinned REQUIRED `apiKeySource`
      // (`sdk.d.ts:4860`). Winter emitted no such field before this phase, which was a real parity
      // gap rather than a deliberate omission -- a consumer switching on it read `undefined`.
      apiKeySource: apiKeySource ?? "none",
      // R6-9: the RESOLVED identity rides a Winter-only init EXTENSION, never `model` -- which stays
      // the pinned bare string the caller passed, because the goldens byte-compare it. Absent for a
      // session with no resolved identity (a scripted double, every pre-P6 session), so nothing
      // fabricates a provider row.
      ...(providerIdentity !== undefined
        ? {
            winter_provider: {
              providerId: providerIdentity.providerId,
              modelKey: providerIdentity.modelKey,
              ...(providerIdentity.adapterId !== undefined ? { adapterId: providerIdentity.adapterId } : {}),
              ...(providerIdentity.adapterVersion !== undefined ? { adapterVersion: providerIdentity.adapterVersion } : {}),
              ...(providerIdentity.catalogVersion !== undefined ? { catalogVersion: providerIdentity.catalogVersion } : {}),
              ...(providerIdentity.continuationDomain !== undefined ? { continuationDomain: providerIdentity.continuationDomain } : {}),
              ...(providerIdentity.authRefKind !== undefined ? { authRefKind: providerIdentity.authRefKind } : {}),
            },
          }
        : {}),
      ...initLoadedSurface,
      ...(mcpServersWire !== undefined ? { mcp_servers: mcpServersWire } : {}),
    },
  });

  const userFrames = new Queue<UserFrame>();
  // Non-null exactly while a turn is turn_active; the pump calls it (a no-op while idle) when an
  // `interrupt` control request arrives. Kept as a plain callback rather than an AbortController
  // because Provider/ToolExecutor take no signal at P1 (see raceInterrupt above). A ref OBJECT
  // rather than a bare `let`: TS's control-flow narrowing carries the `null` seen at this
  // declaration into the pump closure below and never widens it back across that closure's
  // internal `await`s (a known CFA limitation with values mutated by a second, concurrently
  // -running closure) — `.current` on an object sidesteps that narrowing.
  const interruptCurrentTurn: { current: (() => void) | null } = { current: null };

  // Ruling P2-B: an explicit, engine-controlled shutdown signal for the pump — resolved exactly
  // once, from OUTSIDE the pump (after the turn loop below fully drains; see that call site's own
  // comment) — because a `for await` loop can only be `break`-ed by code physically inside it, and
  // "stop reading, from outside, once we know it's safe" has no other expression. See the pump's
  // own header comment (just below) for the full re-argued termination guarantee this replaces.
  let stopReading!: () => void;
  const stopSignal = new Promise<void>((resolve) => {
    stopReading = resolve;
  });

  // The ONLY reader of `input` (WS-04 §4.1). Decoupling "read a frame" from "process a turn" is
  // what lets `interrupt`/`end_input` land WHILE a turn is blocked awaiting the provider or a tool
  // — a single sequential `for await` over `input` could never observe a new frame until the
  // blocked call happened to settle on its own, which would make interrupt meaningless.
  //
  // *** Ruling P2-B — the two-sided end_input fix, engine side (WS-04 §1: fix BOTH sides together
  // or the topologies diverge; see query.ts's own stdin.end() relocation for the wrapper side) ***
  // Before this ruling, `end_input` made the pump `break` outright — the ONLY reader of `input`
  // stopped reading ANY further frame, including a `control_response` answering a runtime-
  // originated permission RPC (T8). A single-shot query sends its one prompt, then `end_input`,
  // essentially immediately — almost always BEFORE the tool call that needs a permission decision
  // has even run. With the old `break`, that permission RPC's `bridge.request()` (no park timeout,
  // WS-04 §3) then awaited a `control_response` the pump had already stopped listening for: a
  // structural deadlock, not a timing accident — the RPC could not have been answered no matter how
  // fast the host replied, because engine.ts itself was no longer reading.
  //
  // The fix inverts what `end_input` means to this loop: it now means "no more USER envelopes" —
  // `userFrames.end()`, below — NOT "stop reading frames." The pump keeps routing every other frame
  // kind (control_response above all) for as long as the turn loop might still need one delivered.
  //
  // Termination, RE-ARGUED for the new direction (P1's own guarantee — "the pump always reaches its
  // own teardown, which always ends userFrames, which always ends the turn loop" — assumed end_input
  // ended the pump, which is exactly the assumption this ruling retires):
  //   1. `userFrames` ending is now guaranteed by TWO independent paths, either sufficient on its
  //      own: (a) `input` truly ends on its own (real stdin EOF / process death — unchanged from
  //      P1; the pump's own `finally` below still runs on ANY exit, ending userFrames exactly as
  //      before), or (b) an explicit `end_input` frame arrives, calling `userFrames.end()` directly
  //      — independent of whether `input` itself ever ends.
  //   2. Given `userFrames` ends, the turn loop (`for await (const userFrame of userFrames)`,
  //      further down) is GUARANTEED to eventually finish draining every already-queued turn and
  //      exit its own for-await — each turn's processing is fully awaited in sequence before the
  //      loop advances, so "the loop exits" and "no turn is still mid-flight, awaiting anything
  //      (including a bridge response)" are the same fact.
  //   3. What NOW guarantees the pump itself ends (the piece P1's argument no longer supplies):
  //      engine completion EXPLICITLY cancels the pump's read — `stopReading()` is called (see its
  //      call site below) ONLY after the turn loop's own for-await has exited, i.e. only once (2)
  //      already holds. There is no cycle: stopping the pump is strictly sequenced to happen after
  //      the turn loop provably has no more work, so cancelling it can never orphan an in-flight
  //      bridge request. If `input` already ended on its own before the turn loop drains (no
  //      end_input, true EOF — path (a) above), the pump has already exited by then and the later
  //      `stopReading()` call is a harmless, already-redundant no-op (resolving an unobserved
  //      promise).
  //   4. Point 3 is where "the pump ends" is proven; it is NOT yet where "runEngine returns" is
  //      proven, because a no-park-timeout bridge.request() (WS-04 §3, Task 8's permission RPC) can
  //      be mid-flight precisely on path (a) — true EOF racing ahead of the turn loop, rather than
  //      end_input's own turn-loop-drains-first sequencing. The pump's own `finally` (below) closes
  //      this: it calls `bridge.rejectAllPending(...)` unconditionally on every exit. On the `stop`
  //      path this is a verified no-op (point 3's invariant already guarantees no request is
  //      pending); on the true-EOF path it is what turns an otherwise-permanent hang into a clean
  //      denial (prompt-stage.ts's rejection handling + Ruling P2-I), letting the stuck turn — and
  //      therefore runEngine itself — complete. (Found by review — see the `finally` block's own
  //      comment for the full mechanism.)
  // Manually driving the iterator (rather than `for await`) is what makes racing it against
  // `stopSignal` possible at all — `for await` offers no hook to await "the next value OR a stop
  // signal, whichever comes first."
  const pump = (async () => {
    const iterator = input[Symbol.asyncIterator]();
    try {
      while (true) {
        const outcome = await Promise.race([
          iterator.next().then((result) => ({ kind: "frame" as const, result })),
          stopSignal.then(() => ({ kind: "stop" as const })),
        ]);
        if (outcome.kind === "stop") return; // engine completion cancelled the pump's read — see header above
        if (outcome.result.done) return; // true input EOF (path (a) above)
        const frame = outcome.result.value;

        if (frame.type === "user") {
          userFrames.write(frame as UserFrame);
          continue;
        }
        if (frame.type === "control_response") {
          // Task 2 direction inversion: this is the ACK for a request the RUNTIME originated
          // (bridge.request() — rpc_probe, and now T8's real permission RPC), arriving
          // host->runtime. handleResponse itself never throws and logs+drops an unmatched/stale
          // requestId (WS-04: a stale response must never kill the run) — nothing more to do here.
          // Ruling P2-B: reachable AFTER end_input too now — this is the exact frame kind the fix
          // exists to keep delivering.
          // Phase 4 Task 8 (rider 19, RULING P4-I): `handleResponse` returns whether it MATCHED a
          // pending request of its own. When this run's bridge did not issue it, the response
          // belongs to a CHILD engine whose own control_request was forwarded up this same stream
          // (transformChildFrame passes control frames through verbatim) -- so it is offered to
          // every registered child bridge until one claims it. An id no bridge claims is still
          // dropped harmlessly, exactly as before (a stale response must never kill the run).
          //
          // NEW-2 (residual round): the ROSTER is consulted first for any id this run's own bridge
          // does not own. The previous order asked the parent bridge first via `handleResponse`,
          // whose miss path logs "dropping control_response for unknown or already-settled
          // requestId" -- so the PRODUCTION P4-I success path emitted that line for every single
          // child-routed answer, and the message stopped meaning what it says. `ownsRequest` asks
          // the same question with no settle and no log; `handleResponse` is still what runs for an
          // id this bridge owns, and is still what reports a genuinely unclaimed one.
          const response = frame as ControlResponseFrame;
          let claimed = false;
          if (!bridge.ownsRequest(response.requestId)) {
            for (const handle of childResponseHandlers) {
              if (handle(response)) {
                claimed = true;
                break;
              }
            }
          }
          if (!claimed) bridge.handleResponse(response);
          continue;
        }
        if (frame.type === "control_request") {
          const cf = frame as ControlRequestFrame;
          if (cf.subtype === "end_input") {
            output.write({ type: "control_response", requestId: cf.requestId, ok: true });
            // Ruling P2-B: "no more USER envelopes," NOT "stop reading frames" — see this const's
            // own header. `continue`, never `break`: the pump keeps pumping past this point.
            userFrames.end();
            continue;
          }
          if (cf.subtype === "interrupt") {
            output.write({ type: "control_response", requestId: cf.requestId, ok: true });
            interruptCurrentTurn.current?.(); // no-op while idle: nothing active to abort
            // Phase 6 Task 3 (R6-I): an interrupt ENDS the turn, so the quiescent boundary a parked
            // `set_model` was waiting for has arrived early -- apply it now rather than leaving the
            // session on a model the host has already asked it to leave.
            applyPendingModelSwitch("interrupt");
            continue;
          }
          // --- Phase 6 Task 3 (R6-I): `set_model` ------------------------------------------------
          //
          // The pin's own wire shape (`sdk.d.ts:4181-4188`): `{ subtype: 'set_model', model?: string
          // | null }`, where OMITTED, `null` AND the literal string `'default'` all reset to the
          // session default. Accepting only `undefined`/`null` as "reset" silently treats `'default'`
          // as a model id, which is why the payload is carried verbatim and resolved in exactly one
          // place (`applyPendingModelSwitch`).
          //
          // RECORDED, NOT APPLIED, and the ack says the request was accepted rather than that the
          // model has already changed: applying mid-generation would split one logical turn across
          // two models, which is the cross-model history the continuity package exists to avoid.
          if (cf.subtype === "set_model") {
            const payload = cf.payload;
            const requested = typeof payload === "object" && payload !== null ? (payload as { model?: unknown }).model : payload;
            if (requested !== undefined && requested !== null && typeof requested !== "string") {
              output.write({ type: "control_response", requestId: cf.requestId, ok: false, error: { code: "invalid_model", message: `invalid model: ${JSON.stringify(requested)}` } });
              continue;
            }
            pendingModelSwitch = { model: requested as string | null | undefined };
            output.write({ type: "control_response", requestId: cf.requestId, ok: true });
            // IDLE is itself a quiescent boundary: with no turn in flight there is nothing to split,
            // so the switch takes effect immediately rather than waiting for a next envelope that may
            // never come. `interruptCurrentTurn.current` is non-null exactly while a turn is running.
            if (interruptCurrentTurn.current === null) applyPendingModelSwitch("set_model");
            continue;
          }
          // --- Phase 6 Task 10 (R6-I): `list_models` and `account_info` ---------------------------
          //
          // `list_models` is PAYLOAD-FREE on the pin and is answered from the session's own registry
          // — capture (J) established that the pinned runtime serves this from a table inside the
          // binary and issues no `/v1/models` request at all, so a handler that reached for live
          // discovery here would be a behavioural divergence, not an improvement.
          if (cf.subtype === "list_models") {
            output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: supportedModels?.() ?? [] });
            continue;
          }
          // Winter-only, disclosed — see `EngineOptions.accountInfo` for why the pin's own surface
          // (the initialize response) has no counterpart here.
          if (cf.subtype === "account_info") {
            output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: accountInfo?.() ?? {} });
            continue;
          }
          if (cf.subtype === "set_permission_mode") {
            // Task 6 (WS-07 §2/§6.4) upgrade over T2's minimal handler: still validates the payload
            // is one of the six public values (unchanged — a wire-level guard against arbitrary
            // strings), then routes the actual switch through PolicyStateStore.setMode, which bumps
            // `policyVersion` on success and applies the SAME bypassPermissions gate startup
            // validation uses (checkBypassGate) — `ok:false` with a typed error code
            // ("bypass_not_allowed" / "bypass_disabled") on a gated rejection, never a silent no-op.
            const mode = cf.payload; // WS-04 §3.1: request payload is the bare PermissionMode value
            if (typeof mode !== "string" || !isPermissionMode(mode)) {
              output.write({
                type: "control_response",
                requestId: cf.requestId,
                ok: false,
                error: { code: "invalid_mode", message: `invalid permission mode: ${JSON.stringify(mode)}` },
              });
              continue;
            }
            const previousMode = policyStateStore.getState().mode;
            const result = policyStateStore.setMode(mode);
            if (!result.ok) {
              output.write({ type: "control_response", requestId: cf.requestId, ok: false, error: result.error });
              continue;
            }
            // Task 11: door 1 of 2 — see cancelPendingApprovalsOnModeSwitch's own header.
            cancelPendingApprovalsOnModeSwitch(previousMode, result.effectiveMode);
            output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: { effectiveMode: result.effectiveMode } });
            continue;
          }
          // --- Phase 5 Task 3 (R5-11): `rewind_files` ------------------------------------------
          //
          // Wire shape (derived-shapes-p5 item (e), `sdk.d.ts:4146-4150`): snake_case, and it DROPS
          // the result -- `{ subtype: "rewind_files", user_message_id, dry_run? }` in, the
          // RewindFilesResult back on the control_response payload.
          //
          // Every failure mode answers `canRewind: false` with an `error` rather than an `ok:false`
          // control response: `rewindFiles()` returns a typed result on the pin, so a host that gets
          // a rejected promise instead of `{canRewind:false}` cannot tell "nothing to rewind" from a
          // transport fault.
          if (cf.subtype === "rewind_files") {
            const payload = typeof cf.payload === "object" && cf.payload !== null ? (cf.payload as Record<string, unknown>) : {};
            const userMessageId = typeof payload.user_message_id === "string" ? payload.user_message_id : undefined;
            const dryRun = payload.dry_run === true;
            if (userMessageId === undefined) {
              output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: { canRewind: false, error: "rewind_files requires a string `user_message_id`" } });
              continue;
            }
            if (!enableFileCheckpointing || fileCheckpointSink === undefined) {
              output.write({
                type: "control_response",
                requestId: cf.requestId,
                ok: true,
                payload: { canRewind: false, error: enableFileCheckpointing ? "no file-checkpoint sink is registered for this session" : "file checkpointing is not enabled for this session (enableFileCheckpointing)" },
              });
              continue;
            }
            try {
              const result = await fileCheckpointSink.rewind(userMessageId, { dryRun });
              output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: result });
            } catch (err) {
              output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: { canRewind: false, error: err instanceof Error ? err.message : String(err) } });
            }
            continue;
          }
          // Phase 4 Task 3 (MUST 4, WS-04 §3.1, WS-09 §3): the four host->runtime MCP control
          // subtypes -- thin dispatch over rpc/mcp-control.ts's own pure handlers, mirroring
          // set_permission_mode's own "validate/delegate/respond" shape immediately above.
          if (cf.subtype === "mcp_status" || cf.subtype === "mcp_reconnect" || cf.subtype === "mcp_toggle" || cf.subtype === "mcp_set_servers") {
            const mcpDeps = { ...(effectiveMcpStateSource !== undefined ? { stateSource: effectiveMcpStateSource } : {}), ...(effectiveMcpControlSeam !== undefined ? { controlSeam: effectiveMcpControlSeam } : {}) };
            const result =
              cf.subtype === "mcp_status"
                ? await handleMcpStatus(mcpDeps)
                : cf.subtype === "mcp_reconnect"
                  ? await handleMcpReconnect(mcpDeps, cf.payload)
                  : cf.subtype === "mcp_toggle"
                    ? await handleMcpToggle(mcpDeps, cf.payload)
                    : await handleMcpSetServers(mcpDeps, cf.payload);
            output.write(
              result.ok
                ? { type: "control_response", requestId: cf.requestId, ok: true, ...(result.payload !== undefined ? { payload: result.payload } : {}) }
                : { type: "control_response", requestId: cf.requestId, ok: false, error: result.error },
            );
            continue;
          }
          // WS-04 §3.1: an unrecognized subtype gets a structured error response, never a dropped
          // request or a process death.
          const resp: ControlResponseFrame = {
            type: "control_response",
            requestId: cf.requestId,
            ok: false,
            error: { code: "unknown_subtype", message: `unrecognized control subtype '${cf.subtype}'` },
          };
          output.write(resp);
          continue;
        }
        // Other/unknown top-level frame types (hook/MCP RPCs, other control subtypes) land in later
        // phases; ignored here, matching the P0 precedent of skipping non-"user" frames rather than
        // erroring.
      }
    } finally {
      userFrames.end();
      // Deliberately NOT calling iterator.return() here: at the moment the pump is cancelled via
      // stopSignal, the LOSING `iterator.next()` call is typically still pending, with the
      // underlying generator (a real stdin read, or the in-memory Queue's own generator) suspended
      // INSIDE an await on a promise that legitimately never settles again (no more writes are
      // coming — that's exactly why we're stopping). Calling `.return()` on a generator suspended at
      // an unsettled internal await does NOT unwind immediately (unlike calling it at a `yield`
      // point, which `for await...of`'s own `break` handling relies on, safely, for the OTHER exit
      // path here — true EOF) — it waits for that internal await to settle first, which in this
      // exact situation never happens. An earlier version of this fix called `iterator.return()`
      // here as a "harmless courtesy cleanup" and it deadlocked runEngine's own returned promise
      // (confirmed empirically — see the task report). The abandoned generator is simply left to be
      // garbage-collected once nothing references it any longer (a real child process exits via
      // main.ts's own process.exit() regardless; the in-memory Queue has no other resource to
      // release) — never a hang, just a resolver reference sitting inert.
      //
      // Termination re-argument, the remaining gap (found by review): step 3 above shows
      // `stopReading()` is only ever called after the turn loop has no more work — so on the `stop`
      // exit path, `bridge`'s pending map is already empty by that same invariant, and the call below
      // is a no-op. But on the TRUE-EOF exit path (`outcome.result.done`, or the loop's other early
      // returns), `input` itself is what ended — independent of whether the turn loop has finished —
      // so a turn can still be genuinely mid-flight, awaiting a no-park-timeout `bridge.request()`
      // (WS-04 §3, e.g. Task 8's permission RPC) that can now NEVER be answered: nothing is left to
      // route a `control_response` even if one existed. Without this call, THAT specific request
      // parks forever and runEngine never returns. `rejectAllPending` turns that unreachable hang
      // into a clean resolution: prompt-stage.ts's `catch` already maps ANY bridge rejection to "no
      // opinion" (null), and Ruling P2-I already maps "no opinion" to a denial — so the stuck turn
      // completes with a denied tool_result, exactly as if the (now-impossible) answer had been "no."
      bridge.rejectAllPending(new Error("winter: input ended before this control request could be answered"));
    }
  })();

  // T9-CARRY 2 (reassigned to T10; WS-08 §1.1): "engine start, after init." Fired here — AFTER the
  // pump has started running (the `const pump = ...` assignment above has already invoked its IIFE;
  // by the time control reaches this line the pump's own `while(true)` loop is actively listening
  // for control_response frames) and BEFORE the turn loop begins — never any earlier: a hook RPC
  // issued before the pump exists would have nothing routing its eventual answer back to the
  // bridge, and would need to rely solely on the runner's own per-hook timeout to ever resolve.
  await fireObservationalHook("SessionStart", {
    payload: { source: config.forkSession === true ? "fork" : config.resume !== undefined || config.continue === true ? "resume" : "startup" },
  });
  // B-H1(c) point 2: the session is IDLE, waiting for a user envelope (WS-04 §4.1's `idle` state).
  // Emitted here and again after every terminal result below, which is exactly the set of moments
  // the state machine re-enters `idle` -- an observer polling for "is it my turn" has no other
  // signal, because `result` also fires for a turn that immediately continues a streaming input.
  emitNotification("idle", "Waiting for input.");

  const messages: ProviderMessage[] = initialMessages ? [...initialMessages] : [];

  // Phase 6 Task 3 (R6-7): re-attach the CONTINUATION CHAIN to a resumed history.
  //
  // AWAITED, not fire-and-forget: the very first generation of the run reads these annotations, so a
  // detached attach would race the turn it exists to inform -- and lose, silently, on a fast host.
  // The logic itself lives in `store/continuation-attach.ts` (review round 1, M8): it is a pure
  // function of a message array and a persistence seam, and belongs beside the codec it consumes.
  if (store !== undefined) {
    await attachContinuationChain({
      messages,
      store,
      sessionId: config.sessionId,
      warn: (message) => output.write({ type: "data", message }),
      newUuid: randomUUID,
    });
  }

  // M6 (fix wave, P3 close-out): wire the advisor's REAL transcript source, now that `messages`
  // (this run's own turn history) exists in this closure -- see this file's own import comment for
  // why this cross-module call is deliberate, not an oversight. `resolveReviewer` STAYS the P6 seam
  // (advisor.ts's own module-load default, `() => undefined`) -- this call replaces ONLY
  // `transcriptSource`, never invents a reviewer-resolution story this phase was never asked to
  // build. Gated on the SAME capability (`winter.reviewer-model`) `buildAdvertisedSet` already
  // checks before ever advertising the tool (this file's own call, a few lines down) -- wiring a
  // live transcript source for a tool that is never advertised to this session would be pointless
  // per-run work, and the capability check is already computed once, here, for that call anyway.
  // `messages` is captured by REFERENCE (the closure below runs only when the advisor tool actually
  // executes, well after this line, by which point the round loop has appended real turns to it) --
  // the getter is what stays live, never a one-time snapshot taken at this line.
  if (config.capabilities?.includes("winter.reviewer-model") === true) {
    replaceExecutor(
      ADVISOR_TOOL_NAME,
      createAdvisorExecutor({
        transcriptSource: {
          getEntries: (): TranscriptEntry[] => messages.map((m) => ({ role: m.role, text: providerMessageContentToText(m.content) })),
        },
        resolveReviewer: () => undefined,
      }),
    );
  }

  // --- Task 11 (WS-07 §9): resume-consumption ------------------------------------------------------
  //
  // DESIGN (this task's own documented judgment call — the spec states WHAT must hold ["the call
  // executes exactly once"] but not HOW a later resume finds and applies a resolution; capture-noted
  // per the brief). Runs ONCE, here, before the turn loop starts (mirrors SessionStart's own "after
  // pump start, before turn loop" placement) — a fresh, never-deferred session has nothing to do
  // (`approvalStore.listFor` returns `[]`, or `approvalStore` itself is undefined).
  //
  // Locating the candidate: resume.ts's own rebuildProviderMessages comment already establishes that
  // a synthetic marker (interrupted/error, and now `deferred`) round-trips VERBATIM through
  // persist->readBack->rebuild, identically to a real tool_result — this scan keys off
  // `record.toolUseID` matching a tool_result's own `tool_use_id` (the store's own authority on
  // which calls are outstanding), treating the `deferred` flag as corroboration only, per this
  // task's own advisor-reviewed robustness note — a hypothetical future dialect change that stopped
  // persisting that one boolean would not silently break this scan.
  //
  // The PERSISTED "[deferred]" line is NEVER rewritten (the store is append-only, WS-05 §6) — only
  // THIS RUN's in-memory `messages` (and therefore the very next provider.generate() call) sees the
  // corrected value. A real tool_use_id has at most one tool_result in valid provider history; this
  // REPLACES the one block already there, never appends a second (appending a second would be
  // provider-invalid — a duplicate tool_result for one tool_use_id).
  //
  // EXACTLY-ONCE EXECUTION (the correctness core of this design): an "allowed" record is executed
  // via `tools.execute()` at most once across its ENTIRE lifetime, regardless of how many times this
  // session is later resumed — `approvalStore.markConsumed` persists the output (or error) the FIRST
  // time, and every later resume substitutes the CACHED result without revalidating or executing
  // again (the `consumedAt` fast path below) — re-validating an already-executed call protects
  // nothing, since the side effect already happened. Revalidation instead runs on the FIRST resume
  // that finds a "pending" or "allowed"-not-yet-consumed record — WS-07 §9's own "ANY mismatch ->
  // expired, never execute" applies to allowed just as much as to pending, since "allowed" alone
  // never proves the call is still safe to run against a session/mode/path/runtime that has since
  // moved on.
  //
  // Fix round 1, Ruling P2-L: the pre-fix-round-1 version of this design was "executes exactly
  // once" in NAME only — a hard process kill between tools.execute() returning and markConsumed()
  // persisting left the record "allowed" with no consumedAt, indistinguishable from "never
  // attempted" to a later resume, which would re-execute (at LEAST once, not EXACTLY once, for a
  // possibly non-idempotent side effect). `approvalStore.markConsuming()` closes this: a durable
  // "about to execute" fact written BEFORE the risky call, so a later resume that finds intent
  // without a result fails closed to "expired" rather than guessing. This sequential
  // crash-recovery guarantee itself assumes no SECOND live process is doing the identical thing for
  // the same session CONCURRENTLY — see the "allowed" branch's own comment, below, for the eager
  // writer-lease dependency (dialect.ts's Ruling P1-S) that provides that assumption.
  //
  // "denied"/"cancelled"/"expired" never execute and are recomputed fresh on every resume (pure
  // data, no side effect, so no consumedAt bookkeeping is needed for them at all).
  if (approvalStore) {
    for (const record of approvalStore.listFor({ sessionId: config.sessionId })) {
      let foundAt: { mi: number; bi: number } | undefined;
      outer: for (let mi = 0; mi < messages.length; mi++) {
        const message = messages[mi]!;
        if (message.role !== "tool" || !Array.isArray(message.content)) continue;
        for (let bi = 0; bi < message.content.length; bi++) {
          const block = message.content[bi]!;
          if (block.type === "tool_result" && block.tool_use_id === record.toolUseID) {
            foundAt = { mi, bi };
            break outer;
          }
        }
      }
      if (foundAt === undefined) continue; // no on-disk trace of this record's own [deferred] marker in THIS run's rebuilt history

      const { mi, bi } = foundAt;
      const substitute = (fields: { content: string; denied?: boolean; error?: boolean }): void => {
        const current = messages[mi]!;
        const blocks = (current.content as ContentBlock[]).slice();
        blocks[bi] = {
          type: "tool_result",
          tool_use_id: record.toolUseID,
          content: fields.content,
          ...(fields.denied === true ? { denied: true } : {}),
          ...(fields.error === true ? { error: true } : {}),
        };
        messages[mi] = { ...current, content: blocks };
      };

      if (record.consumedAt !== undefined) {
        substitute({ content: record.consumedResult ?? "", ...(record.consumedIsError === true ? { error: true } : {}) });
        continue;
      }

      // Fix round 1, Ruling P2-L (write-ahead consumption intent): a "consuming" marker with NO
      // matching "consumed" outcome is the crash signature — a PRIOR resume already called
      // approvalStore.markConsuming() (below) and then died somewhere between that write and
      // tools.execute() returning (or between execute() returning and markConsumed() persisting).
      // Whether the side effect actually ran is now UNKNOWABLE from persisted state alone. Fail
      // closed: expire, never re-execute — "executes exactly once" would otherwise silently become
      // "executes at least once" for a non-idempotent tool. This check runs BEFORE the state-based
      // branching below (and therefore before revalidation) because it is not a context-drift
      // question at all — an intent-without-result is disqualifying regardless of whether the
      // current context would otherwise still revalidate cleanly.
      if (record.consumingAt !== undefined) {
        const reason = "a prior execution attempt for this approval did not record its outcome (the process may have been interrupted mid-execution); re-approval is required";
        approvalStore.expire(record.requestId, reason);
        substitute({ content: `Approval expired: ${reason}`, denied: true });
        continue;
      }

      if (record.state === "pending" || record.state === "allowed") {
        // Ruling P2-K/P1-S dependency (documented here, not merely in the report): this
        // revalidate-then-execute window assumes no SECOND live process can be doing the identical
        // thing for the SAME session concurrently — that guarantee is NOT provided by anything in
        // this function. It comes from dialect.ts's resolveEngineSession eagerly claiming the
        // session's writer lease (Ruling P1-S) before this code ever runs: a second resume attempt
        // against the same session fails outright at session-resolution time (ResumeTargetError
        // "locked"), long before it could reach this loop. Without that eager claim, two concurrent
        // resumes could both revalidate successfully and both execute — a race markConsuming()
        // alone does not close (it protects sequential crash-recovery, not concurrent execution).
        const revalidationCtx = {
          runtimeKind: WINTER_RUNTIME_KIND,
          sessionId: config.sessionId,
          backendSessionId: config.sessionId,
          toolUseID: record.toolUseID,
          policyMode: policyStateStore.getState().mode,
          policyVersion: policyStateStore.getState().version,
          // Item 10 (P2 fix-wave): the LIVE content hash this resume's own current policy computes
          // to — compared against the record's own frozen, issuance-time hash (see approvals.ts's
          // own revalidateApproval comment for the full rationale).
          policyHash: computePolicyHash(policyStateStore.getState()),
          cwd: config.cwd,
          home: permissionHome,
        };
        const verdict = revalidateApproval(record, revalidationCtx);
        if (!verdict.ok) {
          approvalStore.expire(record.requestId, verdict.reason);
          substitute({ content: `Approval expired: ${verdict.reason}`, denied: true });
          continue;
        }
        if (record.state === "pending") continue; // genuinely still pending and still valid -- leave the [deferred] marker as is

        // "allowed" + revalidated -- execute exactly once. A responder's own transformedInput (the
        // durable analog of canUseTool's updatedInput, WS-07 §7.2) wins over the original input when
        // present, taken verbatim with no re-validation — the SAME posture engine.ts's real-time
        // canUseTool path already documents for its own updatedInput (no tool registry/schema exists
        // at P2 to re-check against).
        const inputToExecute = record.resolution?.transformedInput ?? record.originalInput;
        // Ruling P2-L: the write-ahead marker, persisted BEFORE the risky operation — see
        // markConsuming's own interface comment (approvals.ts) for the full rationale.
        approvalStore.markConsuming(record.requestId);
        try {
          const result = await tools.execute({ id: record.toolUseID, name: record.toolName, input: inputToExecute });
          approvalStore.markConsumed(record.requestId, { output: result.output });
          substitute({ content: result.output });
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          approvalStore.markConsumed(record.requestId, { output: `[error: ${text}]`, isError: true });
          substitute({ content: `[error: ${text}]`, error: true });
        }
        continue;
      }

      // "denied" / "cancelled" -- never executes; recomputed fresh every resume (pure data).
      substitute({ content: record.resolution?.message ?? record.resolution?.reason ?? `Approval ${record.state}`, denied: true });
    }
  }
  // Ruling P1-F: maxTurns is the RUN's cumulative agentic tool-use round-trip cap (report §8 /
  // WS-03 §5) — it never resets per user envelope. Declared here, outside the turn loop, so it
  // persists for runEngine's whole lifetime; once spent, EVERY subsequent tool_use attempt in this
  // run fails with error_max_turns (sticky-over-limit — incrementing past the limit is harmless,
  // there's no need to cap the counter itself). A plain-text turn never touches this counter, so a
  // text-only envelope always succeeds regardless of how much of the budget prior turns spent.
  let rounds = 0;

  // --- Phase 5 Task 3 (R5-9/R5-16): system-prompt assembly, ONE producer -----------------------------
  //
  // Called once per USER ENVELOPE (never once per run, never once per provider call): R5-9's dynamic
  // sections include the date and a git summary, which a long-lived streaming session must not freeze
  // at connect time, and `planMode` can change mid-session through set_permission_mode. Called once
  // per envelope rather than per provider call because the result must be STABLE across a turn's tool
  // rounds -- a system prompt that changed between rounds of the same turn would invalidate provider
  // prompt caching and make the turn's own history internally inconsistent.
  //
  // R5-16: with no assembler registered this returns the caller's `agentSystemPrompt` (a child's
  // persona, R5-3) or an EMPTY prompt. No authored text lives here, deliberately -- the only authored
  // minimal prompt is Lane C's (see context/seam.ts's header).
  // --- Phase 5 Task 3 (R5-4): compaction ----------------------------------------------------------
  //
  // THE SEQUENCE (compaction/seam.ts's header states why each ordering is load-bearing):
  //   PreCompact -> compact() -> persist boundary+summary -> emit the frame -> PostCompact
  //   -> registry.onCompaction(evidenced) -> swap the in-memory history.
  //
  // NO VETO IS INVENTED (WS-08 OQ4): `PreCompact` has no hook-specific output type on the pin, so
  // there is no shape a veto could be expressed in. Its output is RECORDED (the audit stream, via
  // runHooks) and FORWARDED (its `extraContext` is appended to `customInstructions`); compaction
  // then proceeds regardless of what it said.
  //
  // The re-entrancy guard is `lastCompactionTokens`, not a per-turn flag. After a compaction the
  // accountant still reports the PRE-compaction reading until the next generation records usage --
  // so a naive `shouldCompact()` check would fire again on the very next round and loop forever. A
  // turn that genuinely grows past the threshold twice still compacts twice, because the second
  // check runs against a reading a real generation has since updated.
  let lastCompactionTokens: number | null = null;

  const performCompaction = async (trigger: "auto" | "manual", customInstructions: string | null): Promise<{ ok: true; summary: string; retainedCount: number } | { ok: false; error: string }> => {
    if (compactionController === undefined) {
      return { ok: false, error: "No compaction controller is configured for this session (R5-4: the compaction vehicle is supplied by the host; the engine never summarizes on its own)." };
    }
    const startedAt = Date.now();

    // PreCompact -- pinned input `{ trigger, custom_instructions }` (derived-shapes-p5 item (f)).
    // `custom_instructions` is `string | null` on the pin, never absent.
    const pre = await fireObservationalHook("PreCompact", { payload: { trigger, custom_instructions: customInstructions } });
    const forwarded = (pre.extraContext ?? []).map((c) => c.context).filter((t) => typeof t === "string" && t.length > 0);
    const effectiveInstructions = [customInstructions, ...forwarded].filter((t): t is string => typeof t === "string" && t.length > 0).join("\n\n");

    let result: CompactionResult;
    try {
      result = await compactionController.compact({
        messages: messages.map((m) => ({ ...m })),
        trigger,
        customInstructions: effectiveInstructions.length > 0 ? effectiveInstructions : null,
        accountant: contextAccountant,
        provider,
      });
    } catch (err) {
      // A failed compaction is REPORTED, never fatal: the turn continues on the un-compacted history
      // (which is correct but large) rather than losing the conversation. The pinned status message
      // carries exactly this pair -- `compact_result: "failed"` + `compact_error`.
      const text = err instanceof Error ? err.message : String(err);
      output.write({ type: "data", message: { type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: text, uuid: randomUUID(), session_id: config.sessionId } });
      return { ok: false, error: text };
    }

    // Phase 5 Task 8 (rider 17): THE ENGINE NOW SAYS SO, which is what `compaction/seam.ts`'s
    // `CompactionResult.retained` doc has always claimed -- "a controller that returns the full
    // input here has compacted nothing and the engine will say so rather than silently looping."
    // There was no such check. The engine swaps its whole history for `[summary, ...retained]`, so a
    // controller returning the full input makes the history LONGER on every round, forever, while
    // `lastCompactionTokens` records a "successful" compaction that freed nothing.
    //
    // Compared by COUNT against the input it was handed, not by identity: a controller may legally
    // return copies (Lane K's does, and this function hands it copies to begin with), so identity
    // would never fire. `>=` rather than `>` because retaining exactly as many messages as it was
    // given is the same "nothing was folded" condition -- the summary is pure growth either way.
    //
    // Routed through the SAME failure arm a thrown controller takes (the pinned
    // `compact_result: "failed"` + `compact_error` pair), because the outcome for the session is
    // identical: the turn continues on the un-compacted history rather than on a corrupted one.
    if (result.retained.length >= messages.length) {
      const text = `the compaction controller returned ${result.retained.length} of ${messages.length} messages, so nothing was compacted -- applying it would grow the history by a summary on every round (compaction/seam.ts's CompactionResult.retained contract)`;
      output.write({ type: "data", message: { type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: text, uuid: randomUUID(), session_id: config.sessionId } });
      return { ok: false, error: text };
    }

    // Persist BEFORE emitting the frame and before resetting the loaded set: a crash between
    // persistence and the reset leaves the durable transcript and the in-memory loaded set
    // disagreeing in the SAFE direction (the set is rebuilt from the transcript on resume; a reset
    // that outlived an unpersisted summary would not be).
    // The in-memory swap happens BEFORE the frame is emitted (but after persistence) so
    // `post_tokens` can be measured on the history the model will actually carry forward. It used to
    // sit at the very end of this function, which left `post_tokens` structurally unreachable -- the
    // field was declared on the frame and never populated by anything.
    let boundaryWrite: CompactBoundaryWriteResult | undefined;
    if (store?.recordCompactBoundary !== undefined) {
      const boundaryRecord: CompactBoundaryRecord = {
        trigger,
        preTokens: result.preTokens,
        durationMs: Date.now() - startedAt,
        summary: result.summary,
        retainedCount: result.retained.length,
      };
      try {
        boundaryWrite = (await store.recordCompactBoundary(boundaryRecord)) ?? undefined;
      } catch {
        /* auxiliary, exactly like recordUser/recordAssistant -- a store failure is never turn-fatal */
      }
    }

    messages.length = 0;
    messages.push({ role: "user", content: result.summary }, ...result.retained);
    lastCompactionTokens = contextAccountant.contextTokens();

    // Fix round 1 (M3): `preserved_messages` on the FRAME, built from the uuids the store just
    // minted -- previously unreachable, because `recordCompactBoundary` returned `void`, so a host
    // reading the stream could never relink a preserved segment while the durable entry carried it
    // correctly. OMITTED when nothing was preserved: absence is semantic on the pin ("compaction
    // summarized everything"), so an empty `uuids: []` would assert something different.
    //
    // `post_tokens` IS OMITTED (Phase 5 fix wave, A-8 / whole-branch N2). It used to carry
    // `contextAccountant.contextTokens()`, which after the rebuild is still the PRE-compaction
    // reading -- the accountant records the last GENERATION's usage, not a live count of `messages`,
    // and no generation has run since the swap. So the field asserted `pre == post`: "compaction
    // freed nothing", on every successful compaction.
    //
    // ABSENCE IS THE HONEST FORM OF UNKNOWN, and the field is optional on the pin precisely so it
    // can be. A real post-compaction count needs a token counter over the rebuilt message list,
    // which is WS-13's provider layer -- carried, not faked.
    output.write({
      type: "data",
      message: {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger,
          pre_tokens: result.preTokens,
          duration_ms: Date.now() - startedAt,
          ...(boundaryWrite !== undefined && boundaryWrite.preservedUuids.length > 0
            ? { preserved_messages: { anchor_uuid: boundaryWrite.anchorUuid, uuids: boundaryWrite.preservedUuids } }
            : {}),
        },
        uuid: boundaryWrite?.boundaryUuid ?? randomUUID(),
        session_id: config.sessionId,
      },
    });

    // PostCompact AFTER compact(): its pinned input carries `compact_summary` as a REQUIRED string,
    // so the summary must exist before the hook can be given its input at all.
    await fireObservationalHook("PostCompact", { payload: { trigger, compact_summary: result.summary } });

    // WS-09 §8.5: the deferred loaded set resets to `evidenced n still-registered` -- a tool the
    // model can no longer see evidence of having loaded must not stay silently callable.
    onCompaction(loadedToolSet, result.evidencedToolNames);

    return { ok: true, summary: result.summary, retainedCount: result.retained.length };
  };

  // R5-14's `/compact [instructions]`: the MANUAL trigger, never subject to the auto re-entrancy
  // guard (a user asking twice gets two compactions).
  const runManualCompaction = async (customInstructions: string): Promise<string> => {
    const outcome = await performCompaction("manual", customInstructions.length > 0 ? customInstructions : null);
    if (!outcome.ok) return `/compact did nothing: ${outcome.error}`;
    return `Compacted the conversation. ${outcome.retainedCount} message(s) retained alongside the summary.`;
  };

  // The AUTO trigger. The threshold formula itself lives with the controller (R5-4) -- the engine
  // only decides WHEN to ask and guards against asking again before the accountant has moved.
  const maybeAutoCompact = async (): Promise<void> => {
    if (compactionController === undefined) return;
    if (lastCompactionTokens !== null && contextAccountant.contextTokens() === lastCompactionTokens) return;
    if (!compactionController.shouldCompact(contextAccountant)) return;
    await performCompaction("auto", null);
  };

  const assemblePrompt = (): AssembledPrompt => {
    const base: SystemPromptInput = {
      config,
      cwd: config.cwd,
      env: engineEnv ?? process.env,
      platform: process.platform,
      osVersion: osRelease(),
      shell: (engineEnv ?? process.env)["SHELL"] ?? "",
      date: new Date().toISOString().slice(0, 10),
      planMode: policyStateStore.getState().mode === "plan",
      ...(agentSystemPrompt !== undefined ? { agentPrompt: agentSystemPrompt } : {}),
      // Withheld when `Skill` is not advertised -- see EngineOptions.skillListing for why the engine
      // rather than either lane owns this check.
      ...(skillListing !== undefined && skillListing.length > 0 && advertisedToolNames.includes(SKILL_TOOL_ADVERTISED_NAME) ? { skillListing } : {}),
    };
    if (systemPromptAssembler === undefined) return { system: agentSystemPrompt ?? "", userContextBlocks: [] };
    return systemPromptAssembler.assemble(base);
  };

  // Builds the LIVE request's message list: the engine's own history, with this envelope's
  // user-context blocks prepended to a user message in it.
  //
  // Applied to a COPY, never to `messages` -- Ruling P1-B keeps persistence and history free of
  // presentation concerns, and a block that entered history would be re-sent on every later turn,
  // re-persisted, and eventually summarized into a compaction as if the model had said it. The
  // blocks are re-attached each turn instead, which is what R5-9's "always injected as user-context"
  // means operationally.
  //
  // RULING P5-F (fix round 1, M2): THE ATTACHMENT POINT IS RECOMPUTED FROM THE REBUILT MESSAGE LIST
  // ON EVERY PROVIDER CALL -- never a cached index. The first version captured
  // `turnUserIndex = messages.length - 1` once per envelope, which a MID-TURN COMPACTION strands: the
  // engine replaces `messages` wholesale with `[summary, ...retained]`, so with `retained: []` index
  // 0 is the SUMMARY and the WINTER.md/memory blocks were prepended INSIDE the summary text, and with
  // any other retention count the index pointed at an unrelated message or past the end and the
  // blocks were silently dropped for the rest of that turn.
  //
  // "The LAST user-role message" is the correct anchor after re-anchoring: it is this envelope's own
  // prompt when nothing has compacted, and the summary-anchored first user message when everything
  // was summarized away (the summary is pushed as a `user` message, and the envelope's prompt is
  // inside it) -- in both cases the newest thing the model is being asked about. Searching from the
  // END also makes it correct on a resumed session, whose FIRST user message belongs to an earlier
  // run.
  const requestMessages = (blocks: string[]): ProviderMessage[] => {
    const copy = messages.map((m) => ({ ...m }));
    if (blocks.length === 0) return copy;
    for (let i = copy.length - 1; i >= 0; i--) {
      const target = copy[i];
      if (target === undefined || target.role !== "user" || typeof target.content !== "string") continue;
      target.content = `${blocks.join("\n\n")}\n\n${target.content}`;
      return copy;
    }
    // No string-content user message anywhere (a tool-result-only history): nothing to attach to, and
    // inventing a message would put context in the transcript the model never asked for.
    return copy;
  };

  // --- Phase 6 Task 3: the provider request's own inputs ------------------------------------------

  /**
   * The ADVERTISED set with real JSON Schemas -- what an adapter puts in the request's `tools` array.
   *
   * ONLY LOADED DEFERRED TOOLS, deliberately. WS-09 §8.2's "load != permission" runs the other way
   * too: advertising a schema for a deferred tool this session has not loaded invites the model to
   * call a name the engine's own load-first check (`isDeferredAndUnloaded`) will refuse before
   * permission evaluation even starts -- a wasted round trip and a confusing refusal, every time.
   *
   * `advertisedName` is the name the MODEL sees (the alias table's own resolution), never the
   * canonical one -- a schema keyed on a name the model was not shown is a tool it cannot call.
   */
  const providerToolSpecs = (): ProviderToolSpec[] => {
    const specs: ProviderToolSpec[] = [];
    for (const descriptor of advertisedPartition.eager) {
      specs.push({ name: descriptor.advertisedName, description: descriptor.description, inputSchema: descriptor.inputSchema as Record<string, unknown> });
    }
    for (const descriptor of advertisedPartition.deferred) {
      if (!loadedToolSet.isLoaded(descriptor.canonicalName)) continue;
      specs.push({ name: descriptor.advertisedName, description: descriptor.description, inputSchema: descriptor.inputSchema as Record<string, unknown> });
    }
    return specs;
  };

  /**
   * P1 carry: the per-message input byte cap, enforced BEFORE the request leaves the engine.
   *
   * A TYPED ERROR, never a silent truncation (see `DEFAULT_MAX_PROVIDER_MESSAGE_BYTES`). It is a
   * `ProviderTurnError` so it lands on R6-F's result shape -- a caller sees "the provider request was
   * refused", which is what happened, rather than a generic execution error.
   *
   * Measured on the SERIALIZED message, because that is what actually goes on the wire: a message
   * whose `content` is a 4 MiB base64 image block is over the cap however short its text is.
   */
  const assertMessagesWithinCap = (msgs: readonly ProviderMessage[]): void => {
    const cap = maxProviderMessageBytes ?? DEFAULT_MAX_PROVIDER_MESSAGE_BYTES;
    for (let i = 0; i < msgs.length; i++) {
      const message = msgs[i]!;
      const bytes = Buffer.byteLength(typeof message.content === "string" ? message.content : JSON.stringify(message.content), "utf8");
      if (bytes > cap) {
        // The message's own CONTENT is never quoted here -- an error message is a log line and a
        // frame, and this one is about a message that may hold anything.
        throw new ProviderTurnError(`provider input message ${i} (role "${message.role}") is ${bytes} bytes, over the ${cap}-byte per-message cap; it was NOT truncated`);
      }
    }
  };

  /**
   * R6-5 / R6-G: the sink one GENERATION streams into, or `undefined` for an auxiliary call.
   *
   * `undefined` is the point for auxiliary generations. Capture (F) found the pinned runtime issuing
   * three POSTs for a two-turn conversation and forwarding stream events for only two of them -- the
   * first POST is an auxiliary call whose events never reach the host. A Winter emitter that streamed
   * every provider call would emit frames the pinned runtime suppresses, so the compaction
   * summariser, the classifier, the advisor and `countTokens` are all built WITHOUT a sink rather
   * than with one that is filtered later.
   *
   * `ttft_ms` rides the FIRST `stream_event` of each forwarded generation (capture (F): exactly 2
   * frames carried it, one per forwarded turn, on that turn's `message_start`), so the flag is
   * per-sink and a new sink is built per generation.
   */
  const buildStreamSink = (): ProviderStreamSink =>
    createStreamFrameSink({
      sessionId: config.sessionId,
      includePartialMessages: config.includePartialMessages === true,
      write: (message) => output.write({ type: "data", message }),
      // GETTERS, not captured values: a `set_model` between generations changes what
      // `reasoning_summary` should name, and a sink built once per generation would otherwise report
      // the model the session started on.
      identity: () => currentProviderIdentity,
      model: () => currentModel ?? "",
    });

  /**
   * R6-3: the continuation annotations an assistant message carries in the IN-MEMORY history.
   *
   * `origin` is what the cross-family check on a resume, a fallback or a handoff reads; `nativeState`
   * is the OPAQUE continuation state, carried here so the very next request can replay it exactly
   * inside the same continuation domain. Neither is ever serialized into `message.content`, and both
   * are dropped by the compaction summariser's positive rebuild (asserted in the seam contract test).
   */
  const providerAnnotations = (turn: ProviderTurn): { origin?: MessageOrigin; nativeState?: ProviderNativeState } => ({
    ...(currentProviderIdentity !== undefined
      ? {
          origin: {
            providerId: currentProviderIdentity.providerId,
            modelKey: currentProviderIdentity.modelKey,
            family: currentProviderIdentity.family,
            ...(currentProviderIdentity.continuationDomain !== undefined ? { continuationDomain: currentProviderIdentity.continuationDomain } : {}),
          },
        }
      : {}),
    ...("nativeState" in turn && turn.nativeState !== undefined ? { nativeState: turn.nativeState } : {}),
  });

  /** R6-7/R6-8: what rides the SIDECAR for this turn -- the opaque native state and any FOREIGN reasoning summary, neither of which may enter the transcript. */
  const turnProvenance = (turn: ProviderTurn): { nativeState?: ProviderNativeState; summary?: string } => ({
    ...("nativeState" in turn && turn.nativeState !== undefined ? { nativeState: turn.nativeState } : {}),
    // T10 (Lane C wiring item 8): `exposed` as well as `summary`.
    //
    // `ProviderThinkingOutput` declares both -- a provider-authored SUMMARY and the model's own
    // EXPOSED reasoning -- and only the first was ever recorded. So a family whose reasoning channel
    // IS the model's own output (the exposed-reasoning families) wrote no `summary` record at all,
    // its sidecar carried nothing for those turns, and the continuity renderer had no material to
    // decorate a later cross-family message with. The whole no-warning class Lane C built for those
    // families was unreachable, silently, because the write path stopped one field short.
    //
    // `summary` WINS when both are present: a provider-authored summary is the shape R6-8 permits to
    // travel, and the raw exposed text is the fallback for a family that produces no summary of its own.
    // Either way it lands in the sidecar and NEVER in `assistant.message.content`.
    ...("thinking" in turn && turn.thinking?.summary !== undefined
      ? { summary: turn.thinking.summary }
      : "thinking" in turn && turn.thinking?.exposed !== undefined
        ? { summary: turn.thinking.exposed }
        : {}),
  });

  /**
   * R6-C / R6-I: apply a pending `set_model`.
   *
   * THE QUIESCENT BOUNDARY IS THE DEFAULT, and immediacy is the exception. A model swapped
   * mid-generation would split one logical turn across two models, which is exactly the cross-model
   * history the continuity package exists to avoid -- so a `set_model` arriving mid-turn is PARKED
   * and applied before the next envelope's first generation. An INTERRUPT ends the turn, so the
   * boundary has arrived early and the parked switch applies immediately; so does an IDLE session,
   * where there is no turn to split and waiting would mean waiting for an envelope that may never come.
   *
   * The RESOLUTION itself is Lane C/T10's (this is the hook point, not the coordinator): the pending
   * value is carried verbatim, the pin's three-way reset spelling is honoured HERE because getting it
   * wrong silently treats the literal string `'default'` as a model id, and the swap is announced on
   * the Winter-only `system/model_switch` frame plus the dialect record's `providerHistory`.
   *
   * A hoisted `function`, not a `const` arrow: the pump closure is written ABOVE this point in the
   * file and calls it, and a block-scoped const would be a use-before-declaration error even though
   * the call only ever happens long after this line has run.
   */
  function applyPendingModelSwitch(reason: "set_model" | "interrupt"): void {
    if (pendingModelSwitch === undefined) return;
    const requested = pendingModelSwitch.model;
    pendingModelSwitch = undefined;
    // The pin's three-way reset spelling (`sdk.d.ts:4184`): omitted, `null`, or the literal
    // `'default'` all reset to the session default.
    const next = requested === undefined || requested === null || requested === "default" ? config.model : requested;
    if (next === currentModel) return;
    const from = currentModel;
    currentModel = next;
    store?.recordProviderSwitch?.({ from, to: next, reason });
    output.write({
      type: "data",
      message: { type: "system", subtype: "model_switch", reason, from_model: from, to_model: next, provider: currentProviderIdentity?.providerId ?? "", uuid: randomUUID(), session_id: config.sessionId },
    });
  }

  for await (const userFrame of userFrames) {
    // Set BEFORE any await this turn (including recordUser below) so the entire turn — from the
    // moment its envelope is accepted — is interruptible (WS-04 §5).
    let interruptResolve!: () => void;
    const interruptSignal = new Promise<void>((resolve) => {
      interruptResolve = resolve;
    });
    // Phase 6 Task 3 (R6-6): TRUE cancellation, per turn.
    //
    // The interrupt was a Promise the engine RACED -- it stopped waiting, and the provider request
    // and the in-flight tool ran to completion behind an abandoned await. This controller is what
    // turns "stop waiting" into "stop working": it reaches `provider.generate` (cancelling
    // pre-header and mid-stream) and `ToolExecutor` through `ToolExecutionContext.signal`, so an
    // interrupt also kills the in-flight Bash process group. The race stays -- it is what unwinds the
    // turn promptly -- and the signal is what stops the work the race walked away from.
    const turnAbort = new AbortController();
    // Fix wave (I5): an interrupt abandons the in-flight tool call -- including an Agent call that
    // is awaiting a foreground child -- so the abandoned child is stopped with it. Ordered
    // resolve-then-stop so the turn unwinds immediately; `stop()` is fire-and-forget and settles
    // the child's own result promise (never awaited here: WS-04 §5's interrupt must not block on a
    // child's teardown).
    interruptCurrentTurn.current = () => {
      interruptResolve();
      // Phase 6 Task 3 (R6-6): aborted BEFORE the children are stopped and after the race is
      // resolved, so the unwind order is unchanged and the in-flight generation/tool stop as well as
      // being abandoned. `abort()` is idempotent and never throws.
      turnAbort.abort();
      abortForegroundChildren();
    };
    // Phase 6 Task 3 (R6-I): the QUIESCENT BOUNDARY. A `set_model` parked during the previous turn
    // takes effect here -- before this envelope's first generation -- so a turn never spans two models.
    applyPendingModelSwitch("set_model");

    // Finding 3 (P2 fix-wave, IMPORTANT): result.permission_denials, the array the frozen
    // derived-shapes doc calls "the record to trust ... the array is the ledger" (permission_denied
    // stream messages are best-effort/advisory only, per that same doc's own load-bearing finding).
    // Reset PER USER TURN (never across turns) — this is "what did THIS turn deny," mirroring how
    // each turn gets exactly one terminal result. Pushed to from the ONE denyCall site below, which
    // both fail-closed-defer denials (no durable approval store; persisting the record itself
    // failed) already route through — nothing else needs separate instrumentation.
    const turnPermissionDenials: SDKPermissionDenial[] = [];

    // --- Phase 5 Task 3 (R5-14): command resolution, BEFORE the model sees the prompt -------------
    //
    // Three outcomes, in this order. (1) An engine BUILT-IN (`/compact [instructions]`) never becomes
    // a provider turn at all -- it runs its own engine-side action and produces this envelope's own
    // terminal result. (2) An `expand` resolution REPLACES the prompt text with the fully expanded
    // body; the model never observes the `/name args` form, which is the entire reason resolution
    // cannot be a tool. (3) Anything else -- not a command, or a `/name` no resolver claims -- is used
    // verbatim; an unknown command is never an error and never a dropped turn.
    //
    // The built-in is recognised FIRST, so a `.winter/commands/compact.md` in an untrusted clone
    // cannot shadow a built-in with real engine-side power (the same self-grant shape P5-A closes on
    // the settings side). The resolver is only ever offered a `/name` the engine did not claim.
    const builtinCommand = resolveBuiltinCommand(userFrame.text);
    let resolvedPromptText = userFrame.text;
    if (builtinCommand === undefined && commandResolver !== undefined && looksLikeCommand(userFrame.text)) {
      const resolution = await commandResolver.resolve(userFrame.text, config.cwd);
      if (resolution.kind === "expand") resolvedPromptText = resolution.text;
    }

    if (builtinCommand !== undefined) {
      // `/compact`. Deliberately produces a terminal `result` of its own: WS-04 §4.1 gives every
      // accepted user envelope exactly one terminal result, and a built-in that silently produced
      // none would hang any single-shot caller (query.ts's readLoop breaks on the result frame).
      // `permission_denials` is stamped here for the same reason every other terminal write does:
      // the field is pin-verified always-present.
      interruptCurrentTurn.current = null;
      const compactOutcome = await runManualCompaction(builtinCommand.args);
      output.write({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: compactOutcome, permission_denials: [] } });
      await flushStore();
      continue;
    }

    // WHOLE-BRANCH MINOR m3, DISCLOSED (fix wave). Both the provider history and the durable
    // transcript get the EXPANDED body, never `/review src` as the user typed it. A `/name` turn is
    // therefore recorded as a multi-kilobyte prompt with no trace of the command that produced it,
    // and a resumed session or a transcript reader sees prose the user never wrote.
    //
    // NOT CHANGED, and the reason is that both candidate fixes cost more than the defect. Recording
    // the ORIGINAL text would make the transcript disagree with what the provider actually saw --
    // the failure mode a replay is supposed to rule out. Recording BOTH (the original as the user
    // entry, the expansion as a sibling) is a new entry type in the dialect and therefore a
    // compatibility question against the pinned shape, which no capture answers: the pin is silent
    // on how it records an expanded command. Inventing a shape here would be Winter guessing at
    // parity in the one place parity is checkable byte-for-byte later.
    //
    // The cost is real but bounded, and it is a READABILITY cost, not a correctness one: nothing
    // downstream needs the original text, and the expansion is exactly what the model was given.
    // Carried for a capture.
    const userText = resolvedPromptText;
    messages.push({ role: "user", content: userText });
    await recordUser(userText);

    // Phase 5 Task 3: assembled AFTER the envelope is recorded (so a store failure never leaves an
    // assembled-but-unrecorded turn) and BEFORE the first provider call of the turn.
    const assembled = assemblePrompt();

    // R5-10: the attempt budget is PER ENVELOPE, not per run. Each user envelope is expected to
    // produce its own structured result, so a run-wide counter would let one envelope's failures
    // exhaust every later envelope's budget in a streaming session. Capture (6)'s harness is
    // single-shot, so the pin does not discriminate the two readings; this one is disclosed.
    let structuredOutputAttempts = 0;

    // R5-11: the id this envelope's file checkpoints are keyed by, and the unit `rewindFiles`
    // restores to. Minted per envelope even when checkpointing is off (it costs one uuid and keeps
    // the two paths structurally identical), but only DISCLOSED to the host -- on the turn's terminal
    // result, below -- when checkpointing is on, so no pre-P5 trace moves.
    const turnUserMessageUuid = randomUUID();

    // T9-CARRY 2 (reassigned to T10; WS-08 §1.1): "user envelope accepted, BEFORE the turn's
    // provider call" — fired here, after the envelope is durably recorded but before
    // provider.generate() is ever invoked. Its own output shape (additionalContext/sessionTitle/
    // suppressOriginalPrompt) is declaration-owned and OBSERVATIONAL at P2 (WS-08 §1.3 / open
    // question 4: "any gating behavior beyond the declaration is ... never assumed") — nothing here
    // consumes it; a future task that wants UserPromptSubmit to actually suppress/rewrite the
    // prompt has a real seam to build against (this call site), not a gap to discover.
    await fireObservationalHook("UserPromptSubmit", { payload: { prompt: userText } });

    // Finding 3 (P2 fix-wave): `permission_denials` is deliberately OMITTED from this variable's own
    // type — every one of the several construction sites below builds a plain result shape exactly
    // as before this fix wave; the field is stamped exactly once, at the single terminal-write site
    // (via a spread), rather than repeated at each `finalResult = {...}` assignment.
    let finalResult: Omit<Extract<SdkMessage, { type: "result" }>, "permission_denials"> | null = null;
    let interrupted = false;

    roundLoop: while (true) {
      // Phase 5 Task 3 (R5-10): `outputFormat` with no seam fails LOUDLY, on the first round, before
      // a single token is spent -- see EngineOptions.structuredOutput for why silence is the worse
      // outcome here.
      if (structuredOutputActive && structuredOutput === undefined) {
        finalResult = {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "outputFormat is configured but no structured-output seam is registered for this session, so no StructuredOutput tool could be generated (R5-10).",
        };
        break roundLoop;
      }

      // Phase 5 Task 3 (R5-4): the AUTO trigger. Checked before EVERY provider call of the turn, not
      // once per turn -- a long tool-using turn is exactly where a context window fills up, and a
      // check that only ran at turn start would let it overflow mid-turn with no recourse.
      await maybeAutoCompact();

      let turn: ProviderTurn;
      try {
        const outboundMessages = requestMessages(assembled.userContextBlocks);
        // P1 carry: the per-message cap, enforced BEFORE the request leaves the engine. Throws a
        // `ProviderTurnError`, so it lands on R6-F's result shape through the catch below.
        assertMessagesWithinCap(outboundMessages);
        const toolSpecs = providerToolSpecs();
        const raced = await raceInterrupt(
          provider.generate({
            messages: outboundMessages,
            // `exactOptionalPropertyTypes`: an empty assembled prompt omits the key entirely rather
            // than sending `system: ""`. The two are equivalent to a provider ("this host supplied no
            // system prompt" -- ProviderRequest's own contract), and omitting keeps every
            // pre-P5 consumer, fixture and recorded trace byte-identical to before this task.
            ...(assembled.system.length > 0 ? { system: assembled.system } : {}),
            // --- Phase 6 Task 3 (R6-3): the real adapter's inputs ----------------------------------
            //
            // Every one is CONDITIONALLY SPREAD, so a session that configures none sends the exact
            // `{ messages }`/`{ messages, system }` shape every pre-P6 provider double already sees.
            // An empty advertised set omits `tools` rather than sending `[]`: the two are different
            // requests to a real provider (the second says "you have no tools", the first says
            // nothing), and a session with no tools is the shape every P1-P5 fixture uses.
            ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
            ...(currentModel !== undefined ? { model: currentModel } : {}),
            ...(config.effort !== undefined ? { effort: config.effort } : {}),
            ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
            signal: turnAbort.signal,
            // R6-G: a MAIN-LOOP generation gets a sink. Auxiliary calls (the compaction summariser,
            // the classifier, the advisor, countTokens) build their own requests elsewhere and get
            // none -- capture (F) observed the pinned runtime suppressing exactly those events.
            sink: buildStreamSink(),
          }),
          interruptSignal,
        );
        if (raced.kind === "interrupted") {
          interrupted = true;
          break roundLoop;
        }
        turn = raced.value;
        // Phase 5 Task 2 (R5-3): the ONE place this run folds a generation's reported usage into
        // the session's context accounting. A provider that reports no usage (every P1/P3/P4 test
        // double, and any real provider family that omits it) simply leaves the accountant reading
        // whatever the last reporting turn said -- never a fabricated number. Nothing in this phase
        // ACTS on the accountant yet: R5-4's threshold read and the compaction it triggers are Task
        // 3's and Lane K's, which is why the accountant is also an EngineOptions injection point.
        if (turn.usage !== undefined) contextAccountant.record(turn.usage);
        // --- Phase 6 Task 3 (R6-C): the pinned REFUSAL frames -----------------------------------
        //
        // Emitted on `stopReason: "refusal"` and NOWHERE else. The distinction the pin draws and
        // capture (G) confirmed is the whole point: a model REFUSAL is frame-visible, an OVERLOAD
        // fallback is not (the pinned runtime swaps models with no frame at all), so `fallbackModel`
        // never triggers these -- Winter's own `system/model_switch` covers that case instead.
        //
        // ONLY the no-fallback arm is emitted here. `model_refusal_fallback` requires the retry to
        // have actually happened on a fallback model (its `fallback_model`/`direction`/
        // `retracted_message_uuids` describe a swap that occurred), and engaging a fallback is the
        // switch coordinator's -- T10/Lane C's -- half of R6-C. Emitting the pair's other arm from
        // here would announce a retry that never took place.
        if ("stopReason" in turn && turn.stopReason === "refusal" && (config.fallbackModel === undefined || config.fallbackModel.trim().length === 0)) {
          output.write({
            type: "data",
            message: {
              type: "system",
              subtype: "model_refusal_no_fallback",
              trigger: "refusal",
              original_model: currentModel ?? "",
              // Winter has no provider request id on this seam -- `null` is the pinned spelling for
              // its absence, never an invented value.
              request_id: null,
              content: turn.kind === "text" ? turn.text : (turn.text ?? ""),
              uuid: randomUUID(),
              session_id: config.sessionId,
            },
          });
        }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        // Phase 6 Task 3 (R6-F, capture (I)): a PROVIDER failure lands on `subtype: "success"` with
        // `is_error: true`, `terminal_reason: "api_error"` and `api_error_status: <status | null>` --
        // the pinned shape, which has no provider-specific result subtype at all
        // (`SDKResultError`'s union is four members, none of them provider-shaped). Any OTHER throw
        // stays `error_during_execution`, byte-identical to before this task.
        finalResult = isProviderTurnError(err)
          ? { type: "result", subtype: "success", is_error: true, result: text, terminal_reason: "api_error", api_error_status: err.status ?? null }
          : { type: "result", subtype: "error_during_execution", is_error: true, result: text };
        break roundLoop;
      }

      if (turn.kind === "text") {
        // Phase 6 Task 3 (R6-8): IN-DIALECT thinking blocks lead the content, carrying their REAL
        // signatures. `turn.thinking.blocks` is Anthropic-family only, by the seam's own contract --
        // a foreign `summary`/`exposed` never becomes a block here (that is what
        // `system/reasoning_summary` and the sidecar's `summary` record are for), because the pinned
        // runtime materialises `signature: ""` on any thinking block that lacks one and replays it
        // verbatim, so a foreign summary written here would ride a fabricated signature (capture (F)).
        const thinkingBlocks = ("thinking" in turn ? turn.thinking?.blocks : undefined) ?? [];
        const assistantBlocks: ContentBlock[] = [...thinkingBlocks, { type: "text", text: turn.text }];
        // Sign-off 5 (whole-branch review): this write intentionally precedes its record-await —
        // the terminal result below is the sole durability barrier for this turn; P6 (partial
        // streaming) must revisit this ordering once intermediate frames become resumable state.
        output.write({ type: "data", message: { type: "assistant", message: { content: assistantBlocks } } });
        // The in-memory history keeps the bare STRING when there is nothing but text -- that is the
        // shape `rebuildProviderMessages` collapses a single-text-block entry back to, and changing
        // it would make a resumed session's history differ from a continuous one's (resume.test.ts's
        // own continuous-vs-split fidelity test).
        // RECORDED FIRST so the in-memory message can carry the same anchor uuid the sidecar record
        // names. A live session's history and the same session's RESUMED history must agree on every
        // assistant message's `uuid` -- that agreement is what the continuation chain is keyed on,
        // and resume.test.ts's continuous-vs-split fidelity test pins it.
        const textAnchor = await recordAssistant(assistantBlocks, turnProvenance(turn));
        messages.push({ role: "assistant", content: thinkingBlocks.length === 0 ? turn.text : assistantBlocks, ...(textAnchor !== undefined ? { uuid: textAnchor } : {}), ...providerAnnotations(turn) });
        finalResult = { type: "result", subtype: "success", is_error: false, result: turn.text };
        break roundLoop;
      }

      // tool_use: one round trip regardless of how many calls it batches ("a tool round = provider
      // tool_use → execute → results appended → provider again" — counted once per such cycle).
      rounds++;
      if (config.maxTurns !== undefined && rounds > config.maxTurns) {
        finalResult = { type: "result", subtype: "error_max_turns", is_error: true };
        break roundLoop;
      }

      // Phase 6 Task 3 (R6-3): thinking blocks lead, then the turn's own TEXT, then the calls.
      //
      // `turn.text` is the field R6-3 adds for exactly this: a real model returns text AND calls in
      // one turn, and before it existed that text had nowhere to go and was silently discarded --
      // losing a whole assistant utterance from the transcript with nothing failing anywhere. It
      // persists as a LEADING text block, which is the order the model produced it in.
      const toolUseBlocks: ContentBlock[] = [
        ...(("thinking" in turn ? turn.thinking?.blocks : undefined) ?? []),
        ...(turn.text !== undefined && turn.text.length > 0 ? [{ type: "text" as const, text: turn.text }] : []),
        ...turn.calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
      ];
      // Sign-off 5 (whole-branch review): this write intentionally precedes its record-await — the
      // terminal result is the sole durability barrier; P6 (partial streaming) must revisit this.
      output.write({ type: "data", message: { type: "assistant", message: { content: toolUseBlocks } } });
      const callAnchor = await recordAssistant(toolUseBlocks, turnProvenance(turn));
      messages.push({ role: "assistant", content: toolUseBlocks, ...(callAnchor !== undefined ? { uuid: callAnchor } : {}), ...providerAnnotations(turn) });

      const resultBlocks: ContentBlock[] = [];
      // Set (alongside `finalResult`) exactly when a call in THIS round throws — kept as its own
      // variable, rather than re-deriving from `finalResult`, because `finalResult` can ALSO be set
      // by the provider.generate() catch above, which already does its own `break roundLoop` and
      // never reaches this point in the same iteration; this flag only ever reflects a throw from
      // the loop directly below it.
      let toolThrowText: string | null = null;
      // Phase 5 Task 3 (R5-10): set when a StructuredOutput call ENDED this turn (accepted or
      // exhausted). Its own flag rather than a re-derivation from `finalResult`, for exactly the
      // reason `toolThrowText` above is one -- `finalResult` has several other producers.
      let structuredTerminated = false;
      for (const call of turn.calls) {
        // --- Phase 5 Task 3 (R5-10): the host-generated StructuredOutput tool -----------------------
        //
        // Handled BEFORE every other execution-boundary check, and deliberately outside the try:
        // this tool has no executor, no permission class a rule could sensibly name, and no WS-06
        // descriptor -- the availability and load-first checks below would refuse it on all three
        // counts. It is not a tool the model "uses"; it is how the model RETURNS.
        //
        // A valid call ENDS THE TURN with `result.structured_output`. An invalid one returns a
        // validation-error tool result and burns one attempt, so the model can correct itself on the
        // next round. Exhaustion terminates with BOTH pinned spellings on their own fields (item (d)):
        // `subtype: "error_max_structured_output_retries"` and
        // `terminal_reason: "structured_output_retry_exhausted"`, and NO `structured_output` at all
        // (it is declared on the success variant only -- an exhausted run has no output, not a null one).
        if (structuredOutputActive && structuredOutput !== undefined && call.name === STRUCTURED_OUTPUT_TOOL_NAME) {
          structuredOutputAttempts++;
          const validation = structuredOutput.validate(outputFormatSchema!, call.input);
          if (validation.ok) {
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: "Structured output accepted." });
            finalResult = { type: "result", subtype: "success", is_error: false, structured_output: validation.value };
            structuredTerminated = true;
            break;
          }
          if (structuredOutputAttempts >= maxStructuredOutputAttempts) {
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: `Structured output validation failed: ${validation.errors.join("; ")}`, error: true });
            finalResult = {
              type: "result",
              subtype: "error_max_structured_output_retries",
              is_error: true,
              result: `Failed to provide valid structured output after ${structuredOutputAttempts} attempts`,
              terminal_reason: "structured_output_retry_exhausted",
            };
            structuredTerminated = true;
            break;
          }
          resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: `Structured output validation failed: ${validation.errors.join("; ")}. Call ${STRUCTURED_OUTPUT_TOOL_NAME} again with a corrected value.`, error: true });
          continue;
        }
        try {
          // Phase 4 Task 3 (MUST 6, WS-09 §8.2/§8.5): the load-first execution-boundary check runs
          // BEFORE permission evaluation even starts — an unloaded deferred tool is not yet
          // ELIGIBLE to run at all, independent of whether it would otherwise be allowed, so this
          // rejection never consumes a canUseTool prompt (WS-09 §8.2's own "load ≠ permission": the
          // inverse also holds -- loading a tool never authorizes it, and NOT having loaded it is
          // resolved here, not by the permission pipeline at all). Never executed; the round
          // continues to the next call.
          // Phase 4 Task 8 (rider 27): the AVAILABILITY execution-boundary check, structurally
          // parallel to the load-first check immediately below and for the same reason -- a tool
          // this session's own configuration EXCLUDES is not eligible to run at all, independent of
          // whether it would otherwise be permitted, so the rejection must land before the
          // permission pipeline is ever entered.
          //
          // It cannot live only in registry.ts's dispatch adapter (where it also runs, as
          // defence-in-depth for a non-engine caller): a tool whose own permission class forces an
          // interactive prompt never REACHES dispatch. `AskUserQuestion` -- the exact tool WS-06
          // §3.3 declares "not available inside Agent-tool subagents", and the exact case Lane C's
          // I3 finding was about -- parks on a permission RPC first, and inside a child that RPC is
          // answered by nobody, so the call hung until the stall watchdog aborted the whole child.
          // Empirically confirmed while wiring this: with the check only in the adapter, a child
          // calling AskUserQuestion still stalled. Checking here turns it into an immediate typed
          // refusal and the child continues normally.
          const availabilityDescriptor = getRegisteredTool(call.name)?.descriptor;
          if (availabilityDescriptor !== undefined && !isToolAvailable(availabilityDescriptor, { ...advertisedCfg, mode: policyStateStore.getState().mode })) {
            resultBlocks.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: `'${call.name}' is not available in this session's current configuration (WS-06 §1.5 availability) -- it is registered but excluded here, so it was not executed`,
              error: true,
            });
            continue;
          }
          // NEW-5 (residual round): an ALIAS-EXCLUDED name is refused with the reason it was taken
          // away, not with the load-first hint. The two look identical from the load-first
          // predicate's side -- a hidden Winter twin is still `deferred: true` at its source, so
          // `resolveDeferral` says "deferred" and `isDeferredAndUnloaded` says "unloaded" -- but the
          // hint it produces ("use ToolSearch to select it") is unfollowable: the same exclusion pass
          // removed the name from ToolSearch's own pool, so the model is sent to a search that can
          // never return it. Checked HERE, with the availability family, deliberately BEFORE the
          // load-first boundary: it is an exclusion, not a not-yet-loaded state.
          //
          // Ordering is otherwise untouched -- load-first still precedes the permission pipeline
          // (VERIFIED-CLEAN), and a genuinely deferred-but-loadable tool still gets the hint below.
          if (isDeferredAndUnloaded(call.name)) {
            // NEW-5 (residual round): the load-first branch picks its MESSAGE by why the name is
            // missing. A hidden Winter twin satisfies this predicate for the wrong reason -- it is
            // still `deferred: true` at its source, so `resolveDeferral` says "deferred" -- but the
            // hint "use ToolSearch to select it" is unfollowable: the same alias-exclusion pass
            // removed it from ToolSearch's own pool, so the model is sent to a search that can never
            // return it. Deciding INSIDE this branch (rather than ahead of it) is what keeps the
            // change surgical: ordering is untouched, load-first still precedes the permission
            // pipeline (VERIFIED-CLEAN), and every name that is NOT deferred-and-unloaded -- including
            // the same twin with Tool Search inactive -- still falls through to the permission
            // pipeline and gets a real rule denial with its `permission_denied` frame.
            const excludedReason = aliasExclusionLive(call.name);
            resultBlocks.push(
              excludedReason !== undefined
                ? {
                    type: "tool_result",
                    tool_use_id: call.id,
                    content: `'${call.name}' is not available in this session: ${excludedReason}. It cannot be loaded with ToolSearch either -- the same exclusion removes it from the searchable pool.`,
                    error: true,
                  }
                : {
                    type: "tool_result",
                    tool_use_id: call.id,
                    content: `'${call.name}' is a deferred tool that has not been loaded this session yet -- use ToolSearch to select it before calling it (WS-09 §8.5)`,
                    loadFirst: true,
                  },
            );
            continue;
          }
          // Task 6 (WS-07 §2, WS-04 §4 ordering rule 5): the permission gate slots HERE — between
          // this round's tool_use emission (already written/pushed/recorded above) and execution.
          // Calls in one round evaluate SEQUENTIALLY in call order (this `for` loop's own order); a
          // deny produces its synthetic tool_result and the loop CONTINUES to the next call — it
          // does not `break` the round, matching "each-call-independent" semantics (unlike an
          // interrupt or a thrown executor, which legitimately do stop the round early below).
          const permissionInput = typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {};
          // RULING P4-E AMENDED (fix wave, whole-branch C2 + T8-review M6): the hook/permission
          // identity is alias-aware in BOTH directions -- a rule naming EITHER spelling governs both.
          //
          // P4-E's unamended half is untouched: `call.name` still drives registry lookup, execution
          // and the load-first predicate (the checks above, `executedCall` and `tools.execute` below).
          // Only the name the permission pipeline and hook matchers are matched AGAINST is resolved
          // here -- WS-09 §10's "hook and permission matching run on the canonical post-alias
          // identity" -- and the PRIMARY candidate is still exactly `resolveToolAlias(call.name,
          // config.toolAliases)`, so a session that configures no aliases and writes no rule against
          // a canonical twin is byte-identical to before this amendment.
          //
          // What changed: the alternates. `resolvePermissionIdentity` walks the single-hop
          // equivalence set over the EFFECTIVE table (Winter defaults + host) and picks the
          // STRICTEST identity that anything actually matches -- deny, then ask, then an explicit
          // hook matcher, then allow. One evaluation, never two (a second `evaluate()` for the twin
          // would prompt the user twice for an `ask`).
          //
          // The probes read the SAME live state the evaluation itself will: `evalCtxForIdentity` is
          // this call's own `makeEvalCtx()` snapshot (so a mid-flight rule change is handled by
          // evaluateWithFreshPolicy's existing stale-policy retry, not by a second notion of "live"),
          // and `hookRegistry.matching` is the identical selector the hook stage runs. Matcher-ABSENT
          // hook entries are filtered out: WS-08 §2.1 makes them match every occurrence, so counting
          // them would let one global hook flip the identity of every call in the session.
          const evalCtxForIdentity = makeEvalCtx();
          const probeRule = (behavior: "deny" | "ask" | "allow") => (candidate: string): boolean =>
            findMatchingRuleEntry(evalCtxForIdentity.policy.rules, { toolName: candidate, input: permissionInput, toolUseId: call.id }, behavior, evalCtxForIdentity) !==
            undefined;
          const permissionCall: PermissionCall = {
            toolName: resolvePermissionIdentity(call.name, config.toolAliases, {
              deniedByRule: probeRule("deny"),
              askedByRule: probeRule("ask"),
              hookScoped: (candidate: string): boolean =>
                (["PreToolUse", "PermissionRequest"] as const).some((event) => hookRegistry.matching(event, candidate).some((e) => e.matcher !== undefined)),
              allowedByRule: probeRule("allow"),
            }),
            input: permissionInput,
            toolUseId: call.id,
            // Phase 4 Task 3 (MUST 9): the identical agentID a child engine's own hook stage/audit
            // already carry (createHookStage/fireObservationalHook above) -- PermissionCall.agentId
            // existed as a P3-era seam (evaluator.ts's own header) with no production caller
            // supplying it until now; feeds PromptStageMeta.agentID and the `permission_denied`/
            // `permission_deferred` stream messages' own `agent_id` field (both already conditional
            // on this field being set, unchanged since P2/T8).
            ...(config.agentId !== undefined ? { agentId: config.agentId } : {}),
          };
          const decisionRaced = await raceInterrupt(evaluateWithFreshPolicy(permissionCall), interruptSignal);
          if (decisionRaced.kind === "interrupted") {
            interrupted = true;
            break;
          }
          const decision = decisionRaced.value;

          // Denial emission, factored out (Task 11) so BOTH a real evaluate()-driven denial AND a
          // fail-closed-defer denial (this call's own new branch, below — no durable approval store
          // reachable, or persisting the record itself failed) share the identical tool_result +
          // permission_denied system message + PermissionDenied hook triple. `interrupt` stays OUT
          // of this helper deliberately: only a REAL PermissionDecisionRecord ever carries it
          // (WS-07 §7.2's own union) — an engine-originated fail-closed denial invents no such
          // signal, so the one real call site below still handles it inline, after calling this.
          const denyCall = async (message: string, mechanism: string, ruleRef?: string): Promise<void> => {
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: message, denied: true });
            // Finding 3 (P2 fix-wave, IMPORTANT): the ONE accumulation site — every denial reaches
            // here (hook/rule/mode/canUseTool/autoEngine, plus both fail-closed-defer cases below),
            // so this single push is the array's complete producer. `tool_input` is `permissionCall.
            // input` — the ORIGINAL, un-hook-transformed input the call was evaluated against
            // (matching the pinned 3-field shape's own semantics, and the tool_use block the model
            // itself already saw), never `executedCall.input`, which a canUseTool answer's own
            // updatedInput may have since narrowed/redirected.
            turnPermissionDenials.push({ tool_name: call.name, tool_use_id: call.id, tool_input: permissionCall.input });
            // Task 10 (WS-08 §6 / derived-shapes-p2.md item (d)): the public SDKPermissionDeniedMessage
            // is UNCONDITIONAL — never gated by includeHookEvents (that item's own "Correction to
            // this task's own brief framing": only the hook_started/hook_progress/hook_response
            // trio is gated) — and fires on ANY-stage denial regardless of `mechanism` (hook/rule/
            // mode/canUseTool/autoEngine all reach this one call site, plus Task 11's own two
            // engine-originated fail-closed-defer cases). Best-effort/advisory per that same item's
            // own load-bearing finding — the tool_result block above (and, since this fix wave,
            // `result.permission_denials`) is the authoritative record; this stream message is
            // UX/telemetry only. `decision_reason_type`/`decision_reason` are Winter's own mapping
            // of PermissionDecisionRecord's mechanism/ruleRef — the pinned declaration names the
            // fields without pinning their exact semantics beyond advisory/UI-facing.
            output.write({
              type: "data",
              message: {
                type: "system",
                subtype: "permission_denied",
                tool_name: call.name,
                tool_use_id: call.id,
                ...(permissionCall.agentId !== undefined ? { agent_id: permissionCall.agentId } : {}),
                decision_reason_type: mechanism,
                ...(ruleRef !== undefined ? { decision_reason: ruleRef } : {}),
                message,
                session_id: config.sessionId,
                uuid: randomUUID(),
              },
            });
            // WS-08's own PermissionDenied HOOK EVENT (distinct from the stream message above) —
            // purely observational (§6: "observes denials ... for logging/telemetry/UX; it cannot
            // reverse them"), fired for the SAME every-mechanism denial. Not raced against
            // interruptSignal (this whole call-info-building/firing step is synchronous-cheap and
            // deliberately unraced, matching the rpc_probe turn kind's own precedent elsewhere in
            // this file).
            await fireObservationalHook("PermissionDenied", {
              toolUseID: call.id,
              toolName: call.name,
              input: permissionCall.input,
              payload: { reason: message },
            });
          };

          // --- Task 11 (WS-07 §9 / WS-08 §7): a `defer` decision parks the call durably ----------
          if (decision.decision === "defer") {
            const deferMessage = decision.message ?? "a PreToolUse hook deferred this call for durable approval";
            // Fail-closed case 1: no durable approval store reachable for this run (e.g.
            // persistSession:false — there is nowhere to durably park a call that, by definition,
            // needs to survive this process exiting). WS-07 §6.1's "never implicitly allowed" floor
            // applies just as much to an un-parkable park as to an unresolved prompt — a phantom
            // "[deferred]" marker nothing could ever resume would be strictly worse than a denial.
            if (!approvalStore) {
              await denyCall(`Denied: cannot defer -- no durable approval store is available for this session (${deferMessage})`, "hook");
              continue;
            }
            const requestId = randomUUID();
            const executedInput = decision.transformedInput ?? permissionCall.input;
            const approval: DurableApprovalRecord = {
              runtimeKind: WINTER_RUNTIME_KIND,
              sessionId: config.sessionId,
              backendSessionId: config.sessionId,
              requestId,
              toolUseID: call.id,
              ...(permissionCall.agentId !== undefined ? { agentID: permissionCall.agentId } : {}),
              toolName: call.name,
              originalInput: executedInput,
              displayMetadata: { decisionReason: deferMessage },
              policyMode: policyStateStore.getState().mode,
              policyVersion: decision.policyVersion,
              // Item 10 (P2 fix-wave): the content-based hash a later resume's own revalidation
              // compares against (see approvals.ts's own revalidateApproval comment). Computed from
              // the SAME live policyStateStore.getState() `decision.policyVersion` was itself
              // stamped from -- evaluateWithFreshPolicy's own re-evaluation loop guarantees the two
              // already agree by the time this branch runs, so this is exactly the policy the
              // deferred decision was actually made under, not a later, possibly-already-moved-on
              // snapshot.
              policyHash: computePolicyHash(policyStateStore.getState()),
              issuedAt: new Date().toISOString(),
              state: "pending",
              issuedCwd: config.cwd,
              issuedHome: permissionHome,
            };
            // Fail-closed case 2: the store exists but persisting THIS record threw. Unlike
            // recordUser/recordPermissionUpdate/recordHookAudit (auxiliary mirrors of in-memory
            // truth the turn is already correct without), the persisted approval record IS the
            // feature here — "the run can END cleanly with the record persisted" (this task's own
            // brief) presumes persistence succeeded. A park whose record failed to write is
            // unresolvable forever (worse than a denial, which the agent can at least react to) —
            // so this is its own denial, never a swallowed auxiliary failure, and the synthetic
            // "[deferred]" marker below is never emitted for a record that was never actually
            // durable.
            try {
              approvalStore.record(approval);
            } catch (err) {
              const text = err instanceof Error ? err.message : String(err);
              await denyCall(`Denied: failed to persist the durable approval record (${text})`, "hook");
              continue;
            }
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: "[deferred]", deferred: true });
            // Winter-original public system message (no pinned upstream shape exists for a durable
            // defer — WS-07 §9 itself frames the durable-approval layer as a Winter product
            // addition over the SDK-compatible surface, not an upstream wire pin, unlike
            // permission_denied's own derived-shapes provenance). Mirrors permission_denied's own
            // field shape/spirit; `request_id` is this record's own correlator for a later
            // out-of-band respond().
            output.write({
              type: "data",
              message: {
                type: "system",
                subtype: "permission_deferred",
                tool_name: call.name,
                tool_use_id: call.id,
                ...(permissionCall.agentId !== undefined ? { agent_id: permissionCall.agentId } : {}),
                request_id: requestId,
                message: deferMessage,
                session_id: config.sessionId,
                uuid: randomUUID(),
              },
            });
            continue;
          }

          if (decision.decision !== "allow") {
            // decision.decision === "deny" here (defer is handled above; a matched ask rule is
            // already resolved to a terminal allow/deny by the prompt stage inside evaluate() itself,
            // never surfaced as its own pending state). Cross-task pin: a denial is a NORMAL
            // tool_result, `denied: true`, flowing through the SAME emit/push/record cluster below
            // as every other result — this is what makes dontAsk's deny-not-hang fall out
            // structurally (WS-07 §6.3).
            const deniedMessage = decision.message ?? "Permission denied";
            await denyCall(deniedMessage, decision.mechanism, decision.ruleRef);
            // Task 8 (WS-07 §7.2): a deny's `interrupt: true` ADDITIONALLY triggers the engine's
            // existing interrupt path — "interrupt can stop more than the individual call." Mirrors
            // every other in-round interrupt trigger: mark `interrupted`, fire the SAME turn-wide
            // signal a host-originated `interrupt` control request fires (so any later await in this
            // turn also observes it), and stop processing further calls in this round — the
            // post-loop padding logic below fills in synthetic `[interrupted]` results for any call
            // this round never got to. `allow` never carries `interrupt` (WS-07 §7.2's own union),
            // so this check is scoped to the deny branch by construction, not by an extra guard.
            if (decision.interrupt === true) {
              interrupted = true;
              interruptCurrentTurn.current?.();
              break;
            }
            continue;
          }
          // Task 8 (WS-07 §7.2): updatedPermissions applies each suggested update to the LIVE
          // policy, bumping policyVersion (authority "session" — a canUseTool answer is a live
          // session interaction, never a direct settings-file edit; policy-state.ts's own authority
          // gate still governs whether a file-destined suggestion may actually land there). Applied
          // BEFORE executing this call: the update affects FUTURE calls only (this call's own
          // decision is already final), so ordering relative to tools.execute() below is not
          // observable either way — applying it here simply keeps every side effect of "the
          // permission decision resolved" together, before moving on to "now run the tool."
          if (decision.updatedPermissions) {
            for (const update of decision.updatedPermissions) {
              // Finding 8 (P2 fix-wave, MINOR): (a) applyUpdate's OWN {ok:false} result (the bypass
              // gate rejecting a setMode suggestion) was previously discarded — the update was
              // journaled as APPLIED regardless, so a bypass-gated setMode suggestion was rejected
              // LIVE but journaled as though it had succeeded (P5's replay would faithfully write a
              // mutation the live gate refused — the P2-H envelope work exists precisely so the
              // journal never misleads replay). (b) applyUpdate's OWN typed throws (an invalid rule
              // inside addRules/replaceRules -> PermissionRuleValidationError; a forged destination
              // -> PermissionUpdateAuthorityError) previously escaped uncaught into this round's own
              // try/catch, turning an ALREADY-APPROVED call into a whole-turn error_during_execution
              // over nothing worse than one bad suggestion string — policy-state.ts's own applyUpdate
              // comment flagged this exact caller as needing its own try/catch, never honored until
              // now. Both failure modes below drop ONLY the suggestion (stderr note, journal
              // untouched) — the call itself was already approved and proceeds regardless.
              try {
                // Task 11: door 2 of 2 (policy-state.ts's own "second door into the same room" —
                // `applyUpdate` can carry a `type:"setMode"` update just as easily as a direct
                // set_permission_mode control request) — see cancelPendingApprovalsOnModeSwitch's own
                // header. Captured/compared around applyUpdate regardless of update type; a no-op for
                // every non-"setMode" update since the mode value cannot have moved.
                const previousMode = policyStateStore.getState().mode;
                const applied = policyStateStore.applyUpdate(update, { authority: "session" });
                if (!applied.ok) {
                  console.error(`winter: dropped a canUseTool/hook-suggested permission update rejected by the bypass gate (${applied.error.code}): ${applied.error.message}`);
                  continue;
                }
                cancelPendingApprovalsOnModeSwitch(previousMode, policyStateStore.getState().mode);
                // Phase ruling 2: "applies session-effective immediately AND appends to the
                // permission journal" — the live application above and the durability journal below
                // are two independent effects of the SAME update, not a fallback chain; journaling
                // failure (auxiliary, see recordPermissionUpdate's own comment) never undoes or
                // blocks the live application that already happened.
                await recordPermissionUpdate(update, "session");
              } catch (err) {
                const text = err instanceof Error ? err.message : String(err);
                console.error(`winter: dropped a malformed canUseTool/hook-suggested permission update: ${text}`);
              }
            }
          }
          // WS-07 §7.2: updatedInput/transformedInput sanitizes/narrows/redirects the EXECUTED call
          // — the tool_use block already emitted above keeps the model's ORIGINAL input; only what
          // actually runs (and therefore the tool_result that comes back) reflects the transform.
          // SEAM (P3, no tool registry/schema yet at P2): a host-supplied updatedInput is taken
          // verbatim, with no re-validation against the tool's own input schema before execution —
          // P3's tool registry (WS-06) is where that re-check belongs; until then a canUseTool
          // callback that returns a shape the target tool cannot handle surfaces as that tool's own
          // execution error, not a permission-layer one.
          const executedCall = decision.transformedInput !== undefined ? { ...call, input: decision.transformedInput } : call;

          // --- Phase 5 Task 3 (R5-11): backup-before-modify ---------------------------------------
          //
          // Placed HERE, after permission approval and after any transform, and before execution:
          // backing up a file for a call that is about to be DENIED would write backups for edits
          // that never happen, and backing up the pre-transform path would back up a file the
          // approved call no longer touches.
          //
          // Keyed on the CANONICAL post-alias identity (`permissionCall.toolName`), not `call.name`,
          // so a session that aliases `Write` still checkpoints -- the same identity rule WS-09 §10
          // sets for hooks and permissions.
          //
          // Paths come from the SAME extraction the permission layer used (`extractCandidateWritePaths`),
          // never a bespoke `input.file_path` read: a second extraction would drift from the one that
          // decided whether the write was allowed at all.
          //
          // A sink that throws is AUXILIARY, exactly like a store failure: the user's edit still
          // happens, and the failure surfaces as a status message rather than a dead turn. That is
          // the safe direction for the user's work and the unsafe one for undo, which is why it is
          // reported rather than swallowed.
          if (enableFileCheckpointing && fileCheckpointSink !== undefined && isCheckpointedTool(permissionCall.toolName)) {
            const checkpointTool: CheckpointedTool = permissionCall.toolName;
            for (const path of extractCandidateWritePaths({ ...permissionCall, input: typeof executedCall.input === "object" && executedCall.input !== null ? (executedCall.input as Record<string, unknown>) : {} }, makeEvalCtx())) {
              try {
                await fileCheckpointSink.beforeMutation({ path, tool: checkpointTool, userMessageUuid: turnUserMessageUuid, sessionUuid: config.sessionId });
              } catch (err) {
                const text = err instanceof Error ? err.message : String(err);
                output.write({ type: "data", message: { type: "system", subtype: "status", status: null, compact_result: undefined, uuid: randomUUID(), session_id: config.sessionId, checkpoint_error: text } });
              }
            }
          }

          // R6-6: the SAME per-turn signal `provider.generate` receives. The race still unwinds the
          // turn promptly; the signal is what stops the work the race walked away from.
          const raced = await raceInterrupt(tools.execute(executedCall, { signal: turnAbort.signal }), interruptSignal);
          if (raced.kind === "interrupted") {
            interrupted = true;
            break;
          }
          resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: raced.value.output });
          // Task 10 (WS-08 §5; PreToolUse/PostToolUse/PostToolUseFailure "fire at the tool round"):
          // contribution-capable, observational at P2 — its own transformedOutput/extraContext
          // fields still have no consumer (a future WS-08 task's job); `classifierContext` DOES have
          // a consumer now (Task 12, WS-07 §10.4/§10.6-8) — see the accumulation immediately below.
          // Fired + audited + streamed regardless, per the SAME "declaration-owned... not silently
          // assumed" posture as every other ad hoc call site in this function. Fires ONLY after a
          // genuinely successful execution — never for a denied call (never executed at all) or an
          // interrupted one (abandoned mid-flight, not completed).
          const postToolUseComposite = await fireObservationalHook("PostToolUse", {
            toolUseID: call.id,
            toolName: call.name,
            input: executedCall.input as Record<string, unknown>,
            payload: { tool_response: raced.value.output },
          });
          // Task 12: T9's own accumulation contract (reducer.ts's Rule 4) is "unconditional, never
          // override-discard" — mirrored here at the one place this composite is actually consumed.
          if (postToolUseComposite.classifierContext !== undefined) {
            accumulatedClassifierContext.push(...postToolUseComposite.classifierContext);
          }
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          finalResult = { type: "result", subtype: "error_during_execution", is_error: true, result: text };
          toolThrowText = text;
          // Task 10 (WS-08 §5): the failure-arm sibling of PostToolUse above — fires when this
          // call's own tool executor threw (or, less commonly, when an earlier step in this SAME
          // try block threw first, e.g. evaluateWithFreshPolicy or the updatedPermissions loop —
          // `executedCall`/`decision` are try-block-scoped and not reachable from `catch`, so this
          // uses `call`'s own raw, untransformed input, the one value guaranteed available
          // regardless of which line inside the try actually threw).
          await fireObservationalHook("PostToolUseFailure", {
            toolUseID: call.id,
            toolName: call.name,
            input: typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {},
            payload: { error: text },
          });
          break;
        }
      }

      if (toolThrowText !== null) {
        // Ruling P1-H: the tool_use/tool_result pairing invariant must hold in ACCUMULATED HISTORY
        // (and on the wire, and in persistence) even when a tool executor THROWS mid-round — the
        // assistant's tool_use was already pushed into `messages` above, so every one of its calls
        // needs a matching tool_result or the history a real provider's next request (and Task 8's
        // persistence) would carry a dangling tool_use, which a real provider rejects outright.
        // Provisional shape pending official capture (same class as the interrupted-result shape
        // below, whose comment this mirrors): content "[error: <thrown>]" + `error: true` marks a
        // call that never got a real result because its round's tool executor threw — covers both
        // the call that threw and any calls after it in this round that never got to run. Uses the
        // SAME Error-message-or-String(err) rendering as `finalResult.result` above (`text`) rather
        // than an unconditional `String(thrown)` — see the task-8 report's deviations for why.
        const resultedIds = new Set(resultBlocks.map((b) => (b as { tool_use_id: string }).tool_use_id));
        for (const call of turn.calls) {
          if (!resultedIds.has(call.id)) {
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: `[error: ${toolThrowText}]`, error: true });
          }
        }
      }

      if (structuredTerminated) {
        // Ruling P1-G/P1-H's pairing invariant, third case (Phase 5 Task 3): a StructuredOutput call
        // that ends the turn leaves any LATER call in the same round unexecuted, so each still needs
        // a tool_result or the persisted history carries a dangling tool_use that a real provider
        // rejects outright on the next request.
        const resultedIds = new Set(resultBlocks.map((b) => (b as { tool_use_id: string }).tool_use_id));
        for (const call of turn.calls) {
          if (!resultedIds.has(call.id)) {
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: "[not executed: the turn ended on a structured-output result]", error: true });
          }
        }
      }

      if (interrupted) {
        // Ruling P1-G: the tool_use/tool_result pairing invariant must hold in ACCUMULATED HISTORY
        // even when a round is cut short — the assistant's tool_use was already pushed into
        // `messages` above, so every one of its calls needs a matching tool_result or the history
        // Task 8 persists (and any real provider's next request) carries a dangling tool_use, which
        // a real provider rejects outright. Provisional shape pending official capture (same
        // standing pattern as the interrupted-result shape below): content "[interrupted]" +
        // `interrupted: true` marks a call that never got a real result because the turn was
        // interrupted — covers both "never started" and "was mid-execution when interrupted" calls.
        const resultedIds = new Set(resultBlocks.map((b) => (b as { tool_use_id: string }).tool_use_id));
        for (const call of turn.calls) {
          if (!resultedIds.has(call.id)) {
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: "[interrupted]", interrupted: true });
          }
        }
      }

      // Emitted/pushed/recorded unconditionally (normal completion, padded-after-interrupt, OR
      // padded-after-throw) so the wire, the in-memory history, and persistence never disagree about
      // whether this round's tool_result exists — an implementation-shape choice under P1-G (later
      // extended by P1-H to the throw path): previously nothing was emitted here on interrupt (nor,
      // until P1-H, on a throw), which under-delivered relative to WS-04 §5's drain-after-interrupt
      // contract ("buffered data of the interrupted turn, then its terminal result").
      // Sign-off 5 (whole-branch review): this write intentionally precedes its record-await — the
      // terminal result is the sole durability barrier; P6 (partial streaming) must revisit this.
      output.write({ type: "data", message: { type: "user", message: { content: resultBlocks } } });
      messages.push({ role: "tool", content: resultBlocks });
      await recordUser(resultBlocks);

      if (finalResult) break roundLoop; // relocated below the emit/push/record (Ruling P1-H) — see comment above
      if (interrupted) break roundLoop;
      // loop back for the next provider.generate() call
    }

    // T9-CARRY 2 (reassigned to T10; WS-08 §1.1): "when the main agent is about to stop" — fired
    // HERE, deliberately BEFORE the turn's terminal result is written below (advisor-confirmed
    // placement, not merely tidy): the single-shot wrapper's own readLoop only breaks out once it
    // observes the terminal `result` data frame (query.ts), so it is STILL actively reading stdout
    // at this exact point — a Stop hook RPC issued here is genuinely answerable on every prompt
    // shape. Firing it any later (e.g. after the result write) would make it unanswerable in
    // single-shot mode for the identical structural reason SessionEnd needed the bridge's
    // closed-flag fix (see that call site's own comment, further down this function). Declaration-
    // owned/observational output (WS-08 §1.3, §13 open question 4) — not consumed here.
    await fireObservationalHook("Stop", { payload: { stop_hook_active: false } });

    interruptCurrentTurn.current = null;

    // Terminal-over-abort (WS-04 §5 drain-after-interrupt; the same principle query.ts's wrapper
    // pins for its own abort-vs-terminal race): a turn that genuinely completed wins even if an
    // interrupt landed in the same tick as completion (e.g., during the recordAssistant/recordUser
    // await just before this check). Only the ABSENCE of a terminal result falls through to the
    // provisional interrupted shape.
    //
    // Finding 3 (P2 fix-wave): `permission_denials` is stamped HERE, once, regardless of which of
    // the several `finalResult = {...}` construction sites above (or the provisional
    // interrupted-result fallback below) produced this turn's terminal shape — a single seam rather
    // than instrumenting every construction site individually. Pin-verified ALWAYS PRESENT (never
    // optional) on the real declaration, so every result carries it, `[]` when this turn denied
    // nothing.
    if (finalResult) {
      // R5-11: `user_message_uuid` is how a host learns the id to pass to `rewindFiles`. Winter emits
      // no user-message frame of its own (the pinned surface's `SDKUserMessage.uuid` is its channel),
      // so the envelope's terminal result is the one place the id can travel. CONDITIONAL on
      // checkpointing being enabled, so every pre-P5 golden trace stays byte-identical. Disclosed as
      // a Winter-defined discovery channel.
      output.write({ type: "data", message: { ...finalResult, permission_denials: turnPermissionDenials, ...(enableFileCheckpointing ? { user_message_uuid: turnUserMessageUuid } : {}) } });
      // B-H1(c) point 2 (the second half): the turn is over and the state machine is back in `idle`.
      // Emitted AFTER the result so an observer that acts on it sees the result first.
      emitNotification("idle", "Waiting for input.");
    } else {
      // Provisional shape pending official capture (standing controller ruling) — no `result` text.
      output.write({ type: "data", message: { type: "result", subtype: "success", is_error: false, interrupted: true, permission_denials: turnPermissionDenials } });
    }
    await flushStore();
  }

  // T9-CARRY 2 (reassigned to T10; WS-08 §1.1): "teardown" — fired HERE, after the turn loop has
  // fully drained but strictly BEFORE `stopReading()` below, so the pump (still alive at this exact
  // point per Ruling P2-B's own guarantee, point 2) can still route this hook RPC's eventual
  // control_response. This is the ONE lifecycle call site genuinely at risk of racing a dead
  // connection even with correct placement: a single-shot wrapper's own readLoop has ALREADY broken
  // out (it stops reading stdout entirely the instant it sees the turn's terminal `result` frame,
  // written well before this point) and closes its stdin shortly after — meaning THIS runtime's own
  // `input` can hit true EOF (triggering the pump's `bridge.rejectAllPending`, see that call site's
  // own comment) before or immediately after this request is even issued, regardless of how this
  // call site is placed. Structurally unanswerable in single-shot mode, not a race to win — which is
  // exactly why the bridge itself was extended (this task, rpc/bridge.ts) to reject a request
  // immediately once closed, rather than letting it sit until the 30s observational timeout: without
  // that fix, EVERY single-shot query with any hook configured would stall SessionEnd for up to 30s
  // before runEngine could return. With it, this call resolves promptly either way — a genuine
  // answer in streaming mode (the wrapper is still reading), or an immediate rejection (folded by
  // runHooks into a normal {kind:"error"} audit outcome, never a hang) in single-shot mode.
  await fireObservationalHook("SessionEnd", { payload: { reason: "other" } });

  // Ruling P2-B: the turn loop's own `for await (const userFrame of userFrames)` above has now
  // exited — every queued turn has fully drained (see the pump's own header, point 2) — so it is
  // now safe to explicitly cancel the pump's read. This is the NEW guarantee that ends the pump in
  // the inverted direction: if `input` already ended on its own (no end_input was ever sent), the
  // pump is already resolved and this is a harmless no-op; if the pump is still alive (end_input
  // was seen but `input` itself never closed), this is what actually stops it.
  stopReading();
  await pump.catch(() => {}); // the pump only throws on a truly unexpected input-source error; never let that crash teardown
  // Phase 4 Task 3 (registry singleton hygiene): unregisters every SDK-MCP-server tool this run
  // registered at startup -- the module-level tool registry (tools/registry.ts) is a process-wide
  // singleton every in-memory-leg run in one process shares (registry.ts's own header), so a
  // registration this run's own config.mcpServers introduced must not silently leak into the next
  // run's own advertised set once THIS run ends.
  for (const serverName of sdkMcpServerNames) {
    unregisterMcpServerTools(serverName);
  }
  // Phase 4 Task 8 (rider 11): tear down THIS run's own MCP lifecycle -- closes every live client
  // (process-group-killing a stdio child, per RULING P4-H) and unregisters every tool it registered
  // into the process-wide registry singleton. Only ever set when this run BUILT the lifecycle; a
  // caller-supplied state source/control seam is the caller's own to dispose.
  // Phase 4 Task 8: withdraw this run's child roster from the process-level messaging runtime --
  // a completed session's children must not keep appearing in another session's ListAgents.
  // Fix wave (I5): a BACKGROUND child that is still running at teardown outlives the session in the
  // in-memory leg (the child/compiled legs die with the process, main.ts) -- it kept executing tools
  // while being WITHDRAWN from the messaging roster one line below, i.e. live but unaddressable by
  // anything. Stopped here instead, BEFORE the withdrawal, and awaited (each `stop()` settles its
  // own generation) so a host that returns from `runEngine` has no live background descendants.
  //
  // FOREGROUND children are deliberately NOT swept here (the review's teardown finding is about the
  // background half): a foreground child is owned by the Agent call awaiting it -- it either
  // completes, in which case there is nothing to stop, or its call is interrupted, in which case
  // `abortForegroundChildren` above already stopped it. Residual, disclosed: a foreground-shaped
  // spawn that some other caller abandons WITHOUT an interrupt (this file's own test fixtures do
  // exactly that, deliberately, to interact with a child past its parent's turn) keeps its
  // pre-existing lifetime.
  await Promise.allSettled(childRoster.filter((c) => !foregroundChildren.has(c) && c.status() === "running").map((c) => c.stop()));
  removeChildRosterSource();
  disposeSessionMcpLifecycle?.();
  if (mcpLifecycle) await mcpLifecycle.dispose().catch(() => {});
  // Phase 4 Task 8 (rider 2): drop this run's ToolSearch session runtime -- same singleton-hygiene
  // argument as the MCP unregistration immediately above (one leaked entry per run otherwise).
  // Fix wave (I1): keyed by `sessionStateKey`, never `config.sessionId`, which a child shares with its
  // parent. Fix wave follow-up (2) / whole-branch M3(c): the IDENTITY-CHECKED disposer returned by the
  // registration, never the unconditional by-key `unregisterToolSearchSessionRuntime` -- a child
  // `stop()`ped and immediately `resume()`d registers generation 2 under the same agent key while
  // generation 1's teardown is still draining, and a by-key delete would let the dead generation
  // remove the live one's runtime.
  disposeToolSearchSessionRuntime();
  // Phase 5 Task 3 (R5-10): withdraw this run's host-generated StructuredOutput descriptor -- same
  // singleton-hygiene argument as the MCP/ToolSearch withdrawals above, and the disposer is
  // identity-checked so a concurrent in-memory run's own registration is never removed by this one.
  disposeStructuredOutputTool?.();
  // Phase 5 Task 8 + B-low + I5: withdraw this run's workflow session.
  //
  // THE `finally` HALF OF THE B-LOW IS **NOT** LANDED, and this says so rather than implying it is.
  // Wrapping this function's ~1800 remaining lines in a `try/finally` is a restructure out of
  // proportion to a Low, and would conflict with every concurrent edit in the file.
  //
  // WHAT WAS CHECKED, because "it never throws" and "this line is always reached" are two different
  // claims and only the second one matters here: between the `registerWorkflowSession` call and this
  // withdrawal there is exactly ONE top-level `return` in `runEngine`, the `return 0` five lines
  // below -- so there is no early-return path that skips the withdrawal. The only way past it is a
  // THROW, which is the contract both entrypoints already rely on (see testing.ts's own "NOT
  // redundant with runEngine's own always-resolves design" note) but which nothing structurally
  // enforces.
  //
  // So the residual exposure is: a future throw from anywhere in those 1800 lines, ONCE I5's key has
  // landed. First-wins would then let the leaked entry under session X refuse a later run that
  // legitimately reuses that id in the same process -- which is what a `--resume` does. Carried,
  // with both triggers named.
  //
  // The DISPOSER first (identity-checked, so a child engine's teardown cannot delete its parent's
  // entry); the unkeyed clear only as the pre-I5 fallback -- see the registration site's own note.
  if (disposeWorkflowSession !== undefined) disposeWorkflowSession();
  else if (workflowWinterHome !== undefined) clearWorkflowSession();
  output.end();
  return 0;
}
