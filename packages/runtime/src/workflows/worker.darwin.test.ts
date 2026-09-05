// Phase 5 Lane W (task 4), WS-12 §5.2 / WS-11 §1.7: the workflow worker's fence, proved against a
// REAL `/usr/bin/sandbox-exec`.
//
// `sandbox/deny.darwin.test.ts` already proves two things about this profile -- that it LOADS (the
// `(deny process-fork*)` unbound-variable trap) and that exec of a non-self binary is denied. This
// suite adds the three axes that file does not cover, plus the P5 delta:
//   - a WRITE from inside the sandbox is denied,
//   - a NETWORK connection from inside is denied,
//   - a FORK from inside is denied,
//   - and the R5-5 `~/.winter/run` read-deny actually BINDS when `{home}` is passed (T3's Lane W
//     item 2), while a sibling directory under the same `.winter` stays readable -- which is what
//     proves the rule is scoped rather than the whole tree being unreadable by accident.
//
// It then runs a REAL workflow end-to-end through `realWorkerSpawner()`, which is the only place in
// the `bun test` suite where the runtime, the worker, `sandbox-exec` and a genuine subprocess are all
// present at once. (`scripts/verify-workflow.ts` is the same proof against the COMPILED binary.)
//
// `test.skipIf`, per this codebase's own convention (deny.darwin.test.ts's header): a non-darwin CI
// run still ENUMERATES every case as visibly skipped instead of a whole file quietly vanishing. Every
// path is mkdtemp-derived, never a fixed literal -- other lanes' darwin suites run concurrently on
// this same machine, and a shared fixed path would make one lane's write "succeed" by racing another
// lane's cleanup rather than by an actual hole in the fence.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { buildWorkflowWorkerSeatbeltProfile } from "../sandbox/profile.ts";
import { WorkflowRuntime, realWorkerSpawner } from "./runtime.ts";
import { fakeWorkflowRunHost } from "./seam.ts";
import { fakeStructuredOutputSeam } from "../structured/seam.ts";
import { createContextAccountant } from "../engine.ts";

const darwin = process.platform === "darwin";
const t = test.skipIf(!darwin);

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Runs `bun -e <code>` under the worker profile. `bun` IS the self binary, so its exec is the one the
 * profile allows.
 *
 * MEASURED TRAP, and the reason every probe below asserts on OUTPUT rather than exit status: under
 * bun 1.3.14 `bun -e` exits **0 even on an uncaught exception** (verified directly:
 * `bun -e "require('node:fs').writeFileSync('/nonexistentdir-xyz/x','y')"` -> status 0). A denial
 * test written the obvious way -- "the sandboxed write should exit non-zero" -- therefore FAILS on a
 * fence that is working perfectly, and, far worse, its inverse would PASS on a fence that had been
 * removed. So each probe prints a sentinel on each branch and the assertion reads the sentinel.
 */
function underProfile(code: string, opts: { home?: string } = {}): { status: number | null; stderr: string; stdout: string } {
  const profile = buildWorkflowWorkerSeatbeltProfile(process.execPath, opts.home !== undefined ? { home: opts.home } : {});
  const res = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", code], { encoding: "utf8", timeout: 20_000 });
  return { status: res.status, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
}

/** Wraps a probe so BOTH branches are observable: exactly one sentinel is always printed. */
function probe(body: string): string {
  return `try { ${body} console.log("ALLOWED"); } catch (e) { console.log("DENIED:" + (e && e.code ? e.code : e)); }`;
}

describe("the workflow worker profile denies writes, network and fork (WS-12 §5.2)", () => {
  t("a WRITE from inside the sandbox is denied, and the file is never created", () => {
    const dir = scratch("winter-wf-deny-write-");
    const probeFile = join(dir, "escape.txt");
    const res = underProfile(probe(`require("node:fs").writeFileSync(${JSON.stringify(probeFile)}, "pwned");`));
    expect(res.stdout).toContain("DENIED");
    expect(res.stdout).not.toContain("ALLOWED");
    expect(existsSync(probeFile)).toBe(false);
  });

  t("a NETWORK connection from inside the sandbox is denied, even to a listener on this machine", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = underProfile(
        `const net = require("node:net");
         const s = net.connect(${port}, "127.0.0.1");
         s.on("connect", () => { console.log("ALLOWED"); process.exit(0); });
         s.on("error", (e) => { console.log("DENIED:" + e.code); process.exit(0); });`,
      );
      expect(res.stdout).toContain("DENIED");
      expect(res.stdout).not.toContain("ALLOWED");
    } finally {
      server.close();
    }
  });

  t("a FORK from inside the sandbox is denied -- the profile's `(deny process-fork)` is real, not decorative", () => {
    const res = underProfile(
      `const r = require("node:child_process").spawnSync("/bin/echo", ["hi"]);
       console.log(r.error || r.status !== 0 ? "DENIED:" + (r.error && r.error.code) : "ALLOWED");`,
    );
    expect(res.stdout).toContain("DENIED");
    expect(res.stdout).not.toContain("ALLOWED");
  });
});

