// cron.ts tests -- Phase 3, Lane D, Task 6. `import "./cron.ts"` triggers the module's three
// replaceExecutor(...) side effects (registry.test.ts's "Fix round 1" precedent: never use
// "CronCreate"/"CronDelete"/"CronList" as throwaway fixture names elsewhere).
//
// Durable-persistence tests use a FRESH mkdtemp project dir per test as `ctx.cwd` -- isolation comes
// from the filesystem itself (never ~/.winter, never a shared fixture tree), so no reset hook is
// needed for the durable half; the in-memory (non-durable) half IS a shared, process-wide module
// singleton and gets the house beforeEach+afterEach reset (background-tasks.ts precedent).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./cron.ts";
import { humanizeCron, resetInMemoryCronStoreForTest, validateCronExpression } from "./cron.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";

function makeCtx(cwd: string): ToolExecutionContext {
  return {
    cwd,
    home: "/home/test",
    sessionId: "cron-test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: join(cwd, ".tmp"),
    sandboxSettings: {},
    // M3 (fix wave, P3 close-out): cron.ts now keys its durable store on ctx.session.getSessionRoot()
    // (RULING P3-L), not the live ctx.cwd -- this fixture's own session root must track `cwd` (the
    // test's own project dir) for the durable-store tests to exercise the real file path.
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => cwd, setSessionRoot() {} },
  };
}

async function run(name: string, input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const tool = getRegisteredTool(name);
  if (!tool?.executor) throw new Error(`${name} executor is not registered`);
  return tool.executor.execute(input, ctx);
}

function tempProjectDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "winter-cron-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

beforeEach(() => {
  resetInMemoryCronStoreForTest();
});
afterEach(() => {
  resetInMemoryCronStoreForTest();
});

describe("validateCronExpression", () => {
  test("accepts a fully-wildcard expression", () => {
    expect(() => validateCronExpression("* * * * *")).not.toThrow();
  });

  test("accepts steps, ranges, lists, and month/day-of-week names", () => {
    expect(() => validateCronExpression("*/15 9-17 * * mon-fri")).not.toThrow();
    expect(() => validateCronExpression("0 9 * jan mon")).not.toThrow();
    expect(() => validateCronExpression("1,2,3 0 1 1 0")).not.toThrow();
  });

  test("rejects a field count other than 5", () => {
    expect(() => validateCronExpression("* * * *")).toThrow(/5/);
    expect(() => validateCronExpression("* * * * * *")).toThrow(/5/);
  });

  test("rejects a named schedule (@daily)", () => {
    expect(() => validateCronExpression("@daily")).toThrow(/named schedule/);
  });

  test("rejects an out-of-range value", () => {
    expect(() => validateCronExpression("60 * * * *")).toThrow(/out of range/);
    expect(() => validateCronExpression("* 24 * * *")).toThrow(/out of range/);
  });

  test("rejects an unknown token (not a number or name)", () => {
    expect(() => validateCronExpression("0 9 * bogus *")).toThrow(/not a valid value/);
  });

  test("rejects a malformed step", () => {
    expect(() => validateCronExpression("*/0 * * * *")).toThrow();
    expect(() => validateCronExpression("*/abc * * * *")).toThrow();
  });

  test("rejects an inverted range", () => {
    expect(() => validateCronExpression("30-10 * * * *")).toThrow(/range start must not exceed end/);
  });

  test("rejects an empty expression", () => {
    expect(() => validateCronExpression("")).toThrow();
    expect(() => validateCronExpression("   ")).toThrow();
  });
});

