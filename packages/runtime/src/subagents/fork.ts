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
// Ground truth captured against the pinned binary (d2-report.md, 2026-09-17): when the parent batches
// TWO fork calls in one assistant message, EACH fork's own clone keeps ONLY ITS OWN tool_use block --
// the sibling's tool_use (and every other block the original message carried) is dropped, not kept.
// Sibling forks are therefore identical up to the Winter-authored boilerplate TEXT (a constant), never
// at the tool_use/tool_result block itself (which necessarily differs: a different id, and often a
// different `input.prompt`, per fork). This file's own conformance oracle,
// `packages/conformance/src/official/fork-request-bytes-differential.test.ts` (Lane D2), asserts this
// exact shape against the real pinned binary; build to IT, not to r3a §2's original (superseded) text.
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
 * A worktree fork's own extra note (claude's `_Fn(e,t)`, `e` the parent's own cwd, `t` the
 * worktree root): the inherited transcript still names the PARENT's own working directory in every
 * path it mentions, but this fork is running in an isolated worktree of its own.
 *
 * VERIFIED against the pinned 0.3.250 binary's own decompiled source (`_Fn`'s call site,
 * `if(We&&wn)vr.push(Pe({content:_Fn(te(),wn.worktreePath)}))`): claude pushes this as its OWN,
 * SEPARATE transcript entry, AFTER `yFn`'s own `[clone, tool_result+directive]` pair -- never folded
 * into the directive text block itself. `buildForkDirectiveText` below appends it AFTER
 * `"Your directive: "` for the same reason (`child-engine.ts`'s `startGeneration` delivers exactly
 * ONE live user turn to seed a generation -- see this file's own header for why that single turn
 * still reproduces claude's OWN wire-level merge of `tool_result` + directive text; a genuinely
 * separate THIRD transcript entry, positioned after a turn the live-frame mechanism hasn't sent yet,
 * has no channel to ride on without deeper engine surgery this lane does not own). DISCLOSED:
 * Winter's own transcript therefore holds ONE fewer entry here than claude's for a worktree fork,
 * and the note's ORDER (now after the directive) is verified, while its EXACT WIRE placement
 * (a byte-separate message vs. a folded paragraph) is not -- claude's own message-merge algorithm
 * (the same one `context/request-layout.ts` ports) may or may not also collapse `p` and this note
 * into one wire message the way Winter's does; unverified either way.
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

function isToolUseBlock(block: ContentBlock): block is Extract<ContentBlock, { type: "tool_use" }> {
  return block.type === "tool_use";
}
function isToolResultBlock(block: ContentBlock): block is Extract<ContentBlock, { type: "tool_result" }> {
  return block.type === "tool_result";
}

/** Every `tool_use` id any message in `messages` answers (a `tool_result` naming it, anywhere). */
function answeredToolUseIds(messages: readonly ProviderMessage[]): Set<string> {
  const answered = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const block of m.content) if (isToolResultBlock(block)) answered.add(block.tool_use_id);
  }
  return answered;
}

/**
 * claude's `ern`: drop every assistant message carrying a `tool_use` block with no answering
 * `tool_result` ANYWHERE in the list -- ported generally (a scan over every message, not "assume it
 * is only ever the last one"), even though in practice engine.ts's own round-loop invariant means the
 * in-flight message IS always last at fork time (this round's own tool_results are filed only after
 * every call, including this spawn, returns -- so nothing EARLIER in a live history can be
 * unanswered). A general filter is the more literal, more robust reading of "drop any assistant
 * message with an unresolved tool_use", and costs nothing extra.
 */
function dropUnansweredAssistantMessages(messages: readonly ProviderMessage[]): { filtered: ProviderMessage[]; dropped: ProviderMessage[] } {
  const answered = answeredToolUseIds(messages);
  const filtered: ProviderMessage[] = [];
  const dropped: ProviderMessage[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") {
      filtered.push(m);
      continue;
    }
    const toolUses = m.content.filter(isToolUseBlock);
    const hasUnanswered = toolUses.some((call) => !answered.has(call.id));
    (hasUnanswered ? dropped : filtered).push(m);
  }
  return { filtered, dropped };
}

