// Case-variant write roots on a REAL case-sensitive volume, under real `sandbox-exec`.
//
// Seatbelt matches every path filter ignoring case, so on a case-sensitive volume the write root
// `<v>/proj` also admitted a distinct `<v>/PROJ` (measured before this fix: from cwd `proj`,
// `echo x > ../PROJ/escape.txt` landed, and a non-cwd root's variant could be created and written).
// This suite makes a small case-sensitive APFS disk image in a temp dir (`hdiutil`, never browsed or
// opened in Finder: `-nobrowse`), mounts it under that temp dir, and detaches and deletes it at the end.
// Skipped (visibly) where there is no Seatbelt or the image cannot be made and attached.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildSeatbeltProfile } from "./profile.ts";
import { findCaseVariantsOf, isOnCaseSensitiveVolume } from "./case-variants.ts";
import { caseSensitiveWriteRootsOrRefuse, isSandboxAvailable, runCommand, SandboxCaseVariantError, SandboxUnavailableError } from "./spawn.ts";

const workDir = process.platform === "darwin" ? realpathSync(mkdtempSync(join(tmpdir(), "winter-casevol-"))) : "";
const mountPoint = join(workDir, "mnt");
const image = join(workDir, "cs.dmg");
let attached = false;

function setUpImage(): boolean {
  if (!isSandboxAvailable()) return false;
  mkdirSync(mountPoint);
  const made = spawnSync("/usr/bin/hdiutil", ["create", "-quiet", "-size", "32m", "-fs", "Case-sensitive APFS", "-volname", "wintercasetest", "-o", image], { timeout: 120_000 });
  if (made.status !== 0) return false;
  const att = spawnSync("/usr/bin/hdiutil", ["attach", "-quiet", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint, image], { timeout: 120_000 });
  attached = att.status === 0;
  return attached;
}

const imageReady = process.platform === "darwin" && setUpImage();
const t = test.skipIf(!imageReady);
let n = 0;
/** A fresh folder on the case-sensitive volume for one test. */
function vol(): string {
  const dir = join(realpathSync(mountPoint), `t${++n}`);
  mkdirSync(dir);
  return dir;
}

async function run(command: string, cwd: string, writableRoots: string[] = []) {
  return runCommand({ command, cwd, env: { ...process.env, TMPDIR: cwd }, timeoutMs: 8000, settings: {}, writableRoots });
}

afterAll(() => {
  if (attached) spawnSync("/usr/bin/hdiutil", ["detach", "-quiet", "-force", mountPoint], { timeout: 120_000 });
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

describe("case-variant write roots on a case-sensitive volume (real disk image, real sandbox-exec)", () => {
  t("the volume probe: the image is case-sensitive, the temp dir's volume is not", () => {
    expect(isOnCaseSensitiveVolume(realpathSync(mountPoint))).toBe(true);
    expect(isOnCaseSensitiveVolume(join(realpathSync(mountPoint), "not", "yet"))).toBe(true);
    expect(isOnCaseSensitiveVolume(workDir)).toBe(false);
  });

  t("an EXISTING case variant of cwd refuses the command before anything runs; the variant is untouched", async () => {
    const v = vol();
    mkdirSync(join(v, "proj"));
    mkdirSync(join(v, "PROJ"));
    await expect(run("echo x > ../PROJ/escape.txt", join(v, "proj"))).rejects.toBeInstanceOf(SandboxCaseVariantError);
    expect(readdirSync(join(v, "PROJ"))).toEqual([]);
    // A subclass of the unavailability error, so the Bash and Monitor tools report it to the model.
    expect(new SandboxCaseVariantError("/a", ["/A"])).toBeInstanceOf(SandboxUnavailableError);
  });

  t("an existing variant of an extra write root, or of an ancestor of a root (`A/proj` beside `a/proj`), refuses too; a file variant counts", async () => {
    const v = vol();
    mkdirSync(join(v, "cwd"));
    mkdirSync(join(v, "scratch"));
    writeFileSync(join(v, "Scratch"), "a distinct file");
    await expect(run("true", join(v, "cwd"), [join(v, "scratch")])).rejects.toBeInstanceOf(SandboxCaseVariantError);
    mkdirSync(join(v, "a", "proj"), { recursive: true });
    mkdirSync(join(v, "A", "proj"), { recursive: true });
    expect(findCaseVariantsOf(join(v, "a", "proj"))).toEqual([join(v, "A", "proj")]);
    await expect(run("true", join(v, "a", "proj"))).rejects.toBeInstanceOf(SandboxCaseVariantError);
  });

  t("a variant that lies inside ANOTHER write root is not an escape (that root is writable anyway) and is not refused", () => {
    const v = vol();
    mkdirSync(join(v, "w", "out"), { recursive: true });
    mkdirSync(join(v, "w", "OUT"));
    expect(caseSensitiveWriteRootsOrRefuse([join(v, "w"), join(v, "w", "out")])).toEqual([join(v, "w"), join(v, "w", "out")]);
  });

  t("no existing variant: the command runs, a variant of a root cannot be CREATED (mkdir, symlink, rename), and ordinary work inside the roots is unaffected", async () => {
    const v = vol();
    const cwd = join(v, "solo");
    const scratch = join(v, "scratch");
    mkdirSync(cwd);
    mkdirSync(scratch);
    const ok = await run(`echo ok > a && mkdir -p d/e && mv a d/e/ && echo ok > "${scratch}/b" && mkdir "${scratch}/sub" && mv "${scratch}/b" "${scratch}/sub/" && rm -r d "${scratch}/sub"`, cwd, [scratch]);
    expect(ok.exitCode).toBe(0);
    expect(ok.profile).toContain(`(deny file-write-create\n  (literal "${cwd}")\n  (literal "${scratch}"))`);
    for (const probe of [`mkdir "${v}/SCRATCH"`, `ln -s /tmp "${v}/Scratch"`, `mkdir "${scratch}/m" && mv "${scratch}/m" "${v}/SCRATCH"`, "mkdir ../SOLO", "mkdir ../Solo && echo x > ../Solo/e"]) {
      const res = await run(probe, cwd, [scratch]);
      expect({ probe, exit: res.exitCode === 0 }).toEqual({ probe, exit: false });
    }
    expect(readdirSync(v).sort()).toEqual(["scratch", "solo"]);
  });

  t("the default (case-insensitive) volume: no create fence, so the profile is byte-identical to one built without the field", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-casevol-default-")));
    try {
      const res = await run("echo ok > a", cwd);
      expect(res.exitCode).toBe(0);
      expect(res.profile).not.toContain("(deny file-write-create\n");
      expect(caseSensitiveWriteRootsOrRefuse([cwd])).toEqual([]);
      expect(buildSeatbeltProfile({ cwd, allowNetwork: false, caseSensitiveWriteRoots: [] })).toBe(buildSeatbeltProfile({ cwd, allowNetwork: false }));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
