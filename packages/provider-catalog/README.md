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

**The published tarballs contain `src/`.** Alongside the compiled `dist/` a consumer resolves, every
package ships its own TypeScript sources: Bun resolves them directly through the `bun` export
condition, and they are readable by anyone who installs the package. Nothing in them is private —
but treat these packages as source-visible, because they are.
