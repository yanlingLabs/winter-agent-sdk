// Pure profile-GENERATION tests (task brief: "pure generation, linux-safe") -- string assertions
// only, no child_process, no real sandbox-exec, no platform branching. Real containment proof
// against a live sandbox-exec is deny.darwin.test.ts's job; this file proves the STRING the builder
// emits has the right shape and ordering, on every platform CI runs on.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSeatbeltProfile,
  buildWorkflowWorkerSeatbeltProfile,
  resolveNetworkPosture,
  SandboxConfigError,
  DEFAULT_SANDBOX_SETTINGS,
} from "./profile.ts";

function realTmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "winter-sb-")));
}

describe("buildSeatbeltProfile", () => {
  test("denies by default, allows read everywhere, writes only under writable roots", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false });
    expect(p).toContain("(deny default)");
    expect(p).toContain("(allow file-read*)");
    expect(p).toContain(`(subpath "${cwd}")`); // cwd is a writable root
    expect(p).toContain("(allow process-exec)");
    expect(p).toContain("(deny network*)"); // network denied by default
  });

  test("network can be explicitly allowed", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: true });
    expect(p).toContain("(allow network*)");
    expect(p).not.toContain("(deny network*)");
  });

  test("extra writable roots are included and realpath-canonicalized", () => {
    const cwd = realTmp();
    const extra = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [extra], allowNetwork: false });
    expect(p).toContain(`(subpath "${cwd}")`);
    expect(p).toContain(`(subpath "${extra}")`);
  });

  // Base directories are mkdtemp'd (already-real, platform-stable) so canonicalization never
  // rewrites the base out from under the assertion (macOS resolves /tmp -> /private/tmp; a literal
  // "/tmp/..." fixture would silently break only on macOS, which this "linux-safe" file must not
  // depend on) -- only the quote/backslash-bearing LEAF segment is nonexistent, so
  // resolveRealTarget's graceful fall-through leaves it untouched, verbatim, past the real base.
  test("paths with quotes/backslashes are escaped in the profile", () => {
    const base = realTmp();
    const weird = join(base, 'we"ird');
    const back = join(base, "back\\slash");
    const p = buildSeatbeltProfile({ cwd: join(base, "a"), writableRoots: [weird, back], allowNetwork: false });
    expect(p).toContain(`(subpath "${join(base, 'we\\"ird')}")`);
    expect(p).toContain(`(subpath "${join(base, "back\\\\slash")}")`);
  });

  test("empty writableRoots yields exactly cwd as the sole writable root", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [], allowNetwork: false });
    const subpaths = [...p.matchAll(/\(subpath "([^"]*)"\)/g)].map((m) => m[1]);
    expect(subpaths).toEqual([cwd]);
    expect(subpaths).toHaveLength(1);
  });

  test("the mktemp direct-children allowance is only emitted when darwinUserTempDir is supplied", () => {
    const withoutIt = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false });
    expect(withoutIt).not.toMatch(/\[\^\/\]\+\$/);
    const withIt = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, darwinUserTempDir: "/private/var/folders/xx/yy/T" });
    expect(withIt).toContain('(allow file-write* (regex #"^/private/var/folders/xx/yy/T/[^/]+$"))');
  });

  test("the mktemp allowance is DIRECT CHILDREN ONLY -- never a subpath grant", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, darwinUserTempDir: "/priv/tmp-user" });
    expect(p).toContain('(regex #"^/priv/tmp-user/[^/]+$"))');
    expect(p).not.toContain('(subpath "/priv/tmp-user")');
  });

  test("the mktemp allowance appears BEFORE the control-plane denies (SBPL last-match-wins keeps them overriding)", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, darwinUserTempDir: "/priv/tmp-user" });
    const mktempIdx = p.indexOf("[^/]+$");
    const controlPlaneIdx = p.indexOf("(deny file-write* (literal");
    expect(mktempIdx).toBeGreaterThan(0);
    expect(controlPlaneIdx).toBeGreaterThan(mktempIdx);
  });
});

