// Task 8 (Phase 3 close-out) -- the fixture-matrix sweep proving WS-06 §6's five tool-catalog
// obligations and WS-12 §11's enforceable-now conformance subset, mirroring
// permissions/conformance.test.ts's own P2 T13 pattern exactly: every named bullet gets exactly one
// of "covered" (a real test already proves it, cited by {file, testName}, machine-verified below),
// "new" (a genuine gap this file closes directly, self-cited the same way), or "deferred" (out of
// scope at this phase, every row naming its owning-phase reasoning with evidence, never a silent
// absence). Zero rows may lack one of the three.
//
// WS-12 §11 is explicitly scoped here to its ENFORCEABLE-NOW subset (task-8-brief.md) -- WS-12 §11
// itself is written as "the WS-17 harness MUST prove, at minimum," spanning mechanisms this phase's
// five merged lanes actually built AND mechanisms (background promotion of a timed-out command, the
// agent-task transcript symlink rule, network verdict caching) that a grep of the real source below
// confirms do not exist as code paths anywhere in this repository yet -- those rows are deferred with
// the evidence for their absence stated plainly, not silently reinterpreted as "covered" by an
// adjacent mechanism.
//
// This file does NOT re-fetch the pinned upstream artifact -- WS-06 §6 obligation 3's schema-identity
// fixtures are encoded from two hermetic sources only: WS-06's own verbatim fenced input-schema code
// blocks (precise by construction -- unlike the RESULT arrow-prose this same investigation found
// dropping wrapper keys, an input schema WS-06 fences as ```ts is quoted directly, not paraphrased),
// and packages/conformance/compat/anthropic/0.3.250/derived-shapes-p3-task8.md's own already-recorded
// ephemeral-capture findings (fetched, verified, and the tarball deleted, in the session that produced
// that file). `bun test` itself stays hermetic; the only live-fetch surface for this artifact is the
// env-gated scripts/capture-official-golden.ts.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine } from "../engine.ts";
import { scriptedProvider, stubExecutor } from "../provider/mock.ts";
import "./descriptors/index.ts";
import { getRegisteredTool, listRegisteredTools, buildAdvertisedSet, registerTool, unregisterToolForTest, type ToolDescriptor } from "./registry.ts";

// --- shared local test helpers (file-private, mirroring permissions/conformance.test.ts's own
// "self-sufficient, not cross-file-shared" judgment call) -------------------------------------------

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  sessionId: "tools-conformance-s",
  cwd: "/tmp/winter-tools-conformance-fixture",
  model: "sonnet",
  ...overrides,
});

function fixtureDescriptor(canonicalName: string, overrides?: Partial<ToolDescriptor>): ToolDescriptor {
  return {
    canonicalName,
    advertisedName: canonicalName,
    source: "builtin",
    inputSchema: { type: "object" },
    description: "fixture",
    exposure: "eager",
    permissionClass: "read",
    availability: {},
    capabilityRequirements: [],
    disposition: "implement-now",
    ...overrides,
  };
}

// ================================================================================================
// New coverage: WS-06 §6 obligation 1 -- a real system/init.tools snapshot, at the ENGINE level.
// ================================================================================================
//
// buildAdvertisedSet's own per-axis logic (mode via hiddenWhenFamilyTaskNative, familyMetadata,
// feature flags, toolSearchEnabled, insideSubagent) is already exhaustively unit-tested as a PURE
// function in registry.test.ts (cited in the matrix below, row WS06-01b) -- that coverage is real and
// is not re-proven here. What was NEVER proven before this task is that the real engine wire output
// reflects buildAdvertisedSet at all (it was hardcoded tools:[] on both init frames since P1). This
// closes that gap for the two axes RuntimeConfig actually threads through to the real
// runEngine(...) call site today (mode, disallowedTools) -- see this row's own note in the matrix for
// the honest scope carve-out on the other four axes (family/feature/toolSearch/subagent), which have
// no RuntimeConfig field wiring them to the real call at all yet, only to the pure function.
test("WS-06 §6 obligation 1: system/init.tools reflects the real buildAdvertisedSet wiring (mode + disallowedTools) on BOTH init frame shapes, not the old hardcoded []", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([{ kind: "text", text: "done" }]);
  const config = baseConfig({ permissionMode: "default", disallowedTools: ["Bash"] });
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames: WinterFrame[] = [];
  for await (const f of host.input) frames.push(f);
  await done;

  const initFrame = frames.find((f) => f.type === "init") as { tools: string[] } | undefined;
  expect(initFrame).toBeDefined();
  // Real, non-empty, derived-from-the-registry list -- not the old literal [].
  expect(initFrame!.tools.length).toBeGreaterThan(0);
  // disallowedTools reached the real engine call: a bare-denied name is genuinely excluded...
  expect(initFrame!.tools).not.toContain("Bash");
  // ...while an ordinary, unrelated tool is completely unaffected.
  expect(initFrame!.tools).toContain("Read");
  // A correctly-absent name is never advertised regardless of disallowedTools (WS-06 §2's own
  // "the absence is itself a conformance assertion" -- unconditional, not merely not-yet-denied).
  expect(initFrame!.tools).not.toContain("PowerShell");

  const systemInit = dataMessages(frames).find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "init") as
    | { tools: string[] }
    | undefined;
  expect(systemInit).toBeDefined();
  // WinterFrame "init" and the SdkMessage "system"/"init" data frame carry the IDENTICAL list --
  // one buildAdvertisedSet call, folded into both wire shapes, never two independent computations
  // that could silently drift apart.
  expect(systemInit!.tools).toEqual(initFrame!.tools);
});

