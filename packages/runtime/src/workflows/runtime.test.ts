// Phase 5 Lane W (task 4): the RUNTIME -- the parent half. Lifecycle (WS-11 §1.8), the bridge
// service loop, progress, abort chaining, resume preconditions (§1.5) and the caps' authoritative
// enforcement.
//
// Driven with an IN-PROCESS spawner that runs the REAL `workflowWorkerMain` over a PassThrough pair.
// That is not a mock of the worker: it is the actual worker code, actual NDJSON framing, actual
// request/reply correlation -- only the `sandbox-exec` fork is elided, and `runtime.darwin.test.ts`
// is what covers that. The gain is that every rule below is exercised end-to-end in milliseconds
// instead of behind a 60MB compile.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRuntime, type WorkflowRuntimeDeps } from "./runtime.ts";
import { inProcessWorkerSpawner } from "./worker-harness.ts";
import { fakeWorkflowRunHost, type WorkflowProgress } from "./seam.ts";
import { fakeStructuredOutputSeam } from "../structured/seam.ts";
import { createContextAccountant } from "../engine.ts";
import type { ChildHandle, ChildResult, SpawnChildRequest } from "../subagents/child-handle.ts";
import { parseWorkflowMeta } from "./meta.ts";

const META = `export const meta = { name: "wf", description: "d" };\n`;

// A LOCAL child fake, not `subagents/test-fakes.ts`'s: that one's `result()` never settles without a
// `simulateCompletion` call, and every case here needs a child that settles on its own (or pointedly
// never does, for the abort-chaining test). Owning it also keeps this suite from depending on
// another lane's fixture shape.
// `structuredOutput` (RULING P5-I, fix wave): the fake carried `status`/`content` only, so the
// pending P5-I test below could not have gone green even once the field existed -- the shape it
// pinned was dropped on the way through the double.
function fakeChild(opts: { content?: string; status?: ChildResult["status"]; structuredOutput?: unknown; neverSettle?: boolean; onStop?: () => void } = {}): ChildHandle {
  let status: ChildResult["status"] | "running" = "running";
  let settle!: (r: ChildResult) => void;
  const result = new Promise<ChildResult>((resolve) => {
    settle = resolve;
  });
  if (opts.neverSettle !== true) {
    status = opts.status ?? "completed";
    settle({ status: opts.status ?? "completed", content: opts.content ?? "", ...("structuredOutput" in opts ? { structuredOutput: opts.structuredOutput } : {}) });
  }
  return {
    record: {
      id: "child-1",
      parentSessionId: "sess-1",
      parentToolUseId: "tooluse-1",
      transcript: "subagents/agent-child-1.jsonl",
      status: "running",
      runtime: "winter-agent",
      model: { effectiveModel: "sonnet", effectiveEffort: "medium" },
      permission: { effectiveMode: "default", parentPolicyHash: "h", parentPolicyVersion: 1 },
    },
    status: () => (status === "running" ? "running" : status),
    steer: async () => ({ status: "delivered", messageId: "m1" }),
    resume: async () => ({ status: "resumed_and_delivered", messageId: "m1" }),
    result: () => result,
    stop: async () => {
      opts.onStop?.();
      status = "stopped";
      settle({ status: "stopped", content: "" });
    },
  };
}

interface Rig {
  runtime: WorkflowRuntime;
  host: ReturnType<typeof fakeWorkflowRunHost>;
  log: Array<{ kind: string; taskId: string; event: "created" | "progress" | "complete" | "fail"; detail?: unknown }>;
  spawned: SpawnChildRequest[];
  winterHome: string;
  sessionTempDir: string;
}

function rig(opts: {
  spawnAgent?: (req: SpawnChildRequest) => Promise<ChildHandle>;
  caps?: WorkflowRuntimeDeps["caps"];
  budgetTotal?: number | null;
  accountant?: ReturnType<typeof createContextAccountant>;
  resolveNested?: WorkflowRuntimeDeps["resolveNestedWorkflow"];
  resolveAgentType?: NonNullable<WorkflowRuntimeDeps["session"]["resolveAgentType"]>;
  spentTokens?: () => number;
} = {}): Rig {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-wf-rt-home-"));
  const sessionTempDir = mkdtempSync(join(tmpdir(), "winter-wf-rt-temp-"));
  const spawned: SpawnChildRequest[] = [];
  const log: Array<{ kind: string; taskId: string; event: "created" | "progress" | "complete" | "fail"; detail?: unknown }> = [];
  const host = fakeWorkflowRunHost({
    structured: fakeStructuredOutputSeam(),
    accountant: opts.accountant ?? createContextAccountant({ limit: 100_000 }),
    spawnAgent: async (req) => {
      spawned.push(req);
      return (opts.spawnAgent ?? (async () => fakeChild({ content: `child:${req.prompt}` })))(req);
    },
    log,
  });
  const runtime = new WorkflowRuntime({
    session: {
      winterHome,
      projectKey: "-proj",
      sessionTempDir,
      structured: fakeStructuredOutputSeam(),
      accountant: opts.accountant ?? createContextAccountant({ limit: 100_000 }),
      ...(opts.budgetTotal !== undefined ? { budgetTotal: opts.budgetTotal } : {}),
      ...(opts.resolveAgentType !== undefined ? { resolveAgentType: opts.resolveAgentType } : {}),
      ...(opts.spentTokens !== undefined ? { spentTokens: opts.spentTokens } : {}),
    },
    spawnWorker: inProcessWorkerSpawner(),
    ...(opts.caps !== undefined ? { caps: opts.caps } : {}),
    ...(opts.resolveNested !== undefined ? { resolveNestedWorkflow: opts.resolveNested } : {}),
  });
  return { runtime, host, log, spawned, winterHome, sessionTempDir };
}

