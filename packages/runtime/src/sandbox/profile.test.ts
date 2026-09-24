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
  caseFoldSegment,
} from "./profile.ts";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { recursiveGlobToSbplRegexSource } from "../permissions/file-rules.ts";

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
    // Fix round 14: the SAME root also appears in the pR-tail re-permit's own `(subpath ...)` clause
    // (buildReadDenyWritePermitBlock). Fix round 15: cwd's OWN default-write-protection entries
    // (buildDefaultWriteProtectionBlock, claude's own cR) also live under cwd, so a whole-profile
    // subpath scan now finds many DISTINCT nested paths too -- scoped to the ORDINARY write-ALLOW
    // block specifically (`(allow file-write*\n  ...)`), which is this assertion's own actual intent
    // ("exactly cwd as the sole writable root"), not a scan of the whole profile.
    const allowBlockStart = p.indexOf("(allow file-write*\n");
    const allowBlockEnd = p.indexOf("\n\n", allowBlockStart);
    const allowBlockText = p.slice(allowBlockStart, allowBlockEnd === -1 ? undefined : allowBlockEnd);
    const subpaths = [...allowBlockText.matchAll(/\(subpath "([^"]*)"\)/g)].map((m) => m[1]);
    expect(subpaths).toEqual([cwd]);
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
    const controlPlaneIdx = p.indexOf("(deny file-write* file-write-unlink file-write-create (literal");
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
      const denyIdx = p.indexOf(`(deny file-write* file-write-unlink file-write-create (literal "${join(cwd, ".winter", f)}"))`);
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
        expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (literal "${join(root, ".winter", f)}"))`);
      }
    }
  });

  test("literal denies are grouped per root, root-by-root in `roots` order, three filenames each", () => {
    const cwd = realTmp();
    const extra = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [extra], allowNetwork: false });
    const denyLines = [...p.matchAll(/\(deny file-write\* file-write-unlink file-write-create \(literal "([^"]*)"\)\)/g)].map((m) => m[1]);
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
    expect(p).not.toContain(`(deny file-write* file-write-unlink file-write-create (literal "${join(cwd, ".winter")}"))`);
    expect(p).not.toContain(`(deny file-write* file-write-unlink file-write-create (literal "${join(cwd, ".winter", "memory")}"))`);
    expect(p).not.toContain(`(deny file-write* file-write-unlink file-write-create (literal "${join(cwd, ".winter", "rules")}"))`);
  });

  test("the carve-out path is escaped the same way subpath roots are (quotes/backslashes)", () => {
    const cwd = join(realTmp(), 'we"ird');
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false });
    const escapedCwd = cwd.replace(/"/g, '\\"');
    expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (literal "${escapedCwd}/.winter/permissions.local.json"))`);
    expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (literal "${escapedCwd}/.winter/settings.json"))`);
    expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (literal "${escapedCwd}/.winter/settings.local.json"))`);
  });

  test("three SEPARATE any-depth regex denies, never merged by alternation, case-folded per character", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false });
    expect(p).toContain(String.raw`(deny file-write* file-write-unlink file-write-create (regex #"/\.[Ww][Ii][Nn][Tt][Ee][Rr]/[Pp][Ee][Rr][Mm][Ii][Ss][Ss][Ii][Oo][Nn][Ss]\.[Ll][Oo][Cc][Aa][Ll]\.[Jj][Ss][Oo][Nn]$"))`);
    expect(p).toContain(String.raw`(deny file-write* file-write-unlink file-write-create (regex #"/\.[Ww][Ii][Nn][Tt][Ee][Rr]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\.[Jj][Ss][Oo][Nn]$"))`);
    expect(p).toContain(String.raw`(deny file-write* file-write-unlink file-write-create (regex #"/\.[Ww][Ii][Nn][Tt][Ee][Rr]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\.[Ll][Oo][Cc][Aa][Ll]\.[Jj][Ss][Oo][Nn]$"))`);
    // Fix round 15: scoped to the CASE-FOLDED (`[Ww]`-style) regex denies specifically -- claude's
    // own cR (buildDefaultWriteProtectionBlock) also contributes regex denies with the SAME widened
    // op-list prefix now, unconditionally, but its own entries are NOT case-folded (see that
    // function's own header: claude's Do/qa() are never case-folded either), so they never match
    // this pattern.
    const regexDenyCount = [...p.matchAll(/\(deny file-write\* file-write-unlink file-write-create \(regex #"\/\\\.\[/g)].length;
    expect(regexDenyCount).toBe(3);
    expect(p).not.toContain("|"); // SBPL alternation marker never appears anywhere
  });

  // --- P7a fix r1 (Important-1) ------------------------------------------------------------------
  //
  // THE WHOLE-PROFILE BYTE DIFF the fix round was asked for. Transcribed from the profile `cd5fa4b`
  // rendered for this exact input, BEFORE the three any-depth control-plane regexes stopped being
  // hard-coded. A derivation that changed one character of the default profile fails here with the
  // offending line, rather than somewhere downstream in the darwin deny suite.
  test("the ENTIRE rendered profile is byte-identical to the pre-derivation build under the default brand", () => {
    const EXPECTED = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup",
    "  (global-name \"com.apple.system.notification_center\")",
    "  (global-name \"com.apple.system.logger\")",
    "  (global-name \"com.apple.CoreServices.coreservicesd\")",
    "  (global-name \"com.apple.bsd.dirhelper\"))",
    "(allow file-read*)",
    "",
    "", // fix round 11: denyReadRegexRules, always-interpolated and empty here (no glob-shaped denyRead entries)
    "", // fix round 12: denyReadAncestorRenameBlock, always-interpolated and empty here (no denyRead entries at all)
    "(allow file-write-unlink file-write-create", // fix round 14: pR's own trailing re-permit -- unconditional, one clause per write root
    "  (subpath \"/work\")",
    "  (subpath \"/work/a\"))",
    "(deny file-read* (subpath \"/Users/x/.winter/run\"))",
    "(deny file-read* (subpath \"/Users/x/custom-root/run\"))",
    "(deny file-read* (regex #\"^/Users/x/\\.winter/[Pp][Rr][Oo][Jj][Ee][Cc][Tt][Ss]/.*\\.[Pp][Rr][Oo][Vv][Ii][Dd][Ee][Rr]-[Ss][Tt][Aa][Tt][Ee]\\.[Jj][Ss][Oo][Nn][Ll]$\"))",
    "(deny file-read* (regex #\"^/Users/x/custom-root/[Pp][Rr][Oo][Jj][Ee][Cc][Tt][Ss]/.*\\.[Pp][Rr][Oo][Vv][Ii][Dd][Ee][Rr]-[Ss][Tt][Aa][Tt][Ee]\\.[Jj][Ss][Oo][Nn][Ll]$\"))",
    "(allow file-write*",
    "  (subpath \"/work\")",
    "  (subpath \"/work/a\"))",
    "",
    "", // fix round 11: denyWriteRegexRules, always-interpolated and empty here (no glob-shaped denyWrite entries)
    "", // fix round 12: denyWriteAncestorRenameBlock, always-interpolated and empty here (no denyWrite entries at all)
    // fix round 15 (CRITICAL, claude's own cR): buildDefaultWriteProtectionBlock -- unconditional,
    // claude's own Do (9 filenames + Winter's own .winter/mcp.json), qa() (.vscode/.idea/.claude's
    // commands+agents + Winter's own .winter/commands+agents), and .git/hooks + .git/config (no
    // allowGitConfigWrites here), each as a plain cwd-anchored subpath deny AND an unanchored,
    // any-depth regex deny, both with the widened (survives-the-re-permit) operation list, plus the
    // plain half's own Ch ancestor-rename-bypass fence -- see that function's own header.
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.gitconfig\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.gitmodules\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.bashrc\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.bash_profile\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.zshrc\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.zprofile\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.profile\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.ripgreprc\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.mcp.json\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.winter/mcp.json\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.vscode\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.idea\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.claude/commands\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.claude/agents\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.winter/commands\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.winter/agents\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.git/hooks\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/work/.git/config\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.gitconfig$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.gitmodules$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.bashrc$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.bash_profile$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.zshrc$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.zprofile$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.profile$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.ripgreprc$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.mcp\\.json$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.winter/mcp\\.json$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.vscode(/.*)?$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.idea(/.*)?$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.claude/commands(/.*)?$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.claude/agents(/.*)?$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.winter/commands(/.*)?$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.winter/agents(/.*)?$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.git/hooks(/.*)?$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.git/config$\"))",
    // buildDefaultWriteProtectionEntries deliberately EXCLUDES Winter's own brand-derived additions
    // (.winter/mcp.json, .winter/commands, .winter/agents) from Ch's own ancestor-fence -- see that
    // function's own header (a real sandbox-exec regression, empirically caught: feeding them in
    // denied `mkdir -p .winter/memory` in a fresh project, since Ch's own literal-ancestor
    // protection denies file-write-create on ".winter" itself, which Winter routinely needs to
    // create fresh, unlike claude's own ".claude").
    "(deny file-write-unlink file-write-create",
    "  (subpath \"/work/.gitconfig\")",
    "  (literal \"/work\")",
    "  (subpath \"/work/.gitmodules\")",
    "  (subpath \"/work/.bashrc\")",
    "  (subpath \"/work/.bash_profile\")",
    "  (subpath \"/work/.zshrc\")",
    "  (subpath \"/work/.zprofile\")",
    "  (subpath \"/work/.profile\")",
    "  (subpath \"/work/.ripgreprc\")",
    "  (subpath \"/work/.mcp.json\")",
    "  (subpath \"/work/.vscode\")",
    "  (subpath \"/work/.idea\")",
    "  (subpath \"/work/.claude/commands\")",
    "  (literal \"/work/.claude\")",
    "  (subpath \"/work/.claude/agents\")",
    "  (subpath \"/work/.git/hooks\")",
    "  (literal \"/work/.git\")",
    "  (subpath \"/work/.git/config\"))",
    "", // fix round 13: denyReadKeepInPlaceBlock, always-interpolated and empty here (no denyRead entries at all)
    "(allow file-write-data (path \"/dev/null\") (path \"/dev/stdout\") (path \"/dev/stderr\") (path \"/dev/dtracehelper\"))",
    "(allow file-write* (regex #\"^/var/folders/xx/T/[^/]+$\"))",
    "(deny network*)",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/Users/x/.winter/file-history\"))",
    "(deny file-write* file-write-unlink file-write-create (subpath \"/Users/x/custom-root/file-history\"))",
    "(deny file-write* file-write-unlink file-write-create (literal \"/work/.winter/permissions.local.json\"))",
    "(deny file-write* file-write-unlink file-write-create (literal \"/work/.winter/settings.json\"))",
    "(deny file-write* file-write-unlink file-write-create (literal \"/work/.winter/settings.local.json\"))",
    "(deny file-write* file-write-unlink file-write-create (literal \"/work/a/.winter/permissions.local.json\"))",
    "(deny file-write* file-write-unlink file-write-create (literal \"/work/a/.winter/settings.json\"))",
    "(deny file-write* file-write-unlink file-write-create (literal \"/work/a/.winter/settings.local.json\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.[Ww][Ii][Nn][Tt][Ee][Rr]/[Pp][Ee][Rr][Mm][Ii][Ss][Ss][Ii][Oo][Nn][Ss]\\.[Ll][Oo][Cc][Aa][Ll]\\.[Jj][Ss][Oo][Nn]$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.[Ww][Ii][Nn][Tt][Ee][Rr]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\\.[Jj][Ss][Oo][Nn]$\"))",
    "(deny file-write* file-write-unlink file-write-create (regex #\"/\\.[Ww][Ii][Nn][Tt][Ee][Rr]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\\.[Ll][Oo][Cc][Aa][Ll]\\.[Jj][Ss][Oo][Nn]$\"))",
    "",
    ].join("\n");
    const input = { cwd: "/work", writableRoots: ["/work/a"], allowNetwork: false, home: "/Users/x", winterHome: "/Users/x/custom-root", darwinUserTempDir: "/var/folders/xx/T" };
    expect(buildSeatbeltProfile({ ...input })).toBe(EXPECTED);
    // ...and stating the brand EXPLICITLY changes nothing: `WINTER_BRAND` is what the omitted
    // parameter already resolves to.
    expect(buildSeatbeltProfile({ ...input, brand: WINTER_BRAND })).toBe(EXPECTED);
  });

  //
  // The test immediately above is the BYTE-IDENTITY pin for the default brand: it spells the three
  // rendered regexes out in full, and it passed unchanged when the hard-coded `[Ww][Ii][Nn][Tt][Ee][Rr]`
  // became `caseFoldSegment(brand.projectDirName)`. These are the other half.
  test("the any-depth control-plane regexes are DERIVED: under a brand they fence the brand's dot-dir and nothing else", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, brand: { homeDirName: ".acme", projectDirName: ".acme" } });
    expect(p).toContain(String.raw`(deny file-write* file-write-unlink file-write-create (regex #"/\.[Aa][Cc][Mm][Ee]/[Pp][Ee][Rr][Mm][Ii][Ss][Ss][Ii][Oo][Nn][Ss]\.[Ll][Oo][Cc][Aa][Ll]\.[Jj][Ss][Oo][Nn]$"))`);
    expect(p).toContain(String.raw`(deny file-write* file-write-unlink file-write-create (regex #"/\.[Aa][Cc][Mm][Ee]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\.[Jj][Ss][Oo][Nn]$"))`);
    expect(p).toContain(String.raw`(deny file-write* file-write-unlink file-write-create (regex #"/\.[Aa][Cc][Mm][Ee]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\.[Ll][Oo][Cc][Aa][Ll]\.[Jj][Ss][Oo][Nn]$"))`);
    // Winter's own token is GONE -- the fence follows the session's product rather than accumulating.
    expect(p).not.toContain("[Ww][Ii][Nn][Tt][Ee][Rr]");
    // Still three, still never merged by alternation (WS-12 §5.2 is categorical). Fix round 15:
    // scoped to case-folded regex denies specifically -- see the identical scoping comment on the
    // "three SEPARATE any-depth regex denies" test above.
    expect([...p.matchAll(/\(deny file-write\* file-write-unlink file-write-create \(regex #"\/\\\.\[/g)].length).toBe(3);
    expect(p).not.toContain("|");
  });

  test("a brand that SPLITS homeDirName and projectDirName gets BOTH fenced -- a control-plane file exists under each", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, brand: { homeDirName: ".acme", projectDirName: ".acme-proj" } });
    expect(p).toContain(String.raw`/\.[Aa][Cc][Mm][Ee]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\.[Jj][Ss][Oo][Nn]$`);
    expect(p).toContain(String.raw`/\.[Aa][Cc][Mm][Ee]-[Pp][Rr][Oo][Jj]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\.[Jj][Ss][Oo][Nn]$`);
    // Two distinct names -> two sets of three. Winter's own profile makes them one string, which is
    // why the default renders exactly three and is byte-identical. Fix round 15: scoped to
    // case-folded regex denies specifically -- see the identical scoping comment above.
    expect([...p.matchAll(/\(deny file-write\* file-write-unlink file-write-create \(regex #"\/\\\.\[/g)].length).toBe(6);
  });

  test("caseFoldSegment escapes every regex metacharacter and folds only letters", () => {
    // `.` MUST be escaped or the class matches any character -- which would turn the fence into a
    // wildcard rather than a tightening. `-` is literal outside a character class and is left alone,
    // matching `sbplRegexLiteral`'s own escape set.
    expect(caseFoldSegment(".winter")).toBe(String.raw`\.[Ww][Ii][Nn][Tt][Ee][Rr]`);
    expect(caseFoldSegment(".acme-proj")).toBe(String.raw`\.[Aa][Cc][Mm][Ee]-[Pp][Rr][Oo][Jj]`);
    expect(caseFoldSegment("winter")).toBe("[Ww][Ii][Nn][Tt][Ee][Rr]");
    // A digit is neither folded nor escaped; a metacharacter is escaped rather than passed through.
    expect(caseFoldSegment("a1$b")).toBe(String.raw`[Aa]1\$[Bb]`);
  });

  test("empty writableRoots ([]) carves out cwd's own control-plane files exactly once each", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [], allowNetwork: false });
    const denyLines = [...p.matchAll(/\(deny file-write\* file-write-unlink file-write-create \(literal "([^"]*)"\)\)/g)].map((m) => m[1]);
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
    const denyIdx = p.indexOf(`(deny file-write* file-write-unlink file-write-create (subpath "${secret}"))`);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  test("denyWritePaths are a real subpath deny -- unlike the control-plane carve-out, this one IS a blanket subpath rule (scoped to configured denyWrite only)", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, denyWritePaths: ["/some/secret/dir"] });
    expect(p).toMatch(/\(deny file-write\* file-write-unlink file-write-create \(subpath "\/some\/secret\/dir"\)\)/);
  });

  test("denyWritePaths appear BEFORE the mktemp allowance and the control-plane denies (neither carried protection can be shadowed by user config)", () => {
    const p = buildSeatbeltProfile({
      cwd: realTmp(),
      allowNetwork: false,
      denyWritePaths: ["/some/secret/dir"],
      darwinUserTempDir: "/priv/tmp-user",
    });
    const denyWriteIdx = p.indexOf('(deny file-write* file-write-unlink file-write-create (subpath "/some/secret/dir"))');
    const mktempIdx = p.indexOf("[^/]+$");
    const controlPlaneIdx = p.indexOf("(deny file-write* file-write-unlink file-write-create (literal");
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

  test("no denyRead configured emits no file-read* subpath deny at all", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false });
    expect(p).not.toMatch(/\(deny file-read\* \(subpath/);
  });

  // Fix round 15: the ORIGINAL version of this test asserted no `file-write*`-shaped subpath deny at
  // all with nothing configured -- no longer true. claude's own cR (buildDefaultWriteProtectionBlock)
  // ALWAYS contributes many such denies now, regardless of any user configuration. Re-scoped to what
  // this test actually means: a user-configured denyWrite path that was never passed never appears.
  test("no USER-configured denyWritePaths never surfaces a subpath deny for an arbitrary, unconfigured path", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false });
    expect(p).not.toContain('(subpath "/user/configured/secret")');
  });
});

