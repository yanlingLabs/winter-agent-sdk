// Kept as its own file, separate from paths.test.ts, deliberately: this helper is Task 7's P1-N
// addition, landing while paths.test.ts itself has an unrelated concurrent edit in flight
// elsewhere in this same session (a darwin-only skipIf gate on a different test). A new file has
// zero chance of colliding with that edit.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectDirName } from "./project-dir-name.ts";
import { WinterPathsError } from "./temp.ts";
import { sessionTempDir } from "./temp.ts";
import { compatibilityKeys } from "./keys.ts";

describe("resolveProjectDirName (Controller Ruling P1-N)", () => {
  test("defaults to the given projectKey when WINTER_PROJECT_DIR_NAME is unset", () => {
    expect(resolveProjectDirName("some-project-key", {})).toBe("some-project-key");
  });

  test("treats an empty-string override as unset", () => {
    expect(resolveProjectDirName("some-project-key", { WINTER_PROJECT_DIR_NAME: "" })).toBe("some-project-key");
  });

  test("treats a whitespace-only override as unset", () => {
    expect(resolveProjectDirName("some-project-key", { WINTER_PROJECT_DIR_NAME: "   " })).toBe("some-project-key");
  });

  test("an explicit undefined value in the env map is treated as unset", () => {
    expect(resolveProjectDirName("some-project-key", { WINTER_PROJECT_DIR_NAME: undefined })).toBe("some-project-key");
  });

  test("a valid override REPLACES the default entirely, not appended/combined", () => {
    expect(resolveProjectDirName("some-project-key", { WINTER_PROJECT_DIR_NAME: "my-custom-name" })).toBe("my-custom-name");
  });

  test("rejects an override containing a path separator", () => {
    expect(() => resolveProjectDirName("k", { WINTER_PROJECT_DIR_NAME: "a/b" })).toThrow(WinterPathsError);
  });

  test("rejects an absolute-path-shaped override", () => {
    expect(() => resolveProjectDirName("k", { WINTER_PROJECT_DIR_NAME: "/etc/passwd" })).toThrow(WinterPathsError);
  });

  test("rejects a traversal override", () => {
    expect(() => resolveProjectDirName("k", { WINTER_PROJECT_DIR_NAME: "../escape" })).toThrow(WinterPathsError);
  });

  test("rejects an override with a space or other non-alnum-dash character", () => {
    expect(() => resolveProjectDirName("k", { WINTER_PROJECT_DIR_NAME: "has space" })).toThrow(WinterPathsError);
    expect(() => resolveProjectDirName("k", { WINTER_PROJECT_DIR_NAME: "has.dot" })).toThrow(WinterPathsError);
  });

  test("reads process.env when no env map is supplied", () => {
    const prior = process.env.WINTER_PROJECT_DIR_NAME;
    try {
      process.env.WINTER_PROJECT_DIR_NAME = "from-real-env";
      expect(resolveProjectDirName("k")).toBe("from-real-env");
    } finally {
      if (prior === undefined) delete process.env.WINTER_PROJECT_DIR_NAME;
      else process.env.WINTER_PROJECT_DIR_NAME = prior;
    }
  });

  test("NEVER renames the temp cwd segment: sessionTempDir's tempProjectKey is unaffected even when WINTER_PROJECT_DIR_NAME is set in the SAME env", () => {
    const base = mkdtempSync(join(tmpdir(), "winter-project-dir-name-test-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-project-dir-name-cwd-"));
    try {
      const keys = compatibilityKeys(cwd);
      const env = { WINTER_TMPDIR: base, WINTER_PROJECT_DIR_NAME: "totally-different-override-name" };

      // resolveProjectDirName itself does not touch sessionTempDir at all — it is a standalone
      // function a PERSISTENT-store consumer would call; demonstrate the non-interaction directly:
      // the temp resolver, given the SAME env, keeps using the ordinary tempProjectKey.
      const dirs = sessionTempDir({ tempProjectKey: keys.tempProjectKey, backendUuid: "11111111-1111-4111-8111-111111111111", env });

      expect(dirs.root).toContain(keys.tempProjectKey);
      expect(dirs.root).not.toContain("totally-different-override-name");

      // meanwhile the SAME env's override IS what a persistent-store consumer would get for the
      // project directory name, entirely independently of the temp path computed above.
      expect(resolveProjectDirName(keys.transcriptProjectKey, env)).toBe("totally-different-override-name");
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
