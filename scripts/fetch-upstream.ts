// THIN CALLER (P7a Lane C, WS-02 §9 Step 2): the real implementation moved to
// `packages/conformance/src/official/fetch.ts` so it is importable from the published
// `@yanlinglabs/winter-conformance` package rather than only reachable by a repo-relative script
// path. This file keeps the `bun run conformance:fetch` CLI entry point and re-exports every name a
// consumer previously imported from here (`gen-declaration-snapshot.ts`, `compile-official-fixture.ts`,
// `capture-official-golden.ts`, `check-derived-shapes.ts` all still `import ... from "./fetch-upstream.ts"`
// unmodified) so none of them needed to change.
import { dirname } from "node:path";
import { rmSync } from "node:fs";

export {
  ChecksumMismatchError,
  verifyDigest,
  verifySha512Integrity,
  resolveCacheDir,
  fetchAndVerifyUpstream,
} from "../packages/conformance/src/official/fetch.ts";
import { fetchAndVerifyUpstream } from "../packages/conformance/src/official/fetch.ts";

if (import.meta.main) {
  // T11 fix-wave: this CLI entry (the `conformance:fetch` script) never passed a cacheDir, so every
  // invocation — a plain manual run, and every `bun run conformance:fetch` in CI — got a fresh,
  // OWNED mkdtemp (resolveCacheDir's `ownedDir: true` branch) that was never cleaned up here,
  // leaking one throwaway tarball directory into the real OS tmpdir per run (pre-existing, ~1 dir/
  // run). Mirrors capture-official-golden.ts's and compile-official-fixture.ts's own
  // `if (ownedDir) rmSync(dirname(tarballPath), ...)` guard — keyed off `ownedDir`, never
  // unconditional, so a future caller that DOES pass a shared cacheDir here still doesn't delete it.
  fetchAndVerifyUpstream()
    .then(({ sha256, tarballPath, ownedDir }) => {
      console.log(`verified upstream ${sha256}`);
      if (ownedDir) rmSync(dirname(tarballPath), { recursive: true, force: true });
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
