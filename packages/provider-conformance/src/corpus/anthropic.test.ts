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
import { withFake, noRequestContains, requestsTo, sseResponse, type FakeRoute } from "../fakes/server.ts";
import {
  FAKE_CONSOLE_ACCESS_TOKEN,
  FAKE_CONSOLE_ACCOUNT_ID,
  FAKE_CONSOLE_REFRESHED_ACCESS_TOKEN,
  FAKE_CONSOLE_REFRESH_TOKEN,
  startAnthropicConsoleOauthFake,
} from "../fakes/anthropic-console-oauth.ts";
import {
  createMemoryCredentialStore,
  createAnthropicMessagesAdapter,
  ANTHROPIC_ADAPTER_ID,
  ANTHROPIC_DEFAULT_BASE_URL,
  CONSOLE_OAUTH,
  anthropicCredentialRef,
  mapAnthropicEffort,
  winterUserAgent,
} from "@yanlinglabs/winter-provider-runtime";
import { anthropicError, anthropicFakeRoutes, anthropicTurnResponse, assertAnthropicRequest, anthropicBody, messageBlocks } from "../fakes/anthropic-messages.ts";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { THINKING_ENABLED_NEEDS_BUDGET } from "@yanlinglabs/winter-provider-runtime/testing";
// `foldProviderStream` stays relative (review r1 Critical-2): `winter-agent-runtime` is
// `"private": true`, never published -- irrelevant here since `.test.ts` files never ship as
// reachable code.
import { foldProviderStream } from "../../../runtime/src/provider/bridge.ts";
import { formatCorpusReport, runAdapterCorpus } from "./runner.ts";
import { ANTHROPIC_MODELS, ANTHROPIC_TEST_KEY, anthropicCorpusCases, anthropicCorpusRoutes, foldTurn, testAnthropicAdapter, testAnthropicCatalog, testContext } from "./anthropic.ts";

describe("Anthropic Messages: the live request", () => {
  test("WS-13b: every request carries Winter's OWN user-agent, never an editor or vendor CLI identity", async () => {
    // Winter's identity, read off the LIVE request. The negative half carries the weight: Bun's
    // fetch supplies `Bun/<version>` when nothing sets the header, so an adapter that simply forgot
    // would still have A user-agent and a presence-only assertion would pass.
    const adapter = createAnthropicMessagesAdapter({ catalog: testAnthropicCatalog() });
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "hi" }] }, testContext(fake.url));
      expect(fake.requests.length).toBeGreaterThan(0);
      for (const recorded of fake.requests) expect(recorded.headers["user-agent"]).toBe(winterUserAgent());
    });
  });

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

  test("`{ type: \"enabled\" }` with NO budget is refused BEFORE the request, not sent for the endpoint to 400", async () => {
    // The pin types `budgetTokens` optional while its own JSDoc renders the arm as requiring one --
    // and this endpoint requires it. Forwarding the arm budget-less is a request we KNOW will fail
    // upstream, which is exactly what the reject-before rule exists for.
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await expect(
        foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "go" }], thinking: { type: "enabled" } }, testContext(fake.url)),
      ).rejects.toThrow(THINKING_ENABLED_NEEDS_BUDGET);
      expect(fake.requests).toHaveLength(0);
      // The SENTENCE is the shared one, not merely a message mentioning `budgetTokens` (fix-wave
      // F-2 / review M-2): Bedrock refuses the identical Anthropic-dialect object for the identical
      // model family, and Google refuses the same config for a different reason -- three families
      // answering one question in three sentences is how a caller learns to read three messages
      // instead of one. `adapters/refusals.ts` owns the string; this asserts the wiring.
    });
  });

  test("a host `connection.headers` entry cannot override `anthropic-version` or `content-type`", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "go" }] },
        testContext(fake.url, { connection: { providerId: "anthropic", baseUrl: fake.url, local: true, headers: { "anthropic-version": "1999-01-01", "x-host-own": "kept" } } }),
      );
      // A wrong API version surfaces as an unexplained upstream 400 rather than anything local, so
      // the adapter's own value wins.
      assertAnthropicRequest(fake.requests[0]!, {});
      expect(fake.requests[0]!.headers["x-host-own"]).toBe("kept");
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

