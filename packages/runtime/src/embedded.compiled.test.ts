// WS-23: the embedded topology inside a `bun build --compile` binary -- the shape an embedding host
// (Winter's daemon, `winter-core`) ships in.
//
// A tiny HOST plus a one-line WORKER FILE are compiled together (the worker as a second entrypoint),
// and the host constructs the Worker from that file's PLAIN relative path -- the only spelling that
// works in a `$bunfs` binary (WS-23 spike #1: `new URL(…, import.meta.url).href` hangs there; a wrong
// plain path is an error event, measured). The host then drives ONE real session through `query()`
// and `spawnEmbeddedWorker`, on a scripted `winter-test/*` model and a temp WINTER_HOME.
//
// It compiles the whole runtime, which takes a few seconds; that is the proof, because dev and
// compiled resolution differ (the worker's `import.meta.url` is `/$bunfs/…` in the binary).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNTIME_SRC = import.meta.dir;
const SDK_INDEX = join(RUNTIME_SRC, "..", "..", "sdk", "src", "index.ts");
const dir = mkdtempSync(join(tmpdir(), "winter-embedded-compiled-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a compiled host runs one embedded session in a Worker built from its plain entry path", async () => {
  writeFileSync(join(dir, "worker.ts"), `import ${JSON.stringify(join(RUNTIME_SRC, "embedded-worker.ts"))};\n`);
  writeFileSync(
    join(dir, "host.ts"),
    [
      `import { query } from ${JSON.stringify(SDK_INDEX)};`,
      `import { spawnEmbeddedWorker } from ${JSON.stringify(join(RUNTIME_SRC, "embedded-host.ts"))};`,
      `import { RUNTIME_VERSION } from ${JSON.stringify(join(RUNTIME_SRC, "version.ts"))};`,
      `let exit;`,
      `const messages = [];`,
      `for await (const m of query({ prompt: "go", options: {`,
      `  model: "winter-test/tooluse",`,
      `  cwd: process.env.PROBE_CWD,`,
      `  env: { PATH: process.env.PATH, WINTER_HOME: process.env.PROBE_HOME, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" },`,
      `  spawnClaudeCodeProcess: (o) => { const p = spawnEmbeddedWorker({ workerEntry: "./worker.ts", spawn: o }); exit = p.exited; return p; },`,
      `} })) messages.push(m);`,
      `const result = messages.find((m) => m.type === "result");`,
      `console.log(JSON.stringify({ compiled: import.meta.url.includes("$bunfs"), result: result?.result, subtype: result?.subtype, exit: await exit, version: RUNTIME_VERSION }));`,
      `process.exit(0);`,
    ].join("\n"),
  );
  const outfile = join(dir, "embedded-host-probe");
  const build = Bun.spawnSync(["bun", "build", "--compile", "host.ts", "worker.ts", "--outfile", outfile], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect([build.exitCode, build.stderr.toString()]).toEqual([0, ""]);

  const home = mkdtempSync(join(dir, "home-"));
  const cwd = mkdtempSync(join(dir, "cwd-"));
  // Run from an UNRELATED cwd: the plain path resolves against the binary's own `$bunfs` root, not the
  // process cwd (measured) -- a host daemon's cwd is wherever launchd put it.
  const run = Bun.spawn([outfile], { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PROBE_HOME: home, PROBE_CWD: cwd }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => run.kill("SIGKILL"), 60_000);
  const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  clearTimeout(timer);
  expect([code, stderr]).toEqual([0, ""]);
  const line = JSON.parse(stdout.trim().split("\n").at(-1)!) as { compiled: boolean; result: string; subtype: string; exit: unknown; version: string };
  expect(line).toEqual({ compiled: true, result: "tool round done", subtype: "success", exit: { code: 0, signal: null }, version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
}, 180_000);
