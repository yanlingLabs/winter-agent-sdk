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
const LIVE = "../../provider-conformance/src/live";
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
      // P6 fix wave (Ruling E-3): the fallback that DOES engage is announced, never silent.
      { file: `${SDK}/transport-equivalence.test.ts`, testName: "p6-fallback (R6-C through Ruling E-3)" },
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
    // Review round 1 (I): the citation is the THROW, not the success line. A `console.log` is what a
    // gate prints when it passes; the assertion is what makes it a gate, and deleting the throw would
    // leave the log — and the old citation — intact.
    citations: [
      { file: `${SCRIPTS}/verify-protocol-compiled.ts`, testName: "the bundled catalog is not the one that was built in" },
      { file: `${SCRIPTS}/verify-protocol-compiled.ts`, testName: "reported a `winter_provider` identity it cannot have resolved" },
    ],
    note: "A gate rather than a `bun test` case, because the subject IS the compiled binary: a path read that resolves in dev and to nothing inside `$bunfs` is the exact class this leg exists to disprove, and no dev-mode test can see it. Both citations are THROWS -- the catalog-version mismatch and the negative control.",
  },
  {
    id: "WS13-I9",
    spec: "WS-13 §13 (integration)",
    bullet: "a capability change can never grant filesystem / shell / network / permission behaviour -- the harness stays the enforcement boundary",
    status: "covered",
    citations: [{ file: `${RUNTIME}/provider/session-provider.test.ts`, testName: "a bare model with no provider CONSTRUCTS, reports no identity, and refuses on the first generation" }],
    note: "The provider layer's whole reach is which endpoint is called with which body; every tool call still goes through the permission evaluator, which no catalog row can address. The cited row pins the narrower claim this phase actually changed: selection refuses rather than substituting.",
  },
  {
    id: "WS13-I11",
    spec: "WS-13 §13 (integration)",
    bullet: "R6-9's refusal is surfaced in T1's CAPTURED failure shape (init, then the pinned result, then a throw)",
    status: "new",
    citations: [
      { file: `${SDK}/transport-equivalence.test.ts`, testName: "p6-resolution-failure: an unresolvable model still emits `system/init`" },
      { file: "../goldens/p6-resolution-failure.trace.json", testName: "api_error_status" },
    ],
    note: "Review round 1, Critical A. Refusing at construction produced ZERO frames and a `CLIConnectionError`; the pinned shape has an init frame in it. The golden is what makes the ruling durable -- a regression back to refusing at construction cannot match a two-frame trace.",
  },
  {
    id: "WS13-I12",
    spec: "WS-13 §13 (integration)",
    bullet: "identity across a model SWITCH on resume (R6-I's boundary rule, the non-control-request half)",
    status: "new",
    citations: [{ file: `${SDK}/transport-equivalence.test.ts`, testName: "p6-resume-identity (switch half): a DIFFERENT model on resume applies at the first boundary" }],
    note: "Review round 1, D. The boundary rule was implemented for the `set_model` control request only; a host that resumes with a different `Options.model` changed the session's model with no frame saying so.",
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

// --- P6 fix wave (Lane E): the rows for the fixtures the whole-branch review's Criticals and
// Importants produced. "new" rather than "covered", like every row a task adds for a gap it closes.
const FIX_WAVE_ROWS: ConformanceRow[] = [
  {
    id: "WS13-I13",
    spec: "WS-13 §13 (integration)",
    bullet: "Keychain secrets never cross a provider boundary: a target on ANOTHER provider (classifier, advisor, R6-17 child) never inherits the session's credential or user endpoint (§6 Phase 6 amendment, Ruling E-1)",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/cross-provider-credential.test.ts`, testName: "(P1a, inverted) an R6-17 child on another provider is built with THAT provider's own keychain record" },
      { file: `${RUNTIME}/provider/cross-provider-credential.test.ts`, testName: "(P1b, inverted) the classifier route's OWN" },
      { file: `${RUNTIME}/provider/cross-provider-credential.test.ts`, testName: "a cross-provider target reaches its OWN generated endpoint" },
      { file: `${RUNTIME}/provider/cross-provider-credential.test.ts`, testName: "the spawn reports the child, the model and the provider on stderr AND on the parent's stream" },
    ],
    note: "Whole-branch C-1 (probe P1): vendor A's key on the wire to vendor B's endpoint. Two providers on the shared chat adapter, each with its own loopback fake, the other fake asserting it saw none of the session's material.",
  },
  {
    id: "WS13-I14",
    spec: "WS-13 §13 (integration)",
    bullet: "identity across a model SWITCH via the control request: `set_model` resolves FIRST (R6-K under the session provider), the wire carries the resolved row's own id never the catalog key, `model_switch` and `providerHistory` carry keys, post-switch origins name the new model (R6-I amendment, Ruling E-2)",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/switch-seam.test.ts`, testName: "(P2b, inverted) the QUALIFIED catalog key" },
      { file: `${RUNTIME}/provider/switch-seam.test.ts`, testName: "a key qualified for ANOTHER provider is" },
      { file: `${RUNTIME}/provider/engine-seam-p6.test.ts`, testName: "(whole-branch M-8) the SAME hook points through a CATALOG-RESOLVED adapter with a KEY" },
      { file: `${SDK}/transport-equivalence.test.ts`, testName: "p6-set-model (R6-I through Ruling E-2)" },
      { file: `${SDK}/transport-equivalence.test.ts`, testName: "p6-set-model (refusal)" },
    ],
    note: "Whole-branch C-2 (probe P2): the picker row's `value` went on the wire verbatim and every post-switch origin named the old model. The three-leg scenario drives `supportedModels()[i].value` into `setModel()`.",
  },
  {
    id: "WS13-I15",
    spec: "WS-13 §13 (integration)",
    bullet: "no silent cross-domain replay: a `warned-lossy` switch emits `continuity_warning: cross_domain_replay_dropped` (counts and identity only) and persists the `handoff` sidecar record built by `buildPortableHandoff` (§8.2 / WS-05 §13)",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/switch-seam.test.ts`, testName: "a CROSS-DOMAIN switch emits" },
      { file: `${RUNTIME}/provider/switch-seam.test.ts`, testName: "sidecar record anchored at the source's last entry (M-6)" },
      { file: `${RUNTIME}/provider/switch-seam.test.ts`, testName: "a SAME-DOMAIN switch (two models declaring one certified domain) is lossless" },
      { file: `${RUNTIME}/provider/switch-seam.test.ts`, testName: "parked MID-TURN and applied on interrupt" },
    ],
    note: "The frame carries no anchor uuid (a per-run value); the record does. On the interrupt path the same value carries the matrix's mid-turn-abort loss (trigger 7), disclosed in WS-03.",
  },
  {
    id: "WS13-I16",
    spec: "WS-13 §13 (integration)",
    bullet: "fallback ENGAGES on an R6-6 retryable-class failure after retries, through the same seam, same domain only, announced as `model_switch{reason:\"fallback\"}` both ways, silent at parity (R6-C amendment, Ruling E-3)",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/switch-seam.test.ts`, testName: "the primary fails on a retryable class -> the candidate serves the SAME round" },
      { file: `${RUNTIME}/provider/switch-seam.test.ts`, testName: "a NON-retryable class never engages a fallback" },
      { file: `${RUNTIME}/provider/switch-seam.test.ts`, testName: "a candidate OUTSIDE the current model's continuation domain is skipped" },
      { file: `${SDK}/transport-equivalence.test.ts`, testName: "p6-fallback (R6-C through Ruling E-3)" },
    ],
    note: "Whole-branch I-1: `fallbackModel` was accepted, domain-checked at init and never engaged. The three-leg scenario exhausts a real `withRetry` (503 x11, `Retry-After: 1`) on gemini-2.5-flash and serves the turn on flash-lite.",
  },
  {
    id: "WS13-I17",
    spec: "WS-13 §13 (integration)",
    bullet: "usage accounting reaches the host: a priced row's results carry `total_cost_usd` and `modelUsage` from the descriptor's pricing evidence; an unpriced row carries no cost field; `maxBudgetUsd` stops the next request on `error_max_budget_usd` (R6-H amendment, Ruling E-4)",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/cost-and-pin.test.ts`, testName: "a PRICED row: the result carries the exact" },
      { file: `${RUNTIME}/provider/cost-and-pin.test.ts`, testName: "an UNPRICED row: no cost field at all" },
      { file: `${RUNTIME}/provider/cost-and-pin.test.ts`, testName: "the request that would cross an already-exceeded ceiling never goes out" },
      { file: "../goldens/p6-anthropic-fake.trace.json", testName: "\"modelUsage\"" },
    ],
    note: "Whole-branch I-2: `estimateCostUsd` had no production caller. The golden citation pins that a priced family trace carries the row; `total_cost_usd` is scrubbed by the trace normalizer, so the golden cannot pin it.",
  },
  {
    id: "WS13-I18",
    spec: "WS-13 §13 (integration)",
    bullet: "the classifier is PINNED by the session's first successful classification (`classifierPin` on the dialect identity + the `fallback_state` audit record) -- §10, Ruling E-5",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/cost-and-pin.test.ts`, testName: "through the REAL route against the fake: the identity is restamped with" },
      { file: `${RUNTIME}/provider/cost-and-pin.test.ts`, testName: "a classification that yields NO verdict pins nothing" },
    ],
    note: "Whole-branch I-5: the pin was accepted by the dialect and stamped by nothing.",
  },
  {
    id: "WS13-I19",
    spec: "WS-13 §13 (integration)",
    bullet: "daemon restart preserves provider identity across a FORK made through the public session API: the chain and the identity block travel with it (WS-05 §13, the fix-wave carry)",
    status: "new",
    citations: [
      { file: `${RUNTIME}/store/fork-door.test.ts`, testName: "a fork made through the session API resumes with the source's origins and native state re-attached" },
      { file: `${RUNTIME}/store/provider-state.test.ts`, testName: "a fork replays the source's chain, anchored by the SAME entry uuids, and resumes without a warning" },
    ],
    note: "T3 re-review round 2 M3: the public door landed chain-less. One store-level primitive now serves both doors.",
  },
];

// --- P6.5 (WS-13b): provider widening ------------------------------------------------------------
//
// WS-13b amends WS-13 after Phase 6 closed, so its acceptance obligations are a FOURTH group in this
// same table rather than a table of their own: every guard below (a citation's file is read and the
// substring genuinely searched for; the self-citation double-occurrence rule; the ≥13-character
// specificity bound; unique ids) iterates `ALL_ROWS`, and a sibling array would have to duplicate
// all four or escape them.
//
// PARTIAL BY CONSTRUCTION, and the partiality is named rather than hidden. WS-13b §7 owes one row
// per new provider family behaviour — Console OAuth (Lane A2), the two authored OAuth flows and the
// reversion condition (Lane O), the Anthropic-dialect siblings and the exclusions ledger (Lane X2).
// Those lanes merge AFTER this one, and a row may only cite a test that exists: a row citing a test
// name guessed from a brief is exactly the rot the citation guard exists to prevent. The rows below
// are the ones whose covering tests are in the tree TODAY (the spine's, and this lane's own); the
// rest land when their lanes do.
const WS13B = "WS-13b §7 (widening)";

const WIDENING_ROWS: ConformanceRow[] = [
  {
    id: "WS13b-1",
    spec: WS13B,
    bullet: "§1/R6b-3: every shipped row carries a `pricingBasis` and an `admission.citation`; a missing citation fails validation and an `unknown` one is refused by the pipeline rather than imported",
    status: "new",
    citations: [
      { file: `${CATALOG}/validate.test.ts`, testName: "every shipped provider row carries pricingBasis and an admission citation" },
      { file: `${CATALOG}/validate.test.ts`, testName: "a row without an admission citation FAILS validation with code admission-missing" },
      { file: `${CATALOG}/validate.test.ts`, testName: "a citation naming the audit's `unknown` evidence class is refused with code admission-unknown" },
      { file: `${CATALOG}/extract/pipeline.test.ts`, testName: "an allowlisted entry citing the audit's `unknown` evidence class is REFUSED (admission-unknown), never imported" },
      { file: `${CATALOG}/extract/pipeline.test.ts`, testName: "the reviewed pricing basis and admission citation are COPIED onto the generated row, never derived" },
    ],
    note: "The rule is evidence, not decoration: 'the decisive document was not found' is a disposition to EXCLUDE, so a row may not ship carrying it.",
  },
  {
    id: "WS13b-2",
    spec: WS13B,
    bullet: "§1 honest identity: every adapter family sends Winter's OWN `User-Agent`, never an editor, CLI or first-party product identity — asserted off the live request a fake received, on every family",
    status: "new",
    citations: [
      { file: `${PROVIDER_RUNTIME}/identity.test.ts`, testName: "the user agent names Winter and its version, never an editor or vendor CLI" },
      { file: `${PROVIDER_RUNTIME}/identity.test.ts`, testName: "it is a single well-formed product token — no vendor originator can be appended to it" },
      { file: `${CORPUS}/openai.test.ts`, testName: "WS-13b: every request carries Winter's OWN user-agent, on both surfaces" },
      { file: `${CORPUS}/anthropic.test.ts`, testName: "WS-13b: every request carries Winter's OWN user-agent, never an editor or vendor CLI identity" },
      { file: `${CORPUS}/google.test.ts`, testName: "WS-13b: every request carries Winter's OWN user-agent, never an editor or vendor CLI identity" },
      { file: `${CORPUS}/vertex.test.ts`, testName: "the GenerateContent request carries Winter's OWN user-agent" },
      { file: `${CORPUS}/bedrock.test.ts`, testName: "every request carries Winter's OWN user-agent, and the fake's SigV4 check still passes with it in the signed set" },
    ],
    note: "WS-13 §5 reaffirmed, not relaxed: client-identity headers are never imported and Winter adapters author their own. The OAuth helpers' own token/device requests carry it too — WS13b-6's citations, not WS13b-5's.",
  },
  {
    id: "WS13b-3",
    spec: WS13B,
    bullet: "§1 pricing basis is data: a `subscription`- or `free`-priced row never feeds R6-H cost (`total_cost_usd`/`modelUsage` omitted), while the SAME row priced per token still does",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/session-provider.test.ts`, testName: "a subscription-priced row reports NO cost: a per-token number for a seat is not a smaller error, it is a wrong one" },
      { file: `${RUNTIME}/provider/session-provider.test.ts`, testName: "a free (local) row reports no cost either" },
      { file: `${CATALOG}/validate.test.ts`, testName: "a subscription-priced row is legal and keeps its own basis" },
      // The INVERTED leg, cited in its own right (review round 1, minor 2): without it the row's two
      // negatives would pass just as happily on a wiring that had never heard of `pricingBasis`.
      { file: `${RUNTIME}/provider/session-provider.test.ts`, testName: "the SAME row priced per token DOES report a cost — so the negative below is about the basis, not about missing evidence" },
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "a subscription- or free-priced row NEVER carries a token price — the basis and the pricing agree" },
      { file: `${CORPUS}/xai-oauth.test.ts`, testName: "the catalog row is SUBSCRIPTION-priced, so nothing it returns can feed R6-H cost" },
    ],
    note: "The inverted leg is what carries it: the same row priced per token DOES report a cost, so the assertion is about the basis rather than about a row with no pricing evidence.",
  },
  {
    id: "WS13b-4",
    spec: WS13B,
    bullet: "§4/R6b-7: a provider disabled by `settings.providers.<id>.enabled` is REFUSED at resolution with code `provider-disabled` — at session start, at `set_model`, and for every `fallbackModel` candidate; R6b-9 makes the switch operator-immune (any tier's `false` wins)",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/selection.test.ts`, testName: "a provider disabled in settings is REFUSED at resolution with code provider-disabled — never skipped silently" },
      { file: `${RUNTIME}/provider/selection.test.ts`, testName: "a fallbackModel on a disabled provider is refused at init, not discovered at failover" },
      { file: `${RUNTIME}/provider/session-provider.test.ts`, testName: "with the provider disabled, the switch is REFUSED with provider-disabled — never a parked or silent switch" },
      { file: `${RUNTIME}/production-wiring.test.ts`, testName: "a USER-tier `providers.<id>.enabled: false` REFUSES the session's provider, by name, on the wiring warning channel" },
      { file: `${SDK}/settings/settings.test.ts`, testName: "R6b-9: a PROJECT tier can never re-enable what the USER tier disabled — the reversion switch is operator-immune" },
    ],
    note: "This is the reversion condition's mechanism (§4): if xAI rejects an honest unregistered agent identity, the row is switched off by the operator and no lower tier can put it back.",
  },
  {
    id: "WS13b-5",
    spec: WS13B,
    bullet: "§7 the live gate: one opt-in target per documented third-party path (api-key, OAuth via a Keychain ref, keyless), a per-target row carrying identifiers/verdict/latency/identity and never a byte of what a provider returned, and no path from `bun test` to a vendor or to the Keychain",
    status: "new",
    citations: [
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "an OAuth row is selected by WINTER_LIVE_<P>_CREDENTIAL_REF and never by an API-key variable" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "a keyless row is selected by WINTER_LIVE_<P>=1 with no key" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "the keyless selector is `1` exactly, and it never applies to a PRICED row" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "the spawn helper REFUSES a credential-ref variable -- the OAuth kind can never be driven from `bun test`" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "a live run whose adapter fails prints identity only -- never the body" },
      { file: `${LIVE}/summary.test.ts`, testName: "the formatted line carries every field as `key=value`, and NOTHING a provider returned" },
      { file: `${LIVE}/summary.test.ts`, testName: "`describeThrown` on a CredentialResolutionError renders the class and code, and NOT the redacted ref its message carries" },
    ],
    note: "The OAuth kind is proved through the PURE planner and nowhere else: resolving it constructs the production Keychain store, which no test may reach. The spawn helper's refusal is what makes that structural.",
  },
  {
    id: "WS13b-5a",
    spec: WS13B,
    bullet:
      "§7 the live gate against the WIDENED catalog: every selector is cross-checked against the row's OWN `authKinds` (an OAuth-only row is never asked with a key, a keyed row is never asked with nothing, a row with no OAuth path never yields `kind: \"oauth\"`), and all 163 rows are reachable",
    status: "new",
    citations: [
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "the OAuth arm refuses a row that documents NO OAuth path" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "the keyless arm refuses a FREE row that documents an api key" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "the keyless arm's two halves are INDEPENDENT: `xai-oauth` is refused on price, `aihorde` on auth" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "the WIDENED catalog sweep: every one of its rows is reachable, and no row is admitted by a selector its own authKinds contradict" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "a row with NO model row of its own is not silently dropped" },
    ],
    note: "Review round 1's Important #1. The sweep is stated as six properties about credentials rather than as a table computed from the same predicates the code applies; it found on its first run that 62 of the widened rows were being dropped in silence for having no model row.",
  },
  {
    id: "WS13b-5b",
    spec: WS13B,
    bullet:
      "§7 the credential gets IN and lands where the operator chose, and NEVER in the host's services: `--login <providerId>` drives `startProviderLogin` (loopback and device flows both), `WINTER_LIVE_KEYCHAIN_SERVICE` is REQUIRED for every Keychain path (no production default — unset is a typed refusal before any store is constructed), `keychain:<service>/<account>` addresses one record, and neither door is reachable from `bun test`",
    status: "new",
    citations: [
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "`anthropic` runs the Console PKCE login against the fake and prints the exact CREDENTIAL_REF to export" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "`xai-oauth` runs the DEVICE flow: the verification URL and user code arrive on the progress channel, never through openUrl" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "`keychain:<service>/<account>` carries the service on the ref; `keychain:<account>` leaves it to the store" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "an account containing a SLASH is not mistaken for a service" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "the spawn helper REFUSES `--login` too -- it is the second door onto the Keychain" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "UNSET: the refusal happens BEFORE any store is constructed" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "SET: the store is built with THAT service, and the api-key and keyless kinds never build one at all" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "`--login` refuses with no service EVEN when a store is injected" },
    ],
    note: "The controller's close-out ruling — a dedicated `com.winter.live.<yyyymmdd>` service, deleted after the run, so `com.winter.core`/`.dev` are never touched — is ENFORCED, not merely enabled: the service has no production default, and a spy factory proves no store is constructed without one.",
  },
  {
    id: "WS13b-6",
    spec: WS13B,
    bullet: "§3/§4 shared OAuth machinery: a refresh that persists new material without logging it, refuses before any request when it holds no refresh token, and never lets a partial response clobber a known-good record; an RFC 8628 device flow that carries an honest identity field on EVERY request",
    status: "new",
    citations: [
      { file: `${PROVIDER_RUNTIME}/adapters/oauth/refresh.test.ts`, testName: "exchanges the refresh token, persists the new material, never logs it" },
      { file: `${PROVIDER_RUNTIME}/adapters/oauth/refresh.test.ts`, testName: "a 4xx is a typed credential error naming the ref, never the token" },
      { file: `${PROVIDER_RUNTIME}/adapters/oauth/refresh.test.ts`, testName: "a partial refresh response NEVER clobbers a known-good refresh token, id token or account id" },
      { file: `${PROVIDER_RUNTIME}/adapters/oauth/device-code.test.ts`, testName: "requests a device code, reports the user code, polls until the token arrives, and sends the identity field on EVERY request" },
      { file: `${PROVIDER_RUNTIME}/adapters/oauth/device-code.test.ts`, testName: "a terminal error from the token endpoint stops the flow instead of polling forever, and never echoes the body" },
    ],
    note: "The helpers the §3/§4 flows are built from; the flows themselves are WS13b-7 and WS13b-8.",
  },
  {
    id: "WS13b-7",
    spec: WS13B,
    bullet:
      "§3/D20 Anthropic Console OAuth: a PKCE login against the CONSOLE host with the public product client and an honest Winter identity, one Keychain record per account (`anthropic:<accountId>`, R6-10), the OAuth beta as a PROTOCOL header on the turn, API-key auth still the default, and the consumer-subscription host nowhere in the shipped constants",
    status: "new",
    citations: [
      { file: `${PROVIDER_RUNTIME}/adapters/anthropic/console-oauth.test.ts`, testName: "the PKCE loopback login persists oauth material under `anthropic:<accountId>` and sends an honest identity" },
      { file: `${PROVIDER_RUNTIME}/adapters/anthropic/console-oauth.test.ts`, testName: "D13/D14: the CONSOLE host is what D20 speaks to — the consumer subscription host appears nowhere in the shipped constants" },
      { file: `${PROVIDER_RUNTIME}/adapters/anthropic/console-oauth.test.ts`, testName: "D21: the requested scope is the admissible SUBSET — inference and profile, never the vendor application's own entitlements" },
      { file: `${PROVIDER_RUNTIME}/adapters/anthropic/console-oauth.test.ts`, testName: "a callback whose `state` does not match is REFUSED — a planted callback cannot complete a login this process did not start" },
      { file: `${CORPUS}/anthropic.test.ts`, testName: "D20: oauth material rides as a Bearer with the OAuth beta as a PROTOCOL header, and a near-expiry token is refreshed BEFORE the turn" },
      { file: `${CORPUS}/anthropic.test.ts`, testName: "an API-KEY turn carries neither the OAuth beta nor an Authorization header — the arm is chosen by the material, not switched on globally" },
      { file: `${CORPUS}/anthropic.test.ts`, testName: "WS-13b: an OAuth turn still names Winter and carries NO vendor product identity — not in the user-agent, and not in the beta list" },
      { file: `${RUNTIME}/provider/credential-api.test.ts`, testName: "`anthropic` runs the Console PKCE login and answers with the ref the record now occupies" },
    ],
    note: "The credential is the ORDINARY keychain ref, not a new `CredentialRef` kind — which is why the live gate's `keychain:<account>` locator addresses it with no adaptation (review round 1, minor 8, confirmed against the merged code).",
  },
  {
    id: "WS13b-8",
    spec: WS13B,
    bullet:
      "§4 `xai-oauth`: a Winter-run RFC 8628 device login on xAI's published secret-less client with Winter's own name in the flow's identity field on the device request AND every poll, a subscription row at the proxy the capture derived (never the metered api-key surface), NONE of the vendor's product-identity headers on either the login or the generation path, and the REVERSION CONDITION pinned by a test description on both paths",
    status: "new",
    citations: [
      { file: `${PROVIDER_RUNTIME}/adapters/openai/xai-oauth.test.ts`, testName: "REVERSION CONDITION (WS-13b §4): an honest unregistered agent identity that the vendor rejects is a partner allowlist in fact" },
      { file: `${PROVIDER_RUNTIME}/adapters/openai/xai-oauth.test.ts`, testName: "a device flow that fails for an ORDINARY reason does NOT claim the reversion condition" },
      { file: `${PROVIDER_RUNTIME}/adapters/openai/xai-oauth.test.ts`, testName: "NONE of the vendor's six product-identity headers is sent on the GENERATION path either — including the two the proxy's own client injects" },
      { file: `${PROVIDER_RUNTIME}/adapters/openai/xai-oauth.test.ts`, testName: "the identity field rides the POLLS too, not only the device request — a flow honest exactly once is not honest" },
      { file: `${PROVIDER_RUNTIME}/adapters/openai/xai-oauth.test.ts`, testName: "the subscription endpoint is the proxy the capture found, NOT the metered api-key surface" },
      { file: `${CORPUS}/xai-oauth.test.ts`, testName: "R6b-7: the reversion SWITCH works on this row — the per-provider enabled setting refuses it at resolution, by name" },
      { file: `${LIVE}/summary.test.ts`, testName: "only the allowlisted fields survive -- a marker sitting in the SAME body does not" },
      { file: `${LIVE}/summary.test.ts`, testName: "the allowlist is a CLOSED list -- every field it names is one an auth refusal reports, and nothing else is read" },
      { file: `${LIVE}/summary.test.ts`, testName: "`xai-oauth`: an OAuth entitlement's 401 IS the reversion condition, names its own provider in the remediation" },
      { file: `${LIVE}/summary.test.ts`, testName: "`codex-oauth`: the SAME semantics, and the remediation names CODEX" },
      { file: `${LIVE}/summary.test.ts`, testName: "`clinepass`: an API-KEY row on a subscription plan reads its 401 as a KEY failure" },
    ],
    note: "The last five citations are the INFERENCE-PATH half of the condition, which only a live run can answer: a 401/403 on a valid subscription bearer sent with Winter's identity alone. The gate reports the vendor's own auth dimensions through a closed allowlist and NEVER retries with the product header to prove the point (D21). The reversion SEMANTICS are gated on the target's auth path, not its price: four rows are subscription-priced and two of them are ordinary api-key products, whose 401 is a bad key and says nothing about Winter's identity (review round 2, I1).",
  },
  {
    id: "WS13b-9",
    spec: WS13B,
    bullet:
      "§2/R6b-5 dual-dialect siblings: a provider with two documented dialects is two rows, each with its OWN `defaultEndpoints.api`, a dialect-suffixed display name and its own model keys; `winter.anthropic-messages` is multi-provider in fact and each sibling's turn reaches its own endpoint with every protocol header intact",
    status: "new",
    citations: [
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "every dialect sibling states its dialect in its display name, and never shares an endpoint with its twin" },
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "`anthropic` is the ONLY `authoritative` row on its adapter — A2's closure does not reach the siblings" },
      { file: `${RUNTIME}/provider/catalog-endpoint-shape.test.ts`, testName: "R6b-5: `winter.anthropic-messages` is multi-provider IN FACT -- each sibling reaches its OWN endpoint" },
      { file: `${RUNTIME}/provider/catalog-endpoint-shape.test.ts`, testName: "...and the COPY costs `anthropic` no header: every protocol header and Winter's own user-agent still arrive" },
      { file: `${CORPUS}/anthropic.test.ts`, testName: "oauth material on a SIBLING provider row rides as a plain Bearer: no Anthropic beta, and NOTHING is sent to Anthropic's token endpoint" },
      { file: `${RUNTIME}/provider/catalog-endpoint-shape.test.ts`, testName: "EVERY shipped catalog row on a path-appending adapter carries a root, not a protocol path" },
    ],
    note: "The last citation is the endpoint-root fix X2 found while widening: a row carrying a full protocol path would have had it DOUBLED by a path-appending adapter, which no fixture at 21 rows could have surfaced.",
  },
  {
    id: "WS13b-10",
    spec: WS13B,
    bullet:
      "§5 every exclusion is LEDGERED with its reason and absent from the catalog — the user's rulings, the impersonation-required rows, the agent transports, the website scrapers and the evidence-pending ids — and PROVENANCE.md's table matches the ledger row for row",
    status: "new",
    citations: [
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "every user- and audit-excluded id is ABSENT from the catalog and PRESENT in the ledger with its reason" },
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "PROVENANCE.md's exclusion table matches the ledger, row for row" },
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "the api-key pool is widened: at least 120 apikey-category providers are now rows, and none is a website-scrape transport" },
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "NO row anywhere carries the aihorde anonymous key, or any other credential literal" },
      { file: `${RUNTIME}/provider/credential-api.test.ts`, testName: "`qoder` is a TYPED refusal, not a crash and not a silent no-op" },
      { file: `${SCRIPTS}/verify-provider-live.test.ts`, testName: "`qoder` answers with its TYPED refusal rather than opening anything -- the exclusion is the end state, not a stub" },
    ],
    note: "`qoder` is EXCLUDED, not owed: the brief's qoder provider row is restated here as an exclusion row. Lane O's capture established against Qoder's own documentation index that it publishes no third-party OAuth grant and no third-party inference endpoint — its documented routes are a PAT and its own Agent SDK, which is the agent-transport class WS-13 §8.2 excludes. There is nothing to sign in to, and the two citations pin that the refusal is typed and reached rather than a stub waiting on a lane.",
  },
];

