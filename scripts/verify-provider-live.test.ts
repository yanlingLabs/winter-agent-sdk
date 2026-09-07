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
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createEnvCredentialStore, createMemoryCredentialStore, CredentialResolutionError, normalizeHttpError, winterUserAgent, type CredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { anthropicConsoleOauthFake, errorResponse, startFake, xaiOauthFake } from "@yanlinglabs/winter-provider-conformance";
import {
  ADAPTERS_MODULE_VAR,
  bearerStore,
  countByKind,
  CREDENTIAL_REF_SUFFIX,
  collectAdapters,
  credentialStoreFor,
  KEYCHAIN_SERVICE_VAR,
  liveEnvPrefix,
  OPT_IN_VAR,
  planLiveRun,
  PROVIDER_LOGIN_IDS,
  runLogin,
  SKIPPED_LINE,
  type LiveTargetKind,
} from "./verify-provider-live.ts";

const CATALOG = loadCatalog();

/**
 * The dedicated Keychain service every Keychain-touching case names.
 *
 * CONTROLLER RULING (2026-09-06): the live gate has no production default — unset, it refuses every
 * Keychain path rather than reading or writing `com.winter.core`/`.dev`, which are the host's. So a
 * case that plans an OAuth target has to say where the run's material lives, exactly as an operator
 * does, and the refusal itself has its own tests below. The value is a throwaway name that no store
 * is ever actually built against here.
 */
const SERVICE = { [KEYCHAIN_SERVICE_VAR]: "com.winter.live.test" } as const;

