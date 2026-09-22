// A MODEL'S OWN PRIOR REASONING IS NEVER FOREIGN MATERIAL -- probed against the REAL catalog.
//
// THE BUG THIS FILE PINS (dist session s_5d314c81045e, `deepseek-anthropic/deepseek-v4-flash`,
// generation 1, never resumed, never handed off): a visible assistant message began with
// `<recovered_reasoning kind="summary" provider="deepseek-anthropic" model="deepseek-anthropic/deepseek-v4-flash">`
// and the model's own chain of thought. The chain that produced it, every link read off this
// repository:
//
//   1. the row declares `reasoning.continuation: "none"`, so `registry.ts`'s `continuationDomainOf`
//      mints NO domain id for it -- on the bridge's target and on the engine's stamped origin alike;
//   2. `sameDomain(undefined, undefined)` is false BY DESIGN (absence is "undocumented", never a
//      wildcard), so the model's own previous step fell into the renderer's CROSS-DOMAIN branch;
//   3. that branch stripped the model's own thinking blocks and, through the W18-17 fallback, turned
//      their visible text into "material" (`kind: "summary"`, because the row's readable state is
//      `"none"`), which pass 2 wrapped in the tag door;
//   4. the Anthropic adapter placed that tag as an ordinary TEXT block in the assistant turn -- the
//      model then read its own reasoning as quoted text in its own mouth, and imitated the tag.
//
// The same shape reaches every OpenAI-chat row with reasoning and `continuation: "none"`: the adapter
// emits `thinking_exposed_delta` unconditionally, the engine records it as the anchor's sidecar
// `summary`, and the cross-domain branch decorates the model's own exposed reasoning.
//
// THE RULE (claude parity): claude replays its own thinking blocks to the model that produced them,
// natively, and never shows a model its own reasoning as quoted text. A message produced by the SAME
// provider and the SAME model as the target is therefore the model's own turn -- replayed exactly,
// never decorated -- whatever the catalog says about continuation domains. Decoration stays what it
// was built for: labelled data from a genuinely FOREIGN model.
//
// Built the way `real-catalog.test.ts` and `zai-glm-real-catalog.test.ts` build theirs -- the REAL
// catalog, the REAL registry, the target expression the REAL bridge constructs -- because every
// hand-built fixture in this lane carried a domain id, which is exactly the fact that hid this.
import { describe, expect, test } from "bun:test";
import { loadCatalog, type WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { createRegistry, type ProviderRegistry } from "../registry.ts";
import type { ContentBlockLike, MessageOrigin, ProviderMessageLike } from "../types.ts";
import { toWireMessages } from "../adapters/anthropic/messages.ts";
import { mapChatMessages } from "../adapters/openai/chat-completions.ts";
import { createShippedAdapters } from "../adapters/index.ts";
import { RECOVERED_REASONING_TAG } from "./decoration.ts";
import { createHistoryRenderer, type ContinuationChainLike, type ContinuationLinkLike, type HistoryTarget } from "./renderer.ts";

/** The real catalog with the REAL shipped adapters -- `capabilities()` is what the bridge reads the target's readable state from. */
function realRegistry(): ProviderRegistry {
  const catalog = loadCatalog();
  const registry = createRegistry(catalog);
  for (const adapter of createShippedAdapters(catalog)) registry.register(adapter);
  return registry;
}

/** Every reasoning row the catalog gives NO continuation domain -- the population the bug lives in. */
function reasoningRowsWithoutDomain(adapterId: string): WinterModelDescriptor[] {
  const catalog = loadCatalog();
  const adapterOf = new Map(catalog.providers.map((p) => [p.id, p.adapterId]));
  return catalog.models.filter(
    (m) => adapterOf.get(m.providerId) === adapterId && m.status !== "blocked" && m.reasoning?.supported.value === true && m.reasoning.continuation === "none",
  );
}

/**
 * EXACTLY what `adapterAsProvider` (runtime `bridge.ts`) builds for `target`: the adapter's family,
 * the registry's own continuation domain, the adapter's readable state -- and the resolved model's
 * own identity, which is what lets the renderer recognise the model's own prior turns.
 */
function bridgeTarget(registry: ProviderRegistry, modelKey: string): { target: HistoryTarget; origin: MessageOrigin } {
  const resolved = registry.resolve({ model: modelKey });
  if (resolved instanceof Error) throw resolved;
  const capabilities = resolved.descriptor !== undefined ? resolved.adapter.capabilities(resolved.descriptor) : undefined;
  const target: HistoryTarget = {
    family: resolved.adapter.family,
    ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}),
    readableState: capabilities?.readableState ?? "none",
    providerId: resolved.providerId,
    modelKey: resolved.modelKey,
  };
  // EXACTLY what the engine stamps on an assistant message it produced (`providerAnnotations`).
  const origin: MessageOrigin = {
    providerId: resolved.providerId,
    modelKey: resolved.modelKey,
    family: resolved.adapter.family,
    ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}),
  };
  return { target, origin };
}

