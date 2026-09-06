import { describe, expect, test } from "bun:test";
import { createRegistry } from "../../../provider-runtime/src/registry.ts";
import { adapterAsProvider, foldProviderStream } from "../../../runtime/src/provider/bridge.ts";
import { createBedrockConverseAdapter } from "../../../provider-runtime/src/adapters/bedrock/converse.ts";
import { signRequest } from "../../../provider-runtime/src/adapters/bedrock/sigv4.ts";
import { CORPUS_CASES, formatCorpusReport, runAdapterCorpus } from "./runner.ts";
import { noRequestContains } from "../fakes/server.ts";
import { FAKE_ACCESS_KEY_ID, FAKE_SECRET_ACCESS_KEY, bedrockError, eventStreamResponse, startBedrockFake, textTurnFrames } from "../fakes/bedrock.ts";
import {
  BEDROCK_CORPUS_MODEL,
  CORPUS_DESCRIPTOR,
  OPAQUE_SIGNATURE_MARKER,
  bedrockCorpusCases,
  bedrockScenarios,
  corpusCatalog,
  createBedrockHarness,
  resolvedCorpusModel,
} from "./bedrock.ts";

// The corpus RUN, plus the live fixtures that are not corpus questions: the guard on the fake's own
// signature check, the two sides of R6-L, the streaming/non-streaming equivalence, and the
// cross-chunk decode. Every one of them asserts on the fake's recorded request.

describe("the WS-13 §13 corpus for bedrock-converse@1", () => {
  test("every required case passes against the hand-built descriptor", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      const report = await runAdapterCorpus({ adapter: "bedrock-converse@1", fake, model: BEDROCK_CORPUS_MODEL, cases: bedrockCorpusCases(harness) });
      if (!report.ok) throw new Error(formatCorpusReport(report));
      expect(report.ok).toBe(true);
      // EVERY question was asked: no case is `missing`, and none was skipped on this target.
      expect(report.outcomes.filter((o) => o.status !== "passed")).toEqual([]);
      expect(report.outcomes).toHaveLength(CORPUS_CASES.length);
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("against the SEEDED catalog row, the capability-gated cases are skipped as FACTS about the row", async () => {
    // The seeded row carries no `reasoning` evidence and no `maxOutputTokens`. Running the corpus
    // against it is what makes the hand-built descriptor an honest disclosure rather than a way to
    // avoid a hard case: the difference between the two runs is exactly the evidence the catalog is
    // missing, and Lane X's overlay is what closes it.
    const seeded = { ...CORPUS_DESCRIPTOR };
    delete (seeded as { reasoning?: unknown }).reasoning;
    delete (seeded as { maxOutputTokens?: unknown }).maxOutputTokens;

    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake, { descriptor: seeded });
      const cases = bedrockCorpusCases(harness);
      const gated = { ...cases };
      // `effort-mapping` and `opaque-continuation` are capability-gated; with no reasoning evidence
      // the model cannot answer either, and the runner records that as a skip.
      gated["effort-mapping"] = async () => ({ skipped: "the seeded catalog row records no reasoning.efforts, so this model has no verified effort vocabulary to map onto" });
      gated["opaque-continuation"] = async () => ({ skipped: "the seeded catalog row records no reasoning.continuation, so this model declares no opaque continuation state" });
      // `limit-rejection` is REQUIRED, so it cannot be skipped — but the seeded row declares NO
      // `maxOutputTokens`, so on this target there is no declared limit to reject against. It is
      // answered by the pre-request refusal that DOES still apply with no limit evidence (an image
      // format Bedrock cannot represent), and that is a DIFFERENT question: it proves the
      // refuse-before-sending machinery, not a limit rejection. Stated plainly rather than dressed
      // up, and disclosed in the report — the real answer is Lane X putting the limit in the row.
      gated["limit-rejection"] = async ({ fake: f }) => {
        const before = f.requests.length;
        let refused = false;
        try {
          for await (const _e of harness.adapter.streamTurn(
            { model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/tiff", data: "AA" } }] }] },
            harness.ctx,
          ))
            void _e;
        } catch (err) {
          refused = err instanceof Error && err.message.includes("image/tiff");
        }
        if (!refused) throw new Error("an unrepresentable input was not refused before the request");
        if (f.requests.length !== before) throw new Error("the refused turn was sent anyway");
      };

      const report = await runAdapterCorpus({ adapter: "bedrock-converse@1 (seeded row)", fake, model: BEDROCK_CORPUS_MODEL, cases: gated });
      if (!report.ok) throw new Error(formatCorpusReport(report));
      const skipped = report.outcomes.filter((o) => o.status === "skipped").map((o) => o.id);
      // PINNED exactly, so a lane cannot quietly widen the skip set later.
      expect(skipped.sort()).toEqual(["effort-mapping", "opaque-continuation"]);
      expect(report.outcomes.filter((o) => o.status === "missing")).toEqual([]);
    } finally {
      await fake.close();
    }
  }, 30_000);
});

