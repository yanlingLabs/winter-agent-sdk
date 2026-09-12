// P9a-6: `winter --version`'s own test. Spawns the REAL dev-leg entrypoint (`bun src/main.ts`, the
// same invocation transport-equivalence.test.ts's dev-child leg uses -- `process.execPath` under Bun
// IS Bun, which runs a `.ts` file directly, no separate compile step needed to prove the argv door).
// The compiled-binary leg of this same behaviour is proven by `verify:compiled` (Task S.1's own
// checkpoint), which runs the version-pinned probe against the real `bun build --compile` artifact.
import { describe, test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { SDK_VERSION } from "@yanlinglabs/winter-agent-sdk";

const MAIN_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));

async function runMain(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, MAIN_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("winter --version (P9a-6)", () => {
  test("prints SDK_VERSION + newline to stdout and exits 0", async () => {
    const { stdout, stderr, exitCode } = await runMain(["--version"]);
    expect(stdout).toBe(`${SDK_VERSION}\n`);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  // The FIRST door wins: checked before the `__workflow-worker` dispatch and before
  // `parseConfigFromArgv`'s `--run` requirement, so a caller who tacks `--version` onto anything else
  // still gets the version rather than a "missing --config-json" throw.
  test("`--version --run` still prints the version -- checked before the --run parse", async () => {
    const { stdout, exitCode } = await runMain(["--version", "--run"]);
    expect(stdout).toBe(`${SDK_VERSION}\n`);
    expect(exitCode).toBe(0);
  });

  test("no `-v` shorthand -- the surface stays exactly `--version`", async () => {
    const { stdout, exitCode } = await runMain(["-v"]);
    // Falls through to the ordinary argv parse, which throws on a missing `--run` -- NOT the version.
    expect(stdout).not.toBe(`${SDK_VERSION}\n`);
    expect(exitCode).not.toBe(0);
  });

  test("no `--help` shorthand either", async () => {
    const { stdout, exitCode } = await runMain(["--help"]);
    expect(stdout).not.toBe(`${SDK_VERSION}\n`);
    expect(exitCode).not.toBe(0);
  });
});
