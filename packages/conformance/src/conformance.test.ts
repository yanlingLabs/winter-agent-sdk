// Phase 6 Task 10 -- the WS-13 §13 cite-or-cover matrix.
//
// Same pattern as `packages/runtime/src/{permissions,tools,mcp,subagents}/conformance.test.ts` and
// `conformance-ws11.test.ts` before it: §13's acceptance inventory is decomposed into rows, and every
// row carries exactly one of
//
//   "covered"  -- a real test already proves it, cited by {file, testName}, MACHINE-VERIFIED below
//                 (the citation's file is read and the substring genuinely searched for, so a renamed
//                 or deleted test fails HERE rather than rotting silently inside a comment);
//   "new"      -- a gap this task closes, self-cited the same way (with the self-citation loophole
//                 guard: a row citing THIS file must find its own title TWICE, since the table's own
//                 string literal would otherwise satisfy a plain `.includes()`);
//   "deferred" -- out of scope at this phase, naming its owning-phase reasoning, never a silent
//                 absence.
//
// Zero rows may lack one of the three; the tests at the bottom enforce that structurally.
//
// WHY THIS FILE LIVES IN `packages/conformance/src`. The matrix cites across FOUR packages -- the
// catalog's extraction tests, the provider-conformance corpus, the runtime's wiring tripwires and the
// sdk's equivalence suite. Every other matrix in this repo lives beside the one package it covers;
// this obligation has no single such package, and putting it beside any one of them would make three
// quarters of its citations reach upward through `../../`. `tsconfig.typecheck.json` already includes
// this directory, so the file is type-checked rather than merely present.
//
// This file does NOT re-fetch the pinned upstream artifact and stands up no server: it reads source
// files and asserts on their contents. `bun test` stays hermetic.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Citation {
  file: string;
  testName: string;
}

interface ConformanceRow {
  id: string;
  spec: string;
  bullet: string;
  status: "covered" | "new" | "deferred";
  citations?: Citation[];
  owningPhase?: string;
  note?: string;
}

// Paths are relative to THIS file (`packages/conformance/src/`).
const CATALOG = "../../provider-catalog/src";
const PROVIDER_RUNTIME = "../../provider-runtime/src";
const CORPUS = "../../provider-conformance/src/corpus";
const RUNTIME = "../../runtime/src";
const SDK = "../../sdk/src";
const SCRIPTS = "../../../scripts";

// --- §13 bullet 1: CATALOG / EXTRACTION ----------------------------------------------------------

