// Phase 6 Task 6 (Lane B): the Google GenerateContent adapter, proved on the wire.
//
// Same contract as the Anthropic fixtures: every assertion reads the live request the loopback fake
// received, and the normalized stream is folded by the REAL consumer.
import { describe, expect, test } from "bun:test";
import { noRequestContains, requestsTo, withFake } from "../fakes/server.ts";
import { assertGeminiRequest, geminiBody, geminiContents, geminiFakeRoutes, geminiStreamResponse } from "../fakes/gemini.ts";
import { createGoogleGenerateContentAdapter, GOOGLE_ADAPTER_ID, GOOGLE_DEFAULT_BASE_URL, mapGoogleEffort, toContents } from "../../../provider-runtime/src/adapters/google/index.ts";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { formatCorpusReport, runAdapterCorpus } from "./runner.ts";
import { GOOGLE_MODELS, GOOGLE_SIGNATURE, GOOGLE_TEST_KEY, foldTurn, googleContext, googleCorpusCases, googleCorpusRoutes, testGoogleAdapter, testGoogleCatalog } from "./google.ts";

describe("Google GenerateContent: the live request", () => {
  test("puts the model and the method in the PATH, selects SSE with `?alt=sse`, and authenticates with x-goog-api-key", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      await foldTurn(adapter, { model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "hello" }] }, googleContext(fake.url));
      expect(fake.requests[0]!.path).toBe(`/v1beta/models/${GOOGLE_MODELS.main}:streamGenerateContent`);
      assertGeminiRequest(fake.requests[0]!, { model: GOOGLE_MODELS.main, search: "?alt=sse", roles: ["user"], partKinds: ["text"] });
      expect(noRequestContains(fake, GOOGLE_TEST_KEY)).toBe(true);
    });
  });

  test("`x-goog-user-project` is PRIVILEGED: present for a generated endpoint, dropped for a user one (R6-L)", async () => {
    // The negative is the one that matters, and it is the one this fixture can prove on the wire: a
    // loopback fake is by construction a USER endpoint (`baseUrl` is set), so the account identifier
    // must not reach it. The positive is proved against the policy itself, below, because a
    // generated endpoint is `api.anthropic.com`/`generativelanguage.googleapis.com` and no test may
    // contact either.
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      await foldTurn(adapter, { model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "hi" }] }, googleContext(fake.url, { connection: { providerId: "google", baseUrl: fake.url, local: true, project: "winter-test-project" } }));
      expect(fake.requests[0]!.headers["x-goog-user-project"]).toBeUndefined();
      expect(noRequestContains(fake, "winter-test-project")).toBe(true);
    });
  });

  test("`hostHeaders` keeps an identity header on a GENERATED endpoint and drops it on a user one", async () => {
    const { createEndpointPolicy } = await import("@yanlinglabs/winter-provider-runtime");
    const { hostHeaders, PRIVILEGED_IDENTITY_HEADERS } = await import("../../../provider-runtime/src/adapters/privileged-headers.ts");
    const generated = createEndpointPolicy(GOOGLE_DEFAULT_BASE_URL, { generated: true });
    const user = createEndpointPolicy("https://example.invalid", { generated: false });
    expect(generated.ok && user.ok).toBe(true);
    if (!generated.ok || !user.ok) return;
    const supplied = { "x-goog-user-project": "p", "X-GOOG-USER-PROJECT": "p2", "openai-organization": "o", "x-trace": "keep" };
    // A reviewed descriptor endpoint vouches for the identity headers that belong to it.
    expect(hostHeaders(generated.policy, supplied)).toEqual(supplied);
    // Case-INSENSITIVELY on a user endpoint: a plain record compares keys case-sensitively, so an
    // upper-case spelling was the obvious way past a naive filter.
    expect(hostHeaders(user.policy, supplied)).toEqual({ "x-trace": "keep" });
    // A family's own extra name is honoured, and the input is never mutated.
    expect(hostHeaders(user.policy, { "x-family-org": "o", "x-trace": "keep" }, ["X-Family-Org"])).toEqual({ "x-trace": "keep" });
    expect(supplied["x-goog-user-project"]).toBe("p");
    expect(PRIVILEGED_IDENTITY_HEADERS).toContain("x-goog-user-project");
  });

  test("the privileged header IS built for a generated endpoint", async () => {
    const { applyPrivilegedHeaders, createEndpointPolicy } = await import("@yanlinglabs/winter-provider-runtime");
    const generated = createEndpointPolicy(GOOGLE_DEFAULT_BASE_URL, { generated: true });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(applyPrivilegedHeaders(generated.policy, { "x-goog-user-project": "p" })).toEqual({ "x-goog-user-project": "p" });
    const user = createEndpointPolicy("https://example.invalid", { generated: false });
    expect(user.ok).toBe(true);
    if (!user.ok) return;
    expect(applyPrivilegedHeaders(user.policy, { "x-goog-user-project": "p" })).toEqual({});
  });

  test("`thinkingConfig`: disabled is a ZERO budget, adaptive OMITS one, and a summary is asked for the descriptor's own way", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      const ctx = googleContext(fake.url);
      await foldTurn(adapter, { model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "a" }], thinking: { type: "disabled" } }, ctx);
      expect((geminiBody(fake.requests[0]!)["generationConfig"] as Record<string, unknown>)["thinkingConfig"]).toEqual({ thinkingBudget: 0 });

      await foldTurn(adapter, { model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "a" }], thinking: { type: "adaptive" }, requestSummary: true }, ctx);
      // `adaptive` means "the model decides"; this family expresses that as the ABSENCE of a budget,
      // so no sentinel is invented.
      expect((geminiBody(fake.requests[1]!)["generationConfig"] as Record<string, unknown>)["thinkingConfig"]).toEqual({ includeThoughts: true });

      await foldTurn(adapter, { model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "a" }] }, ctx);
      expect(geminiBody(fake.requests[2]!)["generationConfig"]).toBeUndefined();
    });
  });

  test("reasoning tokens reported on an EARLY chunk survive a later chunk that restates only the visible count", async () => {
    // Accumulating both counters into one variable loses the reasoning half the moment a provider
    // restates only what changed -- an under-report of a reasoning turn's real cost, silently.
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      const turn = await foldTurn(adapter, { model: GOOGLE_MODELS.splitUsage, messages: [{ role: "user", content: "go" }] }, googleContext(fake.url));
      expect(turn.usage).toEqual({ inputTokens: 10, outputTokens: 13 });
    });
  });

  test("a SAFETY finish reason is a `refusal`, not a completed empty turn", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      const turn = await foldTurn(adapter, { model: GOOGLE_MODELS.refusal, messages: [{ role: "user", content: "go" }] }, googleContext(fake.url));
      expect(turn.stopReason).toBe("refusal");
    });
  });
});