// The round-1 tests planned two of the three kinds against a `catalogPlus()` fixture, because
// `xai-oauth`, `aihorde` and `uncloseai` did not exist yet. Lanes X2/A2/O have merged, so the
// fixture is GONE and every case below plans against the shipped 163-row catalog. Its justification
// expired with the merge, and a fixture row shadowing a real one is how three of these tests broke
// the moment X2 landed.

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
  test("an OAuth row is selected by WINTER_LIVE_<P>_CREDENTIAL_REF and never by an API-key variable", () => {
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", ...SERVICE, WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: "keychain:xai-oauth:acct" }, CATALOG);
    expect(plan.optedIn && plan.targets.map((t) => [t.providerId, t.kind])).toEqual([["xai-oauth", "oauth"]]);
    // The credential resolves through a KEYCHAIN ref — R6-10's one record per provider/account — and
    // the target reports the VARIABLE that named it, never the account.
    expect(plan.optedIn && plan.targets[0]!.authRef).toEqual({ kind: "keychain", account: "xai-oauth:acct" });
    expect(plan.optedIn && plan.targets[0]!.selectedBy).toBe("WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF");
    // ...and the second half of this test's name, which is the part with teeth: an API-key variable
    // naming an OAuth-only row selects NOTHING. Without it, an operator with a stale key variable
    // would send a bearer this vendor never issued and read the 401 as a Winter bug.
    const byKey = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_XAI_OAUTH_API_KEY: "test-key-x" }, CATALOG);
    expect(byKey.optedIn).toBe(false);
    expect(byKey.warnings?.join(" ")).toContain("WINTER_LIVE_XAI_OAUTH_API_KEY");
  });

  test("a keyless row is selected by WINTER_LIVE_<P>=1 with no key", () => {
    // RESTATED ON THE SHIPPED ROW. The brief named `aihorde`; X2 shipped `aihorde` as an `api-key`
    // row (its documented anonymous access is still a key the operator supplies), and `uncloseai`
    // — `custom`, `free`, no key at all — is the keyless one. The row's shape decides, not the name
    // in a brief; the refusal `aihorde` now gets is the test below this one.
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_UNCLOSEAI: "1" }, CATALOG);
    expect(plan.optedIn && plan.targets[0]).toMatchObject({ providerId: "uncloseai", kind: "keyless" });
    // `none` is a real `CredentialRef` arm: every store answers it with null, so "send no credential"
    // is a resolution rather than a missing one.
    expect(plan.optedIn && plan.targets[0]!.authRef).toEqual({ kind: "none" });
  });

  test("the keyless selector is `1` exactly, and it never applies to a PRICED row -- an unauthenticated request to a paid vendor is not a smaller mistake than none", () => {
    for (const value of ["", "0", "true", "yes"]) {
      expect(planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_UNCLOSEAI: value }, CATALOG).optedIn).toBe(false);
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

  test("a CREDENTIAL_REF that is not a `keychain:<account>` locator is refused rather than guessed at, and the warning NAMES the variable", () => {
    // Round-1 minor 4: this asserted only `optedIn === false`, which a run that had simply not opted
    // in would satisfy just as well. The warning is what distinguishes "refused" from "never asked".
    for (const value of ["xai-oauth:acct", "env:SOMETHING", "keychain:", "  "]) {
      const plan = planLiveRun({ [OPT_IN_VAR]: "1", ...SERVICE, WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: value }, CATALOG);
      expect(plan.optedIn).toBe(false);
      // A blank value is not a malformed ref — it is no ref at all, and nothing was named.
      if (value.trim().length > 0) expect(plan.warnings?.join(" ")).toContain("WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF");
    }
  });

  test("naming BOTH a credential ref and an API key for one provider resolves through the ref, and SAYS so -- neither variable's value is printed", () => {
    // On `anthropic`, which WS-13b §3 gives BOTH auth kinds, so both variables are legitimate and the
    // precedence rule is the only thing deciding.
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", ...SERVICE, WINTER_LIVE_ANTHROPIC_CREDENTIAL_REF: "keychain:anthropic:acct", WINTER_LIVE_ANTHROPIC_API_KEY: "test-key-x" }, CATALOG);
    expect(plan.optedIn && plan.targets.map((t) => t.kind)).toEqual(["oauth"]);
    const warning = (plan.warnings ?? []).join(" ");
    expect(warning).toContain("WINTER_LIVE_ANTHROPIC_CREDENTIAL_REF");
    expect(warning).toContain("WINTER_LIVE_ANTHROPIC_API_KEY");
    expect(warning).not.toContain("test-key-x");
    expect(warning).not.toContain("anthropic:acct");
  });

  test("a run that names a provider and selects nothing still reports SKIPPED_LINE, with the explanation on the warnings channel beside it", () => {
    // Round-1 minor 5: the old name said "the reason carries the warnings", which it does not —
    // `reason` is the unchanged constant and `warnings` is a sibling field. Both halves matter, so
    // the name now states both.
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_XAI_OAUTH_API_KEY: "test-key-x" }, CATALOG);
    expect(plan.optedIn).toBe(false);
    expect(plan.optedIn === false && plan.reason).toBe(SKIPPED_LINE);
    expect(plan.warnings ?? []).not.toEqual([]);
    // ...and a genuinely empty environment still carries NO warnings key at all, so the plain
    // not-opted-in shape is unchanged.
    expect(planLiveRun(strippedEnv(), CATALOG)).toEqual({ optedIn: false, reason: SKIPPED_LINE });
  });

  test("the three kinds are counted per kind, so a run says what it is about to do before it does it", () => {
    const plan = planLiveRun(
      { [OPT_IN_VAR]: "1", ...SERVICE, WINTER_LIVE_OPENAI_API_KEY: "test-key-x", WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: "keychain:xai-oauth:acct", WINTER_LIVE_UNCLOSEAI: "1" },
      CATALOG,
    );
    expect(plan.optedIn).toBe(true);
    if (!plan.optedIn) return;
    expect(plan.targets.map((t) => t.kind).sort()).toEqual(["api-key", "keyless", "oauth"]);
    expect(countByKind(plan.targets)).toEqual({ "api-key": 1, oauth: 1, keyless: 1 });
  });
});

