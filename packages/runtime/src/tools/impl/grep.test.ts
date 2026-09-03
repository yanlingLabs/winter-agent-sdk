// Phase 3, Lane A, Task 4 -- Grep executor tests. Fresh mkdtemp fixture tree per test.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./grep.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import type { GrepResult } from "./grep.ts";

function makeCtx(cwd: string, overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd,
    home: "/home/test",
    sessionId: "test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: join(cwd, ".tmp"),
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
    ...overrides,
  };
}

async function runGrep(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const tool = getRegisteredTool("Grep");
  if (!tool?.executor) throw new Error("Grep executor is not registered");
  return tool.executor.execute(input, ctx);
}

function parse(result: ToolResultPayload): GrepResult {
  return JSON.parse(result.output) as GrepResult;
}

describe("Grep (Phase 3, Lane A, Task 4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "winter-grep-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("modes", () => {
    test("defaults to files_with_matches", async () => {
      writeFileSync(join(dir, "a.txt"), "needle here");
      writeFileSync(join(dir, "b.txt"), "nothing");
      const r = parse(await runGrep({ pattern: "needle" }, makeCtx(dir)));
      expect(r.mode).toBe("files_with_matches");
      expect(r.files).toEqual([join(dir, "a.txt")]);
      expect(r.content).toBeUndefined();
      expect(r.counts).toBeUndefined();
    });

    test("content mode returns matching lines", async () => {
      writeFileSync(join(dir, "a.txt"), "hello world\nfoo bar\nHELLO again");
      const r = parse(await runGrep({ pattern: "hello", output_mode: "content" }, makeCtx(dir)));
      expect(r.content).toHaveLength(1);
      expect(r.content?.[0]?.text).toBe("hello world");
    });

    test("count mode counts distinct matching lines per file", async () => {
      writeFileSync(join(dir, "a.txt"), "cat\ncat\ndog\ncat");
      const r = parse(await runGrep({ pattern: "cat", output_mode: "count" }, makeCtx(dir)));
      expect(r.counts).toEqual({ [join(dir, "a.txt")]: 3 });
    });

    test("no matches -> empty result, not an error", async () => {
      writeFileSync(join(dir, "a.txt"), "nothing here");
      const result = await runGrep({ pattern: "zzz" }, makeCtx(dir));
      expect(result.isError).toBeUndefined();
      const r = parse(result);
      expect(r.files).toEqual([]);
    });
  });

  describe("-i case insensitivity", () => {
    test("without -i, case matters", async () => {
      writeFileSync(join(dir, "a.txt"), "hello\nHELLO");
      const r = parse(await runGrep({ pattern: "hello", output_mode: "content" }, makeCtx(dir)));
      expect(r.content).toHaveLength(1);
    });
    test("with -i, both cases match", async () => {
      writeFileSync(join(dir, "a.txt"), "hello\nHELLO");
      const r = parse(await runGrep({ pattern: "hello", output_mode: "content", "-i": true }, makeCtx(dir)));
      expect(r.content).toHaveLength(2);
    });
  });

  describe("-n line numbers (content mode only)", () => {
    test("line is omitted without -n", async () => {
      writeFileSync(join(dir, "a.txt"), "a\nmatch\nc");
      const r = parse(await runGrep({ pattern: "match", output_mode: "content" }, makeCtx(dir)));
      expect(r.content?.[0]?.line).toBeUndefined();
    });
    test("line is populated (1-based) with -n", async () => {
      writeFileSync(join(dir, "a.txt"), "a\nmatch\nc");
      const r = parse(await runGrep({ pattern: "match", output_mode: "content", "-n": true }, makeCtx(dir)));
      expect(r.content?.[0]?.line).toBe(2);
    });
  });

  describe("-o only-match", () => {
    test("emits one row per match on a line", async () => {
      writeFileSync(join(dir, "a.txt"), "cat cat dog cat");
      const r = parse(await runGrep({ pattern: "cat", output_mode: "content", "-o": true }, makeCtx(dir)));
      expect(r.content).toHaveLength(3);
      expect(r.content?.every((row) => row.text === "cat")).toBe(true);
    });
    test("without -o, one row per matching LINE regardless of match count on it", async () => {
      writeFileSync(join(dir, "a.txt"), "cat cat dog cat");
      const r = parse(await runGrep({ pattern: "cat", output_mode: "content" }, makeCtx(dir)));
      expect(r.content).toHaveLength(1);
      expect(r.content?.[0]?.text).toBe("cat cat dog cat");
    });
  });

  describe("context (-B/-A/-C/context)", () => {
    function makeTenLines(): string {
      return Array.from({ length: 10 }, (_, i) => (i === 4 ? "MATCH" : `line${i + 1}`)).join("\n");
    }

    test("-B/-A add context rows without `match` set, only the real match row has match:true", async () => {
      writeFileSync(join(dir, "a.txt"), makeTenLines());
      const r = parse(await runGrep({ pattern: "MATCH", output_mode: "content", "-B": 1, "-A": 1, "-n": true }, makeCtx(dir)));
      expect(r.content?.map((row) => [row.line, row.text, row.match ?? false])).toEqual([
        [4, "line4", false],
        [5, "MATCH", true],
        [6, "line6", false],
      ]);
    });

    test("-C sets both directions", async () => {
      writeFileSync(join(dir, "a.txt"), makeTenLines());
      const r = parse(await runGrep({ pattern: "MATCH", output_mode: "content", "-C": 2, "-n": true }, makeCtx(dir)));
      expect(r.content?.map((row) => row.line)).toEqual([3, 4, 5, 6, 7]);
    });

    test("`context` is an alias for -C", async () => {
      writeFileSync(join(dir, "a.txt"), makeTenLines());
      const r = parse(await runGrep({ pattern: "MATCH", output_mode: "content", context: 2, "-n": true }, makeCtx(dir)));
      expect(r.content?.map((row) => row.line)).toEqual([3, 4, 5, 6, 7]);
    });

    test("-B alone leaves `after` at 0", async () => {
      writeFileSync(join(dir, "a.txt"), makeTenLines());
      const r = parse(await runGrep({ pattern: "MATCH", output_mode: "content", "-B": 1, "-n": true }, makeCtx(dir)));
      expect(r.content?.map((row) => row.line)).toEqual([4, 5]);
    });

    test("overlapping context windows from two nearby matches are merged, not duplicated", async () => {
      writeFileSync(join(dir, "a.txt"), "MATCH\nmid\nMATCH\nend");
      const r = parse(await runGrep({ pattern: "MATCH", output_mode: "content", "-C": 1, "-n": true }, makeCtx(dir)));
      expect(r.content?.map((row) => row.line)).toEqual([1, 2, 3, 4]);
      expect(r.content?.filter((row) => row.match === true)).toHaveLength(2);
    });

    test("context/-n/-o are ignored outside content mode", async () => {
      writeFileSync(join(dir, "a.txt"), makeTenLines());
      const r = parse(await runGrep({ pattern: "MATCH", output_mode: "files_with_matches", "-C": 5, "-n": true, "-o": true }, makeCtx(dir)));
      expect(r.files).toEqual([join(dir, "a.txt")]);
      expect(r.content).toBeUndefined();
    });
  });

  describe("head_limit / offset", () => {
    test("default head_limit is 250, and truncation is reported", async () => {
      writeFileSync(join(dir, "a.txt"), Array.from({ length: 260 }, () => "X").join("\n"));
      const r = parse(await runGrep({ pattern: "X", output_mode: "content" }, makeCtx(dir)));
      expect(r.content).toHaveLength(250);
      expect(r.truncated).toBe(true);
      expect(r.limit).toBe(250);
    });

    test("head_limit:0 means unlimited", async () => {
      writeFileSync(join(dir, "a.txt"), Array.from({ length: 260 }, () => "X").join("\n"));
      const r = parse(await runGrep({ pattern: "X", output_mode: "content", head_limit: 0 }, makeCtx(dir)));
      expect(r.content).toHaveLength(260);
      expect(r.truncated).toBe(false);
      expect(r.limit).toBe(0);
    });

    test("offset skips rows before head_limit applies", async () => {
      writeFileSync(join(dir, "a.txt"), Array.from({ length: 10 }, (_, i) => `X${i}`).join("\n"));
      const r = parse(await runGrep({ pattern: "X", output_mode: "content", "-n": true, head_limit: 3, offset: 5 }, makeCtx(dir)));
      expect(r.content?.map((row) => row.line)).toEqual([6, 7, 8]);
      expect(r.truncated).toBe(true);
      expect(r.offset).toBe(5);
    });

    // T8 rider ("Grep negative head_limit/offset validation"): a bare `typeof !== "number"` check
    // let a NEGATIVE value straight through, reaching `rows.slice(offsetInput)` with silently WRONG
    // semantics (a negative slice argument means "count back from the end" in JS, not an error).
    test("a negative head_limit errors, never silently accepted", async () => {
      const result = await runGrep({ pattern: "x", head_limit: -5 }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("head_limit");
    });

    test("a negative offset errors, never silently accepted", async () => {
      const result = await runGrep({ pattern: "x", offset: -1 }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("offset");
    });

    test("NaN/Infinity for head_limit or offset error too (both are technically 'number', so the bare typeof check alone would accept them)", async () => {
      for (const bad of [NaN, Infinity, -Infinity]) {
        const headLimitResult = await runGrep({ pattern: "x", head_limit: bad }, makeCtx(dir));
        expect(headLimitResult.isError).toBe(true);
        const offsetResult = await runGrep({ pattern: "x", offset: bad }, makeCtx(dir));
        expect(offsetResult.isError).toBe(true);
      }
    });

    test("head_limit:0 (the pinned 'unlimited' sentinel) is still accepted -- the new check rejects negative/non-finite, never zero", async () => {
      writeFileSync(join(dir, "a.txt"), "X");
      const result = await runGrep({ pattern: "X", head_limit: 0 }, makeCtx(dir));
      expect(result.isError).toBeUndefined();
    });
  });

  describe("glob and type filters", () => {
    test("`glob` scopes which files are searched", async () => {
      writeFileSync(join(dir, "a.ts"), "needle");
      writeFileSync(join(dir, "a.md"), "needle");
      const r = parse(await runGrep({ pattern: "needle", glob: "*.ts" }, makeCtx(dir)));
      expect(r.files).toEqual([join(dir, "a.ts")]);
    });

    test("`type` filters by a recognized extension set", async () => {
      writeFileSync(join(dir, "a.ts"), "needle");
      writeFileSync(join(dir, "a.md"), "needle");
      const r = parse(await runGrep({ pattern: "needle", type: "ts" }, makeCtx(dir)));
      expect(r.files).toEqual([join(dir, "a.ts")]);
    });

    test("an unrecognized `type` errors, naming supported types", async () => {
      const result = await runGrep({ pattern: "needle", type: "not-a-real-type" }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("unrecognized type");
    });

    // Fix round 1 (MODERATE): `glob` is silently a no-op when `path` directly names a file -- only
    // the directory branch consults it. Pinned here: a `glob` that would EXCLUDE the directly-named
    // file (it's .txt, the glob only wants .md) has no effect -- the file is still searched.
    test("a `glob` that would exclude the directly-named file still searches it (glob is a no-op for a directly-named path)", async () => {
      const p = join(dir, "target.txt");
      writeFileSync(p, "needle");
      const r = parse(await runGrep({ pattern: "needle", path: p, glob: "*.md" }, makeCtx(dir)));
      expect(r.files).toEqual([p]);
    });

    test("`type` still applies to a directly-named path (a positive filter the caller explicitly asked for, unlike glob)", async () => {
      const p = join(dir, "target.py");
      writeFileSync(p, "needle");
      const r = parse(await runGrep({ pattern: "needle", path: p, type: "js" }, makeCtx(dir)));
      expect(r.files).toEqual([]);
    });
  });

  describe("per-file size cap (fix round 1, MODERATE)", () => {
    test("an oversized file is skipped, counted, and forces truncated:true -- a normal sibling still matches", async () => {
      const bigFile = join(dir, "huge.txt");
      // ~6.67MB of "needle" text -- over GREP_MAX_FILE_BYTES (5MB). Every line WOULD match if
      // scanned, so a passing test here proves the file was genuinely skipped, not just empty.
      writeFileSync(bigFile, "needle\n".repeat(1_000_000));
      writeFileSync(join(dir, "normal.txt"), "needle");
      const r = parse(await runGrep({ pattern: "needle" }, makeCtx(dir)));
      expect(r.files).toEqual([join(dir, "normal.txt")]);
      expect(r.skippedOversized).toBe(1);
      expect(r.truncated).toBe(true);
    });

    test("no oversized files: skippedOversized is 0 and never spuriously forces truncated", async () => {
      writeFileSync(join(dir, "normal.txt"), "needle");
      const r = parse(await runGrep({ pattern: "needle" }, makeCtx(dir)));
      expect(r.skippedOversized).toBe(0);
      expect(r.truncated).toBe(false);
    });
  });

  describe("multiline", () => {
    test("a pattern can span multiple lines; `line` reports the match's starting line", async () => {
      writeFileSync(join(dir, "a.txt"), "aaa\nSTART\nmid\nEND\nbbb");
      const r = parse(await runGrep({ pattern: "START.*END", output_mode: "content", multiline: true, "-n": true }, makeCtx(dir)));
      expect(r.content).toHaveLength(1);
      expect(r.content?.[0]?.line).toBe(2);
      expect(r.content?.[0]?.text).toBe("START\nmid\nEND");
    });

    test("-o in multiline mode shows only the matched substring, not the full spanned lines", async () => {
      writeFileSync(join(dir, "a.txt"), "aaa\nSTART\nmid\nEND\nbbb");
      const r = parse(await runGrep({ pattern: "ART.*EN", output_mode: "content", multiline: true, "-o": true }, makeCtx(dir)));
      expect(r.content?.[0]?.text).toBe("ART\nmid\nEN");
    });

    test("without multiline, a pattern requiring a cross-line span does not match", async () => {
      writeFileSync(join(dir, "a.txt"), "aaa\nSTART\nmid\nEND\nbbb");
      const r = parse(await runGrep({ pattern: "START.*END", output_mode: "content" }, makeCtx(dir)));
      expect(r.content).toEqual([]);
    });
  });

  describe("gitignore (directory mode only)", () => {
    test("an ignored file is excluded from a directory scan by default", async () => {
      writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
      writeFileSync(join(dir, "ignored.txt"), "needle");
      writeFileSync(join(dir, "kept.txt"), "needle");
      const r = parse(await runGrep({ pattern: "needle" }, makeCtx(dir)));
      expect(r.files).toEqual([join(dir, "kept.txt")]);
    });

    test("directly naming an ignored file still searches it", async () => {
      writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
      writeFileSync(join(dir, "ignored.txt"), "needle");
      const r = parse(await runGrep({ pattern: "needle", path: join(dir, "ignored.txt") }, makeCtx(dir)));
      expect(r.files).toEqual([join(dir, "ignored.txt")]);
    });

    test("a nested .gitignore can negate a broader parent rule", async () => {
      writeFileSync(join(dir, ".gitignore"), "*.log\n");
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", ".gitignore"), "!keep.log\n");
      writeFileSync(join(dir, "a.log"), "needle");
      writeFileSync(join(dir, "sub", "other.log"), "needle");
      writeFileSync(join(dir, "sub", "keep.log"), "needle");
      const r = parse(await runGrep({ pattern: "needle" }, makeCtx(dir)));
      expect(r.files?.sort()).toEqual([join(dir, "sub", "keep.log")].sort());
    });

    test("hidden files/directories are skipped by default (ripgrep-style)", async () => {
      mkdirSync(join(dir, ".hidden"));
      writeFileSync(join(dir, ".hidden", "a.txt"), "needle");
      writeFileSync(join(dir, ".dotfile"), "needle");
      writeFileSync(join(dir, "visible.txt"), "needle");
      const r = parse(await runGrep({ pattern: "needle" }, makeCtx(dir)));
      expect(r.files).toEqual([join(dir, "visible.txt")]);
    });
  });

  describe("binary files", () => {
    test("a file with a NUL byte is skipped", async () => {
      writeFileSync(join(dir, "bin.dat"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x00, 0x6c, 0x65]));
      writeFileSync(join(dir, "text.txt"), "needle");
      const r = parse(await runGrep({ pattern: "need" }, makeCtx(dir)));
      expect(r.files).toEqual([join(dir, "text.txt")]);
    });
  });

  describe("errors", () => {
    test("a nonexistent path errors", async () => {
      const result = await runGrep({ pattern: "x", path: join(dir, "nope") }, makeCtx(dir));
      expect(result.isError).toBe(true);
    });

    test("an invalid regex pattern errors without throwing", async () => {
      const result = await runGrep({ pattern: "(unterminated" }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid pattern");
    });

    test("a pattern over the internal length cap errors", async () => {
      const result = await runGrep({ pattern: "a".repeat(2000) }, makeCtx(dir));
      expect(result.isError).toBe(true);
    });

    test("missing pattern errors", async () => {
      const result = await runGrep({}, makeCtx(dir));
      expect(result.isError).toBe(true);
    });
  });

  // I1 (fix wave, P3 close-out): a rule-matched `path` FIELD deny is not a traversal guard --
  // `Grep({pattern:"x", path:"<home>"})` matches no `~/.winter/run/**` rule on ITS OWN `path` field
  // (the scan ROOT isn't under the denied subtree) yet would still walk INTO the run dir and surface
  // its contents. This is the exact RED scenario the review names: "plant `<home>/.winter/run/
  // pidfile`, run Grep with a probeReadAccess that answers deny for that subtree -- the result must
  // not list the file."
  describe("I1 (fix wave, P3 close-out): probeReadAccess filters deny-read subtrees out of the scan, not just the call's own path field", () => {
    test("a file under a subtree probeReadAccess denies is never listed, even though the scan root itself is not denied", async () => {
      const runDir = join(dir, ".winter", "run");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "pidfile"), "SEARCHABLE_SECRET_TOKEN");
      writeFileSync(join(dir, "ok.txt"), "SEARCHABLE_SECRET_TOKEN");

      const ctx = makeCtx(dir, {
        permissions: {
          probeReadAccess: (filePath: string) => (filePath.startsWith(runDir + "/") || filePath === runDir ? "deny" : "silent"),
        },
      });
      const result = await runGrep({ pattern: "SEARCHABLE_SECRET_TOKEN", output_mode: "files_with_matches" }, ctx);
      const parsed = parse(result);
      expect(parsed.files).toBeDefined();
      expect(parsed.files).toEqual([join(dir, "ok.txt")]);
      expect(parsed.files).not.toContain(join(runDir, "pidfile"));
    });

    test("a directly-named denied file (not a directory scan) is also excluded", async () => {
      const secretFile = join(dir, "secret.txt");
      writeFileSync(secretFile, "content");
      const ctx = makeCtx(dir, { permissions: { probeReadAccess: (filePath: string) => (filePath === secretFile ? "deny" : "silent") } });
      const result = await runGrep({ pattern: "content", path: secretFile, output_mode: "files_with_matches" }, ctx);
      const parsed = parse(result);
      expect(parsed.files ?? []).toEqual([]);
    });
  });

  describe("extractPaths seam (RULING P3-F, fix round 1: raw passthrough, no cwd resolution)", () => {
    test("returns the RAW `path` string unresolved, even when relative", () => {
      const tool = getRegisteredTool("Grep");
      expect(tool!.extractPaths!({ pattern: "x", path: "/some/dir" }).reads).toEqual(["/some/dir"]);
      expect(tool!.extractPaths!({ pattern: "x", path: "relative/dir" }).reads).toEqual(["relative/dir"]);
    });

    test("returns no candidates when `path` is absent -- never synthesizes a cwd default", () => {
      const tool = getRegisteredTool("Grep");
      expect(tool!.extractPaths!({ pattern: "x" }).reads).toEqual([]);
    });
  });
});
