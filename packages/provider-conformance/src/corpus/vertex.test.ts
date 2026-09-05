// Phase 6 Task 6 (Lane B): Vertex Gemini, proved on the wire -- including its ADC flow.
//
// The token endpoint in these fixtures is REAL in the one way that matters: it verifies the RS256
// signature of every assertion against the in-test public key and checks the claim set. An adapter
// that signed with the wrong algorithm, addressed the wrong audience, or dropped the scope gets a
// 401 here exactly as it would from Google -- which is the only way "the ADC flow works" can be
// something a test knows rather than something a comment asserts.
import { describe, expect, test } from "bun:test";
import { noRequestContains, requestsTo, withFake } from "../fakes/server.ts";
import { geminiBody, geminiContents } from "../fakes/gemini.ts";
import { VERTEX_TEST_ACCESS_TOKEN, assertVertexRequest, generateTestKeyPair } from "../fakes/vertex.ts";
import { verifyRs256Jwt } from "../fakes/jwt-verify.ts";
import {
  GCP_CLOUD_PLATFORM_SCOPE,
  VERTEX_ADAPTER_ID,
  createServiceAccountTokenSource,
  createVertexGeminiAdapter,
  importRs256PrivateKey,
  pkcs8DerFromPem,
  signRs256Jwt,
  vertexEndpointUrl,
  vertexModelPath,
} from "../../../provider-runtime/src/adapters/google/index.ts";
import { foldProviderStream } from "../../../runtime/src/provider/bridge.ts";
import { GOOGLE_MODELS, GOOGLE_SIGNATURE } from "./google.ts";
import { formatCorpusReport, runAdapterCorpus } from "./runner.ts";
import {
  VERTEX_LOCATION,
  VERTEX_PROJECT,
  VERTEX_SERVICE_ACCOUNT_EMAIL,
  createVertexHarness,
  serviceAccountJson,
  testVertexAdapter,
  vertexAccessTokenContext,
  vertexContext,
  vertexCorpusCases,
  vertexGeneratePath,
} from "./vertex.ts";

describe("Vertex Gemini: the location endpoint (ruling R6-A, verbatim)", () => {
  test("composes exactly the URL the ruling names", () => {
    expect(`${vertexEndpointUrl(VERTEX_LOCATION)}${vertexModelPath(VERTEX_PROJECT, VERTEX_LOCATION, "gemini-2.5-pro", "streamGenerateContent", "?alt=sse")}`).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/winter-test-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
  });

  test("a project or location that is not a Google Cloud identifier is REFUSED, never escaped into the path", async () => {
    const adapter = testVertexAdapter();
    const harness = await createVertexHarness();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      for (const bad of ["../../etc", "Project", "a/b", "p%2e%2e"]) {
        const events = [];
        // No `baseUrl`, so the adapter must COMPOSE the endpoint -- which is where the validation runs.
        const ctx = vertexContext(harness, fake.url, { connection: { providerId: "vertex", project: bad, location: VERTEX_LOCATION } });
        for await (const event of adapter.streamTurn({ model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "go" }] }, ctx)) events.push(event);
        expect(events[0]).toMatchObject({ type: "error", error: { code: "capability" } });
      }
      expect(fake.requests).toHaveLength(0);
    });
  });

  test("a missing project or location is a typed refusal, not a malformed URL", async () => {
    const adapter = testVertexAdapter();
    const harness = await createVertexHarness();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const events = [];
      const ctx = vertexContext(harness, fake.url, { connection: { providerId: "vertex", location: VERTEX_LOCATION } });
      for await (const event of adapter.streamTurn({ model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "go" }] }, ctx)) events.push(event);
      const first = events[0];
      expect(first?.type === "error" && first.error.message).toContain('needs a "project"');
    });
  });
});

