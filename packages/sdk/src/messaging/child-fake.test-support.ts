// The shared `ChildLike` FAKE for this module's own tests.
//
// A `.test-support.ts`, not a `.test.ts` and not a plain `.ts`, for two reasons that are both
// enforced elsewhere: bun's runner never treats it as a suite (so importing it from four test files
// does not run a fifth one), and `packages/sdk/tsconfig.build.json` EXCLUDES the pattern, so it
// contributes no `.d.ts` to the published tarball. It is a fixture, never part of the subpath's API.
//
// It replaces the runtime's own `createFakeChildHandle` for the moved tests: those tests used to
// reach into `packages/runtime/src/subagents/test-fakes.ts`, which is exactly the dependency
// direction R-7b-4 removes. The state machine is the same minimal, realistic one -- running, steer
// while running, resume only when terminal -- reduced to the four members `ChildLike` actually has.
import type { ChildLike, ChildLikeRecord, ChildLikeStatus, DeliveryOutcome } from "./adapter.ts";

export interface FakeChild extends ChildLike {
  /** Drives the state machine from a test, the way a real child's own settle path would. */
  setStatus(next: ChildLikeStatus): void;
  /** Every message body this child was steered or resumed with, in call order. */
  readonly received: string[];
}

export function createFakeChild(overrides: Partial<ChildLikeRecord> = {}, initialStatus: ChildLikeStatus = "running"): FakeChild {
  let status: ChildLikeStatus = initialStatus;
  let counter = 0;
  const received: string[] = [];
  const record: ChildLikeRecord = {
    id: "child-1",
    parentSessionId: "parent-1",
    permission: { effectiveMode: "default" },
    ...overrides,
  };
  return {
    record,
    received,
    status: () => status,
    setStatus(next) {
      status = next;
    },
    async steer(msg): Promise<DeliveryOutcome> {
      if (status !== "running") return { status: "not_found", messageId: msg.messageId, reason: `child ${record.id} is not running (status: ${status})` };
      received.push(msg.body);
      return { status: "delivered", messageId: msg.messageId };
    },
    async resume(msg): Promise<DeliveryOutcome> {
      if (status === "running") return { status: "not_found", messageId: msg.messageId, reason: `child ${record.id} is still running -- resume targets a TERMINAL child only` };
      received.push(msg.body);
      status = "running"; // WS-10 §7: an addressable terminal child auto-resumes
      return { status: "resumed_and_delivered", messageId: msg.messageId };
    },
  };
}
