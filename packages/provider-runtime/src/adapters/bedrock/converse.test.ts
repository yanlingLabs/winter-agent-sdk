import { describe, expect, test } from "bun:test";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import type { ProviderMessageLike, TurnRequest } from "../../types.ts";
import { bedrockErrorCode, buildConverseBody, mapBedrockEffort, normalizeBedrockError, toBedrockMessages } from "./converse.ts";

// PURE-MAPPING FIXTURES. Everything here is request construction and error normalization with no
// server involved; the LIVE-REQUEST assertions (the ground truth for what a provider was asked) live
// in the conformance package's corpus, where a fake records them.

function descriptor(overrides: Partial<WinterModelDescriptor> = {}): WinterModelDescriptor {
  return {
    key: "bedrock/test-model",
    providerId: "bedrock",
    upstreamId: "test-model",
    displayName: "Test Model",
    aliases: [],
    endpoints: ["chat"],
    inputModalities: { value: ["text", "image"], source: "upstream-static", confidence: "inferred" },
    outputModalities: { value: ["text"], source: "upstream-static", confidence: "inferred" },
    toolCalling: { value: "native", source: "upstream-static", confidence: "inferred" },
    nativeTools: { value: true, source: "upstream-static", confidence: "inferred" },
    unsupportedParameters: [],
    status: "experimental",
    ...overrides,
  };
}

const reasoningDescriptor = descriptor({
  reasoning: {
    supported: { value: true, source: "official-doc", confidence: "verified" },
    efforts: ["low", "medium", "high"],
    continuation: "opaque-provider-state",
    readableState: { value: "summary", source: "official-doc", confidence: "verified" },
    continuationDomain: { value: ["bedrock/test-model"], source: "official-doc", confidence: "verified" },
  },
});

function turn(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return { model: "test-model", messages: [{ role: "user", content: "hello" }], ...overrides };
}

