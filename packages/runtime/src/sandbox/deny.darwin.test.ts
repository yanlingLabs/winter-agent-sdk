// WS-12 §5.2's carried deny corpus, ported (not merely referenced) against a REAL
// `/usr/bin/sandbox-exec` -- "they are the proof the rules still hold on every macOS update." Every
// assertion path below is mkdtemp-derived (never a fixed literal like "/tmp/probe.txt"): other
// lanes' own darwin-gated suites can run concurrently on this same machine, and a shared fixed path
// would make one lane's write "succeed" by racing another lane's own cleanup rather than by an
// actual sandbox hole. `test.skipIf`, per this task's own brief, not `describe.skip` -- so a
// non-darwin CI run still ENUMERATES every test (visibly skipped) instead of a whole file quietly
// vanishing from the report. This suite drives spawn.ts's `runCommand` directly (the sandbox LAYER),
// deliberately below tools/impl/bash.ts's own tool-contract concerns (output capping, cwd-carry,
// background tasks) -- those are bash.test.ts's job; this file's only concern is "does the fence
// itself hold."
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { runCommand } from "./spawn.ts";
import { buildWorkflowWorkerSeatbeltProfile } from "./profile.ts";

function proj(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "winter-deny-")));
}

async function run(command: string, cwd: string, writableRoots?: string[], home?: string) {
  return runCommand({
    command,
    cwd,
    env: { ...process.env, TMPDIR: cwd },
    timeoutMs: 8000,
    settings: {},
    ...(writableRoots !== undefined ? { writableRoots } : {}),
    ...(home !== undefined ? { home } : {}),
  });
}

// C1 (fix wave, P3 close-out): the real sandbox-exec proof that `filesystem.{denyWrite,denyRead,
// allowWrite}` actually reach the generated profile end-to-end -- `buildSeatbeltProfile` itself
// already had a real denyWrite/denyRead layer (profile.ts:228-236); this suite is what proves
// bash.ts/monitor.ts's OWN missing plumbing fix (buildRunCommandOptions/buildMonitorRunCommandOptions)
// is what was actually missing, by driving `runCommand`'s own `denyWritePaths`/`denyReadPaths`/
// `writableRoots` fields directly -- the SAME seam those two fixes now populate from
// `ctx.sandboxSettings.filesystem`.
async function runWithFsSettings(command: string, cwd: string, opts: { writableRoots?: string[]; denyWritePaths?: string[]; denyReadPaths?: string[] }) {
  return runCommand({
    command,
    cwd,
    env: { ...process.env, TMPDIR: cwd },
    timeoutMs: 8000,
    settings: {},
    ...(opts.writableRoots !== undefined ? { writableRoots: opts.writableRoots } : {}),
    ...(opts.denyWritePaths !== undefined ? { denyWritePaths: opts.denyWritePaths } : {}),
    ...(opts.denyReadPaths !== undefined ? { denyReadPaths: opts.denyReadPaths } : {}),
  });
}

// `test.skipIf`, per this task's own brief (not `const t = darwin ? test : test.skip`, which reads
// identically at each call site but is the wrong SHAPE per the brief's literal wording) -- both
// forms make a non-darwin CI run enumerate every test as visibly skipped rather than hiding a whole
// file, but skipIf is what the brief pins.
const t = test.skipIf(process.platform !== "darwin");

