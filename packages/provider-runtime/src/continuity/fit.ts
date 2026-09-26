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
// THE BUDGET is the target's window times the session's compaction threshold: exactly the headroom the
// auto-compaction trigger keeps (review r1, I-1). Images and documents are charged per item, never by
// their encoded bytes (I-2), and non-ASCII text at about a token per character (M-6).

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

/** Tokens for `chars` characters of ASCII text, by the estimate above. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil((chars / ESTIMATE_CHARS_PER_TOKEN) * ESTIMATE_MARGIN);
}

/**
 * Review r1, M-6: tokens for a TEXT. ASCII at ~3.5 characters per token; every non-ASCII code point at
 * about ONE token -- CJK and most other non-Latin scripts tokenize at roughly a token per character, so
 * counting them at 3.5 underestimated such a conversation about threefold. Plus the same 10% margin.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii++;
    else if (code >= 0xdc00 && code <= 0xdfff) continue; // the low half of a surrogate pair: one code point, already counted
    else other++;
  }
  return Math.ceil((ascii / ESTIMATE_CHARS_PER_TOKEN + other) * ESTIMATE_MARGIN);
}

/**
 * Review r1, I-2: what an IMAGE or a DOCUMENT costs, per item -- never its bytes. Vision models charge
 * by the picture, not by its encoding: Anthropic's own rule is about (width x height) / 750 tokens and at
 * most ~1,600 for an image at its maximum size (https://platform.claude.com/docs/en/build-with-claude/vision),
 * so 1,600 is the conservative per-image charge; a PDF page is billed as its text plus the page as an
 * image, ~1,500-3,000 tokens (https://platform.claude.com/docs/en/build-with-claude/pdf-support), 1,500
 * per page here. A base64 screenshot of 1 MB is ~1.4 million characters and used to read as ~430k tokens.
 */
export const IMAGE_TOKENS = 1_600;
export const DOCUMENT_PAGE_TOKENS = 1_500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A PDF's page count, from its own `/Type /Page` objects (not `/Pages`), or `undefined` when it is not readable as one. */
function pdfPageCount(base64: string): number | undefined {
  let latin: string;
  try {
    latin = Buffer.from(base64, "base64").toString("latin1");
  } catch {
    return undefined;
  }
  const pages = latin.match(/\/Type\s*\/Page(?![s\w])/g)?.length ?? 0;
  return pages > 0 ? pages : undefined;
}

/** The fixed charge for a media block (image or document, any carrier), or `undefined` when `value` is not one. */
function mediaTokens(value: Record<string, unknown>): number | undefined {
  const type = value["type"];
  if (type === "image" || type === "input_image" || type === "image_url") return IMAGE_TOKENS;
  if (type !== "document" && type !== "input_file") return undefined;
  const declared = [value["pages"], value["page_count"], value["pageCount"]].find((n): n is number => typeof n === "number" && n > 0);
  if (declared !== undefined) return declared * DOCUMENT_PAGE_TOKENS;
  const source = value["source"];
  const data = isRecord(source) && typeof source["data"] === "string" ? source["data"] : typeof value["file_data"] === "string" ? value["file_data"] : undefined;
  const pages = data !== undefined ? pdfPageCount(data.replace(/^data:[^,]*,/, "")) : undefined;
  return (pages ?? 1) * DOCUMENT_PAGE_TOKENS;
}

/**
 * The token estimate for any request part -- a message's content, a tool list, native state: its text
 * (as serialized) by `estimateTextTokens`, every image or document at its fixed per-item cost instead.
 */
export function estimateValueTokens(value: unknown): number {
  let media = 0;
  const stripped = JSON.stringify(value, function (this: unknown, _key, v: unknown) {
    if (isRecord(v)) {
      const cost = mediaTokens(v);
      if (cost !== undefined) {
        media += cost;
        return { type: v["type"] };
      }
    }
    return v;
  });
  return (stripped === undefined ? 0 : estimateTextTokens(stripped)) + media;
}

/**
 * What a request may occupy on a model: `window x threshold` -- the SAME rule as the auto-compaction
 * trigger (`contextTokens() >= threshold * limit()`), so a switch never calls "too big" a conversation
 * the target itself would carry on with (review r1, I-1). The first draft also subtracted the row's
 * maximum output: 48 catalog rows declare a maximum output equal to their window, which left them a
 * budget of zero, so every switch into one "did not fit".
 */
export function fitBudgetTokens(window: number, threshold: number): number {
  return Math.max(0, Math.floor(window * threshold));
}

/** The fit verdict both the engine and the pre-flight review report. */
export interface FitVerdict {
  fits: boolean;
  /** The estimate, in tokens, of the request the target would receive. */
  estimatedTokens: number;
  /** The target's context window, in tokens. */
  window: number;
}

export function fitVerdict(estimatedTokens: number, window: number, threshold: number): FitVerdict {
  return { fits: estimatedTokens <= fitBudgetTokens(window, threshold), estimatedTokens, window };
}
