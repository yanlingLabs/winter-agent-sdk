# `@yanlinglabs/winter-provider-conformance`

The provider-layer conformance harness: the shared corpus every OpenAI-, Anthropic-, Google- and
Bedrock-family adapter is asked the same questions through, the continuity and classifier-safety
corpora, and the loopback fakes (`./fakes`) those corpora drive.

**Bun only.** This package declares `engines.bun` and no `engines.node`: its fakes stand up real
loopback HTTP servers with `Bun.serve`, which has no Node equivalent it implements.

## Install

Published to **both** registries. This is one of the org's own test harnesses rather than something a
consumer of the wrapper installs — and it is on public npm deliberately: the router package
`@yanlinglabs/winter-runtime-sdk` lives in its own repository and needs these loopback provider fakes as a dev dependency, and
reaching GitHub Packages from that repository's CI would mean a cross-repo `read:packages` token
whose only purpose is fetching test fixtures.

### From public npm (anyone)

```sh
npm install @yanlinglabs/winter-provider-conformance
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
literal in the file. Then `npm install @yanlinglabs/winter-provider-conformance` as usual.

**The published packages contain COMPILED OUTPUT ONLY.** Each tarball ships `dist/` — the bundled
JavaScript a consumer imports and the `.d.ts` declarations their type-checker reads — plus its data
files, `README.md` and `LICENSE`. It does **not** ship `src/`: the TypeScript sources live at
<https://github.com/yanlingLabs/winter-agent-sdk>, which is where to read them, file an issue, or send
a patch.

## License

MIT — see [`LICENSE`](./LICENSE), which ships in the published tarball.

This package's xAI OAuth fake mirrors the flow Winter's provider derives from the Apache-2.0 licensed
`xai-org/grok-build`; that attribution is in [`NOTICE`](./NOTICE), which ships in the tarball beside
this file.