describe("humanizeCron", () => {
  test("every minute", () => {
    expect(humanizeCron("* * * * *")).toBe("every minute");
  });
  test("every N minutes", () => {
    expect(humanizeCron("*/15 * * * *")).toBe("every 15 minutes");
  });
  test("hourly at a given minute", () => {
    expect(humanizeCron("30 * * * *")).toBe("hourly at minute 30");
  });
  test("daily at HH:MM", () => {
    expect(humanizeCron("5 9 * * *")).toBe("daily at 09:05");
  });
  test("weekly on a named day", () => {
    expect(humanizeCron("0 9 * * mon")).toBe("weekly on Monday at 09:00");
  });
  test("weekly on a numeric day-of-week", () => {
    expect(humanizeCron("0 9 * * 0")).toBe("weekly on Sunday at 09:00");
  });
  test("monthly on a day-of-month", () => {
    expect(humanizeCron("0 9 15 * *")).toBe("monthly on day 15 at 09:00");
  });
  test("an unrecognized shape falls back to the raw expression, never invented wording", () => {
    expect(humanizeCron("1,2 3 * * *")).toBe("1,2 3 * * *");
  });
});

describe("CronCreate", () => {
  test("non-durable success: id/humanSchedule/recurring present, durable OMITTED", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      const result = await run("CronCreate", { cron: "0 9 * * *", prompt: "say good morning" }, makeCtx(dir));
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(typeof parsed.id).toBe("string");
      expect(parsed.humanSchedule).toBe("daily at 09:00");
      expect(parsed.recurring).toBe(true);
      expect(parsed).not.toHaveProperty("durable");
    } finally {
      cleanup();
    }
  });

  test("recurring:false is honored and echoed", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      const result = await run("CronCreate", { cron: "* * * * *", prompt: "p", recurring: false }, makeCtx(dir));
      expect(JSON.parse(result.output).recurring).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("durable:true is echoed as durable:true and persists to .winter/scheduled_tasks.json", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      const result = await run("CronCreate", { cron: "* * * * *", prompt: "p", durable: true }, makeCtx(dir));
      const parsed = JSON.parse(result.output);
      expect(parsed.durable).toBe(true);
      const filePath = join(dir, ".winter", "scheduled_tasks.json");
      const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
      expect(onDisk.jobs).toHaveLength(1);
      expect(onDisk.jobs[0].id).toBe(parsed.id);
      expect(onDisk.jobs[0].durable).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("durable create makes the parent .winter/ directory when absent", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      await run("CronCreate", { cron: "* * * * *", prompt: "p", durable: true }, makeCtx(dir));
      expect(() => readFileSync(join(dir, ".winter", "scheduled_tasks.json"), "utf8")).not.toThrow();
    } finally {
      cleanup();
    }
  });

  test("a durable job survives the in-memory store being reset (the file is the source of truth)", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      await run("CronCreate", { cron: "* * * * *", prompt: "p", durable: true }, makeCtx(dir));
      resetInMemoryCronStoreForTest();
      const listed = JSON.parse((await run("CronList", {}, makeCtx(dir))).output);
      expect(listed.jobs).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("rejects a malformed cron expression with a legible, field-naming error", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      const result = await run("CronCreate", { cron: "60 * * * *", prompt: "p" }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("minute");
    } finally {
      cleanup();
    }
  });

  test("rejects a missing prompt", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      const result = await run("CronCreate", { cron: "* * * * *" }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("prompt");
    } finally {
      cleanup();
    }
  });

  test("a durable create against an existing malformed scheduled_tasks.json fails loudly and does not clobber the file", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      mkdirSync(join(dir, ".winter"), { recursive: true });
      const filePath = join(dir, ".winter", "scheduled_tasks.json");
      writeFileSync(filePath, "{ not valid json", "utf8");
      const result = await run("CronCreate", { cron: "* * * * *", prompt: "p", durable: true }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("{ not valid json");
    } finally {
      cleanup();
    }
  });
});