// Fix round 12 ("Important" item, claude's own `Ch`/`ed`, dump byte 15368116/15367994): the
// ancestor-rename-bypass fix -- for every write/read-denied path, ALSO deny file-write-unlink/
// file-write-create on every ancestor directory of it, and on a glob's own fixed prefix.
describe("buildSeatbeltProfile: the ancestor-rename-bypass fix (claude's Ch/ed)", () => {
  test("a plain denyWritePaths entry denies unlink/create on every one of its own ancestors", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, denyWritePaths: ["/work/proj/secrets"] });
    expect(p).toContain("(deny file-write-unlink file-write-create");
    expect(p).toContain('(literal "/work/proj")');
    expect(p).toContain('(literal "/work")');
    expect(p).not.toContain('(literal "/")');
  });

  test("the block ALSO includes the denied path's own recursive (subpath ...) clause -- claude's own Ch adds it a second time, for these two specific operations", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, denyWritePaths: ["/work/proj/secrets"] });
    const idx = p.indexOf("(deny file-write-unlink file-write-create");
    expect(idx).toBeGreaterThanOrEqual(0);
    // The very next "(deny file-write*" occurrence (the ORDINARY deny, rendered earlier in the
    // profile) is a DIFFERENT clause than this one -- searching from `idx` onward stays scoped to
    // THIS block's own text, which the profile's own trailing content (control-plane denies etc.)
    // never repeats verbatim.
    expect(p.indexOf('(subpath "/work/proj/secrets")', idx)).toBeGreaterThan(idx);
  });

  test("a glob-shaped denyWrite entry's own fixed prefix is denied unlink/create too, plus ITS ancestors", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, denyWriteGlobFixedPrefixes: ["/work/proj/sub"] });
    expect(p).toContain('(literal "/work/proj/sub")');
    expect(p).toContain('(literal "/work/proj")');
    expect(p).toContain('(literal "/work")');
  });

  test("denyReadPaths get their OWN, separate ancestor-rename-bypass block, unlink/create too (claude's pR calls the SAME Ch on its own read-deny list)", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, denyReadPaths: ["/secret/data"] });
    const blocks = [...p.matchAll(/\(deny file-write-unlink file-write-create/g)];
    // Fix round 15: ALWAYS +1 now -- buildDefaultWriteProtectionBlock (claude's own cR) feeds its OWN
    // plain, cwd-anchored entries into Ch unconditionally, on every profile, regardless of what (if
    // anything) the caller configured. This test's own read-deny Ch block is the SECOND one.
    expect(blocks.length).toBe(2);
    expect(p).toContain('(literal "/secret")');
  });

  test("both write and read denies each get their own block when both are configured", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, denyWritePaths: ["/w/secret"], denyReadPaths: ["/r/secret"] });
    const blocks = [...p.matchAll(/\(deny file-write-unlink file-write-create/g)];
    // Fix round 15: +1 for buildDefaultWriteProtectionBlock's own unconditional Ch block (see above).
    expect(blocks.length).toBe(3);
  });

  test("no USER-configured denyWrite/denyRead emits exactly ONE ancestor-rename-bypass DENY block -- claude's own cR's default protections, not a user-configured one", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false });
    // Fix round 14: bare "file-write-unlink"/"file-write-create" substrings are no longer absent from
    // an otherwise-plain profile -- Winter's own port of pR's trailing re-permit
    // (buildReadDenyWritePermitBlock) is UNCONDITIONAL on the Winter side (fires whenever there is a
    // write-roots set at all, which is nearly always -- cwd alone qualifies). DISCLOSED, not
    // dump-confirmed: claude's own call site (dump byte 15376527) gates pR's ENTIRE first argument on
    // a truthy outer `e` (`let X=e?uR(e,t?.allowOnly):void 0`) whose own producer was not traced --
    // `uR(e,t)` itself (dump byte 15366505) builds `{denies,allows,writeRoots}` from `e.denyOnly||[]`
    // etc regardless of whether those arrays are EMPTY, so claude's own gate is "does a read-restriction
    // config object exist for this session at all," not "are there any actual denyRead entries" -- an
    // open question left for a future round rather than assumed either way.
    //
    // Fix round 15: this test's own ORIGINAL intent ("Ch never fires with nothing denied") no longer
    // holds even for the DENY form specifically -- claude's own cR (buildDefaultWriteProtectionBlock)
    // feeds ITS OWN plain, cwd-anchored entries into Ch unconditionally, regardless of any USER
    // configuration. Re-scoped to what remains true: with no user-configured denyWrite/denyRead,
    // there is exactly the ONE Ch block cR's own defaults contribute, never a SECOND one from a
    // user-side denyWritePaths/denyReadPaths that was never configured.
    const blocks = [...p.matchAll(/\(deny file-write-unlink file-write-create/g)];
    expect(blocks.length).toBe(1);
  });

  // Fix round 14 (CRITICAL item 1, claude's own pR's own trailing re-permit): the new block this
  // block's own header describes -- see buildReadDenyWritePermitBlock's own header for the full
  // rationale (dump-verified alongside Ch/mR/fR/Li/Cs).
  describe("the pR trailing re-permit (claude's own pR, round 14)", () => {
    test("is emitted, unconditionally, one (subpath ...) clause per write root, right after Ch's own read-side block", () => {
      const p = buildSeatbeltProfile({ cwd: "/work/proj", writableRoots: ["/work/other"], allowNetwork: false });
      const permitIdx = p.indexOf("(allow file-write-unlink file-write-create");
      expect(permitIdx).toBeGreaterThanOrEqual(0);
      expect(p.indexOf('(subpath "/work/proj")', permitIdx)).toBeGreaterThan(permitIdx);
      expect(p.indexOf('(subpath "/work/other")', permitIdx)).toBeGreaterThan(permitIdx);
      // Right after Ch's own read-side block (even when that block is empty, as here) and strictly
      // before the ordinary write-allow block -- the SAME template position `denyReadAncestorRenameBlock`
      // occupies, one slot earlier.
      const writeAllowIdx = p.indexOf("(allow file-write*");
      expect(permitIdx).toBeLessThan(writeAllowIdx);
    });

    test("still fires when a read-deny is ALSO configured, positioned after Ch's own (non-empty) deny this time", () => {
      const p = buildSeatbeltProfile({ cwd: "/work/proj", allowNetwork: false, denyReadPaths: ["/work/proj/.env"] });
      const chIdx = p.indexOf("(deny file-write-unlink file-write-create");
      const permitIdx = p.indexOf("(allow file-write-unlink file-write-create");
      expect(chIdx).toBeGreaterThanOrEqual(0);
      expect(permitIdx).toBeGreaterThan(chIdx);
    });
  });
});

