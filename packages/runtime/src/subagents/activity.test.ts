// Contract §8: the per-tool activity text an agent's task_progress.description carries.
import { describe, test, expect } from "bun:test";
import { toolActivityDescription, truncActivity, displayActivityPath } from "./activity.ts";

const ctx = { cwd: "/work/proj", home: "/Users/me" };
const act = (tool: string, input: unknown): string | undefined => toolActivityDescription(tool, input, ctx);

describe("contract §8: trunc and path", () => {
  test("trunc collapses whitespace runs (newlines included), trims, and cuts at 50 with an ellipsis", () => {
    expect(truncActivity("  echo   hi\n\n  there  ")).toBe("echo hi there");
    const long = "x".repeat(60);
    expect(truncActivity(long)).toBe(`${"x".repeat(50)}…`);
    expect(truncActivity("y".repeat(50))).toBe("y".repeat(50));
  });

  test("path: relative inside the cwd, ~/… under home, else absolute; a relative input resolves against the cwd", () => {
    expect(displayActivityPath("/work/proj/src/a.ts", ctx.cwd, ctx.home)).toBe("src/a.ts");
    expect(displayActivityPath("src/b.ts", ctx.cwd, ctx.home)).toBe("src/b.ts");
    expect(displayActivityPath("/Users/me/notes/x.md", ctx.cwd, ctx.home)).toBe("~/notes/x.md");
    expect(displayActivityPath("/etc/hosts", ctx.cwd, ctx.home)).toBe("/etc/hosts");
    expect(displayActivityPath("/work/projection/x", ctx.cwd, ctx.home)).toBe("/work/projection/x"); // a sibling prefix is not "inside"
  });
});

describe("contract §8: the per-tool table", () => {
  test("Bash / PowerShell: description ?? trunc(command), fallback 'Running command'", () => {
    expect(act("Bash", { command: "ls   -la\n" })).toBe("Running ls -la");
    expect(act("Bash", { command: "ls", description: "List files" })).toBe("Running List files");
    expect(act("PowerShell", { command: "Get-ChildItem" })).toBe("Running Get-ChildItem");
    expect(act("Bash", {})).toBe("Running command");
  });

  test("Read: a Winter task .output file names the TASK; otherwise path(file_path); fallback 'Reading file'", () => {
    expect(act("Read", { file_path: "/tmp/winter-501/key/sess/tasks/0f8c2a4e-1b2c-4d5e-8f90-123456789abc.output" })).toBe("Reading 0f8c2a4e-1b2c-4d5e-8f90-123456789abc");
    expect(act("Read", { file_path: "/work/proj/README.md" })).toBe("Reading README.md");
    expect(act("Read", {})).toBe("Reading file");
  });

  test("Write / Edit / NotebookEdit", () => {
    expect(act("Write", { file_path: "/work/proj/a.txt" })).toBe("Writing a.txt");
    expect(act("Write", {})).toBe("Writing file");
    expect(act("Edit", { file_path: "/Users/me/x.ts" })).toBe("Editing ~/x.ts");
    expect(act("Edit", {})).toBe("Editing file");
    expect(act("NotebookEdit", { notebook_path: "/work/proj/n.ipynb" })).toBe("Editing notebook n.ipynb");
    expect(act("NotebookEdit", {})).toBe("Editing notebook");
  });

  test("Glob / Grep / WebFetch / WebSearch", () => {
    expect(act("Glob", { pattern: "src/**/*.ts" })).toBe("Finding src/**/*.ts");
    expect(act("Glob", {})).toBe("Finding files");
    expect(act("Grep", { pattern: "TODO" })).toBe("Searching for TODO");
    expect(act("Grep", {})).toBe("Searching");
    expect(act("WebFetch", { url: "https://example.com/a" })).toBe("Fetching https://example.com/a");
    expect(act("WebFetch", {})).toBe("Fetching web page");
    expect(act("WebSearch", { query: "bun  test\nrunner" })).toBe("Searching for bun test runner");
    expect(act("WebSearch", {})).toBe("Searching the web");
  });

  test("Agent: description whitespace-collapsed and trimmed (not truncated); Monitor: 'Monitoring: <description>'", () => {
    expect(act("Agent", { description: "  review\n the   diff " })).toBe("review the diff");
    expect(act("Agent", { description: "z".repeat(80) })).toBe("z".repeat(80));
    expect(act("Agent", {})).toBe("Running task");
    expect(act("Monitor", { description: "watch logs" })).toBe("Monitoring: watch logs");
    expect(act("Monitor", {})).toBe("Monitoring");
  });

  test("any other tool has no activity text; a non-object input takes the fallbacks", () => {
    expect(act("TodoWrite", { todos: [] })).toBeUndefined();
    expect(act("mcp__server__tool", {})).toBeUndefined();
    expect(act("Bash", null)).toBe("Running command");
    expect(act("Read", "nope")).toBe("Reading file");
  });
});