function launch(r: Rig, source: string, extra: { args?: unknown; sessionId?: string } = {}) {
  const parsed = parseWorkflowMeta(source);
  if (!parsed.ok) throw new Error(parsed.error);
  return r.runtime.launch(
    {
      sessionId: extra.sessionId ?? "sess-1",
      cwd: "/synthetic",
      trustedWorkspace: true,
      parentToolUseId: "tooluse-launch",
      source,
      meta: parsed.meta,
      ...(extra.args !== undefined ? { args: extra.args } : {}),
    },
    r.host,
  );
}

describe("launch -- the result contract (WS-11 §1.4 + capture (3))", () => {
  test("returns taskId/runId/scriptPath/transcriptDir, and the run starts `running`", async () => {
    const r = rig();
    const launched = launch(r, META + `return 1;`);
    expect(launched.taskId).toBeTruthy();
    expect(launched.runId).toMatch(/^wf_[0-9a-f]+$/);
    expect(launched.status).toBe("running");
    expect(launched.scriptPath).toBe(join(r.winterHome, "projects", "-proj", "sess-1", "workflows", "scripts", `wf-${launched.runId}.js`));
    expect(launched.transcriptDir).toBe(join(r.winterHome, "projects", "-proj", "sess-1", "subagents", "workflows", launched.runId));
    await r.runtime.await(launched.runId);
  });

  test("the script is PERSISTED at that path before the worker starts (WS-11 §1.3's edit-then-rerun loop)", async () => {
    const r = rig();
    const source = META + `return 1;`;
    const launched = launch(r, source);
    expect(existsSync(launched.scriptPath)).toBe(true);
    expect(readFileSync(launched.scriptPath, "utf8")).toBe(source);
    await r.runtime.await(launched.runId);
  });

  test("the transcript directory it REPORTS is actually created -- a model reading the path must not get ENOENT", async () => {
    const r = rig();
    const launched = launch(r, META + `return 1;`);
    expect(existsSync(launched.transcriptDir)).toBe(true);
    await r.runtime.await(launched.runId);
  });

  test("the run is registered as a background task through the HOST seam, with the internal `workflow` kind", () => {
    const r = rig();
    const launched = launch(r, META + `return 1;`);
    expect(r.log[0]).toEqual({ kind: "workflow", taskId: launched.taskId, event: "created", detail: { runId: launched.runId, name: "wf" } });
  });
});

describe("lifecycle -- running -> completed | failed | stopped (WS-11 §1.8)", () => {
  test("a returning script completes, and only the script's RETURN VALUE re-enters the conversation", async () => {
    const r = rig();
    const launched = launch(r, META + `log("noise"); return { answer: 42 };`);
    const view = await r.runtime.await(launched.runId);
    expect(view.status).toBe("completed");
    expect(view.result).toBe(JSON.stringify({ answer: 42 }));
    expect(r.log.at(-1)).toMatchObject({ event: "complete" });
  });

  test("a throwing script FAILS the run with the script's own message", async () => {
    const r = rig();
    const launched = launch(r, META + `throw new Error("nope");`);
    const view = await r.runtime.await(launched.runId);
    expect(view.status).toBe("failed");
    expect(view.error).toContain("nope");
    expect(r.log.at(-1)).toMatchObject({ event: "fail" });
  });

  test("CRASH FALLBACK: a worker that exits with no terminal message fails the run rather than hanging the caller", async () => {
    const r = rig();
    const launched = r.runtime.launch(
      { sessionId: "sess-1", cwd: "/synthetic", trustedWorkspace: true, parentToolUseId: "tooluse-launch", source: META + `return 1;`, meta: { name: "wf", description: "d" } },
      r.host,
    );
    // Kill the worker before it can answer -- the exact shape of an OOM or an external kill.
    r.runtime.killWorkerForTest(launched.runId);
    const view = await r.runtime.await(launched.runId);
    expect(view.status).toBe("failed");
    expect(view.error).toContain("exited");
  });

  test("stop() moves a live run to `stopped`, and a late crash cannot overwrite that with `failed`", async () => {
    const r = rig();
    const launched = launch(r, META + `await agent("hang"); return 1;`, {});
    // Never answer the agent call: the run is genuinely in flight when stop lands.
    expect(r.runtime.stop(launched.runId)).toBe(true);
    const view = await r.runtime.await(launched.runId);
    expect(view.status).toBe("stopped");
  });

  test("`wasStopped` distinguishes the third terminal state -- a stop is not a failure", async () => {
    const r = rig();
    const launched = launch(r, META + `await agent("hang"); return 1;`, {});
    r.runtime.stop(launched.runId);
    await r.runtime.await(launched.runId);
    expect(r.runtime.wasStopped(launched.runId)).toBe(true);

    const failed = launch(r, META + `throw new Error("nope");`);
    await r.runtime.await(failed.runId);
    expect(r.runtime.wasStopped(failed.runId)).toBe(false);
  });

  test("stop() on an unknown or already-terminal run is false, never a throw", async () => {
    const r = rig();
    expect(r.runtime.stop("wf_nope")).toBe(false);
    const launched = launch(r, META + `return 1;`);
    await r.runtime.await(launched.runId);
    expect(r.runtime.stop(launched.runId)).toBe(false);
  });
});

