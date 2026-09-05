// Phase 5 Lane W (task 4), WS-11 §1.6: the SCRIPT API -- the authoring surface a workflow body sees.
// Driven directly here (no subprocess, no seatbelt): this suite is about what the globals DO, and
// `worker-harness.test.ts` / `runtime.test.ts` cover the wire and the process around them.
import { describe, test, expect } from "bun:test";
import { runWorkflowScript, type ScriptApiDeps, type AgentBridgeResult } from "./script-api.ts";
import { promptKey } from "./journal.ts";

interface Recorded {
  prompts: Array<{ prompt: string; opts?: unknown }>;
  phases: string[];
  logs: string[];
}

function harness(
  source: string,
  overrides: Partial<ScriptApiDeps> = {},
): { run: Promise<{ meta: unknown; result: unknown }>; rec: Recorded } {
  const rec: Recorded = { prompts: [], phases: [], logs: [] };
  const deps: ScriptApiDeps = {
    source,
    args: undefined,
    concurrency: 4,
    totalAgentCap: 1000,
    maxItemsPerCall: 4096,
    budget: { total: null, spent: 0 },
    agent: async (prompt, opts) => {
      rec.prompts.push({ prompt, ...(opts !== undefined ? { opts } : {}) });
      return { ok: true, value: `echo:${prompt}` };
    },
    resolveWorkflow: async () => ({ ok: false, error: "no nested workflows configured in this fixture" }),
    phase: (t) => rec.phases.push(t),
    log: (m) => rec.logs.push(m),
    ...overrides,
  };
  return { run: runWorkflowScript(deps), rec };
}

const META = `export const meta = { name: "t", description: "d" };\n`;

async function runOk(source: string, overrides: Partial<ScriptApiDeps> = {}): Promise<unknown> {
  return (await harness(META + source, overrides).run).result;
}

