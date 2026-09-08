# `@yanlinglabs/winter-conformance`

Winter's SDK compatibility corpus: a trace normalizer, a set of committed golden traces, and the
pinned-upstream ("official SDK") mechanics that back Winter's compatibility claim against
`@anthropic-ai/claude-agent-sdk@0.3.250` (see [WS-02](../../../docs/superpowers/specs/winter/WS-02-repo-and-packaging.md)
in the `winter-agent-sdk` repository for the full spec, if you have it checked out).

This package is published to GitHub Packages under restricted access (`@yanlinglabs` scope) — see
the repository root `.npmrc` and `package.json` `publishConfig` for the registry pin.

## What it ships

| Import | What it is |
| --- | --- |
| `@yanlinglabs/winter-conformance` | The full barrel: everything below, in one import. |
| `@yanlinglabs/winter-conformance/trace` | `normalizeTrace`, `compareTraces`, and the `ConformanceTraceEntry` type — strips volatile fields (session ids, timestamps, durations, costs) from a captured SDK message trace and diffs two normalized traces. |
| `@yanlinglabs/winter-conformance/official` | The pinned-upstream mechanics: `fetchAndVerifyUpstream` (checksum-verified ephemeral fetch of the pinned official wrapper tarball) and `runCapture` (the `RUN_OFFICIAL_CAPTURE=1`-gated differential-signal harness). |

Goldens (`goldens/*.trace.json`) ship as data alongside `src/` — load them with `loadGolden`,
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
is excluded from every published tarball; only `src/` and `goldens/` ship (see this package's
`package.json` `files` field). The `runCapture()` harness under `./official` never writes a golden
file or persists anything from a live capture run; it prints a report for a human to read.

## Runtime notes

`./trace` is plain, dependency-free TypeScript and is the one subpath this repository's own CI
proves importable under both Node 18 and Bun (the `pack-smoke` job, WS-02 §9 Step 3). The top-level
barrel and `./official` additionally pull in `./official/capture.ts`, which calls `Bun.spawn` (to
install the pinned official SDK into a throwaway npm prefix) — only inside `runCapture()`'s own
function body, never at module load, so importing the barrel itself never requires Bun; actually
*calling* `runCapture()` does.
