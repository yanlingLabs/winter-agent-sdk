import { describe, expect, test } from "bun:test";
import { scanForSecrets, validateCatalog } from "../validate.ts";
import { extractAll, type LiteralValue, type Rejection } from "./literal-extractor.ts";
import { buildUpstreamLayer, ExtractionRefusal, mergeLayers, type Allowlist, type BuildUpstreamLayerInput } from "./merge.ts";
import { computeDenominator, FIELD_PROVENANCE, findClaimedProviderCount } from "./ledgers.ts";

/**
 * The mapper's contract, exercised on a WINTER-AUTHORED synthetic upstream tree.
 *
 * Synthetic on purpose. A fixture cut from the real OmniRoute tree would put vendored source in this
 * repository — the one thing `third_party/omniroute-provider-source/README.md` says never happens —
 * and it would also make these tests re-fetch the network to stay honest. The shapes below mirror
 * the ones the real extraction meets (a registry entry, a product-catalog category map, a shared
 * capability constant, a per-model `targetFormat`) with names and values of our own.
 */

const OBSERVED_AT = "2026-01-01T00:00:00Z";
const COMMIT = "a".repeat(40);

const SHARED = `export const SHARED_CAPS = { toolCalling: true, supportsVision: true, contextLength: 128000 };`;

const ACME = `import { SHARED_CAPS } from "../../shared.ts";
export const acmeProvider = {
  id: "acme",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.acme.test/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  reasoningTransport: "opaque",
  defaultContextLength: 64000,
  liveCatalogAuthoritative: true,
  models: [
    { id: "acme-one", name: "Acme One", ...SHARED_CAPS },
    { id: "acme-quiet", name: "Acme Quiet" },
    { id: "acme-one", name: "Acme One (again)" },
    { id: "acme-thinks", name: "Acme Thinks", supportsReasoning: true, supportedThinkingEfforts: ["low", "high"], maxOutputTokens: 4096 },
    { id: "acme-responses", name: "Acme Responses", targetFormat: "openai-responses" },
    { id: "acme-foreign", name: "Acme Foreign", targetFormat: "claude" },
  ],
};`;

const GHOST = `export const ghostProvider = {
  id: "ghost", format: "openai", executor: "default", authType: "apikey", authHeader: "bearer",
  models: [{ id: "ghost-one", name: "Ghost One" }],
};`;

const INDEX = `import { acmeProvider } from "./registry/acme/index.ts";
import { ghostProvider } from "./registry/ghost/index.ts";
export const REGISTRY: Record<string, unknown> = {
  acme: acmeProvider,
  ghost: ghostProvider,
};`;

const CATEGORY_FILES: Record<string, string> = {
  "src/shared/constants/providers/apikey/index.ts": `export const APIKEY_PROVIDERS = { acme: { id: "acme", name: "Acme AI" }, spare: { id: "spare", name: "Spare AI" } };`,
  "src/shared/constants/providers/web-cookie.ts": `export const WEB_COOKIE_PROVIDERS = { ghost: { id: "ghost", name: "Ghost Web" } };`,
  "src/shared/constants/providers/noauth.ts": `export const NOAUTH_PROVIDERS = { freebie: { id: "freebie", name: "Freebie" } };`,
  "src/shared/constants/providers/oauth.ts": `export const OAUTH_PROVIDERS = { signin: { id: "signin", name: "Sign In" } };`,
  "src/shared/constants/providers/local.ts": `export const LOCAL_PROVIDERS = { boxy: { id: "boxy", name: "Boxy" } };`,
  "src/shared/constants/providers/search.ts": `export const SEARCH_PROVIDERS = { finder: { id: "finder", name: "Finder" } };`,
  "src/shared/constants/providers/audio.ts": `export const AUDIO_ONLY_PROVIDERS = { speaky: { id: "speaky", name: "Speaky" } };`,
  "src/shared/constants/providers/upstream-proxy.ts": `export const UPSTREAM_PROXY_PROVIDERS = { relay: { id: "relay", name: "Relay" } };`,
  "src/shared/constants/providers/cloud-agent.ts": `export const CLOUD_AGENT_PROVIDERS = { drone: { id: "drone", name: "Drone" } };`,
  "src/shared/constants/providers/system.ts": `export const SYSTEM_PROVIDERS = { auto: { id: "auto", name: "Auto" } };`,
};

const SOURCES = [
  { path: "open-sse/config/providers/shared.ts", text: SHARED },
  { path: "open-sse/config/providers/registry/acme/index.ts", text: ACME },
  { path: "open-sse/config/providers/registry/ghost/index.ts", text: GHOST },
  { path: "open-sse/config/providers/index.ts", text: INDEX },
  ...Object.entries(CATEGORY_FILES).map(([path, text]) => ({ path, text })),
];

const CATEGORY_OF: Record<string, string> = {
  acme: "apikey", spare: "apikey", ghost: "web-cookie", freebie: "noauth", signin: "oauth",
  boxy: "local", finder: "search", speaky: "audio", relay: "upstream-proxy", drone: "cloud-agent", auto: "system",
};

