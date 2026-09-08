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

**This package is published to GitHub Packages only.** It is the provider layer the compiled `winter`
runtime uses; the wrapper a public consumer installs — `@yanlinglabs/winter-agent-sdk` — SPAWNS that
runtime rather than importing this package, so it is not part of what `npm install
@yanlinglabs/winter-agent-sdk` needs. Public npm carries exactly the wrapper and its runtime
dependency closure (`@yanlinglabs/winter-agent-sdk`, `@yanlinglabs/winter-provider-catalog`).

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

## Bun-only surface

This package declares `engines.node` and every entry point **imports** cleanly under Node 18+ (the
compiled emit under `dist/` is what a non-Bun runtime resolves, via each export's `default`
condition; Bun resolves the `bun` condition and gets the TypeScript source unchanged). Importable is
not the same as runnable on every path — these exports need the Bun runtime:

| Function | Import | Needs | Why |
| --- | --- | --- | --- |
| `startCodexLogin()` | `@yanlinglabs/winter-provider-runtime` | `Bun.serve` | The authorization-code flow receives the vendor's redirect on `127.0.0.1`, which needs a real HTTP listener. |
| `startAnthropicConsoleLogin()` | `@yanlinglabs/winter-provider-runtime` | `Bun.serve` | Same flow, same listener. |
| `startXaiOauthFake()` | `@yanlinglabs/winter-provider-runtime/testing` | `Bun.serve` | Binds a loopback server on `127.0.0.1:0` to stand in for the vendor. |
| `startXaiChatFake()` | `@yanlinglabs/winter-provider-runtime/testing` | `Bun.serve` | Same. |

(Internally all four go through one `runLoginFlow`/`Bun.serve` seam, which is not on either barrel
and which a consumer cannot call.)

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
