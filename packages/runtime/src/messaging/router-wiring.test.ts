// R-7b-4: the WIRING half of the messaging move, pinned where the wiring lives.
//
// The router core moved to `@yanlinglabs/winter-agent-sdk/messaging` and its tests moved with it,
// which left exactly one behaviour without a home. `deliverEnvelope` used to `instanceof`-check
// RULING P4-D's `ChildResumeModeIncomparableError` directly; the published core cannot import that
// class, so classification became an owner-supplied predicate
// (`MessagingRuntimeDeps.classifyDeliveryError`). The core's tests pin that it honours the predicate
// in both directions with a synthetic class. THIS file pins the fact those tests can no longer see:
// that the WINTER RUNTIME actually supplies it, and supplies it correctly for the REAL class.
//
// Without this, `createDefaultMessagingRuntime` could silently omit the predicate and every P4-D
// refusal would quietly become `delivery_uncertain` -- a status that asserts the delivery may have
// happened, about a refusal whose whole point is that nothing happened.
import { describe, test, expect } from "bun:test";
import { sendMessage, type MessagingRuntimeDeps } from "@yanlinglabs/winter-agent-sdk/messaging";
import { ChildResumeModeIncomparableError } from "../permissions/auto/inheritance.ts";
import { classifyDeliveryError, createDefaultMessagingRuntime } from "./reference-adapter.ts";
import { registerMessagingRuntime, getMessagingRuntime, resetMessagingRuntimeForTest } from "./router.ts";
import { createFakeChildHandle } from "../subagents/test-fakes.ts";

describe("classifyDeliveryError: Winter's own refusal-vs-crash-window predicate", () => {
  test("RULING P4-D's ChildResumeModeIncomparableError is a POLICY refusal, and nothing else is", () => {
    expect(classifyDeliveryError(new ChildResumeModeIncomparableError("dontAsk", "auto"))).toBe("refused");
    expect(classifyDeliveryError(new Error("the child process died mid-write"))).toBe("uncertain");
    expect(classifyDeliveryError("not even an error")).toBe("uncertain");
    expect(classifyDeliveryError(undefined)).toBe("uncertain");
  });

  test("createDefaultMessagingRuntime WIRES it -- a runtime built here always carries the predicate", () => {
    const runtime = createDefaultMessagingRuntime({ now: () => 0 });
    expect(runtime.classifyDeliveryError).toBe(classifyDeliveryError);
  });
});

describe("end to end: a real ChildResumeModeIncomparableError reaches `refused`, not `delivery_uncertain`", () => {
  test("sendMessage through createDefaultMessagingRuntime surfaces the error's own message as the refusal reason", async () => {
    const err = new ChildResumeModeIncomparableError("dontAsk", "auto");
    const runtime = createDefaultMessagingRuntime({ now: () => 0 });
    const child = createFakeChildHandle({ id: "c1", parentSessionId: "s_caller" });
    child.simulateCompletion("done"); // terminal -> SendMessage resumes rather than steers (WS-10 §10.3)
    // The REAL adapter, with only this child's own `resume` replaced by the throw RULING P4-D
    // produces -- so every other step (resolution, the bounds, the outcome ledger) is the production
    // path, and the ONLY synthetic thing is the error itself.
    child.resume = async () => {
      throw err;
    };
    runtime.seam.addChildRosterSource(() => [child]);

    const deps: MessagingRuntimeDeps = runtime;
    const result = await sendMessage(deps, { sessionId: "s_caller", toolUseId: "tool-1" }, { to: "c1", message: "resume me" });
    expect(result.outcome).toEqual({ status: "refused", messageId: result.outcome.messageId, reason: err.message });
  });

  test("the negative control: any OTHER throw from the same path is delivery_uncertain with deliveryMayHaveOccurred", async () => {
    const runtime = createDefaultMessagingRuntime({ now: () => 0 });
    const child = createFakeChildHandle({ id: "c2", parentSessionId: "s_caller2" });
    child.simulateCompletion("done");
    child.resume = async () => {
      throw new Error("simulated crash between invoking and recording");
    };
    runtime.seam.addChildRosterSource(() => [child]);

    const result = await sendMessage(runtime, { sessionId: "s_caller2", toolUseId: "tool-1" }, { to: "c2", message: "resume me" });
    expect(result.outcome.status).toBe("delivery_uncertain");
    if (result.outcome.status === "delivery_uncertain") expect(result.outcome.deliveryMayHaveOccurred).toBe(true);
  });
});

describe("the PROCESS-level runtime singleton (R-7b-4: it stayed in the runtime, not the library)", () => {
  test("register/get/reset round-trip", () => {
    resetMessagingRuntimeForTest();
    expect(getMessagingRuntime()).toBeUndefined();
    const deps = createDefaultMessagingRuntime({ now: () => 0 });
    registerMessagingRuntime(deps);
    expect(getMessagingRuntime()).toBe(deps);
    resetMessagingRuntimeForTest();
    expect(getMessagingRuntime()).toBeUndefined();
  });
});