describe("Google GenerateContent: images nested inside a tool_result (I2/I3)", () => {
  const history = (model: string) => ({
    model,
    messages: [
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "c1", name: "Read", input: {} }] },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "c1",
            content: [{ type: "text" as const, text: "page 1" }, { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "aGVsbG8=" } }],
          },
        ],
      },
    ],
  });

  test("a NESTED image is refused before the request for a non-vision model", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      await expect(foldTurn(adapter, history(GOOGLE_MODELS.noVision), googleContext(fake.url))).rejects.toThrow(/does not advertise image input/);
      expect(fake.requests).toHaveLength(0);
    });
  });

  test("a NESTED image rides as a SIBLING `inlineData` part, never silently filtered out", async () => {
    // `functionResponse.response` is a Struct -- JSON, with no field that carries binary -- so the
    // image cannot travel inside the response. It goes beside it, on the same `user` entry, in the
    // same `inline_data` field a user-supplied image rides; `imageCount` is what associates the two.
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      await foldTurn(adapter, history(GOOGLE_MODELS.main), googleContext(fake.url));
      const contents = geminiContents(fake.requests[0]!);
      expect(contents[1]?.parts).toEqual([
        { functionResponse: { name: "Read", response: { output: "page 1", imageCount: 1 } } },
        { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
      ]);
    });
  });
});