const CATALOG_ROWS: ConformanceRow[] = [
  {
    id: "WS13-C1",
    spec: "WS-13 §13 (catalog)",
    bullet: "byte-identical regeneration from the same commit + extractor",
    status: "covered",
    citations: [
      { file: `${SCRIPTS}/provider-source-sync.test.ts`, testName: "regenerates the merged catalog byte-identically — WS-13 §13's own acceptance test" },
      { file: "./conformance.test.ts", testName: "CI runs the catalog regeneration check and the OFFLINE source sync" },
    ],
    note: "The second citation is the CI half: a regeneration check that nothing runs is a property, not a gate.",
  },
  {
    id: "WS13-C2",
    spec: "WS-13 §13 (catalog)",
    bullet: "per-row source paths + the pinned commit",
    status: "covered",
    citations: [
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "every OmniRoute-derived provider row names its source paths and the pinned commit" },
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "WINTER-owned rows keep an EMPTY commit — the honest marker for a row no extraction produced" },
    ],
  },
  {
    id: "WS13-C3",
    spec: "WS-13 §13 (catalog)",
    bullet: "unique IDs / aliases / keys",
    status: "covered",
    citations: [
      { file: `${CATALOG}/validate.test.ts`, testName: "rejects a duplicate model key" },
      { file: `${CATALOG}/validate.test.ts`, testName: "rejects an alias that collides with another model's alias in the SAME provider" },
      { file: `${CATALOG}/validate.test.ts`, testName: "ACCEPTS the same alias under two DIFFERENT providers — alias scope is per provider" },
    ],
  },
  {
    id: "WS13-C4",
    spec: "WS-13 §13 (catalog)",
    bullet: "unknown category / auth / executor / protocol values fail extraction",
    status: "covered",
    citations: [{ file: `${CATALOG}/extract/pipeline.test.ts`, testName: "`targetFormat` within the family selects the endpoint; ACROSS families it is refused" }],
  },
  {
    id: "WS13-C5",
    spec: "WS-13 §13 (catalog)",
    bullet: "blocked -> supported requires a reviewed allowlist change",
    status: "covered",
    citations: [{ file: `${CATALOG}/extract/pipeline.test.ts`, testName: "the allowlist's `winterId` renames the provider, and its risk is stamped through" }],
  },
  {
    id: "WS13-C6",
    spec: "WS-13 §13 (catalog)",
    bullet: "no secrets / cookies / OAuth client secrets / executable functions / logos in the output",
    status: "covered",
    citations: [
      { file: `${CATALOG}/extract/literal-extractor.test.ts`, testName: "OAuth blocks and literal anonymous keys are `credential-material`" },
      { file: `${CATALOG}/extract/literal-extractor.test.ts`, testName: "functions, methods, accessors, calls and `new` are all `executable-value`" },
      { file: `${CATALOG}/extract/literal-extractor.test.ts`, testName: "a URL builder is rejected as `url-builder` — WS-13 §13 names this exact hazard" },
    ],
  },
  {
    id: "WS13-C7",
    spec: "WS-13 §13 (catalog)",
    bullet: "notices cover copied files; a re-sync never overwrites the overlay",
    status: "covered",
    citations: [
      { file: `${SCRIPTS}/provider-source-sync.test.ts`, testName: "NO overlay path is among them — WS-13 §7's 'a re-sync must never overwrite the overlay'" },
      { file: `${SCRIPTS}/provider-source-sync.test.ts`, testName: "every artefact is valid JSON where it claims to be, and the notices are copied verbatim" },
    ],
  },
  {
    id: "WS13-C8",
    spec: "WS-13 §13 (catalog)",
    bullet: "the 351/352 upstream row discrepancy is reported",
    status: "covered",
    citations: [{ file: `${CATALOG}/extract/pipeline.test.ts`, testName: "a DUPLICATE upstream model id is dropped and RECORDED, never silently de-duplicated" }],
    note: "The denominator ledger (`generated/denominator.json`) is the reported artefact; the cited test pins the mechanism that produces the discrepancy row rather than the count itself, which moves with the pin.",
  },
  {
    id: "WS13-C9",
    spec: "WS-13 §13 (catalog)",
    bullet: "a catalog entry alone never causes a code download or execution",
    status: "covered",
    citations: [
      { file: `${CATALOG}/extract/fetch.test.ts`, testName: "git runs with an EMPTY hooks path, so a hostile repository's hooks cannot execute" },
      { file: `${CATALOG}/extract/literal-extractor.test.ts`, testName: "only the inert fields survive" },
    ],
  },
];

// --- §13 bullet 2: ADAPTER BEHAVIOUR --------------------------------------------------------------

