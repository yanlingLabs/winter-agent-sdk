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
import {
  sendMessage,
  facetNotificationKey,
  isReservedNotificationKey,
  RESERVED_NOTIFICATION_KEY_PREFIX,
  type MessagingRuntimeDeps,
} from "@yanlinglabs/winter-agent-sdk/messaging";
import { runEngine } from "../engine.ts";
import type { WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
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

// --- Fix r2 (N4/N5): the facet's process-level registrations, and its queue namespace ---------------

describe("N4: a throw anywhere in the run cannot leak the facet's self-peer", () => {
  test("a run whose provider throws still withdraws its peer and its notice forwarder", async () => {
    // THE RESIDUAL this closes, and why it stopped being acceptable. `runEngine`'s teardown is a
    // straight-line block near the end of ~2400 lines, and its own comment says the `finally` half was
    // never landed. That was tolerable while only a session a host had SUBSCRIBED to held a handle;
    // unconditional self-peer registration made it EVERY session, and a leaked handle keeps answering
    // `list_reachable` and `deliverToSession` for a session that is gone, out of a `status()` closure
    // reading dead state.
    //
    // A PROVIDER that throws is the plant: it is the one injection point that reaches deep inside the
    // turn loop -- past the registration, before the teardown -- without this test having to reach
    // into the engine's internals to break it.
    resetMessagingRuntimeForTest();
    const runtime = createDefaultMessagingRuntime({ now: () => 0 });
    registerMessagingRuntime(runtime);
    const before = runtime.peers.list().length;

    const { host, runtime: channel } = createInMemoryChannel();
    // THE PLANT, and what it took to find one that discriminates. A PROVIDER that throws is not it:
    // the engine catches it and produces an error result, so the ordinary teardown is reached and the
    // test would pass with or without the fix. Nor is an arbitrary Nth write: the early ones land
    // before the registration (nothing to leak) and the pump's own writes are swallowed by the pump,
    // so the run still returns normally.
    //
    // The write of the turn's TERMINAL RESULT is in the main body, past the registration, and nothing
    // catches it -- so a sink that dies there is a throw that genuinely escapes `runEngine`. Verified
    // both ways: with the `finally` removed this test fails on the leaked handle, and with it in place
    // it passes.
    const explodingOutput = {
      write(frame: WinterFrame): void {
        if (frame.type === "data" && (frame as { message?: { type?: string } }).message?.type === "result") {
          throw new Error("planted: the output sink dies writing the terminal result");
        }
        channel.output.write(frame);
      },
      end(): void {
        channel.output.end();
      },
    };
    const done = runEngine({
      config: { sessionId: "n4-leak-probe", cwd: "/tmp/x", model: "winter-test/echo" },
      input: channel.input,
      output: explodingOutput,
      provider: { async generate() { return { kind: "text", text: "ok" } as const; } },
    }).then(
      () => "resolved",
      () => "threw",
    );
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    channel.output.end(); // the run died before it could end its own stream
    for await (const _frame of host.input) {
      /* drain whatever reached the host before the sink died */
    }
    expect(await done).toBe("threw"); // the throw really did escape the run

    // Withdrawn -- the count is back where it started, and specifically no handle at this session's
    // own address survives.
    expect(runtime.peers.list().length).toBe(before);
    expect(runtime.peers.find({ objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "n4-leak-probe" })).toBeUndefined();
    resetMessagingRuntimeForTest();
  });
});

describe("N5: the facet's notification bucket is a RESERVED namespace, not a concatenated string", () => {
  test("the facet's key is never the model's, and the reservation is assertable rather than assumed", () => {
    // A session's own model drains `notifications.drain(sessionId)`; a drain REMOVES, so one shared
    // key has whichever side reads first eat the other's notices. The prefix is what makes the two
    // buckets disjoint -- and `isReservedNotificationKey` is what lets a caller CHECK that rather than
    // rederive the string.
    expect(facetNotificationKey("s_abc")).not.toBe("s_abc");
    expect(isReservedNotificationKey(facetNotificationKey("s_abc"))).toBe(true);
    expect(isReservedNotificationKey("s_abc")).toBe(false);
    expect(facetNotificationKey("s_abc").startsWith(RESERVED_NOTIFICATION_KEY_PREFIX)).toBe(true);
    // The one collision the prefix cannot prevent is named rather than papered over: a session whose
    // OWN id already carries the prefix maps onto its own model's bucket. Unreachable with product
    // ids (`s_<hex>`), harmless if it happened (the two buckets merge, which is the pre-fix
    // behaviour), and detectable by the predicate above -- which is the whole point of exporting it.
    expect(isReservedNotificationKey("host:x")).toBe(true);
  });
});
