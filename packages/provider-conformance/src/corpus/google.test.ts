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

  test("a SAFETY finish reason is a `refusal`, not a completed empty turn", async () => {
    const adapter = testGoogleAdapter();
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      const turn = await foldTurn(adapter, { model: GOOGLE_MODELS.refusal, messages: [{ role: "user", content: "go" }] }, googleContext(fake.url));
      expect(turn.stopReason).toBe("refusal");
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
      // The drop is REPORTED as a count. Silence here would be the failure mode; content here would
      // be a worse one.
      const drop = logged.find((e) => e.kind === "provider.request.foreign-reasoning-dropped");
      expect(drop).toMatchObject({ bytes: 2 });
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
      expect(turn.nativeState?.items).toEqual([{ partIndex: 2, callId: "google-call-0", signature: GOOGLE_SIGNATURE }]);
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

  test("`mapEffort` refuses a tier the model does not declare, and maps a number onto the nearest one", () => {
    const descriptor = testGoogleCatalog().models.find((m) => m.upstreamId === GOOGLE_MODELS.main)!;
    expect(mapGoogleEffort(0, descriptor)).toEqual({ ok: true, value: { thinkingBudget: 1024 } });
    expect(mapGoogleEffort(100, descriptor)).toEqual({ ok: true, value: { thinkingBudget: 24576 } });
    const noEfforts = testGoogleCatalog().models.find((m) => m.upstreamId === GOOGLE_MODELS.noEfforts)!;
    expect(mapGoogleEffort("low", noEfforts)).toMatchObject({ ok: false });
    expect(mapGoogleEffort("low", undefined)).toMatchObject({ ok: false });
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
