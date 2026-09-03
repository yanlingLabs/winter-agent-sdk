// WS-06 §3.1 "NotebookEdit" -- implement-now, pinned schema `{notebook_path, cell_id?, new_source,
// cell_type?, edit_mode?}`. `edit_mode` defaults to "replace"; "insert" places a cell after `cell_id`
// (or at the start when omitted) and REQUIRES `cell_type`; "delete" removes the targeted cell.
// Operates on the .ipynb JSON structurally (nbformat v4). Subject to the shared read-before-edit
// ladder (read-ladder.ts, "edit" operation) -- notebooks have no substring-match concept, so
// `hasUnambiguousCurrentMatch` is never passed, which structurally closes the drift-rescue rung
// (rung 3) for every notebook edit; a drifted notebook always needs a fresh Read, exactly like Write.
//
// KNOWN, FLAGGED LIMITATION (for T8): cells are located by `id` (nbformat >= 4.5). A notebook
// authored under an older nbformat with no per-cell `id` field can never be targeted by `cell_id` --
// this executor does not invent a positional fallback.
//
// Read-deny enforcement note (CLOSED, Task 8, RULING P3-E): the standing P2 evaluator's
// `extractCandidateWritePaths`/`recognizeEditOperation` (permissions/{evaluator,edit-recognition}.ts)
// now recognize `notebook_path` (via `fileRulePathField`) alongside Edit/Write/Bash, and `NotebookEdit`
// joined `FILE_RULE_TOOLS` (grammar.ts) -- a `Read(...)`/`NotebookEdit(...)` deny rule now blocks a
// NotebookEdit on the same path exactly like it blocks Edit/Write (report §40's own "an Edit denial
// is still needed for every editing surface such as NotebookEdit" is now satisfied). This executor
// still does not implement any of that itself -- read-deny composition remains the standing
// evaluator's job, never re-implemented in a tool; this comment is updated in place because it had
// documented the gap as open.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import "../descriptors/index.ts"; // side-effect only: guarantees the "NotebookEdit" stub exists first.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { evaluateReadLadder, recordPostOperationRead, type ReadLadderDeps } from "./read-ladder.ts";

type CellType = "code" | "markdown";
type EditMode = "replace" | "insert" | "delete";

interface NotebookEditInput {
  notebook_path: string;
  cell_id?: string;
  new_source: string;
  cell_type?: CellType;
  edit_mode: EditMode;
}

function isCellType(v: unknown): v is CellType {
  return v === "code" || v === "markdown";
}
function isEditMode(v: unknown): v is EditMode {
  return v === "replace" || v === "insert" || v === "delete";
}

function parseInput(input: unknown): NotebookEditInput | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const notebookPath = rec["notebook_path"];
  const newSource = rec["new_source"];
  const cellIdRaw = rec["cell_id"];
  const cellTypeRaw = rec["cell_type"];
  const editModeRaw = rec["edit_mode"];
  if (typeof notebookPath !== "string" || typeof newSource !== "string") return undefined;
  if (cellIdRaw !== undefined && typeof cellIdRaw !== "string") return undefined;
  if (cellTypeRaw !== undefined && !isCellType(cellTypeRaw)) return undefined;
  if (editModeRaw !== undefined && !isEditMode(editModeRaw)) return undefined;
  return {
    notebook_path: notebookPath,
    new_source: newSource,
    ...(cellIdRaw !== undefined ? { cell_id: cellIdRaw } : {}),
    ...(cellTypeRaw !== undefined ? { cell_type: cellTypeRaw } : {}),
    edit_mode: editModeRaw ?? "replace",
  };
}

function errorResult(message: string): ToolResultPayload {
  return { output: `Error: ${message}`, isError: true };
}

// nbformat's `source` is a string OR an array-of-lines (each element already carrying its own
// trailing newline, per the nbformat convention) -- normalized to a single string for reporting.
function sourceToString(source: unknown): string {
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return source.map((line) => (typeof line === "string" ? line : "")).join("");
  return "";
}

function extractLanguage(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const rec = metadata as Record<string, unknown>;
  const kernelspec = rec["kernelspec"];
  if (typeof kernelspec === "object" && kernelspec !== null) {
    const lang = (kernelspec as Record<string, unknown>)["language"];
    if (typeof lang === "string") return lang;
  }
  const languageInfo = rec["language_info"];
  if (typeof languageInfo === "object" && languageInfo !== null) {
    const name = (languageInfo as Record<string, unknown>)["name"];
    if (typeof name === "string") return name;
  }
  return undefined;
}

