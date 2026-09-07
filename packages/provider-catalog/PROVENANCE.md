# Provenance — how `generated/catalog.json` came to exist

## Layers

The committed catalog is the merge of two layers, performed by `scripts/provider-catalog.ts`
(`bun run provider:catalog`):

| Layer | Source | Owner | Present |
| --- | --- | --- | --- |
| upstream | `generated/upstream-layer.json`, extracted from the pinned OmniRoute tree by `scripts/provider-source-sync.ts` | the extractor | **yes** — 106 providers, 540 models |
| overlay | `overlay/providers.json` + `overlay/models.json`, hand-authored and reviewed | Winter | yes — 64 providers, 65 models |

**The overlay always wins.** WS-13 §7: live discovery and upstream extraction never silently
overwrite `official-doc`/`live-probe` overlay entries, so a conflicting upstream row is dropped in
the overlay's favour rather than merged field-by-field. Rows are then sorted by `id`/`key` so a
regeneration is byte-identical.

A re-sync **never writes the overlay**. `scripts/provider-source-sync.ts` has no code path that
opens `overlay/*.json` for writing, it re-reads both files after every run and fails loudly if their
bytes moved, and `src/extract/pipeline.test.ts` proves an edited overlay survives a re-sync
byte-for-byte.

## The pin

```json
{ "tag": "v3.8.50",
  "tagObject": "6f5d4e00e817bc01b2ac16fdd66db3840c296416",
  "commit":    "5458026c216f77a3da68ea49152dc33470cfe2cb" }
```

`6f5d4e00…` is the **annotated tag's own object**, not a commit. The OmniRoute report records it as
"resolving to" v3.8.50, and taking it as the commit would have pinned nothing that a re-tag could
not move: `git clone --depth 1 --branch v3.8.50` prints *"refs/tags/v3.8.50 6f5d4e00… is not a
commit!"* and checks out `5458026c…`. Winter records **both** and refuses to run when either fails
to match (`src/extract/fetch.ts`).

`catalogVersion` is therefore `v3.8.50+winter.1` — the upstream release plus the extractor revision,
the recoverability WS-13 §2 requires. (The spec's illustrative spelling is `3.8.50-winter.1`; the
composed string is the frozen builder's, `${tag}+${extractorVersion}`, and carries the same two
facts.)

## What upstream contributed, and what it did not

Extraction is a **literal walk**, never an evaluation: `src/extract/literal-extractor.ts` hands file
text to the TypeScript parser and reads object/array literals. No upstream module is imported,
loaded, or executed anywhere in this repository, and git itself runs with `core.hooksPath` pointed
at an empty directory so a hostile repository cannot execute either.

309 upstream files were materialized into a scratch checkout that was deleted before the run ended.
**Two** of them exist in this repository: `third_party/omniroute-provider-source/LICENSE` and
`.../NOTICE`, copied verbatim with their blob ids and sha256 recorded in `extraction-manifest.json`.
No executor, translator, or helper source was copied — the NOTICE register says so, and it is empty
of code entries on purpose.

### Field-by-field classification

Report §6 asks for this table; `src/extract/ledgers.ts`'s `FIELD_PROVENANCE` is its machine-readable
twin and a test asserts the two agree, so this document cannot drift away from the mapper.

| Field | Provenance | Note |
| --- | --- | --- |
| `provider.id` | mechanically normalized | upstream id through the allowlist's reviewed `winterId` map — upstream's `gemini` is Winter's `google`; every other id is verbatim |
| `provider.displayName` | copied verbatim | the product-catalog row's `name` |
| `provider.protocols` | mechanically normalized | upstream `format` through a closed map; an unknown format **fails the run** |
| `provider.authKinds` | mechanically normalized | upstream `authType` through a closed map; an unknown auth value **fails the run** |
| `provider.defaultEndpoints` | mechanically normalized | `api` is upstream's `baseUrl` with exactly the path its own `format` names removed (`/chat/completions`, `/responses`, `/v1/messages`, `/v1beta/models`) — the API **root**, and the exact inverse of what every adapter in that family appends to `connection.baseUrl`. Never a trim to an origin. A `default`-executor row whose URL does not end in its format's suffix, or states none, **fails the run**. `bedrock`/`vertex` are exempt and stay verbatim. `responsesBaseUrl`/`modelsUrl` are copied verbatim. A URL carrying userinfo or a query string is dropped and recorded (R6-11) |
| `provider.modelDiscovery` | mechanically normalized | derived from `modelsUrl`/`passthroughModels`; upstream has no such field |
| `provider.liveCatalogAuthority` | mechanically normalized | upstream `liveCatalogAuthoritative` when **stated**; unstated becomes `unknown`, never upstream's `true` default |
| `provider.adapterId` / `provider.family` | local override | the Winter adapter family the protocol routes to; upstream's `executor` never crosses |
| `provider.risk` | local override | the reviewed allowlist row |
| `provider.upstream.{commit,sourcePaths}` | mechanically normalized | the pinned peeled commit and the paths the row was read from |
| `model.key` / `model.providerId` | mechanically normalized | `<winterId>/<upstream model id>` (WS-13 §8.3) |
| `model.upstreamId` | copied verbatim, **except** a reviewed correction | verbatim unless `allowlist.json`'s `modelOverrides` names it (today: OpenRouter's `auto` → `openrouter/auto`). Every correction is a `reviewed-normalization` ledger row, and the upstream spelling survives as an alias |
| `model.displayName` / `model.aliases` | copied verbatim | a duplicate id is dropped **and recorded**, never silently de-duplicated |
| `model.endpoints` | mechanically normalized | the provider's protocol, or the model's own `targetFormat` when it selects Responses within the same family |
| `model.contextWindow` / `model.maxInputTokens` / `model.maxOutputTokens` | copied verbatim | `contextLength` (falling back to the provider's `defaultContextLength`), `maxInputTokens`, `maxOutputTokens`; non-positive or non-integer values dropped |
| `model.inputModalities` | mechanically normalized | `text` plus `image`/`audio`/`video` from `supportsVision`/`supportsAudio`/`supportsVideo` |
| `model.outputModalities` | local override (a **Winter default**) | upstream declares NO output modality for any model, so `["text"]` is Winter's inference — see "the output-modality stamp" below |
| `model.toolCalling` / `model.nativeTools` | mechanically normalized | upstream `toolCalling` → `native`/`none`; **absent → `none` at `confidence: "unknown"`** |
| `model.reasoning.{supported,efforts,continuation}` | mechanically normalized | `supportsReasoning` / `supportedThinkingEfforts` / the provider's `reasoningTransport`; an unstated transport becomes `none` |
| `model.unsupportedParameters` | copied verbatim | when it is an accepted literal; `Object.freeze([...])` is a call expression and is rejected |
| `model.status` | local override | `candidate` by default; `experimental` where the allowlist's reviewed `initialModelStatus` says so (R6-16's native cloud, 4 of 53 extracted rows), overridable per row. Never `supported` — upstream presence promotes nothing |
| `*.pricing` | official-doc derived | **overlay only**, from the vendors' pricing pages with the URL and observation instant |
| `*.classifierEligible` | live-probe proven | **never set** by extraction or overlay (R6-14) |
| `reasoning.continuationDomain` / `summaryRequest` / `readableState` / `completionEvent` / `toolLoopRequirement` | official-doc derived | **overlay only**; continuation domain is never inferred from a shared HTTP shape |