// Fix round 13 ("Important" item 1, claude's own `fR`, dump byte 15367091): "keep read-denied paths
// inside write roots in place" -- a read-denied path sitting inside a writable root previously lost
// its own protection to the write-allow block (last-match-wins): `mv .env x && cat x` renamed the
// read-denied file to a non-denied name and read it through there.
describe("buildSeatbeltProfile: read-deny-keep-in-place (claude's fR)", () => {
  // Isolates JUST this round's own block from the rest of the profile -- round 12's OWN, DIFFERENT
  // ancestor-rename-bypass block (`(deny file-write-unlink file-write-create ...)`) also names
  // ancestor directories as `(literal ...)` entries, unconditionally (it has no "is this ancestor
  // itself under a write root" gate the way THIS round's block does), so a plain whole-profile
  // `.toContain('(literal "...")')` can accidentally match round 12's own output instead of this
  // round's. This round's own block is the ONLY one whose header is exactly "(deny file-write-unlink"
  // followed immediately by a newline (round 12's own header has " file-write-create" right after
  // "unlink", never a newline there) -- sliced out precisely for every assertion below.
  function readDenyKeepInPlaceBlockOf(profile: string): string | undefined {
    const start = profile.indexOf("(deny file-write-unlink\n");
    if (start === -1) return undefined;
    const end = profile.indexOf("(allow file-write-data", start);
    return profile.slice(start, end === -1 ? undefined : end);
  }

  test("a read-denied path inside cwd (a write root) gets a dedicated file-write-unlink deny, emitted AFTER the write-allow block", () => {
    const p = buildSeatbeltProfile({ cwd: "/work/proj", allowNetwork: false, denyReadPaths: ["/work/proj/.env"] });
    const writeAllowIdx = p.indexOf("(allow file-write*");
    const unlinkIdx = p.indexOf('(deny file-write-unlink\n  (subpath "/work/proj/.env")');
    expect(writeAllowIdx).toBeGreaterThanOrEqual(0);
    expect(unlinkIdx).toBeGreaterThan(writeAllowIdx);
  });

  test("a read-denied path OUTSIDE every write root gets no such block -- nothing to 'keep in place' where nothing is writable", () => {
    const p = buildSeatbeltProfile({ cwd: "/work/proj", allowNetwork: false, denyReadPaths: ["/somewhere/else/.env"] });
    expect(readDenyKeepInPlaceBlockOf(p)).toBeUndefined();
  });

  // The denied path's own ancestors are `(literal ...)`-listed ONLY when THEY are themselves under a
  // write root (claude's own `w(N)`, a PROPER-descendant check that excludes equality) -- the denied
  // path's immediate parent (`/work/proj/sub`) qualifies, but cwd itself (`/work/proj`, the write
  // root it EQUALS) and anything above it do not, matching claude's own `Ch`/`fR` exactly.
  test("the denied path's own ancestors are listed as literals, but only the ones that are THEMSELVES properly nested inside a write root", () => {
    const p = buildSeatbeltProfile({ cwd: "/work/proj", allowNetwork: false, denyReadPaths: ["/work/proj/sub/.env"] });
    const block = readDenyKeepInPlaceBlockOf(p);
    expect(block).toBeDefined();
    expect(block).toContain('(subpath "/work/proj/sub/.env")');
    expect(block).toContain('(literal "/work/proj/sub")');
    expect(block).not.toContain('(literal "/work/proj")'); // equals the write root itself -- excluded
    expect(block).not.toContain('(literal "/work")'); // not under any write root at all -- excluded
  });

  test("a nested write root INSIDE the denied path is carved back out (require-all/require-not) -- that subtree stays genuinely writable/removable", () => {
    const p = buildSeatbeltProfile({
      cwd: "/work/proj",
      allowNetwork: false,
      writableRoots: ["/work/proj/denied/build"],
      denyReadPaths: ["/work/proj/denied"],
    });
    const block = readDenyKeepInPlaceBlockOf(p);
    expect(block).toContain("(require-all");
    expect(block).toContain('(require-not (subpath "/work/proj/denied/build"))');
  });

  // The glob's own fixed prefix EQUALS the sole write root here (both "/work/proj") -- per claude's
  // own w(N), the prefix itself is excluded from the literal set for the identical "equals, not a
  // proper descendant" reason the plain-path test above documents; the block still renders (the
  // skip-condition, which DOES include equality, is a separate check from w()).
  test("a glob-shaped read-deny under a write root ALSO gets the block, via its own recursive regex clause", () => {
    const p = buildSeatbeltProfile({
      cwd: "/work/proj",
      allowNetwork: false,
      denyReadGlobEntries: [{ regex: recursiveGlobToSbplRegexSource("/work/proj/**/.env"), fixedPrefix: "/work/proj" }],
    });
    const block = readDenyKeepInPlaceBlockOf(p);
    expect(block).toBeDefined();
    expect(block).toContain(recursiveGlobToSbplRegexSource("/work/proj/**/.env"));
  });

  // A fixed prefix genuinely NESTED under (not equal to) a write root -- the literal-for-the-prefix-
  // itself step DOES fire here, the discriminating case the test just above cannot exercise.
  test("a glob-shaped read-deny whose fixed prefix is NESTED under a write root gets a literal for the prefix itself too", () => {
    const p = buildSeatbeltProfile({
      cwd: "/work/proj",
      allowNetwork: false,
      denyReadGlobEntries: [{ regex: recursiveGlobToSbplRegexSource("/work/proj/sub/**/.env"), fixedPrefix: "/work/proj/sub" }],
    });
    const block = readDenyKeepInPlaceBlockOf(p);
    expect(block).toContain('(literal "/work/proj/sub")');
  });

  test("a glob-shaped read-deny whose fixed prefix has NOTHING to do with any write root is skipped", () => {
    const p = buildSeatbeltProfile({
      cwd: "/work/proj",
      allowNetwork: false,
      denyReadGlobEntries: [{ regex: recursiveGlobToSbplRegexSource("/elsewhere/**/.env"), fixedPrefix: "/elsewhere" }],
    });
    expect(readDenyKeepInPlaceBlockOf(p)).toBeUndefined();
  });

  test("no denyReadPaths/denyReadGlobEntries configured emits no read-deny-keep-in-place block", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false });
    expect(readDenyKeepInPlaceBlockOf(p)).toBeUndefined();
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
// bash-invoked `echo x >> ~/.winter/file-history/<s>/index.jsonl` never passes through a write
// tool's fence at all, so the seatbelt is the only enforcement point left -- exactly the reasoning
// WS-12 §5.2's control-plane carve-out already records for `.winter/permissions.local.json`.
//
// WS-21 §6.3 item 6, fix round 1: renamed from "backups" -- the checkpoint store's own on-disk
// dirname (`checkpoint/file-history.ts`'s `CHECKPOINT_BACKUPS_DIRNAME`) is a separate constant,
// owned by lane L1b, which renames it to match; see this fix round's report.
describe("buildSeatbeltProfile: baseline <home>/.winter/file-history WRITE denial (T8 rider 25)", () => {
  test("home renders a subpath write-deny for <home>/.winter/file-history, layered AFTER the write-allow block", () => {
    const home = realTmp();
    const p = buildSeatbeltProfile({ cwd: home, allowNetwork: false, home });
    const allowIdx = p.indexOf("(allow file-write*\n");
    const denyIdx = p.indexOf(`(deny file-write* file-write-unlink file-write-create (subpath "${join(home, ".winter", "file-history")}"))`);
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  test("home is canonicalized the same graceful way as every other path this module handles", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false, home: "/does/not/exist/home" });
    expect(p).toContain('(deny file-write* file-write-unlink file-write-create (subpath "/does/not/exist/home/.winter/file-history"))');
  });

  test("home omitted emits no baseline file-history denial (same omitted-is-still-correct posture)", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false });
    expect(p).not.toContain(".winter/file-history");
  });
});