// --- P6.6 (WS-13c): model families and ranked slots ------------------------------------------------
//
// WS-13c amends WS-01 §6, WS-03 §7, WS-06 §3.3, WS-10 §3/§7 and WS-13 §8 (spec §11) rather than
// replacing any of them, so — like WS-13b before it — its acceptance obligations are a FIFTH group in
// this same table under this same set of guards, not a table of their own. §10 states nine numbered
// bullets plus three named SendMessage cases (WS13c-SM1..3, spelled out in full in §8); every row
// below cites a REAL test found by grepping the merged tree, not by trusting a lane report's prose
// summary of one (several summaries paraphrase a title well enough to break a substring match).
// Several of Lane A's and Lane D's own tests are already prefixed `WS13c-N:` in their titles — the
// implementer named the row before this task existed, which is the strongest citation available.
const WS13C = "WS-13c §10 (families)";

const MODEL_FAMILIES_ROWS: ConformanceRow[] = [
  {
    id: "WS13c-1",
    spec: WS13C,
    bullet: "the enum per family: a `gpt` session advertises `astra, sol, terra, luna`; a `claude` session (Winter-driven) advertises the pinned four; an `other` session advertises its own model as one slot",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/slots.test.ts`, testName: "a gpt session advertises astra, sol, terra, luna as family-default" },
      { file: `${RUNTIME}/provider/slots.test.ts`, testName: "a claude session renders the pinned four and no other name" },
      { file: `${RUNTIME}/provider/slots.test.ts`, testName: "a family without slots renders the session's own model as one slot" },
      { file: `${RUNTIME}/engine.test.ts`, testName: "WS13c-1: the Agent tool's model enum is rendered from the active family (gpt session)" },
      { file: `${RUNTIME}/engine.test.ts`, testName: "WS13c-1: a family with no curated slots advertises the session's own model as the single slot" },
    ],
  },
  {
    id: "WS13c-2",
    spec: WS13C,
    bullet: "the \"no false information\" tripwire: no non-`claude` active set ever contains a reserved Claude name; a custom slot named `fable` is rejected whole",
    status: "new",
    citations: [
      { file: `${RUNTIME}/engine.test.ts`, testName: "WS13c-2: a claude session advertises the pinned four and nothing else" },
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "no NON-claude family uses a reserved Claude name (D25: never false information)" },
      { file: `${CATALOG}/validate.test.ts`, testName: "a reserved Claude name on another family is refused" },
      { file: `${SDK}/settings/model-slots.test.ts`, testName: "a bad SECOND entry refuses the set whole — the valid first entry is not returned partially" },
    ],
    note: "The custom-slot citation exercises `opus`, not the bullet's own `fable` example — both are members of `CLAUDE_RESERVED_SLOT_NAMES` and refused by the identical check (`model-slots.ts`'s `CLAUDE_RESERVED_SLOT_NAMES.includes(name)`), so it is the same case the bullet names under a different reserved name. `model-slots.test.ts` is Lane B's file, not this task's, so the fix is naming this rather than editing it in.",
  },
  {
    id: "WS13c-3",
    spec: WS13C,
    bullet: "re-render at `set_model` across families and at a `modelSlots` change, both at the quiescent boundary, with no restart",
    status: "new",
    citations: [
      { file: `${RUNTIME}/engine.test.ts`, testName: "WS13c-3: a set_model across families re-renders at the quiescent boundary, with no restart" },
      { file: `${RUNTIME}/engine.test.ts`, testName: "WS13c-3: a changed settingsVersion re-renders the enum at the next turn, with no restart and no model change" },
      { file: `${RUNTIME}/production-wiring.test.ts`, testName: "settingsVersion tracks the resolved view's identity — and nothing re-resolves it mid-session yet" },
    ],
  },
  {
    id: "WS13c-4",
    spec: WS13C,
    bullet: "acceptance: an active-set name; a unique foreign name (`luna` from a `claude` session); an ambiguous foreign name (`flash` from a `gpt` session) → `ambiguous-slot-name`; an unknown name → the WS-01 §6 error",
    status: "new",
    citations: [
      { file: `${CATALOG}/families.test.ts`, testName: "an active-set name is advertised" },
      { file: `${RUNTIME}/provider/slots.test.ts`, testName: "a unique foreign name resolves; an ambiguous one refuses with both candidates; the Claude names always go to claude" },
      { file: `${RUNTIME}/engine.test.ts`, testName: "WS13c-4: an ambiguous foreign name refuses with its own code, never a substitution" },
      { file: `${RUNTIME}/provider/slots.test.ts`, testName: "an unknown name is a typed unknown-slot refusal, never a substitution" },
      { file: `${RUNTIME}/engine.test.ts`, testName: "an `unknown-slot` answer passes the requested string through -- the registry stays the authority on aliases and upstream ids" },
    ],
  },
  {
    id: "WS13c-5",
    spec: WS13C,
    bullet: "resolution order and the `slot-unservable` refusal that names what would serve; `requestedModel`/`effectiveModel`/`effectiveProvider`/`slot` recorded on the child",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/slots.test.ts`, testName: "vendor row first, subscription before token, then preferred, then the rest" },
      { file: `${RUNTIME}/provider/slots.test.ts`, testName: "a disabled provider is skipped and named in wouldServe" },
      { file: `${RUNTIME}/engine.test.ts`, testName: "WS13c-5: an unservable slot is the Agent tool's own typed error, naming the code and what would have served it" },
      { file: `${RUNTIME}/engine.test.ts`, testName: "WS13c-4/5: a slot name becomes the catalog key that serves it, and the child records the slot it named" },
      { file: `${RUNTIME}/subagents/cross-family-resume.test.ts`, testName: "Fix round 1 (coordinator follow-up): recordModelEffort stamps BOTH effectiveProvider and slot from the child's own materialised identity, and omits both keys entirely when absent" },
    ],
  },
  {
    id: "WS13c-6",
    spec: WS13C,
    bullet: "custom slots: user tier honoured; untrusted project tier ignored and recorded; invalid set ignored whole; Claude session ignores and records `claude-pinned`",
    status: "new",
    citations: [
      { file: `${SDK}/settings/resolve.test.ts`, testName: "untrusted workspace: the project's modelSlots/preferredProviders are dropped, the user tier's own values survive, the drop is recorded on the project source, and the RAW project entry still carries what the repo actually committed" },
      { file: `${SDK}/settings/resolve.test.ts`, testName: "trustedWorkspace: true — the project tier wins with ordinary precedence, and nothing is recorded as ignored" },
      { file: `${RUNTIME}/production-wiring.test.ts`, testName: "a claude session ignores custom slots and RECORDS the ignore through the warnings channel" },
      { file: `${RUNTIME}/production-wiring.test.ts`, testName: "a NON-claude session honours the same custom set, and no ignore is recorded" },
      { file: `${RUNTIME}/production-wiring.test.ts`, testName: "an INVALID custom set is ignored whole AND recorded through the warnings channel, quoting the failing entry" },
      { file: `${SDK}/settings/model-slots.test.ts`, testName: "a bad SECOND entry refuses the set whole — the valid first entry is not returned partially" },
    ],
    note: "\"invalid set ignored whole\" is proven at the validator (the fifth citation, and `model-slots.test.ts`'s WHOLE-SET describe more broadly): a malformed entry drops the ENTIRE set, never a partially-filtered one. No WIRING-level test feeds `buildProductionWiring` an invalid `modelSlots` and asserts the session falls back to `family-default`, or that anything ever actually records `modelSlotsIgnored: \"invalid\"` — `production-wiring.ts`'s own comment assigns that provenance to \"the settings cascade\", and `resolve.ts` does not derive it either (`resolve.test.ts` proves only that the key can never be SPOOFED from a file, not that it is ever genuinely produced). Flagged here rather than papered over with an invented citation.",
  },
  {
    id: "WS13c-7",
    spec: WS13C,
    bullet: "`listModelFamilies()` shape, `active.source`, and `servable` tracking credentials and `providers.<id>.enabled`",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/family-listing.test.ts`, testName: "families carry their slots and every model grouped by canonical id with per-row servable states" },
      { file: `${RUNTIME}/engine.test.ts`, testName: "WS13c-7: `list_model_families` reports the family the session is CURRENTLY on, not the one it started on" },
      { file: `${SDK}/query.test.ts`, testName: "listModelFamilies(): resolves the listing the runtime answers over the list_model_families control request" },
      { file: `${RUNTIME}/production-wiring.test.ts`, testName: "R-6c-27 (P7a): a cold listing reports `servable` as `unknown` for a provider nobody has probed, and `present` for the session's own" },
      { file: `${RUNTIME}/production-wiring.test.ts`, testName: "`list_model_families` answers with the session's OWN active set" },
    ],
  },
  {
    id: "WS13c-SM1",
    spec: WS13C,
    bullet: "parent on `gpt` spawns a child with `sonnet` → parent `set_model` to a `claude` model → `SendMessage` resumes the child → the child's effective model and provider are unchanged",
    status: "new",
    citations: [
      { file: `${RUNTIME}/subagents/cross-family-resume.test.ts`, testName: "WS13c-SM1: a claude-slot child resumed after the parent moved to claude keeps its own provider and model" },
      { file: `${RUNTIME}/subagents/cross-family-resume.test.ts`, testName: "WS13c-SM1 (P-D sub-case): the parent switching onto the child's OWN model key resumes the child on its own provider, never a refusal" },
      { file: `${RUNTIME}/subagents/cross-family-resume.test.ts`, testName: "Fix round 1 (coordinator follow-up): recordModelEffort stamps BOTH effectiveProvider and slot from the child's own materialised identity, and omits both keys entirely when absent" },
    ],
  },
  {
    id: "WS13c-SM2",
    spec: WS13C,
    bullet: "the mirror (parent on `claude`, child on `luna`, parent switches to `gpt`)",
    status: "new",
    citations: [
      { file: `${RUNTIME}/subagents/cross-family-resume.test.ts`, testName: "WS13c-SM2: the mirror -- a luna child resumed after the parent moved from claude to gpt" },
      { file: `${RUNTIME}/subagents/cross-family-resume.test.ts`, testName: "WS13c-SM2 (P-D sub-case mirror): a claude parent switching onto its luna child's own key resumes that child on openai" },
    ],
  },
  {
    id: "WS13c-SM3",
    spec: WS13C,
    bullet: "the child's provider credential removed between spawn and resume → typed refusal, the parent's turn continues",
    status: "new",
    citations: [
      { file: `${RUNTIME}/subagents/cross-family-resume.test.ts`, testName: "WS13c-SM3: a child whose provider lost its credential is a typed refusal on resume, never the parent's provider (a REFUSED re-resolution)" },
      { file: `${RUNTIME}/subagents/cross-family-resume.test.ts`, testName: "WS13c-SM3: a child whose provider lost its credential is a typed refusal on resume, never the parent's provider (an UNRESOLVABLE re-resolution)" },
    ],
  },
  {
    id: "WS13c-8",
    spec: WS13C,
    bullet:
      "catalog integrity: families data generated with zero drift; every row has `modelFamily`/`canonicalModelId`; the normaliser's fixtures (`DeepSeek-V4-Pro`, `us.anthropic.claude-opus-5-v1:0`, `claude-haiku-4-5-20251001`, `openai/gpt-oss-120b`, `MiniMax-M3`); slot rows exist; reserved names; no currency in descriptions",
    status: "new",
    citations: [
      { file: `${CATALOG}/extract/pipeline.test.ts`, testName: "`buildCatalog()` and `mergeLayers(...)` produce the identical catalog" },
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "every model row carries a non-empty `modelFamily` and `canonicalModelId`" },
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "the normaliser reproduces these LIVE rows, including the one that needs an overlay override" },
      { file: `${CATALOG}/families.test.ts`, testName: "canonicalModelIdOf — the provider's spelling removed, the vendor identity kept" },
      { file: `${CATALOG}/extract/catalog-integrity.test.ts`, testName: "every slot's canonical id resolves to at least one SERVABLE row" },
    ],
    note: "The fourth citation is a `describe` title rather than a `test`: it is the block whose `test.each` table carries all five of the bullet's own fixture strings (including `us.anthropic.claude-opus-5-v1:0`, the one the third citation's live-catalog proof does not reach), so citing it names the whole table rather than one arbitrarily-chosen row of it. Reserved names and 'no currency in descriptions' are catalog-level checks proven in `validate.test.ts`'s WS-13c block (`slot-name-reserved`, `slot-description-currency`; see WS13c-2's own citations for the reserved-name half) — not re-cited here to stay inside the 5-citation budget.",
  },
  {
    id: "WS13c-9",
    spec: WS13C,
    bullet: "D28 in Winter alone: a `claude` slot resolves only to `anthropic` with an api-key or Console OAuth credential; a claude.ai OAuth credential ref never serves it",
    status: "new",
    citations: [
      { file: `${RUNTIME}/production-wiring.test.ts`, testName: "the resolver reaches the real catalog: `opus` from a non-claude session resolves into the claude family's vendor row" },
      { file: `${RUNTIME}/production-wiring.test.ts`, testName: "the credential view learns from the child-provider probe, and a slot nothing can serve becomes slot-unservable" },
      { file: `${PROVIDER_RUNTIME}/adapters/anthropic/console-oauth.test.ts`, testName: "D13/D14: the CONSOLE host is what D20 speaks to — the consumer subscription host appears nowhere in the shipped constants" },
      { file: `${RUNTIME}/provider/credential-api.test.ts`, testName: "`anthropic` runs the Console PKCE login and answers with the ref the record now occupies" },
    ],
    note: "\"Resolves only to anthropic\" is §4 step 3-i's VENDOR-LEADS rule, not an exclusion of every other provider: the shipped catalog carries other rows for `claude-opus-5` too (the second citation's own `rows.length` assertion is `toBeGreaterThan(1)`), and they serve the slot when `anthropic` is disabled or unpreferred — a different, legal path §4 already covers (WS13c-5). What D28 actually excludes is a CREDENTIAL KIND the resolver never even sees: `hasCredential` is presence-only, and the third/fourth citations pin that Winter's own credential surface for `anthropic` can only ever be populated by an api-key or by Winter's OWN Console OAuth flow — never by a claude.ai (consumer subscription) credential, for which this repository has no acquisition path and no storable shape under any provider id. No test asks the resolver for a claude.ai-flavoured credential BY NAME, because there is no such `CredentialMaterial` to construct; these four, spanning `runtime` and `provider-runtime`, are the closest real proof and the ones the plan's own self-review pointed at.",
  },
];


// --- Phase 7a: BRAND, ADVISOR, PACKAGING ---------------------------------------------------------
//
// P7a amends WS-00/WS-02/WS-03/WS-06/WS-13b/WS-13c rather than replacing any of them, so its rows
// live in this same table under the same guards -- the fifth spec group to do so (after WS-13b and
// WS-13c). The authority for each bullet is named in the constant below.
//
// EVERY CITATION IS AN EXISTING TEST, and where a bullet has both a mechanism and a wiring, both are
// cited: the pattern this phase's own whole-branch review named is a derivation that is unit-proven
// and never threaded, which one citation apiece would have described as covered.
const WS7A = "WS-7a (brand/advisor/packaging)";

const PHASE_7A_ROWS: ConformanceRow[] = [
  {
    id: "WS7a-1",
    spec: WS7A,
    bullet: "brand defaults byte-identical: under `WINTER_BRAND` every derived name, every rendered profile and every byte on the wire equals the pre-brand build",
    status: "new",
    citations: [
      { file: `${SDK}/brand.test.ts`, testName: "resolveBrand() with nothing returns exactly WINTER_BRAND" },
      { file: `${SDK}/brand.test.ts`, testName: "every field carries WS-01 §2's own literal" },
      { file: `${RUNTIME}/brand-rebrand.test.ts`, testName: "under the DEFAULT profile every derivation is byte-identical to Winter's own names" },
      { file: `${RUNTIME}/sandbox/profile.test.ts`, testName: "the ENTIRE rendered profile is byte-identical to the pre-derivation build under the default brand" },
    ],
    note: "The wire half is the `differential` goldens and `verify:compiled`, which are SCRIPTS rather than named tests and so cannot be cited in this table's `{file, testName}` shape; they run as their own gates (`bun run differential` — 28/28 — and `bun run verify:compiled`). The four citations here are the ones a machine can verify by name: the profile object, its literal table, the whole-derivation default check through the real wiring, and the sandbox profile rendered byte-for-byte.",
  },
  {
    id: "WS7a-2",
    spec: WS7A,
    bullet: "the `acme` rebrand end to end: home, project dir, instructions file, env prefix, keychain service, MCP server name, preset, codex originator, temp root, plugin manifest dir",
    status: "new",
    citations: [
      { file: `${RUNTIME}/brand-rebrand.test.ts`, testName: "`ACME_HOME` resolves the session's home, and `WINTER_HOME` beside it is IGNORED" },
      { file: `${RUNTIME}/brand-rebrand.test.ts`, testName: "the user and project instructions files are `ACME.md`; a `WINTER.md` beside them is not read" },
      { file: `${RUNTIME}/brand-rebrand.test.ts`, testName: "the standing server's canonical twins are advertised as `mcp__acme__*`, and `dispose()` gives the names back" },
      { file: `${RUNTIME}/brand-rebrand.test.ts`, testName: "the codex `originator` and the `User-Agent` on the WIRE are the reuser's, not Winter's" },
      { file: `${RUNTIME}/brand-rebrand.test.ts`, testName: "R-7a-8: the keychain store and the cross-provider `authRef` read ONE source -- `com.acme.core`" },
      { file: `${RUNTIME}/brand-rebrand.test.ts`, testName: "the shared temp root is `<realpath of /tmp>/acme-<uid>` -- computed as a STRING, never created" },
      { file: `${RUNTIME}/brand-rebrand.test.ts`, testName: "the preset's NAME follows the brand; its TEXT does not move by one byte" },
      { file: `${RUNTIME}/brand-rebrand.test.ts`, testName: "P7a fix r1 (I-3): a plugin whose manifest lives in `.acme-plugin/` is DISCOVERED through the production path" },
      { file: `${SDK}/sessions.test.ts`, testName: "P7a (I-1): a BRANDED call reads the brand's own home, and an unbranded call reads Winter's" },
    ],
    note: "`processLabel` is deliberately absent: the spine recorded it as inert in this package (it names the PUBLISHED artifact's executable, not the host's product), so a fixture asserting it moved would assert a change nothing makes. The last citation is the fix wave's own I-1: the sdk's nine standalone session functions run OUTSIDE a query and had no way to learn a brand at all, so they addressed Winter's store for every reuser.",
  },
  {
    id: "WS7a-3",
    spec: WS7A,
    bullet: "no brand-derived env name is read at module load, and no non-test source spells a Winter-owned literal (the sweep gate, rules 1-10)",
    status: "new",
    citations: [
      { file: `${RUNTIME}/brand-gate.test.ts`, testName: "no NEW file carries a raw Winter-owned literal" },
      { file: `${RUNTIME}/brand-gate.test.ts`, testName: "BASELINE_ALLOWLIST is EMPTY -- every lane's debt is discharged" },
      { file: `${RUNTIME}/brand-gate.test.ts`, testName: "FLAGS a module-load read inside a TOP-LEVEL OBJECT LITERAL (the r1 plant)" },
      { file: `${RUNTIME}/brand-gate.test.ts`, testName: "does NOT flag the same read inside a function body" },
      { file: `${RUNTIME}/brand-gate.test.ts`, testName: "every raw rule fires on its own literal and not on a near miss" },
      { file: `${RUNTIME}/brand-gate.test.ts`, testName: "no UNJUSTIFIED brand-less call site exists" },
    ],
    note: "The last citation is the fix wave's item 12, and it covers the shape the gate's first ten rules structurally cannot see: a value DERIVED from `WINTER_BRAND` at module load, or a brand-taking function called without its brand. Every survivor the whole-branch review found was that shape and none of them spelled a literal.",
  },
  {
    id: "WS7a-4",
    spec: WS7A,
    bullet: "the advisor is a bare NATIVE tool, and its reviewer resolves option > setting > per-family default (gpt -> astra, claude -> fable, any other family -> its slot 1)",
    status: "new",
    citations: [
      { file: `${RUNTIME}/tools/conformance.test.ts`, testName: "WS-06 §6 obligation 5 (D29): advisor is a bare NATIVE name with an identical descriptor across every permission mode" },
      { file: `${RUNTIME}/provider/advisor-route.test.ts`, testName: "`Options.advisor.model` wins over `settings.advisor.model` AND over the family default" },
      { file: `${RUNTIME}/provider/advisor-route.test.ts`, testName: "`settings.advisor.model` wins over the family default" },
      { file: `${RUNTIME}/provider/advisor-route.test.ts`, testName: "a gpt session with no setting reviews with astra -- openai/gpt-6-astra when only the API key is configured" },
      { file: `${RUNTIME}/provider/advisor-route.test.ts`, testName: "a claude session with no setting reviews with fable -- anthropic/claude-fable-5-1" },
      { file: `${RUNTIME}/provider/advisor-route.test.ts`, testName: "any OTHER family falls to its slot 1, by position and not by strength" },
      { file: `${RUNTIME}/provider/advisor-route.test.ts`, testName: "D30's family defaults are pinned BY NAME, not read off slot 1 -- a re-ranked gpt family still reviews with astra" },
      { file: `${RUNTIME}/permissions/evaluator.test.ts`, testName: "a user-tier DENY rule refuses the call, even under bypassPermissions" },
    ],
    note: "The last citation is the fix wave's M-4: WS-06 §4 requires the tool to be rule-addressable under its bare name, which the spine's report REASONED held (the `startsWith(\"mcp__\")` sites key on the name) with no test anywhere asserting it.",
  },
  {
    id: "WS7a-5",
    spec: WS7A,
    bullet: "the advisor never substitutes: a stated-but-unresolvable reviewer is a typed refusal, and a resolution failure is an ordinary tool error that never blocks the turn",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/advisor-route.test.ts`, testName: "a stated-but-unresolvable value is a REFUSAL, never a slide down to the next source" },
      { file: `${RUNTIME}/provider/advisor-route.test.ts`, testName: "an unresolvable `Options.advisor.model` refuses too, and names the OPTION as the source" },
      { file: `${RUNTIME}/provider/advisor-route.test.ts`, testName: "a disabled provider is a refusal that says so, not a fall-through to another vendor" },
      { file: `${RUNTIME}/tools/impl/advisor.test.ts`, testName: "no reviewer resolvable -> ordinary tool error, never throws" },
      { file: `${RUNTIME}/tools/impl/advisor.test.ts`, testName: "resolveReviewer throwing is caught as an ordinary tool error" },
    ],
  },
  {
    id: "WS7a-6",
    spec: WS7A,
    bullet: "the publish pipeline packs, scans the TARBALL's contents, and imports every publishable package's every declared exports subpath from a real installed tarball",
    status: "new",
    citations: [
      { file: `${SCRIPTS}/release-pack.test.ts`, testName: "the publishable set is exactly R-7-1's five JS packages PLUS the darwin-arm64 platform package (P9a-3) -- excludes only the private runtime" },
      { file: `${SCRIPTS}/release-pack.test.ts`, testName: "catches all seven categories in one pass over one fixture" },
      { file: `${SCRIPTS}/release-pack.test.ts`, testName: "P7a fix wave (item 9): NO tarball ships a test file -- verified via `tar -tzf`, independently of the scanner" },
      { file: `${SCRIPTS}/smoke-installed.test.ts`, testName: "every publishable package's OWN exports map is fully covered -- no subpath silently skipped" },
      { file: `${SCRIPTS}/smoke-installed.test.ts`, testName: "every target imports cleanly -- this is the exact check that would have caught review r1's two Criticals" },
      { file: `${SCRIPTS}/build-packages.test.ts`, testName: "every entry emits BOTH a .js and a .d.ts, at the path its manifest condition names (bin-only packages emit none)" },
    ],
    note: "The last citation is the fix wave's item 1 (R-7a-16 reversed): every manifest now points its `default` condition at a compiled emit, so `pack-smoke-node18` is a BLOCKING gate rather than the advisory carry it shipped as. The Node leg asserts what each package DECLARES through `engines` -- `@yanlinglabs/winter-provider-conformance` is Bun-only by construction (`Bun.serve` loopback fakes) and declares `engines.bun` alone.",
  },
  {
    id: "WS7a-7",
    spec: WS7A,
    bullet: "the release trigger set is pinned to `v*` tags plus `workflow_dispatch`; a phase tag can never publish, and no other workflow publishes at all",
    status: "new",
    citations: [
      { file: `${SCRIPTS}/release-gates.test.ts`, testName: "the parsed `on:` block is EXACTLY { push: { tags: [\\\"v*\\\"] }, workflow_dispatch: {} }" },
      { file: `${SCRIPTS}/release-gates.test.ts`, testName: "no `push: branches` trigger -- a plain branch push must never publish" },
      { file: `${SCRIPTS}/release-gates.test.ts`, testName: "every OTHER workflow file's actual command text never runs pnpm/npm publish" },
      { file: `${SCRIPTS}/release-gates.test.ts`, testName: "the check above is discriminating, not vacuously true: it DOES flag a publish command when one is present" },
      { file: `${SCRIPTS}/release-gates.test.ts`, testName: "scripts/smoke-installed.ts (which packs + scans internally) runs as a gate BEFORE the publish step" },
    ],
    note: "A `phase-*` tag matches neither trigger, which is what makes \"no task in this plan publishes anything\" mechanical rather than procedural. NOTHING in this phase has published: the first publish is the user's decision.",
  },
  {
    id: "WS7a-8",
    spec: WS7A,
    bullet: "endpoint provenance: a copied reviewed endpoint carries `endpointOrigin: \"reviewed\"` and keeps the privileged set; a `requiresUserEndpoint` row refuses with a typed `endpoint-required` and never a throw",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/endpoint-origin.test.ts`, testName: "the catalog's copied endpoint is `reviewed`; an operator's own is `user`" },
      { file: `${RUNTIME}/provider/endpoint-origin.test.ts`, testName: "the host's `user-agent` does NOT reach a reviewed vendor endpoint, and its `x-goog-quota-project` DOES" },
      { file: `${RUNTIME}/provider/endpoint-origin.test.ts`, testName: "the SHIPPED `ollama-local` row is stamped `reviewed` and `local` — the local cohort is the M-1 closure's largest blast radius" },
      { file: `${RUNTIME}/provider/endpoint-origin.test.ts`, testName: "absent → the typed `endpoint-required` refusal, naming the template, and NOTHING is ever requested" },
      { file: `${RUNTIME}/provider/endpoint-origin.test.ts`, testName: "a CROSS-PROVIDER slot switch onto a per-tenant row refuses -- `{refused, code: \\\"endpoint-required\\\"}`, no throw" },
      { file: `${CATALOG}/validate.test.ts`, testName: "ACCEPTS the shape the two shipped rows use: `requiresUserEndpoint: true`, a template, and an empty `defaultEndpoints`" },
      { file: `${CATALOG}/validate.test.ts`, testName: "a `requiresUserEndpoint` row with NO `endpointTemplate` is refused — the refusal has nothing to name" },
    ],
    note: "The fifth citation is the fix wave's item 4: every RESOLUTION branch of `resolveModelSwitch` already returned a typed refusal, and then the two calls that MATERIALISE the target could still throw past all of them -- which a `set_model` onto azure-ai/oci does.",
  },
  {
    id: "WS7a-9",
    spec: WS7A,
    bullet: "`ModelFamilyListing.servable` is the tri-state `present`/`absent`/`unknown`, and `unknown` is never rendered as `absent`",
    status: "new",
    citations: [
      { file: `${RUNTIME}/provider/family-listing.test.ts`, testName: "families carry their slots and every model grouped by canonical id with per-row servable states" },
      { file: `${RUNTIME}/provider/family-listing.test.ts`, testName: "P7a: the third state is not synthesised here -- every row reports exactly what the predicate said" },
      { file: `${RUNTIME}/production-wiring.test.ts`, testName: "R-6c-27 (P7a): a cold listing reports `servable` as `unknown` for a provider nobody has probed, and `present` for the session's own" },
    ],
  },
  {
    id: "WS7a-10",
    spec: WS7A,
    bullet: "PROVENANCE.md's admission-tier census is GENERATED from the shipped catalog, with a drift check and a named script",
    status: "new",
    citations: [
      { file: `${SCRIPTS}/provenance-tiers.test.ts`, testName: "PROVENANCE.md's census is exactly what a fresh render produces" },
      { file: `${SCRIPTS}/provenance-tiers.test.ts`, testName: "every tier in the vocabulary gets a row, including one with no members" },
      { file: `${SCRIPTS}/provenance-tiers.test.ts`, testName: "`provenance:tiers` is a root script pointing at this generator" },
      { file: `${SCRIPTS}/provenance-tiers.test.ts`, testName: "no CI step runs this generator -- the drift gate is the test above, and there is only one of it" },
    ],
    note: "The drift gate is the FIRST citation, running under the repository's own `bun test` in CI -- not a second CI step. The fix wave (item 3) added the named script for a contributor who has just regenerated the catalog, and the last citation makes that reduction enforceable in the place someone would look before adding one.",
  },
];

