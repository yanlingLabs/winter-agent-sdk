// Phase 4 Task 8 -- the WS-09 §11 cite-or-cover matrix, mirroring permissions/conformance.test.ts's
// own P2 T13 pattern and tools/conformance.test.ts's own P3 T8 pattern exactly: every one of §11's
// eleven numbered fixture obligations is decomposed into rows, and every row carries exactly one of
//
//   "covered"  -- a real test already proves it, cited by {file, testName}, MACHINE-VERIFIED below
//                 (the citation's file is read and the substring genuinely searched for, so a renamed
//                 or deleted test fails HERE rather than rotting silently inside a comment);
//   "new"      -- a genuine gap this task closes, self-cited the same way (with the self-citation
//                 loophole guard: a row citing THIS file must find its own title TWICE, since the
//                 table's own string literal would otherwise satisfy a plain `.includes()`);
//   "deferred" -- out of scope at this phase, naming its owning-phase reasoning, never a silent
//                 absence.
//
// Zero rows may lack one of the three; the tests at the bottom enforce that structurally.
//
// This file does NOT re-fetch the pinned upstream artifact. Where a row's evidence is a CAPTURE, the
// capture lives in scripts/capture-official-golden.ts (env-gated, ephemeral, report-only) and the row
// records what that capture returned -- `bun test` itself stays hermetic.
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

// --- WS-09 §11 item 1: lifecycle timing ---------------------------------------------------------

const ITEM_1: ConformanceRow[] = [
  {
    id: "WS09-1a",
    spec: "WS-09 §11.1",
    bullet: "nonblocking startup default -- start() returns while an ordinary server is still connecting",
    status: "covered",
    citations: [{ file: "./lifecycle.test.ts", testName: "without alwaysLoad, start() returns immediately (nonblocking default) even though the server is still pending" }],
  },
  {
    id: "WS09-1b",
    spec: "WS-09 §11.1",
    bullet: "MCP_CONNECTION_NONBLOCKING=0 + the 5000 ms batch-snapshot deadline",
    status: "covered",
    citations: [{ file: "./lifecycle.test.ts", testName: "MCP_CONNECTION_NONBLOCKING=0 (connectionNonblocking: false): start() waits for the WHOLE batch, bounded by con" }],
  },
  {
    id: "WS09-1c",
    spec: "WS-09 §11.1",
    bullet: "per-server 30000 ms bound (MCP_TIMEOUT) on an individual connection attempt",
    status: "covered",
    citations: [{ file: "./client.test.ts", testName: "a fully unresponsive http server classifies as timeout, bounded by connectTimeoutMs (not left hanging)" }],
    note: "The DEFAULT value itself (30000) is parsed in mcp/env.ts and unit-tested there; what this row needs is the bound actually BINDING, which the cited fixture proves against a genuinely unresponsive server with a short injected deadline (a real 30 s wait in a test suite would be its own defect).",
  },
  {
    id: "WS09-1d",
    spec: "WS-09 §11.1",
    bullet: "cache-served start with the live connection deferred to first call",
    status: "covered",
    citations: [
      { file: "./lifecycle.test.ts", testName: "discovery cache: a cache hit serves 'cached' state + tools without connecting; the live connection is deferred" },
      { file: "./lifecycle.test.ts", testName: "discovery cache: never served for a stdio server, even when discoveryCache=1 and a cache entry exists under th" },
    ],
  },
  {
    id: "WS09-1e",
    spec: "WS-09 §11.1",
    bullet: "alwaysLoad makes startup WAIT for that server",
    status: "covered",
    citations: [
      { file: "./lifecycle.test.ts", testName: "alwaysLoad on a REAL (stdio) transport: start() actually waits for it to finish connecting" },
      { file: "./lifecycle.test.ts", testName: "an sdk-with-instance connection is always awaited by start(), regardless of alwaysLoad (which does not exist o" },
    ],
  },
  {
    id: "WS09-1f",
    spec: "WS-09 §11.1",
    bullet: "the `-p` (non-interactive) first-turn wait, as its own separate lifecycle path",
    status: "deferred",
    owningPhase:
      "R4-8 capture-pending, and NEEDS_CONTEXT after this task's own capture attempt. `packages/runtime` has no `-p`/one-shot concept of its own to attach a fixture to, and -- the new finding -- the OFFICIAL SDK's `query()` surface has no `-p` either: it is a CLI flag, so there is no observable through the SDK to capture the semantics from. WS-09 §12 OQ5's own text ('report §56 establishes that non-interactive -p mode has additional first-turn waiting behavior but does not pin its deadlines') therefore still stands unresolved. mcp/p-flag-first-turn.test.ts holds the deliberate `test.skip` placeholder. RELATED, and recorded because it is the same hazard the -p wait exists to cover: this task's own rider-11 elicitation scenario empirically hit the race (a first-turn tool call reaching a server still connecting under the nonblocking default) and had to set MCP_CONNECTION_NONBLOCKING=0 -- see engine.test.ts's own comment there.",
  },
];

