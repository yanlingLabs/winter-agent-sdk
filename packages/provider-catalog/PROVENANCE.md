# Provenance — how `generated/catalog.json` came to exist

## Layers

The committed catalog is the merge of two layers, performed by `scripts/provider-catalog.ts`
(`bun run provider:catalog`):

| Layer | Source | Owner | Present |
| --- | --- | --- | --- |
| upstream | `generated/upstream-layer.json`, extracted from the pinned OmniRoute tree by `scripts/provider-source-sync.ts` | the extractor | **yes** — 7 providers, 54 models |
| overlay | `overlay/providers.json` + `overlay/models.json`, hand-authored and reviewed | Winter | yes — 21 providers, 13 models |

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
| `provider.defaultEndpoints` | copied verbatim | upstream `baseUrl`/`responsesBaseUrl`/`modelsUrl` exactly as written, including the full chat path. A URL carrying userinfo or a query string is dropped and recorded (R6-11) |
| `provider.modelDiscovery` | mechanically normalized | derived from `modelsUrl`/`passthroughModels`; upstream has no such field |
| `provider.liveCatalogAuthority` | mechanically normalized | upstream `liveCatalogAuthoritative` when **stated**; unstated becomes `unknown`, never upstream's `true` default |
| `provider.adapterId` / `provider.family` | local override | the Winter adapter family the protocol routes to; upstream's `executor` never crosses |
| `provider.risk` | local override | the reviewed allowlist row |
| `provider.upstream.{commit,sourcePaths}` | mechanically normalized | the pinned peeled commit and the paths the row was read from |
| `model.key` / `model.providerId` | mechanically normalized | `<winterId>/<upstream model id>` (WS-13 §8.3) |
| `model.upstreamId` / `displayName` / `aliases` | copied verbatim | a duplicate id is dropped **and recorded**, never silently de-duplicated |
| `model.endpoints` | mechanically normalized | the provider's protocol, or the model's own `targetFormat` when it selects Responses within the same family |
| `model.contextWindow` / `maxInputTokens` / `maxOutputTokens` | copied verbatim | `contextLength` (falling back to the provider's `defaultContextLength`), `maxInputTokens`, `maxOutputTokens`; non-positive or non-integer values dropped |
| `model.inputModalities` / `outputModalities` | mechanically normalized | `text` plus `image`/`audio`/`video` from `supportsVision`/`supportsAudio`/`supportsVideo` |
| `model.toolCalling` / `nativeTools` | mechanically normalized | upstream `toolCalling` → `native`/`none`; **absent → `none` at `confidence: "unknown"`** |
| `model.reasoning.{supported,efforts,continuation}` | mechanically normalized | `supportsReasoning` / `supportedThinkingEfforts` / the provider's `reasoningTransport`; an unstated transport becomes `none` |
| `model.unsupportedParameters` | copied verbatim | when it is an accepted literal; `Object.freeze([...])` is a call expression and is rejected |
| `model.status` | local override | every extracted row is `candidate`; upstream presence promotes nothing |
| `*.pricing` | official-doc derived | **overlay only**, from the vendors' pricing pages with the URL and observation instant |
| `*.classifierEligible` | live-probe proven | **never set** by extraction or overlay (R6-14) |
| `reasoning.continuationDomain` / `summaryRequest` / `readableState` / `completionEvent` / `toolLoopRequirement` | official-doc derived | **overlay only**; continuation domain is never inferred from a shared HTTP shape |

### The two judgement calls worth arguing with

**Absent `toolCalling` becomes `none`, not `native`.** Upstream states tool calling on some rows and
not others, and an unstated capability is unknown. `native` is what makes a model agent-eligible, so
inferring it from silence would admit every unproven row to Code/Dispatch/Cowork/Build on a guess —
precisely the silent degradation WS-13 §8.1 prohibits. The cost is that upstream-derived Claude and
GPT rows report `toolCalling: none` until an overlay row or a live probe corrects them; the
confidence marker on each says `unknown` so nobody reads it as a denial.

**`Object.freeze([...])` is rejected like any other call.** "Accept a call when its callee looks
inert" is a rule that decays the first time upstream renames a helper, and the extractor's one
guarantee is that it never evaluates anything. The cost is visible and bounded: `o3`, `o3-mini` and
`o4-mini` lose their upstream `unsupportedParams`, which appear in `generated/rejections.json` under
`unresolved-reference` for a reviewer to see and the overlay to carry with real evidence.

## Endpoints diverge from upstream on purpose

Upstream's `baseUrl` is the full chat path (`https://api.openai.com/v1/chat/completions`); the
overlay's is the API root (`https://api.openai.com/v1`), because Winter's adapters compose paths
themselves. The verbatim upstream values are preserved in `generated/upstream-layer.json`, so the
divergence is visible rather than laundered. It is a **local override**, and the overlay row's
values are the ones that ship.

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
| apikey | 233 | candidate pool — 8 allowlisted, 225 rejected `not-allowlisted` |
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

`generated/rejections.json` carries all 678 rows, each with an exclusion class:

| Class | Rows | What it means |
| --- | ---: | --- |
| `not-allowlisted` | 225 | an api-key provider upstream lists that Winter has not curated (WS-13 §1: presence is never inclusion) |
| `executable-value` | 116 | functions, arrow functions, `Object.freeze(...)`, `new`, and other calls |
| `unresolved-reference` | 79 | an identifier whose declaration is outside the allowlist, or was itself rejected |
| `dynamic-expression` | 51 | template literals with substitutions, property access, computed keys |
| `category-web-cookie` | 35 | browser-session transports, excluded categorically |
| `identity-header` | 30 | vendor client-identity headers — never imported |
| `category-oauth` | 25 | generic OAuth import is rejected; Winter's OAuth providers are Winter-owned rows |
| `unsupported-shape` | 22 | opaque runtime config, request defaults, malformed rows |
| `credential-material` | 19 | OAuth client ids/secrets and literal anonymous API keys |
| `category-local-live-discovery` | 14 | local backends (Winter-owned, live-discovery only) plus the two image systems |
| `category-search` | 14 | not LLM providers |
| `category-no-auth` | 13 | reject by default (WS-13 §1) |
| `category-audio` | 12 | not worker-model providers |
| `unrepresentable-protocol` | 11 | Vertex's `targetFormat: "claude"` rows — see below |
| `url-builder` | 4 | executable URL builders (WS-13 §13's security floor names this exactly) |
| `category-cloud-agent` | 3 | remote agent products |
| `category-upstream-proxy` | 2 | no proxy-of-proxy layer |
| `duplicate-id` | 1 | upstream's second `gpt-4o` |
| `no-registry-entry` | 1 | `azure-openai` — catalogued upstream, with no backend entry |
| `category-system` | 1 | `auto` is routing policy, which this layer bans |

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
