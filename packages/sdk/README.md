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

## Subpaths

The main entry is the wrapper surface above. Two subpaths ship beside it, for hosts that compose
Winter rather than only call it:

**`@yanlinglabs/winter-agent-sdk/messaging`** (since 0.0.2) — the cross-runtime messaging contract
and its router core: addresses, listings, delivery outcomes, the adapter interface, inbound policy,
the `notify_when_idle` subscription store, and the three orchestration functions a host drives them
with. It ships no adapter and no process-level singleton; those are host composition.

**`@yanlinglabs/winter-agent-sdk/tools`** (since 0.0.3) — Winter's default tools, declared and
implemented once:

- `WINTER_DEFAULT_TOOL_DEFINITIONS` — `send_message`, `list_agents`, `read_notifications` and
  `advisor`, each a `WinterToolDefinition` carrying a BARE `toolName`, the official built-in alias
  key in `builtinName`, the description, the schemas and a permission class. No registry policy
  fields: a host supplies its own.
- the native schemas and their bounds (`NATIVE_SEND_MESSAGE_SCHEMA`, `SEND_MESSAGE_TO_MAX` and the
  rest), plus strict acceptors — unknown arguments are refused, `summary` is truncated rather than
  rejected, and a refusal is returned as data the model can correct from, never thrown.
- `MessagingToolPort` + `messagingToolPortFromRuntimeDeps`, and `createMessagingToolHandlers`, which
  turn a messaging world into the three tool handlers over it.
- `createAdvisorToolHandler` and `transcriptSourceForSessionKey`, with the reviewer left to the host
  to resolve.

A host BINDS these under its own names: the Winter runtime registers them as its native built-ins
plus two canonical standing-server twins, and `@yanlinglabs/winter-runtime-sdk` binds the same
definitions under Claude's built-in names. Handlers return `{ text, isError? }` for each host to
wrap in its own result shape.

## License

MIT — see [`LICENSE`](./LICENSE), which ships in the published tarball.