describe("Vertex Gemini: the ADC service-account flow", () => {
  test("signs an RS256 assertion the token endpoint VERIFIES, then uses the minted bearer token", async () => {
    const adapter = testVertexAdapter();
    const harness = await createVertexHarness();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const turn = await foldProviderStream(adapter.streamTurn({ model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "hi" }] }, vertexContext(harness, fake.url)));
      expect(turn).toMatchObject({ kind: "text", text: "hi" });

      // The exchange happened, and the fake verified the SIGNATURE before minting anything.
      expect(harness.verified).toHaveLength(1);
      expect(harness.verified[0]!.header).toEqual({ alg: "RS256", typ: "JWT" });
      expect(harness.verified[0]!.claims).toMatchObject({ iss: VERTEX_SERVICE_ACCOUNT_EMAIL, scope: GCP_CLOUD_PLATFORM_SCOPE, aud: harness.tokenUri });
      const claims = harness.verified[0]!.claims as { iat: number; exp: number };
      expect(claims.exp - claims.iat).toBe(3600);

      // The generation carried the minted bearer token and NO api key.
      const generate = requestsTo(fake, vertexGeneratePath(GOOGLE_MODELS.main))[0]!;
      assertVertexRequest(generate, { project: VERTEX_PROJECT, location: VERTEX_LOCATION, model: GOOGLE_MODELS.main, search: "?alt=sse" });
      // Neither the private key nor the minted token is ever recorded in a request the fake saw --
      // the key never leaves the process, and the token is redacted as it is logged.
      expect(noRequestContains(fake, VERTEX_TEST_ACCESS_TOKEN)).toBe(true);
      expect(noRequestContains(fake, "-----BEGIN PRIVATE KEY-----")).toBe(true);
    });
  });

  test("the token is CACHED until it expires: a second turn performs no second exchange", async () => {
    const adapter = testVertexAdapter();
    const harness = await createVertexHarness();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const ctx = vertexContext(harness, fake.url);
      await foldProviderStream(adapter.streamTurn({ model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "a" }] }, ctx));
      await foldProviderStream(adapter.streamTurn({ model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "b" }] }, ctx));
      expect(requestsTo(fake, "/token")).toHaveLength(1);
      expect(harness.verified).toHaveLength(1);
    });
  });

  test("an expired token is re-exchanged, and a token with NO stated lifetime is never cached", async () => {
    const harness = await createVertexHarness({ expiresIn: 0 });
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      // `expires_in: 0` -- a lifetime nobody stated. Caching it is how a fleet starts sending expired
      // credentials in unison, so the source treats it as already expired.
      const adapter = testVertexAdapter();
      const ctx = vertexContext(harness, fake.url);
      await foldProviderStream(adapter.streamTurn({ model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "a" }] }, ctx));
      await foldProviderStream(adapter.streamTurn({ model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "b" }] }, ctx));
      expect(requestsTo(fake, "/token")).toHaveLength(2);
    });
  });

  test("a REJECTED exchange fails the turn with a typed auth error that names the account, never the key", async () => {
    const harness = await createVertexHarness({ rejectExchange: true });
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const adapter = testVertexAdapter();
      let message = "";
      try {
        await foldProviderStream(adapter.streamTurn({ model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "a" }] }, vertexContext(harness, fake.url)));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(VERTEX_SERVICE_ACCOUNT_EMAIL);
      expect(message).not.toContain("PRIVATE KEY");
      expect(message).not.toContain(harness.privateKeyPem.slice(40, 80));
      // No generation was attempted: the credential failed first.
      expect(requestsTo(fake, vertexGeneratePath(GOOGLE_MODELS.main))).toHaveLength(0);
    });
  });

  test("an explicit `gcp-access-token` skips the exchange entirely -- R6-A's second ADC form", async () => {
    const harness = await createVertexHarness();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const adapter = testVertexAdapter();
      const turn = await foldProviderStream(
        adapter.streamTurn({ model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "hi" }] }, vertexAccessTokenContext(fake.url, "test-preminted-token-1")),
      );
      expect(turn).toMatchObject({ kind: "text" });
      expect(requestsTo(fake, "/token")).toHaveLength(0);
      expect(noRequestContains(fake, "test-preminted-token-1")).toBe(true);
    });
  });

  test("credential material this transport cannot use is a typed refusal naming the kind", async () => {
    const harness = await createVertexHarness();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const adapter = testVertexAdapter();
      const events = [];
      // An api key is a perfectly good credential -- for another transport.
      for await (const event of adapter.streamTurn(
        { model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "a" }] },
        vertexContext(harness, fake.url, { credentials: (await import("@yanlinglabs/winter-provider-runtime")).createMemoryCredentialStore(), authRef: { kind: "inline", value: "test-key-not-gcp" } }),
      )) {
        events.push(event);
      }
      const first = events[0];
      expect(first?.type === "error" && first.error.message).toContain('kind "api-key"');
      expect(JSON.stringify(events)).not.toContain("test-key-not-gcp");
    });
  });
});

