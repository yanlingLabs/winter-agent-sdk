// Phase 6 Task 8 (Lane D): the live gate's OPT-OUT is what this file proves.
//
// The live script itself is never exercised against a provider here — that is the whole point of it
// being opt-in. What must be true on every machine, including a developer's with real keys exported,
// is that a plain `bun test` cannot make it reach a vendor. So the fixtures below drive the pure
// planner directly, and then SPAWN the real script with every `WINTER_LIVE_*` variable stripped from
// the environment and assert on its exact output and exit code.
//
// Stripping rather than merely not-adding is the load-bearing part: `bun test` inherits the shell,
// and a developer who exported `WINTER_LIVE_OPENAI_API_KEY` an hour ago would otherwise have this
// very test spend their money.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, type ProviderAuthKind, type WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { normalizeHttpError, winterUserAgent } from "@yanlinglabs/winter-provider-runtime";
import { errorResponse, startFake } from "winter-provider-conformance";
import { ADAPTERS_MODULE_VAR, countByKind, CREDENTIAL_REF_SUFFIX, collectAdapters, liveEnvPrefix, OPT_IN_VAR, planLiveRun, SKIPPED_LINE } from "./verify-provider-live.ts";

const CATALOG = loadCatalog();

/**
 * The shipped catalog plus a synthetic row, so the three TARGET KINDS can be planned before the rows
 * that will exercise them exist.
 *
 * P6.5 lands `xai-oauth`, `qoder`, `aihorde` and `uncloseai` in Lanes X2/O, which merge AFTER this
 * lane. A planner test that waited for them would either not exist or be written against ids the
 * catalog does not have — so the two rows below are built by cloning a real descriptor and
 * overriding only the three fields the planner reads (`id`, `authKinds`, `pricingBasis`). The
 * real-catalog twins further down pin the SAME two behaviours against rows that ship TODAY
 * (`codex-oauth` is OAuth-only; every local row is `free`), so neither kind rests on a fixture alone.
 */
function catalogPlus(rows: Array<{ id: string; authKinds: ProviderAuthKind[]; pricingBasis: "token" | "subscription" | "free" }>): WinterCatalog {
  const provider = CATALOG.providers.find((p) => p.id === "openai")!;
  const model = CATALOG.models.find((m) => m.providerId === "openai")!;
  return {
    ...CATALOG,
    providers: [...CATALOG.providers, ...rows.map((row) => ({ ...provider, ...row }))],
    models: [...CATALOG.models, ...rows.map((row) => ({ ...model, providerId: row.id, key: `${row.id}/probe-model`, upstreamId: "probe-model" }))],
  };
}

/** `process.env` with every live-gate variable removed. Used for BOTH the in-process planner and the spawned child. */
function strippedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("WINTER_LIVE")) continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

describe("the environment variable spelling", () => {
  test("is one function for all three variables", () => {
    expect(liveEnvPrefix("openai")).toBe("WINTER_LIVE_OPENAI");
    expect(liveEnvPrefix("codex-oauth")).toBe("WINTER_LIVE_CODEX_OAUTH");
    expect(liveEnvPrefix("ollama-local")).toBe("WINTER_LIVE_OLLAMA_LOCAL");
    expect(liveEnvPrefix("azure-openai")).toBe("WINTER_LIVE_AZURE_OPENAI");
  });
});