describe("CronDelete", () => {
  // T8 envelope-reconciliation fix: the pinned CronDeleteOutput is bare `{id: string}` (confirmed via
  // ephemeral capture, derived-shapes-p3-task8.md) -- no `deleted` field, in either branch. The
  // deletion still genuinely happens (proven below via a follow-up CronList), the wire result just
  // carries no found/not-found signal, per the pinned shape.
  test("deletes a non-durable (in-memory) job by id", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      const created = JSON.parse((await run("CronCreate", { cron: "* * * * *", prompt: "p" }, makeCtx(dir))).output);
      const result = await run("CronDelete", { id: created.id }, makeCtx(dir));
      expect(JSON.parse(result.output)).toEqual({ id: created.id });
      const listed = JSON.parse((await run("CronList", {}, makeCtx(dir))).output);
      expect(listed.jobs).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("deletes a durable job by id, rewriting the file", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      const created = JSON.parse((await run("CronCreate", { cron: "* * * * *", prompt: "p", durable: true }, makeCtx(dir))).output);
      const result = await run("CronDelete", { id: created.id }, makeCtx(dir));
      expect(JSON.parse(result.output)).toEqual({ id: created.id });
      const onDisk = JSON.parse(readFileSync(join(dir, ".winter", "scheduled_tasks.json"), "utf8"));
      expect(onDisk.jobs).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("deleting one durable job among several leaves the others intact", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      const a = JSON.parse((await run("CronCreate", { cron: "* * * * *", prompt: "a", durable: true }, makeCtx(dir))).output);
      const b = JSON.parse((await run("CronCreate", { cron: "0 0 * * *", prompt: "b", durable: true }, makeCtx(dir))).output);
      await run("CronDelete", { id: a.id }, makeCtx(dir));
      const listed = JSON.parse((await run("CronList", {}, makeCtx(dir))).output);
      expect(listed.jobs.map((j: { id: string }) => j.id)).toEqual([b.id]);
    } finally {
      cleanup();
    }
  });

  test("deleting an unknown id is a non-error, bare {id} echo (no found/not-found signal in the pinned shape)", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      const result = await run("CronDelete", { id: "ghost" }, makeCtx(dir));
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.output)).toEqual({ id: "ghost" });
    } finally {
      cleanup();
    }
  });

  test("rejects a missing id", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      const result = await run("CronDelete", {}, makeCtx(dir));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("CronList", () => {
  test("empty project: {jobs: []}", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      const result = await run("CronList", {}, makeCtx(dir));
      expect(JSON.parse(result.output)).toEqual({ jobs: [] });
    } finally {
      cleanup();
    }
  });

  test("lists both durable and non-durable jobs together, each with id/cron/humanSchedule/prompt/recurring/durable", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      await run("CronCreate", { cron: "* * * * *", prompt: "mem", durable: false }, makeCtx(dir));
      await run("CronCreate", { cron: "0 9 * * *", prompt: "disk", durable: true }, makeCtx(dir));
      const listed = JSON.parse((await run("CronList", {}, makeCtx(dir))).output);
      expect(listed.jobs).toHaveLength(2);
      for (const job of listed.jobs) {
        expect(Object.keys(job).sort()).toEqual(["cron", "durable", "humanSchedule", "id", "prompt", "recurring"]);
      }
      const durableRow = listed.jobs.find((j: { durable: boolean }) => j.durable);
      expect(durableRow.humanSchedule).toBe("daily at 09:00");
    } finally {
      cleanup();
    }
  });

  test("a malformed scheduled_tasks.json fails loudly and is never touched by the list call", async () => {
    const { dir, cleanup } = tempProjectDir();
    try {
      mkdirSync(join(dir, ".winter"), { recursive: true });
      const filePath = join(dir, ".winter", "scheduled_tasks.json");
      writeFileSync(filePath, "not json at all", "utf8");
      const result = await run("CronList", {}, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("not json at all");
    } finally {
      cleanup();
    }
  });

  test("two different project directories never see each other's durable jobs", async () => {
    const p1 = tempProjectDir();
    const p2 = tempProjectDir();
    try {
      await run("CronCreate", { cron: "* * * * *", prompt: "p1-job", durable: true }, makeCtx(p1.dir));
      const listedP2 = JSON.parse((await run("CronList", {}, makeCtx(p2.dir))).output);
      expect(listedP2.jobs).toEqual([]);
    } finally {
      p1.cleanup();
      p2.cleanup();
    }
  });
});