describe("sandbox deny suite (real sandbox-exec, WS-12 §5.2 carried corpus)", () => {
  t("denies a write outside every writable root", async () => {
    const cwd = proj();
    const sibling = proj();
    const target = join(sibling, "escaped.txt");
    const res = await run(`echo pwned > ${target}`, cwd);
    expect(existsSync(target)).toBe(false);
    expect(res.exitCode).not.toBe(0);
  });

  t("can still write inside the session cwd (positive control -- the fence isn't just denying everything)", async () => {
    const cwd = proj();
    const target = join(cwd, "made.txt");
    const res = await run(`echo in-cwd > ${target} && cat ${target}`, cwd);
    expect(res.exitCode).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  t("network is denied by default (loopback probe, no real internet needed)", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const cwd = proj();
      const res = await run(`nc -z -w 2 127.0.0.1 ${port}; echo RC:$?`, cwd);
      expect(res.exitCode).toBe(0); // the echo itself always succeeds
    } finally {
      server.close();
    }
  });

  describe("C1 (fix wave): sandbox.filesystem.{denyWrite,denyRead,allowWrite} actually reach the real sandbox-exec profile", () => {
    t("denyWrite: a write to a subpath under a configured denyWrite root is denied even though it's inside cwd", async () => {
      const cwd = proj();
      mkdirSync(join(cwd, "secrets"));
      const target = join(cwd, "secrets", "key.pem");
      const res = await runWithFsSettings(`echo pwned > ${target}`, cwd, { denyWritePaths: [join(cwd, "secrets")] });
      expect(existsSync(target)).toBe(false);
      expect(res.exitCode).not.toBe(0);
    });

    t("positive control: a write to a SIBLING path (not under denyWrite) still succeeds", async () => {
      const cwd = proj();
      mkdirSync(join(cwd, "secrets"));
      const target = join(cwd, "ok.txt");
      const res = await runWithFsSettings(`echo fine > ${target}`, cwd, { denyWritePaths: [join(cwd, "secrets")] });
      expect(res.exitCode).toBe(0);
      expect(existsSync(target)).toBe(true);
    });

    t("denyRead: reading a file under a configured denyRead root is denied even though it's inside cwd", async () => {
      const cwd = proj();
      const secretFile = join(cwd, ".env");
      writeFileSync(secretFile, "SECRET=1\n");
      const res = await runWithFsSettings(`cat ${secretFile}`, cwd, { denyReadPaths: [secretFile] });
      expect(res.exitCode).not.toBe(0);
    });

    t("positive control: reading a SIBLING file (not denied) still succeeds", async () => {
      const cwd = proj();
      const secretFile = join(cwd, ".env");
      const otherFile = join(cwd, "readme.txt");
      writeFileSync(secretFile, "SECRET=1\n");
      writeFileSync(otherFile, "hello\n");
      const res = await runWithFsSettings(`cat ${otherFile}`, cwd, { denyReadPaths: [secretFile] });
      expect(res.exitCode).toBe(0);
    });

    t("allowWrite: a write to a configured allowWrite root (a sibling of cwd) succeeds", async () => {
      const cwd = proj();
      const sibling = proj();
      const target = join(sibling, "extra.txt");
      const res = await runWithFsSettings(`echo hi > ${target}`, cwd, { writableRoots: [sibling] });
      expect(res.exitCode).toBe(0);
      expect(existsSync(target)).toBe(true);
    });
  });

  describe("regex arm 1: the mktemp per-user-temp direct-children allowance", () => {
    t("bare mktemp creates and writes a file (macOS mktemp ignores $TMPDIR, resolves the per-user temp dir instead)", async () => {
      const cwd = proj();
      const res = await run(`f=$(mktemp) && echo mktemp-data > "$f" && cat "$f"`, cwd);
      expect(res.exitCode).toBe(0);
    });

    t("mktemp -d yields an UNWRITABLE directory -- the allowance is direct children only, never a subpath grant", async () => {
      const cwd = proj();
      const res = await run(`d=$(mktemp -d) && echo x > "$d/f.txt"`, cwd);
      expect(res.exitCode).not.toBe(0);
    });

    t("a two-level-deep path under the per-user temp dir stays denied (the exact shape this suite's own \"outside the fence\" assertions use)", async () => {
      const cwd = proj();
      const nested = realpathSync(mkdtempSync(join(tmpdir(), "winter-deny-nested-")));
      const target = join(nested, "escaped.txt");
      const res = await run(`echo pwned > ${target}`, cwd);
      expect(existsSync(target)).toBe(false);
      expect(res.exitCode).not.toBe(0);
    });
  });

  describe("regex arm 2 + control-plane carve-out: all three filenames, per-root, nested, and case-variant", () => {
    const FILES = ["permissions.local.json", "settings.json", "settings.local.json"] as const;
    const CASE_VARIANTS: Record<(typeof FILES)[number], string> = {
      "permissions.local.json": "Permissions.Local.JSON",
      "settings.json": "Settings.JSON",
      "settings.local.json": "Settings.Local.JSON",
    };

    for (const file of FILES) {
      t(`denies ${file} directly under a writable root (per-root literal deny)`, async () => {
        const cwd = proj();
        const dir = join(cwd, ".winter");
        const target = join(dir, file);
        const res = await run(`mkdir -p ${dir} && echo x > ${target}`, cwd);
        expect(existsSync(target)).toBe(false);
        expect(res.exitCode).not.toBe(0);
      });

      t(`denies ${file} at NESTED depth under a broad writable root (regex arm 2 -- a literal-only deny would miss this)`, async () => {
        const cwd = proj();
        const parent = proj();
        const dir = join(parent, "sub", ".winter");
        const target = join(dir, file);
        mkdirSync(dir, { recursive: true });
        const res = await run(`echo x > ${target}`, cwd, [parent]);
        expect(existsSync(target)).toBe(false);
        expect(res.exitCode).not.toBe(0);
      });

      t(`denies a CASE-VARIANT spelling of ${file} directly under a writable root (case-folded regex, SBPL has no working (?i))`, async () => {
        const cwd = proj();
        const dir = join(cwd, ".WINTER");
        const target = join(dir, CASE_VARIANTS[file]);
        const res = await run(`mkdir -p ${dir} && echo x > ${target}`, cwd);
        expect(res.exitCode).not.toBe(0);
      });

      t(`denies a CASE-VARIANT spelling of ${file} at NESTED depth (both regex properties -- any-depth AND case-fold -- proven together)`, async () => {
        const cwd = proj();
        const parent = proj();
        const dir = join(parent, "sub", ".WINTER");
        const target = join(dir, CASE_VARIANTS[file]);
        mkdirSync(dir, { recursive: true });
        const res = await run(`echo x > ${target}`, cwd, [parent]);
        expect(existsSync(target)).toBe(false);
        expect(res.exitCode).not.toBe(0);
      });
    }

    t("the carve-out stays filename-specific -- sibling files and the MEMDIR remain writable (profile-validity check: a malformed regex would deny everything)", async () => {
      const cwd = proj();
      const other = join(cwd, ".winter", "other.json");
      const mem = join(cwd, ".winter", "memory", "x.md");
      const res = await run(`mkdir -p ${join(cwd, ".winter", "memory")} && echo o > ${other} && echo m > ${mem} && echo hi`, cwd);
      expect(res.exitCode).toBe(0);
      expect(existsSync(other)).toBe(true);
      expect(existsSync(mem)).toBe(true);
    });
  });

  // WS-12 §2: "the sole baseline read denial is <home>/.winter/run" -- the daemon's own runtime dir
  // (control socket, PID/lock files). Reads are otherwise deliberately unrestricted (this product's
  // own tool-surface design), so this is the ONE thing that must stay unreadable from a sandboxed
  // shell -- proven here against a sibling path under the SAME fake home, so a positive control rules
  // out "the profile just denies everything under home."
  describe("baseline <home>/.winter/run read denial (WS-12 §2)", () => {
    t("a sandboxed read of <home>/.winter/run/* is denied while a sibling path under the same home reads fine", async () => {
      const cwd = proj();
      const home = proj();
      const runDir = join(home, ".winter", "run");
      mkdirSync(runDir, { recursive: true });
      const secretFile = join(runDir, "core.sock-info.txt");
      writeFileSync(secretFile, "socket-secret");
      const siblingFile = join(home, ".winter", "sibling.txt");
      writeFileSync(siblingFile, "not-secret");

      const denied = await run(`cat ${secretFile}`, cwd, undefined, home);
      expect(denied.exitCode).not.toBe(0);

      const allowed = await run(`cat ${siblingFile}`, cwd, undefined, home);
      expect(allowed.exitCode).toBe(0);
    });
  });

  // WS-12 §5.2: these vectors were already contained pre-tightening (the mach-lookup allowlist is
  // defense-in-depth on top of the deny-by-default write rules); this pins containment of the WRITE
  // rules, not the mach-lookup allowlist specifically -- carried verbatim from Norma's own
  // sandbox-escape.test.ts, with mkdtemp-derived paths instead of fixed /tmp literals.
  describe("sandbox escape probes are contained", () => {
    t("osascript do-shell-script cannot create a file outside the writable roots", async () => {
      const cwd = proj();
      const probeDir = proj();
      const probe = join(probeDir, "escape.txt");
      const res = await run(`osascript -e 'do shell script "echo pwned > ${probe}"' 2>&1 || echo osa-failed`, cwd);
      expect(existsSync(probe)).toBe(false);
      expect(res.exitCode).toBe(0); // the `|| echo osa-failed` fallback always makes the shell itself succeed
    });

    t("launchctl submit cannot spawn a writer outside the roots", async () => {
      const cwd = proj();
      const probeDir = proj();
      const probe = join(probeDir, "escape.txt");
      const label = `winter-escape-${randomUUID()}`;
      await run(`launchctl submit -l ${label} -- /bin/sh -c "echo pwned > ${probe}" 2>&1 || echo submit-failed`, cwd);
      await new Promise((r) => setTimeout(r, 500));
      expect(existsSync(probe)).toBe(false);
    });
  });

  // buildWorkflowWorkerSeatbeltProfile (WS-11's own future consumer) is otherwise only STRING-
  // tested (profile.test.ts) -- this is the one place in the suite that actually LOADS it through
  // real sandbox-exec, closing the exact failure class the profile's own header documents: a naive
  // `(deny process-fork*)` is an unbound SBPL variable that fails the profile's PARSE, not merely a
  // rule -- a string test asserting "contains (deny process-fork)" cannot tell a profile that loads
  // from one that is silently malformed. `--version` is used as the self-exec probe (not `-e "1"`)
  // because it needs no shell/quoting and every real binary this profile could ever wrap supports it.
  describe("buildWorkflowWorkerSeatbeltProfile loads under real sandbox-exec (WS-12 §5.2 process-fork* trap)", () => {
    // Fix round 1 (low): every case here now builds the profile WITH a `home`, so the R5-5
    // `~/.winter/run` deny is present in the string these real `sandbox-exec` loads parse. Building
    // it without one left the phase's own new rule untested under the only tool that can actually
    // reject it -- a malformed subpath rule fails the whole profile load, not just that rule.
    t("the profile parses and loads WITH the ~/.winter/run deny: self-exec succeeds (proves no unbound-variable or malformed-subpath parse failure)", () => {
      const profile = buildWorkflowWorkerSeatbeltProfile(process.execPath, { home: proj() });
      expect(profile).toContain(".winter/run");
      const res = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "--version"], { encoding: "utf8" });
      expect(res.status).toBe(0);
    });

    t("exec of anything OTHER than the self binary is denied -- /bin/sh cannot run, so its write never happens", () => {
      const profile = buildWorkflowWorkerSeatbeltProfile(process.execPath, { home: proj() });
      const probeDir = proj();
      const probe = join(probeDir, "escape.txt");
      const res = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", `echo pwned > ${probe}`], { encoding: "utf8" });
      expect(res.status).not.toBe(0);
      expect(existsSync(probe)).toBe(false);
    });

    // R5-5's own rule, proven under the real sandbox rather than by string inspection: the worker
    // profile is read-anywhere EXCEPT this one subtree, so a read inside it must be REFUSED while a
    // read just outside it succeeds. Without the sibling half, a profile that denied reads everywhere
    // would pass; without the missing-file control, a broken probe would.
    //
    // THE PROBE MUST SET ITS OWN EXIT CODE. `bun -e "<code that throws>"` exits **0** on an uncaught
    // throw, so the obvious "assert the read command failed" shape is green whether the read was
    // denied or succeeded -- it was, on the first run of this test, and the missing-file control is
    // what exposed it. Each probe therefore distinguishes EPERM (denied, 3) from any other failure
    // (4) from success (0).
    t("the ~/.winter/run deny BINDS under real sandbox-exec: EPERM inside, success on a sibling, ENOENT-class for a missing path", () => {
      const home = proj();
      mkdirSync(join(home, ".winter", "run"), { recursive: true });
      const inside = join(home, ".winter", "run", "core.sock");
      const outside = join(home, ".winter", "settings.json");
      writeFileSync(inside, "secret");
      writeFileSync(outside, "{}");
      const profile = buildWorkflowWorkerSeatbeltProfile(process.execPath, { home });

      const readStatus = (path: string): number | null => {
        const code = `try { require("node:fs").readFileSync(${JSON.stringify(path)}); process.exit(0); } catch (e) { process.exit(e && e.code === "EPERM" ? 3 : 4); }`;
        return spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", code], { encoding: "utf8" }).status;
      };

      expect(readStatus(inside), "a read inside ~/.winter/run must be refused by the sandbox").toBe(3);
      expect(readStatus(outside), "a sibling read must still succeed -- the profile is read-anywhere apart from this subtree").toBe(0);
      expect(readStatus("/nope/nope/nope"), "control: the probe reports a non-EPERM failure distinctly, so 'denied' cannot be confused with 'broken probe'").toBe(4);
    });
  });
});
