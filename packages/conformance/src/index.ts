// `@yanlinglabs/winter-conformance` — the public barrel (P7a Lane C, WS-02 §9/§3).
//
// This package ships the pieces a CONSUMER of Winter's conformance story needs without cloning this
// repository: the trace normalizer differential.ts already uses to compare a fresh trace against a
// committed golden, loaders for the committed goldens themselves (R-7a-12: they are publishable),
// and the pinned-upstream ("official SDK") mechanics WS-02 §6 describes. The router package
// (`@yanlinglabs/winter-runtime-sdk`, WS-02 §"Execution amendments — Phase 6") consumes this package
// for its own hermetic tests, per the Phase 7a amendment.
//
// Two subpaths exist BESIDE this barrel, each independently importable so a consumer who only wants
// one slice does not pull in the rest:
//   `@yanlinglabs/winter-conformance/trace`    -- just `normalizeTrace`/`compareTraces` (also here).
//   `@yanlinglabs/winter-conformance/official` -- just the fetch/capture mechanics (also here).
// Both subpaths are re-exported from this file too, so `import { normalizeTrace } from
// "@yanlinglabs/winter-conformance"` and the subpath import are equally valid; pick whichever import
// graph a given consumer prefers.
//
// NOTE ON RUNTIME PORTABILITY: `./official/capture.ts` calls `Bun.spawn` (to install the pinned
// official SDK tarball into a throwaway npm prefix) inside a function body, never at module load, so
// merely IMPORTING this barrel never throws under plain Node — only CALLING `runCapture()` would,
// and nothing does that outside `scripts/capture-official-golden.ts`'s own gated CLI entry. The
// dedicated `./trace` subpath remains the one this package's own pack-smoke CI gate proves importable
// under both Node 18 and Bun (WS-02 §9 Step 3); this top-level barrel and `./official` are Bun-first,
// matching the rest of this repo's pinned-upstream tooling.
//
// IMPORTING THIS BARREL PERFORMS NO I/O EITHER (review r1 Critical Finding 1, fixed): `fetch.ts`'s
// pinned checksums used to be read from `compat/anthropic/0.3.250/checksums.json` at MODULE LOAD --
// harmless when this code lived in a never-packaged script, but `compat/` is deliberately excluded
// from this package's own `files` allowlist (R-7a-12), so a real install threw `ENOENT` the instant
// anything imported this barrel or `./official`. The read is now lazy (`getChecksums()`, called only
// from inside `fetchAndVerifyUpstream()`) and throws a typed `OfficialCompatUnavailableError` when
// `compat/` is absent, rather than either eagerly failing at import time or leaking a raw ENOENT.
export { compareTraces, normalizeTrace } from "./trace.ts";
export type { ConformanceTraceEntry } from "./trace.ts";

export { goldenPath, listGoldens, loadGolden } from "./goldens.ts";

export { ChecksumMismatchError, OfficialCompatUnavailableError, fetchAndVerifyUpstream, getChecksums, resolveCacheDir, runCapture, verifyDigest, verifySha512Integrity } from "./official/index.ts";
// P7a fix wave r2 (item 3, re-review N1): `runCapture` above is the one Bun-only export on this
// barrel; this is the typed error it throws off Bun. See the README's "Bun-only surface" section.
export { BunRequiredError, hasBunRuntime, requireBunRuntime } from "./bun-required.ts";