// --- WS-09 §11 item 2: live mutation ------------------------------------------------------------

const ITEM_2: ConformanceRow[] = [
  {
    id: "WS09-2a",
    spec: "WS-09 §11.2",
    bullet: "toggleMcpServer reflected in the advertised set",
    status: "covered",
    citations: [{ file: "./control.test.ts", testName: "mcp_toggle off then on: tools disappear then reappear, the underlying connection is NEVER re-dialed (WS-09 §2." }],
  },
  {
    id: "WS09-2b",
    spec: "WS-09 §11.2",
    bullet: "setMcpServers reflected in the advertised set (add / remove-by-omission / per-name errors / origin scoping)",
    status: "covered",
    citations: [
      { file: "./control.test.ts", testName: "mcp_set_servers: adds a brand-new dynamic server and reports it in 'added'" },
      { file: "./control.test.ts", testName: "mcp_set_servers: removes a dynamic server omitted from the new payload" },
      { file: "./control.test.ts", testName: "mcp_set_servers: an invalid entry (claudeai-proxy) is reported per-name in errors, without blocking other vali" },
      { file: "./control.test.ts", testName: "mcp_set_servers: a settings/project/plugin-origin server survives an omission untouched (derived-shapes-p4.md " },
    ],
  },
  {
    id: "WS09-2c",
    spec: "WS-09 §11.2",
    bullet: "...and the NEXT TURN's system/init.tools reflects the mutation",
    status: "deferred",
    owningPhase:
      "Structurally unreachable at P4, and named honestly rather than approximated. `system/init` is written ONCE per runEngine, before the first turn (engine.ts) -- there is no re-init frame on the wire and no mechanism that emits one, so 'the next turn's init.tools' has no observable to assert against in this runtime. What IS proven is the layer beneath it: the live REGISTRY mutates (rows 2a/2b), and init.tools is derived from that registry by a pure, separately-proven composition (the differential goldens pin the derivation). A re-init/refresh frame is a protocol addition owned by a later phase; until it exists, this obligation cannot be honestly claimed as covered.",
  },
];

// --- WS-09 §11 item 3: elicitation --------------------------------------------------------------

const ITEM_3: ConformanceRow[] = [
  {
    id: "WS09-3a",
    spec: "WS-09 §11.3",
    bullet: "elicitation WITHOUT a callback -- a deterministic, well-formed decline, never a hang",
    status: "covered",
    citations: [
      { file: "./elicitation.test.ts", testName: "no sender at all -> declines with no round trip attempted" },
      { file: "./elicitation.test.ts", testName: "declining asker (e.g. no callback configured) is a well-formed MCP decline, never a hang or a protocol error" },
      { file: "./client.test.ts", testName: "no elicitation callback configured (NO_ELICIT) -> the server sees a deterministic decline, never a hang" },
    ],
  },
  {
    id: "WS09-3b",
    spec: "WS-09 §11.3",
    bullet: "elicitation WITH a callback -- the answer reaches the server",
    status: "covered",
    citations: [
      { file: "./elicitation.test.ts", testName: "a real elicitation/create request round-trips through installElicitationHandler and an accepting asker" },
      { file: "./client.test.ts", testName: "elicitation: a tool that elicits routes through the configured asker with the correct serverName, and the serv" },
    ],
  },
  {
    id: "WS09-3c",
    spec: "WS-09 §11.3",
    bullet: "...wired to a LIVE session's own host connection (the callback is the engine's RpcBridge)",
    status: "new",
    citations: [
      {
        file: "../engine.test.ts",
        testName: "a real MCP server's mid-call elicitation reaches the host as an mcp_elicitation control_request, and the answer flows back",
      },
    ],
    note:
      "The one half of WS-09 §5 no unit test could reach: `bridge` is a closure-local inside runEngine with no seam exposing it outward, which is exactly why Lane A could not perform this integration itself. The cited fixture drives a REAL loopback http MCP server whose tool handler calls server.elicitInput() mid-call, observes the real mcp_elicitation control_request on the wire, answers it, and asserts the server's own tool result reflects the answer.",
  },
];