// WS-12 §5.2 verbatim carry (Winter-renamed `.norma` -> `.winter`): the seatbelt itself must
// independently deny the control-plane files, because a bash-invoked write never passes through a
// write/edit TOOL's own permission fence at all.
describe("buildSeatbeltProfile: control-plane file carve-out (WS-12 §5.2, verbatim carry)", () => {
  test("denies all three control-plane filenames under cwd, each as a deny-after-allow line (SBPL last-match-wins)", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false });
    const allowIdx = p.indexOf("(allow file-write*");
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    for (const f of ["permissions.local.json", "settings.json", "settings.local.json"]) {
      const denyIdx = p.indexOf(`(deny file-write* (literal "${join(cwd, ".winter", f)}"))`);
      expect(denyIdx).toBeGreaterThan(allowIdx);
    }
  });

  test("denies all three control-plane filenames under EVERY extra writable root too, not just cwd", () => {
    const cwd = realTmp();
    const extra1 = realTmp();
    const extra2 = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [extra1, extra2], allowNetwork: false });
    for (const root of [cwd, extra1, extra2]) {
      for (const f of ["permissions.local.json", "settings.json", "settings.local.json"]) {
        expect(p).toContain(`(deny file-write* (literal "${join(root, ".winter", f)}"))`);
      }
    }
  });

  test("literal denies are grouped per root, root-by-root in `roots` order, three filenames each", () => {
    const cwd = realTmp();
    const extra = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [extra], allowNetwork: false });
    const denyLines = [...p.matchAll(/\(deny file-write\* \(literal "([^"]*)"\)\)/g)].map((m) => m[1]);
    expect(denyLines).toEqual([
      join(cwd, ".winter", "permissions.local.json"),
      join(cwd, ".winter", "settings.json"),
      join(cwd, ".winter", "settings.local.json"),
      join(extra, ".winter", "permissions.local.json"),
      join(extra, ".winter", "settings.json"),
      join(extra, ".winter", "settings.local.json"),
    ]);
  });

  test("the carve-out stays FILENAME-specific -- .winter itself, .winter/memory (the MEMDIR), and .winter/rules all remain un-denied", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false });
    expect(p).not.toContain(`(deny file-write* (literal "${join(cwd, ".winter")}"))`);
    expect(p).not.toContain(`(deny file-write* (literal "${join(cwd, ".winter", "memory")}"))`);
    expect(p).not.toContain(`(deny file-write* (literal "${join(cwd, ".winter", "rules")}"))`);
  });

  test("the carve-out path is escaped the same way subpath roots are (quotes/backslashes)", () => {
    const cwd = join(realTmp(), 'we"ird');
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false });
    const escapedCwd = cwd.replace(/"/g, '\\"');
    expect(p).toContain(`(deny file-write* (literal "${escapedCwd}/.winter/permissions.local.json"))`);
    expect(p).toContain(`(deny file-write* (literal "${escapedCwd}/.winter/settings.json"))`);
    expect(p).toContain(`(deny file-write* (literal "${escapedCwd}/.winter/settings.local.json"))`);
  });

  test("three SEPARATE any-depth regex denies, never merged by alternation, case-folded per character", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false });
    expect(p).toContain(String.raw`(deny file-write* (regex #"/\.[Ww][Ii][Nn][Tt][Ee][Rr]/[Pp][Ee][Rr][Mm][Ii][Ss][Ss][Ii][Oo][Nn][Ss]\.[Ll][Oo][Cc][Aa][Ll]\.[Jj][Ss][Oo][Nn]$"))`);
    expect(p).toContain(String.raw`(deny file-write* (regex #"/\.[Ww][Ii][Nn][Tt][Ee][Rr]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\.[Jj][Ss][Oo][Nn]$"))`);
    expect(p).toContain(String.raw`(deny file-write* (regex #"/\.[Ww][Ii][Nn][Tt][Ee][Rr]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\.[Ll][Oo][Cc][Aa][Ll]\.[Jj][Ss][Oo][Nn]$"))`);
    const regexDenyCount = [...p.matchAll(/\(deny file-write\* \(regex/g)].length;
    expect(regexDenyCount).toBe(3);
    expect(p).not.toContain("|"); // SBPL alternation marker never appears anywhere
  });

  test("empty writableRoots ([]) carves out cwd's own control-plane files exactly once each", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [], allowNetwork: false });
    const denyLines = [...p.matchAll(/\(deny file-write\* \(literal "([^"]*)"\)\)/g)].map((m) => m[1]);
    expect(denyLines).toEqual([
      join(cwd, ".winter", "permissions.local.json"),
      join(cwd, ".winter", "settings.json"),
      join(cwd, ".winter", "settings.local.json"),
    ]);
  });
});

