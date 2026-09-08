# winter-agent-sdk

Winter is a from-scratch TypeScript/Bun agent SDK with a drop-in surface: the same option names,
message shapes and ordering as `@anthropic-ai/claude-agent-sdk`, measured against it by a conformance
corpus of committed golden traces rather than asserted in prose.

## Packages

| Package | What it is | Registries |
| --- | --- | --- |
| [`@yanlinglabs/winter-agent-sdk`](packages/sdk) | The wrapper: `query()`, the `Options` surface, session management, settings, the transcript store, the brand profile. | npm + GitHub Packages |
| [`@yanlinglabs/winter-provider-catalog`](packages/provider-catalog) | The provider/model catalog as inert validated data — 165 providers, 604 models, with provenance. | npm + GitHub Packages |
| [`@yanlinglabs/winter-provider-runtime`](packages/provider-runtime) | The provider layer: adapters, credential refs, endpoint policy, retry and identity headers. | npm + GitHub Packages |
| [`@yanlinglabs/winter-conformance`](packages/conformance) | The drop-in conformance corpus: trace normalizer, goldens, pinned-upstream mechanics. | npm + GitHub Packages |
| [`@yanlinglabs/winter-provider-conformance`](packages/provider-conformance) | The provider-layer conformance harness and its loopback fakes. Bun only. | npm + GitHub Packages |

Public npm carries the **closure of two kinds of root**: the wrapper — what
`npm install @yanlinglabs/winter-agent-sdk` needs at run time — and the two conformance harnesses,
which are the org's own test tooling but are consumed out of this repository by the router package
`@yanlinglabs/winter-runtime-sdk`, whose CI would otherwise need a cross-repo token solely to fetch
test fixtures. `@yanlinglabs/winter-provider-runtime` follows by closure: the provider-conformance
harness imports it, and a published manifest pins its dependencies at an exact version.

## Install

### From public npm (anyone)

```sh
npm install @yanlinglabs/winter-agent-sdk
```

Nothing else is needed: the `@yanlinglabs` scope is public on npm.

### From GitHub Packages (the `yanlingLabs` org)

GitHub Packages needs the scope pointed at it and an authenticated read, even for a public package.
In your project's `.npmrc`:

```
@yanlinglabs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

…with `GITHUB_TOKEN` in the environment — a personal access token carrying `read:packages`, never a
literal in the file.

**The published packages contain COMPILED OUTPUT ONLY.** Each tarball ships `dist/` — the bundled
JavaScript a consumer imports and the `.d.ts` declarations their type-checker reads — plus its data
files, `README.md` and `LICENSE`. It does **not** ship `src/`: the TypeScript sources live in this
repository, <https://github.com/yanlingLabs/winter-agent-sdk>, which is where to read them, file an
issue, or send a patch.

## Development

```sh
pnpm install --frozen-lockfile   # never `bun install`
bun run typecheck                # both tsconfigs
bun test                         # the whole suite; run it alone
bun run build:packages           # the compiled emit every published tarball ships
```

In-repo, Bun resolves each package's `bun` export condition and runs the TypeScript **source**
directly — which is why the monorepo needs no build to develop against itself. The `default`
condition (`dist/`) is what a published consumer resolves, and `publishConfig.exports` drops the
`bun` condition from the packed manifest so a tarball never names a path it does not contain.

## Releasing

See [`RELEASING.md`](./RELEASING.md): the packages must be packed and published with **pnpm** (npm
ignores the `publishConfig` overrides and produces a tarball broken for every Bun consumer — a
`prepack` guard refuses it), how the two registries are chosen, the version/tag gate, and the
re-drive procedure when one job fails after the other succeeded.

## License

MIT — see [`LICENSE`](./LICENSE). Every published package ships a copy.

Two `NOTICE` files carry third-party attribution, and they say opposite things on purpose:

- the root [`NOTICE`](./NOTICE) records the Apache-2.0 attribution for `xai-org/grok-build`, from
  which Winter's xAI OAuth provider derives its client id, endpoints, scope set and request field
  names. It ships in the tarballs of the two packages that carry that code —
  `@yanlinglabs/winter-provider-runtime` and `@yanlinglabs/winter-provider-conformance`;
- [`packages/provider-catalog/NOTICE`](packages/provider-catalog/NOTICE) attributes the upstream
  catalog **data**, and states that no file in that package was copied from any upstream project.
  [`PROVENANCE.md`](packages/provider-catalog/PROVENANCE.md) beside it records where every row came
  from and under what evidence.
