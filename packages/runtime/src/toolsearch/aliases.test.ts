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
import { aliasPermissionIdentities, hideAliasExcludedTwins, resolvePermissionIdentity, resolveToolAlias, suppressAliasedDuplicates } from "./aliases.ts";

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

// --- RULING P4-E AMENDED (fix wave, whole-branch C2) ----------------------------------------------

describe("hideAliasExcludedTwins (C2: exclusion travels along the alias edge)", () => {
  test("direction 1: a REGISTERED-but-unadvertised source hides its alias target", () => {
    try {
      registerFakeBuiltin();
      registerMcpServerTools(SRV, [{ name: "twin", inputSchema: { type: "object" } }], { deferredDefault: false });
      const targetName = `mcp__${SRV}__twin`;
      // The source is registered (registerFakeBuiltin) but bare-denied, so it is NOT advertised.
      const partition = partitionAdvertisedTools({ mode: "default", capabilities: ["winter.mcp"], disallowedTools: [FAKE_BUILTIN_NAME] }, ACTIVE);
      expect(partition.eager.map((d) => d.canonicalName)).not.toContain(FAKE_BUILTIN_NAME);
      expect(partition.eager.map((d) => d.canonicalName)).toContain(targetName);

      const hidden = hideAliasExcludedTwins(partition, { [FAKE_BUILTIN_NAME]: targetName }, [FAKE_BUILTIN_NAME]);
      expect(hidden.eager.map((d) => d.canonicalName)).not.toContain(targetName);
      expect(hidden.deferred.map((d) => d.canonicalName)).not.toContain(targetName);
      expect(hidden.hidden.map((d) => d.canonicalName)).toContain(targetName);
    } finally {
      unregisterToolForTest(FAKE_BUILTIN_NAME);
      unregisterMcpServerTools(SRV);
    }
  });

  test("direction 1 is scoped to REGISTERED sources: an arbitrary model-facing alias label is inert", () => {
    try {
      registerMcpServerTools(SRV, [{ name: "twin2", inputSchema: { type: "object" } }], { deferredDefault: false });
      const targetName = `mcp__${SRV}__twin2`;
      const partition = partitionAdvertisedTools({ mode: "default", capabilities: ["winter.mcp"] }, ACTIVE);
      // "NeverRegisteredLabel" is not a Winter tool at all -- a perfectly ordinary Options.toolAliases
      // use, and hiding the target for it would be a mass-hide bug, not a security fix.
      expect(hideAliasExcludedTwins(partition, { NeverRegisteredLabel: targetName }, undefined)).toBe(partition);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("direction 2 (T8-review M6): a bare deny on the TARGET hides the advertised SOURCE", () => {
    try {
      registerFakeBuiltin();
      registerMcpServerTools(SRV, [{ name: "twin3", inputSchema: { type: "object" } }], { deferredDefault: false });
      const targetName = `mcp__${SRV}__twin3`;
      const partition = partitionAdvertisedTools({ mode: "default", capabilities: ["winter.mcp"], disallowedTools: [targetName] }, ACTIVE);
      expect(partition.eager.map((d) => d.canonicalName)).toContain(FAKE_BUILTIN_NAME);

      const hidden = hideAliasExcludedTwins(partition, { [FAKE_BUILTIN_NAME]: targetName }, [targetName]);
      expect(hidden.eager.map((d) => d.canonicalName)).not.toContain(FAKE_BUILTIN_NAME);
      expect(hidden.hidden.map((d) => d.canonicalName)).toContain(FAKE_BUILTIN_NAME);
    } finally {
      unregisterToolForTest(FAKE_BUILTIN_NAME);
      unregisterMcpServerTools(SRV);
    }
  });
});

describe("resolvePermissionIdentity (C2: alias-aware in BOTH directions, strictest-of)", () => {
  const NONE = { deniedByRule: () => false, askedByRule: () => false, hookScoped: () => false, allowedByRule: () => false };

  test("the identity set is the single-hop equivalence class, primary first", () => {
    expect(aliasPermissionIdentities("SendMessage", undefined)).toEqual(["SendMessage", "mcp__winter__send_message"]);
    expect(aliasPermissionIdentities("mcp__winter__send_message", undefined)).toEqual(["mcp__winter__send_message", "SendMessage"]);
    // A host table's forward mapping still supplies the PRIMARY (P4-E, unamended).
    expect(aliasPermissionIdentities("A", { A: "B" })).toEqual(["B", "A"]);
    // A name in neither table has exactly one identity -- unchanged behaviour, no probes consulted.
    expect(aliasPermissionIdentities("Read", undefined)).toEqual(["Read"]);
  });

  test("nothing matches -> the primary wins (byte-identical to resolveToolAlias)", () => {
    expect(resolvePermissionIdentity("SendMessage", undefined, NONE)).toBe("SendMessage");
    expect(resolvePermissionIdentity("A", { A: "B" }, NONE)).toBe("B");
  });

  test("a deny naming EITHER spelling wins over everything else", () => {
    const denyTwin = { ...NONE, deniedByRule: (n: string) => n === "mcp__winter__send_message", allowedByRule: () => true };
    expect(resolvePermissionIdentity("SendMessage", undefined, denyTwin)).toBe("mcp__winter__send_message");
    const denyNative = { ...NONE, deniedByRule: (n: string) => n === "SendMessage", askedByRule: () => true };
    expect(resolvePermissionIdentity("mcp__winter__send_message", undefined, denyNative)).toBe("SendMessage");
  });

  test("strictness order: deny > ask > hook matcher > allow", () => {
    const ask = { ...NONE, askedByRule: (n: string) => n === "SendMessage", hookScoped: () => true, allowedByRule: () => true };
    expect(resolvePermissionIdentity("mcp__winter__send_message", undefined, ask)).toBe("SendMessage");
    const hook = { ...NONE, hookScoped: (n: string) => n === "SendMessage", allowedByRule: () => true };
    expect(resolvePermissionIdentity("mcp__winter__send_message", undefined, hook)).toBe("SendMessage");
    const allow = { ...NONE, allowedByRule: (n: string) => n === "SendMessage" };
    expect(resolvePermissionIdentity("mcp__winter__send_message", undefined, allow)).toBe("SendMessage");
  });

  test("a single-identity name never consults a probe at all", () => {
    let calls = 0;
    const counting = {
      deniedByRule: () => { calls++; return true; },
      askedByRule: () => { calls++; return true; },
      hookScoped: () => { calls++; return true; },
      allowedByRule: () => { calls++; return true; },
    };
    expect(resolvePermissionIdentity("Read", undefined, counting)).toBe("Read");
    expect(calls).toBe(0);
  });
});