// -------------------------------------------------------------------------------------------------
// Review round 1, Important #1: ONE PREDICATE PER ARM, against the rows X2/A2/O actually shipped.
//
// The round-1 gate cross-checked `authKinds` in the api-key arm only. The widened catalog made both
// remaining holes real, and both are pinned here against the real row rather than against a fixture
// that could be written to agree with the code.
// -------------------------------------------------------------------------------------------------
describe("WS-13b Important #1: each selector is cross-checked against the row's own authKinds", () => {
  test("the OAuth arm refuses a row that documents NO OAuth path -- `openai` + a credential ref would have labelled the evidence `oauth`", () => {
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", ...SERVICE, WINTER_LIVE_OPENAI_CREDENTIAL_REF: "keychain:openai:acct" }, CATALOG);
    expect(plan.optedIn).toBe(false);
    expect(plan.warnings?.join(" ")).toContain("documents no OAuth path");
    // A REFUSAL, not a relabel: quietly demoting it to `api-key` would produce a target the operator
    // never asked for and an api-key run they cannot distinguish from one they meant.
    expect(plan.warnings?.join(" ")).not.toContain("api-key target");
  });

  test("the OAuth arm ADMITS both an OAuth-only row and a dual-auth one -- `xai-oauth`, `codex-oauth` and `anthropic`", () => {
    for (const id of ["xai-oauth", "codex-oauth", "anthropic"]) {
      const plan = planLiveRun({ [OPT_IN_VAR]: "1", ...SERVICE, [`${liveEnvPrefix(id)}${CREDENTIAL_REF_SUFFIX}`]: `keychain:${id}:acct` }, CATALOG);
      expect(plan.optedIn && plan.targets.map((t) => [t.providerId, t.kind])).toEqual([[id, "oauth"]]);
    }
  });

  test("the keyless arm refuses a FREE row that documents an api key -- X2's `aihorde` is free AND keyed, and would have been sent nothing at all", () => {
    // The exact bug the review found: `pricingBasis === "free"` alone admits `aihorde`, whose
    // documented anonymous access is a value in an `apikey` header — so a keyless target would have
    // sent no credential and read the vendor's refusal as a Winter failure.
    const keyless = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_AIHORDE: "1" }, CATALOG);
    expect(keyless.optedIn).toBe(false);
    expect(keyless.warnings?.join(" ")).toContain("WINTER_LIVE_AIHORDE_API_KEY");
    // ...and the row IS reachable, by the variable that carries the vendor's own anonymous value.
    // CONSTRUCTED, not spelled (whole-branch review M-2). X2's own integrity test builds the same
    // value the same way, on the rule that "a test that spells a credential verbatim puts it in the
    // repository just as surely as the row would have" — and this file, in `scripts/`, was outside
    // the sweep that enforces it. The literal sweep now covers `scripts/` too.
    const keyed = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_AIHORDE_API_KEY: "0".repeat(10) }, CATALOG);
    expect(keyed.optedIn && keyed.targets.map((t) => [t.providerId, t.kind])).toEqual([["aihorde", "api-key"]]);
  });

  test("the keyless arm's two halves are INDEPENDENT: `xai-oauth` is refused on price, `aihorde` on auth", () => {
    // Dropping the money half because the auth half exists would admit `WINTER_LIVE_XAI_OAUTH=1` —
    // subscription-priced, `oauth-approved`, no api-key kind — and fire an unauthenticated request at
    // a subscription endpoint. Two reasons, reported as two different mistakes.
    expect(planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_XAI_OAUTH: "1" }, CATALOG).warnings?.join(" ")).toContain('pricingBasis is "subscription"');
    expect(planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_AIHORDE: "1" }, CATALOG).warnings?.join(" ")).toContain("documents an API key");
  });

  test("the WIDENED catalog sweep: every one of its rows is reachable, and no row is admitted by a selector its own authKinds contradict", () => {
    // 163 rows, each planned all three ways. Stated as PROPERTIES rather than as a restatement of the
    // three predicates, because a table computed from the same rules the code applies would agree
    // with any rule at all. Each property below is a statement about credentials that would still be
    // true if the predicates were written differently.
    const violations: string[] = [];
    const admittedCount: Record<LiveTargetKind, number> = { "api-key": 0, oauth: 0, keyless: 0 };
    const modelled = new Set(CATALOG.models.map((m) => m.providerId));
    for (const provider of CATALOG.providers) {
      const prefix = liveEnvPrefix(provider.id);
      const where = `${provider.id} (authKinds=${provider.authKinds.join(",")}, ${provider.pricingBasis})`;
      // 62 of X2's 163 rows carry no model row of their own (the extractor could read the provider
      // and not its model list), and those are reachable only with a `_MODEL` override. That is a
      // fact about the CATALOG, tested on its own below; supplying the override here keeps this
      // sweep about the SELECTOR, which is what it is for.
      const model = modelled.has(provider.id) ? {} : { [`${prefix}_MODEL`]: "probe-model" };
      const admits: Record<LiveTargetKind, boolean> = {
        "api-key": planLiveRun({ [OPT_IN_VAR]: "1", ...model, [`${prefix}_API_KEY`]: "test-key-x" }, CATALOG).optedIn,
        oauth: planLiveRun({ [OPT_IN_VAR]: "1", ...SERVICE, ...model, [`${prefix}${CREDENTIAL_REF_SUFFIX}`]: `keychain:${provider.id}:acct` }, CATALOG).optedIn,
        keyless: planLiveRun({ [OPT_IN_VAR]: "1", ...model, [prefix]: "1" }, CATALOG).optedIn,
      };
      // M-3's selector rides the SAME predicate as `_API_KEY` and must therefore admit exactly the
      // same rows: it is the same credential in the other header, not a second admission basis. A
      // bearer target that reached a row `_API_KEY` cannot would be a new path through the gate.
      const bearerPlan = planLiveRun({ [OPT_IN_VAR]: "1", ...model, [`${prefix}_BEARER`]: "test-key-x" }, CATALOG);
      if (bearerPlan.optedIn !== admits["api-key"]) violations.push(`${where}: _BEARER and _API_KEY disagree on admission`);
      if (bearerPlan.optedIn && bearerPlan.targets[0]?.authStyle !== "bearer") violations.push(`${where}: _BEARER admitted without the bearer auth style`);
      if (bearerPlan.optedIn && bearerPlan.targets[0]?.kind !== "api-key") violations.push(`${where}: _BEARER produced kind ${String(bearerPlan.targets[0]?.kind)}, not api-key`);
      for (const kind of ["api-key", "oauth", "keyless"] as const) if (admits[kind]) admittedCount[kind] += 1;

      // (1) A row nothing can select is a row the live gate can never promote out of `candidate`.
      if (!admits["api-key"] && !admits.oauth && !admits.keyless) violations.push(`${where}: no selector reaches it`);
      // (2) A credential and NO credential are not both right for one row.
      if (admits.oauth && admits.keyless) violations.push(`${where}: admitted as both oauth and keyless`);
      // (3) A row that documents a key is never asked WITHOUT one — X2's `aihorde` is the case.
      if (provider.authKinds.includes("api-key") && admits.keyless) violations.push(`${where}: documents an api key yet is admitted keyless`);
      // (4) A row whose only documented path is OAuth issues no keys, so a key target could only 401.
      if (provider.authKinds.includes("oauth-approved") && !provider.authKinds.includes("api-key") && admits["api-key"]) violations.push(`${where}: OAuth-only yet admitted api-key`);
      // (5) Money: a row that is not free is never reached without a credential.
      if (provider.pricingBasis !== "free" && admits.keyless) violations.push(`${where}: priced yet admitted keyless`);
      // (6) A ref is evidence about an OAuth path; a row with none must not produce `kind: "oauth"`.
      if (!provider.authKinds.includes("oauth-approved") && admits.oauth) violations.push(`${where}: documents no OAuth path yet is admitted oauth`);
    }
    expect(violations).toEqual([]);
    expect(CATALOG.providers.length).toBeGreaterThan(150);
    // Not a bound to satisfy — a printed fact for the run's report, and proof the sweep saw all three.
    for (const kind of ["api-key", "oauth", "keyless"] as const) expect(admittedCount[kind]).toBeGreaterThan(0);
    console.log(`  live-gate sweep: ${CATALOG.providers.length} rows -- admitted as api-key ${admittedCount["api-key"]}, oauth ${admittedCount.oauth}, keyless ${admittedCount.keyless}`);
  });

  test("M-3: `WINTER_LIVE_<P>_BEARER` reaches an Anthropic-dialect sibling as an api-key target with the bearer auth style", () => {
    // The live condition the gate could not vary. `deepseek-anthropic` and its three siblings carry
    // `authKinds: ["api-key"]`, so `messages.ts` sends `x-api-key` -- but what their citations
    // establish is that the vendor's own page targets Claude Code, whose auth-token mode sends
    // `Authorization: Bearer`. Whether these endpoints ALSO accept `x-api-key` is unverified, and a
    // vendor that accepts only the bearer form produced a 401 that reads "bad key".
    //
    // The KIND stays `api-key`, deliberately: the kind is the documented PATH the credential came
    // down, which is what this gate's evidence is about. Only the presentation differs.
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_DEEPSEEK_ANTHROPIC_BEARER: "test-key-x" }, CATALOG);
    expect(plan.optedIn && plan.targets.map((t) => [t.providerId, t.kind, t.authStyle, t.selectedBy])).toEqual([
      ["deepseek-anthropic", "api-key", "bearer", "WINTER_LIVE_DEEPSEEK_ANTHROPIC_BEARER"],
    ]);
  });

  test("M-3: the bearer form WINS over `_API_KEY` and says so -- an operator sets it after a 401 on the default form", () => {
    // Preferring the variable that just failed would reproduce the failure and read as "the retry
    // did nothing", which is the worst outcome for a diagnostic selector.
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_DEEPSEEK_ANTHROPIC_API_KEY: "test-key-x", WINTER_LIVE_DEEPSEEK_ANTHROPIC_BEARER: "test-key-x" }, CATALOG);
    expect(plan.optedIn && plan.targets.map((t) => [t.selectedBy, t.authStyle])).toEqual([["WINTER_LIVE_DEEPSEEK_ANTHROPIC_BEARER", "bearer"]]);
    expect(plan.warnings?.join(" ")).toContain("the bearer form wins");
  });

  test("M-3: `bearerStore` re-presents the env store's api-key material as bearer, and changes nothing else", async () => {
    // The other half of the selector. Without this the plan would say `authStyle: "bearer"` and the
    // request would still carry `x-api-key`, which is the failure the whole item exists to fix.
    const ref = { kind: "env", name: "WINTER_LIVE_FIXTURE_BEARER" } as const;
    const inner = createEnvCredentialStore({ env: { WINTER_LIVE_FIXTURE_BEARER: "test-key-x" } });
    expect(await inner.get(ref)).toEqual({ kind: "api-key", key: "test-key-x" });
    expect(await bearerStore(inner).get(ref)).toEqual({ kind: "bearer", token: "test-key-x" });
    // A missing value stays missing rather than becoming an empty bearer -- an exported-but-empty
    // variable must still produce the actionable "no credential configured", not an opaque 401.
    expect(await bearerStore(createEnvCredentialStore({ env: {} })).get(ref)).toBeNull();
    // Still read-only: the wrapper must not become a write path into the operator's environment.
    // (`set` is keychain-only BY TYPE, so the ref is cast — the point is that the refusal survives
    // the wrapper, not that this call is representable.)
    await expect(bearerStore(inner).set({ kind: "keychain", account: "unused" }, { kind: "api-key", key: "x" })).rejects.toThrow();
  });

  test("M-3: an OAuth-only row refuses `_BEARER` exactly as it refuses `_API_KEY` -- the selector is not a way around the predicate", () => {
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_XAI_OAUTH_BEARER: "test-key-x" }, CATALOG);
    expect(plan.optedIn).toBe(false);
    expect(plan.warnings?.join(" ")).toContain("WINTER_LIVE_XAI_OAUTH_BEARER");
    expect(plan.warnings?.join(" ")).toContain("whose documented path is OAuth and not an API key");
  });

  test("a row with NO model row of its own is not silently dropped: it warns, names the `_MODEL` variable, and is reachable once that is set", () => {
    // 62 of the 163 widened rows are in this state — the extractor read the provider and not its
    // model list — and a live gate that dropped them in silence would look identical to one that had
    // never been given a key. Found by the sweep above; pinned here by name.
    const modelled = new Set(CATALOG.models.map((m) => m.providerId));
    const modelless = CATALOG.providers.filter((p) => !modelled.has(p.id));
    expect(modelless.length).toBeGreaterThan(0);
    const id = modelless[0]!.id;
    const prefix = liveEnvPrefix(id);
    const dropped = planLiveRun({ [OPT_IN_VAR]: "1", [`${prefix}_API_KEY`]: "test-key-x" }, CATALOG);
    expect(dropped.optedIn).toBe(false);
    expect(dropped.warnings?.join(" ")).toContain(`${prefix}_MODEL`);
    const reachable = planLiveRun({ [OPT_IN_VAR]: "1", [`${prefix}_API_KEY`]: "test-key-x", [`${prefix}_MODEL`]: "probe-model" }, CATALOG);
    expect(reachable.optedIn && reachable.targets.map((t) => [t.providerId, t.model])).toEqual([[id, "probe-model"]]);
  });

  test("a `free` row that documents NO key is reachable BOTH ways -- keyless is an addition to the dummy-key path, not a replacement", () => {
    // Property (2) above allows this pair deliberately: `ollama-local` is `local-none` + `free`, so a
    // keyless target is the honest shape AND the P6 `_API_KEY=anything` invocation still works. The
    // sweep would hide the fact inside a "no violations" result, so it is stated once, by name.
    expect(planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_OLLAMA_LOCAL: "1" }, CATALOG).optedIn).toBe(true);
    expect(planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_OLLAMA_LOCAL_API_KEY: "unused" }, CATALOG).optedIn).toBe(true);
  });
});