describe("the bridge service loop", () => {
  test("`agent()` reaches the host's spawnChild and the child's content comes back to the script", async () => {
    const r = rig();
    const launched = launch(r, META + `return await agent("do the thing");`);
    const view = await r.runtime.await(launched.runId);
    expect(view.status).toBe("completed");
    expect(r.spawned).toHaveLength(1);
    expect(r.spawned[0]).toMatchObject({ prompt: "do the thing", runInBackground: false });
    // A STRING return passes through VERBATIM; only a non-string is JSON-rendered, so the
    // model reads the agent's prose rather than a quoted JSON string literal.
    expect(view.result).toBe("child:do the thing");
  });

  test("agent OPTS map onto SpawnChildRequest: label->name, model, isolation, schema->outputFormat", async () => {
    const r = rig();
    const launched = launch(
      r,
      META + `return await agent("p", { label: "L", model: "m", isolation: "worktree", schema: { type: "object" } });`,
    );
    await r.runtime.await(launched.runId);
    expect(r.spawned[0]).toMatchObject({
      prompt: "p",
      name: "L",
      model: "m",
      isolation: "worktree",
      outputFormat: { type: "json_schema", schema: { type: "object" } },
    });
  });

  test("`effort` rides on the child DEFINITION -- SpawnChildRequest carries no effort field (engine.ts:1231)", async () => {
    const r = rig();
    const launched = launch(r, META + `return await agent("p", { effort: "high" });`);
    await r.runtime.await(launched.runId);
    expect(r.spawned[0]?.definition?.effort).toBe("high");
  });

  test("a child that FAILS resolves the script's agent() to null -- not a throw (WS-11 §1.6)", async () => {
    const r = rig({ spawnAgent: async () => fakeChild({ status: "failed", content: "died" }) });
    const launched = launch(r, META + `const a = await agent("x"); return a === null;`);
    const view = await r.runtime.await(launched.runId);
    expect(view.result).toBe("true");
  });

  test("a child that STOPS also resolves to null", async () => {
    const r = rig({ spawnAgent: async () => fakeChild({ status: "stopped", content: "" }) });
    const launched = launch(r, META + `return await agent("x");`);
    expect((await r.runtime.await(launched.runId)).result).toBe("null");
  });

  test("a spawnAgent that THROWS is a null result too, never an unhandled rejection in the daemon", async () => {
    const r = rig({
      spawnAgent: async () => {
        throw new Error("no spawn capability");
      },
    });
    const launched = launch(r, META + `return await agent("x");`);
    const view = await r.runtime.await(launched.runId);
    expect(view.status).toBe("completed");
    expect(view.result).toBe("null");
  });

  test("phase() updates the run's phase and log() flows through progress", async () => {
    const r = rig();
    const launched = launch(r, META + `phase("Research"); log("hello"); return 1;`);
    await r.runtime.await(launched.runId);
    const progress = r.log.filter((e) => e.event === "progress").map((e) => e.detail as WorkflowProgress & { summary?: string });
    expect(progress.some((p) => p.summary === "Research")).toBe(true);
    expect(progress.some((p) => p.summary === "hello")).toBe(true);
  });

  test("progress carries {running, completed, total} AND the pinned usage triple, so the host needs no second mapping", async () => {
    const r = rig();
    const launched = launch(r, META + `await agent("a"); return 1;`);
    await r.runtime.await(launched.runId);
    const progress = r.log.filter((e) => e.event === "progress").map((e) => e.detail as WorkflowProgress);
    expect(progress.length).toBeGreaterThan(0);
    for (const p of progress) {
      expect(typeof p.running).toBe("number");
      expect(typeof p.completed).toBe("number");
      expect(typeof p.total).toBe("number");
      expect(Object.keys(p.usage!).sort()).toEqual(["duration_ms", "tool_uses", "total_tokens"]);
    }
    expect(progress.at(-1)!.completed).toBe(1);
  });
});