### Two tiers of admission citation

Every provider row carries `admission.citation` — the document that admits it (WS-13b §1, D21;
R6b-3 makes a row without one a validation failure, and one citing the audit's `unknown` class a
refusal). The rows do **not** all rest on the same strength of evidence, and conflating the two
tiers would be the quiet failure this field exists to prevent, so they are labelled:

| Tier | What it is | Which rows |
| --- | --- | --- |
| **fetched-document** | a page `docs/research/Provider-third-party-access-audit.md` retrieved and read on 2026-09-06, or a vendor pricing page already reviewed in-repo | the 3 frontier pricing pages, and every P6.5 **overlay** row (the audit's 51 citations) |
| **pinned-upstream** | the vendor's own site as OmniRoute's product catalog records it at commit `5458026`, blob-pinned in `extraction-manifest.json`, plus the api-key path attested by that id's own pinned `RegistryEntry` (`authType: "apikey"`, its dialect, its base URL) | the 107 P6.5 allowlist admissions, and the 5 P6 rows T1 had left citing `spec:WS-13 §1` |

The two tiers above are the two that carry the argument. The full vocabulary has five, and the
CENSUS below is **generated from the shipped catalog** rather than counted by hand — a hand-counted
total in a document that describes a data field is a second, unpinned copy of that field, and it is
the copy a reader trusts. `bun run scripts/provenance-tiers.ts --check` fails when the two disagree.

<!-- BEGIN GENERATED: admission-tier census (bun run scripts/provenance-tiers.ts) -->

Generated from `generated/catalog.json` (`v3.8.50+winter.1`, 165 provider rows). Do not edit by hand.

| Tier | Rows | What it means |
| --- | ---: | --- |
| **fetched-document** | 39 | a vendor page this repository retrieved and read, on a recorded date |
| **pinned-upstream** | 101 | the vendor's own site as the pinned upstream product catalog records it, plus that id's own pinned entry — a real, dated reference, but NOT a page read here |
| **spec-ruling** | 3 | a ruling in an approved spec (or a user ruling recorded in one) admits the PATH; the row's own details are carried from a reviewed ledger entry — `anthropic`, `azure-ai`, `oci` |
| **local** | 12 | a local installation on the operator's own machine — there is no third party to be admitted by — `docker-model-runner`, `lemonade`, `llama-cpp`, `llamafile`, `lm-studio`, `mlx-gemma`, `mlx-qwen`, `ollama-local`, `oobabooga`, `triton`, `vllm`, `xinference` |
| **audit** | 10 | the in-repo third-party-access audit's own findings, which cite the documents it read — `aihorde`, `cline`, `clinepass`, `codex-oauth`, `kilocode`, `moonshot`, `opencode`, `openference`, `uncloseai`, `xai-oauth` |

**Promotion is two-key** (WS-13b §1, fix-wave R-FW-3): a row leaves `pinned-upstream` only when a fetched vendor document AND a live-gate pass both exist, and no `approved` row or `supported` model may sit on that tier while it does not.

<!-- END GENERATED: admission-tier census -->

A pinned-upstream citation is a real, dated, verifiable reference — it names a specific blob at a
verified commit — but it is **not** a page this repository fetched and read, and it is not the
vendor's terms of service. Its own text says so, in every row. Two consequences are deliberate:

* every pinned-upstream row carries `risk.class: "review-required"` with that reason spelled out,
  rather than `approved`. Only `blocked` refuses at resolution (`provider-runtime/src/registry.ts`),
  so the row is usable — but nothing in the catalogue claims a review that did not happen;
* the audit's own `unknown` disposition is a **different and stronger** statement, and it excludes:
  an id whose decisive document was looked for and not found is in `blocked`, not admitted at this
  tier. `codebuddy-cn` is the worked example.

**A citation is checked for LIVENESS, not just for shape (round-1 finding I-3).** Every
`pinned-upstream` citation host was swept with a HEAD, a GET where the host refuses HEAD, and one
retry on 5xx. Eight rows cited something that is not a document and were moved to `blocked` with the
sweep result on the row: three NXDOMAIN (`llamagate`, `monsterapi`, `tokenrouter`), two HTTP 404
(`sumopod`, `token-kiosk`), one persistent 530 (`x5lab`), one HTTP 200 whose entire body is the
string "New API" (`chenzk` — a bare gateway shell), and one permanent redirect to a *different
company's* product page after an acquisition (`predibase` → `rubrik.com`). Two more were repaired
rather than dropped: `cerebras` cited a page that 301s to a chat product and now cites its Inference
API docs, and `zai-anthropic` cited the mainland product site although the lane had fetched z.ai's
own Claude-client doc. A citation is a row's entire evidence, so a citation that resolves to nothing
is a row with no evidence.

**What decision (a) asked for and why it could not be met as written.** The P6.5 plan asked lane X2
to upgrade five `spec:WS-13 §1` citations (`deepseek`, `openrouter`, `azure-openai`, `bedrock`,
`vertex`) "to vendor URLs from the audit's citations". The audit's 51 citations cover the OAuth,
keyless and agent-transport ids it audited; **none of the five appears in it**. They were upgraded to
the pinned-upstream tier instead, which is a real vendor URL and a strict improvement on a `spec:`
self-reference, and this paragraph is the record that the stronger upgrade was unavailable rather
than skipped.

### The two judgement calls worth arguing with

**Absent `toolCalling` becomes `none`, not `native`.** Upstream states tool calling on some rows and
not others, and an unstated capability is unknown. `native` is what makes a model agent-eligible, so
inferring it from silence would admit every unproven row to Code/Dispatch/Cowork/Build on a guess —
precisely the silent degradation WS-13 §8.1 prohibits. The cost is that upstream-derived Claude and
GPT rows report `toolCalling: none` until an overlay row or a live probe corrects them; the
confidence marker on each says `unknown` so nobody reads it as a denial.

**The output-modality stamp says `unknown`, and here is why it cannot say more.** Upstream's
`RegistryModel` has no output-modality field at all, so `["text"]` on every row is Winter's own
inference for a chat registry — not something upstream stated. It was shipped as
`source: "upstream-static", confidence: "inferred"`, which reads as *"upstream said text"*: a false
claim wearing an upstream label, and precisely the thing that let a text-to-speech model into the
catalog looking like a text model. Every row carries `confidence: "unknown"` and a `sourceRef`
that says WINTER DEFAULT in words, and the mapper now also stamps `source: "winter-default"` — the
member added for exactly this (`src/types.ts`), so a reader filtering evidence BY SOURCE no longer
gets a Winter guess wearing an upstream label. The prose stays alongside it, because *why* is not
something an enum can carry.

**That wrinkle is now closed, and how it stayed open is worth recording.** The committed
`generated/upstream-layer.json` is rewritten only by a NETWORK `provider:sync`, which is deliberately
absent from CI (a maintainer action, not a per-push gate). `--offline` re-merges what is on disk and
`provider:catalog` never re-extracts, so when the mapper changed to stamp `winter-default` the
committed layer kept saying `upstream-static`, `catalog.json` inherited it through the merge, and
**neither CI gate could see the gap** — the transition was pinned by a comment rather than by a
regeneration. P6.5 lane X2's first network run performed the sync: 99 evidence rows across the two
generated files moved in one commit, and `provider-source-sync --check` reports byte-identical
regeneration again. The general lesson is the one this document already makes about counts: a
generated file that only one un-gated command can write will drift, and the drift will look exactly
like a comment that is still true.

**It came back once, from another lane, and that is the more useful fact.** Lane O branched before
the fix and authored its two `xai-oauth` model rows on the pre-fix pattern — `upstream-static`, with
the same now-false justification that `EvidenceSource` has no member for a Winter default. Merging it
is what surfaced them, because `catalog-integrity.test.ts`'s I3 case asserts the property over the
MERGED document rather than over one lane's rows. Both were corrected in the merge. The lesson is
not about `xai-oauth`: a convention repaired in one branch is re-introduced by every branch that
forked before the repair, so the guard has to live on the merged artifact, and it did.

**The overlay's fifteen model rows were carrying the same false label, and a stale reason for it.**
Each stamped `outputModalities` as `upstream-static` with a `sourceRef` explaining that
*"`EvidenceSource` is frozen (src/types.ts) with no `winter-derived` member, so the caveat rides the
confidence marker and this ref"*. That was true when those rows were written and false by the time
the member was added — the mapper was updated, the fifteen hand-authored rows were not, and their
own justification went on citing a constraint that no longer existed. All fifteen now stamp
`winter-default` with a ref that says what is actually true. Nothing in the merged catalog claims
upstream stated an output modality any more, from either layer.

**`unsupportedParameters` fails OPEN, and that direction is deliberate.** `toolCalling` fails CLOSED
because a wrong `native` admits an unproven model to the agent modes; an empty
`unsupportedParameters` only means Winter will not *pre-reject* a parameter, and the provider's own
400 is the backstop. But an empty list can mean "upstream states none" OR "upstream states some as an
`Object.freeze([...])` we refuse to evaluate", and the two must not look alike — so every model in
the second case gets its own `unresolved-reference` ledger row naming the model and the consequence.
`openai/o3`, `o3-mini` and `o4-mini` are the ones at this pin — **three** rows, matched by the model's
ARRAY INDEX. The first version of that correlation matched by file, so a single refused field in
`openai/index.ts` produced a ledger row for all nineteen of its models: sixteen false claims, in a
ledger that is read as evidence.

**`Object.freeze([...])` is rejected like any other call.** "Accept a call when its callee looks
inert" is a rule that decays the first time upstream renames a helper, and the extractor's one
guarantee is that it never evaluates anything. The cost is visible and bounded: `o3`, `o3-mini` and
`o4-mini` lose their upstream `unsupportedParams`, which appear in `generated/rejections.json` under
`unresolved-reference` for a reviewer to see and the overlay to carry with real evidence.

## Endpoints diverge from upstream on purpose — and the divergence is now the MAPPER's, not the overlay's

Upstream's `baseUrl` is the full chat path (`https://api.openai.com/v1/chat/completions`). Winter's
adapters compose paths themselves, so what a descriptor must carry is the API **root**
(`https://api.openai.com/v1`). Until P6.5 only the OVERLAY said so: the extractor recorded upstream's
path verbatim and every upstream row was shadowed by a hand-authored overlay row that quietly
corrected it. The two layers therefore disagreed about the shape of this one field for the whole of
P6, and nothing failed — because no unshadowed upstream row had ever reached an adapter.

Widening the catalog is precisely what removes those shadows, so the disagreement was about to
become a hundred-odd rows that 404 at runtime. The mechanism has two links in different packages,
each reasonable on its own:

1. `runtime/src/provider/session-provider.ts`'s `connectionFrom` copies `defaultEndpoints.api` into
   `connection.baseUrl` **as soon as more than one provider shares an adapter id**;
2. the adapter then appends its own protocol path —
   `adapters/openai/chat-completions.ts`: `` `${endpoint.baseUrl}/chat/completions` ``.

Measured against a loopback fake: a row carrying the full path reaches
`/v1/chat/completions/chat/completions`.

So the mapper now records the root, by removing **exactly** the path the row's own upstream `format`
names (`FORMAT_ENDPOINT_SUFFIX` in `src/extract/merge.ts`) — the exact inverse of what the adapter
appends, and nothing more. A URL is still never trimmed to an ORIGIN; a `default`-executor row whose
URL does not end in its format's suffix, or states none at all, **fails the run** rather than
shipping with an absent `api` (an absent one is not inert — `resolveEndpoint` falls back to the
adapter's own vendor default, so the row would send that provider's credential to another vendor).
`bedrock`/`vertex` are exempt: single-provider adapters whose `api` is never copied into a
connection, and whose URLs are region/deployment templates rather than protocol paths.

**The evidence that this is the right transformation, rather than a convenient one:** five
independent human reviews had already performed this exact strip by hand, in `overlay/providers.json`,
before any of this code existed — and the rule reproduces all five byte-for-byte. `pipeline.test.ts`
→ *"THE PROOF THIS IS THE RIGHT TRANSFORM: it reproduces all five hand-authored overlay endpoints"*
pins that, and `runtime/src/provider/catalog-endpoint-shape.test.ts` measures the adapter's half
against a fake rather than describing it.

Every strip is a `reviewed-normalization` ledger row naming both strings, so the divergence stays
visible rather than laundered.

## The denominator (WS-13 §3 step 5)

Recomputed at every run into `generated/denominator.json`. At this pin:

> Enumerated product-catalog union at the pin: 352 distinct provider ids (per-category sum 352, no
> id appears in two categories). Backend REGISTRY entries: 270 (222 resolvable by the literal
> extractor; the remainder are built by a helper CALL, which is never evaluated). 82 catalogued
> id(s) have no backend registry entry; 0 registry id(s) have no product-catalog row. Upstream's own
> claims: README.md=352, docs/reference/PROVIDER_REFERENCE.md=352.

| Category | Ids | Winter disposition |
| --- | ---: | --- |
| noauth | 13 | blocked |
| oauth | 25 | blocked |
| web-cookie | 35 | blocked |
| apikey | 233 | candidate pool — 107 allowlisted, 126 rejected `not-allowlisted`, 0 named individually in `blocked` |
| local | 14 | Winter-owned (12 chat backends; `comfyui`/`sdwebui` excluded as image systems) |
| search | 14 | blocked |
| audio | 12 | blocked |
| upstream-proxy | 2 | blocked |
| cloud-agent | 3 | blocked |
| system | 1 | blocked |

**The 351/352 discrepancy does not reproduce at v3.8.50.** The research report recorded it at the
audited `b7a0c541…` head (declaring 3.8.51); at the pinned tag the enumerated union is 352 and both
of upstream's own claim sources also say 352. What the pin *does* show is a different and larger
gap the report did not name: **270 backend registry entries against 352 catalogued providers**, so
82 catalogued ids — `azure-openai` among them — have no executable entry at all. A catalog count is
not a support count, and at this pin it is not even a routable count.

The obligation is discharged as a standing computation rather than a restated pair of numbers: if a
future bump reintroduces a mismatch, `denominator.json` reports it without anyone editing prose.

## Two findings from the pin that a reviewer should see

**The retirement migrations are ABSENT here.** The report cites migrations `165`–`168` retiring
GPL-derived and provenance-hold integrations (Raycast Relay, Hailuo Web, Felo Web, Qwen Web, ChatGPT
Web). At v3.8.50 the migration series stops at `162`: those retirements landed **after** the pinned
tag. So the corresponding upstream rows are still live in this snapshot, and the only thing keeping
them out of Winter is Winter's own allowlist and category dispositions — not upstream's retirement.
The allowlist keeps the `*retire*`/`*provenance*` path patterns with **zero matches at this pin**
precisely so a future bump picks them up.

**Two verbatim upstream defects were copied as-is and recorded.** Upstream's `openai` entry lists
`gpt-4o` **twice** (the second occurrence is dropped, class `duplicate-id`), and its
`claude-sonnet-4.5` row carries the display name *"Claude Sonnet 4.6"*. The name is copied verbatim
because that is what "copied verbatim" means; correcting it silently would make the catalog
unfalsifiable against its own source.

## What was excluded, and why

`generated/rejections.json` carries all **722** rows. The counts below are generated from the ledger
and pinned by `catalog-integrity.test.ts` → *"PROVENANCE.md's exclusion table matches the ledger,
row for row"*, because a hand-typed count is the line that goes stale first and nobody notices.

| Class | Rows | What it means |
| --- | ---: | --- |
| `not-allowlisted` | 126 | an api-key provider upstream lists that Winter has not curated (WS-13 §1: presence is never inclusion). P6.5 cut this from 225 by admitting 107 through the allowlist and giving **every one of the remaining 126 its own hand-written reason** in `blocked` — a generic class row is not an exclusion anyone can review. That includes the 29 ids whose provider SHIPS as a reviewed overlay row: the class here is still `not-allowlisted` (the mapper stamps it from the id's upstream category, not from why it was kept out), but the REASON on each is the ships-as-an-overlay-row cross-reference `aihorde` and `cline` already carried. **The class name alone never says whether a provider is absent from the catalog** — the reason does |
| `executable-value` | 116 | functions, arrow functions, `Object.freeze(...)`, `new`, and other calls |
| `unresolved-reference` | 82 | an identifier whose declaration is outside the allowlist or was itself rejected — including the **three** models whose `unsupportedParams` could not be read (see below) |
| `dynamic-expression` | 51 | template literals with substitutions, property access, computed keys |
| `category-web-cookie` | 35 | browser-session transports, excluded categorically |
| `identity-header` | 30 | vendor client-identity headers — never imported |
| `category-oauth` | 25 | generic OAuth import is rejected; Winter's OAuth providers are Winter-owned rows |
| `unsupported-shape` | 47 | opaque runtime config, request defaults, malformed rows, and (P6.5) a `modelsUrl`/`responsesBaseUrl` carrying a query string or userinfo — R6-11 drops it rather than trimming, because a URL minus its query is a different request (`fireworks` is the one at this pin) |
| `credential-material` | 19 | OAuth client ids/secrets and literal anonymous API keys |
| `category-local-live-discovery` | 14 | local backends (Winter-owned, live-discovery only) plus the two image systems |
| `category-search` | 14 | not LLM providers |
| `category-no-auth` | 13 | reject by default (WS-13 §1) |
| `category-audio` | 12 | not worker-model providers |
| `unrepresentable-protocol` | 11 | Vertex's `targetFormat: "claude"` rows — see below |
| **`reviewed-normalization`** | 114 | **NOT an exclusion.** A row that DID ship, carrying a reviewed, recorded deviation from the pinned tree: the OpenRouter wire id, the Bedrock executor's protocol, the OpenAI and Vertex adapter overrides, the four Vertex partner statuses, and **one endpoint strip per admitted row** (WS-13b §2 — see "Endpoints diverge from upstream on purpose"), which is now the bulk of the class |
| `url-builder` | 4 | executable URL builders (WS-13 §13's security floor names this exactly) |
| `category-cloud-agent` | 3 | remote agent products |
| `category-upstream-proxy` | 2 | no proxy-of-proxy layer |
| `category-system` | 1 | `auto` is routing policy, which this layer bans |
| `duplicate-id` | 1 | upstream's second `gpt-4o` |
| `no-registry-entry` | 1 | `azure-openai` — catalogued upstream, with no backend entry |
| **`out-of-scope`** | 1 | **`gemini-3.1-flash-tts-preview`** — a TEXT-TO-SPEECH model. WS-13 §4 is a MUST: `tts` rows never feed the worker-model picker, and `scope` is per PROVIDER, so a `gemini` row cannot declare itself `tts` while its provider is `llm`. Excluded through the allowlist's reviewed `modelOverrides`, never a name heuristic — a heuristic would silently drop a future model whose id happened to match |

**`unrepresentable-protocol` is the interesting one.** Upstream's `vertex` entry lists eleven
`claude-*` models with `targetFormat: "claude"` — Claude models served over Vertex's endpoint in the
Anthropic dialect. `WinterProviderDescriptor.protocols` is per-**provider**, and `endpoints`
distinguishes only chat from responses within one family, so nothing in the schema can say "this
model speaks a different dialect from its provider". Emitting those rows anyway would resolve them
onto `winter.google-generate-content` and serialize the wrong dialect on the wire, so they are
refused with the reason recorded. Anthropic-on-Vertex is a recorded carry (R6-16), and a Winter row
for it belongs under a provider whose protocol matches.

## Adapter ids are read from the lanes, not guessed

Every cohort provider row's `adapterId` is the id constant the adapter that serves it actually
exports, read from the lane branches (`git show p6/lane-a:…/adapters/openai/*.ts`,
`git show p6/lane-b:…/adapters/google/*.ts`). Two were wrong, and a registry resolves an adapter **by
that id**, so both were live misroutes rather than cosmetic drift:

- **`vertex` named `winter.google-generate-content`** — the plain Gemini adapter. Lane B's Vertex
  adapter is `winter.vertex-gemini` (`VERTEX_ADAPTER_ID`). A Vertex session would have been served by
  the Gemini API adapter: no location-scoped URL, no ADC credential, and
  `generativelanguage.googleapis.com` on the wire. `family` stays `google` deliberately — Vertex is a
  *transport* over the same GenerateContent mapping (ruling R6-A), not a second dialect.
- **The twelve local rows named `winter.openai-chat-completions`.** They now name
  `winter.local-openai`, the default `createLocalOpenAIAdapter` exports. The old value forced a host
  to register the local adapter *under the chat adapter's id*, which **shadowed** the real Chat
  Completions adapter for `openai`, `openrouter` and `deepseek`. Lane A can drop the `id:` override
  from its wiring line.

- **`openai` derived `winter.openai-chat-completions`** in the upstream layer, from upstream's
  provider-level `format: "openai"` — which names OmniRoute's own default execution path, not the
  surface Winter drives. Six upstream openai rows carry `targetFormat: "openai-responses"` (the
  `*-pro` and GPT-5.6 families are responses-ONLY), so the layer held responses-only models under a
  Chat Completions adapter. The overlay row has said `winter.openai-responses` since the seed, and
  that is precisely what hid it — the merged catalog was consistent while the layer was not. Found
  by running the cross-layer gate over the STANDALONE layer, the same shadow class as Vertex.

`azure-openai` and `vertex` model rows are `experimental` per R6-16 (native cloud enters as
experimental, and both adapters are live). `bedrock` rows stay `candidate`: Lane N has not landed an
adapter, and R6-16's own demotion criterion covers that case. Nothing anywhere is `supported` —
that requires the behavioural corpus (WS-13 §13).

## Reviewed model-id corrections

`allowlist.json`'s `modelIdCorrections` is a hand-maintained map from an upstream model id to the id
the provider documents on its own wire. One entry exists: OpenRouter's auto-router, which upstream
lists as a bare `{ id: "auto" }` while OpenRouter documents `openrouter/auto`. Upstream's spelling
put `auto` on the wire from **both** resolution paths — step 1 (the seeded row's own `upstreamId`)
and the `allowUnlisted` pass-through, which strips a self-prefix — so correcting it at the source
fixes both. The upstream spelling survives as an **alias**, so a caller writing bare `auto` still
reaches the corrected wire id, and no row remains that would send a bare `auto`.

Every correction is written into `generated/rejections.json` with its reason. It is a *mechanical
normalization*, never a silent edit: a reader can diff the catalog against the pinned source and
find the one place they differ, with the justification attached.

## Why `google/gemini-2.5-pro` ships `efforts: []`

Not an omission. Gemini's `generateContent` surface has **no effort vocabulary at all** — thinking is
*budgeted* (`thinkingConfig.thinkingBudget`), not tiered into named levels. WS-13 §8.2 forbids
treating vocabularies as interchangeable, so borrowing OpenAI's `low`/`medium`/`high` here would
invent a control the endpoint does not accept, and the adapter would (correctly) reject the selection
before sending. The row **does** carry `summaryRequest`
(`thinkingConfig.includeThoughts`, `official-doc`, continuity report §6.1), so summaries are
requestable from session start per WS-13 §8.2's proactive-summaries rule; it is only the *effort
tiers* that do not exist. The overlay states this in a `$comment` on the `reasoning` block, but
`scripts/provider-catalog.ts` strips `$comment` keys from the merged catalog — which is why the
reason lives here, where a reader of the shipped artifact can find it.

## Blocked stays blocked

A provider reaches the catalog only through a reviewed edit to
`third_party/omniroute-provider-source/allowlist.json`. The check runs **both ways**: an id the
allowlist admits whose upstream category is not the api-key candidate pool **fails the whole run**
rather than being imported (WS-13 §3 step 7's blocked class transition), and so does a category
change on an already-admitted id. That is what makes "blocked → supported requires an explicit
reviewed allowlist change" a property of the pipeline instead of a promise.

## Pricing

`overlay/models.json` carries list prices for six cohort rows, each with the vendor's own pricing
page as `sourceRef` and the observation instant:

| Model | Input | Output | Cache read | Cache write | Source |
| --- | ---: | ---: | ---: | ---: | --- |
| `openai/gpt-4.1` | 2.00 | 8.00 | 0.50 | — | developers.openai.com/api/docs/pricing |
| `openai/o4-mini` | 1.10 | 4.40 | 0.275 | — | developers.openai.com/api/docs/pricing |
| `anthropic/claude-opus-5` | 5.00 | 25.00 | 0.50 | 6.25 | claude.com/pricing |
| `anthropic/claude-sonnet-5` | 2.00 | 10.00 | 0.20 | 2.50 | claude.com/pricing |
| `anthropic/claude-haiku-4-5-20251001` | 1.00 | 5.00 | 0.10 | 1.25 | claude.com/pricing |
| `google/gemini-2.5-pro` | 1.25 | 10.00 | 0.125 | — | ai.google.dev/gemini-api/docs/pricing |

USD per million tokens. This closes the seed's disclosed gap: `estimateCostUsd` now returns
`costBasis: "list"` for these six, and `maxBudgetUsd` is live for them.

**Two disclosed limits.** (1) Gemini's price is **tiered** — prompts over 200k tokens bill at
$2.50/$15.00/$0.25 — and `ModelPricing` has one rate per direction, so the standard tier is recorded
and cost is **under-reported for prompts above 200k**. That is a schema gap, stated in the row's own
`sourceRef` so it travels with the data. (2) Gateway (`openrouter/*`), Azure-deployment, Bedrock and
Vertex rows are deliberately unpriced: their prices are the reseller's, not the vendor list, and
attributing a vendor price to them would put a number on the wrong billing boundary — the exact
confusion WS-13 §8.3 keeps `openai/gpt-x` and `gateway/gpt-x` apart to avoid. Every upstream-derived
row is unpriced too, by construction: the extractor cannot emit `pricing` at all.

## `classifierEligible` is still absent everywhere

R6-14 sets it only after the safety corpus passes live. The catalog's answer to "may this model
serve as the permission classifier?" therefore remains **no** — Manual fallback, the fail-safe
direction, never a silent weakening.

## The helper-built entries: probed, then admitted or refused individually (round-1 finding I-1)

74 upstream `apikey` ids are built by a **helper call** (`buildOpenAiCompatibleRegistryEntry(...)`)
or a shared constant, which the literal extractor refuses to evaluate — so the pinned tree yields no
endpoint, auth, executor or model list for them, only the product-catalog identity. Round 1 ruled
that carrying all 74 on one generic reason was not good enough: an id is admitted from the **vendor's
own documentation** where one exists, and refused **individually, with the probe result**, where it
does not.

| outcome | n | what it means |
| --- | ---: | --- |
| **admitted** as reviewed overlay rows | **29** | a vendor documentation page was fetched and read on 2026-09-06 **and** it names a fixed API root |
| **admitted** as reviewed **per-tenant** rows (P7a) | **2** | `azure-ai`, `oci`: the endpoint is a per-tenant template, so the row ships **none** and the host supplies one (below) |
| refused — out of **scope** | 14 | image, video, embedding, reranking or web-extraction services. Not held pending a document: more evidence would not admit them |
| refused — **docs reached, no fixed endpoint** | 20 | a docs page answered 200 but states no base URL, or the host answered 403/530, or the vendor documents two hosts and no single base |
| refused — **no public fixed host at all** (enterprise) | 9 | the inference host is per-deployment or per-tenant by design, or no docs page could be reached |

For the 14 admitted from the probe list, **two independent sources agree on the base**: the vendor's
own documentation page, and the base upstream's product catalog states in its `apiHint` at the pin.
Neither was taken on the other's word, and no row was authored from the pinned tree alone —
hand-transcribing a helper call's arguments is precisely the extraction the literal extractor
refuses, so it is not a substitute for the document.

**Three traps, recorded because each looks like an admission until it is read.** `openference-api` is
not a provider: its documentation *is* the shipped `openference` row's documentation, on the same
base — one vendor wearing two ids. `hcnsec` and `helixmind` declare `format: "claude"` with a
`/v1/chat/completions` base, so the entry contradicts its own dialect and neither value can be
trusted; the vendor's doc is the tie-breaker and neither has a readable one. `muse-code` has no
vendor doc at all — its recorded `website` is a GitHub repository URL.

## The per-tenant rows: a row that ships NO endpoint (P7a, WS-13b §2/§10)

`azure-ai` and `oci` have real documented public APIs and were refused through P6.5 for one reason:
`defaultEndpoints.api` is immutable generated data (R6-11) and a per-tenant template
(`https://<resource>.services.ai.azure.com/openai/v1`,
`https://inference.generativeai.<region>.oci.oraclecloud.com/openai/v1`) is not an endpoint. The
round-1 ruling deferred them to "a dedicated host-supplied-endpoint adapter shape". **The user's
ruling of 2026-09-06 replaced that with a user-entered endpoint field**, and P7a ships it:

| field | what it means |
| --- | --- |
| `requiresUserEndpoint: true` | the row ships **no** `api` endpoint at all. The validator refuses one — presence, not shape: a plausible placeholder parses, validates, and would be copied into a connection profile and called |
| `endpointTemplate` | the documented shape, e.g. `https://<resource>.services.ai.azure.com/openai/v1`. **Never sent, never parsed as a URL** — it is documentation, and the only thing the runtime's typed `endpoint-required` refusal has to show a user |

At runtime the host's `connection.baseUrl` is **required** and is evaluated as a **USER** endpoint
(`endpointOrigin: "user"`), so no privileged header ever rides it (WS-13 §5 / R6-L). Absent, the
session refuses before a request exists rather than falling back to the shared adapter's vendor
default — which, for a row on `winter.openai-chat-completions`, would have meant this provider's
credential on the wire to `api.openai.com`.

**Neither row is authored from a fetched page.** Both cite `tier: "spec-ruling"` — the user ruling
admits the *path*, and the template is transcribed verbatim from the id's own P6.5 ledger entry.
This repository has not read `learn.microsoft.com/azure/ai-foundry` or
`oracle.com/artificial-intelligence/generative-ai` for content. Promotion is two-key as everywhere
else: the fetched page (upgrading the citation to `fetched-document`) **and** a live-gate pass
against a real tenant.

**No model rows, and `modelDiscovery: "none"`.** A per-tenant surface serves whatever deployments the
operator created; no document read here enumerates them, and seeding rows would be a claim about
somebody else's tenant. A host reaches models with `allowUnlisted` — both rows are
`liveCatalogAuthority: "unknown"`, which is the door R6-F opens.

## Dialect siblings, and the two keyless rows (P6.5, R6b-5 / WS-13b §8.4)

A provider row carries exactly one `adapterId`, so a vendor that documents **two wire dialects at two
base URLs** is **two rows** — each with its own endpoint, its own model keys and the dialect in its
`displayName`. Four pairs ship:

| OpenAI dialect | Anthropic dialect | Anthropic base URL | Where the pair comes from |
| --- | --- | --- | --- |
| `deepseek` (extracted) | `deepseek-anthropic` (overlay) | `https://api.deepseek.com/anthropic` | vendor guide, retrieved 2026-09-06 |
| `zai` (overlay) | `zai-anthropic` (**extracted**) | `https://api.z.ai/api/anthropic` | vendor docs for both halves, retrieved 2026-09-06 |
| `moonshot` (overlay, token) | `kimi-coding` (overlay, **subscription**) | `https://api.kimi.com/coding` | Kimi Code docs, retrieved 2026-09-06 |
| `minimax` (extracted) | `minimax-anthropic` (overlay) | `https://api.minimax.io/anthropic` | vendor Anthropic-SDK reference, retrieved 2026-09-06 |

The `zai` pair is the one worth reading twice: **upstream's own `zai` entry is the ANTHROPIC one**
(`format: "claude"` at `api.z.ai/api/anthropic/v1/messages`, which z.ai's Claude-client doc confirms
verbatim), so the allowlist admits that id under the `zai-anthropic` **`winterId`** — the same rename
door `gemini` → `google` already uses — and the OpenAI half is the reviewed overlay row. It is also
why `displayNameOverride` exists: upstream's product catalog has one name per vendor ("Z.AI"), and two
rows reading "Z.AI" are two rows a user cannot choose between. The override is a reviewed allowlist
edit, recorded in the ledger like every other normalization, and it is not a licence to rename
providers for taste.

**The Anthropic adapter is multi-provider in fact, and that was measured rather than assumed.**
`runtime/src/provider/catalog-endpoint-shape.test.ts` drives two sibling rows through the real
catalog-resolved adapter against a loopback fake; each reaches its **own** `<root>/v1/messages`.
There is no `providerId === "anthropic"` guard anywhere in `adapters/anthropic/messages.ts`.

**Subscription rows are a billing fact, not a label.** `kimi-coding` and `clinepass` carry
`pricingBasis: "subscription"`, so `priceUsage` returns nothing for them and a session on either
reports no `total_cost_usd`. `clinepass` shares an endpoint **and a key** with the token-priced
`cline` row and is still a separate row, because the basis is per row and that is the whole mechanism.

**The two keyless rows carry no credential, and `aihorde` is the reason to say so explicitly.**
AI Horde documents an anonymous default key. **It is not in this repository** — not in the catalog,
not in an adapter, not in a fixture. The row records only that a documented anonymous default
*exists* and cites the page that names it; supplying it (or, better, a registered key, which buys
queue priority) is the host's act through the ordinary credential path, which is why its `authKinds`
is `api-key` rather than a keyless kind. `catalog-integrity.test.ts` asserts the literal is absent by
name. `uncloseai` needs no credential at all and carries `authKinds: ["custom"]`: `local-none` is
reserved for a **local installation** (the twelve WS-13 §12 rows) and would make `connectionFrom`
stamp `local: true` on a public https host.

## Winter-owned rows

`codex-oauth` (D11) and the twelve local OpenAI-compatible ids (WS-13 §12) carry
`upstream.project: "winter"` and an **empty** commit: no extraction produced them, and the emptiness
is the honest marker. Local inventories are machine-specific, so `modelDiscovery: "local"` and
`liveCatalogAuthority: "unknown"` on every one, and live discovery is the real catalog.
`azure-openai` is the in-between case: it *is* catalogued upstream, so it keeps
`project: "OmniRoute"` and the real commit, but its only `sourcePath` is a product-catalog file and
every endpoint and auth fact on it is Winter-authored.

## Secrets

`validateCatalog` fails the build on any credential-shaped field name or value anywhere in the
document (`scanForSecrets`), and the extractor runs the **same** scan over the raw upstream literals
*before* mapping — a credential that never enters the extraction cannot leak from it, including into
a debug dump no output-side scan would ever see. Field names carrying credential or identity
material (`oauth`, `anonymousApiKey`, `headers`, `extraHeaders`, `defaultHeaders`) are rejected on
sight, whatever their shape. WS-13 §6 is categorical: descriptors never contain secrets.