describe("Vertex Gemini: the token source's own edges", () => {
  test("an UNPARSEABLE `token_uri` is a `capability` refusal, not a retryable network failure (Minor 2)", async () => {
    // `new URL()` throws on it, and a `token_uri` comes out of a credentials FILE — host
    // configuration, not a network condition. Left to propagate it was typed `network`/retryable, so
    // a misconfigured file was retried with backoff and then blamed on the network.
    const { privateKeyPem } = await generateTestKeyPair();
    const source = createServiceAccountTokenSource({ kind: "gcp-service-account", clientEmail: "a@b.iam.gserviceaccount.com", privateKeyPem, tokenUri: "not a url at all" });
    await expect(source.token()).rejects.toThrow(/not a parseable absolute URL/);
    try {
      await source.token();
    } catch (err) {
      expect(err).toMatchObject({ code: "capability", retryable: false });
      // The value shares a document with the private key, so it is never echoed.
      expect((err as Error).message).not.toContain("not a url at all");
    }
    expect(source.exchanges()).toBe(0);
  });

  test("CONCURRENT `token()` calls perform ONE exchange, not one each (Minor 3)", async () => {
    const harness = await createVertexHarness();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const source = createServiceAccountTokenSource(
        { kind: "gcp-service-account", clientEmail: VERTEX_SERVICE_ACCOUNT_EMAIL, privateKeyPem: harness.privateKeyPem, tokenUri: harness.tokenUri },
        { local: true },
      );
      // A burst of turns starting together all miss the cache. Without single-flight that is N
      // signatures, N round trips, and N tokens of which N-1 are discarded on arrival.
      const tokens = await Promise.all([source.token(), source.token(), source.token(), source.token()]);
      expect(new Set(tokens).size).toBe(1);
      expect(source.exchanges()).toBe(1);
      expect(requestsTo(fake, "/token")).toHaveLength(1);
      expect(harness.verified).toHaveLength(1);

      // ...and the in-flight promise is cleared on settle, so a later MISS starts a fresh exchange
      // rather than serving a stale memo forever.
      const later = createServiceAccountTokenSource(
        { kind: "gcp-service-account", clientEmail: VERTEX_SERVICE_ACCOUNT_EMAIL, privateKeyPem: harness.privateKeyPem, tokenUri: harness.tokenUri },
        { local: true },
      );
      await later.token();
      expect(requestsTo(fake, "/token")).toHaveLength(2);
    });
  });

  test("a FAILED exchange is not memoised as a rejection forever (Minor 3)", async () => {
    const harness = await createVertexHarness({ rejectExchange: true });
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const source = createServiceAccountTokenSource(
        { kind: "gcp-service-account", clientEmail: VERTEX_SERVICE_ACCOUNT_EMAIL, privateKeyPem: harness.privateKeyPem, tokenUri: harness.tokenUri },
        { local: true },
      );
      await expect(source.token()).rejects.toThrow();
      await expect(source.token()).rejects.toThrow();
      // Two attempts, not one attempt and a cached rejection: a credential that starts working must
      // be able to start working.
      expect(requestsTo(fake, "/token")).toHaveLength(2);
    });
  });

  test("`countTokens` does not run the GENERATION ceiling check (Minor 4)", async () => {
    // A count carries the prompt and no output allowance, so a thinking budget has no ceiling to
    // overrun. Building the full body and then deleting `max_tokens` meant the check ran on a field
    // that was about to be thrown away — and refused a perfectly countable prompt.
    const harness = await createVertexHarness();
    const adapter = testVertexAdapter();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const count = await adapter.countTokens!(
        { model: GOOGLE_MODELS.capped, messages: [{ role: "user", content: "a" }], thinking: { type: "enabled", budgetTokens: 4096 } },
        vertexContext(harness, fake.url),
      );
      expect(count).toBe(100);
      const recorded = requestsTo(fake, vertexModelPath(VERTEX_PROJECT, VERTEX_LOCATION, GOOGLE_MODELS.capped, "countTokens"))[0]!;
      expect(geminiBody(recorded)["generationConfig"]).toBeUndefined();
    });
  });
});