describe("Anthropic Messages: images nested inside a tool_result (I2)", () => {
  const nestedImage = (id: string) => ({
    role: "tool" as const,
    content: [{ type: "tool_result" as const, tool_use_id: id, content: [{ type: "text" as const, text: "page 1" }, { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "aGVsbG8=" } }] }],
  });

  test("a NESTED image is refused before the request for a non-vision model, exactly like a top-level one", async () => {
    // P3-M's multimodal `Read` delivers its page images SOLELY as image blocks inside a model-facing
    // `tool_result`, so a top-level-only gate let precisely the interesting case reach the wire.
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await expect(
        foldTurn(
          adapter,
          { model: ANTHROPIC_MODELS.noVision, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }] }, nestedImage("c1")] },
          testContext(fake.url),
        ),
      ).rejects.toThrow(/does not advertise image input/);
      expect(fake.requests).toHaveLength(0);
    });
  });

  test("a NESTED image reaches the wire in the family's own shape where the model DOES advertise vision", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        { model: ANTHROPIC_MODELS.main, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }] }, nestedImage("c1")] },
        testContext(fake.url),
      );
      expect(messageBlocks(fake.requests[0]!, 1)).toEqual([
        { type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "page 1" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] },
      ]);
    });
  });

  test("a `redacted_thinking` block that completes with NO data is a typed failure, not a silent drop", async () => {
    // The block IS the opaque continuation state; dropping it silently breaks the signature chain on
    // the next replay, and the failure would then surface as an upstream rejection of a request this
    // adapter had already decided was fine.
    const adapter = testAnthropicAdapter();
    const frames = [
      { event: "message_start", data: JSON.stringify({ type: "message_start", message: { id: "m", model: "m", usage: { input_tokens: 1, output_tokens: 0 } } }) },
      { event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking" } }) },
      { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
    ];
    await withFake({ routes: anthropicFakeRoutes({ messages: { "sc-redacted-nodata": () => sseResponse(frames) } }) }, async (fake) => {
      await expect(foldTurn(adapter, { model: "sc-redacted-nodata", messages: [{ role: "user", content: "go" }] }, testContext(fake.url))).rejects.toThrow(/redacted_thinking block completed with no/);
    });
  });
});

describe("Anthropic Messages: the descriptor's own completion event (Minor 7)", () => {
  test("a row naming `message_stop` holds its in-dialect blocks until then, and a broken stream releases none", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      const events = [];
      for await (const e of adapter.streamTurn({ model: ANTHROPIC_MODELS.lateCapture, messages: [{ role: "user", content: "go" }] }, testContext(fake.url))) events.push(e);
      // The block is complete at its own `content_block_stop`, but this row's evidence says the
      // capture happens at `message_stop` -- so it arrives AFTER the text and the tool call, not
      // interleaved where the default would put it.
      expect(events.map((e) => e.type)).toEqual([
        "message_start",
        "text_delta",
        "tool_call_start",
        "tool_call_delta",
        "tool_call_end",
        "native_thinking_block",
        "usage",
        "done",
      ]);
      const turn = await foldTurn(adapter, { model: ANTHROPIC_MODELS.lateCapture, messages: [{ role: "user", content: "go" }] }, testContext(fake.url));
      expect(turn.thinking?.blocks).toEqual([{ type: "thinking", thinking: "deferred", signature: "sig-late-1" }]);

      // ...AND A BROKEN STREAM RELEASES NONE. The same frames, cut one short of `message_stop`: the
      // block is complete at its own `content_block_stop` and is being held, and the event its row
      // names never arrives -- so the completion-event rule holds at whichever event a row names,
      // not just at the default one.
      const dropped = [];
      for await (const e of adapter.streamTurn({ model: ANTHROPIC_MODELS.lateCaptureDropped, messages: [{ role: "user", content: "go" }] }, testContext(fake.url))) dropped.push(e);
      expect(dropped.some((e) => e.type === "native_thinking_block")).toBe(false);
      expect(dropped.at(-1)).toMatchObject({ type: "error", error: { code: "network" } });
    });
  });

  test("the DEFAULT is the per-block terminator, so an unevidenced row is unchanged", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      const events = [];
      for await (const e of adapter.streamTurn({ model: ANTHROPIC_MODELS.full, messages: [{ role: "user", content: "go" }] }, testContext(fake.url))) events.push(e);
      expect(events[1]).toMatchObject({ type: "native_thinking_block" });
    });
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

