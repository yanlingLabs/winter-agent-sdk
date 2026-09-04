// Phase 4 Task 4 (Lane A), WS-09 §7 as AMENDED by RULING P4-K (2026-09-04): the MCP tool-result
// output cap.
//
// *** WHAT CHANGED, and why the previous shape is gone. *** T8's hermetic capture against the pinned
// 0.3.250 runtime showed it never token-truncates an MCP tool result inline: a 390 000-character
// result came back as a ~2.4 KB `<persisted-output>` envelope naming a file the full payload had
// been written to, plus a head/tail excerpt with an elision -- and setting `MAX_MCP_OUTPUT_TOKENS`
// to 100 changed nothing at that size. WS-00 §1 (evidence wins over an unverified spec sentence)
// therefore retires §7's inline truncation marker: an oversized result is PERSISTED and the model is
// handed the envelope. `MAX_MCP_OUTPUT_TOKENS` remains the documented threshold (default 25000,
// parsed once by mcp/env.ts's parseMcpEnvConfig -- this file never reads env itself) with its exact
// boundary still CAPTURE-PENDING: one probe at one size is not a boundary, so nothing here invents a
// second number.
//
// Token counting: no tokenizer dependency exists anywhere in this monorepo (verified before writing
// this file) and adding a real one (e.g. tiktoken) for a single capture-pending threshold is an
// unjustified footprint increase at this phase -- a documented, conservative CHARACTERS-PER-TOKEN
// heuristic stands in until a real accounting exists (mirrors this codebase's own established
// posture for other capture-pending numeric defaults, e.g. mcp/env.ts's "unset" branch). The
// heuristic is intentionally a named, overridable constant (not buried inline) so a future capture
// or a shared token-counting utility can replace it in one place.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A widely-used rough approximation (ordinary English-shaped text averages ~4 characters per
// token across common tokenizers) -- conservative in the sense that it UNDER-counts tokens for
// dense/non-English/code-heavy text less often than it over-counts, so this threshold errs toward
// persisting slightly EARLIER rather than letting an oversized result reach the model whole.
const CHARS_PER_TOKEN_ESTIMATE = 4;

// The excerpt budget on each side of the elision. CAPTURE-PENDING at these exact values: the one
// observed envelope was ~2383 characters total for a 390 000-character payload, which bounds the
// pair but does not pin the split (the observed total also carries the header line and the
// wrapper). Named constants, in one place, for the same reason the threshold is.
const EXCERPT_HEAD_CHARS = 1000;
const EXCERPT_TAIL_CHARS = 1000;

// The subdirectory persisted payloads land in, under the SESSION's own temp root.
export const MCP_PERSISTED_OUTPUT_DIRNAME = "mcp-output";

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export interface McpOutputCapResult {
  text: string;
  truncated: boolean;
  // Present even when NOT truncated -- a caller (e.g. a future telemetry consumer) never has to
  // branch on `truncated` just to learn the estimated size.
  originalTokens: number;
  cappedTokens: number;
  // The absolute path the full payload was written to. Present only on a SUCCESSFUL persist: a
  // truncated result with no `persistedPath` is the write-failed fallback (below), and a caller can
  // tell the two apart without parsing the envelope text.
  persistedPath?: string;
}

// WHERE the payload is written, supplied by the caller per call.
//
// `sessionDir` MUST be the calling session's OWN root -- `ToolExecutionContext.tempDir`, which the
// registry exposes as a lazy getter over this run's memoized `resolveSessionTempPaths()`. It must
// NOT be derived from the process-global background-task root: `configureBackgroundTaskRoot` is a
// module singleton that every in-process CHILD engine re-points at its own temp dir mid-session
// (whole-branch review M3(a)), so a path taken from there can silently belong to a different
// session than the one whose tool just ran. Keyed this way, a nested child's spawn cannot move where
// the parent's MCP output lands.
// `sessionDir` is a FUNCTION, not a string, for one specific reason: the registry exposes
// `ToolExecutionContext.tempDir` as a lazy getter over `resolveSessionTempPaths()`, which creates
// real `/tmp/winter-<uid>/...` directories on first read (D18). An eagerly-evaluated
// `{ sessionDir: ctx.tempDir }` argument would materialize that tree on EVERY MCP tool call,
// including the overwhelming majority that are nowhere near the threshold. Called only on the
// over-threshold branch.
export interface McpPersistTarget {
  sessionDir(): string;
  serverName: string;
  toolName: string;
}