const DISPOSITIONS: Allowlist["categoryDispositions"] = {
  apikey: { disposition: "candidate-pool", exclusionClass: "not-allowlisted", reason: "curated pool" },
  "web-cookie": { disposition: "blocked", exclusionClass: "category-web-cookie", reason: "browser-session transport" },
  noauth: { disposition: "blocked", exclusionClass: "category-no-auth", reason: "reject by default" },
  oauth: { disposition: "blocked", exclusionClass: "category-oauth", reason: "generic OAuth import is rejected" },
  local: { disposition: "winter-owned", exclusionClass: "category-local-live-discovery", reason: "live discovery only" },
  search: { disposition: "blocked", exclusionClass: "category-search", reason: "not an LLM provider" },
  audio: { disposition: "blocked", exclusionClass: "category-audio", reason: "not a worker model" },
  "upstream-proxy": { disposition: "blocked", exclusionClass: "category-upstream-proxy", reason: "no proxy-of-proxy" },
  "cloud-agent": { disposition: "blocked", exclusionClass: "category-cloud-agent", reason: "remote agent product" },
  system: { disposition: "blocked", exclusionClass: "category-system", reason: "routing policy" },
};

function allowlistWith(providers: Allowlist["providers"]): Allowlist {
  return {
    allowlistVersion: 2,
    paths: [],
    providers,
    categoryDispositions: DISPOSITIONS,
    blocked: [],
    importBoundary: { resolveIdentifiersWithin: "materialized-allowlisted-files-only", failOnUnresolvedFields: ["id", "format", "executor", "authType"] },
  };
}

const ACME_ROW = {
  upstreamId: "acme",
  winterId: "acme-winter",
  expectedCategory: "apikey",
  risk: { class: "review-required" as const, reasons: ["fixture"] },
  // WS-13b §1: an allowlist entry carries its own admission evidence, and `buildUpstreamLayer`
  // refuses the run without it (see "rows are evidence" below).
  pricingBasis: "token" as const,
  admission: { basis: "api-key" as const, citation: "https://acme.test/pricing" },
};

function buildInput(allowlist: Allowlist, patch: Partial<BuildUpstreamLayerInput> = {}): BuildUpstreamLayerInput {
  const { modules } = extractAll(SOURCES);
  const registryLiteral = modules.get("open-sse/config/providers/index.ts")!.values.get("REGISTRY") as Record<string, LiteralValue>;
  const moduleRejections: Rejection[] = [];
  for (const module of modules.values()) moduleRejections.push(...module.rejections);
  const categories = new Map(
    Object.entries(CATEGORY_OF).map(([id, category]) => [
      id,
      { category, sourcePath: `src/shared/constants/providers/${category}.ts`, row: { id, name: `${id} display` } as LiteralValue },
    ]),
  );
  return {
    allowlist,
    registry: new Map(Object.entries(registryLiteral)),
    categories,
    registrySourcePaths: new Map([["acme", "open-sse/config/providers/registry/acme/index.ts"], ["ghost", "open-sse/config/providers/registry/ghost/index.ts"]]),
    commit: COMMIT,
    observedAt: OBSERVED_AT,
    moduleRejections,
    ...patch,
  };
}

