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
import type { ContentBlock, Provider, ProviderMessage, ProviderRequest } from "../engine.ts";

// WS-23 (midconv, fix round 1): the instruction is the request's FINAL USER TURN (no prefill: see
// `summaryRequestMessages`), sent once, so it reads the conversation "above" -- it used to be the system
// prompt, pointing "below", and then went out twice.
export const WINTER_SUMMARY_INSTRUCTION =
  "You are compacting a conversation so that it can continue with less context. " +
  "Summarize the conversation above as clear declarative statements of what is true and what was decided -- " +
  "not as a paraphrase of the most recent message and not as an acknowledgement. " +
  "Preserve every specific verbatim: numbers, names, file paths, identifiers, exact values, and any decision that was made or reversed. " +
  "Record work still outstanding as well as work completed. " +
  "Be concise but complete; never drop a fact to save words. " +
  "Output the summary text and nothing else.";

/**
 * WS-23: the same instruction for the PREFIX-REUSING summary, where it rides as the last user message
 * after the session's own conversation (so "above", not "below") and the session's tools are still
 * declared -- declared because removing them would change the cached prefix, which is the whole point.
 */
export const WINTER_PREFIX_SUMMARY_INSTRUCTION =
  "The conversation above is being compacted so that it can continue with less context. " +
  "Do not call any tools: reply with the summary text only. " +
  "Summarize the conversation above as clear declarative statements of what is true and what was decided -- " +
  "not as a paraphrase of the most recent message and not as an acknowledgement. " +
  "Preserve every specific verbatim: numbers, names, file paths, identifiers, exact values, and any decision that was made or reversed. " +
  "Record work still outstanding as well as work completed. " +
  "Be concise but complete; never drop a fact to save words. " +
  "Output the summary text and nothing else.";

/**
 * WS-23: is this provider request the summariser's, in either shape -- the redacted one (Winter's
 * instruction as `system`) or the prefix-reusing one (the instruction as the final user message)?
 * For a scripted double that must answer the summariser differently from the conversation; nothing in
 * production branches on it.
 */
export function isCompactionSummaryRequest(req: Pick<ProviderRequest, "system" | "messages">): boolean {
  if (req.system?.includes("compacting a conversation") === true) return true;
  const last = req.messages.at(-1);
  return last?.role === "user" && typeof last.content === "string" && (last.content.startsWith(WINTER_PREFIX_SUMMARY_INSTRUCTION) || last.content.startsWith(WINTER_SUMMARY_INSTRUCTION));
}

/** WS-23: appended when the conversation already opens with a summary this compaction carries forward VERBATIM. */
export const CARRIED_SUMMARY_NOTE = "The conversation above begins with an earlier summary, which is kept verbatim; summarize only what happened after it.";

/**
 * WS-23: the prefix-reusing request shows the model the WHOLE conversation, including the exchanges the
 * compaction keeps verbatim after the summary -- the redacted request only ever showed it the part
 * being replaced. This sentence scopes the summary back to that part, so a compaction does not
 * restate what stays in context anyway. It rides the appended instruction, so it costs the cache
 * nothing.
 */
export function retainedExchangesNote(pairs: number): string {
  return `The most recent ${pairs} user/assistant exchange${pairs === 1 ? "" : "s"} will be kept verbatim after your summary; summarize what precedes ${pairs === 1 ? "it" : "them"}, and include from ${pairs === 1 ? "it" : "them"} only what is needed to understand the earlier context.`;
}

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

/**
 * WS-23 (midconv, live gate on claude-opus-5-5): the redacted request's messages, ENDING WITH A USER
 * TURN. The summarised window often ends on an assistant reply, and a request that ends there is an
 * assistant PREFILL, which newer models refuse outright ("This model does not support assistant message
 * prefill. The conversation must end with a user message.", HTTP 400) -- the fallback summary, the one
 * that exists for when the prefix request cannot run, then failed too. So the instruction is the final
 * user turn: the window as it was, then the ask (and nowhere else -- fix round 1). A window that already ends on a user message
 * gets the same trailing turn (the adapters merge adjacent user messages), so the shape is one rule.
 * The prefix-reusing request (`summarizeOverPrefix`) already ends with its instruction as a user turn.
 */
export function summaryRequestMessages(messages: readonly ProviderMessage[], instruction: string): ProviderMessage[] {
  // And never START on an assistant turn either (claude 2.1.282's prompt-too-long retry prepends a user
  // marker for the same reason): a window cut after an earlier summary can open on a reply.
  const lead: ProviderMessage[] = messages[0]?.role === "assistant" ? [{ role: "user", content: SUMMARY_WINDOW_OPENS_MID_CONVERSATION }] : [];
  return [...lead, ...messages, { role: "user", content: instruction }];
}

/** WS-23 (midconv): the user marker in front of a summarised window that opens on an assistant reply. */
export const SUMMARY_WINDOW_OPENS_MID_CONVERSATION = "[The conversation continues from an earlier point.]";

export class CompactionSummarizerError extends Error {}

/**
 * One generation on the session provider. Its usage is deliberately NOT recorded into the
 * accountant: the accountant reports the LAST TURN's window occupancy, and a summarizer call is not
 * a turn of the conversation -- recording it would leave the trigger reading a number that describes
 * the compaction rather than the context it was meant to shrink.
 */
export async function summarize(provider: Provider, messages: readonly ProviderMessage[], instruction: string): Promise<string> {
  // The instruction goes out ONCE, as the final user turn (fix round 1): no system prompt as well.
  const turn = await provider.generate({ messages: summaryRequestMessages(messages, instruction) });
  if (turn.kind !== "text") {
    throw new CompactionSummarizerError(`the summarizer provider answered with a ${turn.kind} turn instead of summary text`);
  }
  const text = turn.text.trim();
  if (text.length === 0) throw new CompactionSummarizerError("the summarizer provider returned an empty summary");
  return text;
}

/**
 * WS-23: one generation that REUSES the session's own request -- its system blocks, tools, model,
 * reasoning settings and every message the main loop already sent, byte for byte -- with the
 * instruction appended as the final user message, the way a byte-exact fork reuses its parent's
 * prefix. The largest request of a session then reads its prefix from the prompt cache instead of
 * paying for all of it again (the old shape sent `{messages, system}` with no cache blocks at all).
 *
 * Returns `undefined` when the model answered with a tool call despite the instruction: the session's
 * tools are declared (dropping them, or forcing `tool_choice: none`, would change the cached prefix,
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching), so the
 * caller falls back to the redacted, tool-less summary on the same provider and model rather than
 * running a tool the summariser was never meant to run.
 */
export async function summarizeOverPrefix(provider: Provider, prefixRequest: ProviderRequest, instruction: string): Promise<string | undefined> {
  const { sink: _sink, ...request } = prefixRequest;
  const turn = await provider.generate({ ...request, messages: [...request.messages, { role: "user", content: instruction }] });
  if (turn.kind !== "text") return undefined;
  const text = turn.text.trim();
  if (text.length === 0) throw new CompactionSummarizerError("the summarizer provider returned an empty summary");
  return text;
}