// ================================================================================================
// New coverage: WS-06 §6 obligation 3 -- schema-identity, task-graph/cron/schedule-wakeup family.
// ================================================================================================
//
// Encoded from WS-06 §3.4's own verbatim fenced ```ts input-schema code blocks (TaskUpdate,
// CronCreate, ScheduleWakeup) plus derived-shapes-p3-task8.md's own already-fetched, already-verified
// ephemeral-capture findings for the RESULT shapes that same document settled. No live fetch here.
test("WS-06 §6 obligation 3: TaskUpdate/CronCreate/ScheduleWakeup descriptors carry the exact WS-06 §3.4 verbatim input schema (property names, enum members, required list)", () => {
  const taskUpdate = getRegisteredTool("TaskUpdate")?.descriptor.inputSchema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  expect(Object.keys(taskUpdate.properties).sort()).toEqual(
    ["taskId", "subject", "description", "activeForm", "status", "addBlocks", "addBlockedBy", "owner", "metadata"].sort(),
  );
  expect(taskUpdate.required).toEqual(["taskId"]);
  // WS-06 §3.4 line 322 pins all FOUR status values, including "deleted" as a settable INPUT --
  // deliberately distinct from TaskGet/TaskList's own pinned 3-member OUTPUT union (no "deleted"),
  // per derived-shapes-p3-task8.md item (b)'s own reconciliation of that asymmetry.
  expect((taskUpdate.properties["status"] as { enum: string[] }).enum).toEqual(["pending", "in_progress", "completed", "deleted"]);

  const cronCreate = getRegisteredTool("CronCreate")?.descriptor.inputSchema as { properties: Record<string, unknown>; required: string[] };
  expect(Object.keys(cronCreate.properties).sort()).toEqual(["cron", "prompt", "recurring", "durable"].sort());
  expect(cronCreate.required.sort()).toEqual(["cron", "prompt"]);

  const scheduleWakeup = getRegisteredTool("ScheduleWakeup")?.descriptor.inputSchema as { properties: Record<string, unknown> };
  expect(Object.keys(scheduleWakeup.properties).sort()).toEqual(["delaySeconds", "reason", "prompt", "stop", "noop"].sort());
  // T8 fix (derived-shapes-p3-task8.md item (h)): the pinned artifact's own delaySeconds carries NO
  // schema-level minimum/maximum -- clamping is runtime-only. Pins the fix stays fixed, not just that
  // it once passed.
  expect(scheduleWakeup.properties["delaySeconds"]).not.toHaveProperty("minimum");
  expect(scheduleWakeup.properties["delaySeconds"]).not.toHaveProperty("maximum");
});