describe("planLiveRun refuses by default", () => {
  test("no opt-in variable at all", () => {
    expect(planLiveRun(strippedEnv(), CATALOG)).toEqual({ optedIn: false, reason: SKIPPED_LINE });
  });

  test("the opt-in variable set to anything but `1`", () => {
    for (const value of ["", "0", "true", "yes", "01"]) {
      expect(planLiveRun(strippedEnv({ [OPT_IN_VAR]: value }), CATALOG).optedIn).toBe(false);
    }
  });

  test("opted in but with NO provider key -- the case a CI runner would hit", () => {
    expect(planLiveRun(strippedEnv({ [OPT_IN_VAR]: "1" }), CATALOG)).toEqual({ optedIn: false, reason: SKIPPED_LINE });
  });

  test("a key WITHOUT the opt-in variable is still nothing -- both are required", () => {
    expect(planLiveRun(strippedEnv({ WINTER_LIVE_OPENAI_API_KEY: "test-key-x" }), CATALOG).optedIn).toBe(false);
  });

  test("a blank key does not select a provider", () => {
    expect(planLiveRun(strippedEnv({ [OPT_IN_VAR]: "1", WINTER_LIVE_OPENAI_API_KEY: "   " }), CATALOG).optedIn).toBe(false);
  });

  test("an ambient conventional key is NEVER read (R6-10: no implicit scan)", () => {
    // The one variable a real developer is most likely to have exported.
    const plan = planLiveRun(strippedEnv({ [OPT_IN_VAR]: "1", OPENAI_API_KEY: "test-key-ambient-not-mine", ANTHROPIC_API_KEY: "test-key-ambient-not-mine" }), CATALOG);
    expect(plan.optedIn).toBe(false);
  });
});