// --- WS-09 §11 item 4: forced interaction -------------------------------------------------------

const ITEM_4: ConformanceRow[] = [
  {
    id: "WS09-4a",
    spec: "WS-09 §11.4",
    bullet: "_meta['anthropic/requiresUserInteraction'] survives registration verbatim and derives `interaction: \"required\"`",
    status: "covered",
    citations: [
      { file: "../tools/registry.test.ts", testName: "_meta round-trips verbatim, including the anthropic/ key literal, and derives interaction" },
      { file: "./lifecycle.test.ts", testName: "fix round 1 (Minor 4): a server tool's annotations and _meta survive createMcpLifecycle's own registration, al" },
    ],
  },
  {
    id: "WS09-4b",
    spec: "WS-09 §11.4",
    bullet: "the interaction requirement forces interactive handling over a matching allow rule, and dontAsk denies it",
    status: "covered",
    citations: [{ file: "../permissions/evaluator.test.ts", testName: "requiresInteraction" }],
    note:
      "The evaluator's stage-3 mandatory-interaction gate is where this rule actually lives, and it is unit-tested there against the injected `requiresInteraction` seam. engine.ts fills that seam with a LIVE registry read (`getRegisteredTool(name)?.descriptor.interaction === 'required'`), so a server registered mid-session is reflected on the very next evaluate() with no engine-side cache to go stale -- the two halves compose without a third fixture.",
  },
];

// --- WS-09 §11 item 5: ToolSearch ---------------------------------------------------------------

