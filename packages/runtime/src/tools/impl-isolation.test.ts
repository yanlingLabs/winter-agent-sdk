// IMPORTING ONE EXECUTOR MUST NOT REGISTER SOMEBODY ELSE'S TOOL (SB review r1, Important 2).
//
// Every `impl/*.ts` is side-effectful at module load BY DESIGN: it imports its own descriptors and
// calls `replaceExecutor`. That is the architecture registry.ts describes — a descriptor file is a
// data-only leaf, and a lane's own impl file installs the executor. What it must NOT become is a
// chain: when `read-notifications.ts` imported a helper from `send-message.ts`, importing the
// ReadNotifications executor also registered `SendMessage`, its canonical standing-server twin, and
// both of their descriptors. Nothing in the suite could see it, because `descriptors/index.ts` loads
// everything in practice and the engine imports that barrel — so the coupling was invisible exactly
// where it mattered.
//
// THE PROOF IS A SUBPROCESS, deliberately. The registry is a process-global Map and `bun test` shares
// one module graph across files, so an in-process assertion here would observe whatever every other
// test file already imported. A fresh `bun` process importing ONE module is the only way to say
// "this import, and nothing else" and mean it.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const TOOLS_DIR = fileURLToPath(new URL(".", import.meta.url));

/** The canonical names registered by a fresh process that imported exactly one module. */
async function registeredAfterImportingOnly(moduleRelativePath: string): Promise<string[]> {
  const target = JSON.stringify(join(TOOLS_DIR, moduleRelativePath));
  const registry = JSON.stringify(join(TOOLS_DIR, "registry.ts"));
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `await import(${target});\n` +
        `const { listRegisteredTools } = await import(${registry});\n` +
        `console.log(JSON.stringify(listRegisteredTools().map((t) => t.descriptor.canonicalName).sort()));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`probe for ${moduleRelativePath} exited ${code}:\n${err}`);
  return JSON.parse(out.trim()) as string[];
}

describe("an executor module registers ITS OWN tools and no others", () => {
  test("importing impl/read-notifications.ts alone does NOT register SendMessage or its twin", async () => {
    const registered = await registeredAfterImportingOnly("impl/read-notifications.ts");
    expect(registered).toEqual(["ReadNotifications"]);
    // Named explicitly so a failure reads as the regression it is rather than as a list mismatch.
    expect(registered).not.toContain("SendMessage");
    expect(registered).not.toContain("mcp__winter__send_message");
  }, 30_000);

  test("importing impl/list-agents.ts alone registers exactly ListAgents and its canonical twin", async () => {
    // The twin IS this file's own -- `list-agents.ts` installs the identical executor object under
    // both names (WS-09 §10), so registering both is the design, not leakage.
    const registered = await registeredAfterImportingOnly("impl/list-agents.ts");
    expect(registered).toEqual(["ListAgents", "mcp__winter__list_agents"]);
  }, 30_000);
});

describe("the tripwire: no messaging executor imports another executor module", () => {
  // SCOPED TO THE THREE MESSAGING IMPLS ON PURPOSE. A repo-wide "no impl imports an impl" rule would
  // be red on arrival and for reasons this batch did not create: `edit.ts` imports from `write.ts`
  // and `task-output.ts` imports `CEILING_TIMEOUT_MS` from `bash.ts`, both of which register tools.
  // Widening this gate means discharging that debt first, which is a whole-branch triage item rather
  // than something to smuggle in here. What is pinned is the class this review found, in the files it
  // found it in.
  const MESSAGING_IMPLS = ["send-message.ts", "list-agents.ts", "read-notifications.ts"];

  /** Every `impl/*.ts` that installs an executor -- i.e. every sibling whose import has side effects. */
  const SIDE_EFFECTFUL = new Set(
    readdirSync(join(TOOLS_DIR, "impl"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("_"))
      .filter((f) => readFileSync(join(TOOLS_DIR, "impl", f), "utf8").includes("replaceExecutor(")),
  );

  test("the side-effectful set is real -- the three messaging impls are in it", () => {
    // Non-vacuity: if this set were empty (a renamed `replaceExecutor`, a moved directory) the test
    // below would pass while checking nothing.
    for (const file of MESSAGING_IMPLS) expect([file, SIDE_EFFECTFUL.has(file)]).toEqual([file, true]);
  });

  for (const file of MESSAGING_IMPLS) {
    test(`${file} imports no sibling that registers a tool`, () => {
      const source = readFileSync(join(TOOLS_DIR, "impl", file), "utf8");
      const siblings = [...source.matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!);
      const offending = siblings.filter((s) => SIDE_EFFECTFUL.has(s));
      expect([file, offending]).toEqual([file, []]);
    });
  }
});
