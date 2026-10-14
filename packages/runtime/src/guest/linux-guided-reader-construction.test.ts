import { expect, test } from "bun:test";
import { constructLinuxGuidedReaderChannel, assertLinuxGuidedReaderSymbols } from "./linux-guided-reader-construction.ts";
import { LINUX_GUIDED_READER_LIMITS, type LinuxGuidedReaderRegistration } from "./linux-guided-reader-protocol.ts";
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const registration: LinuxGuidedReaderRegistration = { version: 1, registrationId: uuid(1), owner: { workspaceId: "workspace", logicalSessionId: "logical", backendSessionId: "backend",
  incarnationId: "incarnation", leaseEpoch: 1, bootId: uuid(2), generation: 1 }, views: { sourceRoot: "/workspace/folders/source", sourceCwd: "/workspace/folders/source",
  sharedRoot: "/run/winter/shared-instructions", sharedPath: "/run/winter/shared-instructions/WINTER.md" }, limits: LINUX_GUIDED_READER_LIMITS, requiredRuntimeContext: { version: 1, bindingId: uuid(3) } };

test("failure after claim and before subscription closes returned wire and native owner", () => {
  for (const failure of ["owner", "registration", "subscription"] as const) {
    const actions: string[] = []; let wireClosed = false;
    expect(() => constructLinuxGuidedReaderChannel({
      registration: failure === "registration" ? { ...registration, version: 2 } as unknown as LinuxGuidedReaderRegistration : registration,
      createWire() { actions.push("claim-dup"); return { async send() { actions.push("send-must-not-happen"); },
        subscribe() { actions.push("subscribe"); throw new Error("private subscription failure"); },
        close() { if (wireClosed) return; wireClosed = true; actions.push("close-original-and-js-dup"); } }; },
      assertOwnerHeld() { actions.push("held"); if (failure === "owner") throw new Error("private owner failure"); },
      closeOwner() { actions.push("close-native-owner"); },
    })).toThrow("required_context_unavailable");
    expect(actions[0]).toBe("claim-dup"); expect(actions).not.toContain("send-must-not-happen");
    expect(actions.filter(action => action === "close-original-and-js-dup")).toHaveLength(1);
    expect(actions.at(-1)).toBe("close-native-owner");
    if (failure !== "subscription") expect(actions).not.toContain("subscribe");
  }
});

test("cleanup failures do not skip independent native owner disposal or expose diagnostics", () => {
  let ownerCloses = 0;
  expect(() => constructLinuxGuidedReaderChannel({ registration,
    createWire() { return { async send() {}, subscribe() { throw new Error("subscription"); }, close() { throw new Error("private close failure"); } }; },
    assertOwnerHeld() { throw new Error("private authority failure"); }, closeOwner() { ownerCloses++; throw new Error("private owner-close failure"); },
  })).toThrow(/^required_context_unavailable$/);
  expect(ownerCloses).toBe(1);
});

test("missing native reader ABI or accessor refuses without invoking a claim", () => {
  let calls = 0;
  for (const value of [{}, { winter_owner_claim_reader() { calls++; } }, { winter_owner_reader_shutdown() { calls++; } },
    { winter_owner_claim_reader: 7, winter_owner_reader_shutdown() { calls++; } }]) expect(() => assertLinuxGuidedReaderSymbols(value)).toThrow("required_context_unavailable");
  const accessor = { winter_owner_reader_shutdown() { calls++; } };
  Object.defineProperty(accessor, "winter_owner_claim_reader", { get() { calls++; throw new Error("must not inspect"); } });
  expect(() => assertLinuxGuidedReaderSymbols(accessor)).toThrow(); expect(calls).toBe(0);
});
