// THE DIGEST PROMPT -- the exact request winter's WebFetch makes of its digest model after a fetch:
// one user message carrying the page (capped at 100,000 characters) and the caller's question, then
// the guidelines. There is no system prompt; `system` is `undefined` so the shape can be spread into
// a model call as is. The caller makes the model call.
import { WEB_FETCH_HTML_TRUNCATION_NOTICE } from "./html.ts";

/** The most page text a digest request carries. Longer text is cut and the truncation notice appended. */
export const WEB_FETCH_DIGEST_CONTENT_CAP = 100_000;

/** The guidelines for an ordinary page. */
export const WEB_FETCH_STRICT_GUIDELINES = `Provide a concise response based only on the content above. In your response:
 - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.`;

/** The guidelines winter uses for its preapproved documentation hosts. */
export const WEB_FETCH_PERMISSIVE_GUIDELINES = "Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.";

export interface WebFetchDigestInput {
  /** The page text (markdown for HTML), e.g. `fetchWebPage`'s `text`. */
  text: string;
  /** What the caller wants to know about the page. */
  prompt: string;
  /** Accepted for symmetry with a fetch result; the prompt does not include it (winter's does not either). */
  url?: string;
  /** Default `"strict"`. */
  guidelines?: "strict" | "permissive";
}

export interface WebFetchDigestRequest {
  system: string | undefined;
  messages: [{ role: "user"; content: string }];
}

/** The page text as a digest request carries it: capped, with the notice appended when cut. */
export function cappedForDigest(text: string): string {
  return text.length > WEB_FETCH_DIGEST_CONTENT_CAP ? text.slice(0, WEB_FETCH_DIGEST_CONTENT_CAP) + WEB_FETCH_HTML_TRUNCATION_NOTICE : text;
}

/** The digest pass's one user message, byte for byte. */
export function webFetchDigestPrompt(text: string, prompt: string, guidelines: "strict" | "permissive" = "strict"): string {
  const rules = guidelines === "permissive" ? WEB_FETCH_PERMISSIVE_GUIDELINES : WEB_FETCH_STRICT_GUIDELINES;
  return `\nWeb page content:\n---\n${cappedForDigest(text)}\n---\n\n${prompt}\n\n${rules}\n`;
}

export function buildWebFetchDigestRequest(input: WebFetchDigestInput): WebFetchDigestRequest {
  return { system: undefined, messages: [{ role: "user", content: webFetchDigestPrompt(input.text, input.prompt, input.guidelines ?? "strict") }] };
}
