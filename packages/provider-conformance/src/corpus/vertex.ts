// Phase 6 Task 6 (Lane B): the Vertex Gemini WS-13 §13 corpus.
//
// ADDED beside `corpus/runner.ts`, which is FROZEN (R6-12).
//
// IT ASKS THE SAME QUESTIONS AS THE GEMINI API CORPUS, THROUGH THE SAME CASES, and that is the
// point rather than a shortcut: Vertex is a TRANSPORT over the same dialect and the same normalizer
// (ruling R6-A), so a separate case set would leave the shared half tested twice and the differing
// half tested once. `googleFamilyCorpusCases` is parameterised by exactly what differs -- the URL
// shape, the credential, and the absence of a bounded list endpoint -- and this file supplies it.
//
// NO KEY MATERIAL IS EVER COMMITTED (ruling R6-A, verbatim): the RSA keypair is generated in-test,
// the service-account JSON is assembled in memory, and the file credential store reads it through an
// INJECTED reader that never touches a real filesystem.
import type { ReasoningCapabilities, WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { createFileCredentialStore, createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import type { CredentialStore, ProviderAdapter, ProviderContext } from "@yanlinglabs/winter-provider-runtime";
import { createVertexGeminiAdapter, vertexModelPath } from "../../../provider-runtime/src/adapters/google/index.ts";
import { assertVertexRequest, generateTestKeyPair, vertexFakeRoutes, vertexTokenUrl, type VerifiedAssertion, type VertexFakeOptions } from "../fakes/vertex.ts";
import { jsonResponse, type FakeRoute } from "../fakes/server.ts";
import { GOOGLE_MODELS, googleFamilyCorpusCases, googleScenarioStream } from "./google.ts";
import type { CorpusCaseId, CorpusCaseImpl } from "./runner.ts";

export const VERTEX_PROJECT = "winter-test-project";
export const VERTEX_LOCATION = "us-central1";
export const VERTEX_SERVICE_ACCOUNT_EMAIL = "winter-test@winter-test-project.iam.gserviceaccount.com";
/** The in-memory path the injected reader answers for. No real file is created anywhere. */
export const VERTEX_SERVICE_ACCOUNT_PATH = "/winter-test/service-account.json";

const evidence = <T>(value: T): { value: T; source: "upstream-static"; confidence: "inferred"; observedAt: string } => ({
  value,
  source: "upstream-static",
  confidence: "inferred",
  observedAt: "2026-09-05T00:00:00Z",
});

const vertexReasoning = (key: string): ReasoningCapabilities => ({
  supported: evidence(true),
  efforts: ["low", "medium", "high", "xhigh", "max"],
  continuation: "opaque-provider-state",
  readableState: evidence("summary" as const),
  summaryRequest: evidence({ field: "thinkingConfig.includeThoughts", values: ["true"] }),
  completionEvent: evidence("the chunk carrying finishReason"),
  continuationDomain: evidence([key]),
});

function model(over: Partial<WinterModelDescriptor> & { key: string; upstreamId: string }): WinterModelDescriptor {
  return {
    providerId: "vertex",
    displayName: over.key,
    aliases: [],
    endpoints: ["chat"],
    inputModalities: evidence(["text", "image"]),
    outputModalities: evidence(["text"]),
    toolCalling: evidence("native" as const),
    nativeTools: evidence(true),
    unsupportedParameters: [],
    // EXPERIMENTAL, per R6-16: the native-cloud trio enters the catalog at that status, never
    // `supported`, until the behavioural corpus has run against a real endpoint.
    status: "experimental",
    ...over,
  };
}

export function testVertexCatalog(): WinterCatalog {
  const reasoningIds = [GOOGLE_MODELS.main, GOOGLE_MODELS.full, GOOGLE_MODELS.multiTool, GOOGLE_MODELS.dropBeforeFinish, GOOGLE_MODELS.usage, GOOGLE_MODELS.replay, GOOGLE_MODELS.refusal];
  return {
    schemaVersion: 1,
    catalogVersion: "0.0.0-lane-b-fixture",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers: [
      {
        id: "vertex",
        displayName: "Google Vertex AI",
        protocols: ["google-generate-content"],
        authKinds: ["cloud-credential-chain"],
        // EMPTY, and necessarily so: the host is `<location>-aiplatform.googleapis.com`, which does
        // not exist until a connection names its location. The adapter composes it.
        defaultEndpoints: {},
        modelDiscovery: "provider-native",
        liveCatalogAuthority: "partial",
        adapterId: "winter.vertex-gemini",
        family: "google",
        upstream: { project: "winter", commit: "", sourcePaths: [] },
        risk: { class: "approved", reasons: [] },
        scope: "llm",
      },
    ],
    models: [
      ...reasoningIds.map((id) => model({ key: `vertex/${id}`, upstreamId: id, reasoning: vertexReasoning(`vertex/${id}`), contextWindow: evidence(1_048_576) })),
      model({ key: `vertex/${GOOGLE_MODELS.noTools}`, upstreamId: GOOGLE_MODELS.noTools, toolCalling: evidence("none" as const), nativeTools: evidence(false) }),
      model({ key: `vertex/${GOOGLE_MODELS.noVision}`, upstreamId: GOOGLE_MODELS.noVision, inputModalities: evidence(["text"]) }),
      model({ key: `vertex/${GOOGLE_MODELS.capped}`, upstreamId: GOOGLE_MODELS.capped, maxOutputTokens: evidence(2048), reasoning: vertexReasoning(`vertex/${GOOGLE_MODELS.capped}`) }),
      model({ key: `vertex/${GOOGLE_MODELS.noEfforts}`, upstreamId: GOOGLE_MODELS.noEfforts, reasoning: { supported: evidence(true), efforts: [], continuation: "none" } }),
    ],
  };
}

/** Everything one Vertex fixture needs: the in-test keypair, the mutable fake options, and the verified-assertion log. */
export interface VertexHarness {
  privateKeyPem: string;
  publicKey: CryptoKey;
  verified: VerifiedAssertion[];
  fakeOptions: VertexFakeOptions;
  routes: FakeRoute[];
  /** Called once the fake is listening: the `aud` claim and the credential's `token_uri` are both this URL. */
  bind(fakeUrl: string): void;
  tokenUri: string;
}

/**
 * Builds the harness.
 *
 * `tokenUri` is filled in AFTER the fake starts, because the assertion's audience is the fake's own
 * ephemeral URL and the routes have to exist before the port does. The fake reads `opts.tokenUri` at
 * request time, so mutating it after `startFake` is exactly what the shape supports.
 */
export async function createVertexHarness(over: Partial<VertexFakeOptions> = {}): Promise<VertexHarness> {
  const { privateKeyPem, publicKey } = await generateTestKeyPair();
  const verified: VerifiedAssertion[] = [];
  const fakeOptions: VertexFakeOptions = {
    publicKey,
    project: VERTEX_PROJECT,
    location: VERTEX_LOCATION,
    tokenUri: "",
    verified,
    stream: googleScenarioStream(),
    countTokens: (recorded) => jsonResponse({ totalTokens: (JSON.parse(recorded.body).contents as unknown[]).length * 100 }),
    ...over,
  };
  const harness: VertexHarness = {
    privateKeyPem,
    publicKey,
    verified,
    fakeOptions,
    routes: vertexFakeRoutes(fakeOptions),
    tokenUri: "",
    bind(fakeUrl: string) {
      harness.tokenUri = vertexTokenUrl(fakeUrl);
      fakeOptions.tokenUri = harness.tokenUri;
    },
  };
  return harness;
}

/** The service-account JSON, assembled in memory. Its `token_uri` points at the fake's own token route. */
export function serviceAccountJson(harness: VertexHarness): string {
  return JSON.stringify({
    type: "service_account",
    project_id: VERTEX_PROJECT,
    client_email: VERTEX_SERVICE_ACCOUNT_EMAIL,
    private_key: harness.privateKeyPem,
    token_uri: harness.tokenUri,
  });
}

/** A file credential store whose reader is INJECTED: nothing here opens a real file, and `~/.aws` is never consulted. */
export function serviceAccountStore(harness: VertexHarness): CredentialStore {
  return createFileCredentialStore({
    env: {},
    home: "/winter-test-home-that-does-not-exist",
    readFile: async (path: string) => {
      if (path !== VERTEX_SERVICE_ACCOUNT_PATH) {
        const err = new Error(`no such file: ${path}`) as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      }
      return serviceAccountJson(harness);
    },
  });
}

export function vertexContext(harness: VertexHarness, baseUrl: string, over: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connection: { providerId: "vertex", baseUrl, local: true, project: VERTEX_PROJECT, location: VERTEX_LOCATION },
    credentials: serviceAccountStore(harness),
    authRef: { kind: "file", path: VERTEX_SERVICE_ACCOUNT_PATH, format: "gcp-service-account-json" },
    stallTimeoutMs: 2_000,
    log: () => {},
    ...over,
  };
}

/** A context authenticating with an already-minted access token -- R6-A's second ADC form. */
export function vertexAccessTokenContext(baseUrl: string, token: string, over: Partial<ProviderContext> = {}): ProviderContext {
  return {
    connection: { providerId: "vertex", baseUrl, local: true, project: VERTEX_PROJECT, location: VERTEX_LOCATION },
    credentials: createMemoryCredentialStore([[{ kind: "keychain", account: "vertex:test" }, { kind: "gcp-access-token", token }]]),
    authRef: { kind: "keychain", account: "vertex:test" },
    stallTimeoutMs: 2_000,
    log: () => {},
    ...over,
  };
}

export function testVertexAdapter(over: Parameters<typeof createVertexGeminiAdapter>[0] = {}): ProviderAdapter {
  return createVertexGeminiAdapter({
    catalog: testVertexCatalog(),
    retry: { maxRetries: 3, random: () => 0.5, sleep: async () => {} },
    requestTimeoutMs: 5_000,
    ...over,
  });
}

export function vertexGeneratePath(model: string): string {
  return vertexModelPath(VERTEX_PROJECT, VERTEX_LOCATION, model, "streamGenerateContent");
}

/** The Vertex corpus: the SHARED cases, configured for this transport. */
export function vertexCorpusCases(harness: VertexHarness, adapter: ProviderAdapter): Partial<Record<CorpusCaseId, CorpusCaseImpl>> {
  return googleFamilyCorpusCases({
    adapter,
    context: (fake) => vertexContext(harness, fake.url),
    contextWith: (fake, over) => vertexContext(harness, fake.url, over),
    catalog: testVertexCatalog(),
    providerId: "vertex",
    models: GOOGLE_MODELS,
    isGenerateRequest: (recorded) => recorded.path.includes(":streamGenerateContent"),
    assertSerialization: (recorded, model) => assertVertexRequest(recorded, { project: VERTEX_PROJECT, location: VERTEX_LOCATION, model, search: "?alt=sse" }),
    generatePath: vertexGeneratePath,
    // This phase scopes Vertex to the generation path: there is no bounded model-list endpoint, and
    // the corpus checks that the absence is reported as PARTIAL rather than as an empty catalog.
    discovery: "unsupported",
  });
}
