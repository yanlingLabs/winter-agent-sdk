// WS-09 §9 ground-truth fixtures: every assertion below drives a REAL descriptor through
// `registerMcpServerTools` + `computeExposurePartition` (which itself calls the spine's
// `partitionAdvertisedTools`, never a re-implementation) -- never a hand-built ToolDescriptor
// literal asserted against in isolation. See registry.ts's own header for why registry mutation in
// tests must target a throwaway, invented server name: the registry is a process-wide singleton
// across one `bun test` invocation.
import { describe, test, expect } from "bun:test";
import { registerMcpServerTools, unregisterMcpServerTools, type DeferralActivation } from "../tools/registry.ts";
import { computeExposurePartition } from "./exposure.ts";

const SRV = "t5exposuresrv";

const ACTIVE: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 100 };

// Every live MCP registration is unconditionally gated on "winter.mcp" (registry.ts's own
// buildMcpToolDescriptor, I4 precedent) -- every query in this file except the dedicated
// "capabilities gate" test below supplies it so the fixtures exercise deferral resolution itself,
// not the upstream availability filter (a separate, already-covered axis).
const WITH_MCP_CAP = ["winter.mcp"] as const;

describe("computeExposurePartition (WS-09 §9 exposure mapping, ground truth)", () => {
  test("deferred: true is deferred in every mode while Tool Search is active", () => {
    try {
      registerMcpServerTools(SRV, [{ name: "always_deferred", inputSchema: { type: "object" } }], { deferredDefault: true });
      const name = `mcp__${SRV}__always_deferred`;
      const partition = computeExposurePartition({ mode: "default", activation: ACTIVE, capabilities: WITH_MCP_CAP });
      expect(partition.deferred.map((d) => d.canonicalName)).toContain(name);
      expect(partition.eager.map((d) => d.canonicalName)).not.toContain(name);
      expect(partition.totalDeferredTools).toBe(partition.deferred.length);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("deferred: Mode[] -- deferred ONLY in the listed mode, eager (not hidden) everywhere else", () => {
    try {
      registerMcpServerTools(SRV, [{ name: "plan_only_deferred", inputSchema: { type: "object" } }], { deferredDefault: ["plan"] });
      const name = `mcp__${SRV}__plan_only_deferred`;

      const inPlan = computeExposurePartition({ mode: "plan", activation: ACTIVE, capabilities: WITH_MCP_CAP });
      expect(inPlan.deferred.map((d) => d.canonicalName)).toContain(name);

      const inDefault = computeExposurePartition({ mode: "default", activation: ACTIVE, capabilities: WITH_MCP_CAP });
      expect(inDefault.deferred.map((d) => d.canonicalName)).not.toContain(name);
      expect(inDefault.eager.map((d) => d.canonicalName)).toContain(name); // NOT hidden -- "treated exactly like false" outside listed modes
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("provider fallback -> full injection: providerSupportsToolSearch=false empties `deferred` regardless of a descriptor's own eligibility", () => {
    try {
      registerMcpServerTools(SRV, [{ name: "would_defer", inputSchema: { type: "object" } }], { deferredDefault: true });
      const name = `mcp__${SRV}__would_defer`;
      const fallback: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: false, deferrableContextShare: 100 };
      const partition = computeExposurePartition({ mode: "default", activation: fallback, capabilities: WITH_MCP_CAP });
      expect(partition.deferred.map((d) => d.canonicalName)).not.toContain(name);
      expect(partition.eager.map((d) => d.canonicalName)).toContain(name); // full injection, not silently dropped
      expect(partition.totalDeferredTools).toBe(0);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("Tool Search inactive (enableToolSearch: false) -- everything eligible resolves eager, deferred is empty", () => {
    try {
      registerMcpServerTools(SRV, [{ name: "would_defer_2", inputSchema: { type: "object" } }], { deferredDefault: true });
      const name = `mcp__${SRV}__would_defer_2`;
      const inactive: DeferralActivation = { enableToolSearch: "false", providerSupportsToolSearch: true, deferrableContextShare: 100 };
      const partition = computeExposurePartition({ mode: "default", activation: inactive, capabilities: WITH_MCP_CAP });
      expect(partition.deferred.map((d) => d.canonicalName)).not.toContain(name);
      expect(partition.eager.map((d) => d.canonicalName)).toContain(name);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("recomputes live: a server registered AFTER a first call is visible on the next call with no cache to invalidate", () => {
    const name = `mcp__${SRV}__appears_later`;
    try {
      const before = computeExposurePartition({ mode: "default", activation: ACTIVE, capabilities: WITH_MCP_CAP });
      expect(before.deferred.map((d) => d.canonicalName)).not.toContain(name);
      expect(before.eager.map((d) => d.canonicalName)).not.toContain(name);

      registerMcpServerTools(SRV, [{ name: "appears_later", inputSchema: { type: "object" } }], { deferredDefault: true });
      const after = computeExposurePartition({ mode: "default", activation: ACTIVE, capabilities: WITH_MCP_CAP });
      expect(after.deferred.map((d) => d.canonicalName)).toContain(name);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("capabilities gate composes normally: a capability-gated descriptor stays excluded from BOTH eager and deferred without the token", () => {
    try {
      // Live MCP registrations are always gated on "winter.mcp" (registry.ts's own
      // buildMcpToolDescriptor, I4 precedent) -- omitting that capability from the query excludes
      // the tool from every bucket, not just from `eager`.
      registerMcpServerTools(SRV, [{ name: "gated", inputSchema: { type: "object" } }], { deferredDefault: true });
      const name = `mcp__${SRV}__gated`;
      const withoutCapability = computeExposurePartition({ mode: "default", activation: ACTIVE });
      expect(withoutCapability.deferred.map((d) => d.canonicalName)).not.toContain(name);
      expect(withoutCapability.eager.map((d) => d.canonicalName)).not.toContain(name);

      const withCapability = computeExposurePartition({ mode: "default", activation: ACTIVE, capabilities: WITH_MCP_CAP });
      expect(withCapability.deferred.map((d) => d.canonicalName)).toContain(name);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });
});
