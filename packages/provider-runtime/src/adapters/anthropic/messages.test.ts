// Phase 6 Task 6 (Lane B): the Anthropic adapter's PURE half.
//
// The wire behaviour is proved against the loopback fake in
// `packages/provider-conformance/src/corpus/anthropic.test.ts` -- the ground truth for what a
// provider was asked is the live request it received, and that package is where the fake lives.
// What is left here is what has no wire at all: the message/block transformation, the effort
// vocabulary, the capability read, and the endpoint-policy refusals that happen before a URL exists.
import { describe, expect, test } from "bun:test";
import { createAnthropicMessagesAdapter, mapAnthropicEffort, toWireMessages } from "./index.ts";
import type { CredentialMaterial, CredentialRef, ProviderContext } from "../../types.ts";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";

const evidence = <T>(value: T) => ({ value, source: "upstream-static" as const, confidence: "inferred" as const });

const descriptor = (over: Partial<WinterModelDescriptor> = {}): WinterModelDescriptor => ({
  key: "anthropic/claude-sonnet-5",
  providerId: "anthropic",
  upstreamId: "claude-sonnet-5",
  displayName: "Claude Sonnet 5",
  aliases: ["sonnet"],
  endpoints: ["chat"],
  inputModalities: evidence(["text", "image"]),
  outputModalities: evidence(["text"]),
  toolCalling: evidence("native" as const),
  nativeTools: evidence(true),
  unsupportedParameters: [],
  status: "candidate",
  ...over,
});

const noCredentials = {
  async get(_ref: CredentialRef): Promise<CredentialMaterial | null> {
    return null;
  },
  async set(): Promise<void> {},
  async delete(): Promise<void> {},
};

const ctx = (baseUrl: string, local?: boolean): ProviderContext => ({
  connection: { providerId: "anthropic", baseUrl, ...(local === true ? { local: true } : {}) },
  credentials: noCredentials,
  authRef: { kind: "none" },
  stallTimeoutMs: 1_000,
  log: () => {},
});

describe("toWireMessages", () => {
  test("a `tool` role becomes a `user` message -- the wire has no tool role", () => {
    expect(toWireMessages([{ role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "out" }] }])).toEqual([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "out" }] },
    ]);
  });

  test("thinking and redacted_thinking pass through VERBATIM -- signature and opaque data intact", () => {
    const wire = toWireMessages([
      { role: "assistant", content: [{ type: "thinking", thinking: "why", signature: "sig-abc" }, { type: "redacted_thinking", data: "opaque-xyz" }] },
    ]);
    // R6-8 at the only place it can be enforced: nothing here strips, re-signs or normalizes.
    expect(wire[0]!.content).toEqual([{ type: "thinking", thinking: "why", signature: "sig-abc" }, { type: "redacted_thinking", data: "opaque-xyz" }]);
  });

  test("a signature that is the EMPTY STRING survives -- capture (F)'s normalisation is replayed, not dropped", () => {
    const wire = toWireMessages([{ role: "assistant", content: [{ type: "thinking", thinking: "unsigned", signature: "" }] }]);
    expect(wire[0]!.content).toEqual([{ type: "thinking", thinking: "unsigned", signature: "" }]);
  });

  test("adjacent same-role messages merge, empty ones vanish, and `tool_result` blocks are HOISTED to the front of the merged turn", () => {
    // The hoist is a WIRE RULE, not a preference: this endpoint requires `tool_result` blocks at the
    // start of the turn they ride, and the merge means the constraint is a property of the assembled
    // ENTRY rather than of any one message. An earlier version of this test pinned
    // `[text, tool_result]` -- correct per message, and a request the endpoint rejects.
    expect(
      toWireMessages([
        { role: "user", content: "a" },
        { role: "user", content: [] },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "b" }] },
        { role: "assistant", content: "c" },
      ]),
    ).toEqual([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "b" }, { type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "c" }] },
    ]);
  });

  test("a LATER merged assistant message's leading thinking is hoisted ahead of an earlier message's text", () => {
    // Recorded because it is a real consequence of assembling per merged ENTRY rather than per
    // message, and it was uncovered. It is the wire-correct direction: with thinking enabled this
    // endpoint wants the turn's thinking blocks first, and before the buckets the same input produced
    // `[text, thinking, text]` -- an ordering the endpoint rejects.
    expect(
      toWireMessages([
        { role: "assistant", content: [{ type: "text", text: "x" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "why", signature: "s1" }, { type: "text", text: "y" }] },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "why", signature: "s1" }, { type: "text", text: "x" }, { type: "text", text: "y" }],
      },
    ]);
  });

  test("a blocks-valued tool_result nests its inner blocks rather than stringifying them", () => {
    const wire = toWireMessages([
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "page 1" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }] },
    ]);
    expect(wire[0]!.content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "page 1" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] },
    ]);
  });
});

