// Phase 4 Task 4 (Lane A), WS-09 §7: the MCP tool-result output cap. `MAX_MCP_OUTPUT_TOKENS`
// (default 25000, parsed once by mcp/env.ts's parseMcpEnvConfig -- this file never reads env
// itself) bounds how much of an MCP tool's result text reaches the model. WS-09 §7's own Open
// Question 1 is explicit that the pinned report carries NO entry for this control at all -- the
// default and the exact truncation behavior are sourced from public env-var documentation only,
// and are CAPTURE-PENDING (R4-8 class) until a drift-gate capture pins the real 0.3.250 runtime
// shape. Per WS-09 §7's own resolution ("until that capture lands, Winter marks the truncation
// explicitly in the result the model sees"), this file's obligation is narrower than reproducing
// an unverified byte-exact official shape: cap deterministically, NEVER silently, and leave the
// marker's own exact wording a one-line fixture-alignment away from a future capture.
//
// Token counting: no tokenizer dependency exists anywhere in this monorepo (verified before
// writing this file) and adding a real one (e.g. tiktoken) for a single capture-pending cap is an
// unjustified footprint increase at this phase -- a documented, conservative CHARACTERS-PER-TOKEN
// heuristic stands in until a real accounting exists (mirrors this codebase's own established
// posture for other capture-pending numeric defaults, e.g. mcp/env.ts's "unset" branch). The
// heuristic is intentionally a named, overridable constant (not buried inline) so a future capture
// or a shared token-counting utility can replace it in one place.

// A widely-used rough approximation (ordinary English-shaped text averages ~4 characters per
// token across common tokenizers) -- conservative in the sense that it UNDER-counts tokens for
// dense/non-English/code-heavy text less often than it over-counts, so this cap errs toward
// capping slightly EARLIER rather than letting an oversized result slip through uncapped.
const CHARS_PER_TOKEN_ESTIMATE = 4;

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
}

function truncationMarker(maxTokens: number, originalTokens: number): string {
  // Explicit and model-legible (WS-09 §7: "so the model can re-query narrower instead of trusting
  // a silently clipped payload") -- names the cap AND the original size so the model can judge how
  // much was lost, never just a bare "..." a model could mistake for the tool's own output.
  return `\n\n[winter: MCP tool output truncated at ${maxTokens} tokens (original ~${originalTokens} tokens). Re-query with a narrower request to see more.]`;
}

// Pure, deterministic, and injectable-estimator-free BY DESIGN: every caller in this phase wants
// the identical heuristic (no test needs a different one), so `estimateTokens` is called directly
// rather than threaded through as a parameter -- simpler than the analogous injectable-clock/
// injectable-cache seams elsewhere in this lane, because nothing here needs to vary per test.
export function capMcpOutput(text: string, maxOutputTokens: number): McpOutputCapResult {
  // Defensive floor: a caller-supplied non-positive value (mcp/env.ts's own parser already
  // guarantees a positive `maxOutputTokens` from real env parsing, but this function's contract
  // does not itself assume that) is treated as "cap to nothing" rather than producing a negative
  // slice index or an empty-but-unmarked result -- the marker still explains why.
  const cap = maxOutputTokens < 1 ? 1 : Math.trunc(maxOutputTokens);
  const originalTokens = estimateTokens(text);
  if (originalTokens <= cap) {
    return { text, truncated: false, originalTokens, cappedTokens: originalTokens };
  }
  const maxChars = cap * CHARS_PER_TOKEN_ESTIMATE;
  const clipped = text.slice(0, maxChars);
  const marker = truncationMarker(cap, originalTokens);
  return { text: clipped + marker, truncated: true, originalTokens, cappedTokens: cap };
}
