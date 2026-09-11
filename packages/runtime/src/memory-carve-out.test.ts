// SDK 0.0.4 -- the auto-memory carve-out, END TO END through the in-memory runtime leg.
//
// `permissions/baseline-projects-deny.test.ts` drives `evaluate()` directly and pins the decision
// matrix. This file answers the different question a decision record cannot: does the MODEL-FACING
// path actually work -- the one `context/memory.ts` hands the model every turn ("Auto-memory for
// this project lives at <dir> ... read and write it with the ordinary file tools") -- when a real
// `Write` tool call goes through the real engine, the real rule seeding, the real permission
// pipeline and the real filesystem?
//
// THE FIXTURE SHAPE, and both choices are load-bearing:
//   - a mkdtemp `WINTER_HOME` whose basename is NOT the brand dot-dir, so the RESOLVED-root anchor
//     of both carve-out halves is what has to do the work (the Phase 5 I1 class). Nothing here ever
//     touches a real `~/.winter`.
//   - the memory directory DOES NOT EXIST when the run starts. That is the real shape of a fresh
//     project, and it is the one the sibling P5-B fixture cannot see (it `mkdirSync`s the scripts
//     directory first): `Bash mkdir -p` into `projects/**` is denied, so if `Write` did not create
//     its own parents the feature would still be dead after the carve-out. It does
//     (`tools/impl/write.ts`'s create arm), and this proves it end to end rather than by reading it.
//
// NO NEW `winter-test/<name>` DOUBLE. The reserved namespace exists so a SPAWNED or COMPILED
// `winter` -- which shares no module state with the test process -- can select a scripted provider
// by name (mock.ts's own header). The in-memory leg hands `inMemoryProcess` a provider object
// directly, which is strictly more expressive: the script below issues the exact `Write` calls this
// fixture needs at arbitrary paths, and a named double would only re-spell them one module away.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "./testing.ts";
import type { Provider, ProviderTurn } from "./engine.ts";
import { memoryDirFor, _clearMemoryKeyCacheForTests } from "./context/memory-key.ts";
import { MEMORY_INDEX_BASENAME } from "./context/memory.ts";

let home: string;
let cwd: string;

beforeEach(() => {
  _clearMemoryKeyCacheForTests();
  // NOT named `.winter`: the resolved-root anchor is the half under test here.
  home = realpathSync(mkdtempSync(join(tmpdir(), "winter-memroot-")));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-memcwd-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  _clearMemoryKeyCacheForTests();
});

function scripted(turns: ProviderTurn[]): Provider {
  let i = 0;
  return {
    async generate(): Promise<ProviderTurn> {
      return turns[Math.min(i++, turns.length - 1)]!;
    },
  };
}

/**
 * One envelope under `mode`.
 *
 * `default` carries `permissions.allow: ["Write"]` -- a host grant, which is what a real default-mode
 * session has and what this fixture has instead of a prompt handler. It is ALSO the control: a bare
 * `Write` allow lives at stage 5, and the managed `projects/**` deny at stage 2 beats it outright, so
 * in the very same run the transcript write below is still refused while the memory write lands.
 */
async function run(mode: "bypassPermissions" | "default", turns: ProviderTurn[]): Promise<{ denials: unknown[] }> {
  const config: RuntimeConfig = {
    sessionId: `mem-${Math.random().toString(36).slice(2, 10)}`,
    cwd,
    model: "winter-test/echo",
    winterHome: home,
    settingSources: [],
    permissionMode: mode,
    ...(mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : { permissions: { allow: ["Write"] } }),
    sandbox: { enabled: false },
  };
  const proc = inMemoryProcess(["--run", "--config-json", JSON.stringify(config)], scripted(turns), undefined, { WINTER_HOME: home });
  proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
  proc.stdin.write(encodeFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined }));
  let denials: unknown[] = [];
  let carry = "";
  for await (const chunk of proc.stdout) {
    const split = splitFrames(chunk, carry);
    carry = split.carry;
    for (const frame of split.frames as WinterFrame[]) {
      if (frame.type !== "data") continue;
      const msg = (frame as { message: { type: string; permission_denials?: unknown[] } }).message;
      if (msg.type === "result" && Array.isArray(msg.permission_denials)) denials = msg.permission_denials;
    }
  }
  await proc.exited;
  return { denials };
}

/** The directory the memory feature itself resolves -- never a re-spelled literal. */
function memoryIndexPath(): string {
  return join(memoryDirFor({ cwd, home, env: {} }), MEMORY_INDEX_BASENAME);
}

describe("SDK 0.0.4 e2e: the model can actually write the auto-memory index", () => {
  for (const mode of ["bypassPermissions", "default"] as const) {
    test(`a Write to MEMORY.md SUCCEEDS under \`${mode}\`, into a memory directory that did not exist`, async () => {
      const index = memoryIndexPath();
      expect(existsSync(index), "the fixture is only meaningful if the file is absent to begin with").toBe(false);
      const { denials } = await run(mode, [
        { kind: "tool_use", calls: [{ id: "c1", name: "Write", input: { file_path: index, content: "# Memory index\n\n- [conventions](conventions.md) — two-space indent\n" } }] },
        { kind: "text", text: "recorded" },
      ]);
      expect(denials, `the memory write must not be refused (${mode})`).toEqual([]);
      expect(existsSync(index), "MEMORY.md must exist on disk").toBe(true);
      expect(readFileSync(index, "utf8")).toContain("Memory index");
    });

    test(`a TOPIC file under the same directory succeeds under \`${mode}\` too`, async () => {
      const topic = join(memoryDirFor({ cwd, home, env: {} }), "topics", "conventions.md");
      const { denials } = await run(mode, [
        { kind: "tool_use", calls: [{ id: "c1", name: "Write", input: { file_path: topic, content: "two-space indent\n" } }] },
        { kind: "text", text: "recorded" },
      ]);
      expect(denials).toEqual([]);
      expect(existsSync(topic), "topic files nest freely BELOW the memory directory").toBe(true);
    });
  }

  test("the CONTROL, in the same run: the durable transcript beside it is still refused", async () => {
    // The managed deny is intact; only the memory subtree was carved out. Under `default` the run
    // also carries a bare `Write` allow rule, so this is the sharpest possible statement of the
    // stage order: one host grant, two paths, opposite outcomes.
    const index = memoryIndexPath();
    const transcript = join(home, "projects", "some-key", "sess-1.jsonl");
    const { denials } = await run("default", [
      { kind: "tool_use", calls: [{ id: "c1", name: "Write", input: { file_path: index, content: "# index\n" } }] },
      { kind: "tool_use", calls: [{ id: "c2", name: "Write", input: { file_path: transcript, content: "INJECTED\n" } }] },
      { kind: "text", text: "done" },
    ]);
    expect(existsSync(index), "the memory write lands").toBe(true);
    expect(existsSync(transcript), "the transcript write does not").toBe(false);
    expect(denials.length, "and the refusal is on the ledger").toBeGreaterThan(0);
  });

  test("Bash is untouched end to end: a shell redirect into the memory directory is refused", async () => {
    // The carve-out's tool gate, proven through the real pipeline rather than through the predicate.
    const index = memoryIndexPath();
    const { denials } = await run("bypassPermissions", [
      { kind: "tool_use", calls: [{ id: "c1", name: "Bash", input: { command: `echo poisoned >> ${index}` } }] },
      { kind: "text", text: "done" },
    ]);
    expect(denials.length, "Bash never earns the carve-out").toBeGreaterThan(0);
    expect(existsSync(index)).toBe(false);
  });
});