const ITEM_5: ConformanceRow[] = [
  {
    id: "WS09-5a",
    spec: "WS-09 §11.5",
    bullet: "keyword search vs `select:` (multi-name, untruncated by max_results)",
    status: "covered",
    citations: [
      { file: "../toolsearch/search.test.ts", testName: "select:A,B resolves multiple names and is NOT truncated by max_results" },
      { file: "../toolsearch/search.test.ts", testName: "a deferred tool is discoverable by its own name token" },
      { file: "../toolsearch/search.test.ts", testName: "a deferred tool is discoverable by a description token" },
    ],
  },
  {
    id: "WS09-5b",
    spec: "WS-09 §11.5",
    bullet: "the `max_results` default of 5, and `select:` remaining untruncated past it",
    status: "new",
    citations: [
      { file: "../toolsearch/search.test.ts", testName: "a KEYWORD query with no max_results returns at most 5 matches, out of a deferred pool of 12" },
      { file: "../toolsearch/search.test.ts", testName: "`select:` is NOT truncated by the default -- 8 explicitly selected names all come back (WS-09 §8.2)" },
    ],
  },
  {
    id: "WS09-5c",
    spec: "WS-09 §11.5",
    bullet: "the 5 s pending-server wait, then a retry against the refreshed registry",
    status: "covered",
    citations: [
      { file: "../toolsearch/search.test.ts", testName: "select: waits for a relevant pending server, then retries and finds the tool once it connects" },
      { file: "../toolsearch/search.test.ts", testName: "waits at most the deadline when a relevant server never leaves pending, then returns whatever was found (" },
      { file: "../toolsearch/search.test.ts", testName: "does NOT wait at all when the initial attempt already fully resolved (no pending servers consulted)" },
    ],
  },
  {
    id: "WS09-5d",
    spec: "WS-09 §11.5",
    bullet: "the exact WS-09 §8.2 result shape (optional fields genuinely omitted, never present-as-empty)",
    status: "covered",
    citations: [
      { file: "../toolsearch/search.test.ts", testName: "query is echoed verbatim; optional fields are omitted, not present-as-empty, when there is nothing to rep" },
      { file: "../toolsearch/search.test.ts", testName: "failed_mcp_servers reports a currently-failed server with its errorCode/error" },
    ],
  },
  {
    id: "WS09-5e",
    spec: "WS-09 §11.5",
    bullet: "load ≠ permission: loading a deferred tool never changes its permission verdict",
    status: "covered",
    citations: [{ file: "../tools/impl/tool-search.test.ts", testName: "loading a deferred tool via ToolSearch does not change the real evaluator's verdict for it" }],
  },
  {
    id: "WS09-5f",
    spec: "WS-09 §11.5",
    bullet: "post-compaction re-discovery: a reset tool is searchable again but not callable",
    status: "covered",
    citations: [{ file: "../toolsearch/search.test.ts", testName: "after reset(evidenced) drops a loaded tool, it is searchable again but NOT callable" }],
  },
  {
    id: "WS09-5g",
    spec: "WS-09 §11.5",
    bullet: "the WHOLE round on the wire: deferred tool absent from init.tools -> select: -> tool_reference -> the call then executes",
    status: "new",
    citations: [{ file: "../../../conformance/goldens/toolsearch-select-round.trace.json", testName: "tool_reference" }],
    note:
      "A committed differential golden (scripts/differential.ts's own `toolsearch-select-round` scenario) rather than a test title: it pins the entire mechanic byte-exact in one trace -- the deferred MCP tool ABSENT from system/init.tools (WS-09 §8.5's 'ground truth ... the live request's tools array'), ToolSearch itself advertised because activation is on, a `select:` result carrying the match and total_deferred_tools, a real `tool_reference` assistant block, and the following call to that same name executing for real rather than being load-first rejected. The citation substring is the tool_reference block the golden must contain.",
  },
];

// --- WS-09 §11 item 6: WaitForMcpServers --------------------------------------------------------

const ITEM_6: ConformanceRow[] = [
  {
    id: "WS09-6a",
    spec: "WS-09 §11.6",
    bullet: "the full §8.4 union, with each disqualifying state independently proven",
    status: "covered",
    citations: [
      { file: "../tools/impl/wait-for-mcp-servers.test.ts", testName: "cached counts as ready" },
      { file: "../tools/impl/wait-for-mcp-servers.test.ts", testName: "a real failure (not unconfigured) makes ready false and is reported in `failed`" },
      { file: "../tools/impl/wait-for-mcp-servers.test.ts", testName: "still-pending, needsAuth, and disabled each independently make ready false" },
      { file: "../tools/impl/wait-for-mcp-servers.test.ts", testName: "an explicitly-requested name absent from the snapshot is `unknown`, not silently dropped" },
    ],
  },
  {
    id: "WS09-6b",
    spec: "WS-09 §11.6",
    bullet: "the unconfigured-not-in-ready regression quirk, cloned deliberately",
    status: "covered",
    citations: [{ file: "../tools/impl/wait-for-mcp-servers.test.ts", testName: "dedicated regression: unconfigured is reported but excluded from the ready calculation (WS-09 §8.4 quirk)" }],
  },
  {
    id: "WS09-6c",
    spec: "WS-09 §11.6",
    bullet: "advertised ONLY when ToolSearch is disabled",
    status: "covered",
    citations: [
      { file: "../tools/impl/wait-for-mcp-servers.test.ts", testName: "advertised when toolSearchEnabled: false, absent when toolSearchEnabled: true" },
      { file: "../tools/registry.test.ts", testName: "ToolSearch and WaitForMcpServers partition on the activation axis -- exactly one is ever advertised" },
    ],
    note:
      "This task added the COMPLEMENT (rider 4): ToolSearch itself now carries `requiresToolSearchEnabled`, so the pair genuinely partitions the axis rather than ToolSearch being unconditionally advertised alongside an empty deferred pool -- the gap Lane B's own report flagged.",
  },
  {
    id: "WS09-6d",
    spec: "WS-09 §11.6",
    bullet: "the pinned `{ servers?: string[] }` input schema, as ADVERTISED to the model",
    status: "new",
    citations: [{ file: "../tools/descriptors/wait-for-mcp-servers.ts", testName: "omitted waits for all pending servers" }],
    note:
      "rider 4 (schema identity). The descriptor advertised the T1-era placeholder `{timeout_ms: number}` -- a model literally could not express the one field this tool accepts, and could pass a field it does not have. The executor always handled `{servers?}` correctly; only what the model was TOLD was wrong. The citation is the corrected schema's own description string in the descriptor file.",
  },
  {
    id: "WS09-6e",
    spec: "WS-09 §11.6",
    bullet: "`replRouted` -- REPL routing exposing connected tools inside the REPL",
    status: "deferred",
    owningPhase:
      "No REPL exists anywhere in this codebase, and `McpServerState` (mcp/state.ts) carries no signal to compute the flag from -- populating it would require inventing a state field with no producer. Lane B's own report disclosed this; the field is present in the pinned union and always absent from Winter's result, which wait-for-mcp-servers.test.ts pins explicitly ('replRouted is never populated'). Owned by whichever phase builds the REPL tool (WS-06 §3.6).",
  },
];