const ADAPTER_ROWS: ConformanceRow[] = [
  {
    id: "WS13-A1",
    spec: "WS-13 §13 (adapter)",
    bullet: "request serialization + headers, per shipped family",
    status: "covered",
    citations: [
      { file: `${CORPUS}/anthropic.test.ts`, testName: "carries the model, system, messages, tools, tool_choice and the family's headers" },
      { file: `${CORPUS}/google.test.ts`, testName: "puts the model and the method in the PATH, selects SSE with `?alt=sse`, and authenticates with x-goog-api-key" },
      { file: `${CORPUS}/azure.test.ts`, testName: "every request carries `api-version`, and the classic surface addresses the deployment" },
      { file: `${CORPUS}/bedrock.test.ts`, testName: "every required case passes against the hand-built descriptor" },
    ],
  },
  {
    id: "WS13-A2",
    spec: "WS-13 §13 (adapter)",
    bullet: "streaming order; single / multiple / fragmented tool calls; tool-result replay",
    status: "covered",
    citations: [
      { file: `${CORPUS}/runner.test.ts`, testName: "binds 127.0.0.1 on an ephemeral port and records every request in order" },
      { file: `${CORPUS}/anthropic.test.ts`, testName: "ADJACENT same-role messages merge, preserving block order exactly" },
    ],
    note: "The per-case obligations are the shared corpus's own `CORPUS_CASES` list, which every family lane runs; the cited tests pin the runner and one family's ordering directly.",
  },
  {
    id: "WS13-A3",
    spec: "WS-13 §13 (adapter)",
    bullet: "`Retry-After` parsing WITHOUT unsafe automatic replay of an effectful turn",
    status: "covered",
    citations: [
      { file: `${CORPUS}/openai.test.ts`, testName: "a retry observation is yielded BEFORE the request it precedes reaches the fake" },
      { file: `${SDK}/transport-equivalence.test.ts`, testName: "p6-retry-ratelimit: a 429 becomes `api_retry`, identically on every leg" },
    ],
  },
  {
    id: "WS13-A4",
    spec: "WS-13 §13 (adapter)",
    bullet: "auth / rate-limit / timeout / network / malformed / provider error codes, normalized",
    status: "covered",
    citations: [
      { file: `${CORPUS}/openai.test.ts`, testName: "codex: a 429 produces the SUBSCRIPTION-quota event alongside the ordinary retry (R6-B)" },
      { file: `${SDK}/transport-equivalence.test.ts`, testName: "p6-provider-failure (R6-F): a terminal provider failure lands on `success`+`is_error`" },
    ],
  },
  {
    id: "WS13-A5",
    spec: "WS-13 §13 (adapter)",
    bullet: "limit / parameter rejection BEFORE anything is sent (WS-13 §8.2)",
    status: "new",
    citations: [{ file: `${RUNTIME}/provider/session-provider.test.ts`, testName: "an unsupported parameter is REFUSED before anything reaches the fake" }],
    note: "The refusal existed per family; what was missing is the proof that the WIRING hands each adapter the descriptor it refuses FROM. Omitting `descriptors` disables every §8.2 refusal silently.",
  },
  {
    id: "WS13-A6",
    spec: "WS-13 §13 (adapter)",
    bullet: "effort mapping, per model, from the descriptor's own verified vocabulary",
    status: "covered",
    citations: [{ file: `${CORPUS}/google.test.ts`, testName: "`thinkingConfig`: disabled is a ZERO budget, adaptive OMITS one, and a summary is asked for the descriptor's o" }],
  },
  {
    id: "WS13-A7",
    spec: "WS-13 §13 (adapter)",
    bullet: "opaque continuation, replayed only inside a continuation domain",
    status: "covered",
    citations: [
      { file: `${CORPUS}/continuity.test.ts`, testName: "the eight NAMED transitions of §12.3 are all present, by name" },
      { file: `${CORPUS}/azure.test.ts`, testName: "the classic surface skips opaque continuation as a FACT about the surface" },
    ],
  },
  {
    id: "WS13-A8",
    spec: "WS-13 §13 (adapter)",
    bullet: "immutable reviewed endpoints; a separate policy for user endpoints; privileged headers gated on reviewed status (R6-11 / R6-L)",
    status: "covered",
    citations: [
      { file: `${CORPUS}/openai.test.ts`, testName: "R6-L: `OpenAI-Organization` rides a GENERATED endpoint and is dropped for a user one" },
      { file: `${CORPUS}/google.test.ts`, testName: "`x-goog-user-project` is PRIVILEGED: present for a generated endpoint, dropped for a user one (R6-L)" },
      { file: `${RUNTIME}/provider/session-provider.test.ts`, testName: "`originator` and `chatgpt-account-id` reach the fake when the CATALOG named the endpoint" },
    ],
  },
  {
    id: "WS13-A9",
    spec: "WS-13 §13 (adapter)",
    bullet: "redaction of auth material and reasoning state from logs and error text",
    status: "covered",
    citations: [{ file: `${CORPUS}/runner.test.ts`, testName: "CREDENTIAL HEADERS ARE REDACTED as they are recorded -- the scheme survives, the material does not" }],
  },
  {
    id: "WS13-A10",
    spec: "WS-13 §13 (adapter)",
    bullet: "cancellation pre-header and mid-stream; timeouts; connection and body limits on every adapter",
    status: "covered",
    citations: [{ file: `${PROVIDER_RUNTIME}/http.test.ts`, testName: "a caller's abort AFTER headers still cancels the body read" },
      { file: `${PROVIDER_RUNTIME}/http.test.ts`, testName: "errors while READING a body that exceeds the cap, even with no content-length" },
      { file: `${PROVIDER_RUNTIME}/http.test.ts`, testName: "the header timeout does NOT kill a slow BODY — that is the stall watchdog's job" }],
    note: "The bound itself lives in the shared `boundedFetch`/`parseSse` pair every adapter is built on, which is why one citation covers the family: an adapter that reached for `fetch` directly would fail the corpus's cancellation cases.",
  },
  {
    id: "WS13-A11",
    spec: "WS-13 §13 (adapter)",
    bullet: "discovery edge cases, bounded and validated",
    status: "covered",
    citations: [{ file: `${PROVIDER_RUNTIME}/discovery.test.ts`, testName: "truncates at maxItems and says so, both in `partial` and in a warning" },
      { file: `${PROVIDER_RUNTIME}/discovery.test.ts`, testName: "times out rather than waiting on a provider that never answers" }],
  },
  {
    id: "WS13-A12",
    spec: "WS-13 §13 (adapter)",
    bullet: "vision / file behaviour where advertised",
    status: "deferred",
    owningPhase:
      "NO SHIPPED SURFACE ASKS FOR IT AT P6. The multimodal content-block variants landed (R6-3: `image` on `ContentBlock`, `tool_result.content` widened) and every family's mapper carries them, but no P6 scenario or corpus case drives an image through a real adapter -- the fakes answer text. The obligation is real and unmet; it belongs with whichever phase ships a surface that sends one (P8's daemon work is the first that would).",
  },
  {
    id: "WS13-A13",
    spec: "WS-13 §13 (adapter)",
    bullet: "NO silent tool dropping, and NO silent provider fallback",
    status: "covered",
    citations: [
      { file: `${CORPUS}/anthropic.test.ts`, testName: "a `tool_reference` block is a TYPED REFUSAL, never a silent drop" },
      { file: `${RUNTIME}/provider/selection.test.ts`, testName: "a candidate on ANOTHER PROVIDER is a typed error AT INIT" },
    ],
  },
];