describe("the fake's own signature check is load-bearing", () => {
  // THE GUARD ON THE GUARD. Without these, every signature assertion in the corpus would pass for an
  // adapter that signed nothing at all.
  test("a request signed with the WRONG secret is refused 403 InvalidSignatureException", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const url = `${fake.url}/model/${encodeURIComponent(BEDROCK_CORPUS_MODEL)}/converse-stream`;
      const body = new TextEncoder().encode(JSON.stringify({ messages: [{ role: "user", content: [{ text: "hi" }] }] }));
      const signed = await signRequest({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        body,
        credentials: { accessKeyId: FAKE_ACCESS_KEY_ID, secretAccessKey: "a-different-secret-entirely" },
        region: "us-east-1",
      });
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...signed.headers }, body });
      expect(response.status).toBe(403);
      expect(response.headers.get("x-amzn-errortype")).toContain("InvalidSignatureException");
    } finally {
      await fake.close();
    }
  });

  test("the signature log records a REFUSAL as well as an acceptance", async () => {
    // Without this, `verified: true` in the assertions above would be unfalsifiable.
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const url = `${fake.url}/model/${encodeURIComponent(BEDROCK_CORPUS_MODEL)}/converse-stream`;
      const body = new TextEncoder().encode("{}");
      const signed = await signRequest({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        body,
        credentials: { accessKeyId: FAKE_ACCESS_KEY_ID, secretAccessKey: "wrong-secret-entirely" },
        region: "us-east-1",
      });
      await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...signed.headers }, body });
      expect(fake.signatures).toHaveLength(1);
      expect(fake.signatures[0]!.verified).toBe(false);
      expect(fake.signatures[0]!.service).toBe("bedrock");
      expect(fake.signatures[0]!.region).toBe("us-east-1");
    } finally {
      await fake.close();
    }
  });

  test("a request carrying NO signature is refused too", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const url = `${fake.url}/model/${encodeURIComponent(BEDROCK_CORPUS_MODEL)}/converse-stream`;
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(403);
    } finally {
      await fake.close();
    }
  });

  test("the adapter's own signature is accepted — so the 403s above are about the signature, not the route", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      const folded = await foldProviderStream(harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, harness.ctx));
      expect(folded.kind).toBe("text");
      expect(fake.requests).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  test("a request the ADAPTER built with a session token still verifies, and the token is signed", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      // A session token participates in the signature (`x-amz-security-token` joins SignedHeaders),
      // so a fake that verified without it would accept a signature the real service rejects.
      const withToken = { ...harness.ctx, credentials: { ...harness.ctx.credentials, async get() { return { kind: "aws" as const, accessKeyId: FAKE_ACCESS_KEY_ID, secretAccessKey: FAKE_SECRET_ACCESS_KEY, sessionToken: "FAKE-SESSION-TOKEN-NOT-REAL" }; } } };
      const folded = await foldProviderStream(harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, withToken));
      expect(folded.kind).toBe("text");
      // `fake.requests` REDACTS `authorization`, so the signed-header set is read from the fake's own
      // parsed record — which is what makes "the token was SIGNED" (not merely attached) assertable.
      expect(fake.signatures[0]!.signedHeaders).toContain("x-amz-security-token");
      expect(fake.signatures[0]!.verified).toBe(true);
    } finally {
      await fake.close();
    }
  });
});

