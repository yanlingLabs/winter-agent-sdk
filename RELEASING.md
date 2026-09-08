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
| public npm | `publish-npm` | the closure of the wrapper + the two harness roots — all five today | `secrets.NPM_TOKEN`, `id-token: write` for provenance |

Neither registry is chosen on a command line. `--registry` sets only `registries.default`, and both
pnpm and npm consult the **scope** binding first — a committed `@yanlinglabs:registry` line would
therefore beat it, which is why the project `.npmrc` pins nothing. Each job binds its own scope *and*
credential with `actions/setup-node` (`registry-url` + `scope`), and
`scripts/publish-routing.test.ts` proves the routing with real `npm publish --dry-run` runs.

The npm set is **data** (`winter.publish.npm` per manifest), asserted to equal the transitive
workspace `dependencies` closure of the ROOTS: the wrapper, plus every package flagged
`winter.publish.harness` (R-7b-5 — the two conformance harnesses, which the out-of-repo router
package `@yanlinglabs/winter-runtime-sdk` needs as dev dependencies). `winter-provider-runtime` is on
npm by closure, not as a harness: `winter-provider-conformance` imports values from it, and a
published manifest pins its dependencies at an exact version, so a harness on npm whose dependency is
absent is an install that 404s.

Two flags, not one wider flag, because that is what keeps the rule falsifiable: `npm: true` on a
package that is neither a root nor reachable from one is still a refusal, and
`scripts/release-gates.test.ts` shows the rule refusing on synthetic trees rather than only agreeing
on this one. The npm job publishes in **topological order** (`npmPublishOrder`), so npm never serves
a package whose declared dependency is not there yet.

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

Re-drive instead: **`workflow_dispatch` at the same tag ref**.

The two jobs skip already-published versions by **different** mechanisms, and it matters which:

- **Job 2 (npm)** skips through our own seam, inside `scripts/publish-npm-set.ts`: it asks npm per
  package and prints the verdict. Deleting or failing that check changes what is published.
- **Job 1 (GitHub Packages)** skips through **pnpm's own** `isAlreadyPublished`.
  `scripts/check-already-published.ts` in that job only **reports** — it always exits 0, by design —
  so removing it would change the log and nothing else. pnpm's probe swallows every error as "not
  published", which errs toward *publishing*; the registry then refuses a genuine duplicate with a
  409. Safe, but it is not the audited seam, and an operator should not read the report step as the
  gate.

Either way the re-drive finishes the half that failed and reports the half that did not need doing.

A probe that cannot be answered — an auth failure, a network error — is treated as **not published**
and the publish is attempted: the registry refuses a genuine duplicate with a legible 409, whereas
reading an unanswerable probe as "already there" would silently ship four packages instead of five.

## The docs gates are heuristics

Two `release-gates` assertions read the shipped READMEs as prose: "no README may claim a path ships
that `files` excludes", and "no README names a non-npm package as being on npm". Both are regexes over
English, and a regex over English is a heuristic:

- a claim can be *negated in one clause and asserted in another* on the same line;
- a path can be written without backticks;
- a sentence can name a non-npm package near an npm claim in phrasing the pattern does not match.

Round 4 narrowed the negation skip to the matched clause and accepts unbackticked `src/`, which closes
the two evasions the review demonstrated. The class remains: these gates catch the mistakes people
actually make (a stale sentence surviving a rewrite) and cannot prove a README is true. **When you
change what ships, re-read the five package READMEs** — the gate is a net, not a proof.

## What ships

Compiled output only: `dist/` (bundled JS + `.d.ts`), each package's data files (`generated/`,
`overlay/`, `schema/`, `goldens/`), `README.md`, `LICENSE`, and `NOTICE` where third-party attribution
applies. No `src/` — the sources live in this repository.

`pnpm publish` packs byte-identically to `pnpm pack` (verified: same sha1 for the same tree), which is
what lets `releasePack()`'s scan and the installed-import smoke stand in for the artifact a registry
receives.

## Carries for the next release



- **Trusted Publishing.** Both npm packages now exist, so npm Trusted Publishing (OIDC from `release.yml`, configured per package on npmjs.com against this repository and workflow) can replace the long-lived `NPM_TOKEN` secret. Adopt it for the next release, then revoke the token.

- **Job 1's order is pnpm's, not topological.** `pnpm publish -r` may publish a dependent seconds before its dependency on GitHub Packages (the npm job publishes per tarball in dependency order). Accepted for the org's own registry; a per-package loop would fix it at the cost of pnpm's native `publishConfig` handling.