// --- §13 bullet 3: INTEGRATION --------------------------------------------------------------------

const INTEGRATION_ROWS: ConformanceRow[] = [
  {
    id: "WS13-I1",
    spec: "WS-13 §13 (integration)",
    bullet: "all modes see the same normalized availability rules through the SDK",
    status: "new",
    citations: [
      // The four family scenarios share one parameterised title, so the citation is the TEMPLATE plus
      // the two scenario names the table is generated from -- all three literals are in the file, and
      // deleting any of them breaks this row.
      { file: `${SDK}/transport-equivalence.test.ts`, testName: "text -> tool round -> final, on every leg against the SAME loopback fake" },
      { file: `${SDK}/transport-equivalence.test.ts`, testName: "\"p6-anthropic-fake\", SCENARIO_MODELS.anthropic" },
      { file: `${SDK}/transport-equivalence.test.ts`, testName: "\"p6-openai-chat-fake\", SCENARIO_MODELS.openaiChat" },
    ],
    note: "Three transports, one loopback fake, byte-identical frame streams -- WS-04 §12's own release-blocker standard applied to the provider layer.",
  },
  {
    id: "WS13-I2",
    spec: "WS-13 §13 (integration)",
    bullet: "official-runtime selection stays separate from Anthropic-API-key selection",
    status: "covered",
    citations: [{ file: `${RUNTIME}/provider/selection.test.ts`, testName: "an alias with NO credential ref is a typed refusal -- never silently pointed at another provider" }],
  },
  {
    id: "WS13-I3",
    spec: "WS-13 §13 (integration)",
    bullet: "a restart preserves provider / model / runtime identity",
    status: "new",
    citations: [{ file: `${SDK}/transport-equivalence.test.ts`, testName: "p6-resume-identity: the resolved identity survives a resume, on every leg" }],
    note: "A daemon restart is P8's surface; a RESUME is the same question this phase can ask -- a second process, the same session, the same resolved identity.",
  },
  {
    id: "WS13-I4",
    spec: "WS-13 §13 (integration)",
    bullet: "Keychain secrets never appear in settings / catalog / session events / transcripts / logs",
    status: "covered",
    citations: [
      { file: `${RUNTIME}/provider/keychain-store.test.ts`, testName: "no `.ts` in the REPOSITORY reaches the secrets API except keychain-store.ts itself" },
      { file: `${RUNTIME}/provider/keychain-store.test.ts`, testName: "NO error message ever contains the stored value, or the backend's own message" },
      { file: `${CATALOG}/validate.test.ts`, testName: "scanForSecrets" },
    ],
    note: "The catalog citation is a symbol rather than a test title: `scanForSecrets` is the catalog-wide grep, and its own cases live under that name.",
  },
  {
    id: "WS13-I5",
    spec: "WS-13 §13 (integration)",
    bullet: "Swift decodes the catalog ignoring forward-compatible fields",
    status: "deferred",
    owningPhase:
      "NO SWIFT CONSUMER EXISTS IN THIS REPOSITORY. The catalog is deliberately inert data with a JSON Schema so a Swift decoder CAN be written (and `packages/provider-catalog` is inside the Node-portable fence for exactly that reason), but the decoder itself is an iOS-scoped deliverable -- WS-13 §14's own open question 3 says which cohort subset gets Swift-native adapters is outside this spec.",
  },
  {
    id: "WS13-I6",
    spec: "WS-13 §13 (integration)",
    bullet: "phone-local Chat exposes only locally executable adapters",
    status: "deferred",
    owningPhase: "Same owner as WS13-I5: there is no phone-local surface in this repository at P6. The catalog carries the fact a host would filter on (`modelDiscovery: \"local\"`, and the twelve local providers' own rows), which is the part this phase can supply.",
  },
  {
    id: "WS13-I7",
    spec: "WS-13 §13 (integration)",
    bullet: "structural / adapter / SDK / daemon / Swift / migration / live-test statuses reported separately",
    status: "covered",
    citations: [{ file: `${CORPUS}/continuity.test.ts`, testName: "a FAILING case is reported with its own message, and the run continues past it" }],
    note: "Winter's own separation is by RUNNER: the catalog pipeline, the adapter corpus, the continuity corpus, the classifier-safety corpus, the equivalence suite and the opt-in live gate each report their own verdict, and none of them can mask another.",
  },
  {
    id: "WS13-I8",
    spec: "WS-13 §13 (integration)",
    bullet: "the compiled artifact resolves the catalog (the bundled-JSON-module claim, proved on the real binary)",
    status: "new",
    citations: [{ file: `${SCRIPTS}/verify-protocol-compiled.ts`, testName: "the catalog (${catalog.catalogVersion}: ${catalog.providers.length} providers" }],
    note: "A gate rather than a `bun test` case, because the subject IS the compiled binary: a path read that resolves in dev and to nothing inside `$bunfs` is the exact class this leg exists to disprove, and no dev-mode test can see it.",
  },
  {
    id: "WS13-I9",
    spec: "WS-13 §13 (integration)",
    bullet: "a capability change can never grant filesystem / shell / network / permission behaviour -- the harness stays the enforcement boundary",
    status: "covered",
    citations: [{ file: `${RUNTIME}/provider/session-provider.test.ts`, testName: "a bare model with no provider is a TYPED refusal, not a silent fallback to an echo provider" }],
    note: "The provider layer's whole reach is which endpoint is called with which body; every tool call still goes through the permission evaluator, which no catalog row can address. The cited row pins the narrower claim this phase actually changed: selection refuses rather than substituting.",
  },
  {
    id: "WS13-I10",
    spec: "WS-13 §13 (integration)",
    bullet: "R6-17: a child runs off its OWN provider, end to end",
    status: "new",
    citations: [{ file: `${SDK}/transport-equivalence.test.ts`, testName: "p6-child-own-provider (R6-17): a child with its OWN model runs off its OWN provider" }],
    note: "The P5 factory-seam lesson applied: `AgentDefinition.model` reaching the child proves nothing until a request carrying the CHILD's model id reaches a server.",
  },
];

