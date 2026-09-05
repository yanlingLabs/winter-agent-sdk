// Phase 5 Task 7 (Lane K, R5-4): the SUMMARIZER -- Winter's own instruction, run on the SESSION's
// own provider (never a second, separately-configured model), over a REDACTED rendering of the
// messages the boundary is about to replace.
//
// The instruction below is WINTER'S OWN AUTHORED TEXT. R5-4 names Norma's shipped compactor as the
// vehicle and its SEMANTICS are ported -- declarative statements of what is true rather than a
// paraphrase of the last message, specifics preserved verbatim, summary text only -- but no vendor
// prompt is quoted, here or anywhere.
//
// REDACTION IS A POSITIVE REBUILD, NOT A DENYLIST. `ProviderMessage` carries no
// `encrypted_content`/reasoning-item field at this phase, so there is nothing to strip today; that
// is precisely why the rule is written as "copy only the shapes this file knows" rather than "delete
// the opaque ones". A summary is model-readable text and is persisted as such (the session JSONL is
// the only sink for opaque provider state -- a Global Constraint), so the first provider phase that
// adds an opaque field must NOT have to remember to come back here.
import type { ContentBlock, Provider, ProviderMessage } from "../engine.ts";

export const WINTER_SUMMARY_INSTRUCTION =
  "You are compacting a conversation so that it can continue with less context. " +
  "Summarize the messages below as clear declarative statements of what is true and what was decided -- " +
  "not as a paraphrase of the most recent message and not as an acknowledgement. " +
  "Preserve every specific verbatim: numbers, names, file paths, identifiers, exact values, and any decision that was made or reversed. " +
  "Record work still outstanding as well as work completed. " +
  "Be concise but complete; never drop a fact to save words. " +
  "Output the summary text and nothing else.";

/** How much of a tool call's own input is rendered into the summarizer's view of the transcript. */
export const DEFAULT_TOOL_INPUT_PREVIEW_CHARS = 500;

/**
 * Winter's instruction, plus the caller's own on a manual `/compact <instructions>` run (and any
 * context a PreCompact hook forwarded -- the engine has already folded that into the same field).
 * ATTRIBUTED rather than spliced: the caller's words are the caller's, and a model that mis-follows
 * them must be readable as having done so.
 */
export function buildSummaryInstruction(customInstructions: string | null, instruction: string = WINTER_SUMMARY_INSTRUCTION): string {
  const extra = customInstructions?.trim() ?? "";
  if (extra.length === 0) return instruction;
  return `${instruction}\n\nThe operator asked for this compaction with the following additional instructions. Follow them in addition to the above:\n${extra}`;
}

function renderBlock(block: ContentBlock, toolInputPreviewChars: number): string | undefined {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_use": {
      // The tool's NAME plus a bounded rendering of its own input. The name alone loses the thing a
      // summary most needs (which file was written, which command ran); the whole input can be
      // arbitrarily large, so it is capped rather than trusted.
      let rendered: string;
      try {
        rendered = JSON.stringify(block.input) ?? "";
      } catch {
        rendered = "";
      }
      const clipped = rendered.length > toolInputPreviewChars ? `${rendered.slice(0, toolInputPreviewChars)}...` : rendered;
      return clipped.length > 0 ? `[called ${block.name} with ${clipped}]` : `[called ${block.name}]`;
    }
    case "tool_result":
      // Phase 6 Task 3 (R6-3): `tool_result.content` widened to `string | ContentBlock[]`. A
      // blocks-valued result recurses through the SAME positive rebuild, so an image block inside a
      // tool result is dropped by exactly the rule that drops a top-level one -- rather than being
      // stringified into the summariser's input by an `String(...)` that no longer applies.
      return typeof block.content === "string"
        ? block.content
        : block.content
            .map((inner) => renderBlock(inner, toolInputPreviewChars))
            .filter((t): t is string => typeof t === "string" && t.length > 0)
            .join("\n");
    case "tool_reference":
      return `[tools now callable: ${block.tool_names.join(", ")}]`;
    default:
      // Any block shape this file does not know -- an opaque reasoning item, a provider-specific
      // envelope, anything a later phase introduces -- is DROPPED rather than guessed at.
      //
      // Phase 6 Task 3 (R6-3): `thinking`, `redacted_thinking` and `image` now reach this arm, and
      // dropping them is the CORRECT behaviour, not an oversight: a summary is model-readable text
      // persisted as such, and a thinking block's `signature` / a redacted block's `data` are opaque
      // provider state whose only sink is the sidecar (Global Constraints). This file's own header
      // predicted exactly this moment -- "the first provider phase that adds an opaque field must NOT
      // have to remember to come back here" -- and the positive rebuild is why it did not have to.
      // seam-contracts-p6.test.ts asserts the negative rather than trusting this comment.
      return undefined;
  }
}

/**
 * The messages as the summarizer is allowed to see them: `{ role, content }` only, roles narrowed to
 * user/assistant (the engine's own `tool` role has no provider meaning outside its history), content
 * flattened to text built from known block types alone. Every other key on the original object --
 * including any a future provider adds -- is left behind by construction.
 */
export function redactForSummary(messages: readonly ProviderMessage[], opts: { toolInputPreviewChars?: number } = {}): ProviderMessage[] {
  const cap = opts.toolInputPreviewChars ?? DEFAULT_TOOL_INPUT_PREVIEW_CHARS;
  const out: ProviderMessage[] = [];
  for (const message of messages) {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((block) => renderBlock(block, cap))
            .filter((t): t is string => typeof t === "string" && t.length > 0)
            .join("\n");
    if (text.trim().length === 0) continue;
    out.push({ role: message.role === "assistant" ? "assistant" : "user", content: text });
  }
  return out;
}

export class CompactionSummarizerError extends Error {}

/**
 * One generation on the session provider. Its usage is deliberately NOT recorded into the
 * accountant: the accountant reports the LAST TURN's window occupancy, and a summarizer call is not
 * a turn of the conversation -- recording it would leave the trigger reading a number that describes
 * the compaction rather than the context it was meant to shrink.
 */
export async function summarize(provider: Provider, messages: readonly ProviderMessage[], system: string): Promise<string> {
  const turn = await provider.generate({ messages: [...messages], system });
  if (turn.kind !== "text") {
    throw new CompactionSummarizerError(`the summarizer provider answered with a ${turn.kind} turn instead of summary text`);
  }
  const text = turn.text.trim();
  if (text.length === 0) throw new CompactionSummarizerError("the summarizer provider returned an empty summary");
  return text;
}