describe("WS-13b: the keychain SERVICE door (the close-out live run's throwaway service)", () => {
  test("`keychain:<service>/<account>` carries the service on the ref; `keychain:<account>` leaves it to the store", () => {
    const withService = planLiveRun({ [OPT_IN_VAR]: "1", ...SERVICE, WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: "keychain:com.winter.live.20260906/xai-oauth:acct" }, CATALOG);
    expect(withService.optedIn && withService.targets[0]!.authRef).toEqual({ kind: "keychain", account: "xai-oauth:acct", service: "com.winter.live.20260906" });
    const withoutService = planLiveRun({ [OPT_IN_VAR]: "1", ...SERVICE, WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: "keychain:xai-oauth:acct" }, CATALOG);
    expect(withoutService.optedIn && withoutService.targets[0]!.authRef).toEqual({ kind: "keychain", account: "xai-oauth:acct" });
  });

  test("an account containing a SLASH is not mistaken for a service -- account ids are frequently URL-shaped", () => {
    // The disambiguation rule is decidable rather than heuristic: the text before the first `/` is a
    // service only when it contains NO colon. An account always contains one (`<providerId>:<id>`,
    // and R6-10 forbids a colon in the provider id); a reverse-DNS service never does.
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", ...SERVICE, WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: "keychain:xai-oauth:https://id.example/u/1" }, CATALOG);
    expect(plan.optedIn && plan.targets[0]!.authRef).toEqual({ kind: "keychain", account: "xai-oauth:https://id.example/u/1" });
  });

  test("a service form missing either half is refused, not half-parsed", () => {
    for (const value of ["keychain:com.winter.live/", "keychain:/xai-oauth:acct"]) {
      expect(planLiveRun({ [OPT_IN_VAR]: "1", ...SERVICE, WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: value }, CATALOG).optedIn).toBe(false);
    }
  });

  test(`${KEYCHAIN_SERVICE_VAR} admits the run to the Keychain, and a ref that names its own service still wins for the record it addresses`, () => {
    const plan = planLiveRun(
      { [OPT_IN_VAR]: "1", [KEYCHAIN_SERVICE_VAR]: "com.winter.live.20260906", WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: "keychain:com.winter.live.other/xai-oauth:acct" },
      CATALOG,
    );
    expect(plan.optedIn && plan.targets[0]!.authRef).toEqual({ kind: "keychain", account: "xai-oauth:acct", service: "com.winter.live.other" });
  });
});