describe("Anthropic Messages: countTokens is not a generation (Minor 4)", () => {
  test("a thinking budget that would not fit a generation's `max_tokens` still COUNTS", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      // The same request is a limit REFUSAL as a generation (a fixture above pins that) and a
      // perfectly ordinary count here, because a count has no output allowance for a budget to
      // overrun. Building the body and then deleting `max_tokens` ran the check on a field that was
      // about to be thrown away.
      const count = await adapter.countTokens!(
        { model: ANTHROPIC_MODELS.capped, messages: [{ role: "user", content: "a" }], thinking: { type: "enabled", budgetTokens: 4096 } },
        testContext(fake.url),
      );
      expect(count).toBe(100);
      const body = anthropicBody(requestsTo(fake, "/v1/messages/count_tokens")[0]!);
      expect(body["max_tokens"]).toBeUndefined();
      expect(body["stream"]).toBeUndefined();
      expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 4096 });
    });
  });
});

/**
 * Lane C's REAL output, verbatim.
 *
 * `decoration.text` arrives already finished and already delimited -- the `<recovered_reasoning_summary>`
 * tag WS-13 §8.2 names for the tag door, and the bracketed label for the thinking-channel door -- and
 * Lane C's §9.6 budget is counted on exactly these strings. The fixtures assert the wire carries them
 * BYTE-FOR-BYTE, because anything this layer added would double-label the second door and would add a
 * delimiter Lane C's own `neutralizeDelimiters` does not neutralise: a foreign summary containing the
 * added closing delimiter would break straight out of it.
 */
const LANE_C_DECORATIONS = {
  tag: { text: '<recovered_reasoning_summary provider="openai" model="gpt-5.6-sol">the model weighed two options.</recovered_reasoning_summary>', door: "tag" as const },
  "thinking-channel": { text: "[prior-model reasoning, carried as data \u2014 provider: openai, model: gpt-5.6-sol]\nthe model weighed two options.", door: "thinking-channel" as const },
};