describe("declared phases (WS-11 §1.2) -- matched at the moment a phase() call arrives", () => {
  test("a phase() title matching a DECLARED phase carries that declaration's `detail`; an unmatched one is its own group", async () => {
    const source = `export const meta = { name: "wf", description: "d", phases: [{ title: "Research", detail: "read the code" }] };
phase("Research"); phase("Cleanup"); return 1;`;
    const r = rig();
    const parsed = parseWorkflowMeta(source);
    if (!parsed.ok) throw new Error(parsed.error);
    const launched = r.runtime.launch({ sessionId: "sess-1", cwd: "/synthetic", trustedWorkspace: true, parentToolUseId: "tooluse-launch", source, meta: parsed.meta }, r.host);
    const view = await r.runtime.await(launched.runId);
    expect(view.status).toBe("completed");
    const summaries = r.log.filter((e) => e.event === "progress").map((e) => (e.detail as WorkflowProgress).summary);
    expect(summaries).toContain("Research: read the code"); // matched the declaration
    expect(summaries).toContain("Cleanup"); // its own group, never dropped or folded into the previous one
  });

  test("matching is EXACT -- a near miss is an ad-hoc group, not the declared one", async () => {
    const source = `export const meta = { name: "wf", description: "d", phases: [{ title: "Research", detail: "read the code" }] };
phase("research"); return 1;`;
    const r = rig();
    const parsed = parseWorkflowMeta(source);
    if (!parsed.ok) throw new Error(parsed.error);
    const launched = r.runtime.launch({ sessionId: "sess-1", cwd: "/synthetic", trustedWorkspace: true, parentToolUseId: "tooluse-launch", source, meta: parsed.meta }, r.host);
    await r.runtime.await(launched.runId);
    const summaries = r.log.filter((e) => e.event === "progress").map((e) => (e.detail as WorkflowProgress).summary);
    expect(summaries).toContain("research");
    expect(summaries).not.toContain("research: read the code");
  });
});

