// Phase 5 Lane W (task 4): the WORKER half -- `workflowWorkerMain`'s real body (RULING R5-15's
// frozen signature, body replaced) and the spawn-command split that reaches it.
//
// Driven through `runWorkerInProcess` (worker-harness.ts), which is exactly why R5-15 injects `io`
// rather than reading `process`: the entry can be exercised over a pair of PassThroughs, with the
// parent side of the bridge implemented in the test, and no subprocess or seatbelt involved. The
// REAL process + seatbelt legs are runtime.test.ts and worker.darwin.test.ts.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runWorkerInProcess } from "./worker-harness.ts";
import { WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG, resolveWorkerCommand, buildWorkerSpawn } from "./sandbox.ts";
import { WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE, WORKFLOW_WORKER_BROKEN_EXIT_CODE } from "./subprocess-entry.ts";
import { promptKey } from "./journal.ts";

const META = `export const meta = { name: "t", description: "d" };\n`;

describe("workflowWorkerMain -- the driven body (R5-15)", () => {
  test("a `done` op carries the script's return value, and the worker exits 0", async () => {
    const out = await runWorkerInProcess({ source: META + `return { ok: 1 };` });
    expect(out.exitCode).toBe(0);
    expect(out.terminal).toEqual({ op: "done", result: { ok: 1 } });
  });

  test("phase/log ops arrive one-way, in order, before the terminal message", async () => {
    const out = await runWorkerInProcess({ source: META + `phase("A"); log("l1"); phase("B"); return 1;` });
    expect(out.requests.filter((r) => r.op === "phase" || r.op === "log")).toEqual([
      { op: "phase", title: "A" },
      { op: "log", message: "l1" },
      { op: "phase", title: "B" },
    ]);
  });

  test("`agent` is request/reply keyed by callId -- replies may arrive OUT OF ORDER and still match", async () => {
    const out = await runWorkerInProcess({
      source: META + `const [a, b] = await parallel([() => agent("slow"), () => agent("fast")]); return [a, b];`,
      // Answer "fast" first: correlation must be by callId, never by arrival order.
      answerAgent: async (req) => ({ value: req.prompt, delayMs: req.prompt === "slow" ? 20 : 0 }),
    });
    expect(out.terminal).toEqual({ op: "done", result: ["slow", "fast"] });
  });

  test("a throwing script sends a terminal `error` op -- never a silent exit", async () => {
    const out = await runWorkerInProcess({ source: META + `throw new Error("script blew up");` });
    expect(out.terminal?.op).toBe("error");
    expect((out.terminal as { message: string }).message).toContain("script blew up");
    expect(out.exitCode).toBe(0); // the ERROR OP is the signal; a non-zero code would mean the worker itself broke
  });

  test("a meta-less or unparseable script still terminates with `error`, never a hang", async () => {
    const out = await runWorkerInProcess({ source: `this is not javascript(` });
    expect(out.terminal?.op).toBe("error");
  });

  test("diagnostics go to STDERR only -- stdout carries NDJSON frames exclusively", async () => {
    const out = await runWorkerInProcess({ source: META + `log("hello"); return 1;` });
    for (const line of out.stdoutLines) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("the resume journal reaches the script through the init line", async () => {
    const out = await runWorkerInProcess({
      source: META + `return await agent("one");`,
      resumeJournal: [{ promptKey: promptKey("one"), value: "CACHED" }],
      answerAgent: async () => ({ value: "LIVE" }),
    });
    expect(out.terminal).toEqual({ op: "done", result: "CACHED" });
  });

  test("a nested `workflow()` call becomes a bridge request the PARENT resolves", async () => {
    const child = `export const meta = { name: "c", description: "c" };\nreturn "from-child";`;
    const out = await runWorkerInProcess({
      source: META + `return await workflow("c");`,
      answerWorkflow: async () => ({ ok: true as const, source: child }),
    });
    expect(out.terminal).toEqual({ op: "done", result: "from-child" });
  });
});

describe("F6 -- the worker entry MUTATES NOTHING on globalThis (regression pin for 9fe9ab6)", () => {
  // R5-15 makes this entry runnable IN-PROCESS on purpose, so Norma's carried-over
  // `globalThis.fetch = undefined` belt-and-suspenders poisoned whatever process called it: the full
  // suite went red across the MCP and Monitor files with "fetchImpl is not a function". That sentinel
  // was indirect -- it depended on file ordering and on those suites continuing to use `fetch`. This
  // asserts the property itself.
  test("running a workflow in-process leaves fetch/XMLHttpRequest/WebSocket exactly as they were", async () => {
    const before = (["fetch", "XMLHttpRequest", "WebSocket", "Bun", "crypto", "performance"] as const).map((k) => [k, typeof (globalThis as Record<string, unknown>)[k]] as const);
    const out = await runWorkerInProcess({ source: META + `log("work"); return 1;` });
    expect(out.terminal).toEqual({ op: "done", result: 1 });
    for (const [key, was] of before) {
      expect(`${key}=${typeof (globalThis as Record<string, unknown>)[key]}`).toBe(`${key}=${was}`);
    }
  });

  test("the shadowing the SCRIPT sees is unaffected by that -- containment is per-scope, not global", async () => {
    const out = await runWorkerInProcess({ source: META + `return [typeof Bun, typeof fetch, typeof process];` });
    expect(out.terminal).toEqual({ op: "done", result: ["undefined", "undefined", "undefined"] });
  });
});

describe("workflowWorkerMain -- argv discipline (R5-15)", () => {
  test("WITHOUT the bridge flag it returns the not-implemented code and writes a stderr diagnostic (the frozen contract test's own argv)", async () => {
    const out = await runWorkerInProcess({ argv: ["winter", WORKFLOW_WORKER_ARGV_FLAG, "--run-id", "wf_1"], skipInit: true });
    expect(out.exitCode).toBe(WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE);
    expect(out.stderr).toContain(WORKFLOW_WORKER_ARGV_FLAG);
    expect(out.stdoutLines).toEqual([]);
  });

  test("WITH the bridge flag it runs for real -- the exit code is NOT the not-implemented one", async () => {
    const out = await runWorkerInProcess({ source: META + `return 1;` });
    expect(out.exitCode).not.toBe(WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE);
  });

  test("flags are found by NAME, not position -- a leading argv slot may or may not be there", async () => {
    const withScriptSlot = await runWorkerInProcess({
      argv: ["bun", "/path/to/main.ts", WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG],
      source: META + `return "dev-shape";`,
    });
    const withoutScriptSlot = await runWorkerInProcess({
      argv: ["/usr/local/bin/winter", WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG],
      source: META + `return "compiled-shape";`,
    });
    expect(withScriptSlot.terminal).toEqual({ op: "done", result: "dev-shape" });
    expect(withoutScriptSlot.terminal).toEqual({ op: "done", result: "compiled-shape" });
  });

  test("an unreadable init line breaks the WORKER (a distinct code), rather than being reported as a failed workflow", async () => {
    const out = await runWorkerInProcess({ rawInit: "{not json at all\n" });
    expect(out.exitCode).toBe(WORKFLOW_WORKER_BROKEN_EXIT_CODE);
    expect(WORKFLOW_WORKER_BROKEN_EXIT_CODE).not.toBe(0);
    expect(WORKFLOW_WORKER_BROKEN_EXIT_CODE).not.toBe(WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE);
  });
});

describe("the argv flag constant -- source parity with main.ts (R5-12: main.ts is frozen AND unimportable)", () => {
  // main.ts has NO `import.meta.main` guard: importing it EXECUTES the worker dispatch and then
  // `parseConfigFromArgv(process.argv)`, which throws and exits the test process -- so nothing here
  // may import it, and the flag is pinned by reading its SOURCE instead (the P5-D gate-4 technique).
  //
  // TOLERATES BOTH SHAPES ON PURPOSE. Today main.ts DECLARES the literal; the T3 fix round moves the
  // declaration into subprocess-entry.ts and leaves main.ts IMPORTING it. A test that only accepted
  // the first shape would turn red on a fix that makes the drift structurally impossible -- exactly
  // backwards. Either way this asserts the same thing: main.ts and this module cannot disagree.
  test("`WORKFLOW_WORKER_ARGV_FLAG` matches main.ts -- whether main.ts declares the literal or imports it", () => {
    const source = readFileSync(fileURLToPath(new URL("../main.ts", import.meta.url)), "utf8");
    const declared = /export const WORKFLOW_WORKER_ARGV_FLAG = "([^"]+)"/.exec(source);
    if (declared !== null) {
      expect(declared[1]).toBe(WORKFLOW_WORKER_ARGV_FLAG);
      return;
    }
    expect(source).toMatch(/import\s*\{[^}]*WORKFLOW_WORKER_ARGV_FLAG[^}]*\}\s*from\s*"\.\/workflows\/subprocess-entry\.ts"/);
  });

  test("main.ts dispatches on `process.argv.includes(...)` -- so any argv POSITION reaches the worker", () => {
    const source = readFileSync(fileURLToPath(new URL("../main.ts", import.meta.url)), "utf8");
    expect(source).toContain("process.argv.includes(WORKFLOW_WORKER_ARGV_FLAG)");
  });
});