describe("planLiveRun selects exactly what was named", () => {
  test("one provider, its default model from the catalog", () => {
    const plan = planLiveRun(strippedEnv({ [OPT_IN_VAR]: "1", WINTER_LIVE_OPENAI_API_KEY: "test-key-x" }), CATALOG);
    expect(plan.optedIn).toBe(true);
    if (!plan.optedIn) return;
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.providerId).toBe("openai");
    expect(plan.targets[0]!.kind).toBe("api-key");
    expect(plan.targets[0]!.selectedBy).toBe("WINTER_LIVE_OPENAI_API_KEY");
    expect(plan.targets[0]!.authRef).toEqual({ kind: "env", name: "WINTER_LIVE_OPENAI_API_KEY" });
    expect(plan.targets[0]!.model).toBe(CATALOG.models.find((m) => m.providerId === "openai")!.key);
    expect("baseUrl" in plan.targets[0]!).toBe(false);
  });

  test("the model override wins, and a base url rides along", () => {
    const plan = planLiveRun(
      strippedEnv({ [OPT_IN_VAR]: "1", WINTER_LIVE_OLLAMA_LOCAL_API_KEY: "unused", WINTER_LIVE_OLLAMA_LOCAL_MODEL: "qwen3:4b", WINTER_LIVE_OLLAMA_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1" }),
      CATALOG,
    );
    expect(plan.optedIn).toBe(true);
    if (!plan.optedIn) return;
    expect(plan.targets).toEqual([
      { providerId: "ollama-local", kind: "api-key", selectedBy: "WINTER_LIVE_OLLAMA_LOCAL_API_KEY", authRef: { kind: "env", name: "WINTER_LIVE_OLLAMA_LOCAL_API_KEY" }, model: "qwen3:4b", baseUrl: "http://127.0.0.1:11434/v1" },
    ]);
  });

  test("two named providers produce two targets, and nothing else does", () => {
    const plan = planLiveRun(strippedEnv({ [OPT_IN_VAR]: "1", WINTER_LIVE_OPENAI_API_KEY: "test-key-a", WINTER_LIVE_ANTHROPIC_API_KEY: "test-key-b" }), CATALOG);
    expect(plan.optedIn).toBe(true);
    if (!plan.optedIn) return;
    expect(plan.targets.map((t) => t.providerId).sort()).toEqual(["anthropic", "openai"]);
  });

  test("a key naming a provider the catalog does not have selects nothing", () => {
    expect(planLiveRun(strippedEnv({ [OPT_IN_VAR]: "1", WINTER_LIVE_NOT_A_PROVIDER_API_KEY: "test-key-x" }), CATALOG).optedIn).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// P6.5 Lane L: the gate admits three KINDS of target, because WS-13b §1 admits three documented
// third-party paths — an API key, an OAuth/device flow, and an explicitly public keyless endpoint.
//
// Every one of these drives the PURE planner. The oauth kind is the only selector in this gate that
// reaches the real Keychain, and it does so only inside `runTarget`; nothing in this file may spawn
// the script with a `_CREDENTIAL_REF` variable, and `run()` below REFUSES to, structurally.
// -------------------------------------------------------------------------------------------------
describe("WS-13b: the live gate's three target kinds", () => {
  const XAI = catalogPlus([{ id: "xai-oauth", authKinds: ["oauth-approved"], pricingBasis: "subscription" }]);
  const HORDE = catalogPlus([{ id: "aihorde", authKinds: ["custom"], pricingBasis: "free" }]);

  test("an OAuth row is selected by WINTER_LIVE_<P>_CREDENTIAL_REF and never by an API-key variable", () => {
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: "keychain:xai-oauth:acct" }, XAI);
    expect(plan.optedIn && plan.targets.map((t) => [t.providerId, t.kind])).toEqual([["xai-oauth", "oauth"]]);
    // The credential resolves through a KEYCHAIN ref — R6-10's one record per provider/account — and
    // the target reports the VARIABLE that named it, never the account.
    expect(plan.optedIn && plan.targets[0]!.authRef).toEqual({ kind: "keychain", account: "xai-oauth:acct" });
    expect(plan.optedIn && plan.targets[0]!.selectedBy).toBe("WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF");
    // ...and the second half of this test's name, which is the part with teeth: an API-key variable
    // naming an OAuth-only row selects NOTHING. Without it, an operator with a stale key variable
    // would send a bearer this vendor never issued and read the 401 as a Winter bug.
    const byKey = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_XAI_OAUTH_API_KEY: "test-key-x" }, XAI);
    expect(byKey.optedIn).toBe(false);
    expect(byKey.warnings?.join(" ")).toContain("WINTER_LIVE_XAI_OAUTH_API_KEY");
  });

  test("a keyless row is selected by WINTER_LIVE_<P>=1 with no key", () => {
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_AIHORDE: "1" }, HORDE);
    expect(plan.optedIn && plan.targets[0]).toMatchObject({ providerId: "aihorde", kind: "keyless" });
    // `none` is a real `CredentialRef` arm: every store answers it with null, so "send no credential"
    // is a resolution rather than a missing one.
    expect(plan.optedIn && plan.targets[0]!.authRef).toEqual({ kind: "none" });
  });

  test("the keyless selector is `1` exactly, and it never applies to a PRICED row -- an unauthenticated request to a paid vendor is not a smaller mistake than none", () => {
    for (const value of ["", "0", "true", "yes"]) {
      expect(planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_AIHORDE: value }, HORDE).optedIn).toBe(false);
    }
    // Selection itself does NOT check a row's `authKinds` against its ref (`{kind:"none"}` resolves
    // to null on every store and the adapter simply sends no Authorization header), so this plan-time
    // gate is the only thing standing between `WINTER_LIVE_OPENAI=1` and a keyless request to a paid
    // endpoint. `pricingBasis` is the field that decides, because it is the one WS-13b §1 requires on
    // every row.
    const paid = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_OPENAI: "1" }, CATALOG);
    expect(paid.optedIn).toBe(false);
    expect(paid.warnings?.join(" ")).toContain("pricingBasis");
  });

  test("a CREDENTIAL_REF that is not a `keychain:<account>` locator is refused rather than guessed at", () => {
    for (const value of ["xai-oauth:acct", "env:SOMETHING", "keychain:", "  "]) {
      const plan = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: value }, XAI);
      expect(plan.optedIn).toBe(false);
    }
  });

  test("naming BOTH a credential ref and an API key for one provider resolves through the ref, and SAYS so -- neither variable's value is printed", () => {
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: "keychain:xai-oauth:acct", WINTER_LIVE_XAI_OAUTH_API_KEY: "test-key-x" }, XAI);
    expect(plan.optedIn && plan.targets.map((t) => t.kind)).toEqual(["oauth"]);
    const warning = (plan.warnings ?? []).join(" ");
    expect(warning).toContain("WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF");
    expect(warning).toContain("WINTER_LIVE_XAI_OAUTH_API_KEY");
    expect(warning).not.toContain("test-key-x");
    expect(warning).not.toContain("xai-oauth:acct");
  });

  test("a run that names a provider and selects nothing does NOT read as `not opted in` -- the reason carries the warnings", () => {
    // The failure this exists for: an operator sets one variable, gets the not-opted-in line, and
    // concludes the opt-in did not take. A refusal that explains itself is the difference.
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_XAI_OAUTH_API_KEY: "test-key-x" }, XAI);
    expect(plan.optedIn).toBe(false);
    expect(plan.optedIn === false && plan.reason).toBe(SKIPPED_LINE);
    expect(plan.warnings ?? []).not.toEqual([]);
    // ...and a genuinely empty environment still carries NO warnings key at all, so the plain
    // not-opted-in shape is unchanged.
    expect(planLiveRun(strippedEnv(), CATALOG)).toEqual({ optedIn: false, reason: SKIPPED_LINE });
  });

  test("the three kinds are counted per kind, so a run says what it is about to do before it does it", () => {
    const catalog = catalogPlus([
      { id: "xai-oauth", authKinds: ["oauth-approved"], pricingBasis: "subscription" },
      { id: "aihorde", authKinds: ["custom"], pricingBasis: "free" },
    ]);
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_OPENAI_API_KEY: "test-key-x", WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: "keychain:xai-oauth:acct", WINTER_LIVE_AIHORDE: "1" }, catalog);
    expect(plan.optedIn).toBe(true);
    if (!plan.optedIn) return;
    expect(plan.targets.map((t) => t.kind).sort()).toEqual(["api-key", "keyless", "oauth"]);
    expect(countByKind(plan.targets)).toEqual({ "api-key": 1, oauth: 1, keyless: 1 });
  });
});