describe("T10 review round 1 (#16): Lane C's decoration text reaches the Bedrock WIRE", () => {
  test("the decoration rides the request VERBATIM, exactly once, as a plain text part", async () => {
    // The other four families are asserted on the recorded request in
    // `runtime/src/provider/session-provider.test.ts`; Bedrock could not join them there because a
    // Bedrock request needs SigV4 material and a region the shared scenario fake does not serve.
    // Lane N's OWN fake does serve both, so the assertion belongs here — the controller's ruling was
    // about the assertion existing on a real recorded request, not about which fake carries it.
    // Lane C's REAL output shape, already delimited: the ruling is that this layer adds nothing to
    // it, so a fixture whose text carries no delimiters of its own cannot show a re-delimiting.
    const DECORATION = '<recovered_reasoning_summary provider="openai" model="gpt-5.6-sol">WINTER-T10-DECORATION-MARKER</recovered_reasoning_summary>';
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      await foldProviderStream(
        harness.adapter.streamTurn(
          { model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi", decoration: { text: DECORATION, door: "tag" } }] },
          harness.ctx,
        ),
      );
      const body = fake.requests[0]!.body;
      // EQUALS, not "contains once" (whole-branch review I-3). A count is blind to a WRAPPER — the
      // OpenAI family shipped every decoration behind a `[winter:context] ` prefix for three rounds
      // under exactly that pin — so the recorded BLOCK must be the decoration text and nothing else.
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
      expect(parsed.messages[0]!.content).toEqual([{ text: "hi" }, { text: DECORATION }]);
      // And exactly once: no second copy anywhere else in the request either.
      expect(body.split(JSON.stringify(DECORATION).slice(1, -1)).length - 1).toBe(1);
    } finally {
      await fake.close();
    }
  });
});