// --- WS-09 §11 item 7: exposure mapping ---------------------------------------------------------

const ITEM_7: ConformanceRow[] = [
  {
    id: "WS09-7a",
    spec: "WS-09 §11.7",
    bullet: "each §9 exposure row verified against the live request's tools array, per mode",
    status: "covered",
    citations: [
      { file: "../toolsearch/exposure.test.ts", testName: "deferred: true is deferred in every mode while Tool Search is active" },
      { file: "../toolsearch/exposure.test.ts", testName: "deferred: Mode[] -- deferred ONLY in the listed mode, eager (not hidden) everywhere else" },
      { file: "../toolsearch/exposure.test.ts", testName: "recomputes live: a server registered AFTER a first call is visible on the next call with no cache to inva" },
    ],
  },
  {
    id: "WS09-7b",
    spec: "WS-09 §11.7",
    bullet: "provider-fallback configurations fall back to FULL INJECTION (no deferral)",
    status: "covered",
    citations: [
      { file: "../toolsearch/exposure.test.ts", testName: "provider fallback -> full injection: providerSupportsToolSearch=false empties `deferred` regardless of a " },
      { file: "../toolsearch/exposure.test.ts", testName: "Tool Search inactive (enableToolSearch: false) -- everything eligible resolves eager, deferred is empty" },
    ],
  },
  {
    id: "WS09-7c",
    spec: "WS-09 §11.7",
    bullet: "GROUND TRUTH: the verification is against what the model actually received, on the real wire",
    status: "new",
    citations: [
      { file: "../engine.test.ts", testName: "rider 1: the MCP family appears ONLY when this session actually declares an MCP server" },
      { file: "../engine.test.ts", testName: "rider 4: ToolSearch is advertised iff activation is ON; WaitForMcpServers iff it is OFF (both need winter.mcp)" },
    ],
    note:
      "Every citation above this row is at the pure-function/partition level. These two drive a REAL runEngine and read `init.tools` off the wire, which is what WS-09 §8.5's 'never against configuration intent alone' actually asks for. The first also encodes this task's capture-driven correction: the MCP family is gated on the session declaring MCP servers, matching the official runtime's own default session (capture Scenario D).",
  },
];

// --- WS-09 §11 item 8: the alias suite ----------------------------------------------------------