describe("WS-13b: the three kinds against the SHIPPED catalog, not a fixture", () => {
  test("codex-oauth is OAuth-only TODAY: a keychain ref selects it, its API-key variable does not", () => {
    const byRef = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_CODEX_OAUTH_CREDENTIAL_REF: "keychain:codex-oauth:acct" }, CATALOG);
    expect(byRef.optedIn && byRef.targets.map((t) => [t.providerId, t.kind])).toEqual([["codex-oauth", "oauth"]]);
    // A DELIBERATE behaviour change from Phase 6: `WINTER_LIVE_CODEX_OAUTH_API_KEY` used to select
    // this row and send its value as a bearer. codex-oauth issues no API keys, so that target could
    // only ever 401.
    expect(planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_CODEX_OAUTH_API_KEY: "test-key-x" }, CATALOG).optedIn).toBe(false);
  });

  test("a local row is keyless TODAY: `WINTER_LIVE_OLLAMA_LOCAL=1` needs no dummy key, and the dummy-key path still works", () => {
    const keyless = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_OLLAMA_LOCAL: "1", WINTER_LIVE_OLLAMA_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1" }, CATALOG);
    expect(keyless.optedIn && keyless.targets.map((t) => [t.providerId, t.kind])).toEqual([["ollama-local", "keyless"]]);
    expect(keyless.optedIn && keyless.targets[0]!.baseUrl).toBe("http://127.0.0.1:11434/v1");
    // The old shape is not withdrawn: a local row is `api-key` when a key variable names it, which is
    // what every existing invocation in this file's usage block does.
    expect(planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_OLLAMA_LOCAL_API_KEY: "unused" }, CATALOG).optedIn).toBe(true);
  });

  test("cloud-credential-chain rows are untouched: bedrock and vertex still select on their API-key variable", () => {
    // The OAuth-only skip is `authKinds` includes oauth-approved AND excludes api-key. Widening it to
    // cloud rows would silently withdraw two targets P6's gate already supports.
    for (const id of ["bedrock", "vertex", "azure-openai"]) {
      const plan = planLiveRun({ [OPT_IN_VAR]: "1", [`${liveEnvPrefix(id)}_API_KEY`]: "test-key-x" }, CATALOG);
      expect(plan.optedIn && plan.targets.map((t) => [t.providerId, t.kind])).toEqual([[id, "api-key"]]);
    }
  });
});

