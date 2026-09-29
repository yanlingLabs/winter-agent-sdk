// Claude Sonnet 5.5 (2026-09-29): the Messages adapter reads every mid-conversation mechanism off the
// catalog row, so these assertions run against the COMPILED rows (never a hand-built descriptor) and
// prove the three Opus 5.5 behaviours Sonnet 5.5 documents -- per-message effort, a text-carrying
// mid-conversation `system` message, and tool changes by reference and by value -- on both first-party
// providers, while Claude Sonnet 5 (which documents none of them) keeps refusing each one typed.
import { describe, expect, test } from "bun:test";
import { blockBindingBetaFor, buildRequestBody, perMessageEffortBetaFor, toolChangesBetaFor } from "./messages.ts";
import type { ProviderMessageLike, TurnRequest } from "../../types.ts";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";

const catalog = loadCatalog();
const compiled = (key: string): WinterModelDescriptor => {
  const row = catalog.models.find((m) => m.key === key);
  if (row === undefined) throw new Error(`fixture: no compiled catalog row ${key}`);
  return row;
};

const SONNET_55 = ["anthropic/claude-sonnet-5-5", "console/claude-sonnet-5-5"] as const;
const sonnet5 = () => compiled("anthropic/claude-sonnet-5");

const tool = (name: string) => ({ name, description: `${name} tool`, inputSchema: { type: "object" } });
type Wire = Array<{ role: string; content: unknown; output_config?: unknown }>;

/** Turn 1 at `high`, then an effort switch to `low` before turn 2's user message. */
const switched: ProviderMessageLike[] = [
  { role: "user", content: "plan it" },
  { role: "assistant", content: "1. export 2. import" },
  { role: "system", content: [], outputConfig: { effort: "low" } },
  { role: "user", content: "summarize" },
];
const reminder: ProviderMessageLike[] = [{ role: "user", content: "two" }, { role: "system", content: "<system-reminder>\nThe date has changed.\n</system-reminder>" }];
const toolChanges: ProviderMessageLike[] = [
  { role: "user", content: "one" },
  { role: "assistant", content: "r1" },
  { role: "user", content: "two" },
  { role: "system", content: [], toolChanges: { remove: ["B"], add: [{ type: "reference", name: "C" }, { type: "definition", name: "D", description: "D tool", inputSchema: { type: "object" } }] } },
];

function refusalMessage(req: TurnRequest, descriptor: WinterModelDescriptor): string {
  try {
    buildRequestBody(req, descriptor, {});
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a typed refusal");
}

describe("Claude Sonnet 5.5 on the Messages adapter (compiled catalog rows)", () => {
  for (const key of SONNET_55) {
    const row = () => compiled(key);

    test(`${key}: per-message effort -- the marker is its own \`system\` entry, the top-level effort stays put, and the beta rides the request`, () => {
      const body = buildRequestBody({ model: "claude-sonnet-5-5", messages: switched, effort: "high" }, row(), {});
      const wire = body["messages"] as Wire;
      expect(wire.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
      expect(wire[2]).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
      expect(body["output_config"]).toEqual({ effort: "high" });
      expect(perMessageEffortBetaFor(body, row())).toBe("mid-conversation-output-config-2026-07-01");
    });

    test(`${key}: a text-carrying mid-conversation \`system\` message is sent as its own entry after the user turn`, () => {
      const body = buildRequestBody({ model: "claude-sonnet-5-5", messages: reminder }, row(), {});
      const wire = body["messages"] as Wire;
      expect(wire.map((m) => m.role)).toEqual(["user", "system"]);
      expect(JSON.stringify(wire[1])).toContain("The date has changed.");
    });

    test(`${key}: mid-conversation tool changes by reference AND by value, under the inline beta (it covers references)`, () => {
      const body = buildRequestBody({ model: "claude-sonnet-5-5", messages: toolChanges, tools: [tool("A"), tool("B"), tool("C")] }, row(), {});
      const system = (body["messages"] as Wire).at(-1)!;
      expect(system.role).toBe("system");
      expect(system.content).toEqual([
        { type: "tool_removal", tool: { type: "tool_reference", name: "B" } },
        { type: "tool_addition", tool: { type: "tool_reference", name: "C" } },
        { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "D", description: "D tool", input_schema: { type: "object" } } } },
      ]);
      expect(toolChangesBetaFor(body, row())).toBe("inline-tools-2026-09-15");
      // The `tools` array itself -- the head of the cached prefix -- is exactly what was declared.
      expect((body["tools"] as Array<{ name: string }>).map((t) => t.name)).toEqual(["A", "B", "C"]);
    });

    test(`${key}: \`thinking: disabled\` (a 400 on this model) is never sent -- adaptive with the block-binding opt-in instead`, () => {
      const body = buildRequestBody({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } }, row(), {});
      expect(body["thinking"]).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
      expect(blockBindingBetaFor(body, row())).toBe("thinking-binding-controls-2026-08-01");
    });
  }

  test("Claude Sonnet 5 documents none of the three, and each is still refused typed before the request", () => {
    expect(refusalMessage({ model: "claude-sonnet-5", messages: switched, effort: "high" }, sonnet5())).toContain("does not document per-message effort");
    expect(refusalMessage({ model: "claude-sonnet-5", messages: reminder }, sonnet5())).toContain("does not document mid-conversation system messages");
    expect(refusalMessage({ model: "claude-sonnet-5", messages: toolChanges, tools: [tool("A"), tool("B"), tool("C")] }, sonnet5())).toContain("documents no mid-conversation tool changes");
  });
});
