# `@yanlinglabs/winter-provider-catalog`

Winter's provider and model catalog as inert, validated DATA: 165 provider rows and 604 model rows
with their endpoints, auth kinds, pricing evidence, admission tier and provenance, plus the validator
and the vocabularies the JSON Schema restates.

No network, no filesystem, no Bun API — the catalog is a bundled JSON module import, which is what
lets it be decoded anywhere. `PROVENANCE.md` records where every row came from and under what
evidence; `bun run provenance:tiers -- --check` regenerates its census from the shipped data.

## Install

This package is published to **two registries**, and which one you want depends on who you are.

### From public npm (anyone)

```sh
npm install @yanlinglabs/winter-provider-catalog
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
literal in the file. Then `npm install @yanlinglabs/winter-provider-catalog` as usual.

**The published packages contain COMPILED OUTPUT ONLY.** Each tarball ships `dist/` — the bundled
JavaScript a consumer imports and the `.d.ts` declarations their type-checker reads — plus its data
files, `README.md` and `LICENSE`. It does **not** ship `src/`: the TypeScript sources live at
<https://github.com/yanlingLabs/winter-agent-sdk>, which is where to read them, file an issue, or send
a patch.

## License

MIT — see [`LICENSE`](./LICENSE), which ships in the published tarball.

Third-party attribution for the upstream catalog data this package derives from is in [`NOTICE`](./NOTICE), which ships in the tarball beside this file.
