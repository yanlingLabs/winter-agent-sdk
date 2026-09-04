// Registry spine tests (task-1 brief, Step 1). Deliberately count-independent throughout (WS-06 §6
// obligation 4 / §1.2: "no test may assert '45' or '21' as a constant") -- every assertion below
// checks set MEMBERSHIP or a STRUCTURAL property, never `.length === <N>` against the full catalog.
//
// Test-mutation discipline (see registry.ts's own header): `registerTool`/`replaceExecutor` mutate a
// process-wide singleton that bun's test runner shares across every file in one `bun test`
// invocation (verified empirically before writing this module) -- every mutating test below targets
// an INVENTED, throwaway canonical name (never a real WS-06 entry) and cleans up via
// `unregisterToolForTest` in a `finally`, so no test here can leak state into another file's
// assertions.
import { describe, test, expect, spyOn, afterEach } from "bun:test";
import "./descriptors/index.ts"; // forces every WS-06 §2 stub to register before any test runs
import {
  registerTool,
  replaceExecutor,
  getRegisteredTool,
  listRegisteredTools,
  unregisterToolForTest,
  buildAdvertisedSet,
  buildRegistryToolExecutor,
  registerMcpServerTools,
  unregisterMcpServerTools,
  onRegistryChange,
  createLoadedToolSet,
  resolveDeferral,
  isDeferralActive,
  partitionAdvertisedTools,
  type ToolDescriptor,
  type ToolExecutor,
  type RegistryToolExecutorDeps,
  type DeferralActivation,
  type AdvertisedSetInputs,
} from "./registry.ts";
import { createSessionReadState } from "./read-state.ts";
// Fix round 1, MAJOR item 2: imported (not hand-typed) so the reserved-name test below is a real
// drift tripwire against mcp/winter-server.ts's own constant -- see registry.ts's own
// RESERVED_MCP_SERVER_NAMES comment for why the import runs in THIS direction only (the reverse
// would be a production-code import cycle; a test-only import here carries no such risk).
import { WINTER_SERVER_NAME } from "../mcp/winter-server.ts";

// Every WS-06 §2 name (45 public + §40.46 conditional surfaces + the Winter-only advisor) this task
// is responsible for stubbing. Listed explicitly (not derived from `listRegisteredTools().length`)
// so "stub-complete" is checked against the SPEC's own enumeration, not against whatever this
// module happens to already contain -- a genuine coverage assertion, not a tautology.
const CORRECTLY_ABSENT_NAMES = [
  "Artifact",
  "EndConversation",
  "PowerShell",
  "RemoteTrigger",
  "SendFeedback",
  "Projects",
  "ClaudeDesign",
  "ShowOnboardingRolePicker",
] as const;

const OTHER_WS06_NAMES = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "ListAgents",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "LSP",
  "Monitor",
  "NotebookEdit",
  "PushNotification",
  "Read",
  "ReportFindings",
  "ScheduleWakeup",
  "SendMessage",
  "SendUserFile",
  "ShareOnboardingGuide",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskOutput",
  "TaskStop",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
  "REPL",
  "RefreshMcpTools",
  "ReadMcpResourceDirTool",
  "ReadNotifications",
  "ProposeSkills",
  "ProposeGoal",
  "StructuredOutput",
  "mcp__winter__advisor",
] as const;

describe("stub-complete index (hard requirement 1)", () => {
  test("every WS-06 §2 name (including correctly-absent) resolves via getRegisteredTool", () => {
    for (const name of [...CORRECTLY_ABSENT_NAMES, ...OTHER_WS06_NAMES]) {
      expect(getRegisteredTool(name), `expected a stub registered under "${name}"`).toBeDefined();
    }
  });

  test("correctly-absent names carry the correctly-absent disposition and hidden exposure", () => {
    for (const name of CORRECTLY_ABSENT_NAMES) {
      const entry = getRegisteredTool(name);
      expect(entry?.descriptor.disposition).toBe("correctly-absent");
      expect(entry?.descriptor.exposure).toBe("hidden");
    }
  });

  test("a non-absent WS-06 name is never accidentally disposed as correctly-absent", () => {
    for (const name of OTHER_WS06_NAMES) {
      expect(getRegisteredTool(name)?.descriptor.disposition).not.toBe("correctly-absent");
    }
  });

  test("no lane may edit the index: registerTool throws on a duplicate canonicalName", () => {
    const name = "__t1_test_duplicate__";
    const descriptor = fixtureDescriptor(name);
    registerTool({ descriptor });
    try {
      expect(() => registerTool({ descriptor })).toThrow();
    } finally {
      unregisterToolForTest(name);
    }
  });

  test("replaceExecutor refuses to create a fresh entry -- a stub must exist first", () => {
    expect(() => replaceExecutor("__t1_test_never_registered__", { async execute() { return { output: "" }; } })).toThrow();
  });
});

describe("§1.3 exposure vs. permission are independent axes", () => {
  test("an eager tool may still require mandatory interaction (AskUserQuestion: eager + interaction)", () => {
    const entry = getRegisteredTool("AskUserQuestion");
    expect(entry?.descriptor.exposure).toBe("eager");
    expect(entry?.descriptor.permissionClass).toBe("interaction");
  });

  test("the type system permits every {exposure} x {permissionClass} combination -- nothing on\n      ToolDescriptor correlates the two fields", () => {
    // A deliberately synthetic combination no real WS-06 tool uses today (deferred exposure is
    // WS-09/ToolSearch's own future assignment, not something this phase names by tool) -- proves
    // "a deferred tool may already be pre-approved" is representable, not merely that today's
    // fixed 56 stubs happen not to need it yet.
    const deferredAndPreapprovable = fixtureDescriptor("__t1_test_deferred__", { exposure: "deferred", permissionClass: "read" });
    const eagerAndInteractive = fixtureDescriptor("__t1_test_eager__", { exposure: "eager", permissionClass: "interaction" });
    expect(deferredAndPreapprovable.exposure).toBe("deferred");
    expect(deferredAndPreapprovable.permissionClass).toBe("read");
    expect(eagerAndInteractive.exposure).toBe("eager");
    expect(eagerAndInteractive.permissionClass).toBe("interaction");
  });
});