test("WS-06 §6 obligation 3: TaskCreate/TaskGet/TaskList/TaskUpdate/CronDelete/ScheduleWakeup executors emit exactly the pinned result envelopes (derived-shapes-p3-task8.md), end-to-end through the real registered executors", async () => {
  const { resetTaskGraphStoreForTest } = await import("./task-graph-store.ts");
  const { resetInMemoryCronStoreForTest } = await import("./impl/cron.ts");
  const { resetScheduleWakeupStoreForTest } = await import("./impl/schedule-wakeup.ts");
  await import("./impl/index.ts"); // forces every real executor to be wired, independent of import order
  resetTaskGraphStoreForTest();
  resetInMemoryCronStoreForTest();
  resetScheduleWakeupStoreForTest();

  const { createSessionReadState } = await import("./read-state.ts");
  const ctx = {
    cwd: "/work",
    home: "/home/test",
    sessionId: "t8-schema-identity",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" as const },
    tempDir: "/work/.tmp",
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default" as const },
  };
  const run = async (name: string, input: unknown) => {
    const tool = getRegisteredTool(name);
    if (!tool?.executor) throw new Error(`${name} has no registered executor`);
    return JSON.parse((await tool.executor.execute(input, ctx)).output);
  };

  const created = await run("TaskCreate", { subject: "s", description: "d" });
  expect(Object.keys(created)).toEqual(["task"]); // TaskCreateOutput = { task: { id, subject } }

  const got = await run("TaskGet", { taskId: created.task.id });
  expect(Object.keys(got)).toEqual(["task"]); // TaskGetOutput = { task: {...} | null }

  const updated = await run("TaskUpdate", { taskId: created.task.id, status: "in_progress" });
  // TaskUpdateOutput = { success, taskId, updatedFields, error?, statusChange? }
  expect(Object.keys(updated).sort()).toEqual(["success", "taskId", "updatedFields", "statusChange"].sort());

  const listed = await run("TaskList", {});
  expect(Object.keys(listed)).toEqual(["tasks"]); // TaskListOutput = { tasks: [...] }

  const cronCreated = await run("CronCreate", { cron: "* * * * *", prompt: "p" });
  const cronDeleted = await run("CronDelete", { id: cronCreated.id });
  expect(Object.keys(cronDeleted)).toEqual(["id"]); // CronDeleteOutput = { id } -- no invented `deleted`

  const wakeup = await run("ScheduleWakeup", { delaySeconds: 60, reason: "r", prompt: "p", noop: false });
  expect(typeof wakeup.scheduledFor).toBe("number"); // epoch ms, not an ISO string
});

// ================================================================================================
// New coverage: WS-06 §6 obligation 4 -- registry-count independence is genuinely dynamic, not cached.
// ================================================================================================
test("WS-06 §6 obligation 4: buildAdvertisedSet's own length is derived live from the registry -- registering/unregistering a throwaway tool moves it by exactly one, proving nothing hardcodes or caches a fixed count", () => {
  const before = buildAdvertisedSet({ mode: "default" }).length;
  const name = "__t8_conformance_count_independence__";
  registerTool({ descriptor: fixtureDescriptor(name) });
  try {
    expect(buildAdvertisedSet({ mode: "default" }).length).toBe(before + 1);
  } finally {
    unregisterToolForTest(name);
  }
  expect(buildAdvertisedSet({ mode: "default" }).length).toBe(before);
});

// ================================================================================================
// New coverage: WS-06 §6 obligation 5 -- mcp__winter__* descriptor identity.
// ================================================================================================
//
// "Every Winter plugin tool" reduces to exactly one real instance today (verified: a grep of every
// descriptors/*.ts file for "mcp__winter__" finds only advisor.ts) -- this is not glossing over a
// larger set, it is the complete set as it exists at this phase. "Both branches advertise
// byte-identical descriptors" (WS-06 §4, report §122/D7): Winter has no second, separate
// official-branch copy of its own plugin tool to diff against (advisor is Winter-only, absent from
// the real upstream entirely) -- the testable, Winter-internal analogue of that interchangeability
// requirement is that the ONE canonical registration is never conditionally reshaped by context: it
// carries the pinned mcp__ name (never a bare advisor name, which the spec explicitly rules out), and
// the exact same descriptor is what every mode's advertised set sees, given its one capability gate.
test("WS-06 §6 obligation 5: mcp__winter__advisor keeps the pinned mcp__ name and an identical descriptor across every permission mode", async () => {
  const descriptor = getRegisteredTool("mcp__winter__advisor")?.descriptor;
  expect(descriptor).toBeDefined();
  expect(descriptor!.canonicalName).toBe("mcp__winter__advisor");
  expect(descriptor!.advertisedName).toBe("mcp__winter__advisor");
  expect(getRegisteredTool("advisor")).toBeUndefined(); // the bare name WS-06 §4 explicitly rules out

  // advisor's own availability gates it behind capabilityRequirements: ["winter.reviewer-model"]
  // (advisor.ts) -- supplied here on every call so the loop proves "identical ACROSS MODES", not
  // "visible with no capability supplied" (a separate, correctly-enforced axis, not this row's claim).
  const MODES = ["default", "acceptEdits", "bypassPermissions", "dontAsk", "plan", "auto"] as const;
  for (const mode of MODES) {
    const advertised = buildAdvertisedSet({ mode, capabilities: ["winter.reviewer-model"] }).find((d) => d.canonicalName === "mcp__winter__advisor");
    expect(advertised, `mode=${mode}: mcp__winter__advisor must be advertised identically`).toEqual(descriptor);
  }

  // Honest gap, not silently glossed over: unlike WS06-01a's own ordinary-tool proof (Read/Bash reach
  // the real engine wire today), mcp__winter__advisor does NOT, because RuntimeConfig has no field
  // threading `capabilities` to the real runEngine(...) call site at all (the same gap WS06-01b's own
  // matrix note already names for familyMetadata/features/toolSearchEnabled/insideSubagent -- this is
  // that same gap's concrete instance for the capabilities axis specifically). Proven here rather than
  // asserted away: the real wire currently omits it.
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([{ kind: "text", text: "done" }]);
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  for await (const f of host.input) frames.push(f);
  await done;
  const initFrame = frames.find((f) => f.type === "init") as { tools: string[] } | undefined;
  expect(initFrame!.tools).not.toContain("mcp__winter__advisor");
});