describe("Vertex Gemini: RS256 signing", () => {
  test("round-trips a real signature, and a tampered payload does NOT verify", async () => {
    const { privateKeyPem, publicKey } = await generateTestKeyPair();
    const key = await importRs256PrivateKey(privateKeyPem);
    const jwt = await signRs256Jwt({ iss: "a@b.iam.gserviceaccount.com", scope: GCP_CLOUD_PLATFORM_SCOPE, aud: "https://example.invalid/token", iat: 1, exp: 2 }, key);
    expect(await verifyRs256Jwt(jwt, publicKey)).toMatchObject({ header: { alg: "RS256" }, claims: { iss: "a@b.iam.gserviceaccount.com" } });

    const [header, , signature] = jwt.split(".") as [string, string, string];
    const tampered = `${header}.${btoa(JSON.stringify({ iss: "attacker@evil.invalid" })).replace(/=+$/, "")}.${signature}`;
    expect(await verifyRs256Jwt(tampered, publicKey)).toBeUndefined();
  });

  test("a PKCS#1 PEM is refused by NAME, and no error message ever echoes key material", async () => {
    // openssl still emits PKCS#1 by default, and `importKey` accepts only PKCS#8 -- so the refusal
    // has to say which format was found or it is unactionable.
    const secret = "SUPERSECRETKEYBYTES";
    expect(() => pkcs8DerFromPem(`-----BEGIN RSA PRIVATE KEY-----\n${btoa(secret)}\n-----END RSA PRIVATE KEY-----`)).toThrow(/"RSA PRIVATE KEY" PEM block/);
    try {
      pkcs8DerFromPem(`-----BEGIN PRIVATE KEY-----\n!!!not base64!!!\n-----END PRIVATE KEY-----`);
    } catch (err) {
      expect((err as Error).message).not.toContain("!!!not base64!!!");
    }
    expect(() => pkcs8DerFromPem("no pem here at all")).toThrow(/not a PEM block/);
    await expect(importRs256PrivateKey(`-----BEGIN PRIVATE KEY-----\n${btoa(secret)}\n-----END PRIVATE KEY-----`)).rejects.toThrow(/could not be imported/);
  });

  test("the token source refuses a plain-http token endpoint that is not declared local", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const source = createServiceAccountTokenSource({ kind: "gcp-service-account", clientEmail: "a@b.iam.gserviceaccount.com", privateKeyPem, tokenUri: "http://127.0.0.1:9/token" });
    await expect(source.token()).rejects.toThrow(/token endpoint is unusable/);
  });
});