const ITEM_8: ConformanceRow[] = [
  {
    id: "WS09-8a",
    spec: "WS-09 §11.8",
    bullet: "single-hop resolution (a two-entry loop never chases past the first hop)",
    status: "covered",
    citations: [
      { file: "../toolsearch/aliases.test.ts", testName: "single-hop: a two-entry loop never chases past the first resolution" },
      { file: "../toolsearch/aliases.test.ts", testName: "an aliased name resolves to its configured target" },
    ],
  },
  {
    id: "WS09-8b",
    spec: "WS-09 §11.8",
    bullet: "the native schema stays advertised under an alias (an alias never replaces the model-visible schema)",
    status: "new",
    citations: [{ file: "../tools/registry.test.ts", testName: "mirrors ${native}'s own input schema" }],
    note:
      "The Winter branch satisfies this structurally rather than by configuration: the canonical `mcp__winter__send_message`/`mcp__winter__list_agents` descriptors this task created (rider 15) MIRROR the native input schemas byte-for-byte and are backed by the SAME executor object, so 'an alias target MUST accept the native arguments exactly' cannot drift. The cited test asserts both facts (schema equality and executor identity).",
  },
  {
    id: "WS09-8c",
    spec: "WS-09 §11.8",
    bullet: "duplicate suppression, VERIFIED ON THE ACTIVE REQUEST rather than assumed",
    status: "new",
    citations: [
      { file: "../engine.test.ts", testName: "riders 3/15: WS-09 §10 duplicate suppression -- the model sees ONE SendMessage and ONE ListAgents, never the canonical duplicate" },
      { file: "../toolsearch/aliases.test.ts", testName: "defers the canonical MCP target when its alias SOURCE is already advertised" },
    ],
    note:
      "The engine-level citation reads the real `init.tools` array on both sides of the activation axis -- WS-09 §10's own 'then VERIFIES the active request schema rather than assuming Tool Search hid them', verbatim.",
  },
  {
    id: "WS09-8d",
    spec: "WS-09 §11.8",
    bullet: "hook and permission matching run on the canonical POST-ALIAS identity",
    status: "new",
    citations: [
      { file: "../engine.test.ts", testName: "rider 3 / P4-E: an alias changes the PERMISSION identity only -- lookup and execution still use the unresolved call name" },
      { file: "../engine.test.ts", testName: "rider 3 / P4-E control: without the alias table, the same target-name rule cannot match (mode floor instead)" },
    ],
    note:
      "The discriminating assertion is `decision_reason_type === \"rule\"`: a deny written against the ALIAS TARGET (a name the model never emitted) can only match through post-alias identity resolution, and the control test proves the same config without the table falls back to the mode floor. RULING P4-E's precision is also pinned in the same test: the UNRESOLVED call name still drives registry lookup, execution and the load-first predicate -- there is no dispatch redirection on the Winter branch.",
  },
  {
    id: "WS09-8e",
    spec: "WS-09 §11.8",
    bullet: "the alias suite run against BOTH branches",
    status: "deferred",
    owningPhase:
      "The official (Claude) branch is [WS-14]'s, and no such branch exists in this repository -- WS-09 §10 itself assigns redirection to it ('Applied on the official branch by [WS-14]; on the Winter branch the registry advertises the built-in-compatible name directly'). Every Winter-branch half is covered by rows 8a-8d.",
  },
];

// --- WS-09 §11 item 9: the state model ----------------------------------------------------------

