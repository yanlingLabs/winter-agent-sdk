# `@yanlinglabs/winter-provider-runtime`

Winter's provider layer: the adapter registry, the shipped provider adapters (OpenAI Responses and
Chat Completions, Anthropic Messages, Google generateContent, Bedrock Converse, the OAuth-backed
codex/xAI/Console flows), the credential-ref surface, endpoint policy, retry/stall handling and the
honest-identity headers every request carries.

This package is published to GitHub Packages under restricted access (`@yanlinglabs` scope). The
registry is chosen by the release workflow, not by a committed pin — see [RELEASING.md](https://github.com/yanlingLabs/winter-agent-sdk/blob/main/RELEASING.md).

## What it ships

| Import | What it is |
| --- | --- |
| `@yanlinglabs/winter-provider-runtime` | The full barrel: the registry, the adapters, credential refs and stores, endpoint policy, the error taxonomy, and the identity surface. |
| `@yanlinglabs/winter-provider-runtime/testing` | Test-support helpers a consumer's own adapter tests need: descriptor/context builders, the SigV4 and event-stream primitives, the loopback OAuth/chat fakes, and the fixture catalog. |

## Install

A **supported library** as of 0.0.56: a host with its own agent loop -- in-process, under Node 18+ or
Bun, on any platform -- installs this package and `@yanlinglabs/winter-provider-catalog` and nothing
else. It depends on the catalog alone: it does not pull in `@yanlinglabs/winter-agent-sdk` or the
compiled `winter` runtime binary (a release gate packs both packages, installs them offline, and refuses
any other package in the tree). The wrapper `@yanlinglabs/winter-agent-sdk` spawns the `winter` runtime
rather than importing this package, so a consumer of the wrapper never needs it.

### From public npm (anyone)

```sh
npm install @yanlinglabs/winter-provider-runtime
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
literal in the file. Then `npm install @yanlinglabs/winter-provider-runtime` as usual.

**The published packages contain COMPILED OUTPUT ONLY.** Each tarball ships `dist/` — the bundled
JavaScript a consumer imports and the `.d.ts` declarations their type-checker reads — plus its data
files, `README.md` and `LICENSE`. It does **not** ship `src/`: the TypeScript sources live at
<https://github.com/yanlingLabs/winter-agent-sdk>, which is where to read them, file an issue, or send
a patch.

## Supported public API and versioning (0.0.56)

**What is supported.** Every name exported from the two entry points below, with the types they
declare, is this package's public API. Anything reached by a deep path (`dist/...`) is not.

| Entry point | Supported for |
| --- | --- |
| `@yanlinglabs/winter-provider-runtime` | Production use. The pieces a host's own agent loop is built from: `createRegistry` / `resolve` and `createShippedAdapters`; `ProviderAdapter.streamTurn` with `TurnRequest` and the `ProviderEvent` stream; the stream assembler `foldProviderStream` (with its `StreamAssemblySink` -- `onTextDelta` for an SSE forwarder), `assembledToMessage`, `stampNativeState` and `ProviderStreamError`; `createHistoryRenderer` and `stripOpaque`; `estimateCostUsd` and `pricingTierFor`; the credential stores (`createEnvCredentialStore`, `createMemoryCredentialStore`, `createFileCredentialStore`, `createCompositeCredentialStore`); `withRetry` / `createRetryPolicy`; the error helpers (`isProviderError`, `normalizeThrown`, `parseRetryAfterMs`, `ProviderRequestError`) and the `ProviderErrorCode` taxonomy (0.0.57: `billing` -- the account cannot pay -- beside `rate_limit`, `auth`, `bad_request` and the rest); and the identity surface (`setWinterIdentity`, `activeWinterIdentity`, `winterUserAgent`, `WINTER_DEFAULT_IDENTITY`). |
| `@yanlinglabs/winter-provider-runtime/testing` | Tests only. `createFakeProviderAdapter` with `fakeTextTurn` / `fakeToolCallTurn` / `fakeErrorTurn` (runs under Node and Bun), plus the fixture helpers Winter's own conformance harness uses. Supported, but a helper here may change shape in any release that says so. |

**How versions move.** Both provider packages are released in lockstep with the rest of this repository,
from one `VERSION`, and every release has a `CHANGELOG.md` entry. While versions are `0.0.x`:

- a release may ADD exports, optional `TurnRequest` fields, optional result fields and `ProviderEvent`
  fields, catalog rows and optional catalog fields at any time -- a host that ignores unknown fields is
  never broken by one;
- a change that can break a host using the supported surface -- a removed or renamed export, a changed
  signature, a field made required, a narrowed union, a changed default, a catalog row removed or
  renamed -- ships only under a **"Breaking for provider-package hosts"** heading in that release's
  CHANGELOG entry, naming each affected export and what to do instead;
- a supported export is **deprecated** (documented as such in the CHANGELOG and its doc comment) for at
  least one release before it is removed, unless the removal closes a security problem;
- catalog DATA (prices, limits, efforts) tracks the vendors and changes in any release; the row KEYS a
  host stores are covered by the rules above.

Pin an exact version (`"@yanlinglabs/winter-provider-runtime": "0.0.56"`) and read the CHANGELOG entry
before moving it. The two packages must be the same version.

**`stripOpaque`** is part of the supported surface: `stripOpaque(message)` returns the message's content
with every opaque provider artefact removed -- in-dialect `thinking` / `redacted_thinking` blocks and
anything else only the producing model can read -- and object identity preserved when there was nothing
to strip. A host copying kept turns into a new context (a compaction epoch) uses it so no signed state
travels past the conversation it was minted for.

## A host's agent loop, in brief

```ts
import { createRegistry, createShippedAdapters, createHistoryRenderer, createEnvCredentialStore, foldProviderStream, assembledToMessage, estimateCostUsd, setWinterIdentity } from "@yanlinglabs/winter-provider-runtime";
import type { ProviderContext, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";

setWinterIdentity({ product: "example-host", codexOriginator: "example-host", contactUrl: "https://example.com/contact", version: "1.0.0" });
const catalog = loadCatalog();
const registry = createRegistry(catalog);
for (const adapter of createShippedAdapters(catalog)) registry.register(adapter);
const renderer = createHistoryRenderer(registry);

const resolved = registry.resolve({ model: "anthropic/claude-haiku-5.5", provider: { providerId: "openrouter" } });
if (!("adapter" in resolved)) throw resolved;
const origin = { providerId: resolved.providerId, modelKey: resolved.modelKey, family: resolved.adapter.family, ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}) };
const ctx: ProviderContext = { connection: { providerId: "openrouter" }, credentials: createEnvCredentialStore({ env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } }), authRef: { kind: "env", name: "OPENROUTER_API_KEY" }, stallTimeoutMs: 60_000, log: () => {} };