describe("Google GenerateContent: foreign reasoning at the family boundary", () => {
  test("an Anthropic thinking block is DROPPED and COUNTED, never written into `parts`", async () => {
    const adapter = testGoogleAdapter();
    const logged: Array<{ kind: string; bytes?: number }> = [];
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        {
          model: GOOGLE_MODELS.main,
          messages: [
            { role: "user", content: "go" },
            { role: "assistant", content: [{ type: "thinking", thinking: "ANOTHER-DIALECTS-REASONING", signature: "sig-x" }, { type: "redacted_thinking", data: "OPAQUE-Y" }, { type: "text", text: "answer" }] },
          ],
        },
        googleContext(fake.url, { log: (event) => logged.push(event) }),
      );
      // Not in the body, in any form -- and the opaque payload certainly not.
      expect(noRequestContains(fake, "ANOTHER-DIALECTS-REASONING")).toBe(true);
      expect(noRequestContains(fake, "OPAQUE-Y")).toBe(true);
      expect(geminiContents(fake.requests[0]!)[1]?.parts).toEqual([{ text: "answer" }]);
      // The drop is REPORTED, once per dropped block. Silence here would be the failure mode; content
      // here would be a worse one -- and the count rides the NUMBER OF EVENTS rather than a field
      // named `bytes`, because the seam's frozen telemetry shape has no count field and a block count
      // wedged into a byte field is read as a size by whatever consumes it.
      const drops = logged.filter((e) => e.kind === "provider.request.foreign-reasoning-dropped");
      expect(drops).toHaveLength(2);
      expect(drops.every((e) => e.bytes === undefined)).toBe(true);
      expect(JSON.stringify(logged)).not.toContain("ANOTHER-DIALECTS-REASONING");
    });
  });
});

describe("Google GenerateContent: opaque state never leaks", () => {
  test("a `thoughtSignature` reaches the sidecar and the next request body -- and nothing else", async () => {
    const adapter = testGoogleAdapter();
    const logged: unknown[] = [];
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      const turn = await foldTurn(adapter, { model: GOOGLE_MODELS.replay, messages: [{ role: "user", content: "go" }] }, googleContext(fake.url, { log: (e) => logged.push(e) }));
      expect(turn.nativeState?.items).toEqual([{ partIndex: 2, kind: "function-call", callId: (turn as { calls: Array<{ id: string }> }).calls[0]!.id, signature: GOOGLE_SIGNATURE }]);
      // Never in a log line...
      expect(JSON.stringify(logged)).not.toContain(GOOGLE_SIGNATURE);
      // ...never in the first request (it had not been minted yet)...
      expect(noRequestContains(fake, GOOGLE_SIGNATURE)).toBe(true);
      // ...and never on the turn's own text or thinking summary.
      expect(JSON.stringify({ text: turn.text, thinking: turn.thinking })).not.toContain(GOOGLE_SIGNATURE);
    });
  });

  test("a failure's message never carries the signature", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      let message = "";
      try {
        await foldTurn(adapter, { model: GOOGLE_MODELS.dropBeforeFinish, messages: [{ role: "user", content: "go" }] }, googleContext(fake.url));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toContain(GOOGLE_SIGNATURE);
      expect(message).toContain("network");
    });
  });
});