const ITEM_9: ConformanceRow[] = [
  {
    id: "WS09-9a",
    spec: "WS-09 §11.9",
    bullet: "each §2.1 state is genuinely entered and reported (connected / failed / needsAuth / cached / disabled / pending)",
    status: "covered",
    citations: [
      { file: "./lifecycle.test.ts", testName: "a successfully connected server: registry gains its tools, state is 'connected', tool call round-trips and is " },
      { file: "./lifecycle.test.ts", testName: "a failed connection (nonexistent stdio command): state is 'failed' with an errorCode, no tools registered" },
      { file: "./lifecycle.test.ts", testName: "a server requiring auth (401, no authProvider configured) lands in the 'needsAuth' state, not 'failed'" },
      { file: "./control.test.ts", testName: "mcp_status reads McpServerStateSource.snapshot() directly, wire-mapping needsAuth -> 'needs-auth'" },
    ],
  },
  {
    id: "WS09-9b",
    spec: "WS-09 §11.9",
    bullet: "a cached server whose first live call FAILS re-classifies to failed and its tools are WITHDRAWN, never left dangling",
    status: "covered",
    citations: [{ file: "./lifecycle.test.ts", testName: "a cached server's first live call failing re-classifies to failed and withdraws its tools (WS-09 §2.1)" }],
  },
  {
    id: "WS09-9c",
    spec: "WS-09 §11.9",
    bullet: "the state snapshot reaches system/init.mcp_servers on a LIVE session, identically on every transport",
    status: "new",
    citations: [
      { file: "../engine.test.ts", testName: "an sdk-configured server appears in system/init.mcp_servers as connected (RULING P4-C, state-only feed)" },
      { file: "../engine.test.ts", testName: "a session with NO mcpServers builds no lifecycle at all -- mcp_servers stays absent from both init frames" },
      { file: "../../../sdk/src/transport-equivalence.test.ts", testName: "rider 6: system/init.mcp_servers reports an sdk-configured server as connected, identically on every leg" },
    ],
    note:
      "rider 11's wiring is what makes this reachable at all: before it, `mcpServerStateSource` had no construction site anywhere and `mcp_servers` was absent from every session. The conditional-absence row matters as much as the positive one -- an unconditional `[]` would have churned every committed golden.",
  },
];

// --- WS-09 §11 item 10: source precedence + stdio env -------------------------------------------

const ITEM_10: ConformanceRow[] = [
  {
    id: "WS09-10a",
    spec: "WS-09 §11.10",
    bullet: "source precedence and duplicate-name resolution per §1.2, with the loser REPORTED rather than merged",
    status: "covered",
    citations: [
      { file: "./lifecycle.test.ts", testName: "explicit beats settings beats project beats plugin for the same name; losers reported as shadowed, never merge" },
      { file: "./lifecycle.test.ts", testName: "a rejected higher-precedence declaration still claims the name -- a lower-precedence source never silently bac" },
      { file: "./lifecycle.test.ts", testName: "strictMcpConfig: only 'explicit' sources are even considered -- settings/project/plugin are skipped entirely, " },
    ],
    note:
      "RULING P4-F scopes the LOADERS for the non-explicit sources to Phase 5 (WS-11's settings resolution); the precedence MACHINERY over already-supplied sources is Phase 4's and is what these fixtures drive. engine.ts's own live wiring supplies exactly one source today (`origin: \"explicit\"`, from Options.mcpServers), so `shadowed` is empty by construction in production -- disclosed at that call site.",
  },
  {
    id: "WS09-10b",
    spec: "WS-09 §11.10",
    bullet: "a stdio child's env is EXACTLY the explicit allowlist -- nothing inherited wholesale",
    status: "covered",
    citations: [
      { file: "./transports/stdio.test.ts", testName: "a canary set in the PARENT's own process.env never reaches the child, even though the real baseline names do" },
      { file: "./transports/stdio.test.ts", testName: "each STDIO_BASE_ENV_NAMES entry appears in the child iff the parent process actually has it, with the same val" },
      { file: "./transports/stdio.test.ts", testName: "a config env value overrides the baseline for the same name, and adds a name outside the baseline" },
    ],
    note:
      "RULING P4-H: §1.2's MUST is unsatisfiable through the SDK's own StdioClientTransport (the pinned 1.30.0 build spreads getDefaultEnvironment() unconditionally and never sets `detached`), so Winter ships its own Transport over node:child_process. The parent-canary fixture is the proof the ruling itself demanded.",
  },
  {
    id: "WS09-10c",
    spec: "WS-09 §11.10",
    bullet: "...and the spawned child is reaped by PROCESS GROUP on every exit path",
    status: "covered",
    citations: [
      { file: "./transports/stdio.test.ts", testName: "the spawned child is its own process-group leader: process.kill(-pid, 0) succeeds while it is alive" },
      { file: "./transports/stdio.test.ts", testName: "close() reaps the WHOLE PROCESS GROUP, including a forked grandchild -- not just the direct child" },
      { file: "./transports/stdio.test.ts", testName: "a failed/timed-out connect ALSO reaps the whole group (mirrors mcp/client.ts's own catch-block close path)" },
    ],
  },
];