// WS-12 §5.3: new at cutover -- filesystem.denyWrite/denyRead, driven by SandboxSettings.
describe("buildSeatbeltProfile: denyWrite/denyRead layers (WS-12 §5.3, new)", () => {
  test("denyWritePaths render as subpath denies AFTER the write-allow block", () => {
    const cwd = realTmp();
    const secret = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false, denyWritePaths: [secret] });
    const allowIdx = p.indexOf("(allow file-write*");
    const denyIdx = p.indexOf(`(deny file-write* (subpath "${secret}"))`);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  test("denyWritePaths are a real subpath deny -- unlike the control-plane carve-out, this one IS a blanket subpath rule (scoped to configured denyWrite only)", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, denyWritePaths: ["/some/secret/dir"] });
    expect(p).toMatch(/\(deny file-write\* \(subpath "\/some\/secret\/dir"\)\)/);
  });

  test("denyWritePaths appear BEFORE the mktemp allowance and the control-plane denies (neither carried protection can be shadowed by user config)", () => {
    const p = buildSeatbeltProfile({
      cwd: realTmp(),
      allowNetwork: false,
      denyWritePaths: ["/some/secret/dir"],
      darwinUserTempDir: "/priv/tmp-user",
    });
    const denyWriteIdx = p.indexOf('(deny file-write* (subpath "/some/secret/dir"))');
    const mktempIdx = p.indexOf("[^/]+$");
    const controlPlaneIdx = p.indexOf("(deny file-write* (literal");
    expect(denyWriteIdx).toBeGreaterThanOrEqual(0);
    expect(mktempIdx).toBeGreaterThan(denyWriteIdx);
    expect(controlPlaneIdx).toBeGreaterThan(mktempIdx);
  });

  test("denyReadPaths render as subpath denies AFTER the read-allow line", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, denyReadPaths: ["/some/secret/dir"] });
    const allowIdx = p.indexOf("(allow file-read*)");
    const denyIdx = p.indexOf('(deny file-read* (subpath "/some/secret/dir"))');
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  test("no denyWrite/denyRead configured emits no subpath denies at all (the carried carve-out tests' 'never a blanket subpath deny' invariant, scoped to the default-config case)", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false });
    expect(p).not.toMatch(/\(deny file-write\* \(subpath/);
    expect(p).not.toMatch(/\(deny file-read\* \(subpath/);
  });
});

// WS-12 §2: "the sole baseline read denial is <home>/.winter/run, enforced via profile deny rules
// layered over allow-read."
describe("buildSeatbeltProfile: baseline <home>/.winter/run read denial (WS-12 §2)", () => {
  test("home renders a subpath deny for <home>/.winter/run, layered AFTER the read-allow line", () => {
    const home = realTmp();
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, home });
    const allowIdx = p.indexOf("(allow file-read*)");
    const denyIdx = p.indexOf(`(deny file-read* (subpath "${join(home, ".winter", "run")}"))`);
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  test("home is canonicalized the same graceful way as every other path this module handles", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, home: "/does/not/exist/home" });
    expect(p).toContain('(deny file-read* (subpath "/does/not/exist/home/.winter/run"))');
  });

  test("home omitted emits no baseline run-dir denial -- still a correct, if less defended, profile (mirrors darwinUserTempDir's own omitted-is-still-correct posture)", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false });
    expect(p).not.toContain(".winter/run");
  });
});

