# Provenance — how `generated/catalog.json` came to exist

## Layers

The committed catalog is the merge of at most two layers, performed by
`scripts/provider-catalog.ts` (`bun run provider:catalog`):

| Layer | Source | Owner | Present today |
| --- | --- | --- | --- |
| upstream | `generated/upstream-layer.json`, extracted from the pinned OmniRoute tree by `scripts/provider-source-sync.ts` | Lane X | **no** |
| overlay | `overlay/providers.json` + `overlay/models.json`, hand-authored and reviewed | the spine, then Lane X | yes |

**The overlay always wins.** WS-13 §7: live discovery and upstream extraction never silently
overwrite `official-doc`/`live-probe` overlay entries, so a conflicting upstream row is dropped in
the overlay's favour rather than merged field-by-field. Rows are then sorted by `id`/`key` so a
regeneration is byte-identical — `bun run provider:catalog -- --check` is that gate, and it is
WS-13 §13's own "byte-identical regeneration from the same commit+extractor" acceptance test.

## The current catalog is a SEED, and says so in two independent places

1. `catalogVersion: "0.0.0-seed"`.
2. `upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" }` —
   every pin field is the empty string, and each provider row's own `upstream.commit` is likewise
   empty.

The schema has no top-level "this is a seed" boolean and deliberately gains none: a marker the
schema does not know about is a marker a consumer can ignore. Both signals above are ordinary,
required, schema-checked fields, so a consumer that reads the pin at all cannot miss them.

It was hand-authored from Winter's own specifications — WS-13 §12's cohort list and §4's shapes —
plus two citable in-repo sources, never from any vendor page:

- **Anthropic** row ids, aliases and effort vocabulary: this repository's own
  `packages/conformance/compat/anthropic/0.3.250/derived-shapes-p6.md`, captures (F) and (J). The
  `haiku` row deliberately carries **no** `reasoning` block, mirroring capture (J)'s finding that its
  capability booleans are *absent*, not `false` — absent means unknown, and the catalog records
  unknown by omission for exactly the same reason.
- **codex-oauth** context window, vision and completion event: Norma's
  `packages/core/src/providers/codex-config.ts` (a dated static set with its own drift guard) and
  `responses-sse.ts`.

Everything else carries `source: "upstream-static"`, `confidence: "inferred"`. That is the schema
working as designed: an unverified claim is recorded *as* unverified rather than omitted or dressed
up, and every model row is `status: "candidate"` — promotion to `supported` requires the behavioural
corpus (WS-13 §13), which no row has run.

## Two deliberate seed gaps, disclosed rather than papered over

- **No `pricing` anywhere.** R6-H makes the descriptor's pricing evidence the *only* price source,
  and `costBasis: "list"` is a claim about a real price table. Inventing per-token numbers here would
  launder a guess into that claim. Consequence, exactly as R6-H designs it: `estimateCostUsd` returns
  `{ costUsd: 0, costBasis: "unknown" }` for every seed model, and `maxBudgetUsd` is inert for them
  until Lane X lands real `official-doc` pricing. This is a *disclosed divergence* from R6-9's "the
  overlay carries list prices for the cohort", and closing it is Lane X's.
- **No `classifierEligible: true` anywhere.** R6-14 sets that flag only after the safety corpus
  passes live, so the seed's answer to "may this model serve as the permission classifier?" is no —
  Manual fallback, the fail-safe direction, never a silent weakening.

## Local providers

The twelve local OpenAI-compatible ids (WS-13 §12) are Winter-owned (`upstream.project: "winter"`):
their inventories are machine-specific, so `modelDiscovery: "local"` and `liveCatalogAuthority:
"unknown"` on every one, and live discovery is the real catalog. `defaultEndpoints` records each
project's documented default loopback port purely as a starting point for a connection profile —
`http://` on a loopback address is legitimate here and the endpoint policy admits it as `local`.
Only `ollama-local` carries a seed model row, so the local path has something resolvable for a
fixture; the other eleven intentionally have none, which is what a `liveCatalogAuthority: "unknown"`
provider with an `allowUnlisted` connection is *for*.

## Secrets

`validateCatalog` fails the build on any credential-shaped field name or value anywhere in the
document (`scanForSecrets`), and `validate.test.ts` runs that scan over the committed file. WS-13 §6
is categorical: descriptors never contain secrets.
