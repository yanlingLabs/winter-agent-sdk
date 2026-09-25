// Phase 6 Task 6 (Lane B): the Anthropic adapter's PURE half.
//
// The wire behaviour is proved against the loopback fake in
// `packages/provider-conformance/src/corpus/anthropic.test.ts` -- the ground truth for what a
// provider was asked is the live request it received, and that package is where the fake lives.
// What is left here is what has no wire at all: the message/block transformation, the effort
// vocabulary, the capability read, and the endpoint-policy refusals that happen before a URL exists.
import { describe, expect, test } from "bun:test";
import { createAnthropicMessagesAdapter, mapAnthropicEffort, toWireMessages } from "./index.ts";
import { buildRequestBody, promptCachingLayout } from "./messages.ts";
import { ProviderRequestError } from "../../http.ts";
import type { CredentialMaterial, CredentialRef, ProviderContext, TurnRequest } from "../../types.ts";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog, stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";

const evidence = <T>(value: T) => ({ value, source: "upstream-static" as const, confidence: "inferred" as const });

// WS-13c: `modelFamily`/`canonicalModelId` are DERIVED, never hand-typed into a fixture. The
// pipeline's own `stampFamilyFields` fills them here with NO families, so a fixture row lands in
// `other` carrying the real normaliser's canonical id rather than a second, drifting spelling.
const stampRow = (row: Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">): WinterModelDescriptor => stampFamilyFields([row], [])[0]!;

const descriptor = (over: Partial<WinterModelDescriptor> = {}): WinterModelDescriptor => stampRow({
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
    const adapter = createAnthropicMessagesAdapter({ catalog: { schemaVersion: 2, families: [], catalogVersion: "t", upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" }, providers: [], models: [] } });
    const model = descriptor({ reasoning: { supported: evidence(true), efforts: ["medium"], continuation: "none" } });
    expect(adapter.mapEffort("medium", model)).toEqual(mapAnthropicEffort("medium", model) as { ok: true; value: unknown });
    expect(adapter.mapEffort("max", model)).toMatchObject({ ok: false });
  });
});

// 2026-09-25: `reasoning.effortRequest` -- WHERE a row takes effort on the wire, and per-row
// `thinking.type.*`/`tool_choice.*` rejection tokens sourced from
// https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting. These assert the
// REQUEST BODY `buildRequestBody` returns, never `fake.requests` (this file's own header comment) --
// that half is `provider-conformance`'s job, and these fixtures exist here so a row shape can be
// asserted with no fetch and no fake server at all.
describe("effort via output_config.effort, per-row thinking rules, and forced tool_choice (2026-09-25)", () => {
  const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], ...over });

  // Opus 5.5 / Fable 5.1's real catalog shape: adaptive-only, always on, "enabled" AND "disabled" are
  // both a documented 400, and a FORCED tool_choice is too (the vendor's own advice there is `auto`).
  const opus55Shaped = descriptor({
    key: "anthropic/opus-5-5-shaped",
    upstreamId: "opus-5-5-shaped",
    unsupportedParameters: ["thinking.type.enabled", "thinking.type.disabled", "tool_choice.any", "tool_choice.tool"],
    reasoning: { supported: evidence(true), efforts: ["low", "medium", "high", "xhigh", "max"], continuation: "opaque-provider-state", effortRequest: evidence({ field: "output_config.effort" as const }) },
  });

  // Opus 4.5's real catalog shape: `enabled`-only, `adaptive` is the documented 400, and effort
  // COMPOSES with the budget ladder rather than replacing it (the vendor's effort page, per row).
  const opus45Shaped = descriptor({
    key: "anthropic/opus-4-5-shaped",
    upstreamId: "opus-4-5-shaped",
    unsupportedParameters: ["thinking.type.adaptive"],
    reasoning: { supported: evidence(true), efforts: ["low", "medium", "high"], continuation: "opaque-provider-state", effortRequest: evidence({ field: "output_config.effort" as const }) },
  });

  // Opus 4.6 / Sonnet 4.6's real catalog shape: `effortRequest` present, but NEITHER thinking arm is
  // rejected (`unsupportedParameters` carries neither token) -- adaptive is simply the model's default.
  const opus46Shaped = descriptor({
    key: "anthropic/opus-4-6-shaped",
    upstreamId: "opus-4-6-shaped",
    unsupportedParameters: [],
    reasoning: { supported: evidence(true), efforts: ["low", "medium", "high", "max"], continuation: "opaque-provider-state", effortRequest: evidence({ field: "output_config.effort" as const }) },
  });

  // Haiku 4.5 / Sonnet 4.5's real catalog shape: reasoning IS declared (an effort vocabulary exists),
  // but the row carries NO `effortRequest` at all -- this is the pre-2026-09-25 shape, unaffected by
  // any of this work.
  const noEffortRequestShaped = descriptor({
    key: "anthropic/no-effort-request-shaped",
    upstreamId: "no-effort-request-shaped",
    unsupportedParameters: ["thinking.type.adaptive"],
    reasoning: { supported: evidence(true), efforts: ["low", "medium", "high", "xhigh"], continuation: "opaque-provider-state" },
  });

  describe("an Opus 5.5-shaped row", () => {
    test("effort -> output_config.effort, and thinking becomes adaptive (no budget invented)", () => {
      const body = buildRequestBody(req({ model: opus55Shaped.upstreamId, effort: "high" }), opus55Shaped, {});
      expect(body["thinking"]).toEqual({ type: "adaptive" });
      expect(body["output_config"]).toEqual({ effort: "high" });
    });

    test("explicit `thinking: {type:\"enabled\"}` becomes adaptive -- budget dropped, no effort invented", () => {
      const body = buildRequestBody(req({ model: opus55Shaped.upstreamId, thinking: { type: "enabled", budgetTokens: 16_384 } }), opus55Shaped, {});
      expect(body["thinking"]).toEqual({ type: "adaptive" });
      expect(body).not.toHaveProperty("output_config");
    });

    test("explicit `thinking: {type:\"disabled\"}` OMITS the field entirely -- this model is always on", () => {
      const body = buildRequestBody(req({ model: opus55Shaped.upstreamId, thinking: { type: "disabled" } }), opus55Shaped, {});
      expect(body).not.toHaveProperty("thinking");
    });

    test("explicit thinking wins the FIELD, but output_config.effort still rides when both are requested together", () => {
      // Required behaviour #2's last bullet: an explicit `thinking` overrides the thinking FIELD (as
      // today), but `output_config.effort` is a SEPARATE question and is still sent whenever the row
      // documents `effortRequest` and an effort was requested -- regardless of which arm won the field.
      const body = buildRequestBody(req({ model: opus55Shaped.upstreamId, thinking: { type: "enabled", budgetTokens: 4096 }, effort: "high" }), opus55Shaped, {});
      expect(body["thinking"]).toEqual({ type: "adaptive" }); // the explicit arm, converted (as above) -- NOT re-derived from effort
      expect(body["output_config"]).toEqual({ effort: "high" }); // effort still reaches output_config
    });

    test("an explicit `disabled` that OMITS the field also survives an effort request -- the omission is not overwritten", () => {
      const body = buildRequestBody(req({ model: opus55Shaped.upstreamId, thinking: { type: "disabled" }, effort: "high" }), opus55Shaped, {});
      expect(body).not.toHaveProperty("thinking");
      expect(body["output_config"]).toEqual({ effort: "high" });
    });

    test("a forced tool_choice downgrades to auto (both `any` and `tool`)", () => {
      const tools = [{ name: "t", description: "d", inputSchema: {} }];
      const any = buildRequestBody(req({ model: opus55Shaped.upstreamId, tools, toolChoice: { type: "any" } }), opus55Shaped, {});
      expect(any["tool_choice"]).toEqual({ type: "auto" });
      const named = buildRequestBody(req({ model: opus55Shaped.upstreamId, tools, toolChoice: { type: "tool", name: "t" } }), opus55Shaped, {});
      expect(named["tool_choice"]).toEqual({ type: "auto" });
      // `auto` itself is never rejected, and is forwarded unchanged.
      const already = buildRequestBody(req({ model: opus55Shaped.upstreamId, tools, toolChoice: { type: "auto" } }), opus55Shaped, {});
      expect(already["tool_choice"]).toEqual({ type: "auto" });
    });
  });

  describe("an Opus 4.5-shaped row", () => {
    test("effort -> budget ladder AND output_config.effort (composes, per the vendor's effort page)", () => {
      const body = buildRequestBody(req({ model: opus45Shaped.upstreamId, effort: "high" }), opus45Shaped, {});
      expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 16_384 });
      expect(body["output_config"]).toEqual({ effort: "high" });
    });

    test("explicit adaptive is refused BEFORE the request -- a typed capability error, zero requests", () => {
      let caught: unknown;
      try {
        buildRequestBody(req({ model: opus45Shaped.upstreamId, thinking: { type: "adaptive" } }), opus45Shaped, {});
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderRequestError);
      expect((caught as ProviderRequestError).code).toBe("capability");
      expect((caught as Error).message).toContain("thinking.type.adaptive");
    });
  });

  test("a Haiku-shaped row (no effortRequest): today's budget ladder, byte-identical", () => {
    const body = buildRequestBody(req({ model: noEffortRequestShaped.upstreamId, effort: "high" }), noEffortRequestShaped, {});
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 16_384 });
    expect(body).not.toHaveProperty("output_config");
  });

  test("an Opus 4.6-shaped row (effortRequest, no rejection tokens): adaptive + output_config", () => {
    const body = buildRequestBody(req({ model: opus46Shaped.upstreamId, effort: "max" }), opus46Shaped, {});
    expect(body["thinking"]).toEqual({ type: "adaptive" });
    expect(body["output_config"]).toEqual({ effort: "max" });
  });

  test("unknown unsupportedParameters tokens are inert", () => {
    // A future token this file has never seen, sitting beside the CURATED tokens the old loop already
    // ignores for `thinking`/`tool_choice` purposes (`temperature`) -- neither should change the
    // Opus-4.6-shaped row's behaviour from the test above.
    const withUnknownTokens: WinterModelDescriptor = { ...opus46Shaped, unsupportedParameters: ["a-token-nobody-handles-yet", "temperature", "top_p", "top_k"] };
    const body = buildRequestBody(req({ model: withUnknownTokens.upstreamId, effort: "max" }), withUnknownTokens, {});
    expect(body["thinking"]).toEqual({ type: "adaptive" });
    expect(body["output_config"]).toEqual({ effort: "max" });
    // Neither an explicit `enabled` thinking request nor a forced tool_choice is touched by the
    // unknown tokens -- only the exact `thinking.type.*`/`tool_choice.*` spellings this row does NOT
    // carry are left alone.
    const explicit = buildRequestBody(req({ model: withUnknownTokens.upstreamId, thinking: { type: "enabled", budgetTokens: 4096 } }), withUnknownTokens, {});
    expect(explicit["thinking"]).toEqual({ type: "enabled", budget_tokens: 4096 });
    const forced = buildRequestBody(req({ model: withUnknownTokens.upstreamId, tools: [{ name: "t", description: "d", inputSchema: {} }], toolChoice: { type: "any" } }), withUnknownTokens, {});
    expect(forced["tool_choice"]).toEqual({ type: "any" });
  });

  describe("the public `mapEffort` agrees with what buildRequestBody (streamTurn's own body builder) sends", () => {
    const adapter = createAnthropicMessagesAdapter({ catalog: { schemaVersion: 2, families: [], catalogVersion: "t", upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" }, providers: [], models: [] } });

    test("an adaptive-only, effortRequest row (Opus 5.5-shaped)", () => {
      const mapped = adapter.mapEffort("high", opus55Shaped);
      expect(mapped).toEqual({ ok: true, value: { type: "adaptive", outputConfigEffort: "high" } });
      const body = buildRequestBody(req({ model: opus55Shaped.upstreamId, effort: "high" }), opus55Shaped, {});
      const mappedValue = mapped as { ok: true; value: { type: "adaptive"; outputConfigEffort: string } };
      expect(body["thinking"]).toEqual({ type: mappedValue.value.type });
      expect(body["output_config"]).toEqual({ effort: mappedValue.value.outputConfigEffort });
    });

    test("a composing, effortRequest row (Opus 4.5-shaped)", () => {
      const mapped = adapter.mapEffort("high", opus45Shaped);
      expect(mapped).toEqual({ ok: true, value: { type: "enabled", budget_tokens: 16_384, outputConfigEffort: "high" } });
      const body = buildRequestBody(req({ model: opus45Shaped.upstreamId, effort: "high" }), opus45Shaped, {});
      const mappedValue = mapped as { ok: true; value: { type: "enabled"; budget_tokens: number; outputConfigEffort: string } };
      expect(body["thinking"]).toEqual({ type: mappedValue.value.type, budget_tokens: mappedValue.value.budget_tokens });
      expect(body["output_config"]).toEqual({ effort: mappedValue.value.outputConfigEffort });
    });
  });
});

describe("promptCachingLayout (I3, fix wave)", () => {
  // A request that never carries the 0.0.16 block layout is never marked, regardless of the
  // descriptor -- `systemBlocks === undefined` short-circuits before the descriptor is even read.
  const req = { model: "anthropic/claude-sonnet-5", messages: [], systemBlocks: [{ text: "s", cacheScope: "org" as const }] };

  test("declared true -> marked (array system blocks with cache_control)", () => {
    const model = descriptor({ promptCaching: evidence(true) });
    expect(promptCachingLayout(req, model)).toBe(true);
  });

  test("declared false -> not marked (plain string system)", () => {
    const model = descriptor({ promptCaching: evidence(false) });
    expect(promptCachingLayout(req, model)).toBe(false);
  });

  test("no promptCaching evidence on an otherwise-real descriptor -> not marked", () => {
    const model = descriptor();
    expect(model.promptCaching).toBeUndefined();
    expect(promptCachingLayout(req, model)).toBe(false);
  });

  test("no descriptor at all (an allowUnlisted passthrough) -> not marked", () => {
    expect(promptCachingLayout(req, undefined)).toBe(false);
  });

  test("systemBlocks absent -> never marked even when the row declares true", () => {
    const model = descriptor({ promptCaching: evidence(true) });
    expect(promptCachingLayout({ model: "m", messages: [] }, model)).toBe(false);
  });

  // Regression tripwire (scoped re-review, fix 3): I3's `=== true` requirement is correct, but it
  // turned "no evidence recorded" into a silent cost regression for every Claude row the catalog's
  // own overlay authors had not yet gotten to -- 8 of 12 `anthropic` rows and 8 of 12 `console` rows
  // lost prompt caching the moment this file shipped, with no test failing anywhere. This probes the
  // REAL generated catalog (not a hand-built fixture, which cannot see a data-only regression) so the
  // next upstream re-sync that lands a new promptCaching-silent Claude row fails HERE, not in a bill.
  describe("real catalog: every anthropic/console Claude row is caching-eligible (regression tripwire)", () => {
    const claudeRows = loadCatalog().models.filter((m) => (m.providerId === "anthropic" || m.providerId === "console") && m.key.includes("claude"));

    test("the probe has real rows to examine (a vacuous pass is not a pass)", () => {
      expect(claudeRows.length).toBeGreaterThanOrEqual(12);
    });

    test.each(claudeRows.map((m) => [m.key] as const))("%s declares promptCaching at official-doc/declared, and promptCachingLayout marks it", (key) => {
      const row = claudeRows.find((m) => m.key === key)!;
      expect([key, row.promptCaching?.value]).toEqual([key, true]);
      expect([key, row.promptCaching?.source]).toEqual([key, "official-doc"]);
      expect([key, row.promptCaching?.confidence]).toEqual([key, "declared"]);
      expect([key, promptCachingLayout(req, row)]).toEqual([key, true]);
    });
  });
});

describe("capabilities", () => {
  test("reads the descriptor's own evidence, and omits a continuation domain the row does not declare", () => {
    const adapter = createAnthropicMessagesAdapter({ catalog: { schemaVersion: 2, families: [], catalogVersion: "t", upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" }, providers: [], models: [] } });
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
    const adapter = createAnthropicMessagesAdapter({ catalog: { schemaVersion: 2, families: [], catalogVersion: "t", upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" }, providers: [], models: [] } });
    const events = [];
    for await (const event of adapter.streamTurn({ model: "m", messages: [{ role: "user", content: "hi" }] }, ctx("http://127.0.0.1:9/"))) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", error: { code: "capability" } });
    const first = events[0];
    expect(first?.type === "error" && first.error.message).toContain("connection.local");
  });

  test("a non-http scheme is refused, and the refusal never echoes a credential", async () => {
    const adapter = createAnthropicMessagesAdapter({ catalog: { schemaVersion: 2, families: [], catalogVersion: "t", upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" }, providers: [], models: [] } });
    const events = [];
    for await (const event of adapter.streamTurn({ model: "m", messages: [{ role: "user", content: "hi" }] }, ctx("ftp://example.invalid"))) events.push(event);
    expect(events[0]).toMatchObject({ type: "error", error: { code: "capability" } });
  });
});

// R-S4 (task-frames parity fix wave): a REAL executor error rides the engine's block as `is_error`,
// the engine's synthetic markers as `error` -- both are the same wire field.
describe("toWireMessages: tool_result error spellings", () => {
  test("is_error and the synthetic error marker both become is_error:true; a success carries none", () => {
    const wire = toWireMessages([
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "real failure", is_error: true },
          { type: "tool_result", tool_use_id: "b", content: "[error: threw]", error: true },
          { type: "tool_result", tool_use_id: "c", content: "fine" },
        ],
      },
    ]);
    expect(wire[0]!.content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "real failure", is_error: true },
      { type: "tool_result", tool_use_id: "b", content: "[error: threw]", is_error: true },
      { type: "tool_result", tool_use_id: "c", content: "fine" },
    ]);
  });
});