// Fix round 15 (CRITICAL, claude's own cR/Do/qa(), dump byte 15365486/15282344/15282484): claude's
// write profile ALWAYS adds cR(e)'s own default-protected entries to the write denies (mR: p=[
// ...denyWithinAllow,...cR(r)], then Ch(p)) -- shell rc/config files, editor/agent dot-dirs, and
// .git/hooks + .git/config, each at cwd's own top level AND at any depth (an unanchored glob), with
// no opt-in flag to forget. Winter's profile had none of these.
describe("buildSeatbeltProfile: default write protections (claude's own cR, round 15)", () => {
  test("every Do filename is denied at cwd's own top level, with the widened (survives-the-re-permit) operation list", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false });
    for (const f of [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json"]) {
      expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (subpath "${join(cwd, f)}"))`);
    }
  });

  test("every Do filename is ALSO denied at any depth (an unanchored, any-depth regex)", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: false });
    expect(p).toContain('(deny file-write* file-write-unlink file-write-create (regex #"/\\.gitconfig$"))');
    expect(p).toContain('(deny file-write* file-write-unlink file-write-create (regex #"/\\.zshrc$"))');
  });

  test("qa()'s own dot-dirs (.vscode, .idea, .claude/commands, .claude/agents) are denied recursively, both ways", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false });
    for (const d of [".vscode", ".idea", ".claude/commands", ".claude/agents"]) {
      expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (subpath "${join(cwd, d)}"))`);
      expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (regex #"/${d.replace(/\./g, "\\.")}(/.*)?$"))`);
    }
  });

  test("Winter's OWN brand.projectDirName gets commands/agents/mcp.json too, derived from the brand -- not just claude's literal .claude/ spelling", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false });
    expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (subpath "${join(cwd, ".winter", "commands")}"))`);
    expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (subpath "${join(cwd, ".winter", "agents")}"))`);
    expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (subpath "${join(cwd, ".winter", "mcp.json")}"))`);
  });

  test("a rebranded product's OWN dot-dir gets its own commands/agents/mcp.json protected, not .winter's", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false, brand: { homeDirName: ".acme", projectDirName: ".acme" } });
    expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (subpath "${join(cwd, ".acme", "mcp.json")}"))`);
    expect(p).not.toContain(".winter/mcp.json");
  });

  test(".git/hooks is always protected, both ways", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false });
    expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (subpath "${join(cwd, ".git", "hooks")}"))`);
    expect(p).toContain('(deny file-write* file-write-unlink file-write-create (regex #"/\\.git/hooks(/.*)?$"))');
  });

  test(".git/config is protected by default, both ways", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false });
    expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (subpath "${join(cwd, ".git", "config")}"))`);
    expect(p).toContain('(deny file-write* file-write-unlink file-write-create (regex #"/\\.git/config$"))');
  });

  test("allowGitConfigWrites: true (claude's own cR(e=true)) drops the .git/config protection, and ONLY that one", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false, allowGitConfigWrites: true });
    expect(p).not.toContain(join(cwd, ".git", "config") + '"))');
    expect(p).not.toContain('/\\.git/config$');
    // .git/hooks is unaffected -- the flag only ever gates .git/config, matching cR's own `!e` guard.
    expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (subpath "${join(cwd, ".git", "hooks")}"))`);
  });

  test("the plain, cwd-anchored entries ALSO get Ch's own ancestor-rename-bypass fence", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false });
    // Ch's own ancestor-literal for cwd's OWN parent directory -- proves these entries were fed
    // into buildAncestorRenameBypassBlock, not just rendered as an ordinary deny.
    const cwdParent = cwd.slice(0, cwd.lastIndexOf("/"));
    expect(p).toContain(`(literal "${cwdParent}")`);
  });

  // A genuine empirical finding: a first draft fed EVERY default-protected entry (including Winter's
  // own .winter/mcp.json, .winter/commands, .winter/agents) into Ch's own ancestor-fence, and a real
  // sandbox-exec run against it regressed `mkdir -p .winter/memory` (Winter's own memory-file
  // mechanism, CLAUDE.md's own "Memory is file-based") in a project that never had a `.winter` dir
  // yet -- Ch's own literal-ancestor protection denies file-write-create on the ANCESTOR itself, and
  // `.winter` unlike claude's own `.claude` is a directory Winter routinely needs to create fresh.
  test("Winter's OWN .winter dir is deliberately EXCLUDED from Ch's own ancestor-fence, so it stays freely creatable -- .git is NOT excluded, matching claude's own literal cR entry", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, allowNetwork: false });
    expect(p).not.toContain(`(literal "${join(cwd, ".winter")}")`);
    // .winter/mcp.json/commands/agents themselves are still protected from create/unlink at their
    // OWN exact path -- only the ancestor-rename-bypass fence on .winter itself is excluded.
    expect(p).toContain(`(deny file-write* file-write-unlink file-write-create (subpath "${join(cwd, ".winter", "mcp.json")}"))`);
    // .git DOES get the ancestor fence (claude's own literal cR entry, no Winter-specific need to
    // keep .git freely creatable inside the sandbox the way .winter needs to be).
    expect(p).toContain(`(literal "${join(cwd, ".git")}")`);
  });

  test("no default protection at all is emitted for the workflow-worker profile (a completely different, stricter mechanism -- deny file-write* wholesale already covers it)", () => {
    const p = buildWorkflowWorkerSeatbeltProfile("/usr/local/bin/winter", { home: undefined });
    expect(p).not.toContain("gitconfig");
    expect(p).not.toContain(".git/hooks");
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