describe("availability predicates are declarative data (hard requirement 6)", () => {
  test("every registered descriptor's availability is JSON-serializable (no closures)", () => {
    for (const { descriptor } of listRegisteredTools()) {
      const json = JSON.stringify(descriptor.availability);
      expect(typeof json).toBe("string");
      // A function silently serializes to `undefined` under JSON.stringify inside an object graph
      // rather than throwing -- explicitly walk the own keys to catch that failure mode instead of
      // trusting a successful stringify alone.
      for (const value of Object.values(descriptor.availability)) {
        expect(typeof value).not.toBe("function");
      }
    }
  });
});

describe("the four sets are never collapsed", () => {
  test("the internal catalog (Set 1/3 superset) is a strict superset of any one session's advertised set (Set 2)", () => {
    const catalog = listRegisteredTools().map((t) => t.descriptor.canonicalName);
    const advertised = buildAdvertisedSet({ mode: "default" }).map((d) => d.canonicalName);
    // Membership, not counts: every advertised name is in the catalog...
    for (const name of advertised) expect(catalog).toContain(name);
    // ...and at least one catalog name (a correctly-absent one) is never in ANY advertised set.
    for (const name of CORRECTLY_ABSENT_NAMES) expect(advertised).not.toContain(name);
  });

  test("a gated implement-later/winter-backed-later tool is excluded until its capability is supplied, and included once it is", () => {
    const withoutCapability = buildAdvertisedSet({ mode: "default" }).map((d) => d.canonicalName);
    expect(withoutCapability).not.toContain("REPL");
    const withCapability = buildAdvertisedSet({ mode: "default", capabilities: ["winter.repl-backend"] }).map((d) => d.canonicalName);
    expect(withCapability).toContain("REPL");
  });
});

describe("buildAdvertisedSet §1.5 pipeline", () => {
  test("allowedTools is pre-approval, NOT a visibility allowlist -- it never shrinks the advertised set", () => {
    const withoutAllowedTools = buildAdvertisedSet({ mode: "default" }).map((d) => d.canonicalName);
    const withAllowedTools = buildAdvertisedSet({ mode: "default", allowedTools: ["Read"] }).map((d) => d.canonicalName);
    expect(withAllowedTools).toEqual(withoutAllowedTools);
    // Read is visible either way -- allowedTools naming only Read did not hide Edit/Bash/etc.
    expect(withAllowedTools).toContain("Edit");
  });

  test("a bare disallowedTools entry removes the schema", () => {
    const advertised = buildAdvertisedSet({ mode: "default", disallowedTools: ["Bash"] }).map((d) => d.canonicalName);
    expect(advertised).not.toContain("Bash");
  });

  test("a wildcard-all disallowedTools entry (Tool(*)) is bare-equivalent and also removes the schema", () => {
    const advertised = buildAdvertisedSet({ mode: "default", disallowedTools: ["Bash(*)"] }).map((d) => d.canonicalName);
    expect(advertised).not.toContain("Bash");
  });

  test("a SCOPED disallowedTools entry leaves the schema visible", () => {
    const advertised = buildAdvertisedSet({ mode: "default", disallowedTools: ["Bash(rm:*)"] }).map((d) => d.canonicalName);
    expect(advertised).toContain("Bash");
  });

  test("`tools` is an explicit allowlist by canonical name (distinct from allowedTools)", () => {
    const advertised = buildAdvertisedSet({ mode: "default", tools: ["Read", "Edit"] }).map((d) => d.canonicalName);
    expect(advertised.sort()).toEqual(["Edit", "Read"]);
  });

  test("mode gates a task-graph tool via the R3-4 seam (hiddenWhenFamilyTaskNative)", () => {
    const shownByDefault = buildAdvertisedSet({ mode: "default" }).map((d) => d.canonicalName);
    expect(shownByDefault).toContain("TaskCreate");
    const hiddenForTaskNativeFamily = buildAdvertisedSet({ mode: "default", familyMetadata: { taskNative: true } }).map((d) => d.canonicalName);
    expect(hiddenForTaskNativeFamily).not.toContain("TaskCreate");
  });

  test("TodoWrite is additionally gated behind its own feature flag, on top of the family gate", () => {
    const withoutFlag = buildAdvertisedSet({ mode: "default" }).map((d) => d.canonicalName);
    expect(withoutFlag).not.toContain("TodoWrite");
    const withFlag = buildAdvertisedSet({ mode: "default", features: { todoWrite: true } }).map((d) => d.canonicalName);
    expect(withFlag).toContain("TodoWrite");
  });

  test("WaitForMcpServers is advertised only when ToolSearch is disabled AND its capability token is present", () => {
    // I4 fix-up (fix wave, P3 close-out): WaitForMcpServers fell OUTSIDE I4's original
    // executorless-descriptor scan (its gate is `availability.requiresToolSearchDisabled`, not an
    // empty `capabilityRequirements`), so it was never advertised only by accident -- `toolSearchEnabled`
    // had no RuntimeConfig wiring at all until Part B item 1 landed, so the `toolSearchOff` branch below
    // was dead code until then. Now that a host CAN set toolSearchEnabled: false, the availability gate
    // alone is no longer sufficient; `capabilityRequirements: ["winter.mcp"]` (this fix, mirroring the
    // other four MCP-family tools) is what actually keeps it from reappearing with no executor.
    const toolSearchOn = buildAdvertisedSet({ mode: "default", toolSearchEnabled: true, capabilities: ["winter.mcp"] }).map((d) => d.canonicalName);
    expect(toolSearchOn).not.toContain("WaitForMcpServers");
    const toolSearchOffNoCapability = buildAdvertisedSet({ mode: "default", toolSearchEnabled: false }).map((d) => d.canonicalName);
    expect(toolSearchOffNoCapability).not.toContain("WaitForMcpServers");
    const toolSearchOffWithCapability = buildAdvertisedSet({ mode: "default", toolSearchEnabled: false, capabilities: ["winter.mcp"] }).map(
      (d) => d.canonicalName,
    );
    expect(toolSearchOffWithCapability).toContain("WaitForMcpServers");
  });

  test("AskUserQuestion is unavailable inside a subagent", () => {
    const topLevel = buildAdvertisedSet({ mode: "default" }).map((d) => d.canonicalName);
    expect(topLevel).toContain("AskUserQuestion");
    const inSubagent = buildAdvertisedSet({ mode: "default", insideSubagent: true }).map((d) => d.canonicalName);
    expect(inSubagent).not.toContain("AskUserQuestion");
  });

  // Fix round 1 (reviewer item 3): the two AvailabilityPredicate axes no real WS-06 §2 descriptor
  // currently uses (modes, platforms) -- same synthetic-fixture pattern as the deferred+read
  // combination above (§1.3's own describe block), registered/torn down like the real-executor
  // tests below rather than checked as a bare descriptor-field assertion, since the thing actually
  // under test is buildAdvertisedSet's OWN gating logic (isAvailable), not just that the field exists.
  test("AvailabilityPredicate.modes gates a descriptor to specific permission modes (synthetic -- no real WS-06 tool uses this axis yet)", () => {
    const name = "__t1_test_modes_gate__";
    registerTool({ descriptor: fixtureDescriptor(name, { availability: { modes: ["plan"] } }) });
    try {
      const inPlan = buildAdvertisedSet({ mode: "plan" }).map((d) => d.canonicalName);
      expect(inPlan).toContain(name);
      const inDefault = buildAdvertisedSet({ mode: "default" }).map((d) => d.canonicalName);
      expect(inDefault).not.toContain(name);
    } finally {
      unregisterToolForTest(name);
    }
  });

  test("AvailabilityPredicate.platforms gates a descriptor to specific NodeJS platforms (synthetic -- no real WS-06 tool uses this axis yet)", () => {
    const name = "__t1_test_platforms_gate__";
    registerTool({ descriptor: fixtureDescriptor(name, { availability: { platforms: ["darwin"] } }) });
    try {
      const onDarwin = buildAdvertisedSet({ mode: "default", platform: "darwin" }).map((d) => d.canonicalName);
      expect(onDarwin).toContain(name);
      const onLinux = buildAdvertisedSet({ mode: "default", platform: "linux" }).map((d) => d.canonicalName);
      expect(onLinux).not.toContain(name);
      // cfg.platform OMITTED entirely -- isAvailable's own guard (`cfg.platform !== undefined`) means
      // an unspecified platform never excludes a platform-gated descriptor (§1.5: no resolved value
      // for an axis is "not restricted by it," never treated as a non-match).
      const platformUnspecified = buildAdvertisedSet({ mode: "default" }).map((d) => d.canonicalName);
      expect(platformUnspecified).toContain(name);
    } finally {
      unregisterToolForTest(name);
    }
  });

  test("correctly-absent names are excluded regardless of every other input", () => {
    const maximallyPermissive = buildAdvertisedSet({
      mode: "bypassPermissions",
      capabilities: ["pwsh", "claude.ai-hosting", "winter.repl-backend", "winter.file-delivery-transport", "winter.onboarding-guide-backend"],
      features: { todoWrite: true },
      familyMetadata: { taskNative: false },
      toolSearchEnabled: false,
      tools: [...CORRECTLY_ABSENT_NAMES],
    }).map((d) => d.canonicalName);
    for (const name of CORRECTLY_ABSENT_NAMES) expect(maximallyPermissive).not.toContain(name);
  });
});