describe("Anthropic Messages: a Lane C decoration is RENDERED, not inert (Minor 9)", () => {
  test("both doors ride as PLAIN TEXT, byte-for-byte as Lane C produced them, with NO wrapper of this layer's own", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      for (const door of ["tag", "thinking-channel"] as const) {
        await foldTurn(
          adapter,
          { model: ANTHROPIC_MODELS.main, messages: [{ role: "assistant", content: [{ type: "text", text: "the answer" }], decoration: LANE_C_DECORATIONS[door] }] },
          testContext(fake.url),
        );
      }
      expect(messageBlocks(fake.requests[0]!, 0)).toEqual([{ type: "text", text: LANE_C_DECORATIONS.tag.text }, { type: "text", text: "the answer" }]);
      expect(messageBlocks(fake.requests[1]!, 0)).toEqual([{ type: "text", text: LANE_C_DECORATIONS["thinking-channel"].text }, { type: "text", text: "the answer" }]);
      for (const recorded of fake.requests) {
        // Never dressed as reasoning the model did, and never re-delimited by this layer.
        expect(recorded.body).not.toContain('"type":"thinking"');
        expect(recorded.body).not.toContain('"signature"');
        expect(recorded.body).not.toContain("winter-note");
      }
    });
  });

  test("a decorated TOOL message puts its `tool_result` FIRST — the decoration follows it", async () => {
    // The endpoint requires `tool_result` blocks at the start of the turn they ride, and a tool-role
    // message becomes part of a `user` turn. A decoration rendered at index 0 was therefore
    // wire-invalid; the fake now rejects that ordering, so this pin can fail.
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        {
          model: ANTHROPIC_MODELS.main,
          messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }] },
            { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "out" }], decoration: LANE_C_DECORATIONS.tag },
          ],
        },
        testContext(fake.url),
      );
      assertAnthropicRequest(fake.requests[0]!, { roles: ["assistant", "user"], blockTypes: ["tool_use", "tool_result", "text"] });
      expect(messageBlocks(fake.requests[0]!, 1)[1]).toEqual({ type: "text", text: LANE_C_DECORATIONS.tag.text });
    });
  });

  test("TWO consecutive tool messages, the FIRST decorated, still put BOTH results before the decoration", async () => {
    // The constraint is a property of the MERGED entry, not of a message: a per-message fix yields
    // `[tool_result_1, text, tool_result_2]` here, which is correct per message and rejected on the
    // wire. This is the case that distinguishes the two fixes.
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        {
          model: ANTHROPIC_MODELS.main,
          messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }, { type: "tool_use", id: "c2", name: "Write", input: {} }] },
            { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "one" }], decoration: LANE_C_DECORATIONS.tag },
            { role: "tool", content: [{ type: "tool_result", tool_use_id: "c2", content: "two" }] },
          ],
        },
        testContext(fake.url),
      );
      assertAnthropicRequest(fake.requests[0]!, { roles: ["assistant", "user"], blockTypes: ["tool_use", "tool_use", "tool_result", "tool_result", "text"] });
      expect(messageBlocks(fake.requests[0]!, 1)).toEqual([
        { type: "tool_result", tool_use_id: "c1", content: "one" },
        { type: "tool_result", tool_use_id: "c2", content: "two" },
        { type: "text", text: LANE_C_DECORATIONS.tag.text },
      ]);
    });
  });

  test("the fake REJECTS a turn whose tool_result blocks are not first, so these pins can fail", async () => {
    // The guard is only worth having if it bites. Driven directly, because the adapter no longer
    // produces the ordering it forbids.
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      const res = await fetch(`${fake.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_TEST_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: [{ type: "text", text: "x" }, { type: "tool_result", tool_use_id: "c1", content: "out" }] }] }),
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("must be at the beginning of a turn");
    });
  });

  test("the decoration is placed AFTER any leading thinking blocks, which this endpoint requires", async () => {
    // With thinking enabled the endpoint rejects a text block that precedes the turn's own thinking
    // blocks -- so a decoration at index 0 made a decorated reasoning turn unsendable.
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        {
          model: ANTHROPIC_MODELS.main,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "why", signature: "sig-place-1" },
                { type: "redacted_thinking", data: "opaque-place-1" },
                { type: "text", text: "the answer" },
              ],
              decoration: LANE_C_DECORATIONS.tag,
            },
          ],
          thinking: { type: "enabled", budgetTokens: 1024 },
        },
        testContext(fake.url),
      );
      assertAnthropicRequest(fake.requests[0]!, { blockTypes: ["thinking", "redacted_thinking", "text", "text"] });
      expect(messageBlocks(fake.requests[0]!, 0)[2]).toEqual({ type: "text", text: LANE_C_DECORATIONS.tag.text });
    });
  });
});

describe("Anthropic Messages: a failing assertion never prints opaque state (Minor 8)", () => {
  test("a signature, a redacted payload and a thoughtSignature are redacted out of the failure message", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        {
          model: ANTHROPIC_MODELS.main,
          messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "why", signature: "SIG-MUST-NOT-PRINT" }, { type: "redacted_thinking", data: "DATA-MUST-NOT-PRINT" }] }],
        },
        testContext(fake.url),
      );
      // The body genuinely carries both -- that is the replay rule working.
      expect(fake.requests[0]!.body).toContain("SIG-MUST-NOT-PRINT");
      // ...and a FAILING assertion's message does not, because a failure message is the likeliest
      // thing in a test run to be pasted somewhere.
      let message = "";
      try {
        assertAnthropicRequest(fake.requests[0]!, { model: "deliberately-wrong" });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("deliberately-wrong");
      expect(message).not.toContain("SIG-MUST-NOT-PRINT");
      expect(message).not.toContain("DATA-MUST-NOT-PRINT");
      expect(message).toContain("redacted: opaque provider state");
    });
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

describe("R6-L / F-3: a CREDENTIAL-shaped host header never rides", () => {
  test("a connection profile carrying `cookie` + `x-trace` puts only `x-trace` on the wire (M-4)", async () => {
    // `hostHeaders` used to strip the four IDENTITY names only, so a host `cookie`,
    // `proxy-authorization` or `x-api-key` in a connection profile reached this family's wire on
    // every request — and a profile `x-api-key` would have been overwritten by the real credential
    // anyway, which is the shape that makes the misconfiguration invisible. A `ConnectionProfile` is
    // non-secret connection metadata by contract (WS-13 §6): a credential in it is dropped, never
    // honoured as a second auth channel.
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "hi" }] },
        testContext(fake.url, {
          connection: {
            providerId: "anthropic",
            baseUrl: fake.url,
            local: true,
            headers: { cookie: "session=SMUGGLED-COOKIE", "proxy-authorization": "Basic SMUGGLED-PROXY", "x-api-key": "SMUGGLED-KEY", "x-trace": "keep" },
          },
        }),
      );
      const recorded = fake.requests[0]!;
      expect(recorded.headers["x-trace"]).toBe("keep");
      expect(recorded.headers["cookie"]).toBeUndefined();
      expect(recorded.headers["proxy-authorization"]).toBeUndefined();
      for (const marker of ["SMUGGLED-COOKIE", "SMUGGLED-PROXY", "SMUGGLED-KEY"]) expect([marker, noRequestContains(fake, marker)]).toEqual([marker, true]);
      // The turn's REAL credential still rides: this rule is about the host's map, never about auth.
      expect(recorded.headers["x-api-key"]).toBeDefined();
    });
  });
});

describe("D20: Anthropic Console OAuth on the wire", () => {
  /**
   * Wraps the corpus routes so the RAW `authorization` value is captured.
   *
   * The base fake redacts credential headers as it records them (`Bearer ***`), which is right for
   * evidence a failing assertion prints and useless for the one thing this block must prove: that
   * the turn went out under the REFRESHED bearer rather than the stale one it started with. Counting
   * requests cannot tell those apart — the difference is the value. Same reasoning, and the same
   * shape, as the codex fake's own `bearers` array.
   */
  function capturingRoutes(bearers: string[]): FakeRoute[] {
    return anthropicCorpusRoutes().map((route) => ({
      ...route,
      handler: (req: Request, recorded: Parameters<typeof route.handler>[1]) => {
        const authorization = req.headers.get("authorization");
        if (authorization !== null) bearers.push(authorization.replace(/^Bearer /, ""));
        return route.handler(req, recorded);
      },
    }));
  }

  test("D20: oauth material rides as a Bearer with the OAuth beta as a PROTOCOL header, and a near-expiry token is refreshed BEFORE the turn", async () => {
    const oauthFake = await startAnthropicConsoleOauthFake();
    try {
      const store = createMemoryCredentialStore();
      const ref = anthropicCredentialRef(FAKE_CONSOLE_ACCOUNT_ID);
      // Expiring inside the 60 s freshness window, so the adapter must renew it before it speaks.
      await store.set(ref, { kind: "oauth", accessToken: "test-token-console-stale", refreshToken: FAKE_CONSOLE_REFRESH_TOKEN, accountId: FAKE_CONSOLE_ACCOUNT_ID, expiresAt: Date.now() + 1_000 });
      const adapter = testAnthropicAdapter({ tokenUrl: oauthFake.tokenUrl });
      const bearers: string[] = [];
      await withFake({ routes: capturingRoutes(bearers) }, async (fake) => {
        await foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "hi" }] }, testContext(fake.url, { credentials: store, authRef: ref }));

        const turn = fake.requests.at(-1)!;
        // A Bearer, and NOT an api key: the artifact's own auth builder is a ternary between exactly
        // these two shapes, and it never sends both (derived-shapes-p6b.md §2.5).
        expect(turn.headers["authorization"]).toBe("Bearer ***");
        expect(turn.headers["x-api-key"]).toBeUndefined();
        // The OAuth beta rides as a PROTOCOL header (R6-L): every endpoint speaking this dialect
        // under an OAuth bearer needs it, and it names no account.
        expect(turn.headers["anthropic-beta"]).toContain(CONSOLE_OAUTH.betaHeader);

        // REFRESHED ONCE, BEFORE the generation — not after a 401, which would spend a turn to learn
        // something the expiry already said.
        expect(oauthFake.tokenRequests).toHaveLength(1);
        // R-A2-1: JSON on the refresh grant too, and NO `anthropic-beta` on it -- that header rides
        // the API request, never the token endpoint (the capture's §2.3 vs §2.5).
        expect(oauthFake.tokenRequests[0]?.headers["content-type"]).toBe("application/json");
        expect(oauthFake.tokenRequests[0]?.headers["anthropic-beta"]).toBeUndefined();
        const grant = JSON.parse(oauthFake.tokenRequests[0]!.body) as Record<string, string>;
        expect(grant["grant_type"]).toBe("refresh_token");
        // The artifact's own refresh carries `scope`; Winter sends the scope it was granted.
        expect(grant["scope"]).toBe(CONSOLE_OAUTH.scope);
        // And the turn actually USED the new token. Counting the refresh alone would pass on an
        // adapter that renewed the record and then sent the stale bearer anyway.
        expect(bearers).toEqual([FAKE_CONSOLE_REFRESHED_ACCESS_TOKEN]);
        const stored = await store.get(ref);
        expect(stored?.kind === "oauth" ? stored.accessToken : "").toBe(FAKE_CONSOLE_REFRESHED_ACCESS_TOKEN);
        // The merge rule: a refresh that does not rotate the refresh token must not erase it.
        expect(stored?.kind === "oauth" ? stored.refreshToken : "").toBe(FAKE_CONSOLE_REFRESH_TOKEN);
      });
    } finally {
      await oauthFake.close();
    }
  }, 15_000);

  test("a token with plenty of life left is NOT refreshed — the freshness window is a window, not a per-turn round trip", async () => {
    const oauthFake = await startAnthropicConsoleOauthFake();
    try {
      const store = createMemoryCredentialStore();
      const ref = anthropicCredentialRef(FAKE_CONSOLE_ACCOUNT_ID);
      await store.set(ref, { kind: "oauth", accessToken: FAKE_CONSOLE_ACCESS_TOKEN, refreshToken: FAKE_CONSOLE_REFRESH_TOKEN, accountId: FAKE_CONSOLE_ACCOUNT_ID, expiresAt: Date.now() + 3_600_000 });
      const adapter = testAnthropicAdapter({ tokenUrl: oauthFake.tokenUrl });
      const bearers: string[] = [];
      await withFake({ routes: capturingRoutes(bearers) }, async (fake) => {
        await foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "hi" }] }, testContext(fake.url, { credentials: store, authRef: ref }));
        expect(oauthFake.tokenRequests).toHaveLength(0);
        expect(bearers).toEqual([FAKE_CONSOLE_ACCESS_TOKEN]);
        expect(fake.requests.at(-1)!.headers["anthropic-beta"]).toContain(CONSOLE_OAUTH.betaHeader);
      });
    } finally {
      await oauthFake.close();
    }
  }, 15_000);

  test("an API-KEY turn carries neither the OAuth beta nor an Authorization header — the arm is chosen by the material, not switched on globally", async () => {
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "hi" }] }, testContext(fake.url));
      const turn = fake.requests.at(-1)!;
      expect(turn.headers["x-api-key"]).toBeDefined();
      expect(turn.headers["authorization"]).toBeUndefined();
      expect(turn.headers["anthropic-beta"]).toBeUndefined();
    });
  });

  test("M-3: `bearer` material rides as `Authorization: Bearer` and NEVER as `x-api-key` — the sibling rows' live condition", async () => {
    // Whole-branch review M-3. The four `<id>-anthropic` siblings carry `authKinds: ["api-key"]`, so
    // this adapter sends `x-api-key`; but what their citations establish is that the vendor's own
    // page targets Claude Code, whose auth-token mode sends `Authorization: Bearer`. Whether those
    // endpoints ALSO accept `x-api-key` is a LIVE condition, and the gate now has a
    // `WINTER_LIVE_<P>_BEARER` selector to vary it.
    //
    // `messages.ts` already supported `bearer` material -- and NOTHING asserted it, so "the gate can
    // now produce a bearer" rested on a branch no test drove. This is that assertion, on the wire.
    // The row is a SIBLING id, not `anthropic`, so the D20 beta cannot ride along and make the
    // request look right for the wrong reason.
    const store = createMemoryCredentialStore();
    const ref = { kind: "keychain" as const, account: "deepseek-anthropic:bearer-fixture" };
    await store.set(ref, { kind: "bearer", token: "test-token-sibling-bearer" });
    const adapter = testAnthropicAdapter();
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "hi" }] },
        testContext(fake.url, { connection: { providerId: "deepseek-anthropic", baseUrl: fake.url, local: true }, credentials: store, authRef: ref }),
      );
      const turn = fake.requests.at(-1)!;
      // The fake redacts a credential value as it records it, so the SCHEME is asserted without a
      // token ever entering an assertion or a failure message.
      expect(turn.headers["authorization"]).toBe("Bearer ***");
      expect(turn.headers["x-api-key"]).toBeUndefined();
      // ...and no vendor beta: this is a third party's row, not Anthropic's.
      expect(turn.headers["anthropic-beta"]).toBeUndefined();
      expect(turn.headers["anthropic-version"]).toBeDefined();
    });
  });

  test("WS-13b: an OAuth turn still names Winter and carries NO vendor product identity — not in the user-agent, and not in the beta list", async () => {
    const oauthFake = await startAnthropicConsoleOauthFake();
    try {
      const store = createMemoryCredentialStore();
      const ref = anthropicCredentialRef(FAKE_CONSOLE_ACCOUNT_ID);
      await store.set(ref, { kind: "oauth", accessToken: FAKE_CONSOLE_ACCESS_TOKEN, refreshToken: FAKE_CONSOLE_REFRESH_TOKEN, accountId: FAKE_CONSOLE_ACCOUNT_ID, expiresAt: Date.now() + 3_600_000 });
      const adapter = testAnthropicAdapter({ tokenUrl: oauthFake.tokenUrl });
      await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
        await foldTurn(adapter, { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "hi" }] }, testContext(fake.url, { credentials: store, authRef: ref }));
        const turn = fake.requests.at(-1)!;
        expect(turn.headers["user-agent"]).toBe(winterUserAgent());
        // The corpus pin the brief asks for. The pinned artifact carries a SECOND beta,
        // `claude-code-20250219`, which names its own product; Winter sends the `oauth_auth` one and
        // never that. Checked across every header of every request, not just the two we set, because
        // the way a product identity arrives is on a header nobody was looking at.
        for (const recorded of fake.requests) {
          for (const [name, value] of Object.entries(recorded.headers)) {
            if (name === "host") continue; // 127.0.0.1:<port>, never a vendor name
            // BOTH HALVES. The first version of this sweep asserted `[name, value]` against
            // `[name, matcher]` -- comparing the name to ITSELF, which always passes, so a header
            // NAMED for the vendor (`x-claude-…`) would have sailed through the one test written to
            // catch exactly that.
            expect(name).not.toMatch(/claude/i);
            expect(value).not.toMatch(/claude/i);
          }
        }
      });
    } finally {
      await oauthFake.close();
    }
  }, 15_000);
});

describe("R6b-5: the D20 arm belongs to the anthropic ROW, not to the adapter", () => {
  // This adapter is multi-provider: a third party speaking the Anthropic Messages dialect ships as
  // its own `<id>-anthropic` row on the SAME `adapterId`, with its own endpoint. Nothing upstream
  // checks that a stored credential's KIND matches its row's `authKinds`, so an `oauth` credential
  // configured against a sibling row reaches this adapter looking exactly like a Console one. If the
  // D20 behaviours keyed on the material alone, that would post the THIRD PARTY'S REFRESH TOKEN to
  // `platform.claude.com` under Anthropic's client id, and stamp Anthropic's beta on the third
  // party's request. Neither is a thing a wrong configuration should be able to cause.
  test("oauth material on a SIBLING provider row rides as a plain Bearer: no Anthropic beta, and NOTHING is sent to Anthropic's token endpoint", async () => {
    const oauthFake = await startAnthropicConsoleOauthFake();
    try {
      const store = createMemoryCredentialStore();
      const ref = { kind: "keychain" as const, account: "deepseek-anthropic:acct-test-sibling" };
      // Near expiry, so a provider-blind implementation WOULD refresh — the condition that makes
      // this test able to fail.
      await store.set(ref, { kind: "oauth", accessToken: "test-token-sibling-access", refreshToken: "test-token-sibling-refresh", expiresAt: Date.now() + 1_000 });
      const adapter = testAnthropicAdapter({ tokenUrl: oauthFake.tokenUrl });
      await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
        await foldTurn(
          adapter,
          { model: ANTHROPIC_MODELS.main, messages: [{ role: "user", content: "hi" }] },
          testContext(fake.url, { credentials: store, authRef: ref, connection: { providerId: "deepseek-anthropic", baseUrl: fake.url, local: true } }),
        );
        // ASSERTED FIRST because it is the worst of the two failures and an earlier assertion would
        // mask it: the sibling's refresh token never left for Anthropic's token endpoint, and the
        // record it would have overwritten is untouched.
        expect(oauthFake.tokenRequests).toHaveLength(0);
        const stored = await store.get(ref);
        expect(stored?.kind === "oauth" ? stored.accessToken : "").toBe("test-token-sibling-access");
        const turn = fake.requests.at(-1)!;
        // The credential still authenticates the request — this rule is about Anthropic-specific
        // behaviour, never about refusing to send the credential the host configured.
        expect(turn.headers["authorization"]).toBe("Bearer ***");
        expect(turn.headers["anthropic-beta"]).toBeUndefined();
      });
    } finally {
      await oauthFake.close();
    }
  }, 15_000);
});