const history: ProviderMessageLike[] = [{ role: "user", content: "Hello" }];
const messages = renderer.render(history, new Map(), { ...origin, readableState: "none" });
const turn = await foldProviderStream(resolved.adapter.streamTurn({ model: resolved.providerModelId, messages }, ctx), { sink: { onTextDelta: (text) => process.stdout.write(text) } });
history.push(assembledToMessage(turn, origin));
const cost = estimateCostUsd(turn.usage ?? { inputTokens: 0, outputTokens: 0 }, resolved.descriptor);
```

`setWinterIdentity` puts the host's own product on every request's `User-Agent` (`example-host/1.0.0`)
instead of Winter's; it validates what it is given (a lowercase product token, a codex originator that is
never a first party, an https contact URL, a plain version token) and throws `TypeError` otherwise.

### Type-checking under Node: `skipLibCheck`, or `@types/bun`

One shipped declaration names a Bun type: `AnthropicConsoleBrokerOptions.spawn?: typeof Bun.spawn`
(`dist/adapters/anthropic/console-broker.d.ts`, the host-brokered Console login, which needs Bun anyway --
see the next section). A Node project whose `tsconfig` has `skipLibCheck: false` and no Bun types gets
`TS2868: Cannot find name 'Bun'` from that file, even if it never imports the Console broker. Set
`"skipLibCheck": true` (what `tsc --init` writes for a new project), or add `@types/bun` as a dev
dependency. Nothing at runtime depends on it.

## Bun-only surface

This package declares `engines.node` and every entry point **imports** cleanly under Node 18+ (the
compiled emit under `dist/` is what a non-Bun runtime resolves, via each export's `default`
condition; Bun resolves the `bun` condition and gets the TypeScript source unchanged). Importable is
not the same as runnable on every path — these exports need the Bun runtime:

| Function | Import | Needs | Why |
| --- | --- | --- | --- |
| `startCodexLogin()` | `@yanlinglabs/winter-provider-runtime` | `Bun.serve` | The authorization-code flow receives the vendor's redirect on `127.0.0.1`, which needs a real HTTP listener. |
| `startXaiOauthFake()` | `@yanlinglabs/winter-provider-runtime/testing` | `Bun.serve` | Binds a loopback server on `127.0.0.1:0` to stand in for the vendor. |
| `startXaiChatFake()` | `@yanlinglabs/winter-provider-runtime/testing` | `Bun.serve` | Same. |
| `startAnthropicConsoleBrokerLogin()` | `@yanlinglabs/winter-provider-runtime` | `Bun.spawn` | Spawns Anthropic's own `ant` binary (`auth login`) and pipes its stdin/stdout/stderr for the host-brokered Console login (P10a-1 amendment) — never a loopback listener, since this SDK is not itself a party to the OAuth exchange. |
| `refreshAnthropicBearer()` | `@yanlinglabs/winter-provider-runtime` | `Bun.spawn` | Spawns `ant auth print-credentials` to mint the native provider's bearer token from the profile the login above wrote. |
| `logoutAnthropicConsole()` | `@yanlinglabs/winter-provider-runtime` | `Bun.spawn` | Spawns `ant auth logout`. |

(`startCodexLogin()` and the two loopback fakes go through one `runLoginFlow`/`Bun.serve` seam, which
is not on either barrel and which a consumer cannot call. The Console-broker trio is a SEPARATE
mechanism — each of the three guards itself directly, with no shared seam, since spawning a
subprocess and piping its stdio is a different shape from opening a listener.)

**`startAnthropicConsoleLogin()` is RETIRED (P10a-1, 2026-09-13)**: the derived PKCE login it ran —
re-implementing Claude Code's private OAuth client — was deleted after the platform refused its grant
for every derivable request shape. Console OAuth is host-brokered now, through the three functions
above; this SDK must never re-implement the OAuth protocol itself again.

Each throws `BunRequiredError` (exported from both barrels) as its FIRST action — before any network
call, file write or credential read — naming the function, the Bun API and what to do instead. Catch
it by identity:

```ts
import { startCodexLogin, BunRequiredError } from "@yanlinglabs/winter-provider-runtime";

