// WS-09 §10 fixtures. `resolveToolAlias` is pure (no registry involvement needed at all).
// `suppressAliasedDuplicates` is driven against a REAL `AdvertisedPartition` built from real
// registrations (never a hand-built partition object) -- this file's own version of
// exposure.test.ts's ground-truth discipline. Deliberately uses INVENTED source/target names rather
// than the real `SendMessage`/`mcp__winter__send_message` pair the spec cites as its own example:
// `mcp/winter-server.ts` does not register a `send_message` tool yet (only `advisor`, this phase),
// and `descriptors/send-message.ts` is a P3 static stub with no live registration seam this lane
// should couple its own fixtures to -- Lane D (WS-10) owns that pair landing for real.
import { describe, test, expect } from "bun:test";
import {
  registerTool,
  registerMcpServerTools,
  unregisterMcpServerTools,
  unregisterToolForTest,
  partitionAdvertisedTools,
  type ToolDescriptor,
  type DeferralActivation,
} from "../tools/registry.ts";
import { resolveToolAlias, suppressAliasedDuplicates } from "./aliases.ts";

describe("resolveToolAlias (WS-09 §10, single-hop)", () => {
  test("an aliased name resolves to its configured target", () => {
    expect(resolveToolAlias("SendMessage", { SendMessage: "mcp__winter__send_message" })).toBe("mcp__winter__send_message");
  });

  test("an unaliased name passes through unchanged", () => {
    expect(resolveToolAlias("Read", { SendMessage: "mcp__winter__send_message" })).toBe("Read");
  });

  test("no table at all -> identity", () => {
    expect(resolveToolAlias("SendMessage", undefined)).toBe("SendMessage");
  });

  test("single-hop: a two-entry loop never chases past the first resolution", () => {
    const table = { A: "B", B: "A" };
    expect(resolveToolAlias("A", table)).toBe("B"); // NOT re-looked-up back to "A"
    expect(resolveToolAlias("B", table)).toBe("A");
  });
});

const SRV = "t5aliassrv";
const ACTIVE: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 100 };
const FAKE_BUILTIN_NAME = "T5FakeBuiltinAliasSource";

function registerFakeBuiltin(): void {
  const descriptor: ToolDescriptor = {
    canonicalName: FAKE_BUILTIN_NAME,
    advertisedName: FAKE_BUILTIN_NAME,
    source: "builtin",
    inputSchema: { type: "object" },
    description: "a throwaway builtin standing in for a real aliased built-in (e.g. SendMessage)",
    exposure: "eager",
    permissionClass: "messaging",
    availability: {},
    capabilityRequirements: [],
    disposition: "implement-now",
  };
  registerTool({ descriptor });
}

describe("suppressAliasedDuplicates (WS-09 §10, ground truth against a real partition)", () => {
  test("defers the canonical MCP target when its alias SOURCE is already advertised", () => {
    try {
      registerFakeBuiltin(); // source: builtin, resolveDeferral always "eager" (WS-09 §8's own builtin floor)
      registerMcpServerTools(SRV, [{ name: "send_message", inputSchema: { type: "object" } }], { deferredDefault: false }); // target: eager by default
      const targetName = `mcp__${SRV}__send_message`;

      const partition = partitionAdvertisedTools({ mode: "default", capabilities: ["winter.mcp"] }, ACTIVE);
      // Ground truth precondition: BEFORE suppression, the live registry really does advertise both
      // eagerly (the exact "sees TWO send-message-shaped tools" problem WS-09 §10 exists to fix).
      expect(partition.eager.map((d) => d.canonicalName)).toContain(FAKE_BUILTIN_NAME);
      expect(partition.eager.map((d) => d.canonicalName)).toContain(targetName);

      const suppressed = suppressAliasedDuplicates(partition, { [FAKE_BUILTIN_NAME]: targetName });
      expect(suppressed.eager.map((d) => d.canonicalName)).toContain(FAKE_BUILTIN_NAME); // source untouched
      expect(suppressed.eager.map((d) => d.canonicalName)).not.toContain(targetName); // target moved out of eager
      expect(suppressed.deferred.map((d) => d.canonicalName)).toContain(targetName); // ... into deferred, not hidden
      expect(suppressed.hidden).toEqual(partition.hidden); // hidden bucket untouched
    } finally {
      unregisterToolForTest(FAKE_BUILTIN_NAME);
      unregisterMcpServerTools(SRV);
    }
  });

  test("no-op when the alias source is not actually advertised (nothing to deduplicate against)", () => {
    try {
      registerMcpServerTools(SRV, [{ name: "send_message_2", inputSchema: { type: "object" } }], { deferredDefault: false });
      const targetName = `mcp__${SRV}__send_message_2`;
      const partition = partitionAdvertisedTools({ mode: "default", capabilities: ["winter.mcp"] }, ACTIVE);
      expect(partition.eager.map((d) => d.canonicalName)).toContain(targetName);

      // "NeverRegisteredBuiltin" is not advertised anywhere -- the alias entry is inert.
      const suppressed = suppressAliasedDuplicates(partition, { NeverRegisteredBuiltin: targetName });
      expect(suppressed.eager.map((d) => d.canonicalName)).toContain(targetName); // untouched
      expect(suppressed).toEqual(partition); // structurally the identical partition
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("a target that is already deferred is left alone (nothing to suppress)", () => {
    try {
      registerFakeBuiltin();
      registerMcpServerTools(SRV, [{ name: "already_deferred", inputSchema: { type: "object" } }], { deferredDefault: true }); // target starts deferred
      const targetName = `mcp__${SRV}__already_deferred`;
      const partition = partitionAdvertisedTools({ mode: "default", capabilities: ["winter.mcp"] }, ACTIVE);
      expect(partition.deferred.map((d) => d.canonicalName)).toContain(targetName);

      const suppressed = suppressAliasedDuplicates(partition, { [FAKE_BUILTIN_NAME]: targetName });
      expect(suppressed.deferred.map((d) => d.canonicalName)).toContain(targetName);
      expect(suppressed.eager.map((d) => d.canonicalName)).not.toContain(targetName);
    } finally {
      unregisterToolForTest(FAKE_BUILTIN_NAME);
      unregisterMcpServerTools(SRV);
    }
  });

  test("no table at all -> identity (same object reference, not merely equal)", () => {
    const partition = partitionAdvertisedTools({ mode: "default" }, ACTIVE);
    expect(suppressAliasedDuplicates(partition, undefined)).toBe(partition);
  });
});
