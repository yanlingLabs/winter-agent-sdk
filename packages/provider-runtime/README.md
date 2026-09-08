# `@yanlinglabs/winter-provider-runtime`

Winter's provider layer: the adapter registry, the shipped provider adapters (OpenAI Responses and
Chat Completions, Anthropic Messages, Google generateContent, Bedrock Converse, the OAuth-backed
codex/xAI/Console flows), the credential-ref surface, endpoint policy, retry/stall handling and the
honest-identity headers every request carries.

This package is published to GitHub Packages under restricted access (`@yanlinglabs` scope) — see the
repository root `.npmrc` and `package.json` `publishConfig` for the registry pin.

## What it ships

| Import | What it is |
| --- | --- |
| `@yanlinglabs/winter-provider-runtime` | The full barrel: the registry, the adapters, credential refs and stores, endpoint policy, the error taxonomy, and the identity surface. |
| `@yanlinglabs/winter-provider-runtime/testing` | Test-support helpers a consumer's own adapter tests need: descriptor/context builders, the SigV4 and event-stream primitives, the loopback OAuth/chat fakes, and the fixture catalog. |

## Bun-only surface

This package declares `engines.node` and every entry point **imports** cleanly under Node 18+ (the
compiled emit under `dist/` is what a non-Bun runtime resolves, via each export's `default`
condition; Bun resolves the `bun` condition and gets the TypeScript source unchanged). Importable is
not the same as runnable on every path — these exports need the Bun runtime:

| Function | Import | Needs | Why |
| --- | --- | --- | --- |
| `startCodexLogin()` | `@yanlinglabs/winter-provider-runtime` | `Bun.serve` | The authorization-code flow receives the vendor's redirect on `127.0.0.1`, which needs a real HTTP listener. |
| `startAnthropicConsoleLogin()` | `@yanlinglabs/winter-provider-runtime` | `Bun.serve` | Same flow, same listener. |
| `runLoginFlow()` | `@yanlinglabs/winter-provider-runtime/testing`'s siblings (internal; the two above are its callers) | `Bun.serve` | The one place this package opens a loopback listener. |
| `startXaiOauthFake()` | `@yanlinglabs/winter-provider-runtime/testing` | `Bun.serve` | Binds a loopback server on `127.0.0.1:0` to stand in for the vendor. |
| `startXaiChatFake()` | `@yanlinglabs/winter-provider-runtime/testing` | `Bun.serve` | Same. |

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

**`startXaiLogin()` is NOT on this list**, deliberately: xAI's login is RFC 8628 device-code, which is
`fetch` and polling only — no listener, no spawn — so it runs under Node like the rest of the package.

Everything else — the registry, every adapter's `streamTurn`, discovery, the credential stores, the
endpoint policy and the identity helpers — is plain Node-compatible code over `fetch` and `node:*`.
