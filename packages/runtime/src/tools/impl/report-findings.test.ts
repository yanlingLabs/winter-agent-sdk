// report-findings.ts tests -- Phase 3, Lane D, Task 6. `import "./report-findings.ts"` triggers the
// module's own replaceExecutor("ReportFindings", ...) side effect (registry.test.ts's "Fix round 1"
// precedent: never use "ReportFindings" as a throwaway fixture name elsewhere).
import { describe, expect, test } from "bun:test";
import "./report-findings.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";

function makeCtx(): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId: "findings-test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/work/.tmp",
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [] },
  };
}

async function run(input: unknown): Promise<ToolResultPayload> {
  const tool = getRegisteredTool("ReportFindings");
  if (!tool?.executor) throw new Error("ReportFindings executor is not registered");
  return tool.executor.execute(input, makeCtx());
}

const MINIMAL_FINDING = { file: "src/a.ts", summary: "off-by-one", failure_scenario: "loop reads one past the end" };

describe("ReportFindings", () => {
  test("a minimal valid finding is echoed back verbatim, level omitted", async () => {
    const result = await run({ findings: [MINIMAL_FINDING] });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed).toEqual({ findings: [MINIMAL_FINDING] });
    expect(parsed).not.toHaveProperty("level");
  });

  test("a fully-populated finding round-trips every optional field", async () => {
    const finding = {
      file: "src/a.ts",
      line: 42,
      summary: "off-by-one",
      short_summary: "off-by-one",
      failure_scenario: "loop reads one past the end",
      category: "correctness",
      verdict: "CONFIRMED",
      outcome: "fixed",
    };
    const result = await run({ level: "high", findings: [finding] });
    expect(JSON.parse(result.output)).toEqual({ level: "high", findings: [finding] });
  });

  test("an empty findings array is valid", async () => {
    const result = await run({ findings: [] });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ findings: [] });
  });

  test("order is preserved", async () => {
    const a = { ...MINIMAL_FINDING, file: "a.ts" };
    const b = { ...MINIMAL_FINDING, file: "b.ts" };
    const result = await run({ findings: [a, b] });
    expect(JSON.parse(result.output).findings.map((f: { file: string }) => f.file)).toEqual(["a.ts", "b.ts"]);
  });

  test("rejects more than 32 findings", async () => {
    const findings = Array.from({ length: 33 }, () => MINIMAL_FINDING);
    const result = await run({ findings });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("32");
  });

  test("accepts exactly 32 findings", async () => {
    const findings = Array.from({ length: 32 }, () => MINIMAL_FINDING);
    const result = await run({ findings });
    expect(result.isError).toBeUndefined();
  });

  test("rejects a missing findings field", async () => {
    const result = await run({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("findings");
  });

  test("rejects a non-array findings field", async () => {
    const result = await run({ findings: "nope" });
    expect(result.isError).toBe(true);
  });

  test("rejects a non-object input", async () => {
    const result = await run("nope");
    expect(result.isError).toBe(true);
  });

  test("rejects a finding missing file", async () => {
    const { file: _omit, ...rest } = MINIMAL_FINDING;
    const result = await run({ findings: [rest] });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("file");
  });

  test("rejects a finding missing summary", async () => {
    const { summary: _omit, ...rest } = MINIMAL_FINDING;
    const result = await run({ findings: [rest] });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("summary");
  });

  test("rejects a finding missing failure_scenario", async () => {
    const { failure_scenario: _omit, ...rest } = MINIMAL_FINDING;
    const result = await run({ findings: [rest] });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("failure_scenario");
  });

  test("rejects an invalid verdict enum value", async () => {
    const result = await run({ findings: [{ ...MINIMAL_FINDING, verdict: "MAYBE" }] });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("verdict");
  });

  test("rejects an invalid outcome enum value", async () => {
    const result = await run({ findings: [{ ...MINIMAL_FINDING, outcome: "ignored" }] });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("outcome");
  });

  test("rejects an invalid level enum value", async () => {
    const result = await run({ level: "critical", findings: [] });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("level");
  });

  test("rejects a non-numeric line", async () => {
    const result = await run({ findings: [{ ...MINIMAL_FINDING, line: "42" }] });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("line");
  });

  test("rejects a non-object finding item", async () => {
    const result = await run({ findings: ["not an object"] });
    expect(result.isError).toBe(true);
  });
});