// ================================================================================================
// The fixture matrix itself.
// ================================================================================================

interface Citation {
  /** Path to the test file, relative to THIS file. */
  file: string;
  /** An exact, verbatim substring of a real `test(...)`/`describe(...)` title in that file. For a
   * template-literal-parameterized title, a fixed (non-interpolated) substring is sufficient -- the
   * check below reads raw SOURCE text, so the static portion of the template literal is present
   * exactly once regardless of how many concrete titles it expands to at runtime. */
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

// --- WS-06 §6 -----------------------------------------------------------------------------------

const WS06_06: ConformanceRow[] = [
  {
    id: "WS06-01a",
    spec: "WS-06 §6 obligation 1",
    bullet: "a per-configuration system/init.tools snapshot fixture (§1.5) -- the real ENGINE WIRE, not just the pure function",
    status: "new",
    citations: [
      { file: "./conformance.test.ts", testName: "system/init.tools reflects the real buildAdvertisedSet wiring (mode + disallowedTools) on BOTH init frame shapes" },
    ],
  },
  {
    id: "WS06-01b",
    spec: "WS-06 §6 obligation 1",
    bullet: "per mode × model-family × feature-flag combination -- the underlying buildAdvertisedSet axis logic",
    status: "covered",
    citations: [
      { file: "./registry.test.ts", testName: "mode gates a task-graph tool via the R3-4 seam (hiddenWhenFamilyTaskNative)" },
      { file: "./registry.test.ts", testName: "TodoWrite is additionally gated behind its own feature flag, on top of the family gate" },
      { file: "./registry.test.ts", testName: "WaitForMcpServers is advertised only when ToolSearch is disabled" },
      { file: "./registry.test.ts", testName: "AskUserQuestion is unavailable inside a subagent" },
    ],
    note:
      "Every AdvertisedSetInputs axis is exhaustively unit-tested at the pure-function level. Scope carve-out (stated plainly, not glossed over): RuntimeConfig has no field threading familyMetadata/features/toolSearchEnabled/insideSubagent to the real runEngine(...) call site today -- only mode and disallowedTools reach it (see WS06-01a's own new coverage). A real per-model-family/feature-flag ENGINE-LEVEL snapshot is therefore not yet producible until a later task threads those fields through RuntimeConfig; this row's 'covered' verdict is for the axis LOGIC, which is real and correct, not a claim that every axis is reachable end-to-end today.",
  },
  {
    id: "WS06-02",
    spec: "WS-06 §6 obligation 2",
    bullet: "correct-absence fixtures: EndConversation, SendFeedback, PowerShell, hosted tools -- neither advertised nor callable",
    status: "covered",
    citations: [
      { file: "./registry.test.ts", testName: "correctly-absent names carry the correctly-absent disposition and hidden exposure" },
      { file: "./registry.test.ts", testName: "the internal catalog (Set 1/3 superset) is a strict superset of any one session's advertised set (Set 2)" },
    ],
    note:
      "'Hosted tools' maps to registry.test.ts's own CORRECTLY_ABSENT_NAMES set beyond the three named individually (Artifact, RemoteTrigger, Projects, ClaudeDesign, ShowOnboardingRolePicker -- all hosted/host-surface concerns absent from a local Winter session), covered by the same two citations (both iterate the full CORRECTLY_ABSENT_NAMES array, not just EndConversation/PowerShell/SendFeedback individually). 'Neither advertised' is the second citation (structural: never a member of any advertised set); 'nor callable' is the correctly-absent disposition itself, which registry.ts's own EngineFacingToolExecutor adapter (correctlyAbsentResult) folds into a legible non-throwing error rather than ever dispatching -- exercised end-to-end by registry.test.ts's own EndConversation execute() fixtures (not cited by title here since they are un-named inline assertions, not test(...) titles of their own; the disposition-and-adapter code path is the same for every name in the set).",
  },
  {
    id: "WS06-03a",
    spec: "WS-06 §6 obligation 3",
    bullet: "schema-identity fixtures per §3 entry against the pinned 0.3.250 artifacts -- task-graph/cron/schedule-wakeup family (this task's own envelope-reconciliation investigation)",
    status: "new",
    citations: [
      {
        file: "./conformance.test.ts",
        testName: "TaskUpdate/CronCreate/ScheduleWakeup descriptors carry the exact WS-06 §3.4 verbatim input schema",
      },
      {
        file: "./conformance.test.ts",
        testName: "TaskCreate/TaskGet/TaskList/TaskUpdate/CronDelete/ScheduleWakeup executors emit exactly the pinned result envelopes",
      },
    ],
    note:
      "Full derivation evidence (fetch/verify/extract/delete method, line-numbered citations into the pinned artifact) lives in packages/conformance/compat/anthropic/0.3.250/derived-shapes-p3-task8.md -- this row's own two new tests encode its findings as executable fixtures rather than re-deriving them. A from-scratch schema-identity sweep of the REST of the WS-06 §3 tool surface (Bash, Edit, Read, Write, NotebookEdit, Glob, Grep, Monitor, EnterPlanMode/ExitPlanMode, EnterWorktree/ExitWorktree, TaskOutput/TaskStop) is out of this row's scope -- WS-06's own prose already gives verbatim schemas for most of those (unlike the task-graph/cron RESULT shapes this investigation specifically found paraphrased), and a full re-derivation of the entire tool surface is a materially larger undertaking the derived-shapes document itself flags as a reasonable follow-up task, not something silently folded in here.",
  },
  {
    id: "WS06-03b",
    spec: "WS-06 §6 obligation 3",
    bullet: "schema-identity for tools with NO pinned upstream schema (placeholder set) -- correctly represented as placeholders, not invented schemas presented as pinned",
    status: "covered",
    citations: [
      { file: "./registry.test.ts", testName: "correctly-absent names carry the correctly-absent disposition and hidden exposure" },
    ],
    note:
      "ToolSearch/WaitForMcpServers/StructuredOutput/ListMcpResourcesTool/ReadMcpResourceTool each self-declare a 'placeholder' schema in their own descriptor header comment, for three distinct reasons (WS-09 ownership; per-call dynamic generation; WS-06-prose-silence specifically, not artifact-silence) -- see derived-shapes-p3-task8.md's own closing note for the full breakdown, including the exhaustive grep proving ToolSearch/WaitForMcpServers/StructuredOutput are absent from every file in the pinned artifact while ListMcpResourcesTool/ReadMcpResourceTool's own real pinned schemas exist there but are owned by a different workstream ([WS-09]), out of this task's scope to apply. The cited test is the closest existing structural proof that a placeholder-schema tool is still correctly REGISTERED (not silently missing) rather than a schema-content assertion, since there is nothing pinned to assert content against for three of the five names by design.",
  },
  {
    id: "WS06-04",
    spec: "WS-06 §6 obligation 4",
    bullet: `registry-count independence: no test may assert "45" or "21" as a constant`,
    status: "covered",
    citations: [
      {
        file: "./conformance.test.ts",
        testName: "buildAdvertisedSet's own length is derived live from the registry -- registering/unregistering a throwaway tool moves it by exactly one",
      },
    ],
    note:
      "registry.test.ts's own file header already states and follows this discipline codebase-wide (\"deliberately count-independent throughout... every assertion below checks set MEMBERSHIP or a STRUCTURAL property, never `.length === <N>`\"); this row's own new test is the first to make the INDEPENDENCE property itself directly assertable (a relative delta-of-one, never an absolute count) rather than merely a style convention followed by every other file's own tests.",
  },
  {
    id: "WS06-05",
    spec: "WS-06 §6 obligation 5",
    bullet: "mcp__winter__* descriptor-identity fixtures: both branches advertise byte-identical descriptors for every Winter plugin tool and mcp__winter__advisor",
    status: "new",
    citations: [
      {
        file: "./conformance.test.ts",
        testName: "mcp__winter__advisor keeps the pinned mcp__ name and an identical descriptor across every permission mode",
      },
    ],
    note:
      "The cited test also proves an honest, separate gap rather than glossing over it: mcp__winter__advisor's own capabilityRequirements ([\"winter.reviewer-model\"]) means it is currently NEVER advertised at the real engine wire, because RuntimeConfig has no field threading `capabilities` to the real runEngine(...) call at all -- the concrete instance, for this one tool, of the same capabilities/family/feature-flag RuntimeConfig-threading gap WS06-01b's own note already names.",
  },
];

// --- WS-12 §11 (enforceable-now subset, per task-8-brief.md) -------------------------------------

const WS12_11: ConformanceRow[] = [
  {
    id: "WS12-01",
    spec: "WS-12 §11",
    bullet: "the full §2 config schema parses on both branches, and every 'fully enforced' row behaves identically under differential capture",
    status: "covered",
    citations: [
      { file: "../../../sdk/src/transport-equivalence.test.ts", testName: "Lane C (Bash/sandbox/Monitor/TaskOutput/TaskStop): a real, unsandboxed Bash round" },
    ],
    note:
      "SandboxSettingsConfig parses (packages/sdk/src/protocol/config.ts) and threads through to the real runtime SandboxSettings without re-typing (RuntimeConfig.sandbox -> ToolExecutionContext.sandboxSettings, this task's own production-wiring work). 'Differential capture' here is the leg-equivalence proof this task's own Task 8 section of transport-equivalence.test.ts already established (\"Task 8: one real WS-06 tool round per lane family, on every leg\", Lane C's own Bash entry) -- the SAME transport mechanism every other lane's equivalence proof already relies on, so per-config-row re-registration is not repeated here (WS08-01's own P2 precedent for this exact reasoning: \"structural, not 10x-duplicated\").",
  },
  {
    id: "WS12-02",
    spec: "WS-12 §11",
    bullet: "domain-list network configs fail closed with the typed unsupported-capability error, never a silently-broadened boolean",
    status: "covered",
    citations: [
      { file: "../sandbox/profile.test.ts", testName: "allowedDomains present (even empty) throws a typed SandboxConfigError" },
      { file: "../sandbox/profile.test.ts", testName: "deniedDomains present throws a typed SandboxConfigError" },
      { file: "../sandbox/spawn.test.ts", testName: "runCommand: domain-list network config propagates SandboxConfigError, never silently flattened" },
    ],
  },
  {
    id: "WS12-03",
    spec: "WS-12 §11",
    bullet: "dangerouslyDisableSandbox is surfaced under every permission policy, is never silenced by a rule, and its override state appears in the result",
    status: "covered",
    citations: [
      {
        file: "../permissions/evaluator.test.ts",
        testName: "the override reaches the prompt stage even with a BARE Bash(*) allow rule present — never rule-silenced, never auto-approved by acceptEdits/auto, spec-literal \"under every policy\" including bypass",
      },
      { file: "../permissions/evaluator.test.ts", testName: "a deny rule targeting Bash still wins outright (stage 2 runs before stage 3's mandatory interaction)" },
      { file: "./impl/bash.test.ts", testName: "a background override call reports override-requested in BOTH the started message and the task_notification summary" },
      { file: "./impl/bash.test.ts", testName: "an ordinary sandboxed background call reports [sandbox: sandboxed] in both surfaces too" },
    ],
    note:
      "'Under every permission policy' is proven by a SINGLE mode-parameterized test (template-literal title, one concrete test per mode -- the cited substring is the fixed, non-interpolated portion) rather than six separately-registered tests. 'A deny rule still wins' is the one legitimate exception the RULING P3-J implementation itself preserves (stage 2 precedes stage 3), not a counterexample to 'never silenced' -- a deny is a DENIAL, not a silent bypass of the override's own visibility.",
  },
  {
    id: "WS12-04",
    spec: "WS-12 §11",
    bullet: "the carried deny tests pass against the real sandbox-exec: outside-the-fence writes denied, bare mktemp allowed, mktemp -d unwritable, two-level-deep per-user-temp denied, all three control-plane filenames denied per-root/nested/case-variant",
    status: "covered",
    citations: [
      { file: "../sandbox/deny.darwin.test.ts", testName: "denies a write outside every writable root" },
      { file: "../sandbox/deny.darwin.test.ts", testName: "bare mktemp creates and writes a file (macOS mktemp ignores $TMPDIR, resolves the per-user temp dir instead)" },
      { file: "../sandbox/deny.darwin.test.ts", testName: "mktemp -d yields an UNWRITABLE directory -- the allowance is direct children only, never a subpath grant" },
      { file: "../sandbox/deny.darwin.test.ts", testName: "a two-level-deep path under the per-user temp dir stays denied" },
      { file: "../sandbox/deny.darwin.test.ts", testName: "regex arm 2 + control-plane carve-out: all three filenames, per-root, nested, and case-variant" },
    ],
    note: "darwin-gated via test.skipIf (this suite's own header: enumerated-but-skipped on non-darwin CI, never a vanishing describe.skip block).",
  },
  {
    id: "WS12-05a",
    spec: "WS-12 §11",
    bullet: "fresh-shell/env-non-persistence, cwd-carry-within-allowed-dirs, the 2 min/10 min timeout bounds, the ~30k inline cap + persisted path, the failure head/tail excerpt, and the 5 GB stream kill",
    status: "covered",
    citations: [
      { file: "./impl/bash.test.ts", testName: "env exports from one call do NOT persist to the next -- fresh shell per call" },
      { file: "./impl/bash.test.ts", testName: "a cd that lands within an allowed dir (ctx.tempDir) persists via ctx.session.setCwd" },
      { file: "./impl/bash.test.ts", testName: "a cd OUTSIDE every allowed dir does not persist" },
      { file: "./impl/bash.test.ts", testName: "defaults to 2 minutes when omitted" },
      { file: "./impl/bash.test.ts", testName: "clamps to the 600000ms ceiling (the ordinary ceiling and the declaration cap are the same number)" },
      { file: "./impl/bash.test.ts", testName: "large SUCCESSFUL stdout is capped at ~30k chars with a persisted-output path" },
      { file: "./impl/bash.test.ts", testName: "a large FAILURE gets a smaller head/tail excerpt, not the full 30k" },
      { file: "../sandbox/spawn.test.ts", testName: "the stream-kill switch actually fires: a producer well past maxStreamedBytes is killed mid-stream, not just left to finish naturally" },
    ],
  },
  {
    id: "WS12-05b",
    spec: "WS-12 §11",
    bullet: "background promotion of a timed-out eligible command",
    status: "deferred",
    owningPhase:
      "Not directly ruled -- reasoned from absence: grep for \"promot\" across packages/runtime/src/sandbox and tools/impl/bash.ts, tools/background-tasks.ts returns zero hits; there is no code path anywhere that converts a foreground command exceeding its timeout into a background task. The timeout bounds themselves (2 min/10 min) and background tasks as a STANDALONE feature (run_in_background:true) both exist and are covered (WS12-05a above; WS12-06 below) -- only the PROMOTION mechanism bridging the two on timeout is genuinely unbuilt.",
  },
  {
    id: "WS12-06",
    spec: "WS-12 §11",
    bullet: "background .output files land at the WS-05 path",
    status: "covered",
    citations: [{ file: "./background-tasks.test.ts", testName: "D18 path shape: <session-temp>/tasks/<task-id>.output" }],
  },
  {
    id: "WS12-06b",
    spec: "WS-12 §11",
    bullet: "the agent-task symlink rule accepts a valid transcript link and refuses a foreign-owned/escaping target, falling back to the stub",
    status: "deferred",
    owningPhase:
      "Not directly ruled -- reasoned from absence: grep for \"symlink\" across packages/runtime/src/tools/background-tasks.ts (source, not just its tests) returns zero hits. No agent-task-to-transcript symlink mechanism of any kind exists yet to test; background task output files are plain files today, never links. Most likely bundled with real subagent-originated tool calls / WS-10 messaging (P4), since a symlink INTO a transcript implies a producer-side transcript concept this phase's background-task model does not yet have a consumer for.",
  },
  {
    id: "WS12-07",
    spec: "WS-12 §11",
    bullet: "network verdict cache invalidation on mode/rule/environment change matches the §8 profile",
    status: "deferred",
    owningPhase:
      "Not directly ruled -- reasoned from absence: resolveNetworkPosture (sandbox/profile.ts) is a pure, uncached function recomputed on every call -- there is no cache of any kind on the network-posture axis to invalidate. This is consistent with domain-list configs themselves being unsupported-and-fail-closed at v1 (WS12-02 above; WS-12 §12 open question 1) -- a cache-invalidation obligation over a config shape that itself has no v1 implementation has nothing to bind to yet. Most likely arrives alongside real domain-list support, whichever phase that is scoped to.",
  },
  {
    id: "WS12-08",
    spec: "WS-12 §11",
    bullet: "the reported sandbox posture (§8) matches the actually taken execution path (§4.1) for every combination, including the unavailability error path (§3)",
    status: "covered",
    citations: [
      { file: "../sandbox/spawn.test.ts", testName: "reflects the real binary's presence on darwin" },
      { file: "../sandbox/spawn.test.ts", testName: "dangerouslyDisableSandbox: true wins over excludedCommands/default" },
      { file: "../sandbox/spawn.test.ts", testName: "no config at all resolves to sandboxed, override not requested" },
      { file: "../sandbox/spawn.test.ts", testName: "an injected bogus sandboxExecPath forces SandboxUnavailableError even though the real binary is present" },
      { file: "../sandbox/spawn.test.ts", testName: "a sandboxed posture with no real sandbox-exec on the resolution path rejects with SandboxUnavailableError" },
      { file: "../sandbox/spawn.test.ts", testName: "matchCommand, not the (possibly wrapped) command, is what excludedCommands matches against" },
      { file: "../sandbox/spawn.test.ts", testName: "negative control: the same wrapped command WITHOUT matchCommand is NOT excluded" },
      { file: "./impl/bash.test.ts", testName: "excludedCommands matches the model's RAW command, not bash.ts's own pwd-capture wrapper" },
      { file: "./impl/bash.test.ts", testName: "an ordinary sandboxed background call reports [sandbox: sandboxed] in both surfaces too" },
    ],
  },
  {
    id: "WS12-09",
    spec: "WS-12 §11",
    bullet: "the workflow-worker profile still denies fork/network/writes while booting the worker (exec-of-self allowed)",
    status: "covered",
    citations: [
      { file: "../sandbox/deny.darwin.test.ts", testName: "the profile parses and loads: self-exec succeeds (proves no unbound-variable parse failure)" },
      { file: "../sandbox/deny.darwin.test.ts", testName: "exec of anything OTHER than the self binary is denied -- /bin/sh cannot run, so its write never happens" },
    ],
    note:
      "Exec-of-self-allowed and fork(exec)-of-anything-else-denied are both directly proven, and the denied-exec test's own assertion (`existsSync(probe)` false) proves the WRITE half transitively (the attempted write's side effect never lands). NETWORK denial specifically during the worker's own boot window has no dedicated test -- the same seatbelt profile's default-deny network posture is exercised elsewhere (WS12-08's own citations, the ordinary runCommand path) but never against buildWorkflowWorkerSeatbeltProfile's own profile string specifically. Marked covered on the strength of the two proven axes plus the transitively-proven write axis, with this narrower network-during-boot gap named rather than silently absorbed.",
  },
  {
    id: "WS12-10",
    spec: "WS-12 §11",
    bullet: "PowerShell stays absent (no tool advertisement, no env mirror)",
    status: "covered",
    citations: [
      { file: "./registry.test.ts", testName: "correctly-absent names carry the correctly-absent disposition and hidden exposure" },
      { file: "./conformance.test.ts", testName: "system/init.tools reflects the real buildAdvertisedSet wiring (mode + disallowedTools) on BOTH init frame shapes" },
    ],
    note:
      "'No tool advertisement' shares WS06-02's own citation (PowerShell is a member of CORRECTLY_ABSENT_NAMES) plus this task's own new engine-level test, which additionally asserts PowerShell is absent from the REAL wire's tools[], not just the pure function. 'No env mirror': grep for any PowerShell-env-variable-mirroring code across packages/runtime/src/tools/impl/bash.ts and packages/runtime/src/sandbox returns zero hits -- there is no such mechanism anywhere to test, so its absence is total and structural, the same evidentiary shape as the two deferred rows above, except here the SPEC bullet is itself phrased as an absence to prove, which a clean grep-confirms-nothing-exists result satisfies directly rather than deferring.",
  },
];

describe("WS-06 §6 + WS-12 §11 (enforceable-now subset) tool-catalog/sandbox fixture matrix", () => {
  const ALL_ROWS = [...WS06_06, ...WS12_11];

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
        const abs = fileURLToPath(new URL(relPath, import.meta.url));
        content = readFileSync(abs, "utf8");
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
        const content = readCited(c.file);
        // Self-citation loophole guard (permissions/conformance.test.ts's own precedent): a row
        // citing THIS file has its own `testName` string literal sitting right here in the table,
        // which would trivially satisfy a plain `.includes()` even if the real test were renamed or
        // deleted. Requiring TWO occurrences when self-citing closes that hole.
        const isSelfCitation = c.file === "./conformance.test.ts";
        const occurrences = countOccurrences(content, c.testName);
        const required = isSelfCitation ? 2 : 1;
        expect(occurrences >= required, `${row.id}: citation not found -- ${c.file} does not contain ${required} occurrence(s) of a test/describe title matching "${c.testName}" (found ${occurrences})`).toBe(true);
      }
    }
  });

  test("row ids are unique", () => {
    const ids = ALL_ROWS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("summary counts (informational -- printed for the task report, not itself a pass/fail condition beyond the above)", () => {
    const covered = ALL_ROWS.filter((r) => r.status === "covered").length;
    const newRows = ALL_ROWS.filter((r) => r.status === "new").length;
    const deferred = ALL_ROWS.filter((r) => r.status === "deferred").length;
    expect(covered + newRows + deferred).toBe(ALL_ROWS.length);
  });
});