describe("Google GenerateContent: a thought part's signature is never re-keyed (I4)", () => {
  test("a signed THOUGHT part does not stamp its signature onto the replayed TEXT part", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      const ctx = googleContext(fake.url);
      const turn = await foldTurn(adapter, { model: GOOGLE_MODELS.signedThought, messages: [{ role: "user", content: "go" }] }, ctx);
      // RETAINED as opaque state, keyed as a thought -- so it is not lost...
      expect(turn.nativeState?.items).toEqual([{ partIndex: 0, kind: "thought", signature: GOOGLE_SIGNATURE }]);
      expect(turn.thinking?.summary).toBe("private reasoning");
      expect(turn.text).toBe("the answer");

      // ...and ATTACHED TO NOTHING on replay: a thought part is never replayed as content (R6-8), so
      // there is no part for its signature to ride, and stamping it on the text part beside it is a
      // signature minted for one part re-attached to another -- which a validating endpoint can reject.
      await foldTurn(
        adapter,
        {
          model: GOOGLE_MODELS.signedThought,
          messages: [
            { role: "user", content: "go" },
            { role: "assistant", content: [{ type: "text", text: turn.text ?? "" }], nativeState: { family: "google", continuationDomain: `google/${GOOGLE_MODELS.signedThought}`, items: turn.nativeState?.items ?? [] } },
          ],
        },
        ctx,
      );
      const replayed = geminiContents(fake.requests[1]!);
      expect(replayed[1]?.parts).toEqual([{ text: "the answer" }]);
      expect(noRequestContains(fake, GOOGLE_SIGNATURE)).toBe(true);
    });
  });

  test("a record written BEFORE `kind` existed is read as addressable-by-nothing, not guessed at as text", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        {
          model: GOOGLE_MODELS.main,
          messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }], nativeState: { family: "google", continuationDomain: "google/gemini-2.5-pro", items: [{ partIndex: 0, signature: GOOGLE_SIGNATURE }] } }],
        },
        googleContext(fake.url),
      );
      expect(geminiContents(fake.requests[0]!)[0]?.parts).toEqual([{ text: "hi" }]);
      expect(noRequestContains(fake, GOOGLE_SIGNATURE)).toBe(true);
    });
  });

  test("a descriptor naming a DIFFERENT completion event is honoured, and the marker is the only variable (Minor 7)", async () => {
    // A/B on ONE stream: it finishes, and it never sends `usageMetadata`. The default row completes
    // and captures; the row whose evidence names the usage chunk as its completion event never sees
    // that chunk, so it captures NOTHING and does not report a completed turn — which is the
    // completion-event rule stated at whichever event a row names.
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      const ctx = googleContext(fake.url);
      const byDefault = [];
      for await (const e of adapter.streamTurn({ model: GOOGLE_MODELS.lateUsageDefault, messages: [{ role: "user", content: "go" }] }, ctx)) byDefault.push(e);
      expect(byDefault.map((e) => e.type)).toEqual(["message_start", "text_delta", "native_state", "usage", "done"]);

      const evidenced = [];
      for await (const e of adapter.streamTurn({ model: GOOGLE_MODELS.lateUsage, messages: [{ role: "user", content: "go" }] }, ctx)) evidenced.push(e);
      expect(evidenced.map((e) => e.type)).toEqual(["message_start", "text_delta", "error"]);
      expect(evidenced.some((e) => e.type === "native_state")).toBe(false);
    });
  });
});