// -------------------------------------------------------------------------------------------------
// CONTROLLER RULING (2026-09-06): the live gate never reads or writes the HOST's Keychain services.
//
// `com.winter.core` and `com.winter.core.dev` hold a user's daily-driver records. This gate's
// material belongs in a dedicated service created for the run and deleted after it, so
// `WINTER_LIVE_KEYCHAIN_SERVICE` is REQUIRED rather than defaulted — for an OAuth target's read as
// much as for a `--login` write. Unset, every Keychain path refuses BEFORE a store is constructed.
// -------------------------------------------------------------------------------------------------
describe("WS-13b: no Keychain path at all without a named service", () => {
  test("UNSET: the refusal happens BEFORE any store is constructed -- the store factory is never called, and the message names the variable and the reason", () => {
    // A spy factory rather than a negative on behaviour: "no store was built" is the claim, so the
    // construction itself is what has to be observed. The default parameter is the production
    // constructor, so a regression that dropped the check would reach the real Keychain here.
    const built: string[] = [];
    const spy = (service: string): CredentialStore => {
      built.push(service);
      return createMemoryCredentialStore();
    };
    expect(() => credentialStoreFor("oauth", {}, spy)).toThrow(CredentialResolutionError);
    expect(built).toEqual([]);
    try {
      credentialStoreFor("oauth", {}, spy);
    } catch (err) {
      expect((err as Error).message).toContain(KEYCHAIN_SERVICE_VAR);
      // The REASON, not only the variable: an operator has to know why the obvious default is refused.
      expect((err as Error).message).toContain("com.winter.core");
      expect((err as Error).message).toContain("the host's own records");
    }
    // A blank value is not a named service either.
    expect(() => credentialStoreFor("oauth", { [KEYCHAIN_SERVICE_VAR]: "   " }, spy)).toThrow(CredentialResolutionError);
    expect(built).toEqual([]);
  });

  test("SET: the store is built with THAT service, and the api-key and keyless kinds never build one at all", () => {
    const built: string[] = [];
    const spy = (service: string): CredentialStore => {
      built.push(service);
      return createMemoryCredentialStore();
    };
    credentialStoreFor("oauth", { [KEYCHAIN_SERVICE_VAR]: "com.winter.live.20260906" }, spy);
    expect(built).toEqual(["com.winter.live.20260906"]);
    // The other two kinds are unaffected by the variable in either direction: they have no Keychain
    // path to gate, which is what makes "an api-key target cannot reach the Keychain" structural.
    credentialStoreFor("api-key", {}, spy);
    credentialStoreFor("keyless", {}, spy);
    credentialStoreFor("api-key", { [KEYCHAIN_SERVICE_VAR]: "com.winter.live.20260906" }, spy);
    expect(built).toEqual(["com.winter.live.20260906"]);
  });

  test("an OAuth target is refused at PLAN time too, so the run says so before it starts rather than part-way through", () => {
    const plan = planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF: "keychain:xai-oauth:acct" }, CATALOG);
    expect(plan.optedIn).toBe(false);
    expect(plan.warnings?.join(" ")).toContain(KEYCHAIN_SERVICE_VAR);
    expect(plan.warnings?.join(" ")).toContain("WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF");
    // ...and the api-key and keyless kinds are untouched by the rule.
    expect(planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_OPENAI_API_KEY: "test-key-x" }, CATALOG).optedIn).toBe(true);
    expect(planLiveRun({ [OPT_IN_VAR]: "1", WINTER_LIVE_UNCLOSEAI: "1" }, CATALOG).optedIn).toBe(true);
  });

  test("`--login` refuses with no service EVEN when a store is injected -- the rule is the gate's policy about where its material lives, not a property of the store object", () => {
    const lines: string[] = [];
    let openUrlCalls = 0;
    const io = {
      openUrl: async () => {
        openUrlCalls += 1;
      },
      log: (line: string) => void lines.push(line),
      store: createMemoryCredentialStore(),
    };
    // A fixture that injected a memory store would otherwise be exempt from the very rule it is meant
    // to demonstrate, and the production path (no `io.store`) would be the only one carrying it.
    return runLogin("anthropic", { [OPT_IN_VAR]: "1" }, io).then((ok) => {
      expect(ok).toBe(false);
      expect(openUrlCalls).toBe(0);
      expect(lines.join("\n")).toContain(KEYCHAIN_SERVICE_VAR);
    });
  });
});

