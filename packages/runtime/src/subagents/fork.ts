// WS-10 §3.5: fork semantics -- "a fork inherits EVERYTHING from the main session at spawn:
// conversation, system prompt, exact tool pool, model, permissions, prompt cache, thinking, and
// effective effort... never as a fresh AgentDefinition... ignores a model override by contract."
//
// Most of a fork's OWN inheritance is already implemented, correctly, by engine.ts's own
// `buildChildInheritance`/`resolveChildModel` (frozen, unreachable from this lane):
// `resolveChildModel` returns `config.model` unconditionally when `req.fork === true` ("fork ignores
// a model override by contract"), and `buildChildInheritance` spreads `messages: [...messages]` (a
// COPY, "never mutate the parent's own live turn history") only when `req.fork === true`, and
// resolves `tools` to the session's own CURRENT advertised pool for exactly this case (WS-10 §3.5's
// own "exact tool pool"). This file's own job is the CHILD side of that contract: consuming
// `ChildInheritance.messages` correctly when child-engine.ts seeds a new runEngine() invocation's
// own `initialMessages`.
//
// DISCLOSED SCOPE GAP: `AgentInput` (T1's own pinned 9-field schema, derived-shapes-p4.md item (d))
// has NO boolean/field that could ever set `SpawnChildRequest.fork` from the model-facing Agent
// tool. WS-10 nowhere names the product surface that actually triggers a fork -- its own §3.5
// describes ONLY the inheritance semantics, never an invocation path. In this phase, `fork: true` is
// therefore reachable only by a caller constructing a `SpawnChildRequest` directly (a future
// internal mechanism, e.g. an automatic "continue this turn in an isolated fork" product feature, or
// a test) -- never through tools/impl/agent.ts's own `AgentInput` parsing. Parked exactly like this
// codebase's own repeated "seam exists before its real consumer does" precedent (AutoEngine/
// HookStage at P1) rather than inventing a speculative trigger; recorded in this lane's own report.
import type { ContentBlock, ProviderMessage } from "../engine.ts";
import type { ChildInheritance } from "./child-handle.ts";

// Review r2 finding 1 (whole-branch, minimal fix -- byte-exact fork inheritance per r3a §2 is a
// LATER release, not this one): the constant placeholder text every synthetic tool_result below
// carries. `engine.ts`'s own `buildChildInheritance` copies the parent's live `messages` verbatim
// for a fork (`req.fork === true ? { messages: [...messages] } : {}`) at the exact point the Agent
// tool's own `tool_use` call is executing -- which means the array's LAST entry is always the
// assistant message that batched this round's tool_use blocks (this fork's own call, and any
// SIBLING tool calls the model batched alongside it in the same turn), with NONE of that round's
// tool_results appended yet (those live in the parent engine's own local `resultBlocks`, filed only
// after every call in the round -- including this spawn -- returns). Handed to a provider as-is,
// that history ends on a dangling `tool_use` with no matching `tool_result`: both the Anthropic and
// the OpenAI Responses wire mappers reject (or silently corrupt) a request shaped that way.
export const FORK_PLACEHOLDER_TOOL_RESULT = "Fork started — processing in background";

function isToolUseBlock(block: ContentBlock): block is Extract<ContentBlock, { type: "tool_use" }> {
  return block.type === "tool_use";
}

/**
 * Appends ONE synthetic `role: "tool"` message answering every `tool_use` block in the LAST message,
 * when that last message is an assistant turn carrying any -- siblings included, since a batched
 * round can hold more than one call and every one of them is equally unanswered at fork time. A
 * no-op on anything else (no messages, a string-content last message, an assistant message with no
 * tool_use, or a last message that already isn't the assistant's). The synthetic result carries
 * `FORK_PLACEHOLDER_TOOL_RESULT`, never `is_error` -- this is not a failure, the fork genuinely did
 * start; it is a placeholder for a real result the parent will never see (the fork reports back
 * through its own task_notification, not through this call's own tool_result).
 */
function withSyntheticForkToolResults(messages: ProviderMessage[]): ProviderMessage[] {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== "assistant" || typeof last.content === "string") return messages;
  const unanswered = last.content.filter(isToolUseBlock);
  if (unanswered.length === 0) return messages;
  const toolResults: ContentBlock[] = unanswered.map((call) => ({
    type: "tool_result",
    tool_use_id: call.id,
    content: FORK_PLACEHOLDER_TOOL_RESULT,
  }));
  return [...messages, { role: "tool", content: toolResults }];
}

// A COPY (never the same array reference `inherit.messages` itself holds) -- belt-and-suspenders on
// top of engine.ts's own already-copied array, since this function's own caller (child-engine.ts) is
// about to hand the result to a brand-new runEngine() invocation as ITS OWN mutable turn history:
// nothing should ever let two engine instances share one mutable array. The synthetic tool_result
// message (above) is appended to that copy, never mutated into it, so `inherit.messages` (and the
// parent's own live history, which it was copied from) is untouched.
export function resolveForkInitialMessages(inherit: Pick<ChildInheritance, "messages">): ProviderMessage[] {
  if (inherit.messages === undefined) return [];
  return withSyntheticForkToolResults([...inherit.messages]);
}

export function isForkRequest(req: { fork?: true }): boolean {
  return req.fork === true;
}
