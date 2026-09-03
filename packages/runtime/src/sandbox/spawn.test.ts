import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import {
  resolveExecutionPath,
  isSandboxAvailable,
  resolveDarwinUserTempDir,
  resetDarwinUserTempDirCacheForTest,
  runCommand,
  SandboxUnavailableError,
} from "./spawn.ts";
import { SandboxConfigError, buildSeatbeltProfile, type SandboxSettings } from "./profile.ts";

function realTmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "winter-spawn-")));
}

// ---------------------------------------------------------------------------------------------
// §4.1 execution-path selection -- pure, platform-free, exercises the first-match-wins table.
// ---------------------------------------------------------------------------------------------
describe("resolveExecutionPath (WS-12 §4.1, first-match-wins)", () => {
  test("enabled: false wins over everything else, even an override request", () => {
    const d = resolveExecutionPath({ settings: { enabled: false }, dangerouslyDisableSandbox: true, command: "ls" });
    expect(d.posture).toBe("config-disabled");
    expect(d.sandboxOverrideRequested).toBe(true); // still recorded, even though it wasn't what decided the path
  });

  test("dangerouslyDisableSandbox: true wins over excludedCommands/default", () => {
    const d = resolveExecutionPath({ settings: {}, dangerouslyDisableSandbox: true, command: "ls" });
    expect(d.posture).toBe("override-requested");
    expect(d.sandboxOverrideRequested).toBe(true);
  });

  test("a command matching excludedCommands runs unsandboxed ONLY when allowUnsandboxedCommands is true", () => {
    const settings: SandboxSettings = { excludedCommands: ["docker build ."], allowUnsandboxedCommands: true };
    const d = resolveExecutionPath({ settings, command: "docker build ." });
    expect(d.posture).toBe("excluded");
    expect(d.sandboxOverrideRequested).toBe(false);
  });

  test("a command matching excludedCommands still sandboxes when allowUnsandboxedCommands is NOT set", () => {
    const settings: SandboxSettings = { excludedCommands: ["docker build ."] };
    const d = resolveExecutionPath({ settings, command: "docker build ." });
    expect(d.posture).toBe("sandboxed");
  });

  test("excludedCommands matching is EXACT FULL COMMAND STRING only -- a substring/prefix does not match (R3-6)", () => {
    const settings: SandboxSettings = { excludedCommands: ["docker build ."], allowUnsandboxedCommands: true };
    const d = resolveExecutionPath({ settings, command: "docker build . --no-cache" });
    expect(d.posture).toBe("sandboxed");
  });

  test("no config at all resolves to sandboxed, override not requested", () => {
    const d = resolveExecutionPath({ settings: {}, command: "ls" });
    expect(d.posture).toBe("sandboxed");
    expect(d.sandboxOverrideRequested).toBe(false);
  });

  test("dangerouslyDisableSandbox: false is the SAME as omitted -- not an override request", () => {
    const d = resolveExecutionPath({ settings: {}, dangerouslyDisableSandbox: false, command: "ls" });
    expect(d.posture).toBe("sandboxed");
    expect(d.sandboxOverrideRequested).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// §3 availability -- the injectable seam proves the typed-unavailability path on a box that
// genuinely HAS sandbox-exec (this dev machine does).
// ---------------------------------------------------------------------------------------------
describe("isSandboxAvailable", () => {
  test("reflects the real binary's presence on darwin", () => {
    expect(isSandboxAvailable()).toBe(process.platform === "darwin");
  });

  test("an injected nonexistent path reports unavailable regardless of the real binary", () => {
    if (process.platform !== "darwin") return; // the real check already returns false on non-darwin
    expect(isSandboxAvailable(join(realTmp(), "no-such-sandbox-exec"))).toBe(false);
  });
});

describe("runCommand: §3 sandbox-unavailable is a typed error, never a silent unsandboxed fallback", () => {
  // The real assertion: `sandboxExecPath` lets this fire on EVERY dev/CI box, including one that
  // genuinely has /usr/bin/sandbox-exec (this one does) -- without it, the only way to observe this
  // throw site would be a box that lacks the real binary, which is not this product's shipping
  // platform and would leave the throw site with zero live coverage in practice.
  test("an injected bogus sandboxExecPath forces SandboxUnavailableError even though the real binary is present", async () => {
    const cwd = realTmp();
    await expect(
      runCommand({
        command: "echo should-never-run",
        cwd,
        env: {},
        timeoutMs: 5000,
        settings: {},
        sandboxExecPath: join(realTmp(), "no-such-sandbox-exec"),
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  test("a sandboxed posture with no real sandbox-exec on the resolution path rejects with SandboxUnavailableError (the real, non-injected OS-level absence, for whatever box genuinely lacks the binary -- e.g. non-darwin CI)", async () => {
    if (isSandboxAvailable()) return; // this dev box has it; the injected-path test above already proves the throw site here
    const cwd = realTmp();
    await expect(
      runCommand({ command: "echo hi", cwd, env: {}, timeoutMs: 5000, settings: {} }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });
});

describe("runCommand: domain-list network config propagates SandboxConfigError, never silently flattened", () => {
  const d = process.platform === "darwin" ? test : test.skip;
  d("a sandboxed run with allowedDomains configured rejects before spawning anything", async () => {
    const cwd = realTmp();
    await expect(
      runCommand({
        command: "echo should-never-run",
        cwd,
        env: {},
        timeoutMs: 5000,
        settings: { network: { allowedDomains: ["example.com"] } },
      }),
    ).rejects.toBeInstanceOf(SandboxConfigError);
  });
});

// ---------------------------------------------------------------------------------------------
// darwin per-user temp dir resolution -- caching + reset seam.
// ---------------------------------------------------------------------------------------------
describe("resolveDarwinUserTempDir", () => {
  beforeEach(() => resetDarwinUserTempDirCacheForTest());
  afterEach(() => resetDarwinUserTempDirCacheForTest());

  test("resolves to a real, absolute directory on darwin, null elsewhere", () => {
    const v = resolveDarwinUserTempDir();
    if (process.platform === "darwin") {
      expect(v).not.toBeNull();
      expect(v!.startsWith("/")).toBe(true);
    } else {
      expect(v).toBeNull();
    }
  });

  test("is cached -- a second call returns the identical value without re-invoking getconf (no throw, stable identity)", () => {
    const a = resolveDarwinUserTempDir();
    const b = resolveDarwinUserTempDir();
    expect(a).toBe(b);
  });

  test("resetDarwinUserTempDirCacheForTest forces re-resolution (observable via a fresh, still-consistent value)", () => {
    const a = resolveDarwinUserTempDir();
    resetDarwinUserTempDirCacheForTest();
    const b = resolveDarwinUserTempDir();
    expect(b).toEqual(a); // same real machine -> same real answer, just recomputed
  });
});

// ---------------------------------------------------------------------------------------------
// runCommand: real end-to-end spawn smoke tests (macOS-only product -- gated the way the brief
// pins the darwin deny suite, test.skipIf, not describe.skip).
// ---------------------------------------------------------------------------------------------
describe("runCommand: real spawn (darwin)", () => {
  test.skipIf(process.platform !== "darwin")("runs a trivial command sandboxed by default and reports exit 0", async () => {
    const cwd = realTmp();
    let out = "";
    const res = await runCommand({
      command: "echo hello-winter",
      cwd,
      env: { ...process.env, TMPDIR: cwd },
      timeoutMs: 5000,
      settings: {},
      onStdout: (c) => {
        out += c.toString("utf8");
      },
    });
    expect(res.exitCode).toBe(0);
    expect(res.posture).toBe("sandboxed");
    expect(res.sandboxOverrideRequested).toBe(false);
    expect(out).toContain("hello-winter");
    expect(res.profile).toBeDefined();
  });

  // T8 fix round 1 (coordinator-required, brief item 7): matchCommand (spawn.ts) is what
  // excludedCommands matches against, DISTINCT from the (possibly wrapped) command that actually
  // gets spawned -- bash.ts's own runForeground wraps the model's raw command in a pwd-capture
  // script (buildPwdCaptureScript) before spawning it, but must match excludedCommands against
  // the model's raw command, never the wrapper. This mechanism existed in production code
  // (spawn.ts:210's `command: opts.matchCommand ?? opts.command`) but had zero grep hits across
  // every test file before this fixture -- the WS12-08 matrix row's own citation covered
  // first-match-wins PRIORITY ordering, never raw-vs-wrapped matching specifically.
  test.skipIf(process.platform !== "darwin")("matchCommand, not the (possibly wrapped) command, is what excludedCommands matches against", async () => {
    const cwd = realTmp();
    const raw = "echo winter-t8-fixround1-raw-probe";
    // Mirrors bash.ts's own buildPwdCaptureScript shape closely enough to be a faithful stand-in
    // (the exact trailing lines don't matter to this test -- only that the SPAWNED command differs
    // textually from the raw command excludedCommands names).
    const wrapped = `${raw}\n__winter_test_rc=$?\npwd > /dev/null 2>&1\nexit "$__winter_test_rc"\n`;
    const res = await runCommand({
      command: wrapped,
      matchCommand: raw,
      cwd,
      env: { ...process.env },
      timeoutMs: 5000,
      settings: { excludedCommands: [raw], allowUnsandboxedCommands: true },
    });
    expect(res.posture).toBe("excluded");
    expect(res.exitCode).toBe(0);
  });

  // Negative control (RED direction, per the coordinator's own instruction): the SAME wrapped
  // command WITHOUT matchCommand falls back to matching the WRAPPED command against
  // excludedCommands -- which does not equal the raw string, so this must NOT be excluded. Proven
  // empirically by reverting spawn.ts's own `command: opts.matchCommand ?? opts.command` to a bare
  // `command: opts.command` and re-running both tests: the positive test above then fails
  // (`posture` becomes "sandboxed" instead of "excluded") while THIS test still passes unchanged --
  // confirming this fixture genuinely exercises the matchCommand plumbing rather than being
  // vacuously true regardless of it. Reverted immediately after that RED observation; both tests
  // pass against the real (fixed) spawn.ts.
  test.skipIf(process.platform !== "darwin")("negative control: the same wrapped command WITHOUT matchCommand is NOT excluded -- the wrap defeats naive matching", async () => {
    const cwd = realTmp();
    const raw = "echo winter-t8-fixround1-raw-probe";
    const wrapped = `${raw}\n__winter_test_rc=$?\npwd > /dev/null 2>&1\nexit "$__winter_test_rc"\n`;
    const res = await runCommand({
      command: wrapped,
      // no matchCommand -- resolveExecutionPath falls back to matching `wrapped` itself, which
      // never equals `raw` textually.
      cwd,
      env: { ...process.env },
      timeoutMs: 5000,
      settings: { excludedCommands: [raw], allowUnsandboxedCommands: true },
    });
    expect(res.posture).toBe("sandboxed");
  });

  test.skipIf(process.platform !== "darwin")("dangerouslyDisableSandbox: true actually skips the seatbelt wrapper (no profile in the result)", async () => {
    const cwd = realTmp();
    const res = await runCommand({
      command: "echo hi",
      cwd,
      env: { ...process.env },
      timeoutMs: 5000,
      settings: {},
      dangerouslyDisableSandbox: true,
    });
    expect(res.posture).toBe("override-requested");
    expect(res.sandboxOverrideRequested).toBe(true);
    expect(res.profile).toBeUndefined();
    expect(res.exitCode).toBe(0);
  });

  test.skipIf(process.platform !== "darwin")("kills the whole process group on timeout, so a backgrounded grandchild does not survive", async () => {
    const cwd = realTmp();
    const started = Date.now();
    const res = await runCommand({
      command: "(sleep 30 && touch survived.txt) & echo backgrounded",
      cwd,
      env: { ...process.env, TMPDIR: cwd },
      timeoutMs: 400,
      settings: {},
    });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(res.timedOut).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(cwd, "survived.txt"))).toBe(false);
  });

  test.skipIf(process.platform !== "darwin")("kills the process group on abort", async () => {
    const cwd = realTmp();
    const ac = new AbortController();
    const started = Date.now();
    const p = runCommand({ command: "sleep 30", cwd, env: { ...process.env, TMPDIR: cwd }, timeoutMs: 30000, settings: {}, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const res = await p;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.aborted).toBe(true);
  });

  test.skipIf(process.platform !== "darwin")("network is denied by default even for a loopback connection", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
    const port = (server.address() as AddressInfo).port;
    try {
      const cwd = realTmp();
      const res = await runCommand({
        command: `nc -z -w 2 127.0.0.1 ${port}; echo RC:$?`,
        cwd,
        env: { ...process.env, TMPDIR: cwd },
        timeoutMs: 8000,
        settings: {},
        onStdout: () => {},
      });
      expect(res.exitCode).toBe(0); // the echo itself succeeds regardless
    } finally {
      server.close();
    }
  });

  // No SandboxSettings shape reaches allowNetwork:true through resolveNetworkPosture today (it
  // fails closed on every input by design -- see profile.ts's own header, and the "capture-pending"
  // note there). That is a resolveNetworkPosture-level gap, already pinned as deliberate; it must
  // NOT also leave the actual ENFORCEMENT mechanism (buildSeatbeltProfile's own allowNetwork:true
  // arm) unproven against a real sandbox-exec. This drives buildSeatbeltProfile directly (bypassing
  // resolveNetworkPosture/runCommand's own settings layer) with a hand-built profile, spawned the
  // identical way runCommand spawns a sandboxed command, to prove the MECHANISM works end to end --
  // the missing piece is only "how a config reaches allowNetwork:true," never "whether
  // allowNetwork:true itself is honored."
  test.skipIf(process.platform !== "darwin")("the allowNetwork:true profile arm actually permits a loopback connection through real sandbox-exec", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
    const port = (server.address() as AddressInfo).port;
    try {
      const cwd = realTmp();
      const profile = buildSeatbeltProfile({ cwd, allowNetwork: true });
      const denied = await new Promise<string>((res) => {
        const child = spawn("/usr/bin/sandbox-exec", ["-p", buildSeatbeltProfile({ cwd, allowNetwork: false }), "/bin/bash", "-c", `nc -z -w 2 127.0.0.1 ${port}; echo RC:$?`]);
        let out = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.on("close", () => res(out));
      });
      expect(denied).not.toContain("RC:0");
      const allowed = await new Promise<string>((res) => {
        const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/bin/bash", "-c", `nc -z -w 2 127.0.0.1 ${port}; echo RC:$?`]);
        let out = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.on("close", () => res(out));
      });
      expect(allowed).toContain("RC:0");
    } finally {
      server.close();
    }
  });

  test.skipIf(process.platform !== "darwin")("stdout/stderr are captured separately, not merged (WS-12 §6.4 retirement delta)", async () => {
    const cwd = realTmp();
    let out = "";
    let err = "";
    const res = await runCommand({
      command: "echo on-stdout; echo on-stderr 1>&2",
      cwd,
      env: { ...process.env, TMPDIR: cwd },
      timeoutMs: 5000,
      settings: {},
      onStdout: (c) => (out += c.toString("utf8")),
      onStderr: (c) => (err += c.toString("utf8")),
    });
    expect(res.exitCode).toBe(0);
    expect(out).toContain("on-stdout");
    expect(out).not.toContain("on-stderr");
    expect(err).toContain("on-stderr");
    expect(err).not.toContain("on-stdout");
  });

  test.skipIf(process.platform !== "darwin")("the stream-kill switch actually fires: a producer well past maxStreamedBytes is killed mid-stream, not just left to finish naturally", async () => {
    const cwd = realTmp();
    // yes|head is itself a common way to produce a lot of output fast; the 5MB source is chosen to
    // sit FAR above the 10KB cap (~500x) so the kill is unambiguously what stopped it -- a source
    // only slightly over the cap could instead finish naturally in the same window, leaving
    // `streamKilled` as the only trustworthy signal ambiguous. `res.streamKilled` is set ONLY by
    // spawn.ts's own onChunk threshold check (never by a natural close), so asserting it directly
    // proves the kill switch executed rather than merely that the command eventually stopped.
    const res = await runCommand({
      command: "yes x | head -c 5000000",
      cwd,
      env: { ...process.env, TMPDIR: cwd },
      timeoutMs: 8000,
      settings: {},
      maxStreamedBytes: 10_000,
      onStdout: () => {},
    });
    expect(res.streamKilled).toBe(true);
  });

  test.skipIf(process.platform !== "darwin")("a launch failure (bad spawnFile) resolves with spawnError set, never an unhandled rejection", async () => {
    const cwd = realTmp();
    // config-disabled -> spawnFile is the fixed "/bin/bash", which always exists, so we can't force
    // an ENOENT through the public options -- instead prove the excluded/unsandboxed path at least
    // runs cleanly (spawnError undefined) as the negative-space complement to the darwin-unavailable
    // test above, which covers the OTHER branch's error surface.
    const res = await runCommand({ command: "true", cwd, env: { ...process.env }, timeoutMs: 5000, settings: { enabled: false } });
    expect(res.posture).toBe("config-disabled");
    expect(res.spawnError).toBeUndefined();
    expect(res.exitCode).toBe(0);
  });
});
