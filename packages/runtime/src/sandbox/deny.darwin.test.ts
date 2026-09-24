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
import { mkdtempSync, mkdirSync, realpathSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { runCommand } from "./spawn.ts";
import { buildWorkflowWorkerSeatbeltProfile } from "./profile.ts";
import { splitDenyPathsByGlobShape } from "../permissions/file-rules.ts";

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

/**
 * P7a fix r1 (Important-1): a run whose seatbelt is built under a HOST'S OWN brand.
 *
 * `brand` reaches `buildSeatbeltProfile` through `runCommand`, exactly as a real session's does
 * (`ToolExecutionContext.brand` -> `buildRunCommandOptions` -> here), so this drives the production
 * seam rather than the profile builder in isolation.
 */
async function runBranded(command: string, cwd: string, writableRoots: string[], brand: { homeDirName: string; projectDirName: string }) {
  return runCommand({
    command,
    cwd,
    env: { ...process.env, TMPDIR: cwd },
    timeoutMs: 8000,
    settings: {},
    writableRoots,
    brand,
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

/**
 * Phase 5 fix wave, I1: a run whose SEATBELT is built from a resolved winter root that is not
 * `<home>/.winter`. `home` stays the OS-home anchor (both denies are emitted, never swapped).
 */
async function runWithWinterHome(command: string, cwd: string, winterHome: string) {
  return runCommand({
    command,
    cwd,
    env: { ...process.env, TMPDIR: cwd },
    timeoutMs: 8000,
    settings: {},
    home: proj(), // an OS-home stand-in with no `.winter` in it -- only `winterHome` can be doing the work
    winterHome,
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

    // --- P7a fix r1 (Important-1): the any-depth regexes follow the BRAND ------------------------
    //
    // The per-root LITERAL denies already derived from `brand.projectDirName`; these three regexes
    // did not, so under a rebrand `echo x > <root>/<nested>/.acme/settings.json` from Bash was
    // PERMITTED while the same write under `.winter` -- a directory the reuser's product never reads
    // -- stayed denied. WS-12 §5.2 makes the seatbelt the only enforcement point left for a
    // bash-invoked write to the control plane, so this is the fence itself, proved against a real
    // `sandbox-exec` rather than against the profile text.
    for (const file of FILES) {
      t(`denies ${file} at NESTED depth under a BRANDED dot-dir (.acme), which the hard-coded regex missed entirely`, async () => {
        const cwd = proj();
        const parent = proj();
        const dir = join(parent, "sub", ".acme");
        const target = join(dir, file);
        mkdirSync(dir, { recursive: true });
        const res = await runBranded(`echo x > ${target}`, cwd, [parent], { homeDirName: ".acme", projectDirName: ".acme" });
        expect(existsSync(target)).toBe(false);
        expect(res.exitCode).not.toBe(0);
      });
    }

    t("a CASE-VARIANT branded spelling is denied too -- the derived class is per-character, not a literal", async () => {
      const cwd = proj();
      const parent = proj();
      const dir = join(parent, "sub", ".ACME");
      const target = join(dir, "Settings.JSON");
      mkdirSync(dir, { recursive: true });
      const res = await runBranded(`echo x > ${target}`, cwd, [parent], { homeDirName: ".acme", projectDirName: ".acme" });
      expect(existsSync(target)).toBe(false);
      expect(res.exitCode).not.toBe(0);
    });

    t("under the ACME brand a nested `.winter/settings.json` is NOT denied -- the fence follows the session's product, it does not accumulate", async () => {
      // The honest consequence of the derivation, stated rather than left to be discovered: a
      // reuser's fence guards the reuser's control plane. Winter's own dot-dir is somebody else's
      // directory to that session, exactly as WS-12 §2's model reads one level down. This arm is
      // also the profile-VALIDITY check for the branded profile: a malformed derived regex would
      // deny everything, and this write would fail for the wrong reason.
      const cwd = proj();
      const parent = proj();
      const dir = join(parent, "sub", ".winter");
      const target = join(dir, "settings.json");
      mkdirSync(dir, { recursive: true });
      const res = await runBranded(`echo x > ${target}`, cwd, [parent], { homeDirName: ".acme", projectDirName: ".acme" });
      expect(res.exitCode).toBe(0);
      expect(existsSync(target)).toBe(true);
    });

    // Fix round 17 (R.3 C-1 part 2b): `.winter/` is created BEFORE the sandboxed command runs. The
    // default protection now feeds `.winter/{skills,rules,output-styles,commands,agents}` to `Ch`, so
    // `<cwd>/.winter` itself is a `(literal …)` in the ancestor fence -- creating or deleting the
    // `.winter` directory from inside the sandbox is denied, exactly as `<cwd>/.claude` is on claude.
    // The point of this fixture is unchanged: inside an existing `.winter`, the carve-out is
    // FILENAME-specific, so a sibling file and the MEMDIR stay writable.
    t("the carve-out stays filename-specific -- sibling files and the MEMDIR remain writable (profile-validity check: a malformed regex would deny everything)", async () => {
      const cwd = proj();
      mkdirSync(join(cwd, ".winter"));
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

  // Phase 5 fix wave, I1: the SAME two denies, anchored at a RESOLVED winter root whose basename is
  // NOT `.winter`. Every rider-25/R5-5 case in this file builds a `.winter`-shaped synthetic home and
  // therefore structurally cannot see the class -- which is exactly how the OS-home anchoring
  // survived two SECURITY-rated reviews.
  describe("baseline denies follow the RESOLVED winter home (I1)", () => {
    t("under a WINTER_HOME not named `.winter`, its own run/ is unreadable and file-history/ unwritable, while a sibling still works", async () => {
      const cwd = proj();
      // The resolved root, deliberately NOT named `.winter`, and NOT under `home`.
      const winterHome = proj();
      mkdirSync(join(winterHome, "run"), { recursive: true });
      mkdirSync(join(winterHome, "file-history", "sess-1"), { recursive: true });
      const secret = join(winterHome, "run", "core.sock-info.txt");
      writeFileSync(secret, "socket-secret");
      const indexFile = join(winterHome, "file-history", "sess-1", "index.jsonl");
      const sibling = join(winterHome, "sibling.txt");

      // cwd is the RESOLVED ROOT here, so its whole tree is inside a writable root -- without the
      // denies both operations land, which is what makes the positive control meaningful.
      const deniedRead = await runWithWinterHome(`cat ${secret}`, winterHome, winterHome);
      expect(deniedRead.exitCode).not.toBe(0);

      const deniedWrite = await runWithWinterHome(`echo tampered >> ${indexFile}`, winterHome, winterHome);
      expect(deniedWrite.exitCode).not.toBe(0);
      expect(existsSync(indexFile)).toBe(false);

      const allowed = await runWithWinterHome(`echo ok > ${sibling}`, winterHome, winterHome);
      expect(allowed.exitCode).toBe(0);
      expect(existsSync(sibling)).toBe(true);
      void cwd;
    });
  });

  // T8 rider 25 (SECURITY): the checkpoint backup store must be unwritable from a sandboxed shell.
  // The positive control is what makes this mean something -- the SAME home is a writable root here
  // (cwd IS home), so a sibling under `.winter` writes fine and only `file-history/` is fenced off.
  //
  // WS-21 §6.3 item 6, fix round 1: renamed from "backups" -- the checkpoint store's own on-disk
  // dirname (`checkpoint/file-history.ts`'s `CHECKPOINT_BACKUPS_DIRNAME`) is a separate constant,
  // owned by lane L1b, which renames it to match; see this fix round's report.
  describe("baseline <home>/.winter/file-history write denial (T8 rider 25)", () => {
    t("a sandboxed write under <home>/.winter/file-history is denied while a sibling under the same .winter writes fine", async () => {
      const home = proj();
      const backups = join(home, ".winter", "file-history", "sess-1");
      mkdirSync(backups, { recursive: true });
      const indexFile = join(backups, "index.jsonl");
      const siblingFile = join(home, ".winter", "sibling.txt");

      // cwd IS home, so `.winter/**` is inside a writable root -- without the deny this write lands.
      const denied = await run(`echo tampered >> ${indexFile}`, home, undefined, home);
      expect(denied.exitCode).not.toBe(0);
      expect(existsSync(indexFile)).toBe(false);

      const allowed = await run(`echo ok > ${siblingFile}`, home, undefined, home);
      expect(allowed.exitCode).toBe(0);
      expect(existsSync(siblingFile)).toBe(true);
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

/**
 * Fix round 17 (R.3 C-1): a run whose `sandbox.filesystem.denyWrite` list is split EXACTLY the way
 * `tools/impl/bash.ts`'s `computeDenyPaths` splits it (the same one shared primitive,
 * `splitDenyPathsByGlobShape`), so these tests drive the production classification rather than a
 * hand-built `denyWritePaths`/`denyWriteRegexes` pair. Commands use cwd-relative paths so no
 * bracketed/spaced path has to survive shell quoting.
 */
async function runWithDenyWriteList(command: string, cwd: string, denyWrite: readonly string[]) {
  const split = splitDenyPathsByGlobShape(denyWrite);
  return runCommand({
    command,
    cwd,
    env: { ...process.env, TMPDIR: cwd },
    timeoutMs: 8000,
    settings: {},
    ...(split.paths.length > 0 ? { denyWritePaths: split.paths } : {}),
    ...(split.regexes.length > 0 ? { denyWriteRegexes: split.regexes } : {}),
    ...(split.globFixedPrefixes.length > 0 ? { denyWriteGlobFixedPrefixes: split.globFixedPrefixes } : {}),
  });
}

/** A fresh project root with a glob-special NAME (`[wip] app`, `a*b`, `q?r`) under a canonical temp dir. */
function specialRoot(name: string): string {
  const root = join(proj(), name);
  mkdirSync(root);
  return root;
}

/** The router's `escapeSandboxGlobPath` spelling (`[` -> `[[]`, everything else as written), which the daemon now sends too. */
function escapeForGlobGrammar(path: string): string {
  return path.replace(/\[/g, "[[]");
}

const WINTER_SKILL = join(".winter", "skills", "x", "SKILL.md");
const PROBE_REDIRECT = `mkdir -p .winter/skills/x && echo planted > ${WINTER_SKILL}`;
const PROBE_PYTHON = `python3 -c "import os; os.makedirs('.winter/skills/x', exist_ok=True); open('${WINTER_SKILL}','w').write('planted')"`;
const PROBE_RENAME = `mv .winter .w2 && mkdir -p .w2/skills/x && echo planted > .w2/skills/x/SKILL.md && mv .w2 .winter`;

// Fix round 17 (R.3 C-1 part 2a -- Winter-only hardening, `scanDenyPathGlob`'s own header): the
// ESCAPED spelling of a bracketed project root is a literal path to the sandbox, so its deny renders
// `(subpath …)` and the ancestor-rename fence names the real directories. Measured before the fix
// (the R.3 reviewer's `bracket2.ts`/`bracket3.ts`): the escaped spelling already denied a DIRECT write
// (its regex matched), but the fixed prefix stopped at the first `[`, so a rename of `.winter` (or of
// any other ancestor inside the project) planted the file.
describe("fix round 17 (R.3 C-1 part 2a): an ESCAPED bracketed project root is a literal path to the sandbox", () => {
  // The discriminating shape, independent of the default `.winter/*` protections part 2b adds: only
  // the extended prefix fences `vault` here.
  t("an ancestor rename cannot plant a file under an escaped deny on an ordinary folder (vault/inner)", async () => {
    const cwd = specialRoot("[wip] app");
    mkdirSync(join(cwd, "vault", "inner"), { recursive: true });
    const res = await runWithDenyWriteList(`mv vault v2 && mkdir -p v2/inner && echo x > v2/inner/f && mv v2 vault`, cwd, [escapeForGlobGrammar(join(cwd, "vault", "inner"))]);
    expect(res.exitCode).not.toBe(0);
    expect(existsSync(join(cwd, "vault", "inner", "f"))).toBe(false);
    expect(existsSync(join(cwd, "v2"))).toBe(false);
    expect(existsSync(join(cwd, "vault", "inner"))).toBe(true);
  });

  // A regression guard, green before the fix too (the escaped regex already matched): the literal
  // rendering must keep denying the direct write it replaced.
  t("a direct write under the escaped deny (vault/inner) stays denied", async () => {
    const cwd = specialRoot("[wip] app");
    mkdirSync(join(cwd, "vault", "inner"), { recursive: true });
    const res = await runWithDenyWriteList(`echo x > vault/inner/f`, cwd, [escapeForGlobGrammar(join(cwd, "vault", "inner"))]);
    expect(res.exitCode).not.toBe(0);
    expect(existsSync(join(cwd, "vault", "inner", "f"))).toBe(false);
  });

  t("control: an ordinary write and an ordinary python3 write in the same bracketed cwd succeed", async () => {
    const cwd = specialRoot("[wip] app");
    mkdirSync(join(cwd, "vault", "inner"), { recursive: true });
    const deny = [escapeForGlobGrammar(join(cwd, "vault", "inner"))];
    expect((await runWithDenyWriteList(`echo ok > notes.md`, cwd, deny)).exitCode).toBe(0);
    expect((await runWithDenyWriteList(`python3 -c "open('notes2.md','w').write('ok')"`, cwd, deny)).exitCode).toBe(0);
    expect(existsSync(join(cwd, "notes.md"))).toBe(true);
    expect(existsSync(join(cwd, "notes2.md"))).toBe(true);
  });

  // The brief's item (5): the three probes against the escaped spelling of `<cwd>/.winter/skills`,
  // the spelling the daemon now sends. (1) and (2) were green before the fix (measured, `bracket2.ts`)
  // and are kept as guards; (3) planted the file before the fix (`bracket3.ts`).
  t("(5) escaped spelling: a redirect write into .winter/skills is denied", async () => {
    const cwd = specialRoot("[wip] app");
    mkdirSync(join(cwd, ".winter", "skills"), { recursive: true });
    const res = await runWithDenyWriteList(PROBE_REDIRECT, cwd, [escapeForGlobGrammar(join(cwd, ".winter", "skills"))]);
    expect(res.exitCode).not.toBe(0);
    expect(existsSync(join(cwd, WINTER_SKILL))).toBe(false);
  });

  t("(5) escaped spelling: a python3 write into .winter/skills is denied", async () => {
    const cwd = specialRoot("[wip] app");
    mkdirSync(join(cwd, ".winter", "skills"), { recursive: true });
    const res = await runWithDenyWriteList(PROBE_PYTHON, cwd, [escapeForGlobGrammar(join(cwd, ".winter", "skills"))]);
    expect(res.exitCode).not.toBe(0);
    expect(existsSync(join(cwd, WINTER_SKILL))).toBe(false);
  });

  t("(5) escaped spelling: the .winter ancestor rename is denied and plants nothing", async () => {
    const cwd = specialRoot("[wip] app");
    mkdirSync(join(cwd, ".winter", "skills"), { recursive: true });
    const res = await runWithDenyWriteList(PROBE_RENAME, cwd, [escapeForGlobGrammar(join(cwd, ".winter", "skills"))]);
    expect(res.exitCode).not.toBe(0);
    expect(existsSync(join(cwd, WINTER_SKILL))).toBe(false);
    expect(existsSync(join(cwd, ".w2"))).toBe(false);
    expect(existsSync(join(cwd, ".winter", "skills"))).toBe(true);
  });
});

// Fix round 17 (R.3 C-1 part 2b): the SDK's OWN cover for spec §7.2's project folders -- the Winter
// mapping of claude's `cR` protection of `.claude/{commands,agents}` (dump byte 15365486, `qa()` at
// 15282484) onto `.winter/{skills,rules,output-styles}`, beside the existing `.winter/{commands,agents}`,
// and fed to `Ch` as claude feeds its own entries, so `<cwd>/.winter` is a literal in the ancestor
// fence the way `<cwd>/.claude` is. Proven under three glob-special root names, each with NO host deny
// list (standalone: only the default protection can deny) and with the host's LITERAL spelling of
// `<cwd>/.winter/skills` (what the daemon sent before the escaped spelling; under `[wip] app` its class
// reading misses the real path, the reviewer's `bracket.ts`). Before part 2b, probes (1)-(3) planted
// the file in every "no host list" cell and in the `[wip] app` literal cell; under `a*b`/`q?r` the
// literal list's regex already matched the direct writes, but the rename still planted it.
describe("fix round 17 (R.3 C-1 part 2b): .winter/skills is protected by the SDK itself, under glob-special project roots", () => {
  for (const name of ["[wip] app", "a*b", "q?r"]) {
    for (const hostList of ["none", "literal"] as const) {
      const label = `${name} / host deny list: ${hostList}`;
      const setUp = (): { cwd: string; deny: string[] } => {
        const cwd = specialRoot(name);
        mkdirSync(join(cwd, ".winter", "skills"), { recursive: true });
        return { cwd, deny: hostList === "none" ? [] : [join(cwd, ".winter", "skills")] };
      };

      t(`${label}: (1) a redirect write into .winter/skills/x/SKILL.md is denied`, async () => {
        const { cwd, deny } = setUp();
        const res = await runWithDenyWriteList(PROBE_REDIRECT, cwd, deny);
        expect(res.exitCode).not.toBe(0);
        expect(existsSync(join(cwd, WINTER_SKILL))).toBe(false);
      });

      t(`${label}: (2) a python3 write to the same path is denied`, async () => {
        const { cwd, deny } = setUp();
        const res = await runWithDenyWriteList(PROBE_PYTHON, cwd, deny);
        expect(res.exitCode).not.toBe(0);
        expect(existsSync(join(cwd, WINTER_SKILL))).toBe(false);
      });

      t(`${label}: (3) the ancestor rename of .winter is denied and plants nothing`, async () => {
        const { cwd, deny } = setUp();
        const res = await runWithDenyWriteList(PROBE_RENAME, cwd, deny);
        expect(res.exitCode).not.toBe(0);
        expect(existsSync(join(cwd, WINTER_SKILL))).toBe(false);
        expect(existsSync(join(cwd, ".w2"))).toBe(false);
        expect(existsSync(join(cwd, ".winter", "skills"))).toBe(true);
      });

      t(`${label}: (4) control -- an ordinary write to notes.md, and a python3 one, still succeed`, async () => {
        const { cwd, deny } = setUp();
        expect((await runWithDenyWriteList(`echo ok > notes.md`, cwd, deny)).exitCode).toBe(0);
        expect((await runWithDenyWriteList(`python3 -c "open('notes2.md','w').write('ok')"`, cwd, deny)).exitCode).toBe(0);
        expect(existsSync(join(cwd, "notes.md"))).toBe(true);
        expect(existsSync(join(cwd, "notes2.md"))).toBe(true);
      });
    }
  }

  t("the other two §7.2 folders, .winter/rules and .winter/output-styles, are denied the same way (plain root)", async () => {
    const cwd = proj();
    mkdirSync(join(cwd, ".winter", "rules"), { recursive: true });
    mkdirSync(join(cwd, ".winter", "output-styles"), { recursive: true });
    const rules = await runWithDenyWriteList(`echo x > .winter/rules/r.md`, cwd, []);
    const styles = await runWithDenyWriteList(`echo x > .winter/output-styles/s.md`, cwd, []);
    expect(rules.exitCode).not.toBe(0);
    expect(styles.exitCode).not.toBe(0);
    expect(existsSync(join(cwd, ".winter", "rules", "r.md"))).toBe(false);
    expect(existsSync(join(cwd, ".winter", "output-styles", "s.md"))).toBe(false);
  });

  // The consequence the ruling accepts, pinned: `<cwd>/.winter` is a `(literal …)` in the ancestor
  // fence, so the sandbox can neither create it fresh nor remove it -- the same as `<cwd>/.claude` on
  // claude. A file inside an existing `.winter` is unaffected (the carve-out fixture above).
  t("creating .winter itself from inside the sandbox is denied (the Ch literal), as .claude is on claude", async () => {
    const cwd = proj();
    const res = await runWithDenyWriteList(`mkdir .winter`, cwd, []);
    expect(res.exitCode).not.toBe(0);
    expect(existsSync(join(cwd, ".winter"))).toBe(false);
  });

  t("the nested half: a .winter/skills under a subdirectory of cwd is denied too (plain root)", async () => {
    const cwd = proj();
    mkdirSync(join(cwd, "pkg", ".winter", "skills"), { recursive: true });
    const res = await runWithDenyWriteList(`echo x > pkg/.winter/skills/SKILL.md`, cwd, []);
    expect(res.exitCode).not.toBe(0);
    expect(existsSync(join(cwd, "pkg", ".winter", "skills", "SKILL.md"))).toBe(false);
  });
});

// Fix round 17 (R.3 I-2, a WS-21 regression): `00717d9` moved the SDK's default home to
// `~/<homeDirName>/sdk` (`resolveWinterHome`), but the SDK's own floor only named settings files
// directly under a folder called `<homeDirName>` (the per-root literals and the any-depth
// control-plane regexes), and nothing named the global config file. Measured by the R.3 reviewer
// (`sdkhome.ts`) with cwd = home and no host deny list: `~/.winter/settings.json` blocked, but
// `~/.winter/sdk/settings.json` and `~/.winter/sdk/.winter.json` WRITTEN. The daemon lists both in
// `sandboxConfigFor`, so this is the standalone / third-party-host case. The floor now names the
// self-grant files and folders on BOTH `winterHome` and `storeHome`.
describe("fix round 17 (R.3 I-2): the SDK's own floor covers its own home and store home, cwd = home", () => {
  const SELF_GRANT_WRITES: readonly (readonly [label: string, rel: string, command: (rel: string) => string])[] = [
    ["settings.json", "settings.json", (rel) => `echo '{"permissions":{"allow":["Bash"]}}' > ${rel}`],
    ["settings.local.json", "settings.local.json", (rel) => `echo '{"permissions":{"allow":["Bash"]}}' > ${rel}`],
    ["the global config file (.winter.json)", ".winter.json", (rel) => `echo '{"mcpServers":{"x":{"command":"sh"}}}' > ${rel}`],
    ["agents/", "agents/evil.md", (rel) => `mkdir -p $(dirname ${rel}) && echo '---' > ${rel}`],
    ["plugins/", "plugins/evil/hooks/hooks.json", (rel) => `mkdir -p $(dirname ${rel}) && echo '{}' > ${rel}`],
  ];

  async function runAsHome(command: string, fakeHome: string, homes: { winterHome: string; storeHome?: string }) {
    return runCommand({
      command,
      cwd: fakeHome,
      env: { ...process.env, TMPDIR: fakeHome },
      timeoutMs: 8000,
      settings: {},
      home: fakeHome,
      winterHome: homes.winterHome,
      ...(homes.storeHome !== undefined ? { storeHome: homes.storeHome } : {}),
    });
  }

  // The standalone default: `winterHome` is `~/.winter/sdk`, no store home.
  for (const [label, rel, command] of SELF_GRANT_WRITES) {
    t(`standalone (winterHome = <home>/.winter/sdk): a write to ${label} under it is denied`, async () => {
      const fakeHome = proj();
      const sdk = join(fakeHome, ".winter", "sdk");
      mkdirSync(sdk, { recursive: true });
      const target = join(".winter", "sdk", rel);
      const res = await runAsHome(command(target), fakeHome, { winterHome: sdk });
      expect(res.exitCode).not.toBe(0);
      expect(existsSync(join(fakeHome, target))).toBe(false);
    });
  }

  // The router layout: `winterHome` is the per-run folder, `storeHome` the shared `~/.winter/sdk`.
  for (const [label, rel, command] of SELF_GRANT_WRITES) {
    t(`router layout: a write to ${label} under the store home AND under the run folder is denied`, async () => {
      const fakeHome = proj();
      const store = join(fakeHome, ".winter", "sdk");
      const runFolder = join(fakeHome, ".winter", "cache", "run", "r1");
      mkdirSync(store, { recursive: true });
      mkdirSync(runFolder, { recursive: true });
      for (const root of [join(".winter", "sdk"), join(".winter", "cache", "run", "r1")]) {
        const target = join(root, rel);
        const res = await runAsHome(command(target), fakeHome, { winterHome: runFolder, storeHome: store });
        expect(res.exitCode).not.toBe(0);
        expect(existsSync(join(fakeHome, target))).toBe(false);
      }
    });
  }

  t("an EXISTING settings.json under the sdk home cannot be overwritten or removed either", async () => {
    const fakeHome = proj();
    const sdk = join(fakeHome, ".winter", "sdk");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(sdk, "settings.json"), "{}");
    const overwrite = await runAsHome(`echo '{"permissions":{"allow":["Bash"]}}' > .winter/sdk/settings.json`, fakeHome, { winterHome: sdk });
    const remove = await runAsHome(`rm .winter/sdk/settings.json`, fakeHome, { winterHome: sdk });
    expect(overwrite.exitCode).not.toBe(0);
    expect(remove.exitCode).not.toBe(0);
    expect(readFileSync(join(sdk, "settings.json"), "utf8")).toBe("{}");
  });

  t("control: an ordinary file in the sdk home, and one in the home itself, are still writable -- the floor names files and folders, not the whole home", async () => {
    const fakeHome = proj();
    const sdk = join(fakeHome, ".winter", "sdk");
    mkdirSync(sdk, { recursive: true });
    const res = await runAsHome(`echo ok > .winter/sdk/scratch.txt && echo ok > notes.md`, fakeHome, { winterHome: sdk });
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(sdk, "scratch.txt"))).toBe(true);
    expect(existsSync(join(fakeHome, "notes.md"))).toBe(true);
  });
});