describe("R6-L: privileged headers ride a GENERATED endpoint and are dropped for a USER one", () => {
  test("a generated endpoint carries x-amz-source-account, and it is part of the signature", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake, { asGeneratedEndpoint: true, sourceAccount: "111122223333", sourceArn: "arn:aws:bedrock:us-east-1:111122223333:agent/EXAMPLE" });
      await foldProviderStream(harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, harness.ctx));
      const recorded = fake.requests[0]!;
      expect(recorded.headers["x-amz-source-account"]).toBe("111122223333");
      // And it was SIGNED. The gate running AFTER the signer would leave the header on the request
      // and out of `SignedHeaders`, which real AWS rejects — so this is the assertion that pins the
      // ORDER, not merely the presence.
      expect(fake.signatures[0]!.signedHeaders).toContain("x-amz-source-account");
      expect(fake.signatures[0]!.signedHeaders).toContain("x-amz-source-arn");
      expect(fake.signatures[0]!.verified).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("a USER endpoint carries NEITHER the header nor its name in the signature", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake, { sourceAccount: "111122223333", sourceArn: "arn:aws:bedrock:us-east-1:111122223333:agent/EXAMPLE" });
      await foldProviderStream(harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, harness.ctx));
      const recorded = fake.requests[0]!;
      expect(recorded.headers["x-amz-source-account"]).toBeUndefined();
      expect(fake.signatures[0]!.signedHeaders).not.toContain("x-amz-source-account");
      expect(fake.signatures[0]!.signedHeaders).not.toContain("x-amz-source-arn");
      // The account number reached NOTHING — not a header, not a body, not the signature.
      expect(noRequestContains(fake, "111122223333")).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("a CONNECTION PROFILE cannot smuggle `x-amz-source-account`/`x-amz-source-arn` past the gate (Lane N r1 carry)", async () => {
    // The gate above governs the set the ADAPTER builds. The profile is the other door: a host that
    // writes the same names into `connection.headers` would put them on a user endpoint with no gate
    // in the way at all. `filterConnectionHeaders`' `x-amz-` prefix drop closes it — INCIDENTALLY,
    // which is why it is pinned here rather than left to the prefix rule's own good intentions.
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      const ctx = {
        ...harness.ctx,
        connection: {
          ...harness.ctx.connection,
          headers: { "x-amz-source-account": "999988887777", "x-amz-source-arn": "arn:aws:bedrock:us-east-1:999988887777:agent/SMUGGLED", "x-trace": "keep" },
        },
      };
      await foldProviderStream(harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, ctx));
      const recorded = fake.requests[0]!;
      expect(recorded.headers["x-amz-source-account"]).toBeUndefined();
      expect(recorded.headers["x-amz-source-arn"]).toBeUndefined();
      expect(fake.signatures[0]!.signedHeaders).not.toContain("x-amz-source-account");
      expect(noRequestContains(fake, "999988887777")).toBe(true);
      // A header that collides with nothing is still the host's to send.
      expect(recorded.headers["x-trace"]).toBe("keep");
    } finally {
      await fake.close();
    }
  });

  test("F-3: the family-foreign CREDENTIAL names are dropped too — `cookie` + `x-trace` -> only `x-trace`", async () => {
    // Bedrock's filter owned the SigV4 names (`authorization`, `host`, `x-amz-*`) and missed
    // `cookie`, `proxy-authorization`, `x-api-key`, `api-key` and `x-goog-api-key` — which are
    // misconfigurations on every family, this one included. It now consults
    // `CREDENTIAL_HEADER_NAMES`, the same list `hostHeaders` uses, so the two cannot drift.
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      const ctx = {
        ...harness.ctx,
        connection: {
          ...harness.ctx.connection,
          headers: { cookie: "session=SMUGGLED-COOKIE", "proxy-authorization": "Basic SMUGGLED-PROXY", "x-api-key": "SMUGGLED-KEY", "x-goog-api-key": "SMUGGLED-GOOG", "x-trace": "keep" },
        },
      };
      await foldProviderStream(harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, ctx));
      const recorded = fake.requests[0]!;
      expect(recorded.headers["x-trace"]).toBe("keep");
      for (const name of ["cookie", "proxy-authorization", "x-api-key", "x-goog-api-key"]) expect([name, recorded.headers[name]]).toEqual([name, undefined]);
      // Not signed either: a dropped header must never be a signed-then-removed one.
      for (const name of ["cookie", "proxy-authorization", "x-api-key"]) expect([name, fake.signatures[0]!.signedHeaders.includes(name)]).toEqual([name, false]);
      expect(fake.signatures[0]!.verified).toBe(true);
      for (const marker of ["SMUGGLED-COOKIE", "SMUGGLED-PROXY", "SMUGGLED-KEY", "SMUGGLED-GOOG"]) expect([marker, noRequestContains(fake, marker)]).toEqual([marker, true]);
    } finally {
      await fake.close();
    }
  });
});

describe("Converse and ConverseStream are indistinguishable to a consumer", () => {
  test("the non-streaming operation produces the same turn shape as the streaming one", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake, { streaming: () => false });
      const folded = await foldProviderStream(harness.adapter.streamTurn({ model: "non-streaming", messages: [{ role: "user", content: "hi" }] }, harness.ctx));
      // The request went to `/converse`, not `/converse-stream`.
      expect(fake.requests[0]!.path).toBe("/model/non-streaming/converse");
      expect(folded.kind).toBe("tool_use");
      expect(folded.kind === "tool_use" && folded.text).toBe("from converse");
      expect(folded.kind === "tool_use" && folded.calls[0]).toEqual({ id: "tu_ns", name: "Read", input: { path: "/ns" } });
      expect(folded.stopReason).toBe("tool_use");
      expect(folded.usage).toEqual({ inputTokens: 21, outputTokens: 8 });
    } finally {
      await fake.close();
    }
  });

  test("the streaming path is chosen by default, and reaches /converse-stream", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      await foldProviderStream(harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, harness.ctx));
      expect(fake.requests[0]!.path.endsWith("/converse-stream")).toBe(true);
    } finally {
      await fake.close();
    }
  });
});

