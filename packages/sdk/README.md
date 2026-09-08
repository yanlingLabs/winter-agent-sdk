# `@yanlinglabs/winter-agent-sdk`

Winter's wrapper: `query()`, the `Options` surface, the session-management API, settings resolution,
the transcript store and the brand profile. This is the package a host installs by name; it spawns
the compiled `winter` runtime and speaks to it over the pinned protocol.

This is the DROP-IN surface Winter's conformance corpus measures against
`@anthropic-ai/claude-agent-sdk` — same option names, same message shapes, same ordering.

## Install

This package is published to **two registries**, and which one you want depends on who you are.

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
literal in the file. Then `npm install @yanlinglabs/winter-agent-sdk` as usual.

**The published packages contain COMPILED OUTPUT ONLY.** Each tarball ships `dist/` — the bundled
JavaScript a consumer imports and the `.d.ts` declarations their type-checker reads — plus its data
files, `README.md` and `LICENSE`. It does **not** ship `src/`: the TypeScript sources live at
<https://github.com/yanlingLabs/winter-agent-sdk>, which is where to read them, file an issue, or send
a patch.

## License

MIT — see [`LICENSE`](./LICENSE), which ships in the published tarball.
