# `@yanlinglabs/winter-agent-runtime`

Winter's agent engine: the turn loop, the built-in tools, the session store and the provider wiring
that the compiled `winter` binary runs. Most hosts never install this package — they install
`@yanlinglabs/winter-agent-sdk`, whose `query()` spawns that binary.

This package is for a host that wants to run sessions **in its own process** instead. It is Bun-only.

## Install

This package is published to **two registries**, and which one you want depends on who you are.

### From public npm (anyone)

```sh
npm install @yanlinglabs/winter-agent-runtime
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
literal in the file. Then `npm install @yanlinglabs/winter-agent-runtime` as usual.

**The published packages contain COMPILED OUTPUT ONLY.** Each tarball ships `dist/` — the bundled
JavaScript a consumer imports and the `.d.ts` declarations their type-checker reads — plus
`README.md`, `NOTICE` and `LICENSE`. The TypeScript sources live at
<https://github.com/yanlingLabs/winter-agent-sdk>, which is where to read them, file an issue, or send
a patch.

This package, `@yanlinglabs/winter-agent-sdk` and its platform binary package are released together
at one version, and each pins the others exactly.

## Embedding a session

The runtime keeps per-process state (its tool registry, MCP executors, background-task table), so
each session needs its own JavaScript realm: run one session per Bun `Worker`.

- `@yanlinglabs/winter-agent-runtime/embedded-host` — `spawnEmbeddedWorker(...)` constructs the Worker
  and returns a `SpawnedRuntimeProcess`. Hand it to `query()` through `Options.spawnClaudeCodeProcess`.
  The frames on the wire are exactly the ones the spawned binary writes. This module does not load
  the engine, so it is safe to import on a host's main thread.
- `@yanlinglabs/winter-agent-runtime/embedded-worker` — the Worker entry. A compiled
  (`bun build --compile`) host passes its own one-line worker file as an extra entrypoint and
  constructs the Worker from that file's plain relative path.
- `@yanlinglabs/winter-agent-runtime/embedded` — `runEmbeddedSession(...)`, one session with every
  process global (argv, env, stdio, exit) as a parameter.
- `@yanlinglabs/winter-agent-runtime/workflow-worker` — the Workflow tool's sandboxed worker entry,
  for a host that routes its own binary's argv to it.
- `@yanlinglabs/winter-agent-runtime/version` — `RUNTIME_VERSION`, with no other imports. A host
  should check that it equals the wrapper's `SDK_VERSION` before it runs a session.

## License

MIT — see [`LICENSE`](./LICENSE), which ships in the published tarball.