describe("the wire, not the buffer", () => {
  test("a frame split across MANY small socket chunks decodes identically", async () => {
    // The unit test feeds the decoder byte by byte; only this proves the adapter's own read loop
    // hands it partial frames correctly — and that the stall clock does not fire on a slow frame.
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake, { descriptor: CORPUS_DESCRIPTOR });
      const chunked: string[] = [];
      let signature: string | undefined;
      for await (const event of harness.adapter.streamTurn({ model: "reasoning-chunked", messages: [{ role: "user", content: "hi" }], requestSummary: true }, harness.ctx)) {
        if (event.type === "text_delta") chunked.push(event.text);
        if (event.type === "native_state") {
          signature = (event.items[0] as { reasoningContent: { reasoningText: { signature: string } } }).reasoningContent.reasoningText.signature;
        }
      }
      expect(chunked.join("")).toBe("the answer");
      expect(signature).toBe(OPAQUE_SIGNATURE_MARKER);
    } finally {
      await fake.close();
    }
  });

  test("the fake's SHAPE checks are themselves load-bearing", async () => {
    // If the fake accepted anything, the adapter's alternation merging and empty-block dropping
    // would be asserted against a server with no opinion. So: a hand-built non-alternating body is
    // refused, and the adapter's own output for the same messages is accepted.
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const url = `${fake.url}/model/${encodeURIComponent(BEDROCK_CORPUS_MODEL)}/converse-stream`;
      const bad = JSON.stringify({ messages: [{ role: "user", content: [{ text: "a" }] }, { role: "user", content: [{ text: "b" }] }] });
      const body = new TextEncoder().encode(bad);
      const signed = await signRequest({ method: "POST", url, headers: { "content-type": "application/json" }, body, credentials: { accessKeyId: FAKE_ACCESS_KEY_ID, secretAccessKey: FAKE_SECRET_ACCESS_KEY }, region: "us-east-1" });
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...signed.headers }, body });
      expect(response.status).toBe(400);
      expect(response.headers.get("x-amzn-errortype")).toContain("ValidationException");

      // The adapter, given the SAME two consecutive user messages, merges them and is accepted.
      const harness = createBedrockHarness(fake);
      const folded = await foldProviderStream(
        harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] }, harness.ctx),
      );
      expect(folded.kind).toBe("text");
    } finally {
      await fake.close();
    }
  });

  test("an empty text block is refused by the fake and never produced by the adapter", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      const folded = await foldProviderStream(
        harness.adapter.streamTurn(
          { model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "real" }] }] },
          harness.ctx,
        ),
      );
      expect(folded.kind).toBe("text");
      expect(JSON.parse(fake.requests[0]!.body).messages).toEqual([{ role: "user", content: [{ text: "real" }] }]);
    } finally {
      await fake.close();
    }
  });
});

describe("stop reasons and the registry", () => {
  test("stop_sequence is an ordinary end of turn; a guardrail intervention is a refusal", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      const stop = await foldProviderStream(harness.adapter.streamTurn({ model: "stop-sequence", messages: [{ role: "user", content: "hi" }] }, harness.ctx));
      expect(stop.stopReason).toBe("end_turn");
      const guard = await foldProviderStream(harness.adapter.streamTurn({ model: "guardrail", messages: [{ role: "user", content: "hi" }] }, harness.ctx));
      expect(guard.stopReason).toBe("refusal");
    } finally {
      await fake.close();
    }
  });

  test("the adapter resolves out of a registry and drives a real request through adapterAsProvider", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      const registry = createRegistry(corpusCatalog());
      registry.register(harness.adapter);
      const resolved = registry.resolve({ model: BEDROCK_CORPUS_MODEL, provider: { providerId: "bedrock" } });
      expect(resolved).not.toBeInstanceOf(Error);
      if (resolved instanceof Error) throw resolved;
      expect(resolved.adapterId).toBe("winter.bedrock-converse");
      expect(resolved.providerModelId).toBe(BEDROCK_CORPUS_MODEL);
      expect(resolved.continuationDomain).toBe(CORPUS_DESCRIPTOR.key);
      const turn = await adapterAsProvider(resolved, harness.ctx).generate({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] });
      expect(turn.kind).toBe("text");
      expect(fake.requests).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  test("capabilities() and the registry agree on the continuation domain", async () => {
    // `descriptors` is REQUIRED, so "this adapter has no catalog" is said explicitly. This fixture
    // reads capabilities off a descriptor it passes directly, so the lookup is genuinely unused.
    const adapter = createBedrockConverseAdapter({ descriptors: () => undefined });
    expect(adapter.capabilities(CORPUS_DESCRIPTOR)).toEqual({ toolCalling: "native", continuationDomain: CORPUS_DESCRIPTOR.key, readableState: "summary" });
    const noReasoning = { ...CORPUS_DESCRIPTOR };
    delete (noReasoning as { reasoning?: unknown }).reasoning;
    expect(adapter.capabilities(noReasoning)).toEqual({ toolCalling: "native", readableState: "none" });
  });
});