describe("F2 -- `agent(prompt, { phase })` is EXPLICIT progress-group assignment (WS-11 §1.6)", () => {
  // The option's whole stated purpose is "avoids races on the global `phase()` state inside
  // `pipeline`/`parallel` stages". So the test sets a global phase FIRST and then runs two agents
  // concurrently under different explicit phases: if the option were inert (or if it merely read the
  // ambient phase), both would report the global one.
  test("two agents in parallel under different explicit phases each report THEIR phase, not the global one", async () => {
    const r = rig({
      spawnAgent: async () => {
        await new Promise((res) => setTimeout(res, 10));
        return fakeChild({ content: "ok" });
      },
    });
    const launched = launch(
      r,
      META + `phase("Global");
await parallel([() => agent("a", { phase: "Alpha" }), () => agent("b", { phase: "Beta" })]);
return 1;`,
    );
    await r.runtime.await(launched.runId);
    const summaries = r.log.filter((e) => e.event === "progress").map((e) => (e.detail as WorkflowProgress).summary ?? "");
    expect(summaries.some((s) => s.includes("Alpha"))).toBe(true);
    expect(summaries.some((s) => s.includes("Beta"))).toBe(true);
  });

  test("an agent with NO explicit phase falls back to the run's current global phase", async () => {
    const r = rig();
    const launched = launch(r, META + `phase("Global"); await agent("a"); return 1;`);
    await r.runtime.await(launched.runId);
    const summaries = r.log.filter((e) => e.event === "progress").map((e) => (e.detail as WorkflowProgress).summary ?? "");
    expect(summaries.some((s) => s.includes("Global"))).toBe(true);
  });

  test("an explicit phase does NOT move the run's own global phase -- it is per-agent, not a `phase()` call", async () => {
    const r = rig();
    const launched = launch(r, META + `phase("Global"); await agent("a", { phase: "Sidebar" }); return 1;`);
    await r.runtime.await(launched.runId);
    expect(r.runtime.get(launched.runId)?.phase).toBe("Global");
  });

  // ================================================================================================
  // T8 rider 27: the group is STRUCTURAL now, not only prose.
  // ================================================================================================
  //
  // Lane W's NEEDS_CONTEXT 7. Every assertion above reads `summary` -- the progress TEXT -- because
  // that was the only channel. Text is a bad one: a declared phase whose `meta.phases` entry carries
  // no `detail` renders as a bare title, exactly like an ad-hoc `phase()` call, so a host rendering a
  // progress tree could not reconstruct the grouping WS-11 §1.2 specifies. `phase`/`declaredPhase`
  // on `WorkflowProgress` close that at the seam; the WIRE half stays open (the pinned
  // `task_progress` frame has no phase field -- see the field's own header).
  test("rider 27: a DECLARED phase and an ad-hoc one are distinguishable on the seam, not just in the text", async () => {
    const r = rig();
    // Two phases: one declared in `meta.phases` WITHOUT a detail (so its text is a bare title,
    // indistinguishable from the ad-hoc one), and one never declared at all.
    const meta = `export const meta = { name: "wf", description: "d", phases: [{ title: "Declared" }] };\n`;
    const launched = launch(r, meta + `phase("Declared"); phase("AdHoc"); return 1;`);
    await r.runtime.await(launched.runId);
    const progress = r.log.filter((e) => e.event === "progress").map((e) => e.detail as WorkflowProgress);

    const declared = progress.find((pr) => pr.phase === "Declared");
    const adHoc = progress.find((pr) => pr.phase === "AdHoc");
    expect(declared, "a declared phase reports its group structurally").toBeDefined();
    expect(adHoc, "an unmatched phase() gets its OWN group, not the previous one").toBeDefined();
    expect(declared!.declaredPhase).toBe(true);
    expect(adHoc!.declaredPhase).toBe(false);
    // AND THE TEXT CANNOT TELL THEM APART -- which is the whole reason the fields exist. If this
    // assertion ever fails, the structural fields have stopped being the only reliable signal and
    // this test's own premise needs revisiting.
    expect(declared!.summary).toBe("Declared");
    expect(adHoc!.summary).toBe("AdHoc");
  });

  test("rider 27: a COUNT change carries the current group too, so a progress tree never loses an agent", async () => {
    const r = rig({ spawnAgent: async () => fakeChild({ content: "ok" }) });
    const launched = launch(r, META + `phase("Global"); await agent("a"); return 1;`);
    await r.runtime.await(launched.runId);
    const progress = r.log.filter((e) => e.event === "progress").map((e) => e.detail as WorkflowProgress);
    // At least one report whose counts moved carries the group -- `declaredPhase` deliberately
    // absent there, because whether the group was declared is a fact about the `phase()` call that
    // established it, not about an agent starting under it.
    const counted = progress.filter((pr) => pr.phase === "Global" && pr.running + pr.completed > 0);
    expect(counted.length).toBeGreaterThan(0);
    expect(counted[0]!.declaredPhase).toBeUndefined();
  });
});

describe("meta.name is threaded, never recovered from the SANITIZED filename", () => {
  test("a name outside the slug alphabet keeps its verbatim `meta.name` on the launch result", async () => {
    const source = `export const meta = { name: "My Workflow!", description: "d" };\nreturn 1;`;
    const r = rig();
    const parsed = parseWorkflowMeta(source);
    if (!parsed.ok) throw new Error(parsed.error);
    const launched = r.runtime.launch({ sessionId: "sess-1", cwd: "/synthetic", trustedWorkspace: true, parentToolUseId: "tooluse-launch", source, meta: parsed.meta }, r.host);
    // The FILE is sanitized (it has to be -- the name becomes a path segment) ...
    expect(launched.scriptPath).toContain(`My-Workflow-${launched.runId}.js`);
    // ... while the NAME the pin asserts (`WorkflowOutput.workflowName` = meta.name) is verbatim.
    expect(launched.name).toBe("My Workflow!");
    await r.runtime.await(launched.runId);
  });
});