describe("the mapper", () => {
  const layer = buildUpstreamLayer(buildInput(allowlistWith([ACME_ROW])));
  const models = new Map(layer.models.map((m) => [m.key, m]));
  const rejectionsByPath = new Map(layer.rejections.map((r) => [r.path, r]));

  test("the allowlist's `winterId` renames the provider, and its risk is stamped through", () => {
    expect(layer.providers.map((p) => p.id)).toEqual(["acme-winter"]);
    const provider = layer.providers[0]!;
    expect(provider.risk).toEqual({ class: "review-required", reasons: ["fixture"] });
    expect(provider.upstream).toEqual({
      project: "OmniRoute",
      commit: COMMIT,
      sourcePaths: ["open-sse/config/providers/registry/acme/index.ts", "src/shared/constants/providers/apikey.ts"],
    });
  });

  test("a spread of a shared capability constant reaches the descriptor", () => {
    const one = models.get("acme-winter/acme-one")!;
    expect(one.toolCalling.value).toBe("native");
    expect(one.inputModalities.value).toEqual(["text", "image"]);
    expect(one.contextWindow?.value).toBe(128000);
  });

  test("ABSENT upstream tool calling becomes `none` at confidence `unknown` — never `native`", () => {
    // WS-13 §8.1: `native` is what makes a model agent-eligible. Inferring it from silence would
    // admit every unproven row to the agent modes on a guess.
    const quiet = models.get("acme-winter/acme-quiet")!;
    expect(quiet.toolCalling.value).toBe("none");
    expect(quiet.toolCalling.confidence).toBe("unknown");
    expect(quiet.nativeTools.value).toBe(false);
    expect(quiet.nativeTools.confidence).toBe("unknown");
    // ...and the provider's defaultContextLength is inherited when the model states none.
    expect(quiet.contextWindow?.value).toBe(64000);
  });

  test("a DUPLICATE upstream model id is dropped and RECORDED, never silently de-duplicated", () => {
    expect(layer.models.filter((m) => m.key === "acme-winter/acme-one")).toHaveLength(1);
    expect(models.get("acme-winter/acme-one")!.displayName).toBe("Acme One");
    expect(rejectionsByPath.get("acme.models[acme-one]")?.exclusionClass).toBe("duplicate-id");
  });

  test("`targetFormat` within the family selects the endpoint; ACROSS families it is refused", () => {
    expect(models.get("acme-winter/acme-responses")!.endpoints).toEqual(["responses"]);
    expect(models.has("acme-winter/acme-foreign")).toBe(false);
    const refusal = rejectionsByPath.get("acme.models[acme-foreign].targetFormat")!;
    expect(refusal.exclusionClass).toBe("unrepresentable-protocol");
    expect(refusal.reason).toContain("no per-model protocol field");
  });

  test("reasoning rides the provider's transport, and an unstated one is `none` rather than a guess", () => {
    const thinks = models.get("acme-winter/acme-thinks")!;
    expect(thinks.reasoning?.continuation).toBe("opaque-provider-state");
    expect(thinks.reasoning?.efforts).toEqual(["low", "high"]);
    expect(thinks.maxOutputTokens?.value).toBe(4096);
    expect(models.get("acme-winter/acme-quiet")!.reasoning).toBeUndefined();
  });

  test("every extracted capability is `upstream-static` / `inferred`, and NOTHING is priced or classifier-eligible", () => {
    for (const model of layer.models) {
      expect(model.status).toBe("candidate");
      expect(model.pricing).toBeUndefined();
      expect(model.classifierEligible).toBeUndefined();
      expect(model.inputModalities.source).toBe("upstream-static");
      expect(model.inputModalities.observedAt).toBe(OBSERVED_AT);
    }
  });

  test("`liveCatalogAuthoritative: true` is honoured when STATED; unstated is `unknown`, not upstream's default", () => {
    expect(layer.providers[0]!.liveCatalogAuthority).toBe("authoritative");
    const noFlag = buildUpstreamLayer(buildInput(allowlistWith([ACME_ROW]), {
      registry: new Map([["acme", { id: "acme", format: "openai", executor: "default", authType: "apikey", models: [] } as LiteralValue]]),
    }));
    expect(noFlag.providers[0]!.liveCatalogAuthority).toBe("unknown");
  });

  test("the emitted layer VALIDATES on its own — the overlay would otherwise hide every defect in it", () => {
    const standalone = mergeLayers(layer, { providers: [], models: [] }, { tag: "v9", tagObject: "t", commit: COMMIT, extractorVersion: "e", overlayVersion: "o" });
    const result = validateCatalog(standalone);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  test("no credential-shaped material reaches the layer", () => {
    expect(scanForSecrets(layer)).toEqual([]);
  });
});

describe("curation and class transitions (WS-13 §3 step 7 / §13)", () => {
  test("an api-key provider upstream lists but Winter has not curated is REJECTED, not imported", () => {
    const layer = buildUpstreamLayer(buildInput(allowlistWith([ACME_ROW])));
    expect(layer.providers.map((p) => p.id)).not.toContain("spare");
    const rejection = layer.rejections.find((r) => r.upstreamId === "spare")!;
    expect(rejection.exclusionClass).toBe("not-allowlisted");
  });

  test("...and a REVIEWED allowlist edit is the ONLY thing that admits it", () => {
    const layer = buildUpstreamLayer(buildInput(allowlistWith([
      ACME_ROW,
      { upstreamId: "spare", winterId: "spare", expectedCategory: "apikey", risk: { class: "approved", reasons: [] }, pricingBasis: "token" as const, admission: { basis: "api-key" as const, citation: "https://spare.test/pricing" } },
    ])));
    // It is admitted, but only as far as the pipeline can honestly take it: upstream has no backend
    // registry entry for `spare`, so the row is recorded as such rather than fabricated.
    expect(layer.rejections.find((r) => r.upstreamId === "spare")?.exclusionClass).toBe("no-registry-entry");
  });

  test("an allowlisted id whose upstream CATEGORY is a blocked class FAILS THE RUN", () => {
    // The transition WS-13 §3 step 7 blocks. Checking the allowlist against the pinned tree in this
    // direction is what stops an id from being quietly imported after upstream moves it into a
    // cookie/OAuth class — an allowlist that is merely trusted cannot notice.
    expect(() =>
      buildUpstreamLayer(buildInput(allowlistWith([{ upstreamId: "ghost", winterId: "ghost", expectedCategory: "web-cookie", risk: { class: "approved", reasons: [] }, pricingBasis: "token" as const, admission: { basis: "api-key" as const, citation: "https://ghost.test/pricing" } }]))),
    ).toThrow(/class transition BLOCKED/);
  });

  test("an allowlisted id that MOVED category since review fails rather than being imported", () => {
    expect(() =>
      buildUpstreamLayer(buildInput(allowlistWith([{ ...ACME_ROW, expectedCategory: "local" }]))),
    ).toThrow(/moved category/);
  });

  // --- WS-13b §1 (D21 / R6b-3): the allowlist entry's own admission evidence -----------------------
  //
  // These fail the RUN rather than dropping the row, for the same reason the "matches no upstream
  // row" case above does: a reviewer wrote the entry, so a silently absent row hides the defect in
  // the one file they would have gone to fix.
  test("an allowlisted entry with NO admission citation fails the run (admission-missing)", () => {
    const { admission: _dropped, ...noAdmission } = ACME_ROW;
    expect(() => buildUpstreamLayer(buildInput(allowlistWith([noAdmission as unknown as (typeof ACME_ROW)])))).toThrow(/admission-missing/);
  });

  test("an allowlisted entry with an EMPTY citation fails the same way — a present-but-blank field is not evidence", () => {
    expect(() => buildUpstreamLayer(buildInput(allowlistWith([{ ...ACME_ROW, admission: { basis: "api-key" as const, citation: "   " } }])))).toThrow(/admission-missing/);
  });

  test("an allowlisted entry with NO pricingBasis fails the run (admission-missing)", () => {
    const { pricingBasis: _dropped, ...noBasis } = ACME_ROW;
    expect(() => buildUpstreamLayer(buildInput(allowlistWith([noBasis as unknown as (typeof ACME_ROW)])))).toThrow(/admission-missing/);
  });

  test("an allowlisted entry citing the audit's `unknown` evidence class is REFUSED (admission-unknown), never imported", () => {
    expect(() => buildUpstreamLayer(buildInput(allowlistWith([{ ...ACME_ROW, admission: { basis: "api-key" as const, citation: "audit:unknown" } }])))).toThrow(/admission-unknown/);
  });

  test("the reviewed pricing basis and admission citation are COPIED onto the generated row, never derived", () => {
    const layer = buildUpstreamLayer(buildInput(allowlistWith([{ ...ACME_ROW, pricingBasis: "subscription" as const, admission: { basis: "oauth-documented" as const, citation: "audit:5.1" } }])));
    const row = layer.providers.find((provider) => provider.id === "acme-winter");
    expect(row?.pricingBasis).toBe("subscription");
    expect(row?.admission).toEqual({ basis: "oauth-documented", citation: "audit:5.1" });
  });

  test("an allowlist entry that matches NO upstream row fails loudly — a silently empty extraction is the worse outcome", () => {
    expect(() =>
      buildUpstreamLayer(buildInput(allowlistWith([{ upstreamId: "google", winterId: "google", expectedCategory: "apikey", risk: { class: "approved", reasons: [] }, pricingBasis: "token" as const, admission: { basis: "api-key" as const, citation: "https://google.test/pricing" } }]))),
    ).toThrow(/has no product-catalog row/);
  });
});

describe("unknown vocabularies FAIL extraction (WS-13 §13)", () => {
  const cases: Array<[string, LiteralValue]> = [
    ["format", { id: "acme", format: "grpc-native", executor: "default", authType: "apikey", models: [] }],
    ["authType", { id: "acme", format: "openai", executor: "default", authType: "mtls", models: [] }],
    ["executor", { id: "acme", format: "openai", executor: "browser-pool", authType: "apikey", models: [] }],
  ];
  for (const [field, entry] of cases) {
    test(`an unknown \`${field}\` refuses rather than defaulting`, () => {
      expect(() => buildUpstreamLayer(buildInput(allowlistWith([ACME_ROW]), { registry: new Map([["acme", entry]]) }))).toThrow(ExtractionRefusal);
    });
  }

  test("a NATIVE-CLOUD executor overrides its entry's `format` — and the override is recorded", () => {
    // Upstream's bedrock entry is `format: "openai"` with `executor: "bedrock"`, because its own
    // executor TRANSLATES an OpenAI-shaped request. Reading `format` alone produced a row that
    // validated cleanly and would have sent Converse traffic to the OpenAI chat adapter the day its
    // overlay shadow was removed — a latent misroute in a layer nothing currently reads.
    const layer = buildUpstreamLayer(
      buildInput(allowlistWith([ACME_ROW]), {
        registry: new Map([["acme", { id: "acme", format: "openai", executor: "bedrock", authType: "apikey", models: [] } as LiteralValue]]),
      }),
    );
    expect(layer.providers[0]!.protocols).toEqual(["bedrock-converse"]);
    expect(layer.providers[0]!.adapterId).toBe("winter.bedrock-converse");
    expect(layer.providers[0]!.family).toBe("bedrock");
    const recorded = layer.rejections.find((r) => r.path === "acme.format")!;
    // `reviewed-normalization`, not `unrepresentable-protocol`: the row SHIPPED. Filing a deliberate
    // normalization under an exclusion class made the ledger's own counts lie about what was dropped.
    expect(recorded.exclusionClass).toBe("reviewed-normalization");
    expect(recorded.reason).toContain("TRANSLATES FROM");
  });

  test("an executor with NO override still takes its protocol from `format`", () => {
    const layer = buildUpstreamLayer(
      buildInput(allowlistWith([ACME_ROW]), {
        registry: new Map([["acme", { id: "acme", format: "gemini", executor: "vertex", authType: "apikey", models: [] } as LiteralValue]]),
      }),
    );
    expect(layer.providers[0]!.protocols).toEqual(["google-generate-content"]);
    expect(layer.rejections.some((r) => r.path === "acme.format")).toBe(false);
    // ...but the ADAPTER is still overridden, which is the dimension the shipped layer was missing:
    // Vertex speaks GenerateContent, so its protocol was right and its adapter was not.
    expect(layer.providers[0]!.adapterId).toBe("winter.vertex-gemini");
    expect(layer.rejections.find((r) => r.path === "acme.executor")?.exclusionClass).toBe("reviewed-normalization");
  });

  test("a reviewed model override can correct an id, set a status, or EXCLUDE a row — each recorded", () => {
    const withOverrides = allowlistWith([ACME_ROW]);
    withOverrides.modelOverrides = {
      acme: {
        "acme-quiet": { id: "vendor/acme-quiet", why: "the vendor documents a qualified id" },
        "acme-thinks": { status: "experimental", why: "a live adapter serves this one" },
        "acme-responses": { exclude: true, why: "TEXT-TO-SPEECH — never a worker model" },
      },
    };
    const layer = buildUpstreamLayer(buildInput(withOverrides));
    const models = new Map(layer.models.map((m) => [m.key, m]));
    // id: corrected on the wire, with the upstream spelling kept as an alias so both resolve.
    expect(models.get("acme-winter/vendor/acme-quiet")!.upstreamId).toBe("vendor/acme-quiet");
    expect(models.get("acme-winter/vendor/acme-quiet")!.aliases).toContain("acme-quiet");
    // status: overrides the provider's default.
    expect(models.get("acme-winter/acme-thinks")!.status).toBe("experimental");
    // exclude: gone from the catalog, present in the ledger with its reason.
    expect(models.has("acme-winter/acme-responses")).toBe(false);
    const excluded = layer.rejections.find((r) => r.exclusionClass === "out-of-scope")!;
    expect(excluded.reason).toContain("TEXT-TO-SPEECH");
    expect(layer.rejections.filter((r) => r.exclusionClass === "reviewed-normalization").map((r) => r.path).sort()).toEqual([
      "acme.models[acme-quiet].id",
      "acme.models[acme-thinks].status",
    ]);
  });

  test("`outputModalities` is a WINTER DEFAULT, never stamped as something upstream said", () => {
    // Upstream's RegistryModel has no output-modality field at all. Shipping `["text"]` as
    // `upstream-static`/`inferred` read as "upstream said text" — a false claim wearing an upstream
    // label, and what let a text-to-speech model into the catalog looking like a text model.
    const layer = buildUpstreamLayer(buildInput(allowlistWith([ACME_ROW])));
    for (const model of layer.models) {
      // The label is in the SOURCE FIELD now (Lane X r1 carry). `EvidenceSource` was frozen when
      // this shipped, so the caveat could only live in a `sourceRef` sentence -- and a reader
      // filtering evidence by `source` still got a Winter guess wearing an upstream label.
      // `winter-default` is the member added for exactly this; the prose stays, because "why" is not
      // something an enum can carry.
      expect([model.key, model.outputModalities.source]).toEqual([model.key, "winter-default"]);
      expect([model.key, model.outputModalities.confidence]).toEqual([model.key, "unknown"]);
      expect(model.outputModalities.sourceRef).toContain("WINTER DEFAULT");
    }
  });

  test("an unreadable `unsupportedParams` is recorded for THAT model only — two models, one refusal, one row", () => {
    // The over-approximation this replaces matched `path.includes("models[")`, which is true for
    // every model in a file where ANY model had a refused field: three real refusals in
    // `openai/index.ts` produced NINETEEN ledger rows, sixteen asserting a refusal that never
    // happened. A ledger is read as evidence, so a false row is a false claim.
    const sources = [
      { path: "open-sse/config/providers/shared.ts", text: "export const FROZEN = Object.freeze([\"temperature\"]);" },
      {
        path: "open-sse/config/providers/registry/acme/index.ts",
        text: [
          'import { FROZEN } from "../../shared.ts";',
          "export const acmeProvider = {",
          '  id: "acme", format: "openai", executor: "default", authType: "apikey",',
          "  models: [",
          '    { id: "readable", name: "Readable", unsupportedParams: ["top_p"] },',
          '    { id: "refused", name: "Refused", unsupportedParams: FROZEN },',
          '    { id: "silent", name: "Silent" },',
          "  ],",
          "};",
        ].join("\n"),
      },
      { path: "open-sse/config/providers/index.ts", text: 'import { acmeProvider } from "./registry/acme/index.ts";\nexport const REGISTRY = { acme: acmeProvider };' },
      ...Object.entries(CATEGORY_FILES).map(([path, text]) => ({ path, text })),
    ];
    const { modules } = extractAll(sources);
    const moduleRejections: Rejection[] = [];
    for (const module of modules.values()) moduleRejections.push(...module.rejections);
    const registryLiteral = modules.get("open-sse/config/providers/index.ts")!.values.get("REGISTRY") as Record<string, LiteralValue>;
    const layer = buildUpstreamLayer({
      ...buildInput(allowlistWith([ACME_ROW])),
      registry: new Map(Object.entries(registryLiteral)),
      moduleRejections,
    });

    const recorded = layer.rejections.filter((r) => r.scope === "model" && r.path.endsWith(".unsupportedParams"));
    expect(recorded.map((r) => r.path)).toEqual(["acme.models[refused].unsupportedParams"]);
    expect(recorded[0]!.exclusionClass).toBe("unresolved-reference");
    expect(recorded[0]!.reason).toContain("fails OPEN");
    // The row that STATED a value keeps it; the row that stated nothing is silent in the ledger,
    // because "upstream says none" and "we could not read it" are exactly what must not look alike.
    const models = new Map(layer.models.map((m) => [m.key, m]));
    expect(models.get("acme-winter/readable")!.unsupportedParameters).toEqual(["top_p"]);
    expect(models.get("acme-winter/refused")!.unsupportedParameters).toEqual([]);
    expect(models.get("acme-winter/silent")!.unsupportedParameters).toEqual([]);
  });

  test("a refused or spread `models` ELEMENT fails the per-model correlation CLOSED, with one ledger row (Lane X r2)", () => {
    // The index the correlation above uses is a position in the extractor's COMPACTED array, while
    // the rejection path carries the SYNTACTIC element index. Here they diverge by exactly one: a
    // spread of a non-array is refused as `acme.models[1] (spread)` and contributes nothing to the
    // compacted array, so the model AFTER it sits at compacted 1 and syntactic 2 -- and the naive
    // correlation would report `later`'s unreadable field against `first`.
    //
    // Nothing on the current pin makes the two diverge, which is precisely why the guard is on the
    // CONDITION rather than on today's data: twelve real `models[N] (spread)` rejections exist
    // upstream, and the failure they would cause is a ledger row making a FALSE claim about a row
    // that never had the field.
    const sources = [
      { path: "open-sse/config/providers/shared.ts", text: "export const FROZEN = Object.freeze([\"temperature\"]);\nexport const NOT_AN_ARRAY = Object.freeze({ nope: true });" },
      {
        path: "open-sse/config/providers/registry/acme/index.ts",
        text: [
          'import { FROZEN, NOT_AN_ARRAY } from "../../shared.ts";',
          "export const acmeProvider = {",
          '  id: "acme", format: "openai", executor: "default", authType: "apikey",',
          "  models: [",
          '    { id: "first", name: "First" },',
          "    ...NOT_AN_ARRAY,",
          '    { id: "later", name: "Later", unsupportedParams: FROZEN },',
          "  ],",
          "};",
        ].join("\n"),
      },
      { path: "open-sse/config/providers/index.ts", text: 'import { acmeProvider } from "./registry/acme/index.ts";\nexport const REGISTRY = { acme: acmeProvider };' },
      ...Object.entries(CATEGORY_FILES).map(([path, text]) => ({ path, text })),
    ];
    const { modules } = extractAll(sources);
    const moduleRejections: Rejection[] = [];
    for (const module of modules.values()) moduleRejections.push(...module.rejections);
    // The precondition this guard exists for: the walker really did record an ELEMENT-level path.
    expect(moduleRejections.some((r) => /\.models\[\d+\] \(spread\)$/.test(r.path))).toBe(true);

    const registryLiteral = modules.get("open-sse/config/providers/index.ts")!.values.get("REGISTRY") as Record<string, LiteralValue>;
    const layer = buildUpstreamLayer({ ...buildInput(allowlistWith([ACME_ROW])), registry: new Map(Object.entries(registryLiteral)), moduleRejections });

    // ONE row, at provider scope, saying the correlation was refused -- and NO per-model claim, in
    // particular none against `first`, which is where the off-by-one would have landed it.
    const correlation = layer.rejections.filter((r) => r.path === "acme.models");
    expect(correlation).toHaveLength(1);
    expect(correlation[0]!.scope).toBe("provider");
    expect(correlation[0]!.reason).toContain("no longer line up");
    // The MERGE made no per-model claim. (The walker's own field-level row survives untouched: it
    // is a true statement about a source location, and it is the merge's correlation of that row to
    // a MODEL that the indices cannot support.)
    expect(layer.rejections.filter((r) => r.scope === "model" && r.path.endsWith(".unsupportedParams"))).toEqual([]);
    // The rows still ship, and the field still fails open.
    const models = new Map(layer.models.map((m) => [m.key, m]));
    expect([...models.keys()].sort()).toEqual(["acme-winter/first", "acme-winter/later"]);
    expect(models.get("acme-winter/later")!.unsupportedParameters).toEqual([]);
  });

  test("a `\"*\"` wildcard in `blocked` is REFUSED, never filtered away", () => {
    // It was filtered: a reader believed a wildcard block existed and nothing enforced one.
    const allowlist = allowlistWith([ACME_ROW]);
    allowlist.blocked = [{ upstreamId: "*", reason: "everything hostile" }];
    expect(() => buildUpstreamLayer(buildInput(allowlist))).toThrow(/wildcard/);
    expect(() => buildUpstreamLayer(buildInput(allowlist))).toThrow(/categoryDispositions/);
  });

  test("an identity-critical field the walker could not resolve refuses rather than guessing", () => {
    expect(() =>
      buildUpstreamLayer(buildInput(allowlistWith([ACME_ROW]), { registry: new Map([["acme", { id: "acme", format: "openai", authType: "apikey", models: [] } as LiteralValue]]) })),
    ).toThrow(/identity-critical field/);
  });

  test("an unknown upstream CATEGORY on a non-allowlisted id is recorded, never defaulted", () => {
    const layer = buildUpstreamLayer(
      buildInput(allowlistWith([ACME_ROW]), {
        categories: new Map([
          ["acme", { category: "apikey", sourcePath: "src/shared/constants/providers/apikey.ts", row: { id: "acme", name: "Acme AI" } }],
          ["mystery", { category: "quantum", sourcePath: "src/shared/constants/providers/quantum.ts", row: { id: "mystery", name: "Mystery" } }],
        ]),
      }),
    );
    const rejection = layer.rejections.find((r) => r.upstreamId === "mystery")!;
    expect(rejection.exclusionClass).toBe("unsupported-shape");
    expect(rejection.reason).toContain("no disposition in the allowlist");
  });
});

describe("determinism", () => {
  test("the same inputs produce BYTE-IDENTICAL output — the WS-13 §13 acceptance test, in miniature", () => {
    const first = JSON.stringify(buildUpstreamLayer(buildInput(allowlistWith([ACME_ROW]))), null, 2);
    const second = JSON.stringify(buildUpstreamLayer(buildInput(allowlistWith([ACME_ROW]))), null, 2);
    expect(second).toBe(first);
  });

  test("input ORDER does not change the output — rows and rejections are totally ordered", () => {
    const forwards = buildUpstreamLayer(buildInput(allowlistWith([ACME_ROW])));
    const shuffled = buildUpstreamLayer(
      buildInput(allowlistWith([ACME_ROW]), { categories: new Map([...buildInput(allowlistWith([ACME_ROW])).categories].reverse()) }),
    );
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forwards));
  });

  test("the evidence instant comes from the input, never the clock", () => {
    const layer = buildUpstreamLayer(buildInput(allowlistWith([ACME_ROW]), { observedAt: "1999-12-31T23:59:59Z" }));
    for (const model of layer.models) expect(model.inputModalities.observedAt).toBe("1999-12-31T23:59:59Z");
  });
});