describe("mapEffort", () => {
  test("a named tier the model DECLARES maps onto its budget; one it does not is refused", () => {
    const model = descriptor({ reasoning: { supported: evidence(true), efforts: ["low", "high"], continuation: "none" } });
    expect(mapAnthropicEffort("low", model)).toEqual({ ok: true, value: { type: "enabled", budget_tokens: 4096 } });
    expect(mapAnthropicEffort("max", model)).toMatchObject({ ok: false });
    // The refusal names the model's OWN vocabulary, so the message is actionable.
    const refusal = mapAnthropicEffort("max", model);
    expect(refusal.ok === false && refusal.reason).toContain("low, high");
  });

  test("a non-finite number is refused rather than clamped into a tier", () => {
    const model = descriptor({ reasoning: { supported: evidence(true), efforts: ["low", "high"], continuation: "none" } });
    expect(mapAnthropicEffort(Number.NaN, model)).toMatchObject({ ok: false });
  });

  test("the public `mapEffort` seam and the internal mapping cannot disagree -- they are the same function", () => {
    const adapter = createAnthropicMessagesAdapter({ catalog: { schemaVersion: 1, catalogVersion: "t", upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" }, providers: [], models: [] } });
    const model = descriptor({ reasoning: { supported: evidence(true), efforts: ["medium"], continuation: "none" } });
    expect(adapter.mapEffort("medium", model)).toEqual(mapAnthropicEffort("medium", model) as { ok: true; value: unknown });
    expect(adapter.mapEffort("max", model)).toMatchObject({ ok: false });
  });
});

describe("capabilities", () => {
  test("reads the descriptor's own evidence, and omits a continuation domain the row does not declare", () => {
    const adapter = createAnthropicMessagesAdapter({ catalog: { schemaVersion: 1, catalogVersion: "t", upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" }, providers: [], models: [] } });
    expect(adapter.capabilities(descriptor())).toEqual({ toolCalling: "native", readableState: "none" });
    expect(
      adapter.capabilities(
        descriptor({
          reasoning: { supported: evidence(true), efforts: [], continuation: "opaque-provider-state", readableState: evidence("summary" as const), continuationDomain: evidence(["z/model", "a/model"]) },
        }),
      ),
      // The domain id is the lexicographically smallest member, matching `registry.ts`'s own
      // derivation -- two sites computing it differently would refuse a legitimate replay.
    ).toEqual({ toolCalling: "native", continuationDomain: "a/model", readableState: "summary" });
  });
});

describe("the endpoint policy", () => {
  test("a plain-http user endpoint that is NOT declared local is refused before any request", async () => {
    const adapter = createAnthropicMessagesAdapter({ catalog: { schemaVersion: 1, catalogVersion: "t", upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" }, providers: [], models: [] } });
    const events = [];
    for await (const event of adapter.streamTurn({ model: "m", messages: [{ role: "user", content: "hi" }] }, ctx("http://127.0.0.1:9/"))) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", error: { code: "capability" } });
    const first = events[0];
    expect(first?.type === "error" && first.error.message).toContain("connection.local");
  });

  test("a non-http scheme is refused, and the refusal never echoes a credential", async () => {
    const adapter = createAnthropicMessagesAdapter({ catalog: { schemaVersion: 1, catalogVersion: "t", upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" }, providers: [], models: [] } });
    const events = [];
    for await (const event of adapter.streamTurn({ model: "m", messages: [{ role: "user", content: "hi" }] }, ctx("ftp://example.invalid"))) events.push(event);
    expect(events[0]).toMatchObject({ type: "error", error: { code: "capability" } });
  });
});
