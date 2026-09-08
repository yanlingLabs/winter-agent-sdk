# `@yanlinglabs/winter-provider-conformance`

The provider-layer conformance harness: the shared corpus every OpenAI-, Anthropic-, Google- and
Bedrock-family adapter is asked the same questions through, the continuity and classifier-safety
corpora, and the loopback fakes (`./fakes`) those corpora drive.

**Bun only.** This package declares `engines.bun` and no `engines.node`: its fakes stand up real
loopback HTTP servers with `Bun.serve`, which has no Node equivalent it implements.

## Install

**This package is published to GitHub Packages only** — it is one of the org's own test harnesses, not
part of what a public consumer installs. (The wrapper and its runtime layer —
`@yanlinglabs/winter-agent-sdk`, `@yanlinglabs/winter-provider-catalog`,
`@yanlinglabs/winter-provider-runtime` — are on public npm as well.)

In your project's `.npmrc`:

```
@yanlinglabs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

…with `GITHUB_TOKEN` in the environment — a personal access token carrying `read:packages`, never a
literal in the file.

**The published packages contain COMPILED OUTPUT ONLY.** Each tarball ships `dist/` — the bundled
JavaScript a consumer imports and the `.d.ts` declarations their type-checker reads — plus its data
files, `README.md` and `LICENSE`. It does **not** ship `src/`: the TypeScript sources live at
<https://github.com/yanlingLabs/winter-agent-sdk>, which is where to read them, file an issue, or send
a patch.

## License

MIT — see [`LICENSE`](./LICENSE), which ships in the published tarball.