const chainOf = (entries: Record<string, ContinuationLinkLike>): ContinuationChainLike => new Map(Object.entries(entries));

const OWN_THINKING = "the model's own step-1 reasoning: I should list the files first";
const OWN_SIGNATURE = "sig-own-step-1";

/** One multi-step Anthropic-dialect turn as the engine holds it after step 1: the model thought, then called a tool, and the result came back. */
function anthropicTurn(origin: MessageOrigin): ProviderMessageLike[] {
  return [
    { role: "user", content: "what is in this directory?" },
    {
      role: "assistant",
      uuid: "a1",
      origin,
      content: [
        { type: "thinking", thinking: OWN_THINKING, signature: OWN_SIGNATURE },
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
      ],
    },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "README.md\nsrc" }] },
  ];
}

function wireTexts(wire: Array<{ content: Record<string, unknown>[] }>): string[] {
  return wire.flatMap((m) => m.content.filter((b) => b["type"] === "text").map((b) => String(b["text"])));
}

describe("the model's OWN reasoning is replayed natively, never decorated -- Anthropic-dialect rows with no continuation domain", () => {
  const rows = reasoningRowsWithoutDomain("winter.anthropic-messages");

  test("the probe has real rows to examine, and the reported row is one of them (a vacuous pass is not a pass)", () => {
    expect(rows.map((m) => m.key)).toContain("deepseek-anthropic/deepseek-v4-flash");
  });

  test.each(rows.map((m) => [m.key] as const))("%s: step 2's request carries step 1's thinking block natively and no <recovered_reasoning> text", (modelKey) => {
    const registry = realRegistry();
    const { target, origin } = bridgeTarget(registry, modelKey);
    // The engine's in-memory chain entry for step 1: origin only -- this adapter captures no summary.
    const { messages, report } = createHistoryRenderer(registry).renderWithReport(anthropicTurn(origin), chainOf({ a1: { origin } }), target);

    expect(report.decorations).toHaveLength(0);
    expect(report.strippedInDialectBlocks).toBe(0);
    expect(report.withoutMaterial).toBe(0);
    expect(messages[1]!.decoration).toBeUndefined();

    // The wire: the thinking block rides IN-DIALECT with its own signature (what claude sends back to
    // the model that produced it), and no text block anywhere quotes it.
    const wire = toWireMessages(messages);
    const assistant = wire.find((m) => m.role === "assistant")!;
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: OWN_THINKING, signature: OWN_SIGNATURE });
    for (const text of wireTexts(wire)) {
      expect(text).not.toContain(RECOVERED_REASONING_TAG);
      expect(text).not.toContain(OWN_THINKING);
    }
  });
});

/**
 * EVERY Anthropic-dialect row the registry gives no domain -- WITH OR WITHOUT a reasoning block. The
 * self path does not read the reasoning flag (claude replays a model's own thinking whatever a catalog
 * says about it), so a row with no reasoning block at all -- `zai-anthropic`'s GLM rows,
 * `minimax-anthropic`, the plain `anthropic`/`console` rows -- takes it too: if its endpoint does emit
 * thinking, that thinking used to leak exactly like deepseek-anthropic's.
 */
function anthropicDialectRowsWithoutDomain(): WinterModelDescriptor[] {
  const catalog = loadCatalog();
  const adapterOf = new Map(catalog.providers.map((p) => [p.id, p.adapterId]));
  const blocked = new Set(catalog.providers.filter((p) => p.risk.class === "blocked").map((p) => p.id));
  return catalog.models.filter(
    (m) => adapterOf.get(m.providerId) === "winter.anthropic-messages" && !blocked.has(m.providerId) && m.status !== "blocked" && (m.reasoning === undefined || m.reasoning.continuation === "none"),
  );
}