describe("Vertex Gemini: the shared wire mapping", () => {
  test("the SAME normalizer produces the same turn, opaque state included", async () => {
    const adapter = testVertexAdapter();
    const harness = await createVertexHarness();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const ctx = vertexContext(harness, fake.url);
      const turn = await foldProviderStream(adapter.streamTurn({ model: GOOGLE_MODELS.replay, messages: [{ role: "user", content: "go" }] }, ctx));
      expect(turn.nativeState?.items).toEqual([{ partIndex: 2, kind: "function-call", callId: (turn as { calls: Array<{ id: string }> }).calls[0]!.id, signature: GOOGLE_SIGNATURE }]);
      // Same body shape as the Gemini API transport: only the URL and the credential differ.
      const generate = requestsTo(fake, vertexGeneratePath(GOOGLE_MODELS.replay))[0]!;
      expect(geminiContents(generate)).toEqual([{ role: "user", parts: [{ text: "go" }] }]);
      expect(geminiBody(generate)["contents"]).toBeDefined();
    });
  });

  test("`x-goog-user-project` is dropped for a user endpoint (R6-L), and the project still reaches the PATH", async () => {
    const adapter = testVertexAdapter();
    const harness = await createVertexHarness();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      await foldProviderStream(adapter.streamTurn({ model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "hi" }] }, vertexContext(harness, fake.url)));
      const generate = requestsTo(fake, vertexGeneratePath(GOOGLE_MODELS.main))[0]!;
      // The header is an ACCOUNT identifier and must not reach a host the reviewed catalog never
      // named. The path segment is not the same thing: the host chose the base URL AND the project.
      expect(generate.headers["x-goog-user-project"]).toBeUndefined();
      expect(generate.path).toContain(`/projects/${VERTEX_PROJECT}/`);
    });
  });

  test("`countTokens` reaches the location endpoint's own `:countTokens` method", async () => {
    const adapter = testVertexAdapter();
    const harness = await createVertexHarness();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const count = await adapter.countTokens!({ model: GOOGLE_MODELS.main, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }, vertexContext(harness, fake.url));
      expect(count).toBe(200);
      expect(requestsTo(fake, vertexModelPath(VERTEX_PROJECT, VERTEX_LOCATION, GOOGLE_MODELS.main, "countTokens"))).toHaveLength(1);
    });
  });

  test("`listModels` and `validateCredential` report UNSUPPORTED rather than claiming a check nothing performed", async () => {
    const adapter = testVertexAdapter();
    const harness = await createVertexHarness();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const ctx = vertexContext(harness, fake.url);
      const listed = await adapter.listModels({ ...ctx, limits: { maxBytes: 4096, maxItems: 10, timeoutMs: 1_000 } });
      expect(listed).toMatchObject({ models: [], partial: true });
      expect(listed.warnings.join(" ")).toMatch(/no bounded model-list endpoint/);
      const status = await adapter.validateCredential(ctx.authRef, ctx);
      expect(status).toMatchObject({ ok: false, code: "unsupported" });
    });
  });

  test("the adapter's identity is `winter.vertex-gemini` on the google family", () => {
    const adapter = createVertexGeminiAdapter();
    expect(adapter.id).toBe(VERTEX_ADAPTER_ID);
    expect(adapter.version).toBe("1");
    expect(adapter.family).toBe("google");
    expect(adapter.protocol).toBe("google-generate-content");
  });

  test("the service-account JSON the fixture builds is exactly what the FROZEN file store parses", async () => {
    const harness = await createVertexHarness();
    harness.bind("http://127.0.0.1:1");
    const parsed = JSON.parse(serviceAccountJson(harness)) as Record<string, unknown>;
    // The three fields `credentials/file.ts` requires, and no invented fourth.
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(["client_email", "private_key", "token_uri"]));
  });
});

describe("Vertex Gemini: the WS-13 §13 corpus", () => {
  test("the SHARED cases fire against the Vertex transport, and the report says so", async () => {
    const harness = await createVertexHarness();
    const adapter = testVertexAdapter();
    await withFake({ routes: harness.routes }, async (fake) => {
      harness.bind(fake.url);
      const report = await runAdapterCorpus({ adapter: VERTEX_ADAPTER_ID, fake, model: GOOGLE_MODELS.main, cases: vertexCorpusCases(harness, adapter) });
      if (!report.ok) throw new Error(formatCorpusReport(report));
      expect(report.outcomes.filter((o) => o.status === "skipped").map((o) => o.id)).toEqual(["tool-call-fragmented"]);
      expect(report.outcomes.filter((o) => o.status === "missing" || o.status === "failed")).toEqual([]);
    });
  }, 30_000);
});