describe("collectAdapters duck-types whatever a lane's barrel exports", () => {
  const adapter = (id: string) => ({ id, version: "1.0.0", family: "openai", protocol: "openai-responses", streamTurn: () => {}, validateCredential: async () => ({ ok: true }), listModels: async () => ({}), mapEffort: () => ({}), capabilities: () => ({}) });

  test("finds them in an exported array, in a named export, and in a nested record", () => {
    expect(collectAdapters({ adapters: [adapter("a"), adapter("b")] }).map((a) => a.id)).toEqual(["a", "b"]);
    expect(collectAdapters({ openaiResponses: adapter("c") }).map((a) => a.id)).toEqual(["c"]);
    expect(collectAdapters({ byFamily: { openai: adapter("d") } }).map((a) => a.id)).toEqual(["d"]);
  });

  test("de-duplicates by adapter id", () => {
    const one = adapter("dup");
    expect(collectAdapters({ a: one, b: [one] })).toHaveLength(1);
  });

  test("ignores anything that is not adapter-SHAPED -- an export name is never trusted", () => {
    expect(collectAdapters({ adapters: [{ id: "x" }, null, 3, "s", { id: "y", version: "1", streamTurn: 5, validateCredential: 6 }] })).toEqual([]);
    expect(collectAdapters({})).toEqual([]);
  });
});

/**
 * Spawns the real script with a stripped environment plus `extra`, and collects everything it wrote.
 *
 * THE REFUSAL BELOW IS THE HERMETICITY GUARD FOR THE OAUTH KIND (P6.5 Lane L). Every other selector
 * this gate honours resolves through an environment variable or through nothing at all; the
 * `_CREDENTIAL_REF` selector resolves through the PRODUCTION Keychain store, which under `bun test`
 * would mean reading the developer's own login keychain — the one thing Global Constraints forbid
 * outright. `live/index.ts`'s header states the rule for a fixture ("pin BOTH the endpoint and the
 * adapter"); this makes the third rule structural rather than remembered, because a fixture that
 * pinned both and still named a credential ref would go to the Keychain anyway.
 */
async function run(extra: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  for (const name of Object.keys(extra)) {
    if (name.endsWith(CREDENTIAL_REF_SUFFIX)) {
      throw new Error(`refusing to spawn the live gate with ${name}: that selector resolves through the production Keychain store, and no test may reach it (the OAuth kind is proved by the PURE planner above, and exercised only by a local operator run)`);
    }
  }
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "verify-provider-live.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: strippedEnv(extra),
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } finally {
    proc.kill();
  }
}

