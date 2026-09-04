// Phase 4 fix wave (KNOWN item 2): the shared `ChildHandle` FAKE, relocated out of
// `subagents/seam-contracts-p4.test.ts`.
//
// It lived in that file because that file is the seam AUTHORITY -- the one place the fixture and
// the contract it satisfies are proven together. But three other test files (engine.test.ts,
// messaging/router.test.ts, messaging/reference-adapter.test.ts, messaging/resolution.test.ts) then
// had to IMPORT A TEST FILE to reach it, which under bun's runner means loading and running another
// file's whole suite as a side effect of an import. Moving the fixture to a plain module keeps
// every importer on ordinary code while the seam-authority file goes on testing the IDENTICAL fake
// (it imports it from here now) -- nothing about what is proven, or where, changes.
//
// NOT test-only by accident: this file is deliberately a `.ts` (not `.test.ts`) so bun never treats
// it as a suite. It exports nothing production code imports; it is a fixture module, the same shape
// `mcp/test-fixtures.ts` already established in this codebase.
import type { ChildHandle, ChildResult, ChildSessionRecord } from "./child-handle.ts";

// A minimal, REALISTIC state machine satisfying the ChildHandle contract -- not production code
// (Lane C's own child-engine.ts is that), but a fixture proving the four outcomes MUST 10 pins are
// mutually consistent and testable at all. Lane D's own router (consuming ChildHandle ONLY) can be
// tested against this exact fake instead of a live child engine.
// Fix round 1, MAJOR item 1: exported (was file-private) so engine.test.ts's own NEW spawn-seam
// tests can drive a REAL runEngine against this exact fixture, per the controller's explicit
// instruction, instead of hand-rolling a second, potentially-drifting fake ChildHandle. No test body
// or assertion in THIS file changed -- this is the one, minimal, additive edit "keep it green" was
// always going to tolerate: a seam-authority file staying the single source of the fixture its own
// tests already prove correct, rather than becoming one of two.
export function createFakeChildHandle(recordOverrides?: Partial<ChildSessionRecord>): ChildHandle & { simulateCompletion(content: string): void } {
  let status: ChildSessionRecord["status"] = "running";
  let resolveResult!: (r: ChildResult) => void;
  let settled = false;
  const resultPromise = new Promise<ChildResult>((resolve) => {
    resolveResult = resolve;
  });
  const record: ChildSessionRecord = {
    id: "child-1",
    parentSessionId: "parent-1",
    parentToolUseId: "tooluse-1",
    transcript: "subagents/agent-child-1.jsonl",
    status: "running",
    runtime: "winter-agent",
    model: { effectiveModel: "sonnet", effectiveEffort: "medium" },
    permission: { effectiveMode: "default", parentPolicyHash: "h", parentPolicyVersion: 1 },
    ...recordOverrides,
  };
  let messageCounter = 0;

  return {
    record,
    status: () => status,
    async steer(_msg) {
      if (status !== "running") {
        return { status: "not_found", messageId: `m${++messageCounter}`, reason: `child ${record.id} is not running (status: ${status})` };
      }
      return { status: "delivered", messageId: `m${++messageCounter}` };
    },
    async resume(_msg) {
      if (status !== "completed" && status !== "stopped" && status !== "failed") {
        return { status: "not_found", messageId: `m${++messageCounter}`, reason: `child ${record.id} is still running -- resume targets a TERMINAL child only` };
      }
      status = "running"; // WS-10 §7: an addressable terminal child auto-resumes
      return { status: "resumed_and_delivered", messageId: `m${++messageCounter}` };
    },
    async result() {
      return resultPromise;
    },
    async stop() {
      if (settled) return; // already terminal -- idempotent
      settled = true;
      status = "stopped";
      resolveResult({ status: "stopped", content: "stopped by request" });
    },
    simulateCompletion(content: string): void {
      if (settled) return;
      settled = true;
      status = "completed";
      resolveResult({ status: "completed", content });
    },
  };
}
