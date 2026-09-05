// Phase 5 Task 8, rider 21: **a partial wiring must fail LEGIBLY, never silently.**
//
// Lane W's report names the trap precisely: the Workflow tool is inert in three independent ways --
// no barrel import, no session registration, no capability grant -- and "a merge that lands two of
// the three looks like a working feature until someone calls it." Lane S's report names the same
// three for the Skill tool. Six failure modes, each with its own text, none of which any other test
// in this repository asserts.
//
// This file is the ledger for all six. It does NOT re-prove that the wiring works (the equivalence
// suite and each lane's own tests do that); it proves that when a leg is MISSING, the session says
// so in a way a human reading a transcript can act on. That distinction is why every assertion here
// is on the message text or on an explicit capability requirement, never on a boolean.
//
// LEG 1 is proved in a FRESH SUBPROCESS on purpose. This test file, like every sibling, transitively
// imports the real executors, so an in-process check could never observe the barrel's absence -- the
// very reason the gap survived four lanes. The probe imports only what a live session imports.
import { describe, test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { getRegisteredTool, buildAdvertisedSet, resolveSessionCapabilities } from "../registry.ts";
import "./index.ts";
import { resetWorkflowSessionForTest } from "../../workflows/host-registry.ts";
import { clearSkillSessionRuntime } from "../../skills/runtime.ts";
import type { ToolExecutionContext } from "../registry.ts";

const BARREL = fileURLToPath(new URL("./index.ts", import.meta.url));
const REGISTRY = fileURLToPath(new URL("../registry.ts", import.meta.url));

function freshProcessProbe(expression: string): string {
  const probe = [
    `await import(${JSON.stringify(BARREL)});`,
    `const { getRegisteredTool } = await import(${JSON.stringify(REGISTRY)});`,
    `process.stdout.write(String(${expression}));`,
  ].join("\n");
  const result = Bun.spawnSync(["bun", "-e", probe], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`probe failed: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout);
}

// The minimum a tool executor needs to answer a refusal. Deliberately hand-built rather than routed
// through the engine: what is under test is the executor's own no-runtime arm, and an engine run
// would supply the runtime this test exists to take away.
function bareCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: "partial-wiring-s",
    cwd: "/tmp/winter-partial-wiring-fixture",
    toolUseId: "partial-wiring-call-1",
    ...overrides,
  } as unknown as ToolExecutionContext;
}

describe("rider 21: leg 1 -- the tools/impl barrel installs BOTH P5 executors in a live session", () => {
  // Lane W's own F10 leg-1 fixture asserted `"false"` here and said in its comment: "when T8 adds
  // the barrel import this flips to 'true' and this expectation is what tells them the gap is
  // closed -- the test is the ledger entry, not a permanent invariant." This is that flip, plus its
  // Skill twin, which Lane S had no equivalent fixture for.
  test("a fresh process importing ONLY the barrel finds a real Workflow executor", () => {
    expect(freshProcessProbe(`getRegisteredTool("Workflow")?.executor !== undefined`)).toBe("true");
  });

  test("a fresh process importing ONLY the barrel finds a real Skill executor", () => {
    expect(freshProcessProbe(`getRegisteredTool("Skill")?.executor !== undefined`)).toBe("true");
  });

  test("without the barrel, the descriptors' STUBS answer -- 'registered but not yet executable', the exact silent shape rider 21 is about", () => {
    // The counterfactual, proved rather than asserted in prose: importing the DESCRIPTOR barrel
    // alone (what engine.ts reached before this task) leaves both executors absent.
    const descriptorsOnly = fileURLToPath(new URL("../descriptors/index.ts", import.meta.url));
    const probe = [
      `await import(${JSON.stringify(descriptorsOnly)});`,
      `const { getRegisteredTool } = await import(${JSON.stringify(REGISTRY)});`,
      `process.stdout.write([getRegisteredTool("Workflow")?.executor, getRegisteredTool("Skill")?.executor].map((e) => String(e !== undefined)).join(","));`,
    ].join("\n");
    const result = Bun.spawnSync(["bun", "-e", probe], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe("false,false");
  }, 20_000);
});

describe("rider 21: leg 2 -- with the executor installed but NO session runtime registered, each tool refuses in words", () => {
  test("Workflow names the missing runtime, and does not throw", async () => {
    resetWorkflowSessionForTest();
    const executor = getRegisteredTool("Workflow")?.executor;
    expect(executor).toBeDefined();
    const result = await executor!.execute({ script: "export const meta = { name: 'x', description: 'y' };\nreturn 1;" }, bareCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workflow runtime");
  });

  test("Skill names the missing runtime, and does not throw", async () => {
    clearSkillSessionRuntime("partial-wiring-s");
    const executor = getRegisteredTool("Skill")?.executor;
    expect(executor).toBeDefined();
    const result = await executor!.execute({ skill: "anything" }, bareCtx());
    expect(result.isError).toBe(true);
    expect(result.output.toLowerCase()).toContain("skill");
  });

  test("the two refusals are DISTINGUISHABLE from each other and from a missing-executor stub", async () => {
    resetWorkflowSessionForTest();
    clearSkillSessionRuntime("partial-wiring-s");
    const wf = await getRegisteredTool("Workflow")!.executor!.execute({ script: "export const meta = { name: 'x', description: 'y' };\nreturn 1;" }, bareCtx());
    const sk = await getRegisteredTool("Skill")!.executor!.execute({ skill: "anything" }, bareCtx());
    expect(wf.output).not.toBe(sk.output);
    // The stub's own text, which neither of these may be mistaken for.
    expect(wf.output).not.toContain("not yet executable");
    expect(sk.output).not.toContain("not yet executable");
  });
});

describe("rider 21: leg 3 -- the capability grant, and why it cannot land without leg 1", () => {
  test("both descriptors still REQUIRE their token -- the gate was not removed, it was satisfied", () => {
    expect(getRegisteredTool("Workflow")?.descriptor.capabilityRequirements).toContain("winter.workflows");
    expect(getRegisteredTool("Skill")?.descriptor.capabilityRequirements).toContain("winter.skills");
  });

  test("the tokens are DERIVED from executor presence, so a barrel without them is impossible", () => {
    const capabilities = resolveSessionCapabilities(undefined, { hasMcpServers: false });
    expect(capabilities).toContain("winter.workflows");
    expect(capabilities).toContain("winter.skills");
  });

  test("with the derived tokens, both tools are ADVERTISED in a default session (capture (g): the default 24 include Workflow and Skill)", () => {
    const advertised = buildAdvertisedSet({
      mode: "default",
      capabilities: resolveSessionCapabilities(undefined, { hasMcpServers: false }),
    }).map((d) => d.advertisedName);
    expect(advertised).toContain("Workflow");
    expect(advertised).toContain("Skill");
  });

  test("WITHOUT the tokens neither is advertised -- the silent third failure mode, pinned", () => {
    const advertised = buildAdvertisedSet({ mode: "default", capabilities: [] }).map((d) => d.advertisedName);
    expect(advertised).not.toContain("Workflow");
    expect(advertised).not.toContain("Skill");
  });
});
