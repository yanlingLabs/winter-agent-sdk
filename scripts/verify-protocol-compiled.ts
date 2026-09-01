// Task 5 (WS-02 §7.4) — the compiled-transport gate: `bun run verify:compiled`. Compiles the
// winter runtime to an EPHEMERAL temp path (never the platform package's staged location — this
// script proves the artifact works, it does not publish it) and re-runs the Task-4
// transport-equivalence suite (packages/sdk/src/transport-equivalence.test.ts) with
// WINTER_COMPILED_BIN pointed at that temp binary, so the suite's spawnHook picks up its third
// "compiled" leg and every scenario compares it against the in-memory leg. Mirrors this repo's own
// `bun run verify:workflow`-shaped scripts (differential.ts, gen-declaration-snapshot.ts):
// the compiled artifact is the proof, because dev and compiled paths differ.
//
// Why a fresh `bun test` subprocess rather than importing the suite's exports directly: the suite
// is a bun:test file whose describe/test calls register against the global test runner as a side
// effect of being imported — the only supported way to "run" it a second time with a different env
// is a new `bun test` process, exactly what CI does.
//
// On CI (ubuntu) this compiles a LINUX binary via the direct --out path — the darwin platform
// package is never exercised there (that resolution path has its own darwin-only test instead).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntime } from "./build-runtime.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

if (import.meta.main) {
  const workDir = mkdtempSync(join(tmpdir(), "winter-verify-compiled-"));
  const binPath = join(workDir, "winter");
  try {
    console.log("verify:compiled — compiling the winter runtime to a temp path...");
    await buildRuntime({ out: binPath });

    console.log(`verify:compiled — running the transport-equivalence suite with WINTER_COMPILED_BIN=${binPath} ...`);
    const proc = Bun.spawn([process.execPath, "test", "packages/sdk/src/transport-equivalence.test.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, WINTER_COMPILED_BIN: binPath },
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error(`verify:compiled FAILED (bun test exit ${exitCode})`);
      process.exit(exitCode);
    }
    console.log("verify:compiled OK — the compiled winter binary matches the in-memory transport on every equivalence scenario");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
