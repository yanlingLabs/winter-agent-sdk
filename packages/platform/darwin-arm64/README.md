# `@yanlinglabs/winter-agent-sdk-darwin-arm64`

The compiled `winter` runtime binary for macOS on Apple Silicon (`darwin`/`arm64`). This package
ships **no JavaScript API** — it is an `optionalDependency` of
[`@yanlinglabs/winter-agent-sdk`](https://github.com/yanlingLabs/winter-agent-sdk/tree/main/packages/sdk),
which spawns the binary this package installs and speaks to it over Winter's own protocol.

You do not import this package. Installing `@yanlinglabs/winter-agent-sdk` on a matching platform
pulls it in automatically; `resolveRuntimeExecutable` finds it by name and runs its `bin/winter`.

## Install

This package is published to **two registries**, and which one you want depends on who you are. On
any platform other than `darwin`/`arm64`, a package manager that respects `os`/`cpu` skips it
entirely — installing it there is a no-op, not an error.

### From public npm (anyone)

```sh
npm install @yanlinglabs/winter-agent-sdk-darwin-arm64
```

You will not normally run this directly — `npm install @yanlinglabs/winter-agent-sdk` brings it in
as an optional dependency on a matching platform.

### From GitHub Packages (the `yanlingLabs` org)

GitHub Packages needs the scope pointed at it and an authenticated read, even for a public package.
In your project's `.npmrc`:

```
@yanlinglabs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

…with `GITHUB_TOKEN` in the environment — a personal access token carrying `read:packages`, never a
literal in the file. Then `npm install @yanlinglabs/winter-agent-sdk-darwin-arm64` as usual.

**The published package contains COMPILED OUTPUT ONLY.** The tarball ships the compiled `winter`
binary under `bin/winter` — a single-file, dependency-free executable built with
`bun build --compile` from a path-neutral copy of the checkout (it embeds no developer's filesystem
path) — plus `README.md` and `LICENSE`. It does **not** ship any source: the TypeScript that
compiles into this binary lives at <https://github.com/yanlingLabs/winter-agent-sdk>
(`packages/runtime/`), which is where to read it, file an issue, or send a patch.

## What this package IS and IS NOT

- IS: a native binary, gated by `os`/`cpu` so it installs only where it can run.
- IS NOT: an importable module. It declares no `main`, no `types`, no `exports` — only a `bin` entry.
- IS NOT: built by this package itself. The binary is staged at publish time by this repository's own
  CI (`scripts/build-runtime.ts --platform-package`, run on a macOS `arm64` runner) and never on your
  machine.

## License

MIT — see [`LICENSE`](./LICENSE), which ships in the published tarball.