describe("every domain-less Anthropic-dialect row replays its own turn natively -- reasoning block or not", () => {
  const rows = anthropicDialectRowsWithoutDomain();

  test("the probe covers the rows with NO reasoning block too, including minimax-anthropic and zai-anthropic", () => {
    const providers = new Set(rows.map((m) => m.providerId));
    expect(providers.has("minimax-anthropic")).toBe(true);
    expect(providers.has("zai-anthropic")).toBe(true);
    expect(rows.some((m) => m.reasoning === undefined)).toBe(true);
  });

  test.each(rows.map((m) => [m.key] as const))("%s: its own thinking block rides back in-dialect, no tag", (modelKey) => {
    const registry = realRegistry();
    const { target, origin } = bridgeTarget(registry, modelKey);
    expect(target.continuationDomain).toBeUndefined();
    const { messages, report } = createHistoryRenderer(registry).renderWithReport(anthropicTurn(origin), chainOf({ a1: { origin } }), target);
    expect(report.decorations).toHaveLength(0);
    expect(report.strippedInDialectBlocks).toBe(0);
    const assistant = toWireMessages(messages).find((m) => m.role === "assistant")!;
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: OWN_THINKING, signature: OWN_SIGNATURE });
    expect(JSON.stringify(toWireMessages(messages))).not.toContain(RECOVERED_REASONING_TAG);
  });
});

describe("the model's OWN exposed reasoning is never decorated -- OpenAI-chat rows with no continuation domain", () => {
  const rows = reasoningRowsWithoutDomain("winter.openai-chat-completions");

  test("the probe has real rows to examine", () => {
    expect(rows.length).toBeGreaterThan(10);
  });

  test.each(rows.map((m) => [m.key] as const))("%s: its own sidecar reasoning does not come back to it as a tagged text prefix", (modelKey) => {
    const registry = realRegistry();
    const { target, origin } = bridgeTarget(registry, modelKey);
    const history: ProviderMessageLike[] = [
      { role: "user", content: "hi" },
      { role: "assistant", uuid: "a1", origin, content: [{ type: "text", text: "the visible answer" }] },
      { role: "user", content: "and then?" },
    ];
    // What `turnProvenance` records for a turn whose only reasoning is the model's own `reasoning_content`.
    const { messages, report } = createHistoryRenderer(registry).renderWithReport(history, chainOf({ a1: { origin, summary: "own raw chain of thought" } }), target);
    expect(report.decorations).toHaveLength(0);
    expect(messages[1]!.decoration).toBeUndefined();
    const wire = JSON.stringify(mapChatMessages(messages, false));
    expect(wire).not.toContain(RECOVERED_REASONING_TAG);
    expect(wire).not.toContain("own raw chain of thought");
  });
});

describe("genuinely FOREIGN material is still decorated (the fix did not become a blanket suppression)", () => {
  test("a DIFFERENT model on the SAME provider is foreign: deepseek-v4-pro's turn reaching deepseek-v4-flash is carried as labelled data", () => {
    const registry = realRegistry();
    const { target } = bridgeTarget(registry, "deepseek-anthropic/deepseek-v4-flash");
    const { origin: proOrigin } = bridgeTarget(registry, "deepseek-anthropic/deepseek-v4-pro");
    const { messages, report } = createHistoryRenderer(registry).renderWithReport(anthropicTurn(proOrigin), chainOf({ a1: { origin: proOrigin } }), target);
    expect(report.decorations).toHaveLength(1);
    expect(report.decorations[0]!.source).toEqual({ providerId: "deepseek-anthropic", modelKey: "deepseek-anthropic/deepseek-v4-pro" });
    // Its thinking block is another model's opaque state and comes off.
    expect((messages[1]!.content as ContentBlockLike[]).some((b) => b.type === "thinking")).toBe(false);
    expect(messages[1]!.decoration?.text).toContain(`<${RECOVERED_REASONING_TAG} kind="summary" provider="deepseek-anthropic" model="deepseek-anthropic/deepseek-v4-pro">`);
  });

  test("another PROVIDER's model in the same dialect is foreign: kimi-coding's turn reaching deepseek-anthropic is carried as labelled data", () => {
    const registry = realRegistry();
    const { target } = bridgeTarget(registry, "deepseek-anthropic/deepseek-v4-flash");
    const { origin: kimiOrigin } = bridgeTarget(registry, "kimi-coding/k3");
    const { report } = createHistoryRenderer(registry).renderWithReport(anthropicTurn(kimiOrigin), chainOf({ a1: { origin: kimiOrigin } }), target);
    expect(report.decorations.map((d) => d.source.modelKey)).toEqual(["kimi-coding/k3"]);
  });

  test("a target that does not name its own identity (a caller built before the field existed) behaves exactly as before", () => {
    const registry = realRegistry();
    const { target, origin } = bridgeTarget(registry, "deepseek-anthropic/deepseek-v4-flash");
    const { providerId: _p, modelKey: _m, ...anonymous } = target;
    const { report } = createHistoryRenderer(registry).renderWithReport(anthropicTurn(origin), chainOf({ a1: { origin } }), anonymous);
    expect(report.decorations).toHaveLength(1);
  });
});
