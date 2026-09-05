// Phase 6 Task 6 (Lane B): the Anthropic Messages adapter, proved on the wire.
//
// EVERY assertion here reads the LIVE REQUEST the loopback fake received (`fake.requests`), never
// what the adapter believed it sent -- the lane block's ground-truth rule. The normalized stream is
// folded by the REAL consumer (`foldProviderStream`, exported from the runtime's bridge for exactly
// this), so a fixture proves the adapter against the thing that will actually consume it rather than
// a re-implementation.
//
// The bridge import is RELATIVE because `@yanlinglabs/winter-provider-runtime`'s `exports` map
// publishes only `.` and its barrel is frozen (R6-12) -- a deep specifier does not resolve. Same for
// the adapter itself.
import { describe, expect, test } from "bun:test";
import { withFake, noRequestContains, requestsTo } from "../fakes/server.ts";
import { anthropicError, anthropicFakeRoutes, anthropicTurnResponse, assertAnthropicRequest, anthropicBody, messageBlocks } from "../fakes/anthropic-messages.ts";
import { createAnthropicMessagesAdapter, ANTHROPIC_ADAPTER_ID, ANTHROPIC_DEFAULT_BASE_URL, mapAnthropicEffort } from "../../../provider-runtime/src/adapters/anthropic/index.ts";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { foldProviderStream } from "../../../runtime/src/provider/bridge.ts";
import { formatCorpusReport, runAdapterCorpus } from "./runner.ts";
import { ANTHROPIC_MODELS, ANTHROPIC_TEST_KEY, anthropicCorpusCases, anthropicCorpusRoutes, foldTurn, testAnthropicAdapter, testAnthropicCatalog, testContext } from "./anthropic.ts";

describe("Anthropic Messages: the live request", () => {
  test("carries the model, system, messages, tools, tool_choice and the family's headers", async () => {
    const adapter = createAnthropicMessagesAdapter({ catalog: testAnthropicCatalog() });
    await withFake(
      { routes: anthropicFakeRoutes({ messages: { "claude-sonnet-5": () => anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["hi"] }] }) } }) },
      async (fake) => {
        const turn = await foldProviderStream(
          adapter.streamTurn(
            {
              model: "claude-sonnet-5",
              system: "winter-system",
              messages: [{ role: "user", content: "hello" }],
              tools: [{ name: "Read", description: "read a file", inputSchema: { type: "object", properties: {} } }],
              toolChoice: { type: "auto" },
            },
            testContext(fake.url),
          ),
        );
        expect(turn).toMatchObject({ kind: "text", text: "hi" });
        expect(fake.requests).toHaveLength(1);
        assertAnthropicRequest(fake.requests[0]!, {
          model: "claude-sonnet-5",
          system: "winter-system",
          stream: true,
          roles: ["user"],
          blockTypes: ["text"],
          toolNames: ["Read"],
          toolChoice: { type: "auto" },
        });
        expect(messageBlocks(fake.requests[0]!, 0)).toEqual([{ type: "text", text: "hello" }]);
        expect(noRequestContains(fake, ANTHROPIC_TEST_KEY)).toBe(true);
      },
    );
  });

  test("`anthropic-beta` rides as a PROTOCOL header, and a tool role becomes a user message", async () => {
    const adapter = testAnthropicAdapter({ betas: ["fake-beta-1", "fake-beta-2"] });
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        {
          model: ANTHROPIC_MODELS.main,
          messages: [
            { role: "user", content: "go" },
            { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }] },
            { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok", error: true }] },
          ],
        },
        testContext(fake.url),
      );
      assertAnthropicRequest(fake.requests[0]!, { beta: "fake-beta-1,fake-beta-2", roles: ["user", "assistant", "user"] });
      // Winter's `error` marker has a wire counterpart (`is_error`); the other four provisional
      // markers are bookkeeping and do not reach the wire.
      expect(messageBlocks(fake.requests[0]!, 2)).toEqual([{ type: "tool_result", tool_use_id: "c1", content: "ok", is_error: true }]);
    });
  });

  test("ADJACENT same-role messages merge, preserving block order exactly", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        {
          model: ANTHROPIC_MODELS.main,
          messages: [
            { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "a" }] },
            { role: "tool", content: [{ type: "tool_result", tool_use_id: "c2", content: "b" }] },
            { role: "user", content: "and now this" },
          ],
        },
        testContext(fake.url),
      );
      assertAnthropicRequest(fake.requests[0]!, { roles: ["user"], blockTypes: ["tool_result", "tool_result", "text"] });
    });
  });

  test("a `tool_reference` block is a TYPED REFUSAL, never a silent drop", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await expect(
        foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [{ role: "assistant", content: [{ type: "tool_reference", tool_names: ["Read"] }] }] }, testContext(fake.url)),
      ).rejects.toThrow(/tool_reference/);
      expect(fake.requests).toHaveLength(0);
    });
  });
});