const ALL_ROWS: ConformanceRow[] = [...CATALOG_ROWS, ...ADAPTER_ROWS, ...INTEGRATION_ROWS, ...FIX_WAVE_ROWS, ...WIDENING_ROWS, ...MODEL_FAMILIES_ROWS, ...PHASE_7A_ROWS];

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
    // P6.5 adds a fourth: WS-13b amends WS-13 rather than replacing it, so its rows live in this
    // same table and under this same set of guards. P6.6 adds a fifth the same way: WS-13c amends
    // WS-01/WS-03/WS-06/WS-10/WS-13 rather than replacing any of them. `"WS-13b …"` sorts before
    // `"WS-13c …"` (`"b"` < `"c"`), so WS13C is last.
    // P7a adds a sixth the same way (WS-00 D19/D19a, WS-06 D29/D30, WS-02/WS-03's own "Execution
    // amendments -- Phase 7a", WS-13b §10's Phase 7a bullet, WS-13c §7). `"WS-7a …"` sorts after the
    // `"WS-13…"` strings (`"7"` > `"1"`), so WS7A is last.
    expect([...groups].sort()).toEqual(["WS-13 §13 (adapter)", "WS-13 §13 (catalog)", "WS-13 §13 (integration)", WS13B, WS13C, WS7A]);
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