describe("Google GenerateContent: the pure mapping", () => {
  test("`toContents` merges adjacent roles, maps a tool role to `user`, and refuses an orphan result", () => {
    expect(
      toContents([
        { role: "user", content: "a" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: { p: 1 } }] },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "out" }] },
        { role: "user", content: "b" },
      ]).contents,
    ).toEqual([
      { role: "user", parts: [{ text: "a" }] },
      { role: "model", parts: [{ functionCall: { name: "Read", args: { p: 1 } } }] },
      { role: "user", parts: [{ functionResponse: { name: "Read", response: { output: "out" } } }, { text: "b" }] },
    ]);
    expect(() => toContents([{ role: "tool", content: [{ type: "tool_result", tool_use_id: "nope", content: "x" }] }])).toThrow(/has no matching tool_use/);
  });

  test("a tool_result resolves to the NEAREST PRECEDING call, not to the last one in the history", () => {
    // THE REGRESSION TEST for a live bug: this family's `functionCall` carries no id, so Winter mints
    // one -- and a per-turn counter re-mints the same first id every turn. A flat pre-pass name map
    // was therefore last-write-wins across the conversation, and turn 1's `functionResponse` went on
    // the wire naming turn 2's tool. Wrong tool, silently, on the ordinary multi-tool-loop shape.
    const { contents } = toContents([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "shared-id", name: "Read", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "shared-id", content: "read output" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "shared-id", name: "Write", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "shared-id", content: "write output" }] },
    ]);
    const responses = contents.flatMap((c) => c.parts).filter((p): p is { functionResponse: { name: string } } => "functionResponse" in p);
    expect(responses.map((r) => r.functionResponse.name)).toEqual(["Read", "Write"]);
  });

  test("two turns in one session never share a minted call id", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      const ctx = googleContext(fake.url);
      const first = await foldTurn(adapter, { model: GOOGLE_MODELS.full, messages: [{ role: "user", content: "a" }] }, ctx);
      const second = await foldTurn(adapter, { model: GOOGLE_MODELS.full, messages: [{ role: "user", content: "b" }] }, ctx);
      const idOf = (turn: unknown) => (turn as { calls: Array<{ id: string }> }).calls[0]!.id;
      // The engine correlates a subagent's frames to its parent BY tool_use id, so a collision across
      // turns is not cosmetic.
      expect(idOf(first)).not.toBe(idOf(second));
      expect(idOf(first)).toMatch(/^google-call-[0-9a-f]{8}-0$/);
    });
  });

  test("`{ type: \"enabled\" }` with NO budget is refused BEFORE the request, never sent as the model's default", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      await expect(
        foldTurn(adapter, { model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "a" }], thinking: { type: "enabled" } }, googleContext(fake.url)),
      ).rejects.toThrow(/no budgetTokens/);
      expect(fake.requests).toHaveLength(0);
    });
  });

  test("a host header cannot override a PROTOCOL header, and an identity header it smuggles is STRIPPED on a user endpoint (R6-L)", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        { model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "a" }] },
        googleContext(fake.url, {
          connection: { providerId: "google", baseUrl: fake.url, local: true, headers: { "content-type": "text/plain", "x-goog-user-project": "smuggled-project", "x-host-own": "kept" } },
        }),
      );
      const recorded = fake.requests[0]!;
      // Winter's own values win: a host header spread LAST could replace `content-type`, and a wrong
      // one surfaces as an unexplained upstream 400 rather than as anything local.
      expect(recorded.headers["content-type"]).toContain("application/json");
      // A header that collides with nothing is still the host's to send.
      expect(recorded.headers["x-host-own"]).toBe("kept");
      // R6-L, ENFORCED ON THE HOST'S OWN MAP TOO. `applyPrivilegedHeaders` gates the set the ADAPTER
      // builds; it cannot remove a name from a map it never saw, so before `hostHeaders` this exact
      // request put the operator's account topology on a user endpoint past the rule. R6-L is strict
      // as written: an endpoint that legitimately needs an organisation header must be marked
      // GENERATED by the host.
      expect(recorded.headers["x-goog-user-project"]).toBeUndefined();
      expect(noRequestContains(fake, "smuggled-project")).toBe(true);
    });
  });

  test("`mapEffort` refuses a tier the model does not declare, and maps a number onto the nearest one", () => {
    const descriptor = testGoogleCatalog().models.find((m) => m.upstreamId === GOOGLE_MODELS.main)!;
    expect(mapGoogleEffort(0, descriptor)).toEqual({ ok: true, value: { thinkingBudget: 1024 } });
    expect(mapGoogleEffort(100, descriptor)).toEqual({ ok: true, value: { thinkingBudget: 24576 } });
    const noEfforts = testGoogleCatalog().models.find((m) => m.upstreamId === GOOGLE_MODELS.noEfforts)!;
    expect(mapGoogleEffort("low", noEfforts)).toMatchObject({ ok: false });
    expect(mapGoogleEffort("low", undefined)).toMatchObject({ ok: false });
  });
});

