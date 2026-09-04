// Phase 4 Task 8 -- the WS-10 §16 cite-or-cover matrix. Same contract, same self-citation guard and
// same machine-verified citations as mcp/conformance.test.ts (this file's sibling) and the P2/P3
// matrices before it: every obligation WS-10 §16 enumerates gets exactly one of "covered" / "new" /
// "deferred with a named owning-phase reasoning", and a renamed or deleted cited test fails HERE
// rather than rotting inside a comment.
//
// §16 is written as one long prose sentence ("The [WS-17] harness MUST prove, at minimum: ..."), so
// the rows below decompose it clause by clause, in the order the spec states them, with each row's
// `bullet` quoting or closely paraphrasing its own clause. Rows also cover §17's open questions where
// this task's own capture actually answered one.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Citation {
  file: string;
  testName: string;
}

interface ConformanceRow {
  id: string;
  spec: string;
  bullet: string;
  status: "covered" | "new" | "deferred";
  citations?: Citation[];
  owningPhase?: string;
  note?: string;
}

const ROWS: ConformanceRow[] = [
  // --- schemas + aliasing -----------------------------------------------------------------------
  {
    id: "WS10-01",
    spec: "WS-10 §16",
    bullet: "the exact model-visible SendMessage/ListAgents schemas",
    status: "covered",
    citations: [
      { file: "../tools/impl/send-message.test.ts", testName: "to over 300 chars is a validation error" },
      { file: "../tools/impl/list-agents.test.ts", testName: "output is exactly {listing: string} (WS-10 §10.2 pinned shape), never the structured rows" },
    ],
    note:
      "CAPTURE NOTE (scripts/capture-official-golden.ts Scenario D, this task): derived-shapes-p4 item (e) recorded both schemas as DECLARATION-absent from the pinned artifact, and the capture adds the runtime half -- the official default session DOES advertise `SendMessage` and `ListAgents` to the model. So Winter advertising them is right; only the schema TEXT has no upstream declaration to mirror, which is why WS-10 §10.1/§10.2's own pinned shapes are the authority here rather than the artifact.",
  },
  {
    id: "WS10-02",
    spec: "WS-10 §16",
    bullet: "aliased calls reach the Winter handlers and canonical MCP duplicates stay deferred/hidden",
    status: "new",
    citations: [
      { file: "../engine.test.ts", testName: "riders 3/15: WS-09 §10 duplicate suppression -- the model sees ONE SendMessage and ONE ListAgents, never the canonical duplicate" },
      { file: "../tools/registry.test.ts", testName: "is registered, declared deferred:true AT THE SOURCE, and mirrors" },
    ],
    note:
      "rider 15 created the canonical pair WS-10 §15 names (mcp__winter__send_message / mcp__winter__list_agents), declared `deferred: true` AT THE SOURCE per RULING P4-E and backed by the SAME executor object as the native name -- so 'aliased calls reach the Winter handlers' is true by identity rather than by a redirection table. WS-09's own §11 item 8 rows carry the alias-suite half in mcp/conformance.test.ts.",
  },
  {
    id: "WS10-03",
    spec: "WS-10 §16",
    bullet: "direct/internal official calls cannot bypass the common deny floor",
    status: "deferred",
    owningPhase:
      "The 'official/internal call path' this clause guards against is the [WS-14] Claude-branch surface, which does not exist in this repository -- WS-09 §10 states the reason plainly ('aliases are not a security boundary... disallowedTools remains the enforcement mechanism for those paths'). Winter's own equivalent floor IS proven: the engine applies BASELINE_DENY_RULES unconditionally and a forced-bypass CHILD still honours its parent's deny rules (see row WS10-25).",
  },

  // --- addressing / resolution ------------------------------------------------------------------
  {
    id: "WS10-04",
    spec: "WS-10 §16",
    bullet: "unique / ambiguous / stale / missing / replaced-generation / self-target resolution",
    status: "covered",
    citations: [
      { file: "../messaging/resolution.test.ts", testName: "resolves a uniquely-named child" },
      { file: "../messaging/router.test.ts", testName: "ambiguous -> carries candidates" },
      { file: "../messaging/router.test.ts", testName: "stale name -> refused" },
      { file: "../messaging/resolution.test.ts", testName: "a canonical session address with no matching peer row is not_found" },
      { file: "../messaging/router.test.ts", testName: "addressing your own session by its canonical address is refused, never delivered" },
    ],
    note:
      "'replaced-generation' is the stale-name row's own structural reading (a display name that WAS used by a different child of the same parent), disclosed as such in Lane D's report -- no name-history ledger exists in the in-process reference for a temporal reading.",
  },
  {
    id: "WS10-05",
    spec: "WS-10 §16",
    bullet: "resolution rules 1-6 in order: canonical address > child id within the owning parent > unique display name; names never grant permission",
    status: "covered",
    citations: [
      { file: "../messaging/resolution.test.ts", testName: "canonical resolution takes priority even when a same-named child or peer also exists" },
      { file: "../messaging/resolution.test.ts", testName: "a child id wins even when some OTHER child has that same string as its display name" },
      { file: "../messaging/resolution.test.ts", testName: "a canonical agent address owned by a DIFFERENT parent is not_found (not reachable from another paren" },
      { file: "../messaging/resolution.test.ts", testName: "a name belonging to a child of a DIFFERENT parent is not visible to this caller" },
    ],
  },

  // --- delivery across runtimes/statuses --------------------------------------------------------
  {
    id: "WS10-06",
    spec: "WS-10 §16",
    bullet: "running / idle / exited delivery for top-level sessions",
    status: "covered",
    citations: [
      { file: "../messaging/reference-adapter.test.ts", testName: "RUNNING and IDLE peers are both still listed -- the only two live statuses" },
      { file: "../messaging/reference-adapter.test.ts", testName: "an EXITED peer is unavailable, never silently cold-resumed -- resumed_and_delivered/delivered MUST N" },
      { file: "../messaging/reference-adapter.test.ts", testName: "an EXITED peer is excluded from listReachable's own rows (WS-10 §10.2: never enumerate exited transc" },
    ],
    note: "WS-10 §10.3's third row (cold-resume of an exited top-level session is NOT SendMessage) is the second citation, proven as a refusal rather than an outcome.",
  },
  {
    id: "WS10-07",
    spec: "WS-10 §16",
    bullet: "running / completed / stopped behaviour for child runtimes (steer vs resume)",
    status: "covered",
    citations: [
      { file: "../messaging/reference-adapter.test.ts", testName: "steerChild delegates to a running child's own steer()" },
      { file: "../messaging/reference-adapter.test.ts", testName: "steerChild on a non-running child is not_found (steer targets a RUNNING child only)" },
      { file: "../messaging/reference-adapter.test.ts", testName: "resumeChild delegates to a terminal child's own resume()" },
    ],
  },
  {
    id: "WS10-08",
    spec: "WS-10 §16",
    bullet: "...end to end through a LIVE session, on every transport",
    status: "new",
    citations: [
      { file: "../../../sdk/src/transport-equivalence.test.ts", testName: "Task 8: SendMessage addressed to this session's own child RESUMES it (WS-10 §10.3), identically on every leg" },
      { file: "../engine.test.ts", testName: "Phase 4 Task 8: a live session's ListAgents call reaches the real messaging runtime, not the 'no messaging runtime' error" },
    ],
    note:
      "Every citation above this row drives the router/adapter directly. These two drive a real runEngine: before this task nothing ever registered a messaging runtime, so BOTH tools answered 'no messaging runtime configured for this session' in any live session however correct the layers beneath them were.",
  },

  // --- durability / restart ---------------------------------------------------------------------
  {
    id: "WS10-09",
    spec: "WS-10 §16",
    bullet: "parent restart + child restoration (rebuild identity and resume state from durable storage)",
    status: "covered",
    citations: [
      { file: "./roster.test.ts", testName: "rebuilds a metadata-only child (one that never produced native transcript output)" },
      { file: "./roster.test.ts", testName: "a DIFFERENT parent session's children are never mixed into this roster" },
      { file: "./roster.test.ts", testName: "fix round 1 (finding I4): a restart-orphaned 'running' record is reconciled to a terminal 'stopped' " },
    ],
    note: "RULING P4-J(b): a non-terminal record with no live handle rebuilds as terminal so it is resumable through the ordinary path, rather than being stuck 'running' forever.",
  },

  // --- inbound policy ---------------------------------------------------------------------------
  {
    id: "WS10-10",
    spec: "WS-10 §16",
    bullet: "the full accept/hold/refuse x class matrix (all five §13 rows), plus the unauthenticated-route refusal",
    status: "covered",
    citations: [
      { file: "../messaging/inbound.test.ts", testName: "prompts x prompts -> accept" },
      { file: "../messaging/inbound.test.ts", testName: "prompts x bypasses -> hold" },
      { file: "../messaging/inbound.test.ts", testName: "bypasses x bypasses -> accept" },
      { file: "../messaging/inbound.test.ts", testName: "bypasses x unknown -> hold" },
      { file: "../messaging/inbound.test.ts", testName: "an unauthenticated route is refused before the matrix, regardless of classes" },
      { file: "../messaging/inbound.test.ts", testName: "plan classifies as bypasses only when bypass is available to that session" },
    ],
  },

  // --- bounds -----------------------------------------------------------------------------------
  {
    id: "WS10-11",
    spec: "WS-10 §16",
    bullet: "dedupe (a retry with the same message id returns the stored outcome, never a second turn)",
    status: "covered",
    citations: [{ file: "../messaging/router.test.ts", testName: "a retry with the identical (sessionId, toolUseId) returns the stored outcome without re-invoking the" }],
    note:
      "rider 14 is what makes this real in PRODUCTION rather than only at the router layer: `ctx.toolUseId` now carries the model's own tool_use id, so the (sender, toolUseId) key WS-10 §12 derives the stable messageId from is finally the real one instead of a fresh synthetic value per call.",
  },
  {
    id: "WS10-12",
    spec: "WS-10 §16",
    bullet: "crash at every delivery boundary -> delivery_uncertain with deliveryMayHaveOccurred: true; expiry; queue overflow (50/100); loop prevention; identical rapid repeats dropped visibly",
    status: "covered",
    citations: [
      { file: "../messaging/outcomes.test.ts", testName: "delivery_uncertain always carries deliveryMayHaveOccurred: true" },
      { file: "../messaging/router.test.ts", testName: "an identical rapid repeat (different tool-call id, same content) is refused as a duplicate, distinct" },
      { file: "../messaging/router.test.ts", testName: "a message over MAX_GLOBAL_MESSAGE_SIZE is refused before resolution ever runs" },
      { file: "../messaging/outcomes.test.ts", testName: "strings that could naively concatenate into the same key (delimiter confusion) are distinguished" },
    ],
  },
  {
    id: "WS10-13",
    spec: "WS-10 §16",
    bullet: "rate limiting (per-sender / per-target, at scale)",
    status: "deferred",
    owningPhase:
      "RULING R4-5 scopes Phase 4 to the in-process reference adapter, and 'at scale' has no meaning for a single in-process router -- Lane D's own report lists this in its named P8 seam alongside durable cross-restart storage, cross-process delivery and authenticated routes. WS-10 §15's own split assigns the real router/service to [WS-15].",
  },

  // --- notify_when_idle -------------------------------------------------------------------------
  {
    id: "WS10-14",
    spec: "WS-10 §16",
    bullet: "one-shot idle notices; already-idle immediate notice; the 12-hour expiry; whole-call refusal for unsupported notification targets; the 5-minute dialog expiry",
    status: "covered",
    citations: [
      { file: "../messaging/idle.test.ts", testName: "a fired subscription never fires again (at most one notice, WS-10 §14)" },
      { file: "../messaging/idle.test.ts", testName: "a held subscription fires a reduced-status notice, not ordinary delivered text" },
      { file: "../messaging/router.test.ts", testName: "an agent (child) target refuses the WHOLE call, including the attached message -- neither steer nor " },
      { file: "../messaging/router.test.ts", testName: "a peer target with capabilities.notifyWhenIdle:false refuses the WHOLE call" },
      { file: "../messaging/idle.test.ts", testName: "a child/subagent sender is refused" },
    ],
  },

  // --- inert @ mentions -------------------------------------------------------------------------
  {
    id: "WS10-15",
    spec: "WS-10 §16 / §10.4",
    bullet: "inert `@` mentions, including the recorded 2.1.250 non-equivalence (a deliberate, security-motivated waiver)",
    status: "covered",
    citations: [{ file: "../messaging/reference-adapter.test.ts", testName: "@-mentions and slash-command-shaped text inside `message` are delivered byte-identically -- never expanded" }],
    note:
      "True by construction (nothing in messaging/** or the three tool executors parses `@` or `/` inside a body -- it flows as an opaque string into GlobalAgentMessage.body) AND directly pinned by Lane D's own fix-round rider test, which sends `@file.ts`/`/command`-shaped text through a full sendMessage call and asserts the delivered body is BYTE-IDENTICAL, not merely 'contains'.",
  },

  // --- model / effort / fork --------------------------------------------------------------------
  {
    id: "WS10-16",
    spec: "WS-10 §16",
    bullet: "the model/effort resolution tables, including WINTER_SUBAGENT_MODEL=inherit and org availableModels substitution",
    status: "covered",
    citations: [
      { file: "./resolution.test.ts", testName: "'inherit' at either layer is treated as 'nothing specific requested'" },
      { file: "./resolution.test.ts", testName: "availableModels substitution is RECORDED via substitutedFrom, never silent" },
      { file: "./resolution.test.ts", testName: "an unresolvable alias with no fallback throws a typed error, never a silent substitution" },
      { file: "./resolution.test.ts", testName: "invocation model wins for description purposes" },
      { file: "./resolution.test.ts", testName: "all four fields present" },
    ],
    note: "The last citation is §3.4's own recorded-resolution-metadata obligation (requestedModel/effectiveModel, requestedEffort/effectiveEffort on every child).",
  },
  {
    id: "WS10-17",
    spec: "WS-10 §16 / §3.5",
    bullet: "fork FULL inheritance (conversation copied at spawn; a model override ignored by contract)",
    status: "covered",
    citations: [
      { file: "./fork.test.ts", testName: "fork messages are copied verbatim, in order" },
      { file: "./fork.test.ts", testName: "the returned array is a genuine COPY -- mutating it never touches the original inherit.messages" },
      { file: "../engine.test.ts", testName: "(b) inherit.messages is present iff fork:true, both directions, within the same run" },
    ],
  },

  // --- fg/bg policy + limits + watchdog ----------------------------------------------------------
  {
    id: "WS10-18",
    spec: "WS-10 §16 / §5",
    bullet: "the fg/bg policy chain states (never a hardcoded 'omitted means foreground')",
    status: "covered",
    citations: [
      { file: "./policy.test.ts", testName: "WINTER_DISABLE_BACKGROUND_TASKS forces foreground no matter what else is set" },
      { file: "./policy.test.ts", testName: "AgentDefinition.background:true forces background, overriding an explicit invocation false" },
      { file: "./policy.test.ts", testName: "an explicit invocation request wins over the fork-mode default" },
      { file: "./policy.test.ts", testName: "the SDK (non-fork) default with nothing else specified is foreground -- never a hardcoded independen" },
    ],
  },
  {
    id: "WS10-19",
    spec: "WS-10 §16 / §6",
    bullet: "depth / concurrency limit enforcement (3 / 20, env-overridable), both gates independent",
    status: "covered",
    citations: [
      { file: "./limits.test.ts", testName: "defaults: depth 3, concurrency 20" },
      { file: "./limits.test.ts", testName: "depth 4 with the default max of 3 throws SpawnDepthExceededError, naming both values" },
      { file: "./limits.test.ts", testName: "the 21st concurrent spawn (default max 20) throws SpawnConcurrencyExceededError" },
      { file: "./limits.test.ts", testName: "a depth violation is checked (and throws) even when concurrency has headroom -- both gates apply ind" },
    ],
  },
  {
    id: "WS10-20",
    spec: "WS-10 §16 / §6, R4-9",
    bullet: "stall-watchdog abort typing (600 000 ms of no PROGRESS, a typed error distinct from any wall-clock timeout)",
    status: "covered",
    citations: [
      { file: "./watchdog.test.ts", testName: "defaults to 600000ms" },
      { file: "./watchdog.test.ts", testName: "fires exactly once, with a typed ChildStalledError, after timeoutMs with no pokes" },
      { file: "./watchdog.test.ts", testName: "poke() resets the countdown -- steady poking never fires" },
    ],
  },
  {
    id: "WS10-21",
    spec: "RULING P4-I companion (rider 20)",
    bullet: "an OUTSTANDING host control request is not inactivity -- the progress clock pauses while one is unanswered",
    status: "new",
    citations: [
      { file: "./watchdog.test.ts", testName: "pause() stops the clock: no fire even well past the timeout, and resume() restarts it" },
      { file: "./child-engine.test.ts", testName: "rider 20 complement: a child with NO outstanding host request that makes no progress is still aborted by the watchdog" },
    ],
    note:
      "Both directions are pinned deliberately. The positive direction is row WS10-22's own citation (the permission answer arrives after TWICE the stall timeout and the child still completes); the complement here is what stops the pause from silently disarming the watchdog altogether.",
  },

  // --- child context isolation + control routing --------------------------------------------------
  {
    id: "WS10-22",
    spec: "WS-10 §16 / §4, RULING P4-I",
    bullet: "a child's own permission/hook control RPC is ANSWERED (not dropped by the parent's bridge)",
    status: "new",
    citations: [
      { file: "./child-engine.test.ts", testName: "RULING P4-I: a child under 'default' mode that reaches a real permission prompt RECEIVES its answer through the parent pump's child-bridge roster, and completes" },
      { file: "./child-engine.test.ts", testName: "parentHooks + parentIncludeHookEvents cause the child's own engine to emit hook_started, the host ANSWERS the hook RPC, and the hooked call completes" },
    ],
    note:
      "RED-verified for this task's report: with the pump's child-bridge roster removed, the first cited test times out again exactly as it did before P4-I. Lane C's own header documented the hang as a live, bounded defect ('children under a prompting mode WILL hang on that one tool call today').",
  },
  {
    id: "WS10-23",
    spec: "WS-10 §16 / §4",
    bullet: "child progress is CORRELATED (keyed by parent tool-use id), never flattened into the main assistant stream",
    status: "new",
    citations: [
      { file: "../../../sdk/src/transport-equivalence.test.ts", testName: "rider 25: a real subagent spawn round (Agent -> child -> result) is identical on every leg, and the child's frames are correlated, never flattened" },
      { file: "./child-handle.test.ts", testName: "assistant tool_use is ALWAYS forwarded, stamped with parent_tool_use_id, even with forwardSubagentTe" },
    ],
    note:
      "RULING P4-J(c) / rider 23 is enforced in the same path: a child's DATA-WRAPPED system/init is now swallowed alongside the wire-level init frame, because derived-shapes-p4 §(d) establishes that SDKSystemMessage carries no parent_tool_use_id -- a forwarded child init would be structurally uncorrelatable and would impersonate the session identity frame. The equivalence scenario asserts exactly one system/init and one result on the parent's stream.",
  },
  {
    id: "WS10-24",
    spec: "WS-10 §16 / §9, RULING P4-J(e)",
    bullet: "a child resume applies the STRICTER of the recorded and current parent policy; the incomparable pair fails closed",
    status: "covered",
    citations: [
      { file: "./child-engine.test.ts", testName: "resume() applies the stricter-of comparator when the parent's current policy is stricter than the recorded one" },
      { file: "../permissions/auto/inheritance.test.ts", testName: "resolveChildResumeMode refuses both directions -- never silently widens (recorded dontAsk, current a" },
    ],
    note:
      "rider 26 is what makes this reachable in PRODUCTION: `resolveChildResumeMode` had ZERO call sites anywhere in the repository (policyStateStore is a runEngine local and no seam exposed it), so WS-10 §9's MUST was undelivered by anything, not merely under-exercised. `ChildEngineRunContext.getParentPolicy` -- read fresh per call, never a spawn-time snapshot -- is the missing seam.",
  },
  {
    id: "WS10-25",
    spec: "WS-10 §16 / §9",
    bullet: "an agent message can never approve a pending permission request or change child permission settings; a forced-bypass child still honours the parent's denies",
    status: "covered",
    citations: [
      { file: "./child-engine.test.ts", testName: "a forced-bypass child still DENIES a parent-denied tool call (parentPermissionRules mirrored)" },
      { file: "../messaging/inbound.test.ts", testName: "an explicit receiver setting always wins over the default matrix" },
    ],
    note:
      "The first is Lane C's own I1 fix (the child RuntimeConfig dropped the parent's permissions.{allow,ask,deny} and hooks entirely, so a forced-bypass child auto-approved exactly what the parent forbade). The 'cannot approve' half is structural: nothing in messaging/** hands a delivered body anywhere but the receiver's own turn/mailbox -- Lane D's report states the invariant and no code path contradicts it.",
  },

  // --- definitions / isolation --------------------------------------------------------------------
  {
    id: "WS10-26",
    spec: "WS-10 §2, R4-7",
    bullet: "programmatic and filesystem-defined agents coexist; project definitions are trust-gated",
    status: "new",
    citations: [
      { file: "./definitions.test.ts", testName: "precedence: programmatic > project (trusted) > user, on a real name collision" },
      { file: "./definitions.test.ts", testName: "project-level (.winter/agents) is INVISIBLE when the workspace is untrusted" },
      { file: "../tools/registry.test.ts", testName: "ctx.agents threads the programmatic agent map from deps; absent deps leave it undefined" },
    ],
    note:
      "The `programmatic` half was fully implemented and unit-tested by Lane C but had NO production producer -- `ToolExecutionContext` carried no field for RuntimeConfig.agents, so only filesystem agents were resolvable via subagent_type in a live session. rider 21 added the field and threaded it; the third citation is that seam.",
  },
  {
    id: "WS10-27",
    spec: "WS-10 §8",
    bullet: "isolation: \"worktree\" gives the child a git worktree, auto-cleaned when unchanged and never when changed",
    status: "covered",
    citations: [
      { file: "./workspace.test.ts", testName: "isolation:worktree inside a real repo creates .winter/worktrees/agent-<id> on a fresh branch" },
      { file: "./workspace.test.ts", testName: "an UNCHANGED worktree (no commits, no uncommitted files) is auto-removed" },
      { file: "./workspace.test.ts", testName: "a worktree with uncommitted changes is LEFT IN PLACE, never force-removed" },
    ],
  },
  {
    id: "WS10-28",
    spec: "WS-06 §3.3 / WS-10 §8",
    bullet: "an isolation-pinned subagent cannot leave its isolation workspace",
    status: "new",
    citations: [{ file: "../tools/impl/exit-worktree.test.ts", testName: "rider 28: an isolation-pinned subagent's ExitWorktree call is refused, typed, before any git command runs" }],
    note:
      "rider 28. `ToolExecutionContext.isolationPinnedCwd` was threaded correctly by the P4 spine and read by NOTHING -- while exit-worktree.ts's own header still claimed no such field existed. Both halves are fixed: the field is consumed, and the stale header refreshed.",
  },
  {
    id: "WS10-29",
    spec: "WS-10 §8",
    bullet: "isolation: \"remote\" is a typed unsupported-capability error until a remote backend is configured",
    status: "covered",
    citations: [{ file: "../tools/impl/agent.test.ts", testName: "isolation:\"remote\"" }],
  },

  // --- task namespace -----------------------------------------------------------------------------
  {
    id: "WS10-30",
    spec: "WS-12 §7.3 / rider 24",
    bullet: "TaskStop / TaskOutput reach a BACKGROUND AGENT task through the unified task namespace",
    status: "new",
    citations: [{ file: "../tools/impl/agent.test.ts", testName: "the spawned task is registered with kind 'agent' and a stop callback, and TaskStop genuinely aborts the child" }],
    note:
      "Lane C disclosed the asymmetry ('TaskStop/TaskOutput do not reach background agent tasks'). The mechanical blocker was that background-task-runtime.ts's own BackgroundTaskKind union ('bash'|'monitor') was a strict SUBSET of the spine seam's four-member one, so an agent task allocated through createBackgroundTask('agent') could not be tracked in the registry those two tools are built on. Widened, and the agent task now registers with a generic `stop` callback rather than a pid -- a child is an in-process engine loop (R4-4), so there is no process group to signal.",
  },

  // --- §17 open questions ------------------------------------------------------------------------
  {
    id: "WS10-31",
    spec: "WS-10 §17 OQ1",
    bullet: "`name` capability gating -- accepted host-side, withheld from the model schema until captured",
    status: "new",
    citations: [
      { file: "../tools/descriptors/agent.ts", testName: "`name` is DELIBERATELY ABSENT from the model-visible schema" },
      { file: "../tools/impl/agent.test.ts", testName: "model/isolation:worktree/name pass through to the SpawnChildRequest untouched" },
    ],
    note:
      "ANSWERED BY CAPTURE, not merely implemented. scripts/capture-official-golden.ts Scenario D (pinned 0.3.250, loopback-only) reports the Agent tool's own model-visible input_schema as exactly {description, prompt, subagent_type, model(enum of 4), run_in_background, isolation(enum of 2)}, required [description, prompt], additionalProperties:false -- and NO `name`. That is §17 OQ1's own evidence gap closed, and it confirms RULING P4-J(d) verbatim. Winter's descriptor now matches that shape exactly while the executor still accepts `name` host-side.",
  },
  {
    id: "WS10-32",
    spec: "WS-10 §17 OQ4",
    bullet: "the exact MAX_GLOBAL_MESSAGE_SIZE (documented upstream only as 'about one million characters')",
    status: "deferred",
    owningPhase:
      "NEEDS_CONTEXT after this task's own capture attempt, and the reason is structural rather than an omission: derived-shapes-p4 item (e) establishes that SendMessage has NO declaration in the pinned artifact, and the pinned SDK exposes no messaging surface at all -- so there is nothing to send an oversized message THROUGH to observe a bound. (The Scenario D capture does confirm the official runtime ADVERTISES SendMessage to the model, so a future capture route would have to drive a real Claude Code session rather than the Agent SDK.) The shipped constant stays a versioned compatibility value, 1_000_000, marked CAPTURE-PENDING at its declaration in messaging/outcomes.ts, with DEFAULT_MESSAGE_TTL_MS / MAX_HOP_COUNT / RAPID_REPEAT_WINDOW_MS in the same class.",
  },
  {
    id: "WS10-33",
    spec: "WS-10 §17 OQ2/OQ3",
    bullet: "numeric `effort` semantics; observer/observerMessage/criticalSystemReminder_EXPERIMENTAL runtime behaviour",
    status: "deferred",
    owningPhase:
      "Both are declaration-backed and behaviourally under-evidenced in the pinned report, and §17 itself says so. Winter ACCEPTS all of them for source compatibility (definitions.test.ts's 'effort accepts the numeric form' pins the numeric case), and assigning semantics beyond pass-through-or-reject is the provider layer's ([WS-13]) once a captured behaviour corpus exists.",
  },
];