// Unique within a session without a clock dependency in the name's stable part -- the counter alone
// would collide across two runs sharing one resumed session directory, and a timestamp alone can
// collide inside one millisecond.
let persistCounter = 0;
function persistFileName(target: McpPersistTarget): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "unnamed";
  persistCounter += 1;
  return `${safe(target.serverName)}__${safe(target.toolName)}-${Date.now()}-${persistCounter}.txt`;
}

function sizeKb(text: string): string {
  return (Buffer.byteLength(text, "utf8") / 1024).toFixed(1);
}

// Head + `...` elision + tail. A payload short enough that the two windows would overlap is returned
// whole rather than "excerpted" into something LONGER than the original.
function excerpt(text: string): string {
  if (text.length <= EXCERPT_HEAD_CHARS + EXCERPT_TAIL_CHARS) return text;
  return `${text.slice(0, EXCERPT_HEAD_CHARS)}\n\n...\n\n${text.slice(text.length - EXCERPT_TAIL_CHARS)}`;
}

// Pure and deterministic APART from the one filesystem write, which is deliberately synchronous:
// `capMcpOutput`'s single production call site (mcp/lifecycle.ts) is already inside an async tool
// executor whose result the model is waiting on, and an async write would buy nothing but an extra
// await while introducing an interleaving window on a per-call unique path.
export function capMcpOutput(text: string, maxOutputTokens: number, target: McpPersistTarget): McpOutputCapResult {
  // Defensive floor: a caller-supplied non-positive value (mcp/env.ts's own parser already
  // guarantees a positive `maxOutputTokens` from real env parsing, but this function's contract
  // does not itself assume that) is treated as "threshold of one token" rather than producing a
  // negative budget.
  const cap = maxOutputTokens < 1 ? 1 : Math.trunc(maxOutputTokens);
  const originalTokens = estimateTokens(text);
  if (originalTokens <= cap) {
    return { text, truncated: false, originalTokens, cappedTokens: originalTokens };
  }

  const body = excerpt(text);
  let persistedPath: string | undefined;
  try {
    const dir = join(target.sessionDir(), MCP_PERSISTED_OUTPUT_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, persistFileName(target));
    // BYTE-EXACT: the file holds the tool's own result text and nothing else -- no envelope, no
    // header, no trailing newline. The whole point of the envelope is that the model can `Read` the
    // real payload; a decorated file would make the elision unrecoverable.
    writeFileSync(path, text, "utf8");
    persistedPath = path;
  } catch (err) {
    // NEVER throw from here. This runs inside an MCP tool executor, and a throw would surface as
    // engine.ts's whole-ROUND `error_during_execution` (Ruling P1-H) -- the wrong severity for "the
    // spill file could not be written", and a strictly worse outcome for the model than an excerpt.
    // The full payload is deliberately NOT substituted in on this path: the threshold exists because
    // the payload is too large to put in front of the model, and that stays true when the write
    // fails.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      text: `<persisted-output>\nOutput too large (${sizeKb(text)}KB). Full output could NOT be saved to disk: ${reason}\n\n${body}\n</persisted-output>`,
      truncated: true,
      originalTokens,
      cappedTokens: estimateTokens(body),
    };
  }

  return {
    text: `<persisted-output>\nOutput too large (${sizeKb(text)}KB). Full output saved to: ${persistedPath}\n\n${body}\n</persisted-output>`,
    truncated: true,
    originalTokens,
    cappedTokens: estimateTokens(body),
    persistedPath,
  };
}