describe("Anthropic Messages: thinking, effort and the summary request", () => {
  test("a requested summary sets the DESCRIPTOR'S OWN `thinking.display` field, never a hard-coded one", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "go" }], thinking: { type: "adaptive" }, requestSummary: true }, testContext(fake.url));
      expect(anthropicBody(fake.requests[0]!)["thinking"]).toEqual({ type: "adaptive", display: "summarized" });
    });
  });

  test("each thinking arm is forwarded VERBATIM -- `enabled` is not re-resolved to `adaptive`", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "go" }], thinking: { type: "enabled", budgetTokens: 1024 } }, testContext(fake.url));
      // Capture (F) observed the pinned runtime re-resolving `enabled` -> `adaptive` for this very
      // model. Winter does NOT, because the catalog carries no adaptive-only evidence to justify it
      // (R6-E permits the re-resolution only where the model's evidence says so). Disclosed.
      expect(anthropicBody(fake.requests[0]!)["thinking"]).toEqual({ type: "enabled", budget_tokens: 1024 });
    });
  });

  test("thinking on a model with NO reasoning evidence is refused before the request", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await expect(
        foldTurn(adapter, { model: ANTHROPIC_MODELS.noVision, messages: [{ role: "user", content: "go" }], thinking: { type: "adaptive" } }, testContext(fake.url)),
      ).rejects.toThrow(/does not declare reasoning support/);
      expect(fake.requests).toHaveLength(0);
    });
  });

  test("the ADAPTER'S OWN max_tokens fallback grows to hold a thinking budget; a DECLARED ceiling does not", async () => {
    // The corpus found this on its first run: an effort request that named no output budget was
    // being refused as "over the limit" by a number the caller never chose. A fallback is not a
    // limit; a declared or requested ceiling is.
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "go" }], effort: "high" }, testContext(fake.url));
      expect(anthropicBody(fake.requests[0]!)["max_tokens"]).toBe(16384 + 4096);

      await foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "go" }], maxOutputTokens: 512 }, testContext(fake.url));
      expect(anthropicBody(fake.requests[1]!)["max_tokens"]).toBe(512);
    });
  });

  test("`mapEffort` maps a NUMBER onto the nearest declared tier and refuses an unlisted one", () => {
    const descriptor = testAnthropicCatalog().models.find((m) => m.upstreamId === ANTHROPIC_MODELS.main)!;
    // The five declared tiers spread across a 0-100 intensity: the pin states no unit for the
    // numeric form at all (OQ-P6-2), so this mapping is Winter's disclosed gap-fill.
    expect(mapAnthropicEffort(0, descriptor)).toEqual({ ok: true, value: { type: "enabled", budget_tokens: 4096 } });
    expect(mapAnthropicEffort(50, descriptor)).toEqual({ ok: true, value: { type: "enabled", budget_tokens: 16384 } });
    expect(mapAnthropicEffort(100, descriptor)).toEqual({ ok: true, value: { type: "enabled", budget_tokens: 65536 } });
    expect(mapAnthropicEffort(500, descriptor)).toEqual({ ok: true, value: { type: "enabled", budget_tokens: 65536 } });

    const noEfforts = testAnthropicCatalog().models.find((m) => m.upstreamId === ANTHROPIC_MODELS.noEfforts)!;
    expect(mapAnthropicEffort("high", noEfforts)).toMatchObject({ ok: false });
    // An UNLISTED model has no verified vocabulary, so an effort for it is refused rather than guessed.
    expect(mapAnthropicEffort("high", undefined)).toMatchObject({ ok: false });
  });
});

