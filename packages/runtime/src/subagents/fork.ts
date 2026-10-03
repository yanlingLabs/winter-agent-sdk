// WS-10 §3.5: fork semantics -- "a fork inherits EVERYTHING from the main session at spawn:
// conversation, system prompt, exact tool pool, model, permissions, prompt cache, thinking, and
// effective effort... never as a fresh AgentDefinition... ignores a model override by contract."
//
// SDK 0.0.16 (P16-7, r3a-heldback-fork-listing.md §2, GROUND-TRUTH CORRECTED by d2-report.md): this
// file builds the CHILD side of a fork's history and its directive turn. The system prompt / tool
// specs / userContext half of "byte-exact" is a SEPARATE mechanism -- `ChildInheritance.requestLayout`
// (`engine.ts`'s `buildChildInheritance`, captured from `context/request-layout.ts`'s per-session
// memo) handed to the child's own `runEngine()` as `EngineOptions.exactRequestLayout` -- because
// nothing here has access to the parent's live assembler/tool registry state; this file owns only
// the MESSAGE HISTORY and the DIRECTIVE TEXT.
//
// --- Why a synthetic tool_result exists at all ------------------------------------------------------
//
// At fork time the parent's own live `messages` always ends on the assistant message that batched
// THIS round's tool_use blocks (the Agent(fork) call itself, plus any SIBLING calls the model batched
// alongside it in the same turn) -- engine.ts's own round loop pushes that assistant message before
// executing any of its calls, and files this round's own tool_results only after every one of them
// (including this spawn) returns. Handed to a provider unmodified, that history ends on a dangling
// tool_use with no tool_result: both the Anthropic and the OpenAI Responses wire mappers reject (or
// corrupt) a request shaped that way.
//
// --- The d2 correction over r3a §2's own "(1) a CLONE... ALL BLOCKS KEPT" claim --------------------
//
// Ground truth captured against the official runtime (d2-report.md, 2026-09-17): when the parent batches
// TWO fork calls in one assistant message, EACH fork's own clone keeps ONLY ITS OWN tool_use block --
// the sibling's tool_use (and every other block the original message carried) is dropped, not kept.
// Sibling forks are therefore identical up to the Winter-authored boilerplate TEXT (a constant), never
// at the tool_use/tool_result block itself (which necessarily differs: a different id, and often a
// different `input.prompt`, per fork). This file's own conformance oracle,
// `packages/conformance/src/official/fork-request-bytes-differential.test.ts` (Lane D2), asserts this
// exact shape against the real official runtime; build to IT, not to r3a §2's original (superseded) text.
import type { ContentBlock, ProviderMessage } from "../engine.ts";
import type { ChildInheritance } from "./child-handle.ts";

// Review r2 finding 1 (whole-branch, 0.0.15): the constant placeholder text every synthetic
// tool_result carries -- proven byte-identical to claude's own "Fork started — processing in
// background" (d2-report.md: "Winter's fork placeholder text already byte-matches claude's").
export const FORK_PLACEHOLDER_TOOL_RESULT = "Fork started — processing in background";

// claude's own literal prefix immediately before the model's `prompt` input, ending the directive
// text block (fork-request-bytes-differential.test.ts pins `directiveText.endsWith("Your directive: "
// + prompt)` -- nothing may follow the prompt, and nothing but this exact prefix precedes it).
const DIRECTIVE_PREFIX = "Your directive: ";