describe("the script itself, spawned", () => {

  test("with no opt-in it prints ONE line and exits 0", async () => {
    const result = await run({});
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(SKIPPED_LINE);
    expect(result.stderr).toBe("");
  }, 30_000);

  test("opted in but with no provider key, it STILL skips -- a CI runner cannot go live by accident", async () => {
    const result = await run({ [OPT_IN_VAR]: "1" });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(SKIPPED_LINE);
  }, 30_000);

  test("opted in with an ambient conventional key present, it still skips", async () => {
    const result = await run({ [OPT_IN_VAR]: "1", OPENAI_API_KEY: "test-key-ambient-must-not-be-used", ANTHROPIC_API_KEY: "test-key-ambient-must-not-be-used" });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(SKIPPED_LINE);
  }, 30_000);

  test("the spawn helper REFUSES a credential-ref variable -- the OAuth kind can never be driven from `bun test`", async () => {
    // A negative-only guard passes just as happily when it is broken, so the refusal is fired rather
    // than assumed. It is also the reason the OAuth kind has no spawned fixture anywhere in this file.
    await expect(run({ [OPT_IN_VAR]: "1", [`${liveEnvPrefix("xai-oauth")}${CREDENTIAL_REF_SUFFIX}`]: "keychain:xai-oauth:acct" })).rejects.toThrow("production Keychain store");
    // ...and it does not fire on the selectors that are safe.
    await expect(run({ [OPT_IN_VAR]: "1" })).resolves.toMatchObject({ code: 0 });
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// Review round 1, I1: a provider's response body must never reach the operator's terminal.
//
// The hazard is not hypothetical and not this file's invention: `normalizeHttpError`
// (provider-runtime/src/errors.ts) puts a 200-character snippet of the provider's error BODY into
// `ProviderError.message`, and `ProviderRequestError` carries that message as a real `Error`. The
// first assertion below pins that premise against the real normalizer rather than assuming it; the
// spawned run then proves the gate never prints it.
// ---------------------------------------------------------------------------------------------
describe("a provider's response body never reaches stdout or stderr", () => {
  const MARKER = "MARKER-provider-body-must-not-be-printed-9f3a";

  test("PREMISE: the real normalizer does put the response body into the error message", () => {
    const err = normalizeHttpError(500, new Headers(), JSON.stringify({ error: { message: MARKER, code: "internal_error" } }));
    // If this ever stops being true the fixture below would pass vacuously, so it is asserted rather
    // than assumed.
    expect(err.message).toContain(MARKER);
    expect(err.providerCode).toBe("internal_error");
  });

  test("a live run whose adapter fails prints identity only -- never the body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-live-render-"));
    const fake = await startFake({
      routes: [
        {
          path: "/*",
          handler: () => errorResponse(500, { error: { message: MARKER, code: "internal_error" } }),
        },
      ],
    });
    try {
      // A self-contained adapter module: it imports NOTHING, because a file in the OS temp directory
      // cannot resolve this workspace's packages. It reproduces the exact observable shape of a
      // `ProviderRequestError` built by `normalizeHttpError` -- the shape the assertion above pins --
      // and it reaches the fake with a real fetch, so the marker in the thrown message really did
      // come off the wire.
      writeFileSync(
        join(dir, "adapters.ts"),
        `class ProviderRequestError extends Error {
  code; status; providerCode; retryable;
  constructor(fields) {
    super(fields.message);
    this.name = "ProviderRequestError";
    this.code = fields.code;
    this.status = fields.status;
    this.providerCode = fields.providerCode;
    this.retryable = fields.retryable;
  }
}
async function failFromWire(ctx) {
  const res = await fetch(ctx.connection.baseUrl);
  const body = await res.text();
  throw new ProviderRequestError({ code: "server", message: "HTTP " + res.status + " \\u2014 " + body.slice(0, 200), status: res.status, providerCode: "internal_error", retryable: true });
}
export const adapters = [
  {
    id: "winter.openai-responses",
    version: "0.0.0-fixture",
    family: "openai",
    protocol: "openai-responses",
    async validateCredential() { return { ok: true }; },
    async listModels(ctx) { return failFromWire(ctx); },
    streamTurn(_req, ctx) { return (async function* () { yield* []; await failFromWire(ctx); })(); },
    async countTokens(_req, ctx) { return failFromWire(ctx); },
    mapEffort() { return { ok: true, value: undefined }; },
    capabilities() { return { toolCalling: "native", readableState: "none" }; },
  },
];
`,
        "utf8",
      );

      const result = await run({
        [OPT_IN_VAR]: "1",
        WINTER_LIVE_OPENAI_API_KEY: "test-key-live-render",
        WINTER_LIVE_OPENAI_BASE_URL: fake.url,
        [ADAPTERS_MODULE_VAR]: join(dir, "adapters.ts"),
      });

      const everything = `${result.stdout}\n${result.stderr}`;
      // The whole point.
      expect(everything).not.toContain(MARKER);
      // ...and it is not passing because nothing ran: the adapter WAS reached, the cases DID fail,
      // and what got printed was identity.
      expect(fake.requests.length).toBeGreaterThan(0);
      expect(everything).toContain("winter.openai-responses@0.0.0-fixture");
      expect(everything).toContain("ProviderRequestError");
      expect(everything).toContain("code=server");
      expect(everything).toContain("status=500");
      expect(everything).toContain("providerCode=internal_error");
      expect(result.code).toBe(1);
      // The classifier leg's own throws collapse to a reason code, never a message.
      expect(everything).toContain("provider_error");

      // P6.5 Lane L: the per-target ROW is on this output too, and it is the line an operator reads
      // first — so it is proved on a real spawned run rather than only in the formatter's unit test.
      // Identifiers, a verdict, a duration and the identity Winter sends; the marker is already
      // excluded above, over this same string.
      expect(everything).toMatch(/live-row\s+providerId=openai\s+model=\S+\s+kind=api-key\s+ok=false\s+latencyMs=\d+\s+toolCallOk=false\s+identityHeader=/);
      expect(everything).toContain(`identityHeader=${winterUserAgent()}`);
      expect(winterUserAgent()).toMatch(/^winter-agent-sdk\//);
      // The plan's shape is announced BEFORE the run, per kind.
      expect(everything).toContain("1 target(s): 1 api-key, 0 oauth, 0 keyless");
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