async function runThrows(source: string, overrides: Partial<ScriptApiDeps> = {}): Promise<string> {
  try {
    await harness(META + source, overrides).run;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the script to throw");
}

describe("the script body: compilation and meta capture", () => {
  test("the body's `return` IS the workflow result, and `export const meta` is captured, not executed as an export", async () => {
    const { meta, result } = await harness(`export const meta = { name: "t", description: "d" };\nreturn { hi: 1 };`).run;
    expect(result).toEqual({ hi: 1 });
    expect(meta).toEqual({ name: "t", description: "d" });
  });

  test("top-level `await` works -- the body runs in an async context (WS-11 §1.6)", async () => {
    expect(await runOk(`const a = await agent("one"); return a;`)).toBe("echo:one");
  });

  test("a TypeScript type annotation fails to parse -- plain JavaScript only (WS-11 §1.6)", async () => {
    expect(await runThrows(`const x: number = 1; return x;`)).toBeTruthy();
  });
});

describe("agent() -- WS-11 §1.6", () => {
  test("resolves with the agent's final text", async () => {
    expect(await runOk(`return await agent("go");`)).toBe("echo:go");
  });

  test("resolves NULL when the agent is skipped or dies on a terminal error -- callers filter with .filter(Boolean)", async () => {
    const out = await runOk(`const a = await agent("dies"); return [a, a === null];`, {
      agent: async () => ({ ok: true, value: null }) satisfies AgentBridgeResult,
    });
    expect(out).toEqual([null, true]);
  });

  test("a bridge-level REFUSAL throws inside the script -- a cap breach must not be swallowable by .filter(Boolean)", async () => {
    expect(
      await runThrows(`return await agent("x");`, { agent: async () => ({ ok: false, error: "the per-run agent cap" }) }),
    ).toContain("per-run agent cap");
  });

  test("opts are forwarded VERBATIM -- label/phase/schema/model/effort/isolation/agentType all reach the bridge", async () => {
    const opts = { label: "L", phase: "P", schema: { type: "object" }, model: "m", effort: "high", isolation: "worktree", agentType: "reviewer" };
    const h = harness(META + `return await agent("go", ${JSON.stringify(opts)});`);
    await h.run;
    expect(h.rec.prompts).toEqual([{ prompt: "go", opts }]);
  });
});

describe("parallel() -- a barrier that NEVER rejects (WS-11 §1.6)", () => {
  test("a thunk that throws resolves to null; the batch itself still resolves", async () => {
    expect(
      await runOk(`return await parallel([() => agent("a"), () => { throw new Error("boom"); }, () => agent("c")]);`),
    ).toEqual(["echo:a", null, "echo:c"]);
  });

  test("results keep the thunks' own order regardless of completion order", async () => {
    const out = await runOk(`return await parallel([() => agent("slow"), () => agent("fast")]);`, {
      agent: async (p) => {
        if (p === "slow") await new Promise((r) => setTimeout(r, 15));
        return { ok: true, value: p };
      },
    });
    expect(out).toEqual(["slow", "fast"]);
  });

  test("more than `maxItemsPerCall` items is an EXPLICIT error, never a silent truncation", async () => {
    const msg = await runThrows(`return await parallel(Array.from({length: 5}, () => () => 1));`, { maxItemsPerCall: 4 });
    expect(msg).toContain("4");
    expect(msg.toLowerCase()).toContain("parallel");
  });

  test("the cap DEFAULT is 4096 (WS-11 §1.6)", async () => {
    expect(await runThrows(`return await parallel(Array.from({length: 4097}, () => () => 1));`)).toContain("4096");
  });
});

describe("pipeline() -- per-item flow with NO inter-stage barrier (WS-11 §1.6)", () => {
  test("stage callbacks receive (prevResult, originalItem, index)", async () => {
    expect(
      await runOk(`return await pipeline(["a","b"], (prev, item, i) => [prev, item, i], (prev, item, i) => ({ prev, item, i }));`),
    ).toEqual([
      { prev: ["a", "a", 0], item: "a", i: 0 },
      { prev: ["b", "b", 1], item: "b", i: 1 },
    ]);
  });

  test("a stage throw drops THAT ITEM to null and skips its remaining stages -- other items are unaffected", async () => {
    expect(
      await runOk(`return await pipeline([1,2,3], (p) => { if (p === 2) throw new Error("x"); return p; }, (p) => p * 10);`),
    ).toEqual([10, null, 30]);
  });

  test("NO inter-stage barrier: item 2 reaches stage 2 before item 1 has left stage 1", async () => {
    const out = await runOk(
      `const trace = [];
       await pipeline([1, 2],
         async (p, item) => { if (item === 1) { await new Promise(r => setTimeout(r, 20)); } trace.push("s1:" + item); return item; },
         async (p, item) => { trace.push("s2:" + item); return item; });
       return trace;`,
    );
    expect(out).toEqual(["s1:2", "s2:2", "s1:1", "s2:1"]);
  });

  test("more than `maxItemsPerCall` items is an EXPLICIT error", async () => {
    const msg = await runThrows(`return await pipeline([1,2,3,4,5], (p) => p);`, { maxItemsPerCall: 4 });
    expect(msg.toLowerCase()).toContain("pipeline");
  });
});

describe("phase() / log() / args", () => {
  test("phase() and log() are one-way progress signals, stringified", async () => {
    const h = harness(META + `phase("Research"); log("looked"); log(7); return 1;`);
    await h.run;
    expect(h.rec.phases).toEqual(["Research"]);
    expect(h.rec.logs).toEqual(["looked", "7"]);
  });

  test("`args` is the WorkflowInput.args value VERBATIM -- real JSON values, never re-stringified", async () => {
    const args = { list: [1, 2], nested: { deep: true } };
    const out = await harness(META + `return [typeof args.list, args.list[1], args.nested.deep];`, { args }).run;
    expect(out.result).toEqual(["object", 2, true]);
  });

  test("`args` is undefined when absent (WS-11 §1.6)", async () => {
    expect(await runOk(`return args === undefined;`)).toBe(true);
  });

  test("console.* is routed to log(), never to stdout -- stdout is the NDJSON bridge", async () => {
    const h = harness(META + `console.log("via console"); return 1;`);
    await h.run;
    expect(h.rec.logs).toEqual(["via console"]);
  });
});

describe("determinism guards (WS-11 §1.6) -- resume must be byte-stable", () => {
  test("Date.now() throws", async () => {
    expect(await runThrows(`return Date.now();`)).toContain("Date.now");
  });

  test("argless new Date() throws, but new Date(ts) works -- timestamps come in via args", async () => {
    expect(await runThrows(`return new Date();`)).toContain("Date");
    expect(await runOk(`return new Date(0).getTime();`)).toBe(0);
  });

  test("Math.random() throws, and the rest of Math still works", async () => {
    expect(await runThrows(`return Math.random();`)).toContain("Math.random");
    expect(await runOk(`return Math.max(1, 2);`)).toBe(2);
  });
});

describe("ambient shadowing (WS-11 §1.6) -- no host-runtime reach-through", () => {
  test("`typeof Bun === \"undefined\"` inside the body -- the literal contract the spec states", async () => {
    expect(await runOk(`return typeof Bun === "undefined";`)).toBe(true);
  });

  test("process / require / fetch / globalThis are all undefined in the body", async () => {
    expect(
      await runOk(`return [typeof process, typeof require, typeof fetch, typeof globalThis];`),
    ).toEqual(["undefined", "undefined", "undefined", "undefined"]);
  });

  // REAL FINDING, measured against bun 1.3.14 rather than reasoned from the spec: `await
  // import("node:fs")` inside a `new AsyncFunction` body RESOLVES -- it is not the syntax error a
  // "a function body is not a module" reading predicts, and it reached the real `node:fs`. That is a
  // filesystem reach-through WS-11 §1.6 forbids by name, so script-api.ts refuses the token at
  // compile time (`import` is syntax, never a value, so there is no computed-name route around it).
  test("dynamic `import()` is REFUSED -- the one ambient that cannot be shadowed by a parameter name", async () => {
    expect(await runThrows(`const fs = await import("node:fs"); return 1;`)).toContain("import");
  });

  test("`import.meta` is refused by the same guard", async () => {
    expect(await runThrows(`return import.meta.url;`)).toContain("import");
  });

  test("the refusal reaches a NESTED workflow's body too, not just the launched one", async () => {
    const child = `export const meta = { name: "c", description: "c" };\nreturn await import("node:fs");`;
    expect(await runThrows(`return await workflow("c");`, { resolveWorkflow: async () => ({ ok: true, source: child }) })).toContain("import");
  });
});

describe("caps (WS-11 §1.6/§1.8)", () => {
  test("concurrent agent() calls are bounded and the excess QUEUES -- it runs as slots free, never refused", async () => {
    let live = 0;
    let peak = 0;
    const out = await runOk(`return await parallel(Array.from({length: 8}, (_, i) => () => agent("a" + i)));`, {
      concurrency: 3,
      agent: async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return { ok: true, value: 1 };
      },
    });
    expect((out as unknown[]).length).toBe(8); // every queued call eventually ran
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("the TOTAL agent cap is an explicit failure RECORDING THE COMPLETED COUNT -- never a silent truncation", async () => {
    const msg = await runThrows(`for (let i = 0; i < 5; i++) { await agent("a" + i); } return "unreachable";`, { totalAgentCap: 3 });
    expect(msg).toContain("3"); // the cap
    expect(msg).toContain("completed"); // and how many finished before the stop
  });
});

describe("resume: the longest unchanged PREFIX is cached (WS-11 §1.5)", () => {
  const script = `const a = await agent("one"); const b = await agent("two"); const c = await agent("three"); return [a, b, c];`;

  test("same script + same args = 100% cache hit: nothing is dispatched live", async () => {
    const h = harness(META + script, {
      resumeJournal: [
        { promptKey: promptKey("one"), value: "A" },
        { promptKey: promptKey("two"), value: "B" },
        { promptKey: promptKey("three"), value: "C" },
      ],
    });
    expect((await h.run).result).toEqual(["A", "B", "C"]);
    expect(h.rec.prompts).toEqual([]);
  });

  test("the FIRST changed call and everything after runs live, even where a later index would coincidentally match", async () => {
    const h = harness(META + script, {
      resumeJournal: [
        { promptKey: promptKey("one"), value: "A" },
        { promptKey: promptKey("CHANGED"), value: "B" },
        { promptKey: promptKey("three"), value: "C" }, // would match positionally -- must NOT be used
      ],
    });
    expect((await h.run).result).toEqual(["A", "echo:two", "echo:three"]);
    expect(h.rec.prompts.map((p) => p.prompt)).toEqual(["two", "three"]);
  });

  test("running past the journal's recorded end is a divergence too", async () => {
    const h = harness(META + script, { resumeJournal: [{ promptKey: promptKey("one"), value: "A" }] });
    expect((await h.run).result).toEqual(["A", "echo:two", "echo:three"]);
  });

  test("a cached call costs NOTHING against the total-agent cap -- it never spawned", async () => {
    const h = harness(META + script, {
      totalAgentCap: 1,
      resumeJournal: [
        { promptKey: promptKey("one"), value: "A" },
        { promptKey: promptKey("two"), value: "B" },
        { promptKey: promptKey("three"), value: "C" },
      ],
    });
    expect((await h.run).result).toEqual(["A", "B", "C"]);
  });
});

describe("budget -- a hard ceiling the script cannot spend past (WS-11 §1.6)", () => {
  test("the default is `total: null`, and remaining() is unbounded", async () => {
    expect(await runOk(`return [budget.total, budget.remaining(), budget.spent()];`)).toEqual([null, Infinity, 0]);
  });

  test("the mirrored snapshot updates from the bridge's replies", async () => {
    const out = await runOk(`await agent("x"); return [budget.spent(), budget.remaining()];`, {
      budget: { total: 100, spent: 0 },
      agent: async () => ({ ok: true, value: 1, budget: { total: 100, spent: 40 } }),
    });
    expect(out).toEqual([40, 60]);
  });

  test("once the ceiling is reached, a further agent() call THROWS (WS-11 §1.6)", async () => {
    const msg = await runThrows(`await agent("x"); await agent("y"); return 1;`, {
      budget: { total: 100, spent: 0 },
      agent: async () => ({ ok: true, value: 1, budget: { total: 100, spent: 100 } }),
    });
    expect(msg.toLowerCase()).toContain("budget");
  });
});

describe("workflow() -- one-level nesting (WS-11 §1.6)", () => {
  const child = `export const meta = { name: "child", description: "c" };\nreturn "child:" + (args && args.n);`;

  test("runs another workflow inline and returns ITS return value; args are passed through", async () => {
    expect(
      await runOk(`return await workflow("child", { n: 7 });`, { resolveWorkflow: async () => ({ ok: true, source: child }) }),
    ).toBe("child:7");
  });

  test("a `{scriptPath}` ref resolves the same way a saved NAME does", async () => {
    const seen: unknown[] = [];
    await runOk(`return await workflow({ scriptPath: "/x/y.js" });`, {
      resolveWorkflow: async (ref) => {
        seen.push(ref);
        return { ok: true, source: child };
      },
    });
    expect(seen).toEqual([{ scriptPath: "/x/y.js" }]);
  });

  test("nesting is ONE LEVEL: workflow() inside a child throws", async () => {
    const nesting = `export const meta = { name: "c", description: "c" };\nreturn await workflow("deeper");`;
    expect(await runThrows(`return await workflow("child");`, { resolveWorkflow: async () => ({ ok: true, source: nesting }) })).toContain("one level");
  });

  test("an unknown name / unreadable path throws", async () => {
    expect(await runThrows(`return await workflow("nope");`, { resolveWorkflow: async () => ({ ok: false, error: "unknown workflow \"nope\"" }) })).toContain("nope");
  });

  test("a child SYNTAX error throws", async () => {
    expect(await runThrows(`return await workflow("bad");`, { resolveWorkflow: async () => ({ ok: true, source: `export const meta = { name: "b", description: "b" };\nthis is not javascript(` }) })).toBeTruthy();
  });

  test("the child SHARES the run's agent counter, concurrency cap and budget -- one pool, not two", async () => {
    const counting = `export const meta = { name: "c", description: "c" };\nawait agent("from-child"); return 1;`;
    const msg = await runThrows(`await agent("a"); await agent("b"); return await workflow("c");`, {
      totalAgentCap: 2,
      resolveWorkflow: async () => ({ ok: true, source: counting }),
    });
    expect(msg).toContain("cap"); // the child's agent() call is the 3rd against a shared cap of 2
  });
});