try {
  await startCodexLogin(store, options);
} catch (err) {
  if (err instanceof BunRequiredError) {
    // Complete the login in a Bun process, then pass the resulting credential ref to this session.
  }
  throw err;
}
```

### `BunRequiredError` is THIS package's own class

`@yanlinglabs/winter-conformance` exports a class with the same name and shape, and the two are
deliberately **not** the same type — the packages share no dependency, so there is no module either
could import it from. **Catch the one you imported.** Within this package it is one type across every
subpath: an error thrown by `./testing`'s fakes satisfies `instanceof BunRequiredError` imported from
the main barrel, and vice versa, under Node as well as Bun (the compiled emit gives each export entry
its own bundle, so the class carries a package-scoped `Symbol.for` brand to make that hold).

**`startXaiLogin()` is NOT on this list**, deliberately: xAI's login is RFC 8628 device-code, which is
`fetch` and polling only — no listener, no spawn — so it runs under Node like the rest of the package.

Everything else — the registry, every adapter's `streamTurn`, discovery, the credential stores, the
endpoint policy and the identity helpers — is plain Node-compatible code over `fetch` and `node:*`.

## License

MIT — see [`LICENSE`](./LICENSE), which ships in the published tarball.

This package's xAI OAuth provider derives its client id, endpoints, scope set and request field names
from the Apache-2.0 licensed `xai-org/grok-build`; that attribution is in [`NOTICE`](./NOTICE), which
ships in the tarball beside this file.