describe("the compiled-vs-dev spawn split (WS-11 §1.7)", () => {
  test("DEV: bun + the absolute path to main.ts + the two flags -- main.ts owns the dispatch", () => {
    const cmd = resolveWorkerCommand({ compiled: false, execPath: "/opt/homebrew/bin/bun" });
    expect(cmd.file).toBe("/opt/homebrew/bin/bun");
    expect(cmd.args[0]).toMatch(/main\.ts$/);
    expect(cmd.args.slice(1)).toEqual([WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG]);
  });

  test("COMPILED: the self binary IS the executable -- no separate script-path slot", () => {
    const cmd = resolveWorkerCommand({ compiled: true, execPath: "/usr/local/bin/winter" });
    expect(cmd.file).toBe("/usr/local/bin/winter");
    expect(cmd.args).toEqual([WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG]);
  });

  test("the spawn wraps the command in sandbox-exec with the WORKER profile, and PASSES `home` (T3's Lane W item 2)", () => {
    const spawn = buildWorkerSpawn({ command: { file: "/usr/local/bin/winter", args: [WORKFLOW_WORKER_ARGV_FLAG] }, home: "/home/synthetic" });
    expect(spawn.file).toBe("/usr/bin/sandbox-exec");
    expect(spawn.args[0]).toBe("-p");
    expect(spawn.args[1]).toContain("(deny file-write*)");
    expect(spawn.args[1]).toContain("(deny network*)");
    expect(spawn.args[1]).toContain("(deny process-fork)");
    // The ~/.winter/run read-deny is the R5-5 carry the profile emits ONLY when `home` is supplied.
    expect(spawn.args[1]).toContain(".winter/run");
    expect(spawn.args.slice(2)).toEqual(["/usr/local/bin/winter", WORKFLOW_WORKER_ARGV_FLAG]);
  });

  test("a spawner that forgets `home` is a DIFFERENT profile -- the deny is silently absent, which is the trap T3 named", () => {
    const withHome = buildWorkerSpawn({ command: { file: "/x/winter", args: [] }, home: "/home/synthetic" });
    const withoutHome = buildWorkerSpawn({ command: { file: "/x/winter", args: [] } });
    expect(withHome.args[1]).toContain(".winter/run");
    expect(withoutHome.args[1]).not.toContain(".winter/run");
  });

  test("fix wave I1 (the resolved-home class): a WINTER_HOME whose basename is not `.winter` gets its OWN run deny", () => {
    const command = { file: "/x/winter", args: [] };
    const resolved = buildWorkerSpawn({ command, home: "/home/synthetic", winterHome: "/tmp/custom-root" });
    // Both anchors: the literal `<home>/.winter/run` AND the resolved `<winterHome>/run`.
    expect(resolved.args[1]).toContain(".winter/run");
    expect(resolved.args[1]).toContain("custom-root/run");
    // Without the resolved root the second deny is absent -- the RED half of this fixture.
    const literalOnly = buildWorkerSpawn({ command, home: "/home/synthetic" });
    expect(literalOnly.args[1]).not.toContain("custom-root/run");
    // A resolved root that IS `<home>/.winter` adds nothing beyond the literal deny (one deny, not two).
    const same = buildWorkerSpawn({ command, home: "/home/synthetic", winterHome: "/home/synthetic/.winter" });
    expect(same.args[1].split(".winter/run").length - 1).toBe(literalOnly.args[1].split(".winter/run").length - 1);
  });
});