describe("F3 -- `agent({ schema })` returns the VALIDATED object, or null; never unvalidated data", () => {
  const SCHEMA = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };

  test("a child whose text is valid JSON AND passes the schema yields the validated object", async () => {
    const r = rig({ spawnAgent: async () => fakeChild({ content: JSON.stringify({ verdict: "ship it" }) }) });
    const launched = launch(r, META + `return await agent("review", { schema: ${JSON.stringify(SCHEMA)} });`);
    const view = await r.runtime.await(launched.runId);
    expect(view.status).toBe("completed");
    expect(view.result).toBe(JSON.stringify({ verdict: "ship it" }));
  });

  test("valid JSON that FAILS the schema yields null -- unvalidated data is never presented as validated", async () => {
    const r = rig({ spawnAgent: async () => fakeChild({ content: JSON.stringify({ wrong: 1 }) }) });
    const launched = launch(r, META + `return await agent("review", { schema: ${JSON.stringify(SCHEMA)} });`);
    expect((await r.runtime.await(launched.runId)).result).toBe("null");
  });

  test("non-JSON child text yields null -- the `died on a terminal error` arm, not a raw string", async () => {
    const r = rig({ spawnAgent: async () => fakeChild({ content: "I think you should ship it." }) });
    const launched = launch(r, META + `return await agent("review", { schema: ${JSON.stringify(SCHEMA)} });`);
    expect((await r.runtime.await(launched.runId)).result).toBe("null");
  });

  test("the schema rides SpawnChildRequest.outputFormat -- the same StructuredOutput path the session uses", async () => {
    const r = rig({ spawnAgent: async () => fakeChild({ content: JSON.stringify({ verdict: "ok" }) }) });
    const launched = launch(r, META + `return await agent("review", { schema: ${JSON.stringify(SCHEMA)} });`);
    await r.runtime.await(launched.runId);
    expect(r.spawned[0]?.outputFormat).toEqual({ type: "json_schema", schema: SCHEMA });
  });

  // PENDING RULING P5-I (spine, fix wave). The parent currently RE-PARSES the child's final text,
  // because `ChildResult` carried only `content: string` and `child-engine.ts`'s `observe` read
  // `message.result` -- which the engine's structured SUCCESS variant does not set. A child genuinely
  // forced onto StructuredOutput therefore usually has NO parseable final text, so the three cases
  // above are the FALLBACK's behaviour. RULING P5-I (fix wave) landed the intended one, and the test
  // below -- written against that shape and skipped until it existed -- is now live.
  test("P5-I LANDED: a child reports its validated object on ChildResult.structuredOutput, and agent() returns it without re-parsing text", async () => {
    // FLIPPED FROM `.skip` BY THE PHASE 5 FIX WAVE. The shape this pinned is now real:
    // `ChildResult.structuredOutput` carries what the child's OWN engine validated, and the text
    // re-parse below is a fallback for a child that produced none. The child here returns EMPTY
    // text, which is exactly the case the fallback cannot serve -- so a green result can only have
    // come from the new field.
    const r = rig({
      spawnAgent: async () =>
        fakeChild({ content: "", structuredOutput: { verdict: "ship it" } }),
    });
    const launched = launch(r, META + `return await agent("review", { schema: ${JSON.stringify(SCHEMA)} });`);
    expect((await r.runtime.await(launched.runId)).result).toBe(JSON.stringify({ verdict: "ship it" }));
  });
});

describe("F3 -- `agent({ agentType })` resolves through the SAME registry the Agent tool uses", () => {
  test("a resolved custom type becomes the child's definition, verbatim", async () => {
    const definition = { description: "a code reviewer", prompt: "You review code.", tools: ["Read"] };
    const r = rig({ resolveAgentType: () => definition });
    const launched = launch(r, META + `return await agent("look", { agentType: "reviewer" });`);
    await r.runtime.await(launched.runId);
    expect(r.spawned[0]?.definition).toEqual(definition);
  });

  test("`effort` composes ON TOP of a resolved type rather than replacing it", async () => {
    const r = rig({ resolveAgentType: () => ({ description: "d", prompt: "p" }) });
    const launched = launch(r, META + `return await agent("look", { agentType: "reviewer", effort: "high" });`);
    await r.runtime.await(launched.runId);
    expect(r.spawned[0]?.definition).toEqual({ description: "d", prompt: "p", effort: "high" });
  });

  test("an UNRESOLVED type records what was asked for -- never a silent generic child", async () => {
    const r = rig({ resolveAgentType: () => undefined });
    const launched = launch(r, META + `return await agent("look", { agentType: "ghost" });`);
    await r.runtime.await(launched.runId);
    expect(r.spawned[0]?.definition?.description).toContain("ghost");
  });

  test("the resolver is called with the run's cwd and trust verdict", async () => {
    const seen: Array<{ type: string; cwd: string; trusted: boolean }> = [];
    const r = rig({
      resolveAgentType: (type, ctx) => {
        seen.push({ type, cwd: ctx.cwd, trusted: ctx.trustedWorkspace });
        return undefined;
      },
    });
    const launched = launch(r, META + `return await agent("look", { agentType: "reviewer" });`);
    await r.runtime.await(launched.runId);
    expect(seen).toEqual([{ type: "reviewer", cwd: "/synthetic", trusted: true }]);
  });
});

