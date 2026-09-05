// Phase 6 Lane C: the continuity corpus, RUN -- plus the two proofs that can only be made from this
// package, because it is the only place a lane may relative-import both the continuity module and the
// runtime's real bridge.
//
// WHY THE SECOND HALF EXISTS. Task 3's own lesson 8: a seam can be exported, documented and tested in
// isolation and still never be called correctly, and the failure surfaces on the LIVE path while
// isolated fixtures stay green. `createHistoryRenderer` is exactly such a seam -- it is generic over
// its message type so that `provider-runtime` need not import the runtime (R6-4's cycle rule), and
// whether that generic actually INSTANTIATES at the runtime's frozen `HistoryRenderer` is a question
// no test inside `provider-runtime` can ask. So it is asked here, against the real `adapterAsProvider`
// and the real fold, rather than against a hand-copied shape that would only ever agree with itself.

import { describe, expect, test } from "bun:test";
import { CONTINUITY_CASES, claudeTurn, createContinuityWorld, formatContinuityReport, openaiTurn, runContinuityCorpus } from "./continuity.ts";
import { createHistoryRenderer } from "../../../provider-runtime/src/continuity/index.ts";
import { adapterAsProvider, type HistoryRenderer } from "../../../runtime/src/provider/bridge.ts";
import { scriptedAdapter } from "../../../provider-runtime/src/continuity/fixtures.ts";
import type { ProviderMessage, ProviderStreamSink } from "../../../runtime/src/engine.ts";
import type { ProviderContext, ResolvedModel } from "@yanlinglabs/winter-provider-runtime";

describe("the continuity corpus (report §12.3 + §12.4)", () => {
  test("every case passes, and none is missing", async () => {
    const report = await runContinuityCorpus();
    if (!report.ok) throw new Error(formatContinuityReport(report));
    expect(report.outcomes).toHaveLength(CONTINUITY_CASES.length);
    expect(report.outcomes.every((o) => o.status === "passed")).toBe(true);
  });

  test("the eight NAMED transitions of §12.3 are all present, by name", () => {
    const ids = new Set(CONTINUITY_CASES.map((c) => c.id));
    for (const required of [
      "claude-to-openai-warns",
      "openai-to-claude-warns",
      "gemini-to-openai-warns",
      "xai-to-openai-warns",
      "deepseek-to-openai-full-no-warning",
      "deepseek-to-openai-truncated-warns",
      "same-provider-model-profile-no-warning",
      "same-provider-unverified-model-warns",
    ] as const) {
      expect(ids.has(required)).toBe(true);
    }
  });

  test("MINOR 4: the corpus is reachable through the package's OWN barrel, not only by path", async () => {
    const barrel = await import("../index.ts");
    expect(barrel.CONTINUITY_CASES).toBe(CONTINUITY_CASES);
    expect((await barrel.runContinuityCorpus()).ok).toBe(true);
  });

  test("a MISSING case is reported as missing, not silently skipped", async () => {
    const report = await runContinuityCorpus({});
    expect(report.ok).toBe(false);
    expect(report.outcomes.every((o) => o.status === "missing")).toBe(true);
    expect(formatContinuityReport(report)).toContain("FAILED");
  });

  test("a FAILING case is reported with its own message, and the run continues past it", async () => {
    const report = await runContinuityCorpus({
      "claude-to-openai-warns": () => {
        throw new Error("deliberate");
      },
      "openai-to-claude-warns": () => {},
    });
    expect(report.outcomes.find((o) => o.id === "claude-to-openai-warns")).toMatchObject({ status: "failed", detail: "deliberate" });
    expect(report.outcomes.find((o) => o.id === "openai-to-claude-warns")?.status).toBe("passed");
  });
});

describe("the renderer through its REAL consumer", () => {
  const world = createContinuityWorld();

  test("`createHistoryRenderer(registry)` satisfies the runtime's frozen `HistoryRenderer` seam", () => {
    // The assignment IS the assertion: if the generic did not instantiate at `ProviderMessage`, this
    // line would not type-check, and `bun run typecheck` is the gate that says so.
    const renderer: HistoryRenderer = createHistoryRenderer(world.registry);
    const messages: ProviderMessage[] = [claudeTurn("m1", "claude's visible answer") as ProviderMessage, openaiTurn("m2", "openai's visible answer") as ProviderMessage];
    const chain = new Map([
      ["m1", { summary: "claude's summary" }],
      ["m2", { summary: "openai's summary" }],
    ]);
    const rendered = renderer.render(messages, chain, { family: "openai", continuationDomain: "openai/o-reason", readableState: "summary" });
    expect(rendered).toHaveLength(2);
    expect(rendered[1]!.nativeState?.items).toEqual([{ encrypted_content: "OPENAI-ENCRYPTED-OPAQUE" }]);
    expect(JSON.stringify(rendered)).not.toContain("CLAUDE-SIGNATURE-OPAQUE");
    expect(rendered[0]!.decoration?.text).toContain("claude's summary");
  });

  test("through `adapterAsProvider`, the ADAPTER's live request carries the decoration and not one byte of foreign opaque state", async () => {
    const adapter = scriptedAdapter({ id: "openai-adapter", events: [{ type: "text_delta", text: "ok" }, { type: "done", stopReason: "end_turn" }] });
    const resolved = world.registry.resolve({ model: "openai/o-reason" });
    if (resolved instanceof Error) throw resolved;
    const ctx: ProviderContext = {
      connection: { providerId: "openai" },
      credentials: { async get() { return null; }, async set() {}, async delete() {} },
      authRef: { kind: "none" },
      stallTimeoutMs: 1_000,
      log: () => {},
    };
    const provider = adapterAsProvider(resolved as ResolvedModel, ctx, { adapter, renderer: createHistoryRenderer(world.registry) });

    const sinkEvents: unknown[] = [];
    const sink: ProviderStreamSink = {
      onStreamEvent: (event) => sinkEvents.push(event),
      onRetry: (info) => sinkEvents.push(info),
      onRateLimit: (info) => sinkEvents.push(info),
      onAuthStatus: (info) => sinkEvents.push(info),
      onReasoningSummary: (text) => sinkEvents.push(text),
    };
    await provider.generate({
      messages: [claudeTurn("m1", "claude's visible answer") as ProviderMessage],
      model: "o-reason",
      sink,
    });

    // GROUND TRUTH IS THE REQUEST THE ADAPTER ACTUALLY RECEIVED, not what the renderer believed it
    // produced. (The bridge passes an EMPTY chain today -- T3's own disclosed gap and T10's wiring --
    // so the decoration is absent here while the STRIP is not: the strip needs only the message's own
    // annotations, which is why the opaque assertions below hold regardless of that wiring.)
    const request = adapter.requests[0] as { messages: ProviderMessage[] };
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("CLAUDE-SIGNATURE-OPAQUE");
    expect(serialized).not.toContain("CLAUDE-REDACTED-OPAQUE");
    expect(serialized).toContain("claude's visible answer");
    expect(request.messages[0]!.nativeState).toBeUndefined();
    // ... and nothing opaque reached the live sink either.
    expect(JSON.stringify(sinkEvents)).not.toContain("OPAQUE");
  });
});