describe("Google GenerateContent: a Lane C decoration is RENDERED, not inert (Minor 9)", () => {
  test("both doors ride as a LEADING PLAIN TEXT part — never as a `thought` part the model did not produce", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      for (const door of ["tag", "thinking-channel"] as const) {
        await foldTurn(
          adapter,
          { model: GOOGLE_MODELS.main, messages: [{ role: "assistant", content: [{ type: "text", text: "the answer" }], decoration: { text: `note-${door}`, door } }] },
          googleContext(fake.url),
        );
      }
      expect(geminiContents(fake.requests[0]!)[0]?.parts).toEqual([{ text: "<winter-note>note-tag</winter-note>" }, { text: "the answer" }]);
      expect(geminiContents(fake.requests[1]!)[0]?.parts).toEqual([{ text: "<winter-note>note-thinking-channel</winter-note>" }, { text: "the answer" }]);
      // A decoration is Winter's, not the model's: it must never be marked as reasoning the model did.
      for (const recorded of fake.requests) expect(recorded.body).not.toContain('"thought"');
    });
  });

  test("a decoration does not consume the text ordinal a `thoughtSignature` is keyed to", async () => {
    // The decoration is prepended BEFORE the model's own text part, so a naive "first text part"
    // lookup would stamp the signature onto Winter's note instead of the model's answer.
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      await foldTurn(
        adapter,
        {
          model: GOOGLE_MODELS.main,
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "the answer" }],
              decoration: { text: "a note", door: "tag" },
              nativeState: { family: "google", continuationDomain: "google/gemini-2.5-pro", items: [{ partIndex: 0, kind: "text", signature: GOOGLE_SIGNATURE }] },
            },
          ],
        },
        googleContext(fake.url),
      );
      expect(geminiContents(fake.requests[0]!)[0]?.parts).toEqual([
        { text: "<winter-note>a note</winter-note>" },
        { text: "the answer", thoughtSignature: GOOGLE_SIGNATURE },
      ]);
    });
  });
});

describe("Google GenerateContent: countTokens and catalog agreement", () => {
  test("`countTokens` is a REAL count from `:countTokens`, with the generation parameters stripped", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      const count = await adapter.countTokens!(
        { model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], thinking: { type: "enabled", budgetTokens: 128 } },
        googleContext(fake.url),
      );
      expect(count).toBe(200);
      const recorded = requestsTo(fake, `/v1beta/models/${GOOGLE_MODELS.main}:countTokens`)[0]!;
      expect(geminiBody(recorded)["generationConfig"]).toBeUndefined();
      expect(geminiBody(recorded)["contents"]).toHaveLength(2);
    });
  });

  test("the adapter's id and default endpoint match the COMPILED catalog's own row", () => {
    const catalog = loadCatalog();
    const provider = catalog.providers.find((p) => p.id === "google")!;
    expect(provider.adapterId).toBe(GOOGLE_ADAPTER_ID);
    expect(provider.defaultEndpoints["api"]).toBe(GOOGLE_DEFAULT_BASE_URL);
    const adapter = createGoogleGenerateContentAdapter();
    expect(adapter.family).toBe("google");
    expect(adapter.protocol).toBe("google-generate-content");
  });

  test("the SHIPPED google row declares no effort vocabulary, so every effort level is refused against it", () => {
    // A finding, pinned as a test rather than only written in a report: until Lane X evidences an
    // effort vocabulary for this row, `effort` on the compiled catalog is a typed refusal.
    const shipped = loadCatalog().models.find((m) => m.key === "google/gemini-2.5-pro")!;
    expect(shipped.reasoning?.efforts ?? []).toEqual([]);
    expect(mapGoogleEffort("medium", shipped)).toMatchObject({ ok: false });
  });
});

describe("Google GenerateContent: the WS-13 §13 corpus", () => {
  test("every case fires against the loopback fake, and the report says so", async () => {
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      const report = await runAdapterCorpus({ adapter: GOOGLE_ADAPTER_ID, fake, model: GOOGLE_MODELS.main, cases: googleCorpusCases() });
      if (!report.ok) throw new Error(formatCorpusReport(report));
      // ONE recorded skip, with its reason: this family does not fragment tool arguments.
      expect(report.outcomes.filter((o) => o.status === "skipped").map((o) => o.id)).toEqual(["tool-call-fragmented"]);
      expect(report.outcomes.filter((o) => o.status === "missing" || o.status === "failed")).toEqual([]);
    });
  }, 30_000);

  test("a fake with an unscripted model answers LOUDLY, so a scenario gap can never look like a pass", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: geminiFakeRoutes({ stream: { known: () => geminiStreamResponse([{ parts: [{ text: "x" }], finishReason: "STOP" }]) } }) }, async (fake) => {
      let failed = false;
      try {
        await foldTurn(adapter, { model: "unscripted", messages: [{ role: "user", content: "go" }] }, googleContext(fake.url));
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });
  });
});