describe("caps, enforced PARENT-side (WS-11 §1.6/§1.8)", () => {
  test("the total-agent cap FAILS the run recording how many completed -- never a silent truncation", async () => {
    const r = rig({ caps: { totalAgents: 2 } });
    const launched = launch(r, META + `for (let i = 0; i < 5; i++) await agent("a" + i); return "unreachable";`);
    const view = await r.runtime.await(launched.runId);
    expect(view.status).toBe("failed");
    expect(view.error).toContain("2");
    expect(view.error).toContain("completed");
  });

  test("the runtime-side semaphore is the AUTHORITATIVE concurrency bound", async () => {
    let live = 0;
    let peak = 0;
    const r = rig({
      caps: { concurrency: 2 },
      spawnAgent: async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((res) => setTimeout(res, 10));
        live--;
        return fakeChild({ content: "ok" });
      },
    });
    const launched = launch(r, META + `return await parallel(Array.from({length: 6}, (_, i) => () => agent("a" + i)));`);
    const view = await r.runtime.await(launched.runId);
    expect(view.status).toBe("completed");
    expect(peak).toBeLessThanOrEqual(2);
    expect(r.spawned).toHaveLength(6);
  });

  test("the budget ceiling REFUSES a further agent() call, parent-side, even if the worker's mirror were stale", async () => {
    // F4: driven through the session's CUMULATIVE `spentTokens()` (P5-J), not the context accountant.
    const r = rig({ budgetTotal: 100, spentTokens: () => 110 });
    const launched = launch(r, META + `return await agent("x");`);
    const view = await r.runtime.await(launched.runId);
    expect(view.status).toBe("failed");
    expect(view.error?.toLowerCase()).toContain("budget");
    expect(r.spawned).toHaveLength(0);
  });
});

describe("abort chaining (WS-11 §1.8): stop cancels IN-FLIGHT bridged agents, not just the worker", () => {
  test("a stop() stops every live child the run spawned", async () => {
    const stopped: string[] = [];
    const r = rig({
      spawnAgent: async (req) =>
        fakeChild({ neverSettle: true, onStop: () => stopped.push(req.prompt) }),
    });
    const launched = launch(r, META + `await parallel([() => agent("a"), () => agent("b")]); return 1;`);
    await new Promise((res) => setTimeout(res, 30)); // let both children be in flight
    r.runtime.stop(launched.runId);
    await r.runtime.await(launched.runId);
    expect(stopped.sort()).toEqual(["a", "b"]);
  });
});

describe("nested workflow() -- the parent resolves the source (WS-11 §1.6)", () => {
  test("a `{name}` ref is resolved parent-side and the child's return value comes back", async () => {
    const child = `export const meta = { name: "c", description: "c" };\nreturn "nested-ok";`;
    const r = rig({ resolveNested: async () => ({ ok: true, source: child }) });
    const launched = launch(r, META + `return await workflow("c");`);
    expect((await r.runtime.await(launched.runId)).result).toBe("nested-ok");
  });

  test("an unresolvable ref fails the run with the resolver's message", async () => {
    const r = rig({ resolveNested: async () => ({ ok: false, error: `unknown workflow "ghost"` }) });
    const launched = launch(r, META + `return await workflow("ghost");`);
    expect((await r.runtime.await(launched.runId)).error).toContain("ghost");
  });
});