describe("R5-5: the `~/.winter/run` read-deny BINDS when the spawner passes {home} (T3's Lane W item 2)", () => {
  t("a read under `<home>/.winter/run` is denied, while a sibling under the same `.winter` stays readable", () => {
    const home = scratch("winter-wf-home-");
    mkdirSync(join(home, ".winter", "run"), { recursive: true });
    mkdirSync(join(home, ".winter", "memory"), { recursive: true });
    const secret = join(home, ".winter", "run", "core.sock.token");
    const sibling = join(home, ".winter", "memory", "notes.md");
    writeFileSync(secret, "SECRET");
    writeFileSync(sibling, "READABLE");
    try {
      const denied = underProfile(probe(`console.log("READ:" + require("node:fs").readFileSync(${JSON.stringify(secret)}, "utf8"));`), { home });
      expect(denied.stdout).not.toContain("SECRET");
      expect(denied.stdout).toContain("DENIED");

      // The scoping half. Without it, a profile that simply failed to read ANYTHING would pass the
      // assertion above for entirely the wrong reason.
      const allowed = underProfile(probe(`console.log("READ:" + require("node:fs").readFileSync(${JSON.stringify(sibling)}, "utf8"));`), { home });
      expect(allowed.stdout).toContain("READABLE");
      expect(allowed.stdout).not.toContain("DENIED");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  t("WITHOUT {home} the same read succeeds -- which is exactly why the spawner must never omit it", () => {
    const home = scratch("winter-wf-home-nohome-");
    mkdirSync(join(home, ".winter", "run"), { recursive: true });
    const secret = join(home, ".winter", "run", "core.sock.token");
    writeFileSync(secret, "SECRET");
    try {
      const res = underProfile(probe(`console.log("READ:" + require("node:fs").readFileSync(${JSON.stringify(secret)}, "utf8"));`));
      expect(res.stdout).toContain("SECRET");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("end to end: a REAL sandboxed worker subprocess runs a workflow (WS-11 §1.7)", () => {
  t("a script completes through the real spawner, under the real seatbelt", async () => {
    const winterHome = scratch("winter-wf-e2e-home-");
    const sessionTempDir = scratch("winter-wf-e2e-temp-");
    const runtime = new WorkflowRuntime({
      session: {
        winterHome,
        projectKey: "-e2e",
        sessionTempDir,
        structured: fakeStructuredOutputSeam(),
        accountant: createContextAccountant({ limit: 100_000 }),
      },
      spawnWorker: realWorkerSpawner(),
      requireSandbox: true,
    });
    const host = fakeWorkflowRunHost({ structured: fakeStructuredOutputSeam(), accountant: createContextAccountant({ limit: 100_000 }) });
    const source = `export const meta = { name: "e2e", description: "d" };\nphase("Go"); log("running"); return { sum: 1 + 1 };`;
    const launched = runtime.launch(
      { sessionId: "e2e-session", cwd: sessionTempDir, trustedWorkspace: false, source, meta: { name: "e2e", description: "d" } },
      host,
    );
    try {
      const view = await runtime.await(launched.runId);
      expect(view.status).toBe("completed");
      expect(view.result).toBe(JSON.stringify({ sum: 2 }));
    } finally {
      // Never leave a worker (or its sandbox-exec parent) behind: this suite spawns real process
      // groups, and a leaked one outlives the test runner.
      runtime.killWorkerForTest(launched.runId);
      rmSync(winterHome, { recursive: true, force: true });
      rmSync(sessionTempDir, { recursive: true, force: true });
    }
  }, 60_000);

  t("a script that reaches for the filesystem is refused BEFORE the seatbelt has to catch it (defense in depth, both layers real)", async () => {
    const winterHome = scratch("winter-wf-e2e2-home-");
    const sessionTempDir = scratch("winter-wf-e2e2-temp-");
    const probeFile = join(sessionTempDir, "should-not-exist.txt");
    const runtime = new WorkflowRuntime({
      session: {
        winterHome,
        projectKey: "-e2e",
        sessionTempDir,
        structured: fakeStructuredOutputSeam(),
        accountant: createContextAccountant({ limit: 100_000 }),
      },
      spawnWorker: realWorkerSpawner(),
      requireSandbox: true,
    });
    const host = fakeWorkflowRunHost({ structured: fakeStructuredOutputSeam(), accountant: createContextAccountant({ limit: 100_000 }) });
    const source = `export const meta = { name: "escape", description: "d" };\nconst fs = await import("node:fs");\nfs.writeFileSync(${JSON.stringify(probeFile)}, "pwned");\nreturn "escaped";`;
    const launched = runtime.launch(
      { sessionId: "e2e-session-2", cwd: sessionTempDir, trustedWorkspace: false, source, meta: { name: "escape", description: "d" } },
      host,
    );
    try {
      const view = await runtime.await(launched.runId);
      expect(view.status).toBe("failed");
      expect(view.error).toContain("import");
      expect(existsSync(probeFile)).toBe(false);
    } finally {
      runtime.killWorkerForTest(launched.runId);
      rmSync(winterHome, { recursive: true, force: true });
      rmSync(sessionTempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