/**
 * WS-10 §3.5 / R-S3 ("system prompts are Winter-authored... same structure, same rules, Winter
 * wording"): the fork worker's own boilerplate, read by the child as an ordinary user turn (never a
 * system prompt -- a fork's system prompt is the PARENT's own, verbatim, per `requestLayout` above).
 * Same functional content claude's own fork wrapper carries (worker fork; the inherited transcript is
 * reference, not a live conversation; never spawn a further subagent; report back once; restate the
 * task; stay concise; list any commits made) in Winter's own words -- this is prose Winter authors,
 * never copied Anthropic text (R-S3's own rule).
 *
 * A CONSTANT: nothing here varies per fork or per call, which is what makes two sibling forks' own
 * directive text share a byte-identical prefix up to `DIRECTIVE_PREFIX` (the conformance test's own
 * "boilerplate PREFIX" assertion) -- the one piece of this whole design that is deliberately NOT
 * exact-to-claude byte-for-byte (R-S3 forbids copying Anthropic prose) but still cache-shareable,
 * because it is identical across every fork spawned from the same session.
 */
const FORK_BOILERPLATE = [
  "You are a Winter worker fork: a copy of this session, running independently from this point on.",
  "The conversation above is your inherited transcript -- context to work from, not a live exchange; nothing you say back into it reaches the original session directly.",
  "Do not spawn further subagents. Forks cannot fork, and delegating your own directive elsewhere defeats the point of running as one.",
  "Work your directive to completion, then report back exactly once: restate your task in the first line of your reply, then answer it concisely. If you made any commits, list them.",
].join("\n");

/**
 * A worktree fork's own extra note (given the parent's own cwd and the worktree root): the inherited
 * transcript still names the PARENT's own working directory in every path it mentions, but this fork
 * is running in an isolated worktree of its own.
 *
 * claude adds this note as its OWN, SEPARATE transcript entry, AFTER the `[clone, tool_result +
 * directive]` pair -- never before the directive. `buildForkDirectiveText` below appends it AFTER
 * `"Your directive: "` for the same reason (`child-engine.ts`'s `startGeneration` delivers exactly
 * ONE live user turn to seed a generation -- see this file's own header for why that single turn
 * still reproduces claude's wire-level merge of `tool_result` + directive text; a genuinely separate
 * THIRD transcript entry, positioned after a turn the live-frame mechanism hasn't sent yet, has no
 * channel to ride on without deeper engine surgery this lane does not own). DISCLOSED: Winter's own
 * transcript therefore holds ONE fewer entry here than claude's for a worktree fork, and while the
 * note's ORDER (after the directive) matches, its EXACT WIRE placement (a separate message vs. a
 * folded paragraph) is unverified -- claude's message merge (the behaviour `context/request-layout.ts`
 * reproduces) may or may not also fold this note into the same wire message the way Winter's does.
 */
function worktreeNote(parentRoot: string, worktreeRoot: string): string {
  return `You've inherited the conversation above from the parent session, which was working in ${parentRoot}. You are now running in an isolated git worktree at ${worktreeRoot} -- the same repository, a separate working copy. Any path the inherited transcript names is relative to the PARENT's own directory; translate it onto this worktree's root before you use it, and re-read a file here before editing it, since it may already differ from what the transcript shows. Your own changes stay in this worktree and never touch the parent's files.`;
}

export interface ForkDirectiveInput {
  /** The Agent tool call's own `prompt` input -- this fork's actual task. */
  prompt: string;
  /** Set only for `isolation: "worktree"` forks -- the parent's own cwd and the child's own worktree root (`workspace.root`). */
  worktree?: { parentRoot: string; worktreeRoot: string };
}

/**
 * The fork's own first live turn: the Winter-authored boilerplate, then claude's own
 * `"Your directive: "` prefix immediately followed by the prompt verbatim, then -- for an isolated
 * fork only -- the worktree note (verified ordering, see `worktreeNote`'s own header). Delivered by
 * `child-engine.ts` as the generation's live user frame, which `context/request-layout.ts`'s own
 * message-merge logic folds into the SAME wire message as the placeholder `tool_result` this file
 * also builds (see `buildForkInitialMessages`) -- so the two together reproduce claude's own single
 * "tool_result + directive text" wire message without this file needing to construct that merge
 * itself.
 */
