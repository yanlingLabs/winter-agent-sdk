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
      { file: `${CORPUS}/xai-oauth.test.ts`, testName: "R6b-7: the reversion SWITCH works on this row" },
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

const ALL_ROWS: ConformanceRow[] = [...CATALOG_ROWS, ...ADAPTER_ROWS, ...INTEGRATION_ROWS, ...FIX_WAVE_ROWS, ...WIDENING_ROWS];

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
    // same table and under this same set of guards.
    expect([...groups].sort()).toEqual(["WS-13 §13 (adapter)", "WS-13 §13 (catalog)", "WS-13 §13 (integration)", WS13B]);
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