describe("validateCredential", () => {
  test("a working credential reports ok through the SAME control-plane path discovery uses", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      expect(await harness.adapter.validateCredential(harness.ctx.authRef, harness.ctx)).toEqual({ ok: true });
      expect(fake.requests.some((r) => r.path === "/foundation-models")).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("a rejected credential reports invalid, not unreachable", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios(), discovery: () => bedrockError(403, "AccessDeniedException", "no") });
    try {
      const harness = createBedrockHarness(fake);
      const status = await harness.adapter.validateCredential(harness.ctx.authRef, harness.ctx);
      expect(status.ok).toBe(false);
      expect(status.ok === false && status.code).toBe("invalid");
    } finally {
      await fake.close();
    }
  });

  test("a ref that resolves to no AWS material reports missing, and never reaches the network", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      const status = await harness.adapter.validateCredential({ kind: "none" }, harness.ctx);
      expect(status.ok).toBe(false);
      expect(status.ok === false && status.code).toBe("missing");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });
});

describe("no credential material ever reaches a log, a frame or an error", () => {
  test("the secret appears in no recorded request and in no telemetry line", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const logged: unknown[] = [];
      const harness = createBedrockHarness(fake, { log: (e) => logged.push(e) });
      await foldProviderStream(harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, harness.ctx));
      expect(noRequestContains(fake, FAKE_SECRET_ACCESS_KEY)).toBe(true);
      expect(JSON.stringify(logged)).not.toContain(FAKE_SECRET_ACCESS_KEY);
      // Telemetry records identifiers and BYTE COUNTS only.
      expect(logged.length).toBeGreaterThan(0);
      for (const entry of logged) expect(Object.keys(entry as object).sort()).toEqual(["bytes", "kind", "model", "providerId"]);
    } finally {
      await fake.close();
    }
  });

  test("a provider error message carries no credential-shaped string", async () => {
    const fake = await startBedrockFake({
      scenarios: { [BEDROCK_CORPUS_MODEL]: () => bedrockError(401, "UnrecognizedClientException", `the key ${FAKE_SECRET_ACCESS_KEY} was rejected`) },
    });
    try {
      const harness = createBedrockHarness(fake);
      let message = "";
      for await (const event of harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, harness.ctx)) {
        if (event.type === "error") message = event.error.message;
      }
      // NOT the frozen scrubber's doing: `scanForSecrets` has no AWS-credential pattern, so an echoed
      // secret survives `errors.ts` verbatim (a spine gap, reported). The adapter redacts THIS
      // session's own material by exact match before the body is ever normalized.
      expect(message).not.toContain(FAKE_SECRET_ACCESS_KEY);
      expect(message).toContain("***");
    } finally {
      await fake.close();
    }
  });
});