export function buildForkDirectiveText(input: ForkDirectiveInput): string {
  const directive = `${FORK_BOILERPLATE}\n\n${DIRECTIVE_PREFIX}${input.prompt}`;
  return input.worktree !== undefined ? `${directive}\n\n${worktreeNote(input.worktree.parentRoot, input.worktree.worktreeRoot)}` : directive;
}

/**
 * `child-engine.ts`'s own `initialMessages` for a fork: the parent's history with every assistant
 * message that carries an unanswered `tool_use` dropped, then a clone of THIS fork's own in-flight
 * call (only its own tool_use block, keeping the source message's `origin`, never its `nativeState` or
 * `uuid`), then a placeholder `tool_result` answering it.
 *
 * `forkToolUseId` is `SpawnChildRequest.parentToolUseId` -- the model's own `tool_use` block id for
 * THIS Agent(fork) call (`tools/impl/agent.ts`'s own `ctx.toolUseId`), which is exactly what
 * distinguishes two sibling forks batched in the same assistant message from one another.
 */
export function buildForkInitialMessages(inherit: Pick<ChildInheritance, "messages">, forkToolUseId: string): ProviderMessage[] {
  const messages = inherit.messages;
  if (messages === undefined) return [];

  // Every call id that has a result somewhere in the history, whatever the result's role or position.
  const answered = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result") answered.add(block.tool_use_id);
    }
  }

  // An assistant message is dropped when any of its calls is still waiting for a result; a provider
  // would refuse the dangling call. Everything else is kept as the same object, in order.
  const kept: ProviderMessage[] = [];
  const dropped: ProviderMessage[] = [];
  for (const message of messages) {
    const hasUnanswered =
      message.role === "assistant" && Array.isArray(message.content) && message.content.some((block) => block.type === "tool_use" && !answered.has(block.id));
    (hasUnanswered ? dropped : kept).push(message);
  }

  // The fork's own call: the first matching block of the first dropped message that carries it.
  let source: ProviderMessage | undefined;
  let call: ContentBlock | undefined;
  for (const message of dropped) {
    const blocks = message.content as ContentBlock[];
    const match = blocks.find((block) => block.type === "tool_use" && block.id === forkToolUseId);
    if (match !== undefined) {
      source = message;
      call = match;
      break;
    }
  }
  if (source === undefined || call === undefined) return kept;

  // A one-block copy of just this fork's call (siblings, text and per-message state left out), then
  // the placeholder result that answers it.
  const clone: ProviderMessage = { role: "assistant", content: [call] };
  if (source.origin !== undefined) clone.origin = source.origin;
  const placeholder: ProviderMessage = {
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: forkToolUseId, content: FORK_PLACEHOLDER_TOOL_RESULT }],
  };
  return [...kept, clone, placeholder];
}

export function isForkRequest(req: { fork?: true }): boolean {
  return req.fork === true;
}

/**
 * SDK 0.0.16 (P16-7): a fork's byte-exact request layout has no fallback -- there is no "re-render
 * it, less exactly" path for `engine.ts`'s `buildChildInheritance` to degrade to when
 * `context/request-layout.ts`'s own per-session memo has nothing recorded yet. Thrown, never
 * swallowed into a silently-approximate fork: the ONE call site (a spawn from an Agent(fork) tool_use)
 * can only exist after the model's own turn already sent at least one real request, so this is
 * structurally unreachable in production -- a defensive typed refusal for a test double or a future
 * caller that spawns a fork off a session with no request history at all, exactly the class of gap
 * this codebase's own "throw, never substitute" precedent (WS-13c §4 step 5, `resolveChildSlot`
 * above) asks for.
 */
export class ForkRequestLayoutUnavailableError extends Error {
  constructor() {
    super(
      "fork: this session has not captured a request layout yet (context/request-layout.ts's per-session memo is empty), so there is nothing exact for a fork to inherit -- a fork can only be spawned from a live turn, after the session's own first provider call",
    );
    this.name = "ForkRequestLayoutUnavailableError";
  }
}