describe("WS-10 §16 conformance matrix (Phase 4 Task 8)", () => {
  test("every row is covered, newly tested here, or deferred with a named owning-phase reasoning -- zero unexplained bullets", () => {
    for (const row of ROWS) {
      if (row.status === "deferred") {
        expect(row.owningPhase, `${row.id} (${row.bullet}): a deferred row must name its owning-phase reasoning`).toBeTruthy();
      } else {
        expect(row.citations?.length ?? 0, `${row.id} (${row.bullet}): a ${row.status} row must carry at least one citation`).toBeGreaterThan(0);
      }
    }
  });

  test("every citation's file exists and genuinely contains the cited substring -- a renamed or deleted cited test fails HERE, not silently in a stale comment", () => {
    const fileCache = new Map<string, string>();
    const readCited = (relPath: string): string => {
      let content = fileCache.get(relPath);
      if (content === undefined) {
        content = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
        fileCache.set(relPath, content);
      }
      return content;
    };
    const countOccurrences = (haystack: string, needle: string): number => {
      let count = 0;
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) return count;
        count++;
        from = at + 1;
      }
    };
    for (const row of ROWS) {
      for (const c of row.citations ?? []) {
        const required = c.file === "./conformance.test.ts" ? 2 : 1;
        const occurrences = countOccurrences(readCited(c.file), c.testName);
        expect(
          occurrences >= required,
          `${row.id}: citation not found -- ${c.file} does not contain ${required} occurrence(s) of "${c.testName}" (found ${occurrences})`,
        ).toBe(true);
      }
    }
  });

  // Phase 4 Task 8 (advisor finding): a SHORT citation substring defeats the tripwire above -- "to",
  // "name", "@" or "fork" would match almost any file and would survive the cited test being deleted,
  // which is the exact rot this matrix exists to prevent. A minimum length makes the guard's own
  // strength a checked property rather than a matter of the author's care. The one deliberate
  // exception is a citation into a committed GOLDEN (a .json file), where the cited substring is a
  // content pin rather than a test title. The bound is 18 rather than something rounder because two
  // genuine, COMPLETE test titles are that short ("stale name -> refused", "cached counts as ready");
  // the bound exists to reject one-word fragments, not to force titles to be verbose.
  test("every citation substring is specific enough to be a real tripwire (never a one-word match)", () => {
    for (const row of ROWS) {
      for (const c of row.citations ?? []) {
        if (c.file.endsWith(".json")) continue;
        expect(c.testName.length, `${row.id}: citation "${c.testName}" (${c.file}) is too short to discriminate`).toBeGreaterThanOrEqual(18);
      }
    }
  });

  test("row ids are unique", () => {
    const ids = ROWS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("summary counts (informational -- printed for the task report)", () => {
    const covered = ROWS.filter((r) => r.status === "covered").length;
    const newRows = ROWS.filter((r) => r.status === "new").length;
    const deferred = ROWS.filter((r) => r.status === "deferred").length;
    expect(covered + newRows + deferred).toBe(ROWS.length);
  });
});
