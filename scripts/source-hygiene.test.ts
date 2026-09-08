// P7a fix wave (item 6): NO RAW CONTROL BYTES IN SOURCE — a permanent gate, not a one-off sweep.
//
// The whole-branch review found the last two raw `0x00` bytes in the four source trees, inside a
// string literal in `packages/runtime/src/permissions/approvals.ts` (`targets.join("<NUL>")`, a
// separator that cannot occur in a path). They were replaced with `\u0000`, which is byte-for-byte
// the same string at runtime and a visible, greppable, diffable four characters on disk.
//
// WHY THIS IS WORTH A GATE. A raw control byte in source is invisible in every place a human looks
// at code — an editor, a `git diff`, a review UI, a terminal, this repository's own `grep` output —
// while being fully significant to the compiler. That asymmetry is the whole hazard: the byte cannot
// be reviewed, so whatever it does is unreviewed, and a second one added later is unreviewable in
// exactly the same way. It also breaks tools that reasonably assume text: `grep` treats a file
// containing NUL as binary and reports "Binary file matches" instead of the line, which is precisely
// how these two survived every earlier sweep of this tree. A sweep fixes the two bytes that exist
// today; only a test stops the next one.
//
// SCOPE: every TRACKED `.ts` file under `packages/<pkg>/src/` and `scripts/` — all seven packages
// (not just the four the brand gate scans) and test files included, because a control byte is
// exactly as invisible in a fixture as in an implementation.
//
// `git ls-files` is the enumerator, so "tracked" is git's own answer rather than a filesystem walk
// that would also sweep build output, editor droppings and anything `.gitignore`d. A file enters the
// gate the moment it is `git add`ed, which is strictly before any commit can carry it.
import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// scripts/ -> the repository root.
const REPO_ROOT = resolve(import.meta.dir, "..");

/** `packages/<one segment>/src/**\/*.ts` and `scripts/*.ts`, evaluated against git's own path list. */
const IN_SCOPE = /^(?:packages\/[^/]+\/src\/.*|scripts\/[^/]*)\.ts$/;

/**
 * The forbidden set: any byte below `0x20` that is not TAB (`0x09`), LF (`0x0a`) or CR (`0x0d`).
 *
 * Those three are the only control bytes that carry meaning in a text file, and every one of them
 * is rendered by every tool that shows source. Everything else in the C0 range — NUL, the bell, the
 * escape byte that starts an ANSI sequence, a vertical tab — is invisible, and a string that needs
 * one has a four-character escape (`\u0000`, `\x1b`) that is not.
 */
function isForbidden(byte: number): boolean {
  return byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d;
}

export interface ControlByteOffence {
  file: string;
  /** 1-based, counting LF — the line a reader would jump to. */
  line: number;
  byte: string;
}

export function scanBufferForControlBytes(file: string, buf: Uint8Array): ControlByteOffence[] {
  const out: ControlByteOffence[] = [];
  let line = 1;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] as number;
    if (b === 0x0a) {
      line++;
      continue;
    }
    if (isForbidden(b)) out.push({ file, line, byte: `0x${b.toString(16).padStart(2, "0")}` });
  }
  return out;
}

function trackedSourceFiles(): string[] {
  // `-z` because a path may contain anything but NUL — and quoting is exactly the surface this file
  // is about. A git failure THROWS rather than yielding an empty list: a gate that silently scans
  // nothing is worse than no gate, and the floor assertion below is the second guard on that.
  const listing = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return listing.split(String.fromCharCode(0)).filter((f) => IN_SCOPE.test(f)).sort();
}

describe("P7a fix wave (item 6): no raw control bytes in TypeScript source", () => {
  const files = trackedSourceFiles();

  test("every tracked .ts under packages/*/src and scripts/ is free of raw control bytes", () => {
    const offences: ControlByteOffence[] = [];
    for (const file of files) offences.push(...scanBufferForControlBytes(file, readFileSync(resolve(REPO_ROOT, file))));
    // The message names the file, the line and the byte, because the one thing a reader cannot do
    // with this failure is see it in their editor.
    const detail = offences.map((o) => `  ${o.file}:${o.line}  ${o.byte}`).join("\n");
    expect(offences.length === 0 ? "" : `raw control bytes in source (use an escape, e.g. \\u0000):\n${detail}`).toBe("");
  });

  test("the scan is not vacuous: it covers every package with a src tree, scripts/, and hundreds of files", () => {
    // A gate whose enumerator quietly returns nothing passes forever. Every guard here is a fact
    // about THIS repository that a broken listing cannot satisfy by accident.
    expect(files.length).toBeGreaterThan(400);
    // Six of the seven packages; `packages/platform` is the prebuilt-binary package and has no
    // `src` tree at all (its only tracked file is `darwin-arm64/package.json`), so naming it here
    // would assert a fact about this repository that is false.
    for (const pkg of ["sdk", "runtime", "provider-runtime", "provider-catalog", "conformance", "provider-conformance"]) {
      expect([pkg, files.some((f) => f.startsWith(`packages/${pkg}/src/`))]).toEqual([pkg, true]);
    }
    expect(files.some((f) => f.startsWith("scripts/"))).toBe(true);
    // TEST files are in scope too — a control byte hides equally well in a fixture.
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(true);
    // And the file the fix wave cleaned is really being read.
    expect(files).toContain("packages/runtime/src/permissions/approvals.ts");
  });

  test("the scanner itself catches a planted byte, and passes the three that are legal", () => {
    // Without this, "0 offences" could equally mean "the predicate never fires". The plants are
    // BUILT here rather than committed as a fixture file, so this repository never contains one.
    const enc = new TextEncoder();
    const planted = enc.encode(`const sep = "a${String.fromCharCode(0)}b";\nconst esc = "a\\u0000b";\n`);
    const found = scanBufferForControlBytes("planted.ts", planted);
    expect(found).toEqual([{ file: "planted.ts", line: 1, byte: "0x00" }]);

    // TAB, LF and CR are how real source is laid out and must never be flagged.
    expect(scanBufferForControlBytes("ok.ts", enc.encode("\tconst a = 1;\r\n\tconst b = 2;\n"))).toEqual([]);
    // The other invisibles that matter in practice: the ANSI escape byte and a vertical tab.
    expect(scanBufferForControlBytes("ansi.ts", enc.encode(`red("${String.fromCharCode(27)}[31m");`)).map((o) => o.byte)).toEqual(["0x1b"]);
    expect(scanBufferForControlBytes("vt.ts", enc.encode(`x = "${String.fromCharCode(11)}";`)).map((o) => o.byte)).toEqual(["0x0b"]);
    // Line numbers count LF and nothing else.
    expect(scanBufferForControlBytes("lines.ts", enc.encode(`one\ntwo\nthree${String.fromCharCode(0)}\n`))[0]?.line).toBe(3);
  });

  test("the separator that started this keeps its exact runtime value", () => {
    // `\u0000` is the SAME string the raw byte was; the change is to the source, never to behaviour.
    // Pinned here rather than trusted, because a fix that quietly turned the separator into a
    // two-character `\0` sequence, an empty string, or a space would still make the gate above pass
    // while changing what `approvals.ts` compares.
    const src = readFileSync(resolve(REPO_ROOT, "packages/runtime/src/permissions/approvals.ts"), "utf8");
    expect(src).toContain('issuedTargets.join("\\u0000") !== currentTargets.join("\\u0000")');
    expect("\u0000").toBe(String.fromCharCode(0));
  });
});