describe("the overlay always wins, and is never overwritten", () => {
  const upstream = buildUpstreamLayer(buildInput(allowlistWith([ACME_ROW])));
  const pin = { tag: "v9", tagObject: "t", commit: COMMIT, extractorVersion: "e", overlayVersion: "o" };

  test("a same-key overlay row REPLACES the upstream one whole, never field-by-field", () => {
    const overlayModel = { ...upstream.models[0]!, displayName: "Overlaid", status: "experimental" as const };
    delete (overlayModel as { contextWindow?: unknown }).contextWindow;
    const merged = mergeLayers(upstream, { providers: [], models: [overlayModel] }, pin);
    const row = merged.models.find((m) => m.key === overlayModel.key)!;
    expect(row.displayName).toBe("Overlaid");
    // The upstream row's contextWindow does NOT bleed through. WS-13 §7's rule is that upstream
    // never overwrites overlay evidence, and a field-level merge would do exactly that for every
    // field the overlay deliberately leaves out.
    expect(row.contextWindow).toBeUndefined();
    expect(merged.models.filter((m) => m.key === overlayModel.key)).toHaveLength(1);
  });

  test("an empty pin still reads as the SEED marker, so the marker cannot be faked away", () => {
    expect(mergeLayers(upstream, { providers: [], models: [] }, { ...pin, commit: "" }).catalogVersion).toBe("0.0.0-seed");
    expect(mergeLayers(upstream, { providers: [], models: [] }, pin).catalogVersion).toBe("v9+e");
  });
});

