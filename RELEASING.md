# Releasing

A release is **two publishes to two registries**, driven by pushing a `v<version>` tag. Nothing here
is optional, and two of the rules exist because getting them wrong cannot be undone: neither GitHub
Packages nor npm lets a version be re-published.

## Pack and publish with **pnpm**, never with plain `npm`

`publishConfig.exports` is a **pnpm feature**. pnpm applies it at pack time — dropping the `bun`
condition, so the published manifest names only `dist/`. npm **ignores** it.

An `npm pack` or `npm publish` of these packages therefore produces a tarball whose manifest still
says `"bun": "./src/index.ts"` while `files` ships no `src/`. Measured: such a tarball installs
cleanly and imports fine **under Node**, and dies under **Bun** with
`Cannot find module '@yanlinglabs/winter-provider-catalog'` — a package that looks healthy everywhere
except the runtime this SDK is built for. The three packages carrying workspace dependencies are
worse still: `workspace:*` survives into the manifest and `npm install` of the tarball is impossible.

Every publishable package therefore declares a `prepack` guard that **refuses a non-pnpm packer** with
that explanation. It runs under `npm pack` and `npm publish`, passes under `pnpm pack`/`pnpm publish`
(which is how `releasePack()` and both release jobs pack), and never runs on a consumer's install —
pnpm strips `scripts` from the packed manifest, so the published package carries no `prepack` at all.

`scripts/publish-npm-set.ts` is the one path that mixes the two deliberately: it **packs** through
`releasePack()` (pnpm, so the overrides apply) and **publishes** the resulting tarballs with
`npm publish`, because pnpm's recursive publish silently drops `--provenance`.

## The two registries

| Registry | Job | Packages | Credential |
| --- | --- | --- | --- |
| GitHub Packages | `publish` | all five | `secrets.GITHUB_TOKEN`, `packages: write` |
| public npm | `publish-npm` | the wrapper and its runtime dependency closure — two today | `secrets.NPM_TOKEN`, `id-token: write` for provenance |

Neither registry is chosen on a command line. `--registry` sets only `registries.default`, and both
pnpm and npm consult the **scope** binding first — a committed `@yanlinglabs:registry` line would
therefore beat it, which is why the project `.npmrc` pins nothing. Each job binds its own scope *and*
credential with `actions/setup-node` (`registry-url` + `scope`), and
`scripts/publish-routing.test.ts` proves the routing with real `npm publish --dry-run` runs.

The npm set is **data** (`winter.publish.npm` per manifest), asserted to equal the wrapper's
transitive workspace `dependencies` closure exactly.

## Before pushing the tag

1. `bun run version:bump` (or `--minor`/`--major`), then `bun run version:sync`, and **commit**.
   `scripts/check-release-version.ts` refuses to publish when the tag, `VERSION` and every publishable
   manifest do not agree — a mismatch does not fail the publish, it *succeeds* at publishing the wrong
   number.
2. Make sure `NPM_TOKEN` exists **before** the tag is pushed. Without it the npm job's publish step is
   skipped, the workflow goes green, GitHub Packages has the version and npm has nothing — and adding
   the secret afterwards ships nothing until a re-drive.
3. Tag `v<version>` and push the tag. Nothing else triggers a publish: the workflow fires only on a
   `v*` tag or a `workflow_dispatch`, so a `phase-*` tag can never publish.

## If a job fails

**Do not bump the version.** Both registries refuse a version they already hold, so a bump would leave
the tag naming something other than what shipped.

Re-drive instead: **`workflow_dispatch` at the same tag ref**. Both jobs ask their own registry which
versions it already has (`scripts/check-already-published.ts` in job 1, the same seam inside
`scripts/publish-npm-set.ts` in job 2) and skip those with a printed line, so the re-drive finishes
the half that failed and reports the half that did not need doing.

A probe that cannot be answered — an auth failure, a network error — is treated as **not published**
and the publish is attempted: the registry refuses a genuine duplicate with a legible 409, whereas
reading an unanswerable probe as "already there" would silently ship four packages instead of five.

## What ships

Compiled output only: `dist/` (bundled JS + `.d.ts`), each package's data files (`generated/`,
`overlay/`, `schema/`, `goldens/`), `README.md`, `LICENSE`, and `NOTICE` where third-party attribution
applies. No `src/` — the sources live in this repository.

`pnpm publish` packs byte-identically to `pnpm pack` (verified: same sha1 for the same tree), which is
what lets `releasePack()`'s scan and the installed-import smoke stand in for the artifact a registry
receives.
