# `third_party/omniroute-provider-source` — the upstream boundary

This directory is the **boundary marker** for Winter's use of the OmniRoute provider corpus, and it
is deliberately empty of upstream material. Nothing here is vendored, and nothing in this repository
imports, executes, or transitively loads upstream provider code.

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

`allowlist.json` — the extractor's **input contract**: the upstream provider ids Winter is willing to
extract at all, plus the risk class each was reviewed into. It is a hand-maintained, reviewed file:
promoting a provider from `blocked`/`review-required` to `approved` is a deliberate edit with a
reviewer, exactly the "blocked→supported requires reviewed allowlist change" acceptance test in
WS-13 §13.

The extractor itself (`scripts/provider-source-sync.ts`) is **Lane X's** deliverable, not the
spine's. It will fetch the pinned upstream tree into a scratch directory outside the repository,
read only the rows this allowlist names, emit descriptor JSON, and delete the scratch tree. The
fetched tree is never committed here — this file plus `allowlist.json` are the whole of the
directory's committed content, by design.

## Pin

The upstream pin (tag → commit, extractor version) is recorded in
`packages/provider-catalog/UPSTREAM.json`, alongside the generated catalog it produced. The seed
catalog committed by the spine carries an **empty** pin and `catalogVersion: "0.0.0-seed"`: it was
hand-authored from Winter's own specs, not extracted from upstream, and the empty pin is what says
so.