describe("the denominator ledger", () => {
  const byCategory = new Map<string, Set<string>>();
  for (const [id, category] of Object.entries(CATEGORY_OF)) {
    const set = byCategory.get(category) ?? new Set<string>();
    set.add(id);
    byCategory.set(category, set);
  }

  test("counts the distinct UNION, reports duplicates, and compares upstream's own claim", () => {
    const report = computeDenominator({
      byCategory,
      registryIds: new Set(["acme", "ghost"]),
      registryIdsResolved: new Set(["acme"]),
      claimSources: [{ sourcePath: "README.md", text: "OmniRoute — 12 AI providers behind one endpoint" }],
    });
    expect(report.catalogueUnion).toBe(11);
    expect(report.categorySum).toBe(11);
    expect(report.duplicatedAcrossCategories).toEqual([]);
    expect(report.registryEntries).toBe(2);
    expect(report.registryEntriesResolved).toBe(1);
    expect(report.catalogueWithoutRegistry).toBe(9);
    expect(report.claims[0]!.claimed).toBe(12);
    expect(report.claims[0]!.note).toContain("differs from the enumerated");
  });

  test("an id in two categories is counted ONCE and named, so a naive sum cannot hide it", () => {
    const overlapping = new Map(byCategory);
    overlapping.set("audio", new Set(["speaky", "acme"]));
    const report = computeDenominator({ byCategory: overlapping, registryIds: new Set(), registryIdsResolved: new Set(), claimSources: [] });
    expect(report.catalogueUnion).toBe(11);
    expect(report.categorySum).toBe(12);
    expect(report.duplicatedAcrossCategories).toEqual(["acme"]);
    expect(report.summary).toContain("counted in more than one category");
  });

  test("both upstream claim spellings are recognised, and a source with none says so", () => {
    expect(findClaimedProviderCount("Total providers: **352**. See category breakdown below.")).toBe(352);
    expect(findClaimedProviderCount("one endpoint — 352 AI providers — 90+ free")).toBe(352);
    expect(findClaimedProviderCount("no counts here at all")).toBeUndefined();
  });
});