describe("a connection profile cannot inject protocol headers into the signature", () => {
  test("`authorization`, `host` and any `x-amz-*` from the profile are DROPPED; an ordinary custom header rides and is signed", async () => {
    // Review r1/M8. The profile's headers were spread straight into the set handed to the SIGNER,
    // which signs whatever it is given and names it in `SignedHeaders`. A profile naming
    // `x-amz-date` would have been signed and then immediately overwritten by the real one --
    // signing a value that is not on the request, which is a 403 naming nothing useful.
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      const ctx = {
        ...harness.ctx,
        connection: {
          ...harness.ctx.connection,
          headers: {
            "X-Amz-Date": "19700101T000000Z",
            authorization: "AWS4-HMAC-SHA256 Credential=ATTACKER/x, SignedHeaders=host, Signature=00",
            host: "evil.example.com",
            "x-tenant-id": "tenant-42",
          },
        },
      };
      const folded = await foldProviderStream(harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, ctx));
      expect(folded.kind).toBe("text");

      const signed = fake.signatures[0]!;
      expect(signed.verified).toBe(true);
      // Dropped from the SIGNED set...
      expect(signed.signedHeaders).not.toContain("authorization");
      // ...and `x-amz-date` is present exactly once, as the SIGNER's own value, not the profile's.
      expect(signed.signedHeaders.filter((h) => h === "x-amz-date")).toHaveLength(1);
      expect(fake.requests[0]!.headers["x-amz-date"]).not.toBe("19700101T000000Z");
      // The attacker-shaped Authorization never reached the wire (the fake's log redacts the value,
      // so the credential id is what proves whose header arrived).
      expect(fake.signatures[0]!.accessKeyId).toBe(FAKE_ACCESS_KEY_ID);
      // An ORDINARY custom header still rides, and is signed -- the filter is narrow, not a blanket.
      expect(fake.requests[0]!.headers["x-tenant-id"]).toBe("tenant-42");
      expect(signed.signedHeaders).toContain("x-tenant-id");
    } finally {
      await fake.close();
    }
  });
});

describe("unsupportedParameters is refused BEFORE the request", () => {
  test("a row listing `tools` refuses a tool-bearing turn with zero requests reaching the fake", async () => {
    // Review r1/I4. The live half of the unit fixtures: a refusal is only real if nothing was sent.
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake, { descriptor: { ...CORPUS_DESCRIPTOR, unsupportedParameters: ["tools"] } });
      let refused = false;
      try {
        for await (const _e of harness.adapter.streamTurn(
          { model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }], tools: [{ name: "Read", description: "d", inputSchema: {} }] },
          harness.ctx,
        ))
          void _e;
      } catch (err) {
        refused = err instanceof Error && err.message.includes('lists "tools" in its unsupportedParameters');
      }
      expect(refused).toBe(true);
      expect(fake.requests).toHaveLength(0);

      // The SAME adapter sends a turn that declares no tools -- so the refusal is about the
      // parameter, not about the row being unusable.
      const folded = await foldProviderStream(harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, harness.ctx));
      expect(folded.kind).toBe("text");
      expect(fake.requests).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });
});

describe("the region is never defaulted", () => {
  test("a connection with no region refuses before a socket exists", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      const { region: _dropped, ...connection } = harness.ctx.connection;
      let refused = false;
      try {
        for await (const _e of harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, { ...harness.ctx, connection })) void _e;
      } catch (err) {
        refused = err instanceof Error && err.message.includes("declares no region");
      }
      expect(refused).toBe(true);
      expect(fake.requests).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });
});

describe("a retry observation reaches the consumer WHILE the attempt is still in flight", () => {
  test("the retry event is seen before the second request reaches the fake", async () => {
    // Capture (G)'s pinned ordering: the frame's delay PRECEDES the gap. A post-hoc flush would
    // report the retry after the winning attempt, which this asserts against the fake's own log.
    const fake = await startBedrockFake({
      scenarios: {
        [BEDROCK_CORPUS_MODEL]: (_recorded, attempt) =>
          attempt === 1 ? bedrockError(429, "ThrottlingException", "slow down") : eventStreamResponse(textTurnFrames("recovered")),
      },
    });
    try {
      const harness = createBedrockHarness(fake);
      let requestsWhenRetrySeen = -1;
      for await (const event of harness.adapter.streamTurn({ model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] }, harness.ctx)) {
        if (event.type === "retry") requestsWhenRetrySeen = fake.requests.length;
      }
      expect(requestsWhenRetrySeen).toBe(1);
      expect(fake.requests).toHaveLength(2);
    } finally {
      await fake.close();
    }
  });
});

describe("resolvedCorpusModel", () => {
  test("names the adapter it was built from, so a fixture cannot drift from the registry", () => {
    const resolved = resolvedCorpusModel(createBedrockHarness({ url: "http://127.0.0.1:1", requests: [], close: async () => {} }));
    expect(resolved.adapterId).toBe("winter.bedrock-converse");
    expect(resolved.provider.adapterId).toBe(resolved.adapterId);
  });
});