describe("resumeFromRunId -- preconditions and the cached prefix (WS-11 §1.5)", () => {
  test("an unknown runId is a TYPED error", async () => {
    const r = rig();
    expect(() => r.runtime.resume("wf_ghost", "sess-1", r.host)).toThrow(/unknown/i);
  });

  test("a DIFFERENT session is refused -- resume is same-session only (sdk-tools.d.ts:2786)", async () => {
    const r = rig();
    const launched = launch(r, META + `return 1;`);
    await r.runtime.await(launched.runId);
    expect(() => r.runtime.resume(launched.runId, "sess-OTHER", r.host)).toThrow(/same session/i);
  });

  test("a run that is not STOPPED is refused, and the message names TaskStop", async () => {
    const r = rig();
    const launched = launch(r, META + `return 1;`);
    await r.runtime.await(launched.runId); // completed, not stopped
    expect(() => r.runtime.resume(launched.runId, "sess-1", r.host)).toThrow(/TaskStop/);
  });

  test("resuming a stopped run replays the unchanged agent() prefix from the journal and only re-runs the rest", async () => {
    // The FIRST call completes (and is journaled); the SECOND hangs, so the run is genuinely in
    // flight when stop() lands -- `stopped` is the resume precondition, and a run that raced to
    // `completed` would make this test assert the wrong precondition entirely.
    let hangNext = false;
    const r = rig({
      spawnAgent: async (req) => {
        if (hangNext) return fakeChild({ neverSettle: true });
        hangNext = true;
        return fakeChild({ content: `child:${req.prompt}` });
      },
    });
    const source = META + `const a = await agent("one"); const b = await agent("two"); return [a, b];`;
    const first = launch(r, source);
    await new Promise((res) => setTimeout(res, 40));
    expect(r.runtime.stop(first.runId)).toBe(true);
    await r.runtime.await(first.runId);
    expect(existsSync(join(r.sessionTempDir, "workflows", "runs", first.runId, "journal.jsonl"))).toBe(true);

    hangNext = false; // the resumed run answers both calls for real
    const before = r.spawned.length;
    // The RESUMING call's tool_use id, not the original launch's (WS-10 §4 correlation).
    const second = r.runtime.resume(first.runId, "sess-1", r.host, { parentToolUseId: "tooluse-resume" });
    expect(r.spawned.length).toBe(before); // nothing dispatched yet -- the assertion below is about the NEW children
    const view = await r.runtime.await(second.runId);
    expect(view.status).toBe("completed");
    expect(view.result).toBe(JSON.stringify(["child:one", "child:two"]));
    // "one" came from the journal; only "two" was dispatched live.
    expect(r.spawned.slice(before).map((s) => s.prompt)).toEqual(["two"]);
    expect(r.spawned.slice(before).map((s) => s.parentToolUseId)).toEqual(["tooluse-resume"]);
  });

  test("F8: a resume-of-a-resume still replays -- the cached prefix is carried into the new run's journal", async () => {
    // THREE agents, and one prompt hangs per hop, so each hop reaches `stopped` with exactly one more
    // call journaled than the last. Before F8 the second hop's journal held only its own LIVE call --
    // the replayed prefix short-circuits inside the worker and never reaches the bridge -- so the
    // third hop replayed nothing at all (a 0% hit, against §1.5's "same script + same args -> 100%").
    const hangFor = new Set<string>(["two"]);
    const r = rig({
      spawnAgent: async (req) => (hangFor.has(req.prompt) ? fakeChild({ neverSettle: true }) : fakeChild({ content: `child:${req.prompt}` })),
    });
    const source = META + `const a = await agent("one"); const b = await agent("two"); const c = await agent("three"); return [a, b, c];`;

    const hop1 = launch(r, source);
    await new Promise((res) => setTimeout(res, 50));
    r.runtime.stop(hop1.runId);
    await r.runtime.await(hop1.runId);

    // Hop 2: "one" replays from hop 1's journal, "two" now runs live, "three" hangs.
    hangFor.delete("two");
    hangFor.add("three");
    const hop2 = r.runtime.resume(hop1.runId, "sess-1", r.host, { parentToolUseId: "tooluse-r2" });
    await new Promise((res) => setTimeout(res, 60));
    r.runtime.stop(hop2.runId);
    await r.runtime.await(hop2.runId);

    // Hop 3: "one" AND "two" must both replay -- "one" only can if hop 2 carried it forward.
    hangFor.clear();
    const before = r.spawned.length;
    const hop3 = r.runtime.resume(hop2.runId, "sess-1", r.host, { parentToolUseId: "tooluse-r3" });
    const view = await r.runtime.await(hop3.runId);
    expect(view.status).toBe("completed");
    expect(view.result).toBe(JSON.stringify(["child:one", "child:two", "child:three"]));
    expect(r.spawned.slice(before).map((s) => s.prompt)).toEqual(["three"]); // only the tail ran live
  });

  test("a FAILED agent call is never journaled -- it re-runs LIVE on resume rather than replaying its null (WS-11 §1.5)", async () => {
    let attempt = 0;
    const r = rig({
      spawnAgent: async (req) => {
        attempt++;
        // The first call fails (so it must not be journaled); the second hangs, so the run is
        // genuinely in flight and can reach `stopped` -- the resume precondition.
        if (attempt === 1) return fakeChild({ status: "failed", content: "flaky" });
        if (attempt === 2) return fakeChild({ neverSettle: true });
        return fakeChild({ content: `child:${req.prompt}` });
      },
    });
    const source = META + `const a = await agent("one"); await agent("hang"); return a;`;
    const first = launch(r, source);
    await new Promise((res) => setTimeout(res, 40));
    r.runtime.stop(first.runId);
    await r.runtime.await(first.runId);
    // Nothing was journaled: the only completed call FAILED.
    const journalPath = join(r.sessionTempDir, "workflows", "runs", first.runId, "journal.jsonl");
    expect(existsSync(journalPath) ? readFileSync(journalPath, "utf8").trim() : "").toBe("");

    const before = r.spawned.length;
    const second = r.runtime.resume(first.runId, "sess-1", r.host);
    await r.runtime.await(second.runId);
    expect(r.spawned.slice(before).map((s) => s.prompt)[0]).toBe("one"); // re-ran live
  });
});

describe("isolation from the real environment", () => {
  let originalHome: string | undefined;
  beforeEach(() => {
    originalHome = process.env.WINTER_HOME;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.WINTER_HOME;
    else process.env.WINTER_HOME = originalHome;
  });

  test("every path the runtime writes comes from the injected session, never from the real WINTER_HOME", async () => {
    process.env.WINTER_HOME = "/should/never/be/read";
    const r = rig();
    const launched = launch(r, META + `return 1;`);
    expect(launched.scriptPath.startsWith(r.winterHome)).toBe(true);
    await r.runtime.await(launched.runId);
  });
});