describe("toBedrockMessages", () => {
  test("a string body becomes one text block; roles narrow to user/assistant", () => {
    expect(toBedrockMessages([{ role: "user", content: "hi" }, { role: "assistant", content: "there" }])).toEqual([
      { role: "user", content: [{ text: "hi" }] },
      { role: "assistant", content: [{ text: "there" }] },
    ]);
  });

  test("a `tool` message becomes a USER message carrying toolResult blocks", () => {
    const messages: ProviderMessageLike[] = [
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "42" }] },
    ];
    expect(toBedrockMessages(messages)).toEqual([
      { role: "user", content: [{ toolResult: { toolUseId: "tu_1", content: [{ text: "42" }], status: "success" } }] },
    ]);
  });

  test("`is_error` on a tool result becomes status: error", () => {
    const messages: ProviderMessageLike[] = [
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "boom", is_error: true }] },
    ];
    expect((toBedrockMessages(messages)[0]!.content[0] as { toolResult: { status: string } }).toolResult.status).toBe("error");
  });

  test("CONSECUTIVE SAME-ROLE messages are merged — Bedrock requires strict alternation", () => {
    const messages: ProviderMessageLike[] = [
      { role: "user", content: "one" },
      { role: "user", content: "two" },
      { role: "assistant", content: "ack" },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "r" }] },
      { role: "user", content: "three" },
    ];
    const mapped = toBedrockMessages(messages);
    expect(mapped.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(mapped[0]!.content).toEqual([{ text: "one" }, { text: "two" }]);
    // The tool result and the following user text land in ONE user message, in order.
    expect(mapped[2]!.content).toEqual([{ toolResult: { toolUseId: "tu_1", content: [{ text: "r" }], status: "success" } }, { text: "three" }]);
  });

  test("an EMPTY text block is dropped, and a message that maps to nothing is dropped whole", () => {
    // Both are `ValidationException`s on Bedrock and neither carries anything, so dropping is
    // lossless — and it keeps alternation intact, which sending them would not.
    const messages: ProviderMessageLike[] = [
      { role: "user", content: [{ type: "text", text: "" }] },
      { role: "assistant", content: [{ type: "text", text: "kept" }, { type: "text", text: "" }] },
    ];
    expect(toBedrockMessages(messages)).toEqual([{ role: "assistant", content: [{ text: "kept" }] }]);
  });

  test("tool_use rides as toolUse with its id, name and input", () => {
    const messages: ProviderMessageLike[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "tu_9", name: "Read", input: { path: "/x" } }] },
    ];
    expect(toBedrockMessages(messages)).toEqual([{ role: "assistant", content: [{ toolUse: { toolUseId: "tu_9", name: "Read", input: { path: "/x" } } }] }]);
  });

  test("an image block becomes Bedrock's own {image:{format,source:{bytes}}}, base64 carried verbatim", () => {
    const messages: ProviderMessageLike[] = [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } }] },
    ];
    expect(toBedrockMessages(messages)).toEqual([{ role: "user", content: [{ image: { format: "png", source: { bytes: "AAAB" } } }] }]);
  });

  test("an image format Bedrock does not accept is REFUSED, not sent", () => {
    const messages: ProviderMessageLike[] = [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/tiff", data: "AAAB" } }] },
    ];
    expect(() => toBedrockMessages(messages)).toThrow(/media type "image\/tiff"/);
  });

  test("ANTHROPIC-DIALECT thinking blocks are DROPPED, signature included", () => {
    // Replaying a foreign signature as Bedrock `reasoningContent` would present a signature this
    // endpoint never issued (R6-8); sending the text without it is R6-7's degrade-to-summary. So
    // neither rides, and the signature in particular reaches nothing.
    const messages: ProviderMessageLike[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "FOREIGN-THINKING-TEXT", signature: "FOREIGN-SIGNATURE" },
          { type: "redacted_thinking", data: "FOREIGN-REDACTED" },
          { type: "text", text: "the answer" },
        ],
      },
    ];
    const mapped = toBedrockMessages(messages);
    expect(mapped).toEqual([{ role: "assistant", content: [{ text: "the answer" }] }]);
    expect(JSON.stringify(mapped)).not.toContain("FOREIGN-SIGNATURE");
    expect(JSON.stringify(mapped)).not.toContain("FOREIGN-REDACTED");
  });

  test("a tool_reference block is REFUSED rather than silently dropped", () => {
    const messages: ProviderMessageLike[] = [{ role: "user", content: [{ type: "tool_reference", tool_names: ["Read", "Write"] }] }];
    expect(() => toBedrockMessages(messages)).toThrow(/no way to express a deferred tool surface/);
  });

  test("nativeState items are replayed EXACTLY, ahead of the message's own content", () => {
    const items = [{ reasoningContent: { reasoningText: { text: "prior thought", signature: "SIG-FROM-BEDROCK" } } }];
    const messages: ProviderMessageLike[] = [
      { role: "assistant", content: "and so", nativeState: { family: "bedrock", continuationDomain: "bedrock/test-model", items } },
    ];
    expect(toBedrockMessages(messages)).toEqual([{ role: "assistant", content: [items[0]!, { text: "and so" }] }]);
  });

  test("a Winter decoration rides as PLAIN TEXT, never as reasoningContent", () => {
    const messages: ProviderMessageLike[] = [
      { role: "assistant", content: "body", decoration: { text: "[handoff note]", door: "thinking-channel" } },
    ];
    const mapped = toBedrockMessages(messages);
    expect(mapped).toEqual([{ role: "assistant", content: [{ text: "body" }, { text: "[handoff note]" }] }]);
    expect(JSON.stringify(mapped)).not.toContain("reasoningContent");
  });
});

