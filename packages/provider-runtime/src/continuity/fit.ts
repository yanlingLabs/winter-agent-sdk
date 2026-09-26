// WS-23 (reasoning-state, decision 5): does a conversation FIT the model it is switching to?
//
// A cross-family switch replays the actual transcript -- nothing is summarized or forked -- so the one
// thing that can make it fail is size: a history built on a 1M-token Claude can be far past a 200k-token
// target. The engine checks at the switch (and the daemon's pre-flight review reports it on the
// confirmation card); when the history does not fit, the SOURCE model compacts it before the target's
// first request.
//
// AN ESTIMATE, deliberately, and a conservative one: ~3.5 characters per token (the ratio English prose
// and code tokenize to on current BPE vocabularies) plus 10% margin, over the request as it will be sent.
// A real count would need a tokenizer per vendor, or a count_tokens round trip per switch; the estimate
// errs on the side of compacting slightly early, and the engine's reactive overflow recovery stays behind
// it for the case it misjudges.
//
// THE BUDGET is the target's window times the session's compaction threshold, less the target's maximum
// output: the same headroom the auto-compaction trigger keeps, and room for the reply.

/** Characters per token the estimate assumes. */
export const ESTIMATE_CHARS_PER_TOKEN = 3.5;
/** The margin the estimate adds on top. */
export const ESTIMATE_MARGIN = 1.1;

/**
 * The cross-family reasoning decoration caps (user decision 2), declared here because the fit estimate
 * must account for them: the renderer may add up to `DECORATION_CHAR_BUDGET` characters of
 * `<recovered_reasoning>` to a request whose history holds another model's turns. 4,000 characters is
 * about 1,100 tokens at the ratio above -- room for a Claude turn's summarized thinking or a Responses
 * summary in full (typically a few hundred to two thousand characters), and a hard stop for an open
 * model's raw trace, which can run to tens of thousands. 24,000 in total is about 6,900 tokens: under 4%
 * of a 200k window and under 6% of a 128k one, so even a history made mostly of another family's turns
 * leaves the target its window.
 */
export const MAX_DECORATION_CHARS = 4_000;
export const DECORATION_CHAR_BUDGET = 24_000;

/** Tokens for `chars` characters, by the estimate above. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil((chars / ESTIMATE_CHARS_PER_TOKEN) * ESTIMATE_MARGIN);
}

/** What a request may occupy on a model: `window × threshold − maxOutput`, never below zero. */
export function fitBudgetTokens(window: number, threshold: number, maxOutputTokens: number | undefined): number {
  return Math.max(0, Math.floor(window * threshold) - (maxOutputTokens ?? 0));
}

/** The fit verdict both the engine and the pre-flight review report. */
export interface FitVerdict {
  fits: boolean;
  /** The estimate, in tokens, of the request the target would receive. */
  estimatedTokens: number;
  /** The target's context window, in tokens. */
  window: number;
}

export function fitVerdict(estimatedTokens: number, window: number, threshold: number, maxOutputTokens: number | undefined): FitVerdict {
  return { fits: estimatedTokens <= fitBudgetTokens(window, threshold, maxOutputTokens), estimatedTokens, window };
}