// --- WS-09 §11 item 11: the standing Winter server ----------------------------------------------

const ITEM_11: ConformanceRow[] = [
  {
    id: "WS09-11a",
    spec: "WS-09 §11.11",
    bullet: "descriptor identity for the standing set, including mcp__winter__advisor",
    status: "covered",
    citations: [
      { file: "../tools/conformance.test.ts", testName: "mcp__winter__advisor keeps the pinned mcp__ name and an identical descriptor across every permission mode" },
      { file: "./winter-server.test.ts", testName: "the server's own advisor tool is byte-identical to the regis" },
    ],
  },
  {
    id: "WS09-11b",
    spec: "WS-09 §11.11",
    bullet: "the `winter` server name is RESERVED against live registration (RULING P4-B)",
    status: "covered",
    citations: [{ file: "../tools/registry.test.ts", testName: "RESERVED" }],
  },
  {
    id: "WS09-11c",
    spec: "WS-09 §11.11",
    bullet: "the standing set BEYOND advisor (browser/computer/docs/sheets/slides/sessions)",
    status: "deferred",
    owningPhase:
      "WS-09 §1.3 assigns these to the product layer ([WS-14]/[WS-15], P7/P8); mcp/winter-server.ts's own header records that nothing registers them yet. This task added two MORE standing-server entries (mcp__winter__send_message / mcp__winter__list_agents, rider 15) because WS-10 §15 names them as the alias pair the messaging tools need -- covered by rows 8b/8c, not here.",
  },
  {
    id: "WS09-11d",
    spec: "WS-09 §11.11",
    bullet: "byte-identical advertisement across BOTH runtime branches",
    status: "deferred",
    owningPhase: "Same reason as row 8e: the official branch is [WS-14]'s and does not exist in this repository. The Winter-branch half (one descriptor, one identity, unchanged across modes) is row 11a.",
  },
];

// --- The matrix ---------------------------------------------------------------------------------

const ALL_ROWS: ConformanceRow[] = [...ITEM_1, ...ITEM_2, ...ITEM_3, ...ITEM_4, ...ITEM_5, ...ITEM_6, ...ITEM_7, ...ITEM_8, ...ITEM_9, ...ITEM_10, ...ITEM_11];

describe("WS-09 §11 conformance matrix (Phase 4 Task 8)", () => {
  test("every row is covered, newly tested here, or deferred with a named owning-phase reasoning -- zero unexplained bullets", () => {
    for (const row of ALL_ROWS) {
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
    for (const row of ALL_ROWS) {
      for (const c of row.citations ?? []) {
        // Self-citation loophole guard (the P2/P3 matrices' own precedent): a row citing THIS file
        // has its own `testName` literal sitting in the table, which would trivially satisfy a plain
        // `.includes()` even if the real test were renamed. Requiring TWO occurrences closes it.
        const required = c.file === "./conformance.test.ts" ? 2 : 1;
        const occurrences = countOccurrences(readCited(c.file), c.testName);
        expect(
          occurrences >= required,
          `${row.id}: citation not found -- ${c.file} does not contain ${required} occurrence(s) of "${c.testName}" (found ${occurrences})`,
        ).toBe(true);
      }
    }
  });

  test("row ids are unique", () => {
    const ids = ALL_ROWS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all eleven WS-09 §11 items are represented -- no numbered obligation is silently missing", () => {
    const items = new Set(ALL_ROWS.map((r) => r.spec.replace(/^WS-09 §11\./, "").replace(/[a-z]$/, "")));
    expect([...items].sort((a, b) => Number(a) - Number(b))).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  });

  test("summary counts (informational -- printed for the task report)", () => {
    const covered = ALL_ROWS.filter((r) => r.status === "covered").length;
    const newRows = ALL_ROWS.filter((r) => r.status === "new").length;
    const deferred = ALL_ROWS.filter((r) => r.status === "deferred").length;
    expect(covered + newRows + deferred).toBe(ALL_ROWS.length);
  });
});