describe("buildRegistryToolExecutor (the engine-facing adapter)", () => {
  function deps(overrides?: Partial<RegistryToolExecutorDeps>): RegistryToolExecutorDeps {
    return {
      sessionId: "test-session",
      home: "/home/test",
      getCwd: () => "/work",
      probeReadAccess: () => "silent",
      emitFrame: () => {},
      sandboxSettings: {},
      session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
      readState: createSessionReadState(),
      getTempDir: () => {
        throw new Error("getTempDir should never be invoked by a stub/unregistered-name dispatch in this suite");
      },
      ...overrides,
    };
  }

  test("an unknown tool name resolves to a distinct, non-throwing error result", async () => {
    const executor = buildRegistryToolExecutor(deps());
    const result = await executor.execute({ id: "1", name: "__t1_test_totally_unknown__", input: {} });
    expect(result.output).toContain("unknown tool");
  });

  test("a correctly-absent name resolves to a DISTINCT error result from an unknown name", async () => {
    const executor = buildRegistryToolExecutor(deps());
    const result = await executor.execute({ id: "1", name: "EndConversation", input: {} });
    expect(result.output).toContain("correctly absent");
    expect(result.output).not.toContain("unknown tool");
  });

  test("an implement-now stub with no executor yet resolves to a DISTINCT not-yet-executable result", async () => {
    // Fix round 1 (reviewer item 1): a THROWAWAY name, never "Read" -- once a later lane's own
    // replaceExecutor("Read", ...) lands (Lane B), "Read" is no longer a no-executor stub, and this
    // assertion would start failing for a reason that has nothing to do with T1's own adapter logic.
    const name = "__t1_test_not_yet_executable__";
    registerTool({ descriptor: fixtureDescriptor(name) });
    try {
      const executor = buildRegistryToolExecutor(deps());
      const result = await executor.execute({ id: "1", name, input: {} });
      expect(result.output).toContain("not yet executable");
      expect(result.output).not.toContain("unknown tool");
      expect(result.output).not.toContain("correctly absent");
    } finally {
      unregisterToolForTest(name);
    }
  });

  test("none of the three stub-path results ever throws", async () => {
    // Fix round 1 (reviewer item 1): same throwaway-name swap as above, for the not-yet-executable
    // leg only -- the EndConversation (correctly-absent) and "__nope__" (unknown) legs are real/
    // invented names already immune to a future lane landing a real executor, and stay as-is.
    const notYetExecutableName = "__t1_test_stub_no_throw__";
    registerTool({ descriptor: fixtureDescriptor(notYetExecutableName) });
    try {
      const executor = buildRegistryToolExecutor(deps());
      await expect(executor.execute({ id: "1", name: "__nope__", input: {} })).resolves.toBeDefined();
      await expect(executor.execute({ id: "1", name: "EndConversation", input: {} })).resolves.toBeDefined();
      await expect(executor.execute({ id: "1", name: notYetExecutableName, input: {} })).resolves.toBeDefined();
    } finally {
      unregisterToolForTest(notYetExecutableName);
    }
  });

  test("a real executor receives a fully-populated ToolExecutionContext, and getTempDir stays lazy unless read", async () => {
    const name = "__t1_test_real_executor__";
    const descriptor = fixtureDescriptor(name);
    registerTool({ descriptor });
    try {
      let capturedCwd: string | undefined;
      const echoExecutor: ToolExecutor = {
        async execute(input, ctx) {
          capturedCwd = ctx.cwd;
          return { output: `${name}:${JSON.stringify(input)}` };
        },
      };
      replaceExecutor(name, echoExecutor);
      const executor = buildRegistryToolExecutor(deps({ getCwd: () => "/from-deps" }));
      const result = await executor.execute({ id: "1", name, input: { probe: true } });
      expect(result.output).toBe(`${name}:{"probe":true}`);
      expect(capturedCwd).toBe("/from-deps");
    } finally {
      unregisterToolForTest(name);
    }
  });

  // Phase 4 Task 3 (MUST 5): insideSubagent/isolationPinnedCwd/agentId thread from deps straight
  // onto ctx -- absent deps fields default to `false`/`undefined`, matching this whole codebase's
  // "absent means not known-true" convention for RuntimeConfig.insideSubagent's own sibling field.
  test("insideSubagent/isolationPinnedCwd/agentId thread from deps onto ctx; absent deps default to false/undefined", async () => {
    const name = "__t3_test_child_ctx_fields__";
    registerTool({ descriptor: fixtureDescriptor(name) });
    try {
      let captured: { insideSubagent: boolean | undefined; isolationPinnedCwd: boolean | undefined; agentId: string | undefined } | undefined;
      const echoExecutor: ToolExecutor = {
        async execute(_input, ctx) {
          captured = { insideSubagent: ctx.insideSubagent, isolationPinnedCwd: ctx.isolationPinnedCwd, agentId: ctx.agentId };
          return { output: "ok" };
        },
      };
      replaceExecutor(name, echoExecutor);

      await buildRegistryToolExecutor(deps()).execute({ id: "1", name, input: {} });
      expect(captured).toEqual({ insideSubagent: false, isolationPinnedCwd: false, agentId: undefined });

      await buildRegistryToolExecutor(deps({ insideSubagent: true, isolationPinnedCwd: true, agentId: "agent-xyz" })).execute({ id: "2", name, input: {} });
      expect(captured).toEqual({ insideSubagent: true, isolationPinnedCwd: true, agentId: "agent-xyz" });
    } finally {
      unregisterToolForTest(name);
    }
  });

  test("session.spawnChild, when the deps' session object supplies it, is reachable from a real executor", async () => {
    const name = "__t3_test_spawn_seam__";
    registerTool({ descriptor: fixtureDescriptor(name) });
    try {
      let spawnCalledWithPrompt: string | undefined;
      const spawningExecutor: ToolExecutor = {
        async execute(_input, ctx) {
          const handle = await ctx.session.spawnChild?.({ parentToolUseId: "t1", prompt: "do it", runInBackground: false });
          return { output: handle ? "spawned" : "no-spawn-seam" };
        },
      };
      replaceExecutor(name, spawningExecutor);
      const session = deps().session;
      const executor = buildRegistryToolExecutor(
        deps({
          session: {
            ...session,
            async spawnChild(req) {
              spawnCalledWithPrompt = req.prompt;
              return {
                record: {
                  id: "a1",
                  parentSessionId: "p1",
                  parentToolUseId: req.parentToolUseId,
                  transcript: "subagents/agent-a1.jsonl",
                  status: "running",
                  runtime: "winter-agent",
                  model: { effectiveModel: "sonnet", effectiveEffort: "medium" },
                  permission: { effectiveMode: "default", parentPolicyHash: "h", parentPolicyVersion: 1 },
                },
                status: () => "running",
                steer: async () => ({ status: "queued", messageId: "m1" }),
                resume: async () => ({ status: "resumed_and_delivered", messageId: "m1" }),
                result: async () => ({ status: "completed", content: "done" }),
                stop: async () => {},
              };
            },
          },
        }),
      );
      const result = await executor.execute({ id: "1", name, input: {} });
      expect(result.output).toBe("spawned");
      expect(spawnCalledWithPrompt).toBe("do it");
    } finally {
      unregisterToolForTest(name);
    }
  });

  test("a real executor that actually reads ctx.tempDir DOES trigger getTempDir (laziness proof, positive half)", async () => {
    const name = "__t1_test_tempdir_reader__";
    registerTool({ descriptor: fixtureDescriptor(name) });
    try {
      let getTempDirCalls = 0;
      const readsTempDir: ToolExecutor = {
        async execute(_input, ctx) {
          return { output: ctx.tempDir };
        },
      };
      replaceExecutor(name, readsTempDir);
      const executor = buildRegistryToolExecutor(
        deps({
          getTempDir: () => {
            getTempDirCalls++;
            return "/lazy/temp/root";
          },
        }),
      );
      const result = await executor.execute({ id: "1", name, input: {} });
      expect(result.output).toBe("/lazy/temp/root");
      expect(getTempDirCalls).toBe(1);
    } finally {
      unregisterToolForTest(name);
    }
  });
});