describe("Anthropic Messages: retries and the first-byte rule", () => {
  test("a 529 `overloaded_error` normalizes to a retryable `server` error and one `api_retry`", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      const events = [];
      for await (const event of adapter.streamTurn({ model: ANTHROPIC_MODELS.retry529, messages: [{ role: "user", content: "go" }] }, testContext(fake.url))) events.push(event);
      const retries = events.filter((e) => e.type === "retry");
      expect(retries).toHaveLength(1);
      // Capture (G)'s own mapping: `error_status: 529`, `error: "overloaded"`.
      expect(retries[0]).toMatchObject({ attempt: 1, errorStatus: 529, error: "overloaded" });
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
      expect(requestsTo(fake, "/v1/messages")).toHaveLength(2);
    });
  });

  test("a 529 that never clears normalizes to a RETRYABLE `server` error carrying its own status and code", async () => {
    // The brief names this one explicitly. With no retry budget the first failure is final, so the
    // normalized error itself is observable rather than being consumed by a successful retry.
    const adapter = testAnthropicAdapter({ retry: { maxRetries: 0, sleep: async () => {} } });
    await withFake({ routes: anthropicFakeRoutes({ messages: { "sc-529-always": () => anthropicError(529, "overloaded_error", "Overloaded") } }) }, async (fake) => {
      const events = [];
      for await (const event of adapter.streamTurn({ model: "sc-529-always", messages: [{ role: "user", content: "go" }] }, testContext(fake.url))) events.push(event);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", error: { code: "server", status: 529, retryable: true, providerCode: "overloaded_error" } });
      expect(requestsTo(fake, "/v1/messages")).toHaveLength(1);
    });
  });
});

describe("Anthropic Messages: countTokens and discovery", () => {
  test("`countTokens` is a REAL count from the family's own endpoint, with the generation parameters stripped", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      const count = await adapter.countTokens!({ model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }, testContext(fake.url));
      expect(count).toBe(200);
      const recorded = requestsTo(fake, "/v1/messages/count_tokens")[0]!;
      const body = anthropicBody(recorded);
      expect(body["model"]).toBe(ANTHROPIC_MODELS.main);
      expect(body["stream"]).toBeUndefined();
      expect(body["max_tokens"]).toBeUndefined();
    });
  });

  test("`validateCredential` reports `invalid` for a rejected key and never echoes it", async () => {
    const adapter = testAnthropicAdapter();
    await withFake(
      { routes: anthropicFakeRoutes({ messages: {}, models: () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error" } }), { status: 401, headers: { "content-type": "application/json" } }) }) },
      async (fake) => {
        const status = await adapter.validateCredential({ kind: "inline", value: ANTHROPIC_TEST_KEY }, testContext(fake.url));
        expect(status).toMatchObject({ ok: false, code: "invalid" });
        expect(JSON.stringify(status)).not.toContain(ANTHROPIC_TEST_KEY);
        expect(noRequestContains(fake, ANTHROPIC_TEST_KEY)).toBe(true);
      },
    );
  });
});

describe("Anthropic Messages: catalog agreement", () => {
  test("the adapter's id and default endpoint match the COMPILED catalog's own row", () => {
    // `ProviderContext` never hands an adapter its provider descriptor, so the default endpoint is
    // the adapter's to keep in sync -- this is the assertion that notices when it drifts.
    const catalog = loadCatalog();
    const provider = catalog.providers.find((p) => p.id === "anthropic")!;
    expect(provider.adapterId).toBe(ANTHROPIC_ADAPTER_ID);
    expect(provider.defaultEndpoints["api"]).toBe(ANTHROPIC_DEFAULT_BASE_URL);
    expect(createAnthropicMessagesAdapter().family).toBe("anthropic");
    expect(createAnthropicMessagesAdapter().protocol).toBe("anthropic-messages");
  });
});

describe("Anthropic Messages: the WS-13 §13 corpus", () => {
  test("every case fires against the loopback fake, and the report says so", async () => {
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      const report = await runAdapterCorpus({ adapter: "winter.anthropic-messages", fake, model: ANTHROPIC_MODELS.main, cases: anthropicCorpusCases() });
      if (!report.ok) throw new Error(formatCorpusReport(report));
      expect(report.outcomes.filter((o) => o.status === "passed").length).toBe(report.outcomes.length);
      // No case may be `missing` or `skipped`: this family answers every question WS-13 §13 asks.
      expect(report.outcomes.filter((o) => o.status !== "passed")).toEqual([]);
    });
  }, 30_000);
});
