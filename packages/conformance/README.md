# `@yanlinglabs/winter-conformance`

Winter's SDK compatibility corpus: a trace normalizer, a set of committed golden traces, and the
pinned-upstream ("official SDK") mechanics that back Winter's compatibility claim against
`@anthropic-ai/claude-agent-sdk@0.3.250` (see [WS-02](../../../docs/superpowers/specs/winter/WS-02-repo-and-packaging.md)
in the `winter-agent-sdk` repository for the full spec, if you have it checked out).

This package is published to GitHub Packages under restricted access (`@yanlinglabs` scope) — see
the repository root `.npmrc` and `package.json` `publishConfig` for the registry pin.

## Install

**This package is published to GitHub Packages only** — it is one of the org's own test harnesses, not
part of what a public consumer installs. (Public npm carries exactly the wrapper and its runtime
dependency closure — `@yanlinglabs/winter-agent-sdk` and `@yanlinglabs/winter-provider-catalog`.
`@yanlinglabs/winter-provider-runtime` is GitHub Packages only too: the wrapper SPAWNS the compiled
runtime rather than importing it.)

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

## What it ships

| Import | What it is |
| --- | --- |
| `@yanlinglabs/winter-conformance` | The full barrel: everything below, in one import. |
| `@yanlinglabs/winter-conformance/trace` | `normalizeTrace`, `compareTraces`, and the `ConformanceTraceEntry` type — strips volatile fields (session ids, timestamps, durations, costs) from a captured SDK message trace and diffs two normalized traces. |
| `@yanlinglabs/winter-conformance/official` | The pinned-upstream mechanics: `fetchAndVerifyUpstream` (checksum-verified ephemeral fetch of the pinned official wrapper tarball) and `runCapture` (the `RUN_OFFICIAL_CAPTURE=1`-gated differential-signal harness). |

## Bun-only surface

This package declares `engines.node` and every entry point **imports** cleanly under Node 18+ (the
compiled emit under `dist/` is what a non-Bun runtime resolves, via each export's `default`
condition; Bun resolves the `bun` condition and gets the TypeScript source unchanged). Importable is
not the same as runnable on every path — one exported function needs the Bun runtime:

| Function | Import | Needs | Why |
| --- | --- | --- | --- |
| `runCapture()` | `@yanlinglabs/winter-conformance`, `@yanlinglabs/winter-conformance/official` | `Bun.spawn`, `Bun.serve` | It installs the pinned official SDK into a throwaway npm prefix and drives it against loopback HTTP fakes. |

Called anywhere else it throws `BunRequiredError` (exported from both of those barrels) as its FIRST
action — before the pinned tarball is fetched and before any listener is bound — naming the function,
the Bun API and what to do instead. Catch it by identity:

```ts
import { runCapture, BunRequiredError } from "@yanlinglabs/winter-conformance";

try {
  await runCapture();
} catch (err) {
  if (err instanceof BunRequiredError) { /* run the capture under Bun instead */ }
  throw err;
}
```

### `BunRequiredError` is THIS package's own class

`@yanlinglabs/winter-provider-runtime` exports a class with the same name and shape, and the two are
deliberately **not** the same type — the packages share no dependency, so there is no module either
could import it from. **Catch the one you imported.** Within this package it is one type across every
subpath: an error thrown by `./official`'s `runCapture` satisfies `instanceof BunRequiredError`
imported from the main barrel, and vice versa, under Node as well as Bun. The same holds for
`ChecksumMismatchError` and `OfficialCompatUnavailableError`, which are also exported from both
entries (the compiled emit gives each export entry its own bundle, so each class carries a
package-scoped `Symbol.for` brand to make that hold).

Everything else here — the trace normalizer, the goldens and their loaders, `fetchAndVerifyUpstream`
and the checksum helpers — is plain Node-compatible code. The goldens `runCapture` produces are
ordinary JSON and are readable from Node whoever produced them.

Goldens (`goldens/*.trace.json`) ship as data alongside the compiled `dist/` — load them with `loadGolden`,
`listGoldens`, and `goldenPath` from the main barrel rather than reaching into the installed
package's directory layout by hand.

```ts
import { normalizeTrace, compareTraces, loadGolden } from "@yanlinglabs/winter-conformance";

const golden = loadGolden("plain-query.trace.json");
const fresh = normalizeTrace(await traceMySession());
const diffs = compareTraces(fresh, golden);
```

## What it does NOT ship

Per WS-02 §6 and §9: no Anthropic-derived artifact of any kind (no upstream `.d.ts`, no `sdk.mjs`,
no native binary, no extracted prompt text). `compat/anthropic/0.3.250/` — the derived declaration
digests and independently-authored consumer fixtures this repository uses to prove compatibility —
is excluded from every published tarball; only `dist/` and `goldens/` ship (see this package's
`package.json` `files` field). The `runCapture()` harness under `./official` never writes a golden
file or persists anything from a live capture run; it prints a report for a human to read.

## Runtime notes

`./trace` is plain, dependency-free TypeScript and is the one subpath this repository's own CI
proves importable under both Node 18 and Bun (the `pack-smoke` job, WS-02 §9 Step 3). The top-level
barrel and `./official` additionally pull in `./official/capture.ts`, which calls `Bun.spawn` (to
install the pinned official SDK into a throwaway npm prefix) — only inside `runCapture()`'s own
function body, never at module load, so importing the barrel itself never requires Bun; actually
*calling* `runCapture()` does.

## License

MIT — see [`LICENSE`](./LICENSE), which ships in the published tarball.
