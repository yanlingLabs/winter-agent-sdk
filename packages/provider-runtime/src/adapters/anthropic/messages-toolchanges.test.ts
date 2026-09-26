// WS-23 (midconv) items 2-3: mid-conversation tool changes on the Messages API, asserted on the REQUEST
// BODY and the beta list the adapter derives -- `tool_addition` / `tool_removal` blocks in a
// `role: "system"` message (https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages),
// the beta riding every request that opts in, and the typed refusals for a row without the evidence.
import { describe, expect, test } from "bun:test";
import { buildRequestBody, toolChangesBetaFor, toWireMessages, withMessageCacheMarker } from "./messages.ts";
import { ProviderRequestError } from "../../http.ts";
import type { ProviderMessageLike, TurnRequest } from "../../types.ts";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";

const evidence = <T,>(value: T) => ({ value, source: "official-doc" as const, confidence: "declared" as const });
const stampRow = (row: Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">): WinterModelDescriptor => stampFamilyFields([row], [])[0]!;

const row = (over: Partial<WinterModelDescriptor> = {}): WinterModelDescriptor =>
  stampRow({
    key: "anthropic/claude-opus-5-5",
    providerId: "anthropic",
    upstreamId: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    aliases: [],
    endpoints: ["chat"],
    inputModalities: evidence(["text", "image"]),
    outputModalities: evidence(["text"]),
    toolCalling: evidence("native" as const),
    nativeTools: evidence(true),
    promptCaching: evidence(true),
    deferredToolLoading: evidence(true),
    unsupportedParameters: [],
    status: "candidate",
    ...over,
  });
const reference = () => row({ midConversationToolChanges: evidence({ beta: "mid-conversation-tool-changes-2026-07-01" as const }) });
const inline = () => row({ midConversationToolChanges: evidence({ beta: "mid-conversation-tool-changes-2026-07-01" as const }), inlineToolDefinitions: evidence({ beta: "inline-tools-2026-09-15" as const }) });
const sonnet5 = () => row({ key: "anthropic/claude-sonnet-5", upstreamId: "claude-sonnet-5" });

const tool = (name: string, deferLoading?: true) => ({ name, description: `${name} tool`, inputSchema: { type: "object" }, ...(deferLoading === true ? { deferLoading } : {}) });
const change = (toolChanges: NonNullable<ProviderMessageLike["toolChanges"]>): ProviderMessageLike => ({ role: "system", content: [], toolChanges });

const history: ProviderMessageLike[] = [
  { role: "user", content: "one" },
  { role: "assistant", content: "r1" },
  { role: "user", content: "two" },
  change({ remove: ["B"], add: [{ type: "reference", name: "C" }, { type: "definition", name: "D", description: "D tool", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] }),
];

function refusal(req: TurnRequest, descriptor: WinterModelDescriptor): ProviderRequestError {
  try {
    buildRequestBody(req, descriptor, {});
  } catch (err) {
    return err as ProviderRequestError;
  }
  throw new Error("expected a typed refusal");
}

describe("tool_addition / tool_removal on the wire (WS-23 midconv)", () => {
  test("the documented block shapes, removals first, in their own system message after the user turn", () => {
    const wire = toWireMessages(history);
    expect(wire.map((m) => m.role)).toEqual(["user", "assistant", "user", "system"]);
    expect(wire[3]).toEqual({
      role: "system",
      content: [
        { type: "tool_removal", tool: { type: "tool_reference", name: "B" } },
        { type: "tool_addition", tool: { type: "tool_reference", name: "C" } },
        { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "D", description: "D tool", input_schema: { type: "object", properties: { q: { type: "string" } } } } } },
      ],
    });
  });

  test("the rolling breakpoint lands on the BLOCK, never inside a definition (the docs: one or the other, not both)", () => {
    const marked = withMessageCacheMarker(toWireMessages(history));
    const last = marked[3]!.content.at(-1)!;
    expect(last["cache_control"]).toEqual({ type: "ephemeral" });
    expect((last["tool"] as { definition: Record<string, unknown> }).definition).not.toHaveProperty("cache_control");
  });

  test("the beta: the inline one on an inline row (it covers references), the reference one otherwise -- and on EVERY opted-in request, change or not", () => {
    const req = { model: "claude-opus-5-5", messages: history, tools: [tool("A"), tool("B"), tool("C", true)] } satisfies TurnRequest;
    expect(toolChangesBetaFor(buildRequestBody(req, inline(), {}), inline())).toBe("inline-tools-2026-09-15");
    const plain = buildRequestBody({ model: "claude-opus-5-5", messages: [{ role: "user", content: "one" }], tools: [tool("A")] }, reference(), {});
    expect(toolChangesBetaFor(plain, reference())).toBeUndefined();
    expect(toolChangesBetaFor(plain, reference(), true)).toBe("mid-conversation-tool-changes-2026-07-01");
    expect(toolChangesBetaFor(plain, inline(), true)).toBe("inline-tools-2026-09-15");
  });

  test("typed refusals before the request: no evidence (Sonnet 5), a definition on a reference-only row, a reference to an undeclared tool", () => {
    const tools = [tool("A"), tool("B"), tool("C", true)];
    expect(refusal({ model: "claude-sonnet-5", messages: history, tools }, sonnet5()).message).toContain("documents no mid-conversation tool changes");
    expect(refusal({ model: "claude-opus-5-5", messages: history, tools }, reference()).message).toContain("cannot be defined by value");
    const onlyReference = [...history.slice(0, 3), change({ remove: [], add: [{ type: "reference", name: "Nope" }] })];
    expect(refusal({ model: "claude-opus-5-5", messages: onlyReference, tools }, reference()).message).toContain("tool_reference_unresolved");
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: history, tools }, inline(), {})).not.toThrow();
  });
});