// Phase 4 Task 2: live MCP server registration (WS-09 §1.3/§2.1/§3/§4/§6). Throwaway server name
// distinct from seam-contracts-p4.test.ts's own ("t2seamsrv") -- see registry.ts's own header on why
// the registry is a shared, process-wide singleton across every file in one `bun test` invocation.
describe("registerMcpServerTools / unregisterMcpServerTools (Phase 4 Task 2, WS-09 §1.3/§2.1/§3)", () => {
  const SRV = "t2regsrv";

  test("names tools mcp__<server>__<tool>, defaults description, and gates on winter.mcp", () => {
    try {
      registerMcpServerTools(SRV, [{ name: "foo", inputSchema: { type: "object" } }], { deferredDefault: false });
      const entry = getRegisteredTool(`mcp__${SRV}__foo`);
      expect(entry).toBeDefined();
      expect(entry?.descriptor.source).toBe("mcp");
      expect(entry?.descriptor.permissionClass).toBe("mcp");
      expect(entry?.descriptor.description).toBe("");
      expect(entry?.descriptor.capabilityRequirements).toEqual(["winter.mcp"]);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("annotations pass through verbatim, including fields beyond the three WS-09 §4 names", () => {
    try {
      registerMcpServerTools(
        SRV,
        [{ name: "foo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, idempotentHint: true, title: "Foo" } }],
        { deferredDefault: false },
      );
      const entry = getRegisteredTool(`mcp__${SRV}__foo`);
      expect(entry?.descriptor.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, title: "Foo" });
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("_meta round-trips verbatim, including the anthropic/ key literal, and derives interaction", () => {
    try {
      registerMcpServerTools(
        SRV,
        [
          { name: "needs-interaction", inputSchema: { type: "object" }, _meta: { "anthropic/requiresUserInteraction": true, "anthropic/alwaysLoad": true } },
          { name: "sibling-only", inputSchema: { type: "object" }, _meta: { "anthropic/alwaysLoad": true } },
        ],
        { deferredDefault: false },
      );
      const withInteraction = getRegisteredTool(`mcp__${SRV}__needs-interaction`);
      expect(withInteraction?.descriptor._meta).toEqual({ "anthropic/requiresUserInteraction": true, "anthropic/alwaysLoad": true });
      expect(withInteraction?.descriptor.interaction).toBe("required");

      // Negative: a SIBLING anthropic/-namespaced key round-trips in `_meta` but does NOT itself set
      // `interaction` -- only the exact `anthropic/requiresUserInteraction === true` key/value does.
      const siblingOnly = getRegisteredTool(`mcp__${SRV}__sibling-only`);
      expect(siblingOnly?.descriptor._meta).toEqual({ "anthropic/alwaysLoad": true });
      expect(siblingOnly?.descriptor.interaction).toBeUndefined();
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("alwaysLoad and deferredDefault (incl. a Mode[] form) populate the descriptor verbatim", () => {
    try {
      registerMcpServerTools(SRV, [{ name: "foo", inputSchema: { type: "object" } }], { alwaysLoad: true, deferredDefault: ["plan", "auto"] });
      const entry = getRegisteredTool(`mcp__${SRV}__foo`);
      expect(entry?.descriptor.alwaysLoad).toBe(true);
      expect(entry?.descriptor.deferred).toEqual(["plan", "auto"]);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("re-registering the SAME server replaces the descriptor but preserves an already-wired executor", () => {
    try {
      registerMcpServerTools(SRV, [{ name: "foo", description: "v1", inputSchema: { type: "object" } }], { deferredDefault: false });
      const echo: ToolExecutor = { async execute(input) { return { output: JSON.stringify(input) }; } };
      replaceExecutor(`mcp__${SRV}__foo`, echo);

      registerMcpServerTools(SRV, [{ name: "foo", description: "v2", inputSchema: { type: "object" } }], { deferredDefault: false });
      const entry = getRegisteredTool(`mcp__${SRV}__foo`);
      expect(entry?.descriptor.description).toBe("v2");
      expect(entry?.executor).toBe(echo); // preserved across the same-server replace, not wiped
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("set-replace: re-registering with a shrunk tool list drops the tool that disappeared", () => {
    try {
      registerMcpServerTools(SRV, [{ name: "foo", inputSchema: { type: "object" } }, { name: "bar", inputSchema: { type: "object" } }], {
        deferredDefault: false,
      });
      expect(getRegisteredTool(`mcp__${SRV}__foo`)).toBeDefined();
      expect(getRegisteredTool(`mcp__${SRV}__bar`)).toBeDefined();

      registerMcpServerTools(SRV, [{ name: "foo", inputSchema: { type: "object" } }], { deferredDefault: false });
      expect(getRegisteredTool(`mcp__${SRV}__foo`)).toBeDefined();
      expect(getRegisteredTool(`mcp__${SRV}__bar`)).toBeUndefined(); // dropped -- no longer in the new list
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("registerMcpServerTools(server, []) is equivalent to unregisterMcpServerTools(server)", () => {
    registerMcpServerTools(SRV, [{ name: "foo", inputSchema: { type: "object" } }], { deferredDefault: false });
    expect(getRegisteredTool(`mcp__${SRV}__foo`)).toBeDefined();
    registerMcpServerTools(SRV, [], { deferredDefault: false });
    expect(getRegisteredTool(`mcp__${SRV}__foo`)).toBeUndefined();
  });

  test("colliding with a name registered by a non-live-MCP mechanism throws rather than overwriting", () => {
    // A static stub (registerTool, not registerMcpServerTools) sitting under the EXACT canonical
    // name a live registration would compute -- mirrors the real mcp__winter__advisor collision
    // this section's own header warns about (winter-server.ts avoids it by never calling
    // registerMcpServerTools for advisor at all; this proves the guard fires if something ever did).
    const collideServer = "t2collideserver";
    const toolName = "collidetool";
    const canonicalName = `mcp__${collideServer}__${toolName}`;
    registerTool({ descriptor: fixtureDescriptor(canonicalName) });
    try {
      expect(() => registerMcpServerTools(collideServer, [{ name: toolName, inputSchema: { type: "object" } }], { deferredDefault: false })).toThrow();
      // The throw must not have silently overwritten the static stub.
      expect(getRegisteredTool(canonicalName)?.descriptor.source).toBe("builtin");
    } finally {
      unregisterToolForTest(canonicalName);
      unregisterMcpServerTools(collideServer); // defensive no-op: the throw prevented any real ownership
    }
  });

  test("a MID-BATCH collision leaves the registry byte-identical to before the call (VALIDATE-THEN-COMMIT, fix round 1 MAJOR item 1)", () => {
    const collideServer = "t2atomiccollide";
    const dCanonical = `mcp__${collideServer}__d`;
    registerTool({ descriptor: fixtureDescriptor(dCanonical) }); // a foreign, non-live stub "d" will collide with
    try {
      registerMcpServerTools(collideServer, [{ name: "a", inputSchema: { type: "object" } }, { name: "b", inputSchema: { type: "object" } }], {
        deferredDefault: false,
      });
      expect(getRegisteredTool(`mcp__${collideServer}__a`)).toBeDefined();
      expect(getRegisteredTool(`mcp__${collideServer}__b`)).toBeDefined();

      // [a, c, d]: "a" would be re-affirmed, "c" newly inserted, and "d" collides with the foreign
      // stub above -- under the OLD mutate-as-you-go implementation, "b" (owned before, absent from
      // this new list) was already deleted and "c" already inserted by the time the throw on "d"
      // fired, leaving mcpServerOwnedNames stale in both directions.
      expect(() =>
        registerMcpServerTools(
          collideServer,
          [
            { name: "a", inputSchema: { type: "object" } },
            { name: "c", inputSchema: { type: "object" } },
            { name: "d", inputSchema: { type: "object" } },
          ],
          { deferredDefault: false },
        ),
      ).toThrow();

      // Byte-identical to before the failed call: "a" and "b" untouched, "c" never created.
      expect(getRegisteredTool(`mcp__${collideServer}__a`)).toBeDefined();
      expect(getRegisteredTool(`mcp__${collideServer}__b`)).toBeDefined();
      expect(getRegisteredTool(`mcp__${collideServer}__c`)).toBeUndefined();

      // A subsequent unregister removes EXACTLY "a" and "b" -- the old bug left "b" already deleted
      // but still listed as owned (a harmless double-delete) while a would-be-inserted "c" would be
      // live in the registry but NOT listed as owned: permanently unreachable via unregister.
      unregisterMcpServerTools(collideServer);
      expect(getRegisteredTool(`mcp__${collideServer}__a`)).toBeUndefined();
      expect(getRegisteredTool(`mcp__${collideServer}__b`)).toBeUndefined();
    } finally {
      unregisterToolForTest(dCanonical);
      unregisterMcpServerTools(collideServer); // defensive no-op if the assertions above already cleaned up
    }
  });

  test('RULING P4-B: "winter" is a RESERVED server name -- even a brand-new tool name that collides with nothing throws (fix round 1 MAJOR item 2)', () => {
    // "browser" has never been registered under ANY mechanism -- the ordinary per-name collision
    // check (registry.has(canonicalName)) would NOT fire for it; only the reserved-name guard does.
    expect(() =>
      registerMcpServerTools(WINTER_SERVER_NAME, [{ name: "browser", inputSchema: { type: "object" } }], { deferredDefault: false }),
    ).toThrow();
    expect(getRegisteredTool(`mcp__${WINTER_SERVER_NAME}__browser`)).toBeUndefined(); // never created
  });

  test('the reserved-name guard is exact-match only -- "Winter"/"WINTER" are NOT reserved (documented choice, fix round 1 MAJOR item 2)', () => {
    try {
      expect(() =>
        registerMcpServerTools("Winter", [{ name: "browser", inputSchema: { type: "object" } }], { deferredDefault: false }),
      ).not.toThrow();
      expect(getRegisteredTool("mcp__Winter__browser")).toBeDefined();
    } finally {
      unregisterMcpServerTools("Winter");
    }
  });

  test("registerMcpServerTools(neverSeenServer, []) is a silent no-op, symmetric with unregisterMcpServerTools (fix round 1 NIT item 4)", () => {
    let calls = 0;
    const unsubscribe = onRegistryChange(() => {
      calls++;
    });
    try {
      expect(() => registerMcpServerTools("__t2_never_seen_empty__", [], { deferredDefault: false })).not.toThrow();
      expect(calls).toBe(0); // no notification fired -- nothing changed
    } finally {
      unsubscribe();
      unregisterMcpServerTools("__t2_never_seen_empty__"); // defensive; also expected to be a no-op
    }
  });

  test("unregisterMcpServerTools is idempotent for a server that was never (or is no longer) registered", () => {
    expect(() => unregisterMcpServerTools("__t2_never_registered_server__")).not.toThrow();
  });

  test("onRegistryChange fires exactly once per call (N tools -> 1 notification), and unsubscribe stops delivery", () => {
    let calls = 0;
    const unsubscribe = onRegistryChange(() => {
      calls++;
    });
    try {
      registerMcpServerTools(SRV, [{ name: "foo", inputSchema: { type: "object" } }, { name: "bar", inputSchema: { type: "object" } }], {
        deferredDefault: false,
      });
      expect(calls).toBe(1);
      unregisterMcpServerTools(SRV);
      expect(calls).toBe(2);
      unsubscribe();
      registerMcpServerTools(SRV, [{ name: "foo", inputSchema: { type: "object" } }], { deferredDefault: false });
      expect(calls).toBe(2); // unsubscribed -- no further delivery
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("a throwing onRegistryChange listener does not prevent a sibling listener from firing", () => {
    // Expected, swallowed-and-logged console.error (registry.ts's own notifyRegistryChange) --
    // spied and silenced per this codebase's established query.test.ts precedent, not left to print.
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    let goodCalls = 0;
    const unsubBad = onRegistryChange(() => {
      throw new Error("boom");
    });
    const unsubGood = onRegistryChange(() => {
      goodCalls++;
    });
    try {
      expect(() => registerMcpServerTools(SRV, [{ name: "foo", inputSchema: { type: "object" } }], { deferredDefault: false })).not.toThrow();
      expect(goodCalls).toBe(1);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      unsubBad();
      unsubGood();
      unregisterMcpServerTools(SRV);
      errSpy.mockRestore();
    }
  });

  test("registration ↔ advertised set: a newly registered tool appears only once winter.mcp is supplied", () => {
    try {
      registerMcpServerTools(SRV, [{ name: "foo", inputSchema: { type: "object" } }], { deferredDefault: false });
      const withoutCapability = buildAdvertisedSet({ mode: "default" }).map((d) => d.canonicalName);
      expect(withoutCapability).not.toContain(`mcp__${SRV}__foo`);
      const withCapability = buildAdvertisedSet({ mode: "default", capabilities: ["winter.mcp"] }).map((d) => d.canonicalName);
      expect(withCapability).toContain(`mcp__${SRV}__foo`);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("unregistration removes the tool from the advertised set immediately", () => {
    registerMcpServerTools(SRV, [{ name: "foo", inputSchema: { type: "object" } }], { deferredDefault: false });
    expect(buildAdvertisedSet({ mode: "default", capabilities: ["winter.mcp"] }).map((d) => d.canonicalName)).toContain(`mcp__${SRV}__foo`);
    unregisterMcpServerTools(SRV);
    expect(buildAdvertisedSet({ mode: "default", capabilities: ["winter.mcp"] }).map((d) => d.canonicalName)).not.toContain(`mcp__${SRV}__foo`);
  });
});

describe("LoadedToolSet (Phase 4 Task 2, WS-09 §8.5)", () => {
  test("isLoaded/load/snapshot: a name is loaded only after load(), and load partitions by registry existence", () => {
    const set = createLoadedToolSet();
    expect(set.isLoaded("Read")).toBe(false);
    const result = set.load(["Read", "__t2_totally_unknown_tool__"]);
    expect(result.loaded).toEqual(["Read"]);
    expect(result.unknown).toEqual(["__t2_totally_unknown_tool__"]);
    expect(set.isLoaded("Read")).toBe(true);
    expect(set.snapshot()).toEqual(["Read"]);
  });

  test("load is idempotent -- loading the same name twice does not duplicate it in the snapshot", () => {
    const set = createLoadedToolSet();
    set.load(["Read"]);
    set.load(["Read"]);
    expect(set.snapshot()).toEqual(["Read"]);
  });

  test("reset(evidenced) is an INTERSECTION: drops non-evidenced names, never adds a never-loaded one", () => {
    const set = createLoadedToolSet();
    set.load(["Read", "Edit"]);
    set.reset(["Read", "Grep"]); // Grep was never loaded -- must NOT appear afterward
    expect(set.snapshot().sort()).toEqual(["Read"]);
    expect(set.isLoaded("Edit")).toBe(false);
    expect(set.isLoaded("Grep")).toBe(false);
  });

  test("reset([]) drops everything", () => {
    const set = createLoadedToolSet();
    set.load(["Read", "Edit"]);
    set.reset([]);
    expect(set.snapshot()).toEqual([]);
  });
});

describe("resolveDeferral (Phase 4 Task 2, WS-09 §8.5/§9)", () => {
  const fullActivation: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 100 };

  function mcpDescriptor(overrides?: Partial<ToolDescriptor>): ToolDescriptor {
    return fixtureDescriptor("__t2_resolve_deferral_fixture__", { source: "mcp", ...overrides });
  }

  test("a core builtin is NEVER deferred, even when declared deferred: true and activation is fully on", () => {
    const d = fixtureDescriptor("__t2_builtin_fixture__", { source: "builtin", deferred: true });
    expect(resolveDeferral(d, "default", fullActivation)).toBe("eager");
  });

  test("alwaysLoad: true forces eager regardless of deferred/activation", () => {
    const d = mcpDescriptor({ deferred: true, alwaysLoad: true });
    expect(resolveDeferral(d, "default", fullActivation)).toBe("eager");
  });

  test("exposure: hidden is a floor -- hidden regardless of deferred/activation", () => {
    const d = mcpDescriptor({ deferred: true, exposure: "hidden" });
    expect(resolveDeferral(d, "default", fullActivation)).toBe("hidden");
  });

  test("mode-visibility exclusion (availability.modes) resolves to hidden", () => {
    const d = mcpDescriptor({ deferred: true, availability: { modes: ["plan"] } });
    expect(resolveDeferral(d, "default", fullActivation)).toBe("hidden");
    // Fix round 1, NIT item 6: the in-mode case asserts the EXACT expected value, not merely
    // "anything but hidden" -- `d` is deferred:true under a fully-on activation, so "plan" (a listed
    // mode) must resolve all the way through to "deferred", not just clear the mode-visibility floor.
    expect(resolveDeferral(d, "plan", fullActivation)).toBe("deferred");
  });

  test("deferred absent/false is never eligible -- eager regardless of activation", () => {
    const d = mcpDescriptor({ deferred: false });
    expect(resolveDeferral(d, "default", fullActivation)).toBe("eager");
    const noDeferredField = mcpDescriptor();
    expect(resolveDeferral(noDeferredField, "default", fullActivation)).toBe("eager");
  });

  test("deferred: Mode[] is eligible only in listed modes -- eager (not deferred) outside them", () => {
    const d = mcpDescriptor({ deferred: ["plan"] });
    expect(resolveDeferral(d, "default", fullActivation)).toBe("eager");
    expect(resolveDeferral(d, "plan", fullActivation)).toBe("deferred");
  });

  test("providerSupportsToolSearch: false forces full injection (eager) even when eligible and enableToolSearch: true", () => {
    const d = mcpDescriptor({ deferred: true });
    const activation: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: false, deferrableContextShare: 100 };
    expect(resolveDeferral(d, "default", activation)).toBe("eager");
  });

  test("enableToolSearch: false fully injects (eager) even when eligible", () => {
    const d = mcpDescriptor({ deferred: true });
    const activation: DeferralActivation = { enableToolSearch: "false", providerSupportsToolSearch: true, deferrableContextShare: 100 };
    expect(resolveDeferral(d, "default", activation)).toBe("eager");
  });

  test("enableToolSearch: true forces deferred when eligible, regardless of context share", () => {
    const d = mcpDescriptor({ deferred: true });
    const activation: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 0 };
    expect(resolveDeferral(d, "default", activation)).toBe("deferred");
  });

  test("auto (bare) and unset share the 10% threshold, boundary inclusive (>=)", () => {
    const d = mcpDescriptor({ deferred: true });
    const below: DeferralActivation = { enableToolSearch: "auto", providerSupportsToolSearch: true, deferrableContextShare: 9.9 };
    const atBoundary: DeferralActivation = { enableToolSearch: "auto", providerSupportsToolSearch: true, deferrableContextShare: 10 };
    const above: DeferralActivation = { enableToolSearch: "auto", providerSupportsToolSearch: true, deferrableContextShare: 10.1 };
    expect(resolveDeferral(d, "default", below)).toBe("eager");
    expect(resolveDeferral(d, "default", atBoundary)).toBe("deferred");
    expect(resolveDeferral(d, "default", above)).toBe("deferred");

    const unsetActivation: DeferralActivation = { enableToolSearch: "unset", providerSupportsToolSearch: true, deferrableContextShare: 10 };
    expect(resolveDeferral(d, "default", unsetActivation)).toBe("deferred");
    const unsetBelow: DeferralActivation = { enableToolSearch: "unset", providerSupportsToolSearch: true, deferrableContextShare: 9.9 };
    expect(resolveDeferral(d, "default", unsetBelow)).toBe("eager");
  });

  test("auto:N uses the custom percentage threshold instead of the 10% default", () => {
    const d = mcpDescriptor({ deferred: true });
    const activation: DeferralActivation = { enableToolSearch: { auto: 25 }, providerSupportsToolSearch: true, deferrableContextShare: 20 };
    expect(resolveDeferral(d, "default", activation)).toBe("eager"); // below the custom 25% threshold
    const activationAtBoundary: DeferralActivation = { enableToolSearch: { auto: 25 }, providerSupportsToolSearch: true, deferrableContextShare: 25 };
    expect(resolveDeferral(d, "default", activationAtBoundary)).toBe("deferred");
  });
});

// Phase 4 Task 3 (RULING P4-A): isDeferralActive is a pure re-derivation of resolveDeferral's own
// tail (no descriptor-specific floors) -- every one of resolveDeferral's own activation-level
// assertions above must hold here too, by construction, since resolveDeferral now calls this
// function for that exact logic rather than duplicating it.
describe("isDeferralActive (Phase 4 Task 3, RULING P4-A)", () => {
  test("providerSupportsToolSearch: false is never active, regardless of enableToolSearch", () => {
    expect(isDeferralActive({ enableToolSearch: "true", providerSupportsToolSearch: false, deferrableContextShare: 100 })).toBe(false);
  });
  test("enableToolSearch: false is never active", () => {
    expect(isDeferralActive({ enableToolSearch: "false", providerSupportsToolSearch: true, deferrableContextShare: 100 })).toBe(false);
  });
  test("enableToolSearch: true is always active, regardless of context share", () => {
    expect(isDeferralActive({ enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 0 })).toBe(true);
  });
  test("auto/unset share the 10% boundary-inclusive threshold", () => {
    expect(isDeferralActive({ enableToolSearch: "auto", providerSupportsToolSearch: true, deferrableContextShare: 9.9 })).toBe(false);
    expect(isDeferralActive({ enableToolSearch: "auto", providerSupportsToolSearch: true, deferrableContextShare: 10 })).toBe(true);
    expect(isDeferralActive({ enableToolSearch: "unset", providerSupportsToolSearch: true, deferrableContextShare: 10 })).toBe(true);
    expect(isDeferralActive({ enableToolSearch: "unset", providerSupportsToolSearch: true, deferrableContextShare: 9.9 })).toBe(false);
  });
  test("auto:N uses the custom threshold", () => {
    expect(isDeferralActive({ enableToolSearch: { auto: 25 }, providerSupportsToolSearch: true, deferrableContextShare: 20 })).toBe(false);
    expect(isDeferralActive({ enableToolSearch: { auto: 25 }, providerSupportsToolSearch: true, deferrableContextShare: 25 })).toBe(true);
  });

  // The actual "impossible by construction" proof: resolveDeferral's own verdict for ANY eligible
  // descriptor agrees with isDeferralActive on the SAME activation value, across a representative
  // sweep -- these two can never independently disagree because resolveDeferral literally calls this
  // function for its own tail.
  test("resolveDeferral's own verdict for an eligible descriptor always agrees with isDeferralActive on the identical activation", () => {
    const eligible = fixtureDescriptor("__t3_agree_fixture__", { source: "mcp", deferred: true });
    const sweep: DeferralActivation[] = [
      { enableToolSearch: "unset", providerSupportsToolSearch: true, deferrableContextShare: 0 },
      { enableToolSearch: "auto", providerSupportsToolSearch: true, deferrableContextShare: 10 },
      { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 0 },
      { enableToolSearch: "false", providerSupportsToolSearch: true, deferrableContextShare: 100 },
      { enableToolSearch: "true", providerSupportsToolSearch: false, deferrableContextShare: 100 },
      { enableToolSearch: { auto: 40 }, providerSupportsToolSearch: true, deferrableContextShare: 39 },
    ];
    for (const activation of sweep) {
      const verdict = resolveDeferral(eligible, "default", activation);
      expect(verdict === "deferred").toBe(isDeferralActive(activation));
    }
  });
});

// Phase 4 Task 3 (RULING P4-A): partitionAdvertisedTools wires resolveDeferral into
// buildAdvertisedSet's own output -- buildAdvertisedSet itself stays completely unchanged (proven
// separately by every pre-existing test above and the I4 conformance test remaining green).
describe("partitionAdvertisedTools (Phase 4 Task 3, RULING P4-A)", () => {
  const SRV = "t3partition";
  afterEach(() => {
    unregisterMcpServerTools(SRV);
  });

  test("partitions a live-registered deferred MCP tool into `deferred` when Tool Search is active, `eager` when it is not", () => {
    registerMcpServerTools(SRV, [{ name: "search_docs", inputSchema: { type: "object" } }], { deferredDefault: true });
    const cfg: AdvertisedSetInputs = { mode: "default", capabilities: ["winter.mcp"] };

    const active: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 100 };
    const partitionActive = partitionAdvertisedTools(cfg, active);
    expect(partitionActive.deferred.map((d) => d.canonicalName)).toContain(`mcp__${SRV}__search_docs`);
    expect(partitionActive.eager.map((d) => d.canonicalName)).not.toContain(`mcp__${SRV}__search_docs`);

    const inactive: DeferralActivation = { enableToolSearch: "false", providerSupportsToolSearch: true, deferrableContextShare: 100 };
    const partitionInactive = partitionAdvertisedTools(cfg, inactive);
    expect(partitionInactive.eager.map((d) => d.canonicalName)).toContain(`mcp__${SRV}__search_docs`);
    expect(partitionInactive.deferred.map((d) => d.canonicalName)).not.toContain(`mcp__${SRV}__search_docs`);
  });

  test("a descriptor excluded by buildAdvertisedSet's own pipeline (e.g. missing capability token) never appears in ANY partition bucket", () => {
    registerMcpServerTools(SRV, [{ name: "search_docs", inputSchema: { type: "object" } }], { deferredDefault: true });
    const cfgNoCapability: AdvertisedSetInputs = { mode: "default" }; // no "winter.mcp" -- buildAdvertisedSet itself excludes it
    const activation: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 100 };
    const partition = partitionAdvertisedTools(cfgNoCapability, activation);
    const all = [...partition.eager, ...partition.deferred, ...partition.hidden].map((d) => d.canonicalName);
    expect(all).not.toContain(`mcp__${SRV}__search_docs`);
  });

  test("system/init.tools composition (eager + already-loaded deferred) -- the caller's own responsibility, proven here at the seam boundary", () => {
    registerMcpServerTools(SRV, [{ name: "search_docs", inputSchema: { type: "object" } }], { deferredDefault: true });
    const cfg: AdvertisedSetInputs = { mode: "default", capabilities: ["winter.mcp"] };
    const active: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 100 };
    const partition = partitionAdvertisedTools(cfg, active);

    const loadedSet = createLoadedToolSet();
    const beforeLoad = [...partition.eager.map((d) => d.advertisedName)];
    expect(beforeLoad).not.toContain(`mcp__${SRV}__search_docs`); // deferred + not yet loaded -- absent from init.tools

    loadedSet.load([`mcp__${SRV}__search_docs`]);
    const afterLoad = [
      ...partition.eager.map((d) => d.advertisedName),
      ...partition.deferred.filter((d) => loadedSet.isLoaded(d.canonicalName)).map((d) => d.advertisedName),
    ];
    expect(afterLoad).toContain(`mcp__${SRV}__search_docs`); // now present, exactly once
    expect(afterLoad.filter((n) => n === `mcp__${SRV}__search_docs`).length).toBe(1);
  });
});

// A minimal, valid ToolDescriptor for fixture use -- every field the type requires, none of the
// judgment-call comments a real WS-06 file carries (this is throwaway test data, not a spec entry).
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
