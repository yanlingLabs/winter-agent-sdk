// Pure tests of the case-variant scan: the name fold, the unlistable-folder result, and that every
// write root is scanned (not only roots on a case-sensitive volume). The real-volume, real-sandbox-exec
// suite is case-variants.darwin.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCaseVariantsOf, foldName, setCaseSensitivityProbeForTest } from "./case-variants.ts";
import { caseSensitiveWriteRootsOrRefuse, SandboxCaseVariantError, SandboxUnavailableError } from "./spawn.ts";

describe("foldName", () => {
  test("ẞ (U+1E9E) folds to ss, through ß: one lower/upper round is not enough", () => {
    expect(foldName("paẞ")).toBe(foldName("pass"));
    expect(foldName("PAẞ")).toBe(foldName("pass"));
    expect(foldName("paß")).toBe(foldName("PASS"));
  });

  test("the ﬁ ligature folds with FI and fi", () => {
    expect(foldName("ﬁle")).toBe(foldName("FILE"));
    expect(foldName("ﬁle")).toBe(foldName("file"));
  });

  test("the Kelvin sign (U+212A) folds with k and K", () => {
    expect(foldName("Key")).toBe(foldName("key"));
    expect(foldName("Key")).toBe(foldName("KEY"));
  });

  test("σ, ς and Σ fold together", () => {
    expect(foldName("ας")).toBe(foldName("ασ"));
    expect(foldName("ΑΣ")).toBe(foldName("ας"));
    expect(foldName("σa")).toBe(foldName("ςa"));
  });

  test("distinct names stay distinct; composed and decomposed forms match", () => {
    expect(foldName("proj")).not.toBe(foldName("prok"));
    expect(foldName("café")).toBe(foldName("CAFÉ"));
  });
});

describe("the scan (case sensitivity decided by the test seam)", () => {
  const dirs: string[] = [];
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
    for (const d of dirs.splice(0)) {
      try {
        chmodSync(join(d, "locked"), 0o755);
      } catch {}
      rmSync(d, { recursive: true, force: true });
    }
  });
  function tmp(): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "winter-casescan-")));
    dirs.push(d);
    return d;
  }

  test.skipIf(process.getuid?.() === 0)("a folder that cannot be listed is reported as unlistable, not as a variant, and refuses with its own message", () => {
    const d = tmp();
    const root = join(d, "locked", "proj");
    mkdirSync(root, { recursive: true });
    chmodSync(join(d, "locked"), 0o111);
    restore = setCaseSensitivityProbeForTest(() => true);
    expect(findCaseVariantsOf(root)).toEqual({ variants: [], unlistable: join(d, "locked") });
    let err: unknown;
    try {
      caseSensitiveWriteRootsOrRefuse([root]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SandboxCaseVariantError);
    expect(err).toBeInstanceOf(SandboxUnavailableError);
    const message = (err as Error).message;
    expect(message).toContain("cannot be listed");
    expect(message).toContain("cannot rule out");
    expect(message).not.toContain("which differs from it only in letter case");
    expect((err as SandboxCaseVariantError).unlistable).toBe(join(d, "locked"));
  });

  test.skipIf(process.getuid?.() === 0)("a root on a case-insensitive volume under a case-sensitive ancestor is still scanned (the ancestor level is checked)", () => {
    const d = tmp();
    const root = join(d, "locked", "mnt", "proj");
    mkdirSync(root, { recursive: true });
    chmodSync(join(d, "locked"), 0o111);
    // `locked` and above count as case-sensitive; the root's own volume (under `mnt`) does not. The
    // unlistable `locked` is only found if the insensitive root is scanned at all.
    restore = setCaseSensitivityProbeForTest((p) => !p.startsWith(join(d, "locked", "mnt")));
    expect(() => caseSensitiveWriteRootsOrRefuse([root])).toThrow(SandboxCaseVariantError);
  });

  test("no variant and no case-sensitive level: nothing to fence", () => {
    const d = tmp();
    mkdirSync(join(d, "proj"));
    restore = setCaseSensitivityProbeForTest(() => false);
    expect(findCaseVariantsOf(join(d, "proj"))).toEqual({ variants: [] });
    expect(caseSensitiveWriteRootsOrRefuse([join(d, "proj")])).toEqual([]);
  });
});
