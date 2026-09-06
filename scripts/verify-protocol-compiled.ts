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
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { encodeFrame, splitFrames, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { SCENARIO_FINAL_TEXT, SCENARIO_MODELS, SCENARIO_TOOL_NAME, startScenarioFake } from "winter-agent-runtime";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Phase 6 Task 10: THE CATALOG RESOLVES INSIDE THE BINARY.
 *
 * This is a leg the equivalence suite cannot supply, and the reason is the whole point of the gate.
 * `@yanlinglabs/winter-provider-catalog` imports its data as a BUNDLED JSON MODULE precisely because
 * `bun build --compile` produces a single-file executable whose `$bunfs` has no repository beside it —
 * a runtime path read would resolve to nothing there while type-checking and every dev-mode test
 * passed. That is the exact "silently breaks only in the compiled form" class, and the only way to
 * disprove it is to make a COMPILED session resolve a real catalog row and report what it resolved.
 *
 * Two legs, and the negative one is not decoration: a binary with an EMPTY catalog would refuse every
 * model, which looks identical to a binary with a working catalog refusing an unknown one. So the
 * positive leg asserts the resolved identity field-for-field against the catalog this repo compiled
 * IN, and the negative leg asserts the refusal is `unknown-model` rather than a bundling failure.
 */
async function runCompiledSession(binPath: string, config: Record<string, unknown>, winterHome: string): Promise<{ frames: WinterFrame[]; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([binPath, "--run", "--config-json", JSON.stringify(config)], {
    cwd: REPO_ROOT,
    env: { ...process.env, WINTER_HOME: winterHome },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(encodeFrame({ type: "user", text: "run the compiled catalog probe" }));
  proc.stdin.write(encodeFrame({ type: "control_request", requestId: "c1", subtype: "end_input", payload: undefined }));
  proc.stdin.flush();
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  await proc.stdin.end();
  return { frames: splitFrames(stdout, "").frames, stderr, exitCode };
}

async function verifyCatalogInBinary(binPath: string): Promise<void> {
  const catalog = loadCatalog();
  const winterHome = mkdtempSync(join(tmpdir(), "winter-verify-compiled-home-"));
  const fake = await startScenarioFake();
  try {
    const model = SCENARIO_MODELS.anthropic;
    const base = {
      sessionId: "verify-compiled-catalog",
      cwd: REPO_ROOT,
      allowedTools: [SCENARIO_TOOL_NAME],
      provider: { providerId: "anthropic", authRef: { kind: "inline", value: "test" }, connection: { baseUrl: fake.url, local: true } },
    };

    console.log("verify:compiled — probing that the CATALOG resolves inside the compiled binary...");
    const ok = await runCompiledSession(binPath, { ...base, model }, winterHome);
    const init = ok.frames.map((f) => (f as { message?: { type?: string; subtype?: string } }).message).find((m) => m?.type === "system" && m?.subtype === "init") as
      | { model?: string; winter_provider?: Record<string, unknown> }
      | undefined;
    if (init === undefined) throw new Error(`verify:compiled: the compiled binary emitted no system/init frame (exit ${ok.exitCode})\n${ok.stderr}`);
    const identity = init.winter_provider;
    if (identity === undefined) throw new Error("verify:compiled: the compiled binary's init frame carries NO `winter_provider` — the catalog did not resolve inside the binary");
    if (identity["modelKey"] !== model) throw new Error(`verify:compiled: resolved modelKey ${String(identity["modelKey"])}, expected ${model}`);
    if (identity["catalogVersion"] !== catalog.catalogVersion) {
      throw new Error(`verify:compiled: the binary reports catalogVersion ${String(identity["catalogVersion"])} but this repo compiled ${catalog.catalogVersion} — the bundled catalog is not the one that was built in`);
    }
    if (identity["adapterId"] !== "winter.anthropic-messages") throw new Error(`verify:compiled: resolved adapterId ${String(identity["adapterId"])}`);
    // The session RAN: the fake, in this process, was contacted by the compiled binary.
    if (fake.requests.length === 0) throw new Error("verify:compiled: the compiled binary never reached the loopback fake");
    const finalText = JSON.stringify(ok.frames).includes(SCENARIO_FINAL_TEXT);
    if (!finalText) throw new Error("verify:compiled: the compiled binary's session never produced the scripted final answer");

    console.log("verify:compiled — probing that an UNKNOWN model is a typed refusal inside the binary (the negative control)...");
    const refused = await runCompiledSession(binPath, { ...base, sessionId: "verify-compiled-unknown", model: "anthropic/no-such-model-t10" }, winterHome);
    if (refused.exitCode === 0) throw new Error("verify:compiled: an unknown model did NOT refuse — a binary with an empty catalog would also refuse the known one");
    if (!refused.stderr.includes("is not in provider")) {
      throw new Error(`verify:compiled: the refusal did not name the catalog miss; stderr was:\n${refused.stderr}`);
    }
    console.log(`verify:compiled OK — the catalog (${catalog.catalogVersion}: ${catalog.providers.length} providers, ${catalog.models.length} models) resolves inside the compiled binary`);
  } finally {
    await fake.close();
    rmSync(winterHome, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const workDir = mkdtempSync(join(tmpdir(), "winter-verify-compiled-"));
  const binPath = join(workDir, "winter");
  try {
    console.log("verify:compiled — compiling the winter runtime to a temp path...");
    await buildRuntime({ out: binPath });

    // FIRST, because it is the cheaper and more specific failure: if the catalog did not survive
    // bundling, every provider scenario in the suite below fails for one reason and reports it as
    // twenty.
    await verifyCatalogInBinary(binPath);

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
      // Fix round 1 (reviewer Finding A): process.exit() here would terminate immediately WITHOUT
      // unwinding, so the `finally` below would never run and every failing run would leak this
      // temp dir (with the ~60MB compiled binary) into real $TMPDIR. process.exitCode only RECORDS
      // the code the process exits with once it naturally finishes — the `finally`'s cleanup still
      // runs first, then the process exits with this code on its own. This mirrors the SAME
      // cleanup-inside-try/finally PATTERN build-runtime.ts's own exit path already uses — that
      // pattern never had this bug in the first place, since it never calls process.exit() at all
      // (T5 fix-wave: reworded — the original "which never had this bug" read as if it named the
      // FILE build-runtime.ts, not the pattern the two files share).
      process.exitCode = exitCode;
    } else {
      console.log("verify:compiled OK — the compiled winter binary matches the in-memory transport on every equivalence scenario");
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
