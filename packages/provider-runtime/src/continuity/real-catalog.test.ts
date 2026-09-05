// Phase 6 Lane C, review round 2: THE REAL-CATALOG PROBE.
//
// WHY THIS FILE EXISTS, stated plainly because it is the whole lesson of the round. Every fixture in
// this lane hand-builds its descriptors, and hand-built descriptors are built the way the author
// IMAGINES the catalog looks. The shipped catalog does not look that way: every
// `opaque-provider-state` row carries a single-member `continuationDomain` list naming ITSELF, at
// `confidence: "unknown"`. The round-1 certification gate kept the key-derived self-domain only when
// there was NO domain evidence at all -- a carve-out that never fired on a single real row -- so it
// dropped same-model native replay for five of the six reasoning models in the product, while
// `classifySwitch(X, X)` went on reporting `lossless-native` with zero warnings. A lossless claim
// standing beside real loss, on every leg, with no switch required.
//
// Hand-built fixtures could not see it and a reviewer had to. So this probe asks the question of the
// REAL catalog, through the REAL registry, with the target expression the REAL bridge builds -- and
// it is deliberately written to keep passing when Lane X raises those entries to `declared`, because
// a probe that only holds for today's evidence is a snapshot, not a guard.
import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createRegistry, type ProviderRegistry } from "../registry.ts";
import type { ProviderMessageLike } from "../types.ts";
import { createEndpointResolver } from "./domains.ts";
import { scriptedAdapter } from "./fixtures.ts";
import { createHistoryRenderer, type HistoryTarget } from "./renderer.ts";
import { classifySwitch } from "./warnings.ts";

/** The real catalog with a scripted adapter registered for every adapter id it names. */
function realRegistry(): ProviderRegistry {
  const catalog = loadCatalog();
  const registry = createRegistry(catalog);
  for (const adapterId of new Set(catalog.providers.map((p) => p.adapterId))) {
    const family = catalog.providers.find((p) => p.adapterId === adapterId)?.family ?? "openai";
    registry.register(scriptedAdapter({ id: adapterId, family: family as "openai" | "anthropic" | "google" }));
  }
  return registry;
}

/** Every row whose native state is opaque -- exactly the rows whose replay this lane can break. */
function opaqueStateRows() {
  return loadCatalog().models.filter((m) => m.reasoning?.continuation === "opaque-provider-state");
}

describe("the real catalog: same-model native replay survives, and nothing claims more than it delivers", () => {
  test("the probe has real rows to examine (a vacuous pass is not a pass)", () => {
    const rows = opaqueStateRows();
    expect(rows.length).toBeGreaterThanOrEqual(5);
    // The shape that defeated every hand-built fixture: a single-member list naming the row itself.
    // Asserted as a FACT ABOUT TODAY's catalog, not as a requirement -- Lane X is raising these to
    // `declared`, and the probe below must pass either way.
    expect(rows.some((m) => m.reasoning?.continuationDomain !== undefined)).toBe(true);
  });

  test.each(opaqueStateRows().map((m) => [m.key] as const))(
    "%s: its own native state is REPLAYED, not dropped -- through the real registry and the bridge's own target expression",
    (modelKey) => {
      const registry = realRegistry();
      const resolved = registry.resolve({ model: modelKey });
      if (resolved instanceof Error) throw resolved;

      // EXACTLY what `adapterAsProvider` builds for `target` (bridge.ts): the adapter's family, the
      // registry's own continuation domain, and the adapter's readable state. Using anything else
      // here would prove something about a target the product never constructs.
      const capabilities = resolved.descriptor !== undefined ? resolved.adapter.capabilities(resolved.descriptor) : undefined;
      const target: HistoryTarget = {
        family: resolved.adapter.family,
        ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}),
        readableState: capabilities?.readableState ?? "none",
      };

      const message: ProviderMessageLike = {
        role: "assistant",
        content: [{ type: "text", text: "the visible answer" }],
        uuid: "m1",
        origin: {
          providerId: resolved.providerId,
          modelKey: resolved.modelKey,
          family: resolved.adapter.family,
          ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}),
        },
        nativeState: { family: resolved.adapter.family, continuationDomain: resolved.continuationDomain ?? resolved.adapter.family, items: ["REAL-OPAQUE"] },
      };

      const { messages, report } = createHistoryRenderer(registry).renderWithReport([message], new Map([["m1", { summary: "s" }]]), target);
      expect(report.replayedNatively).toBe(1);
      expect(report.droppedNativeState).toBe(0);
      expect(messages[0]!.nativeState?.items).toEqual(["REAL-OPAQUE"]);
      // A model replaying to itself is not a cross-family transfer, so it is never decorated.
      expect(messages[0]!.decoration).toBeUndefined();
    },
  );

  test.each(opaqueStateRows().map((m) => [m.key] as const))("%s: switching it to ITSELF is lossless with zero warnings, and the claim is true", (modelKey) => {
    const registry = realRegistry();
    const endpoint = createEndpointResolver(registry)({
      providerId: loadCatalog().models.find((m) => m.key === modelKey)!.providerId,
      modelKey,
      family: "openai",
    });
    const verdict = classifySwitch(endpoint, endpoint, {});
    expect(verdict.lossClass).toBe("lossless-native");
    expect(verdict.warnings).toEqual([]);
    // The claim the round-1 gate made while the renderer was stripping the state out from under it.
    // It is only allowed to stand because the replay probe above proves it.
    expect(verdict.portable).toContain(`${modelKey}'s own reasoning state, replayed exactly`);
    expect(endpoint.continuationDomain).toBeDefined();
  });

  test("a cross-model switch between two real rows still warns -- the gate did not become a no-op", () => {
    const registry = realRegistry();
    const resolve = createEndpointResolver(registry);
    const rows = opaqueStateRows();
    const a = resolve({ providerId: rows[0]!.providerId, modelKey: rows[0]!.key, family: "openai" });
    const b = resolve({ providerId: rows[1]!.providerId, modelKey: rows[1]!.key, family: "openai" });
    expect(a.modelKey).not.toBe(b.modelKey);
    expect(classifySwitch(a, b, { summaryAvailable: true }).lossClass).toBe("warned-lossy");
  });
});