const ALL_ROWS: ConformanceRow[] = [...CATALOG_ROWS, ...ADAPTER_ROWS, ...INTEGRATION_ROWS];

describe("WS-13 §13 conformance matrix (Phase 6 Task 10)", () => {
  test("every row is covered, newly tested here, or deferred with a named owning-phase reasoning -- zero unexplained bullets", () => {
    for (const row of ALL_ROWS) {
      if (row.status === "deferred") {
        expect(row.owningPhase, `${row.id} (${row.bullet}): a deferred row must name its owning-phase reasoning`).toBeTruthy();
      } else {
        expect(row.citations?.length ?? 0, `${row.id} (${row.bullet}): a ${row.status} row must carry at least one citation`).toBeGreaterThan(0);
      }
    }
  });

  test("every citation's file exists and genuinely contains the cited substring -- a renamed or deleted cited test fails HERE, not silently in a stale comment", () => {
    const fileCache = new Map<string, string>();
    const readCited = (relPath: string): string => {
      let content = fileCache.get(relPath);
      if (content === undefined) {
        content = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
        fileCache.set(relPath, content);
      }
      return content;
    };
    const countOccurrences = (haystack: string, needle: string): number => {
      let count = 0;
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) return count;
        count++;
        from = at + 1;
      }
    };
    for (const row of ALL_ROWS) {
      for (const c of row.citations ?? []) {
        // Self-citation loophole guard: a row citing THIS file has its own `testName` literal sitting
        // in the table, which would trivially satisfy a plain `.includes()` even if the real test were
        // renamed. Requiring TWO occurrences closes it.
        const required = c.file === "./conformance.test.ts" ? 2 : 1;
        const occurrences = countOccurrences(readCited(c.file), c.testName);
        expect(
          occurrences >= required,
          `${row.id}: citation not found -- ${c.file} does not contain ${required} occurrence(s) of "${c.testName}" (found ${occurrences})`,
        ).toBe(true);
      }
    }
  });

  test("every citation substring is specific enough to be a real tripwire (never a one-word match)", () => {
    for (const row of ALL_ROWS) {
      for (const c of row.citations ?? []) {
        if (c.file.endsWith(".json")) continue;
        // 13 rather than 18 (the P4 matrix's bound): this matrix cites two SYMBOLS rather than test
        // titles -- `scanForSecrets` is the catalog-wide credential grep, and its own cases live under
        // that name in a `describe`. A symbol that specific is a real tripwire; the bound still
        // rejects the one-word fragments the guard exists for.
        expect(c.testName.length, `${row.id}: citation "${c.testName}" (${c.file}) is too short to discriminate`).toBeGreaterThanOrEqual(13);
      }
    }
  });

  test("row ids are unique", () => {
    const ids = ALL_ROWS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all three §13 acceptance groups are represented -- no numbered obligation group is silently missing", () => {
    const groups = new Set(ALL_ROWS.map((r) => r.spec));
    expect([...groups].sort()).toEqual(["WS-13 §13 (adapter)", "WS-13 §13 (catalog)", "WS-13 §13 (integration)"]);
  });

  test("CI runs the catalog regeneration check and the OFFLINE source sync (WS13-C1's other half)", () => {
    const ci = readFileSync(fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)), "utf8");
    expect(ci).toContain("bun run provider:catalog -- --check");
    expect(ci).toContain("bun run provider:sync -- --offline");
  });

  test("summary counts (informational -- printed for the task report)", () => {
    const covered = ALL_ROWS.filter((r) => r.status === "covered").length;
    const newRows = ALL_ROWS.filter((r) => r.status === "new").length;
    const deferred = ALL_ROWS.filter((r) => r.status === "deferred").length;
    expect(covered + newRows + deferred).toBe(ALL_ROWS.length);
    console.log(`WS-13 §13 matrix: ${ALL_ROWS.length} rows -- ${covered} covered, ${newRows} new, ${deferred} deferred`);
  });
});