interface NotebookCell {
  id?: unknown;
  cell_type?: unknown;
  source?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

function findCellIndex(cells: NotebookCell[], cellId: string): number {
  return cells.findIndex((cell) => cell["id"] === cellId);
}

function newCell(cellType: CellType, source: string): NotebookCell {
  return {
    id: randomUUID(),
    cell_type: cellType,
    metadata: {},
    source,
    ...(cellType === "code" ? { execution_count: null, outputs: [] } : {}),
  };
}

// Minimal, honest result shape (report §40.20: "old/new source where relevant, cell identity/type,
// language, mode, notebook path"). The full original/updated NOTEBOOK data the report also mentions
// is deliberately OMITTED -- an entire notebook's JSON on every single-cell edit is neither minimal
// nor, for any reasonably sized notebook, a bounded result; flagged for T8.
interface NotebookEditToolResult {
  notebookPath: string;
  editMode: EditMode;
  cellId: string;
  cellType?: CellType;
  language?: string;
  oldSource?: string;
  newSource?: string;
}

const notebookEditExecutor: ToolExecutor = {
  async execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const parsed = parseInput(rawInput);
    if (!parsed) {
      return errorResult(
        "NotebookEdit requires string fields 'notebook_path' and 'new_source' (optional 'cell_id' string, 'cell_type' of 'code'|'markdown', 'edit_mode' of 'replace'|'insert'|'delete')",
      );
    }
    if (parsed.edit_mode === "insert" && parsed.cell_type === undefined) {
      return errorResult("edit_mode:'insert' requires 'cell_type'");
    }
    if ((parsed.edit_mode === "replace" || parsed.edit_mode === "delete") && parsed.cell_id === undefined) {
      return errorResult(`edit_mode:'${parsed.edit_mode}' requires 'cell_id'`);
    }

    const resolvedPath = resolve(ctx.cwd, parsed.notebook_path);

    try {
      if (!existsSync(resolvedPath)) return errorResult(`"${resolvedPath}" does not exist -- NotebookEdit can only modify an existing notebook`);
      const stat = statSync(resolvedPath);
      if (stat.isDirectory()) return errorResult(`"${resolvedPath}" is a directory, not a file`);

      const deps: ReadLadderDeps = { readState: ctx.readState, probeReadAccess: ctx.permissions.probeReadAccess };
      // No hasUnambiguousCurrentMatch -- notebooks are matched by cell id, not content -- so a
      // drifted notebook (rung 3) is never rescuable here, by construction (see module header).
      const decision = evaluateReadLadder({ filePath: resolvedPath, currentMtimeMs: stat.mtimeMs, operation: "edit" }, deps);
      if (!decision.eligible) return errorResult(decision.reason);

      let notebook: Record<string, unknown>;
      try {
        notebook = JSON.parse(readFileSync(resolvedPath, "utf8")) as Record<string, unknown>;
      } catch {
        return errorResult(`"${resolvedPath}" is not valid JSON`);
      }
      if (!Array.isArray(notebook["cells"])) return errorResult(`"${resolvedPath}" is not a valid notebook (missing a "cells" array)`);
      const cells = notebook["cells"] as NotebookCell[];
      const language = extractLanguage(notebook["metadata"]);

      let resultCellId: string;
      let resultCellType: CellType | undefined;
      let oldSource: string | undefined;
      let newSourceOut: string | undefined;

      if (parsed.edit_mode === "replace") {
        const idx = findCellIndex(cells, parsed.cell_id!);
        if (idx === -1) return errorResult(`no cell with id "${parsed.cell_id}" in "${resolvedPath}"`);
        const target = cells[idx]!;
        oldSource = sourceToString(target["source"]);
        target["source"] = parsed.new_source;
        if (parsed.cell_type !== undefined && parsed.cell_type !== target["cell_type"]) {
          target["cell_type"] = parsed.cell_type;
          // Keep the cell structurally valid nbformat across a type change: code-only fields must
          // exist on a code cell and must not linger on a markdown one.
          if (parsed.cell_type === "code") {
            target["execution_count"] = null;
            target["outputs"] = [];
          } else {
            delete target["execution_count"];
            delete target["outputs"];
          }
        }
        resultCellId = parsed.cell_id!;
        resultCellType = isCellType(target["cell_type"]) ? target["cell_type"] : undefined;
        newSourceOut = parsed.new_source;
      } else if (parsed.edit_mode === "delete") {
        const idx = findCellIndex(cells, parsed.cell_id!);
        if (idx === -1) return errorResult(`no cell with id "${parsed.cell_id}" in "${resolvedPath}"`);
        const removed = cells[idx]!;
        oldSource = sourceToString(removed["source"]);
        cells.splice(idx, 1);
        resultCellId = parsed.cell_id!;
        resultCellType = isCellType(removed["cell_type"]) ? removed["cell_type"] : undefined;
      } else {
        // insert
        let insertAt = 0;
        if (parsed.cell_id !== undefined) {
          const idx = findCellIndex(cells, parsed.cell_id);
          if (idx === -1) return errorResult(`no cell with id "${parsed.cell_id}" in "${resolvedPath}" to insert after`);
          insertAt = idx + 1;
        }
        const created = newCell(parsed.cell_type!, parsed.new_source);
        cells.splice(insertAt, 0, created);
        resultCellId = created["id"] as string;
        resultCellType = parsed.cell_type;
        newSourceOut = parsed.new_source;
      }

      // nbformat/nbformat_minor/top-level metadata are carried verbatim -- only `cells` was mutated,
      // in place, above.
      writeFileSync(resolvedPath, JSON.stringify(notebook, null, 1), "utf8");
      const newMtimeMs = statSync(resolvedPath).mtimeMs;
      recordPostOperationRead(deps, resolvedPath, "carryForward", newMtimeMs);

      const result: NotebookEditToolResult = {
        notebookPath: resolvedPath,
        editMode: parsed.edit_mode,
        cellId: resultCellId,
        ...(resultCellType !== undefined ? { cellType: resultCellType } : {}),
        ...(language !== undefined ? { language } : {}),
        ...(oldSource !== undefined ? { oldSource } : {}),
        ...(newSourceOut !== undefined ? { newSource: newSourceOut } : {}),
      };
      return { output: JSON.stringify(result) };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
};

replaceExecutor("NotebookEdit", notebookEditExecutor);
