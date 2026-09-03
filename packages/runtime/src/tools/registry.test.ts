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
import { describe, test, expect } from "bun:test";
import "./descriptors/index.ts"; // forces every WS-06 §2 stub to register before any test runs
import {
  registerTool,
  replaceExecutor,
  getRegisteredTool,
  listRegisteredTools,
  unregisterToolForTest,
  buildAdvertisedSet,
  buildRegistryToolExecutor,
  type ToolDescriptor,
  type ToolExecutor,
  type RegistryToolExecutorDeps,
} from "./registry.ts";
import { createSessionReadState } from "./read-state.ts";

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