describe("the provenance table is data, not prose", () => {
  test("every FIELD_PROVENANCE row appears in PROVENANCE.md on the SAME TABLE ROW, with the same class", async () => {
    // The previous version checked the field name and the class spelling ANYWHERE in the document,
    // so a twin could class a field one way while the table classed it another and both strings were
    // still "present". Three rows had drifted exactly that way. Matching per ROW is what makes this
    // a pin rather than a spell-check.
    const doc = await Bun.file(new URL("../../PROVENANCE.md", import.meta.url)).text();
    const spelling: Record<string, string> = {
      "copied-verbatim": "copied verbatim",
      "mechanically-normalized": "mechanically normalized",
      "official-doc-derived": "official-doc derived",
      "live-probe-proven": "live-probe proven",
      "local-override": "local override",
    };
    const rows = [...doc.matchAll(/^\| (.+?) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({ field: m[1]!.trim(), provenance: m[2]!.trim().toLowerCase() }));
    expect(rows.length).toBeGreaterThan(15);
    for (const entry of FIELD_PROVENANCE) {
      // EVERY half, not just the first. The drift that shipped was a twin classing
      // `model.inputModalities / outputModalities` together while the doc had split them onto rows
      // with DIFFERENT classes — invisible to a check that only looked up the primary half.
      for (const name of entry.field.split(" / ")) {
        // Full dotted names on both sides, so a half can only match the row that names it.
        const row = rows.find((r) => r.field.includes(`\`${name}\``));
        expect([entry.field, name, row !== undefined]).toEqual([entry.field, name, true]);
        expect([entry.field, name, row!.provenance.includes(spelling[entry.provenance]!)]).toEqual([entry.field, name, true]);
      }
    }
  });

  test("nothing in the table claims extraction can produce pricing or classifier eligibility", () => {
    for (const field of ["*.pricing", "*.classifierEligible"]) {
      const row = FIELD_PROVENANCE.find((r) => r.field === field)!;
      expect(row.note.toUpperCase()).toContain(field === "*.pricing" ? "OVERLAY ONLY" : "NEVER SET");
    }
  });
});

describe("the lane's own source files stay TEXT", () => {
  test("no control byte makes a lane source file binary to grep, diff or a review package", async () => {
    // A regression test for a defect that hid itself. `merge.ts` carried eight raw NUL bytes in
    // `compareRejections` from its first commit — a deliberate composite-key separator, typed as a
    // literal instead of an escape. The key worked; the FILE became `data` to `file(1)`, so `grep`
    // reported no matches anywhere in it. Every search a reviewer ran against the mapper came back
    // empty and looked like an answer. Nothing about the extraction output could have revealed it,
    // which is why the check is on the SOURCE.
    const dir = new URL("./", import.meta.url);
    const { readdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(dir);
    // EVERY lane source, which is what the commit and the report claimed while this scanned
    // `src/extract/` alone (Lane X r2). The sync SCRIPT and its test are lane sources too, they are
    // written by the same hands, and they are exactly where a separator typed as a literal would go
    // unnoticed for the same reason -- so they are named here as fixed relative paths rather than
    // left to a directory listing that cannot see outside this package.
    const repoRoot = fileURLToPath(new URL("../../../../", dir));
    const scanned = [
      ...readdirSync(root).filter((name) => name.endsWith(".ts")).map((name) => ({ name, path: `${root}${name}` })),
      { name: "scripts/provider-source-sync.ts", path: `${repoRoot}scripts/provider-source-sync.ts` },
      { name: "scripts/provider-source-sync.test.ts", path: `${repoRoot}scripts/provider-source-sync.test.ts` },
    ];
    expect(scanned.length).toBeGreaterThan(6);
    for (const { name, path } of scanned) {
      // A path that stops existing must FAIL rather than silently scan nothing -- the whole class of
      // defect here is a check that looks like it ran.
      expect([name, await Bun.file(path).exists()]).toEqual([name, true]);
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      const offenders: string[] = [];
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i]!;
        // Tab, LF and CR are the only control bytes source may carry. Everything below 0x20 else —
        // NUL above all — turns the file binary for the tools a reviewer actually uses.
        if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) offenders.push(`${name}: 0x${byte.toString(16)} at byte ${i}`);
      }
      expect([name, offenders]).toEqual([name, []]);
    }
  });
});
