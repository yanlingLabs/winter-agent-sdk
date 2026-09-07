// P7a Lane C, Step 4's own test. This is the ONE test in the repository proving the not-opted-in
// path of `verify-published-install.ts` -- and, by design, the ONLY thing it can prove: opting in
// for real means spending a real GitHub Packages token against a real publish, which this hermetic
// suite must never do (mirrors `scripts/verify-provider-live.test.ts`'s own opt-in-gate shape and
// its own reasoning for why: `bun test` inherits the developer's shell, so STRIPPING the variable
// rather than merely not setting it is the part that actually matters).
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { OPT_IN_VAR, SKIPPED_LINE, currentPublishedVersion, runtimeLabel } from "./verify-published-install.ts";

/** `process.env` with the opt-in variable removed, so a developer's own exported token (if any) can never leak into this test's spawned child. */
function strippedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === OPT_IN_VAR) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

async function run(extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "verify-published-install.ts")], {
    cwd: import.meta.dir,
    env: strippedEnv(extra),
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } finally {
    proc.kill();
  }
}

describe("runtimeLabel (review r1 Minor-5)", () => {
  test("under `bun test`, names Bun -- never hard-codes \"node\"", () => {
    // This suite itself runs under `bun test`, so `process.versions.bun` is genuinely set here --
    // the same condition that holds for every real invocation (`bun run
    // scripts/verify-published-install.ts` is this script's only entry point; there is no `node`
    // path to it), which is exactly the case the old hard-coded "failed under node" message got wrong.
    expect(typeof process.versions.bun).toBe("string");
    const label = runtimeLabel();
    expect(label).toStartWith("Bun ");
    expect(label.toLowerCase()).not.toContain("node");
  });
});

describe("currentPublishedVersion", () => {
  test("reads the committed VERSION file and returns a valid, leading-zero-free semver", () => {
    const version = currentPublishedVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const raw = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
    expect(raw.split(".").map((p) => String(parseInt(p, 10))).join(".")).toBe(version);
  });

  test("matches the version every publishable package.json is currently synced to", () => {
    const pkg = JSON.parse(readFileSync(new URL("../packages/conformance/package.json", import.meta.url), "utf8")) as { version: string };
    expect(currentPublishedVersion()).toBe(pkg.version);
  });
});

describe("the script itself, spawned (proves ONLY the skip path -- never a real install)", () => {
  test("with no token, it prints exactly ONE line, exits 0, and reaches no network", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(SKIPPED_LINE);
    expect(result.stderr).toBe("");
  }, 30_000);

  test("an empty-string token is treated the same as unset", async () => {
    const result = await run({ [OPT_IN_VAR]: "" });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(SKIPPED_LINE);
  }, 30_000);
});
