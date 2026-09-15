// Fix round 3 (P10b-6, W18-17): the END-TO-END proof that the reader fix (resume.ts's
// `message.model` carry) actually reaches the renderer.
//
// `renderer.ts`'s own unit test (`officialClaudeMessage()` in provider-runtime) hand-constructs a
// `ProviderMessageLike & { model: string }` and proves the RENDERER half works -- but its own
// comment says the reader that actually attaches `.model` off a real transcript lives in "a later
// lane." This file is that lane: it drives the REAL `toDialectEntries` + `rebuildProviderMessages`
// (resume.ts) over a canonical file shaped like the pinned claude binary's own JSONL output, then
// feeds the REAL result into the REAL `createHistoryRenderer` (provider-runtime), through a REAL
// catalog-backed registry -- proving the two lanes actually meet, not just that each one
// independently believes the other does its part.
import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { ProviderAdapter, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import { createRegistry, createHistoryRenderer, RECOVERED_REASONING_TAG, type ProviderRegistry, type HistoryTarget } from "@yanlinglabs/winter-provider-runtime";
import type { SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { toDialectEntries, rebuildProviderMessages } from "./resume.ts";

function stubAdapter(adapterId: string): ProviderAdapter {
  const notCalled = (member: string) => (): never => {
    throw new Error(`resume-renderer.test.ts: stub adapter "${adapterId}" had ${member} called`);
  };
  return {
    id: adapterId,
    version: "stub-for-endpoint-resolution-only",
    family: "custom",
    protocol: "custom",
    validateCredential: notCalled("validateCredential"),
    listModels: notCalled("listModels"),
    streamTurn: notCalled("streamTurn"),
    mapEffort: notCalled("mapEffort"),
    capabilities: notCalled("capabilities"),
  };
}

function realCatalogRegistry(): ProviderRegistry {
  const catalog = loadCatalog();
  const registry = createRegistry(catalog);
  const seen = new Set<string>();
  for (const provider of catalog.providers) {
    if (seen.has(provider.adapterId)) continue;
    seen.add(provider.adapterId);
    registry.register(stubAdapter(provider.adapterId));
  }
  return registry;
}

/** The GPT target this file resumes toward -- `openai/gpt-5.6-sol`, the exact model named in the reported symptom. */
function gptTarget(registry: ProviderRegistry): HistoryTarget {
  const resolved = registry.resolve({ model: "openai/gpt-5.6-sol" });
  if (resolved instanceof Error) throw resolved;
  return { family: resolved.provider.family, readableState: "none" };
}

describe("reader -> renderer, end to end: an official-leg-shaped canonical file resumed toward a GPT target (fix round 3)", () => {
  // Field names mirror the real pinned binary's own JSONL (see
  // packages/conformance/goldens/claude-2.1.250/compaction.jsonl for the sibling shapes this
  // repo already captures from it): `message.id`/`message.model` present, a `thinking` block
  // carrying a dummy (non-real) signature.
  const canonicalFile: SessionStoreEntry[] = [
    { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "what should I do next" } },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      message: {
        id: "msg_01ABCDEFDUMMYID",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-20260101",
        content: [
          { type: "thinking", thinking: "first I should weigh option A against option B", signature: "SIG-DUMMY-NOT-REAL-OPAQUE-BASE64==" },
          { type: "text", text: "You should pick option B." },
        ],
      },
    },
  ];

  test("yields exactly one <recovered_reasoning kind=\"summary\" provider=\"anthropic\" model=\"...\"> carrying the thinking text, with no signature and no redacted_thinking anywhere in the rendered output", () => {
    const registry = realCatalogRegistry();
    const rebuilt = rebuildProviderMessages(toDialectEntries(canonicalFile));
    const renderer = createHistoryRenderer(registry);
    const { messages, report } = renderer.renderWithReport(rebuilt as ProviderMessageLike[], new Map(), gptTarget(registry));

    expect(report.decorations).toHaveLength(1);
    expect(report.decorations[0]).toMatchObject({ kind: "summary", source: { providerId: "anthropic", modelKey: "claude-sonnet-5-20260101" } });

    const decoration = messages[1]!.decoration;
    expect(decoration).toBeDefined();
    expect(decoration!.text).toBe(
      `<${RECOVERED_REASONING_TAG} kind="summary" provider="anthropic" model="claude-sonnet-5-20260101">first I should weigh option A against option B</${RECOVERED_REASONING_TAG}>`,
    );

    const wireShape = JSON.stringify(messages);
    expect(wireShape).not.toContain("signature");
    expect(wireShape).not.toContain("redacted_thinking");
    expect(wireShape).not.toContain("SIG-DUMMY-NOT-REAL-OPAQUE-BASE64==");
    // The visible final answer still crosses, byte-identical.
    expect(wireShape).toContain("You should pick option B.");
  });

  test("REGRESSION GUARD: without the reader fix (message.model stripped by hand, simulating the old projection), no tag is produced at all", () => {
    const registry = realCatalogRegistry();
    const rebuilt = rebuildProviderMessages(toDialectEntries(canonicalFile));
    const stripped = rebuilt.map((m) => {
      const { model: _model, ...rest } = m as unknown as { model?: string } & typeof m;
      return rest;
    });
    const { report } = createHistoryRenderer(registry).renderWithReport(stripped as ProviderMessageLike[], new Map(), gptTarget(registry));
    expect(report.decorations).toHaveLength(0);
  });
});

describe("reverse control: a Winter-native turn with NO message.model resolves through the SIDECAR, unaffected by this fix", () => {
  test("origin comes from the chain (sidecar), not from message.model, and the tag still renders", () => {
    const registry = realCatalogRegistry();
    const claudeSonnet = registry.resolve({ model: "anthropic/claude-sonnet-5" });
    if (claudeSonnet instanceof Error) throw claudeSonnet;

    // A Winter-native transcript entry: NO message.model, exactly what dialect.ts's own
    // `assistantEntry` writes (W18-11's own reason it never carries one).
    const canonicalFile: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "the visible answer" }] } },
    ];
    const rebuilt = rebuildProviderMessages(toDialectEntries(canonicalFile));
    expect((rebuilt[1] as unknown as { model?: string }).model).toBeUndefined();

    // The sidecar chain -- what engine.ts's recordAssistant/turnProvenance would have written for
    // a REAL Winter-run Claude turn (any provider, e.g. Claude on OpenRouter).
    const chain = new Map([["a1", { origin: { providerId: claudeSonnet.providerId, modelKey: claudeSonnet.modelKey, family: claudeSonnet.provider.family }, summary: "the captured reasoning summary" }]]);

    const { messages, report } = createHistoryRenderer(registry).renderWithReport(rebuilt as ProviderMessageLike[], chain, gptTarget(registry));
    expect(report.decorations).toHaveLength(1);
    expect(messages[1]!.decoration!.text).toContain("the captured reasoning summary");
    expect(messages[1]!.decoration!.text).toContain(`provider="${claudeSonnet.providerId}"`);
  });
});
