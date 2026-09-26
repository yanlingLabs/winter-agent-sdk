// WS-23 (midconv): the Responses body builder's mid-conversation mechanisms, asserted on the request
// body it produces. Kept in its own file so other lanes' edits to `responses.test.ts` never collide.
//   - item 1: the engine's effort-only `system` marker -> `configuration_update`, gated on the row.
import { describe, expect, test } from "bun:test";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { ProviderRequestError } from "../../http.ts";
import type { ProviderMessageLike, TurnRequest } from "../../types.ts";
import { assertConfigurationUpdates, buildResponsesBody, CONFIGURATION_UPDATE_PLACEMENT, mapResponsesInput } from "./responses.ts";
import { resolveReasoning } from "./shared.ts";
import { descriptor } from "./testing.ts";

const ev = <T,>(value: T) => ({ value, source: "official-doc" as const, confidence: "declared" as const });
/** A gpt-6-shaped row: the configuration_update item documented. */
const gpt6 = (): WinterModelDescriptor => {
  const row = descriptor({ key: "openai/gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" });
  return { ...row, reasoning: { ...row.reasoning!, perMessageEffort: ev({ item: "configuration_update" as const }) } };
};
const marker = (effort: string): ProviderMessageLike => ({ role: "system", content: [], outputConfig: { effort } });
const cfg = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const asst = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

const switched: ProviderMessageLike[] = [marker("high"), { role: "user", content: "one" }, { role: "assistant", content: "r1" }, marker("low"), { role: "user", content: "two" }];

describe("configuration_update (WS-23 midconv item 1)", () => {
  test("the documented placement is the default: the update sits BEFORE the user message it applies to", () => {
    expect(CONFIGURATION_UPDATE_PLACEMENT).toBe("before-user");
    expect(mapResponsesInput(switched)).toEqual([cfg("high"), user("one"), asst("r1"), cfg("low"), user("two")]);
  });

  test("Codex's placement is one option away (what the probe flips): the update follows the user message", () => {
    expect(mapResponsesInput(switched, { configurationUpdatePlacement: "after-user" })).toEqual([user("one"), cfg("high"), asst("r1"), user("two"), cfg("low")]);
  });

  test("never two updates side by side: the later one wins, and the decision is local (byte-stable on replay)", () => {
    const adjacent: ProviderMessageLike[] = [marker("high"), marker("low"), { role: "user", content: "summary" }, { role: "assistant", content: "r" }, marker("max"), { role: "user", content: "next" }];
    const first = mapResponsesInput(adjacent);
    expect(first).toEqual([cfg("low"), user("summary"), asst("r"), cfg("max"), user("next")]);
    // Appending a turn leaves every earlier item exactly as it was.
    const later = mapResponsesInput([...adjacent, { role: "assistant", content: "r2" }, { role: "user", content: "again" }]);
    expect(later.slice(0, first.length)).toEqual(first);
  });

  test("the top-level `reasoning.effort` is the frozen value the engine sent, whatever the updates say", () => {
    const r: TurnRequest = { model: "gpt-6-astra", messages: switched, effort: "high" };
    const body = buildResponsesBody(r, resolveReasoning(r, gpt6()), gpt6());
    expect(body["reasoning"]).toEqual({ effort: "high" });
    expect((body["input"] as unknown[]).filter((i) => (i as { type?: string }).type === "configuration_update")).toEqual([cfg("high"), cfg("low")]);
    // Never a system/developer message for effort.
    expect((body["input"] as Array<{ role?: string }>).some((i) => i.role === "system")).toBe(false);
  });

  test("the gate: a row without the item, a row recording Anthropic's beta, or a level outside the vocabulary is a typed refusal before the request", () => {
    const refuse = (row: WinterModelDescriptor, messages = switched): ProviderRequestError => {
      try {
        assertConfigurationUpdates({ model: "m", messages }, row);
      } catch (err) {
        return err as ProviderRequestError;
      }
      throw new Error("expected a refusal");
    };
    expect(refuse(descriptor({ key: "openai/gpt-5.6" })).code).toBe("capability");
    const anthropicShaped = { ...gpt6(), reasoning: { ...gpt6().reasoning!, perMessageEffort: ev({ beta: "mid-conversation-output-config-2026-07-01" as const }) } };
    expect(refuse(anthropicShaped).message).toContain("configuration_update");
    expect(refuse(gpt6(), [marker("minimal"), { role: "user", content: "x" }]).message).toContain("verified vocabulary");
    expect(() => assertConfigurationUpdates({ model: "m", messages: switched }, gpt6())).not.toThrow();
    // No marker, no gate: every row without the evidence keeps working.
    expect(() => assertConfigurationUpdates({ model: "m", messages: [{ role: "user", content: "x" }] }, descriptor())).not.toThrow();
  });
});
