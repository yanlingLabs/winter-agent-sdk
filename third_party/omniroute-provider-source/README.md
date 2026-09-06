# `third_party/omniroute-provider-source` — the upstream boundary

This directory is the **boundary marker** for Winter's use of the OmniRoute provider corpus. No
upstream *source* is vendored here — the only upstream content in this repository is the pair of
licence/notice texts named under "What lives here", copied verbatim because the licence requires it
— and nothing in this repository imports, executes, or transitively loads upstream provider code.

## What the boundary is

WS-13 §1/§3/§13 draw the line:

- Winter consumes upstream provider data as **inert facts** — ids, endpoint templates, protocol
  family, auth kind, model rows — extracted into `packages/provider-catalog/generated/catalog.json`
  and validated by this repository's own schema before it is committed.
- Winter **never** ships an upstream URL builder, request signer, executor, or any other upstream
  *code path*. WS-13 §13 states the rule as "no executable upstream URL builders" and "a catalog
  entry alone never causes code download or execution". Adapter behaviour is Winter-authored per
  protocol family (WS-13 §5), proven by the behavioural corpus, never ported row-by-row.
- Pure helper files may be copied only with clean per-file provenance and a NOTICE entry
  (`packages/provider-catalog/NOTICE`). No such file exists today; the NOTICE says so explicitly.
- Browser/private/subscription transports are rejected regardless of feasibility, and Claude.ai
  subscription login is categorically **not** a Winter provider (WS-13 §6, D13/D14).

## What lives here

`allowlist.json` — the extractor's **input contract**, in two halves. `paths` is the **versioned
path allowlist** the sparse checkout materializes; the extractor refuses to materialize anything
outside it and never widens the boundary on its own. `providers` is the reviewed intake list: the
upstream provider ids Winter is willing to extract at all, plus the risk class each was reviewed
into. Promoting a provider from `blocked`/`review-required` to `approved`, or adding an id, is a
deliberate edit with a reviewer — exactly the "blocked→supported requires a reviewed allowlist
change" acceptance test in WS-13 §13. `categoryDispositions` encodes WS-13 §1's table as data, and
the check runs both ways: an allowlisted id whose upstream category is not the api-key candidate
pool fails the whole run rather than being imported.

`UPSTREAM.json` — the extractor's **input pin** (repository, tag, annotated-tag object, peeled
commit, and the `observedAt` instant stamped onto every piece of extracted evidence). Distinct from
`packages/provider-catalog/UPSTREAM.json`, which is the **output** pin the catalog builder stamps
onto the merged catalog.

`extraction-manifest.json` — **generated**: every upstream file the extraction materialized, with
git's own blob id, a sha256 of the bytes, and the byte count, split into `copiedFiles` and
`readOnlyFiles`.

`LICENSE` and `NOTICE` — **the only upstream content committed anywhere in this repository**:
OmniRoute's root `LICENSE` (MIT) and its `THIRD_PARTY_NOTICES.md`, both verbatim, both registered in
the manifest above with `modifications: "none"`. The report's §12 requirement is that copied files
carry clean per-file provenance; these two do, and nothing else was copied. The extractor
materializes ~309 upstream files into a scratch checkout **outside** this repository and deletes it
before the run ends — no upstream source tree is ever committed here.

The extractor is `scripts/provider-source-sync.ts` plus
`packages/provider-catalog/src/extract/**`. It fetches the pinned tag with a shallow, blob-filtered,
`--no-checkout` clone; verifies that the tag resolves to the recorded tag object AND peels to the
recorded commit; sparse-checks-out only the allowlisted paths; re-checks every materialized path
against the allowlist after checkout; hashes each one; parses (never evaluates) the TypeScript; and
emits descriptor JSON plus the rejection, provenance and denominator ledgers. `git` itself runs with
`core.hooksPath` pointed at an empty directory and `--template=`, so a hostile repository's hooks
cannot execute during the clone either.

## Pin

The upstream pin is recorded twice, deliberately: `UPSTREAM.json` here is what the extractor
FETCHES, and `packages/provider-catalog/UPSTREAM.json` is what the generated catalog CARRIES.

    tag         v3.8.50
    tag object  6f5d4e00e817bc01b2ac16fdd66db3840c296416   (the ANNOTATED TAG's own object)
    commit      5458026c216f77a3da68ea49152dc33470cfe2cb   (that tag, peeled)

The two are different objects. The OmniRoute report records `6f5d4e00…` as "resolving to" v3.8.50;
it is the tag object, and a pin on it alone would not survive a re-tag. The extractor verifies both
and refuses to run on either mismatch. `catalogVersion` is `v3.8.50+winter.1`, which is how the
upstream release and the Winter extraction revision stay recoverable from a shipped artifact
(WS-13 §2).