// -------------------------------------------------------------------------------------------------
// `--login <providerId>` — how an OAuth credential gets IN.
//
// IN-PROCESS against the loopback OAuth fakes with a MEMORY store, which is what keeps it hermetic:
// no spawn, no Keychain, no vendor. It is the same shape `runtime/src/provider/credential-api.test.ts`
// uses to drive `startProviderLogin`, deliberately — a second idiom for driving these fakes is a
// second thing to keep right.
// -------------------------------------------------------------------------------------------------
describe("WS-13b: the `--login` door", () => {
  function collect(): { log: (line: string) => void; lines: string[] } {
    const lines: string[] = [];
    return { log: (line) => void lines.push(line), lines };
  }

  test("`anthropic` runs the Console PKCE login against the fake and prints the exact CREDENTIAL_REF to export", async () => {
    const fake = await anthropicConsoleOauthFake.startAnthropicConsoleOauthFake();
    const io = collect();
    try {
      const store = createMemoryCredentialStore();
      const ok = await runLogin(
        "anthropic",
        { [OPT_IN_VAR]: "1", [KEYCHAIN_SERVICE_VAR]: "com.winter.live.test" },
        { openUrl: (url) => fake.completeAuthorization(url), log: io.log, store, overrides: { authorizeUrl: fake.authorizeUrl, tokenUrl: fake.tokenUrl, profileUrl: fake.profileUrl, callbackPort: 0 } },
      );
      expect(ok).toBe(true);
      const printed = io.lines.join("\n");
      // The line an operator copies. It names the SERVICE the run stored into, which is the whole
      // point of the door: the close-out run uses a throwaway service, not `com.winter.core`.
      expect(printed).toContain(`export WINTER_LIVE_ANTHROPIC_CREDENTIAL_REF='keychain:com.winter.live.test/anthropic:${anthropicConsoleOauthFake.FAKE_CONSOLE_ACCOUNT_ID}'`);
      // ...and it is not passing because nothing happened: the fake WAS reached and the record IS there.
      expect((await store.get({ kind: "keychain", account: `anthropic:${anthropicConsoleOauthFake.FAKE_CONSOLE_ACCOUNT_ID}`, service: "com.winter.live.test" }))?.kind).toBe("oauth");
    } finally {
      await fake.close();
    }
  }, 20_000);

  test("`xai-oauth` runs the DEVICE flow: the verification URL and user code arrive on the progress channel, never through openUrl", async () => {
    const fake = await xaiOauthFake.startXaiOauthFake();
    const io = collect();
    let openUrlCalls = 0;
    try {
      const store = createMemoryCredentialStore();
      const ok = await runLogin(
        "xai-oauth",
        { [OPT_IN_VAR]: "1", ...SERVICE },
        {
          openUrl: async () => {
            openUrlCalls += 1;
          },
          log: io.log,
          store,
          overrides: { deviceCodeUrl: fake.deviceCodeUrl, tokenUrl: fake.tokenUrl, pollIntervalMs: 1 },
        },
      );
      expect(ok).toBe(true);
      // RFC 8628 has no browser leg. A host that rendered this login by waiting for `openUrl` would
      // wait forever while the two strings the user needs went past on the other channel.
      expect(openUrlCalls).toBe(0);
      const printed = io.lines.join("\n");
      // The fake's own user code and verification URL (`xai-oauth.testing.ts`'s device response). It
      // exports no constant for either, so they are spelled here — and both are asserted, because a
      // flow that reported only one of them would leave the user unable to complete the login.
      expect(printed).toContain("WXYZ-1234");
      expect(printed).toContain("https://example.invalid/activate");
      // SERVICE-QUALIFIED, always: the run named its service, so the ref it hands back names it too.
      // A bare `keychain:<account>` would resolve against whatever the next run happened to set.
      expect(printed).toContain("export WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF='keychain:com.winter.live.test/xai-oauth:");
    } finally {
      await fake.close();
    }
  }, 20_000);

  test("`qoder` answers with its TYPED refusal rather than opening anything -- the exclusion is the end state, not a stub", async () => {
    const io = collect();
    let openUrlCalls = 0;
    const ok = await runLogin(
      "qoder",
      { [OPT_IN_VAR]: "1", ...SERVICE },
      {
        openUrl: async () => {
          openUrlCalls += 1;
        },
        log: io.log,
        store: createMemoryCredentialStore(),
      },
    );
    expect(ok).toBe(false);
    expect(openUrlCalls).toBe(0);
    expect(io.lines.join("\n")).toContain("not wired in this build");
  });

  test("a provider with no login flow, and a login without the opt-in, both refuse before anything runs", async () => {
    const notALogin = collect();
    expect(await runLogin("openai", { [OPT_IN_VAR]: "1", ...SERVICE }, { openUrl: async () => {}, log: notALogin.log, store: createMemoryCredentialStore() })).toBe(false);
    expect(notALogin.lines.join("\n")).toContain(PROVIDER_LOGIN_IDS.join(", "));

    const notOptedIn = collect();
    // A login is a vendor network call, so it sits behind the same opt-in as everything else here.
    expect(await runLogin("anthropic", { ...SERVICE }, { openUrl: async () => {}, log: notOptedIn.log, store: createMemoryCredentialStore() })).toBe(false);
    expect(notOptedIn.lines.join("\n")).toContain("not opted in");
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
async function run(extra: Record<string, string>, args: readonly string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  for (const name of Object.keys(extra)) {
    if (name.endsWith(CREDENTIAL_REF_SUFFIX)) {
      throw new Error(`refusing to spawn the live gate with ${name}: that selector resolves through the production Keychain store, and no test may reach it (the OAuth kind is proved by the PURE planner above, and exercised only by a local operator run)`);
    }
  }
  // `--login` is the SECOND door onto the Keychain, and a spawned child would build the real store
  // from `WINTER_LIVE_KEYCHAIN_SERVICE` or the production default. The login tests drive `runLogin`
  // in-process against the loopback fakes with a memory store instead.
  if (args.includes("--login")) {
    throw new Error("refusing to spawn the live gate with --login: it builds the production Keychain store, and no test may reach it (the login door is proved in-process against the OAuth fakes)");
  }
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "verify-provider-live.ts"), ...args], {
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

  test("the spawn helper REFUSES `--login` too -- it is the second door onto the Keychain", async () => {
    await expect(run({ [OPT_IN_VAR]: "1" }, ["--login", "anthropic"])).rejects.toThrow("--login");
  }, 30_000);

  test("opted in with every named provider REFUSED, it exits 1 -- an operator who set a variable did not run an idle gate", async () => {
    // Round-1 minor 6. `codex-oauth` documents no API key, so this names a provider and selects
    // nothing; exiting 0 would be the same answer an untouched environment gets, which is the one
    // reading that is wrong.
    const result = await run({ [OPT_IN_VAR]: "1", WINTER_LIVE_CODEX_OAUTH_API_KEY: "test-key-x" });
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe(SKIPPED_LINE);
    expect(result.stderr).toContain("WINTER_LIVE_CODEX_OAUTH_API_KEY");
    expect(result.stderr).not.toContain("test-key-x");
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