/**
 * The clone (d2-report.md's own corrected shape): a NEW message carrying ONLY the one `tool_use`
 * block whose id is `forkToolUseId` -- every other block the original in-flight message carried
 * (a sibling's own tool_use, any accompanying text/thinking) is dropped, per the conformance oracle's
 * own pinned `cloneBlocks.length === 1`.
 *
 * `origin` is kept (which provider/model produced the ORIGINAL round -- still true of the clone, a
 * fact about where this tool_use came from, not about the clone's own freshness) but `nativeState`
 * and `uuid` are NOT: `nativeState` is opaque, adapter-owned continuation state for a REPLAYED
 * message (its own doc: "the ONLY sink is the provider-state sidecar") -- a clone that answers only
 * ONE of the native chain's own tool_use entries while the native state still names every sibling
 * call would desync a family whose adapter replays native items (the OpenAI Responses family) rather
 * than reconstructing wire messages from `content` alone. `uuid` is dropped because this is
 * genuinely a NEW message in the child's own transcript, never a replay of the parent's -- the pin's
 * own "(1)... new uuid" (r3a §2), which this file honours by simply never copying the old one
 * (the child's own transcript writer mints a fresh one when it persists this message, same as any
 * other fresh assistant entry).
 */
function cloneWithOwnToolUse(original: ProviderMessage, ownToolUse: Extract<ContentBlock, { type: "tool_use" }>): ProviderMessage {
  return {
    role: "assistant",
    content: [ownToolUse],
    ...(original.origin !== undefined ? { origin: original.origin } : {}),
  };
}

/**
 * `child-engine.ts`'s own `initialMessages` for a fork: the parent's history with every unanswered
 * assistant message dropped, then a clone of THIS fork's own in-flight call (only its own tool_use
 * block), then a placeholder `tool_result` answering it.
 *
 * `forkToolUseId` is `SpawnChildRequest.parentToolUseId` -- the model's own `tool_use` block id for
 * THIS Agent(fork) call (`tools/impl/agent.ts`'s own `ctx.toolUseId`), which is exactly what
 * distinguishes two sibling forks batched in the same assistant message from one another.
 *
 * No-ops (returns `inherit.messages` filtered, with nothing appended) when no dropped message
 * actually carries a tool_use block matching `forkToolUseId` -- a defensive shape for a hand-built
 * `ChildInheritance` (every test double that predates this lane) or `inherit.messages === undefined`
 * (every non-fork child; `buildChildInheritance` never sets `messages` for one), returning `[]`.
 */
export function buildForkInitialMessages(inherit: Pick<ChildInheritance, "messages">, forkToolUseId: string): ProviderMessage[] {
  if (inherit.messages === undefined) return [];
  const { filtered, dropped } = dropUnansweredAssistantMessages(inherit.messages);
  let ownToolUse: Extract<ContentBlock, { type: "tool_use" }> | undefined;
  let sourceMessage: ProviderMessage | undefined;
  for (const m of dropped) {
    if (typeof m.content === "string") continue;
    const match = m.content.filter(isToolUseBlock).find((call) => call.id === forkToolUseId);
    if (match !== undefined) {
      ownToolUse = match;
      sourceMessage = m;
      break;
    }
  }
  if (ownToolUse === undefined || sourceMessage === undefined) return filtered;
  const clone = cloneWithOwnToolUse(sourceMessage, ownToolUse);
  const toolResult: ProviderMessage = { role: "tool", content: [{ type: "tool_result", tool_use_id: forkToolUseId, content: FORK_PLACEHOLDER_TOOL_RESULT }] };
  return [...filtered, clone, toolResult];
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
