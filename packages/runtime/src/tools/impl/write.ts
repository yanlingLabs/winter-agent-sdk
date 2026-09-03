// WS-06 §3.1 "Write" -- implement-now, pinned schema `{file_path, content}`. Create or COMPLETE
// overwrite, never append/merge; same read-before-overwrite ladder as Edit for EXISTING files (via
// read-ladder.ts's "overwrite" operation, which folds in the notebook/partial-read override); new
// files have no precondition at all (WS-06 §3.1, verbatim).
//
// Also hosts `computeLineDiff` -- the one LCS line-diff helper this lane needs, shared with edit.ts
// (a cross-import between this lane's OWN two files; no separate fifth file, per this task's file
// list). Write is the tool whose own WS-06 paragraph says "structured diff", so it lives here;
// edit.ts imports it for its own "file/diff info" result field.
//
// `replaceExecutor` runs at THIS module's own load time (mirrors every descriptors/*.ts file's own
// top-level `stub(...)` call) -- a test (or, later, T8's real wiring) triggers registration simply by
// importing this module. Production wiring (making the compiled daemon actually import every
// impl/*.ts file) is explicitly OUT of this lane's scope (R3-5: engine.ts/main.ts/the descriptors
// index are no-touch) -- T8 owns that per the phase ledger.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import "../descriptors/index.ts"; // side-effect only: guarantees the "Write" stub exists first.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { evaluateReadLadder, recordPostOperationRead, type ReadLadderDeps } from "./read-ladder.ts";

// ---------------------------------------------------------------------------------------------------
// computeLineDiff -- a small, self-contained LCS line diff. No new dependency (a diff library would
// be a NEEDS_CONTEXT stop under this lane's protocol; package.json is shared, no-touch) -- this is a
// standard O(lines(old) * lines(new)) dynamic-program, adequate for the tool-result sizes Edit/Write
// actually produce. Flagged for T8: a pathologically huge file produces a correspondingly large `dp`
// table and an unbounded-length result array -- no size cap is pinned anywhere in WS-06 §3.1 for
// Edit/Write (unlike Bash's explicit §3.2 output caps), so none is invented here.
// ---------------------------------------------------------------------------------------------------

export interface DiffLine {
  type: "context" | "add" | "remove";
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

// An empty string has ZERO lines, not one blank line -- `"".split("\n")` disagrees (`[""]`), which
// would inject a spurious leading "remove the empty line" artifact into every diff against a brand
// new (previousContent === "") or fully-emptied file. Any NON-empty string still splits normally,
// correctly preserving a genuine trailing "" element for content that ends in a newline.
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const m = oldLines.length;
  const n = newLines.length;

  // dp[i][j] = length of the LCS of oldLines[i..] and newLines[j..].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const dpRowBelow = dp[i + 1]!;
      const dpRow = dp[i]!;
      dpRow[j] = oldLines[i] === newLines[j] ? dpRowBelow[j + 1]! + 1 : Math.max(dpRowBelow[j]!, dpRow[j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldLineNumber = 1;
  let newLineNumber = 1;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: "context", oldLineNumber, newLineNumber, content: oldLines[i]! });
      i++;
      j++;
      oldLineNumber++;
      newLineNumber++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      result.push({ type: "remove", oldLineNumber, content: oldLines[i]! });
      i++;
      oldLineNumber++;
    } else {
      result.push({ type: "add", newLineNumber, content: newLines[j]! });
      j++;
      newLineNumber++;
    }
  }
  while (i < m) {
    result.push({ type: "remove", oldLineNumber, content: oldLines[i]! });
    i++;
    oldLineNumber++;
  }
  while (j < n) {
    result.push({ type: "add", newLineNumber, content: newLines[j]! });
    j++;
    newLineNumber++;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------
// The Write executor
// ---------------------------------------------------------------------------------------------------

interface WriteInput {
  file_path: string;
  content: string;
}

function parseInput(input: unknown): WriteInput | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const filePath = rec["file_path"];
  const content = rec["content"];
  if (typeof filePath !== "string" || typeof content !== "string") return undefined;
  return { file_path: filePath, content };
}

function errorResult(message: string): ToolResultPayload {
  return { output: `Error: ${message}`, isError: true };
}

// Minimal, honest result shape (WS-06 §3.1 prose + report §40.45): create/update, path/content, a
// structured diff, previous content "when retained" (always retained here -- no size threshold is
// pinned anywhere for omitting it, so omitting on some undocumented cutoff would be inventing
// behavior, not following the spec), and userEdited. `gitDiff` is deliberately OMITTED (report calls
// it "optional"; no git plumbing exists in this runtime and adding a shell-out is well outside this
// lane's scope) -- flagged for T8. `userEdited` is always `false`: the permission evaluator's own
// `transformedInput` (an approval-time content rewrite) happens upstream of this executor, and
// `ToolExecutionContext` has no seam exposing whether that happened -- this executor genuinely cannot
// know, so `false` is the honest (not merely convenient) default. Flagged for T8.
interface WriteToolResult {
  type: "create" | "update";
  filePath: string;
  content: string;
  diff: DiffLine[];
  previousContent?: string;
  userEdited: boolean;
}

const writeExecutor: ToolExecutor = {
  async execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const parsed = parseInput(rawInput);
    if (!parsed) return errorResult("Write requires string fields 'file_path' and 'content'");

    const resolvedPath = resolve(ctx.cwd, parsed.file_path);
    const deps: ReadLadderDeps = { readState: ctx.readState, probeReadAccess: ctx.permissions.probeReadAccess };

    try {
      let previousContent: string | undefined;
      let type: "create" | "update";

      if (existsSync(resolvedPath)) {
        const stat = statSync(resolvedPath);
        if (stat.isDirectory()) return errorResult(`"${resolvedPath}" is a directory, not a file`);

        // Same ladder as Edit for an EXISTING file -- "overwrite" operation (read-ladder.ts folds in
        // the notebook/partial-read override; Write has no substring match, so no
        // hasUnambiguousCurrentMatch is ever passed -- profile omitted: unpopulated-until-P6 seam,
        // see read-ladder.ts's own header).
        const decision = evaluateReadLadder({ filePath: resolvedPath, currentMtimeMs: stat.mtimeMs, operation: "overwrite" }, deps);
        if (!decision.eligible) return errorResult(decision.reason);

        previousContent = readFileSync(resolvedPath, "utf8");
        type = "update";
      } else {
        // New files have no precondition (WS-06 §3.1, verbatim) -- the ladder is never consulted.
        type = "create";
        mkdirSync(dirname(resolvedPath), { recursive: true });
      }

      writeFileSync(resolvedPath, parsed.content, "utf8");
      const newMtimeMs = statSync(resolvedPath).mtimeMs;
      // Write always ends up knowing the COMPLETE new content, regardless of how much of the
      // previous content (if any) was ever read -- "full", never "carryForward".
      recordPostOperationRead(deps, resolvedPath, "full", newMtimeMs);

      const result: WriteToolResult = {
        type,
        filePath: resolvedPath,
        content: parsed.content,
        diff: computeLineDiff(previousContent ?? "", parsed.content),
        ...(previousContent !== undefined ? { previousContent } : {}),
        userEdited: false,
      };
      return { output: JSON.stringify(result) };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

replaceExecutor("Write", writeExecutor);