describe("buildConverseBody", () => {
  test("system, tools and toolChoice map into Bedrock's own shapes", () => {
    const body = buildConverseBody(
      turn({
        system: "be brief",
        tools: [{ name: "Read", description: "read a file", inputSchema: { type: "object", properties: {} } }],
        toolChoice: { type: "tool", name: "Read" },
        maxOutputTokens: 100,
      }),
      descriptor(),
      undefined,
    );
    expect(body.system).toEqual([{ text: "be brief" }]);
    expect(body.toolConfig).toEqual({
      tools: [{ toolSpec: { name: "Read", description: "read a file", inputSchema: { json: { type: "object", properties: {} } } } }],
      toolChoice: { tool: { name: "Read" } },
    });
    expect(body.inferenceConfig).toEqual({ maxTokens: 100 });
  });

  test("toolChoice auto and any map to their own arms", () => {
    const tools = [{ name: "Read", description: "d", inputSchema: {} }];
    expect((buildConverseBody(turn({ tools, toolChoice: { type: "auto" } }), descriptor(), undefined).toolConfig as { toolChoice: unknown }).toolChoice).toEqual({ auto: {} });
    expect((buildConverseBody(turn({ tools, toolChoice: { type: "any" } }), descriptor(), undefined).toolConfig as { toolChoice: unknown }).toolChoice).toEqual({ any: {} });
  });

  test("an empty system prompt is OMITTED — no Winter-authored default instruction is ever sent", () => {
    expect(buildConverseBody(turn({ system: "" }), descriptor(), undefined).system).toBeUndefined();
    expect(buildConverseBody(turn(), descriptor(), undefined).system).toBeUndefined();
  });

  test("tools on a model whose descriptor says tool calling is not native are REFUSED", () => {
    expect(() =>
      buildConverseBody(turn({ tools: [{ name: "Read", description: "d", inputSchema: {} }] }), descriptor({ toolCalling: { value: "none", source: "official-doc", confidence: "verified" } }), undefined),
    ).toThrow(/refuses the turn rather than sending it as plain chat/);
  });

  test("a request over the model's declared maxOutputTokens is REFUSED before it is sent", () => {
    const bounded = descriptor({ maxOutputTokens: { value: 4096, source: "official-doc", confidence: "verified" } });
    expect(() => buildConverseBody(turn({ maxOutputTokens: 8192 }), bounded, undefined)).toThrow(/declares a maximum of 4096/);
    expect(buildConverseBody(turn({ maxOutputTokens: 4096 }), bounded, undefined).inferenceConfig).toEqual({ maxTokens: 4096 });
  });

  test("thinking with a budget rides as additionalModelRequestFields.thinking with Anthropic's own spelling", () => {
    const body = buildConverseBody(turn({ thinking: { type: "enabled", budgetTokens: 2048 } }), reasoningDescriptor, undefined);
    expect(body.additionalModelRequestFields).toEqual({ thinking: { type: "enabled", budget_tokens: 2048 } });
  });

  test("thinking WITHOUT a budget re-resolves to adaptive rather than inventing a number (R6-E)", () => {
    expect(buildConverseBody(turn({ thinking: { type: "enabled" } }), reasoningDescriptor, undefined).additionalModelRequestFields).toEqual({ thinking: { type: "adaptive" } });
    expect(buildConverseBody(turn({ thinking: { type: "adaptive" } }), reasoningDescriptor, undefined).additionalModelRequestFields).toEqual({ thinking: { type: "adaptive" } });
  });

  test("thinking is REFUSED on a model whose descriptor records no reasoning support, and with no descriptor at all", () => {
    expect(() => buildConverseBody(turn({ thinking: { type: "enabled", budgetTokens: 10 } }), descriptor(), undefined)).toThrow(/records no reasoning support/);
    expect(() => buildConverseBody(turn({ thinking: { type: "adaptive" } }), undefined, undefined)).toThrow(/not available to this adapter/);
  });

  test("thinking: disabled sends no thinking field at all", () => {
    expect(buildConverseBody(turn({ thinking: { type: "disabled" } }), reasoningDescriptor, undefined).additionalModelRequestFields).toBeUndefined();
  });

  test("a mapped effort rides beside thinking in additionalModelRequestFields", () => {
    const body = buildConverseBody(turn({ thinking: { type: "adaptive" } }), reasoningDescriptor, "high");
    expect(body.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive" }, effort: "high" });
  });
});

describe("mapBedrockEffort", () => {
  test("no effort is trivially mappable", () => {
    expect(mapBedrockEffort(undefined, descriptor())).toEqual({ ok: true, value: undefined });
  });

  test("a model with NO verified effort vocabulary refuses every effort", () => {
    const result = mapBedrockEffort("low", descriptor());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("no verified effort vocabulary");
  });

  test("a named tier the model verifies passes through verbatim; one it does not is refused", () => {
    expect(mapBedrockEffort("high", reasoningDescriptor)).toEqual({ ok: true, value: "high" });
    const refused = mapBedrockEffort("max", reasoningDescriptor);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("does not accept \"max\"");
  });

  test("a NUMERIC effort is a position on the pinned ladder, clamped, then snapped DOWN to a verified tier", () => {
    // 1 = low … 5 = max. This model verifies low/medium/high, so 4 and 5 snap down to high.
    expect(mapBedrockEffort(1, reasoningDescriptor)).toEqual({ ok: true, value: "low" });
    expect(mapBedrockEffort(2, reasoningDescriptor)).toEqual({ ok: true, value: "medium" });
    expect(mapBedrockEffort(3, reasoningDescriptor)).toEqual({ ok: true, value: "high" });
    expect(mapBedrockEffort(5, reasoningDescriptor)).toEqual({ ok: true, value: "high" });
    expect(mapBedrockEffort(0, reasoningDescriptor)).toEqual({ ok: true, value: "low" });
    expect(mapBedrockEffort(99, reasoningDescriptor)).toEqual({ ok: true, value: "high" });
  });

  test("a model verifying only a tier ABOVE the requested position still snaps, upward, rather than refusing", () => {
    const only = descriptor({ reasoning: { supported: { value: true, source: "official-doc", confidence: "verified" }, efforts: ["max"], continuation: "none" } });
    expect(mapBedrockEffort(1, only)).toEqual({ ok: true, value: "max" });
  });
});

describe("bedrockErrorCode / normalizeBedrockError", () => {
  test("the code comes from x-amzn-errortype, with its trailing namespace stripped", () => {
    const headers = new Headers({ "x-amzn-errortype": "ThrottlingException:http://internal.amazon.com/coral/x" });
    expect(bedrockErrorCode(headers, "")).toBe("ThrottlingException");
  });

  test("the code falls back to the body's __type, with its # namespace stripped", () => {
    expect(bedrockErrorCode(new Headers(), '{"__type":"com.amazon.coral.service#ValidationException","message":"bad"}')).toBe("ValidationException");
  });

  test("a body with no structured code yields undefined rather than a guess", () => {
    expect(bedrockErrorCode(new Headers(), '{"message":"something went wrong"}')).toBeUndefined();
    expect(bedrockErrorCode(new Headers(), "<html>502</html>")).toBeUndefined();
  });

  test("the code is read off the FULL body, before any truncation", () => {
    // The frozen normalizer caps its message snippet at 200 chars; a code that sits after a long
    // human message would be lost to a parser that read the truncated form.
    const body = JSON.stringify({ message: "x".repeat(500), __type: "ValidationException" });
    const error = normalizeBedrockError(400, new Headers(), body);
    expect(error.providerCode).toBe("ValidationException");
    expect(error.message.length).toBeLessThan(300);
  });

  test("statuses map onto the five-way taxonomy with the provider code preserved", () => {
    const throttle = normalizeBedrockError(429, new Headers({ "x-amzn-errortype": "ThrottlingException" }), "{}");
    expect(throttle.code).toBe("rate_limit");
    expect(throttle.retryable).toBe(true);
    expect(throttle.providerCode).toBe("ThrottlingException");

    const denied = normalizeBedrockError(403, new Headers({ "x-amzn-errortype": "AccessDeniedException" }), "{}");
    expect(denied.code).toBe("auth");
    expect(denied.retryable).toBe(false);
    expect(denied.providerCode).toBe("AccessDeniedException");

    const invalid = normalizeBedrockError(400, new Headers({ "x-amzn-errortype": "ValidationException" }), "{}");
    expect(invalid.code).toBe("bad_request");
    expect(invalid.providerCode).toBe("ValidationException");

    const unavailable = normalizeBedrockError(503, new Headers({ "x-amzn-errortype": "ServiceUnavailableException" }), "{}");
    expect(unavailable.code).toBe("server");
    expect(unavailable.retryable).toBe(true);

    // ModelNotReadyException is a 429 that IS worth retrying — the taxonomy is driven by the status,
    // and this row exists so a reader can see that the provider code does not override it.
    const notReady = normalizeBedrockError(429, new Headers({ "x-amzn-errortype": "ModelNotReadyException" }), "{}");
    expect(notReady.retryable).toBe(true);
  });

  test("Retry-After survives normalization", () => {
    const error = normalizeBedrockError(429, new Headers({ "x-amzn-errortype": "ThrottlingException", "retry-after": "3" }), "{}");
    expect(error.retryAfterMs).toBe(3000);
  });
});