// T8 rider 25 (SECURITY): the checkpoint backup store's shell-side half. The managed permission
// floor (engine.ts's buildBaselineDenyRules) binds a Write/Edit/NotebookEdit TOOL call; a
// bash-invoked `echo x >> ~/.winter/backups/<s>/index.jsonl` never passes through a write tool's
// fence at all, so the seatbelt is the only enforcement point left -- exactly the reasoning WS-12
// §5.2's control-plane carve-out already records for `.winter/permissions.local.json`.
describe("buildSeatbeltProfile: baseline <home>/.winter/backups WRITE denial (T8 rider 25)", () => {
  test("home renders a subpath write-deny for <home>/.winter/backups, layered AFTER the write-allow block", () => {
    const home = realTmp();
    const p = buildSeatbeltProfile({ cwd: home, allowNetwork: false, home });
    const allowIdx = p.indexOf("(allow file-write*\n");
    const denyIdx = p.indexOf(`(deny file-write* (subpath "${join(home, ".winter", "backups")}"))`);
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  test("home is canonicalized the same graceful way as every other path this module handles", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, home: "/does/not/exist/home" });
    expect(p).toContain('(deny file-write* (subpath "/does/not/exist/home/.winter/backups"))');
  });

  test("home omitted emits no baseline backups denial (same omitted-is-still-correct posture)", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false });
    expect(p).not.toContain(".winter/backups");
  });
});

describe("resolveNetworkPosture", () => {
  test("undefined network config resolves to deny (false)", () => {
    expect(resolveNetworkPosture(undefined)).toBe(false);
  });

  test("an object with no domain lists resolves to deny (false) -- capture-pending, fails closed", () => {
    expect(resolveNetworkPosture({})).toBe(false);
    expect(resolveNetworkPosture({ someProxyKnob: true })).toBe(false);
  });

  test("allowedDomains present (even empty) throws a typed SandboxConfigError", () => {
    expect(() => resolveNetworkPosture({ allowedDomains: [] })).toThrow(SandboxConfigError);
    expect(() => resolveNetworkPosture({ allowedDomains: ["example.com"] })).toThrow(SandboxConfigError);
  });

  test("deniedDomains present throws a typed SandboxConfigError", () => {
    expect(() => resolveNetworkPosture({ deniedDomains: ["evil.example"] })).toThrow(SandboxConfigError);
  });

  test("DEFAULT_SANDBOX_SETTINGS has no network config and resolves to deny", () => {
    expect(resolveNetworkPosture(DEFAULT_SANDBOX_SETTINGS.network)).toBe(false);
    expect(DEFAULT_SANDBOX_SETTINGS.enabled).toBe(true);
  });
});

// WS-12 §5.2 "carries over for the workflow subprocess" -- ships as a tested mechanism now, even
// with no real workflow-worker caller in this phase yet (WS-11 is later work).
describe("buildWorkflowWorkerSeatbeltProfile", () => {
  test("denies all writes and network, allows read, denies fork", () => {
    const p = buildWorkflowWorkerSeatbeltProfile("/usr/local/bin/winter-core", { home: undefined });
    expect(p).toContain("(deny file-write*)");
    expect(p).toContain("(deny network*)");
    expect(p).toContain("(deny process-fork)");
    expect(p).not.toContain("(deny process-fork*)"); // process-fork* is an unbound SBPL variable
    expect(p).toContain("(allow file-read*)");
  });

  test("allows process-exec ONLY for the canonicalized self binary, never a blanket allow", () => {
    const self = realTmp();
    const selfBin = join(self, "winter-core");
    const p = buildWorkflowWorkerSeatbeltProfile(selfBin, { home: undefined });
    expect(p).toContain(`(allow process-exec (literal "${selfBin}"))`);
    expect(p).not.toContain("(allow process-exec)\n"); // never the unrestricted form
  });

  test("a nonexistent self path falls through gracefully (canon's graceful fallback) rather than throwing", () => {
    expect(() => buildWorkflowWorkerSeatbeltProfile("/does/not/exist/winter-core", { home: undefined })).not.toThrow();
  });
});
