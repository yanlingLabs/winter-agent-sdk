// Phase 6 Lane C: the HISTORY RENDERER -- WS-13 §8.2's per-message decoration matrix.
//
// THE WHOLE DESIGN IN ONE RULE: when building a request, compare each historical assistant message's
// PRODUCING model with the TARGET, per message, and decide that message's fate on its own facts.
//
//   same continuation domain  -> EXACT native replay: its opaque state and its in-dialect thinking
//                                blocks ride unchanged, and it gets NO decoration (the target can
//                                read the real thing);
//   different domain          -> the native state is dropped, in-dialect thinking blocks are stripped
//                                from the content, and the message carries AT MOST ONE decoration --
//                                its OWN summary, or its own complete exposed reasoning -- as labeled
//                                prior-model DATA in the target's door.
//
// WHY PER MESSAGE AND NOT PER SESSION: arbitrary multi-hop chains (Claude -> OpenAI -> DeepSeek ->
// Claude -> ...) compose from this single rule with nothing else added. Each message answers only for
// itself, so the returning provider's own native state LIGHTS UP AGAIN on the hop back while the
// intervening families' messages keep their own decorations and nothing else. A session-level
// "we switched, so degrade everything" rule would have thrown that away permanently.
//
// WHAT IS NEVER DONE HERE, stated because each is a live temptation:
//   - a foreign summary is never written into a signed thinking channel (R6-8) -- `decoration` is an
//     annotation carried plainly, and neither door is a validated channel;
//   - opaque state never crosses a domain boundary in ANY carrier: not `nativeState.items`, and not
//     the Anthropic-family `thinking.signature` / `redacted_thinking.data` blocks that ride in the
//     CONTENT rather than in `nativeState`;
//   - raw hidden reasoning is never synthesized into a decoration from an in-dialect thinking block.
//     The material is the provider's OWN readable summary (or its exposed reasoning), captured from
//     its own summary channel into the sidecar. A Claude message whose summary was never captured
//     therefore carries nothing across the boundary -- and the switch point's classification warns
//     that it is summary-less, which is the honest outcome rather than forwarding a private chain of
//     thought.

import type { ProviderRegistry } from "../registry.ts";
import type { ContentBlockLike, MessageOrigin, ProviderMessageLike, ProviderNativeState } from "../types.ts";
import { MIN_DECORATION_BODY_CHARS, buildDecoration, decorationOverhead, doorFor, type Decoration, type DecorationDoor } from "./decoration.ts";
import { createEndpointResolver, sameDomain, type ContinuityEndpoint, type ReadableState } from "./domains.ts";

/** The target of THIS request. Structurally the `target` argument of the runtime's frozen `HistoryRenderer` seam. */
export interface HistoryTarget {
  family: string;
  continuationDomain?: string;
  readableState: ReadableState;
}

/** One assistant entry's folded sidecar records. Structurally `ContinuationLink` from the runtime's `store/provider-state.ts`. */
export interface ContinuationLinkLike {
  origin?: MessageOrigin;
  nativeState?: ProviderNativeState;
  summary?: string;
}

/** What the renderer needs of a chain: a lookup by anchor uuid. `Map<string, ContinuationLink>` -- the runtime's `ContinuationChain` -- satisfies it exactly. */
export interface ContinuationChainLike {
  get(anchorUuid: string): ContinuationLinkLike | undefined;
}

/** Whether a message's readable material is a provider SUMMARY or its own complete exposed reasoning. §9.5: the two are never merged, and never merged with opaque state. */
export type MaterialKind = "summary" | "exposed";

export interface RenderedDecoration {
  /** The decorated message's anchor uuid, when it had one. Identity only -- this record never carries the decoration's text, let alone any payload. */
  anchorUuid?: string;
  source: { providerId: string; modelKey: string };
  kind: MaterialKind;
  door: DecorationDoor;
  truncated: boolean;
}

/**
 * What one render did. The seam returns only messages, so this is how a caller learns that a transfer
 * became lossy -- §9.6's "never silently truncate reasoning while still classifying the handoff as
 * lossless" needs somewhere for the truncation to be reported, and this is it.
 */
export interface RenderReport {
  /** Messages replayed with their native state intact (same domain). */
  replayedNatively: number;
  /** Messages whose native state was dropped because the target is a different domain. */
  droppedNativeState: number;
  /** In-dialect thinking / redacted_thinking blocks stripped from content on a cross-domain leg. */
  strippedInDialectBlocks: number;
  decorations: RenderedDecoration[];
  /** Cross-domain messages that had NO readable material to carry (no summary captured, or forwarding was policy-blocked). */
  withoutMaterial: number;
  /** Material dropped ENTIRELY because the render's total decoration budget was exhausted. */
  budgetDropped: number;
  /** ANY truncation or budget drop. The engine's switch point reads this to flip a would-be-lossless transfer to warned-lossy. */
  truncated: boolean;
  /**
   * Decorations placed on the THINKING-CHANNEL door, which only the target family's own adapter can
   * address. Surfaced so a caller can see that this render depends on adapter-side placement --
   * `applyDecorationToContent` deliberately cannot do it, and a count of zero means every decoration
   * this render produced is placeable as ordinary text.
   */
  thinkingChannelDecorations: number;
}

export interface HistoryRendererOptions {
  /** §9.6: the per-decoration character budget. Absent = unbounded. */
  maxDecorationChars?: number;
  /** §9.6: the budget for ALL decorations in one render, spent NEWEST FIRST so the material closest to the current work survives. Absent = unbounded. */
  decorationCharBudget?: number;
  /**
   * §12.4 / §8.4: whether raw exposed reasoning may be forwarded at all. `false` suppresses
   * `exposed` material (a provider or user policy that forbids forwarding) while leaving
   * provider-produced summaries alone; `classifySwitch` turns it into the policy-blocked warning.
   */
  allowExposedForwarding?: boolean;
  /** Called with every render's report. The frozen seam returns only messages; this is the side channel that keeps truncation observable through it. */
  onReport?: (report: RenderReport) => void;
}

/**
 * The renderer.
 *
 * `render` is deliberately GENERIC over the message type rather than typed against the engine's
 * `ProviderMessage`: this package must never import the runtime (R6-4's cycle rule), and a generic
 * whose constraint is `ProviderMessageLike` is instantiated at `M = ProviderMessage` when this object
 * is assigned to the runtime's frozen `HistoryRenderer` seam. `corpus/continuity.test.ts` proves that
 * assignment against the REAL `adapterAsProvider` rather than against a hand-copied shape.
 */
export interface WinterHistoryRenderer {
  render<M extends ProviderMessageLike>(messages: M[], chain: ContinuationChainLike, target: HistoryTarget): M[];
  renderWithReport<M extends ProviderMessageLike>(messages: M[], chain: ContinuationChainLike, target: HistoryTarget): { messages: M[]; report: RenderReport };
}

export function createHistoryRenderer(registry: ProviderRegistry, options: HistoryRendererOptions = {}): WinterHistoryRenderer {
  const resolveEndpoint = createEndpointResolver(registry);
  const allowExposed = options.allowExposedForwarding !== false;

  function renderWithReport<M extends ProviderMessageLike>(messages: M[], chain: ContinuationChainLike, target: HistoryTarget): { messages: M[]; report: RenderReport } {
    const report: RenderReport = {
      replayedNatively: 0,
      droppedNativeState: 0,
      strippedInDialectBlocks: 0,
      decorations: [],
      withoutMaterial: 0,
      budgetDropped: 0,
      truncated: false,
      thinkingChannelDecorations: 0,
    };

    // PASS 1: decide each message's fate on its own facts, and note which ones want a decoration.
    // The decoration TEXT is not built yet -- the budget is spent newest-first in pass 2, and a
    // decoration that will be dropped for budget should never have been built.
    const plans: Array<{ index: number; material: { kind: MaterialKind; text: string }; source: ContinuityEndpoint; anchorUuid?: string }> = [];
    const out: M[] = messages.map((message, index) => {
      // A message with no origin AT ALL is passed through untouched: every pre-P6 history, every
      // host-supplied message, and every message rebuilt by a compaction summariser (which drops the
      // annotations) is in this class. ABSENCE IS NOT A DOMAIN MISMATCH -- treating it as one would
      // strip content from histories that never had a provider identity to mismatch with.
      const origin = message.origin ?? (message.uuid !== undefined ? chain.get(message.uuid)?.origin : undefined);
      if (origin === undefined) {
        // SYMMETRY with the same-domain path: an ASSISTANT message carrying a decoration but no
        // origin has a foreign model's material on it and no provenance to justify it, so the stale
        // annotation comes off. User and tool messages are left entirely alone -- a decoration there
        // is a HANDOFF note, deliberately attached to the user message that opens the target's first
        // turn, and stripping it would silently discard the handoff.
        if (message.role !== "assistant" || message.decoration === undefined) return message;
        const { decoration: _staleOrphan, ...kept } = message;
        return kept as unknown as M;
      }

      const source = resolveEndpoint(origin);
      if (sameDomain(source, target)) {
        // EXACT REPLAY. Native state and in-dialect blocks ride unchanged, and no decoration is
        // added: the target can read the real thing, and a summary beside it would be the merge §9.5
        // forbids. A decoration the input happened to carry is REMOVED rather than passed on -- it
        // would be another family's material sitting on a message this target authored itself.
        if (message.nativeState !== undefined) report.replayedNatively++;
        if (message.decoration === undefined) return message;
        const { decoration: _stale, ...kept } = message;
        return kept as unknown as M;
      }

      // CROSS-DOMAIN. Everything provider-authenticated comes off, in BOTH carriers.
      const { nativeState, content, strippedBlocks } = stripOpaque(message);
      if (nativeState !== undefined) report.droppedNativeState++;
      report.strippedInDialectBlocks += strippedBlocks;

      const link = message.uuid !== undefined ? chain.get(message.uuid) : undefined;
      const material = materialFor(link, source, allowExposed);
      if (material === undefined) {
        report.withoutMaterial++;
      } else {
        plans.push({ index, material, source, ...(message.uuid !== undefined ? { anchorUuid: message.uuid } : {}) });
      }

      const { nativeState: _dropped, decoration: _replaced, ...rest } = message;
      // THE ONE CAST. A spread of `M` plus a narrowed `content` is structurally `M` -- every other
      // key is copied verbatim -- but TypeScript cannot prove that for an unresolved generic. Kept to
      // this single site so nothing else in the file can quietly widen a message.
      return { ...rest, content } as unknown as M;
    });

    // PASS 2: spend the decoration budget NEWEST FIRST. When it runs out the OLDEST material is
    // dropped rather than every decoration being shrunk to uselessness -- §9.6's ordering applied at
    // the message level, and, like every other loss here, reported rather than silent.
    let remaining = options.decorationCharBudget;
    const door = doorFor(target);
    for (const plan of [...plans].reverse()) {
      const source = { providerId: plan.source.providerId, modelKey: plan.source.modelKey };
      const perDecoration = budgetFor(options.maxDecorationChars, remaining);
      // A budget that cannot hold the wrapper plus a usable body buys nothing: sending a delimiter
      // around three characters spends context and carries no meaning. Dropped, counted, and the
      // whole transfer flips to lossy.
      if (perDecoration !== undefined && perDecoration < decorationOverhead(source, door) + MIN_DECORATION_BODY_CHARS) {
        report.budgetDropped++;
        report.truncated = true;
        continue;
      }
      const decoration: Decoration = buildDecoration({
        text: plan.material.text,
        source,
        door,
        ...(perDecoration !== undefined ? { maxChars: perDecoration } : {}),
      });
      if (remaining !== undefined) remaining = Math.max(0, remaining - decoration.text.length);
      if (decoration.truncated) report.truncated = true;
      if (decoration.door === "thinking-channel") report.thinkingChannelDecorations++;
      report.decorations.push({
        ...(plan.anchorUuid !== undefined ? { anchorUuid: plan.anchorUuid } : {}),
        source,
        kind: plan.material.kind,
        door: decoration.door,
        truncated: decoration.truncated,
      });
      const current = out[plan.index]!;
      // AT MOST ONE DECORATION PER MESSAGE, structurally: this is the only assignment to the field in
      // the whole render, it happens at most once per index (one plan per message), and pass 1 has
      // already dropped any decoration the input carried.
      out[plan.index] = { ...current, decoration: { text: decoration.text, door: decoration.door } } as unknown as M;
    }

    options.onReport?.(report);
    return { messages: out, report };
  }

  return {
    render(messages, chain, target) {
      return renderWithReport(messages, chain, target).messages;
    },
    renderWithReport,
  };
}

/**
 * The readable material a cross-domain message may carry: its OWN summary, or its OWN complete
 * exposed reasoning.
 *
 * WHICH ONE IT IS is decided by the SOURCE model's own readable-state evidence, not by the text: a
 * `full-exposed` model's recorded reasoning text IS its exposed reasoning (DeepSeek `reasoning_content`),
 * and every other model's is a provider-produced summary. The distinction is not cosmetic -- §8.4's
 * second no-warning condition applies ONLY to complete exposed reasoning forwarded unmodified, so
 * mislabelling a summary as exposed reasoning would suppress a warning the transfer has earned.
 */
function materialFor(link: ContinuationLinkLike | undefined, source: ContinuityEndpoint, allowExposed: boolean): { kind: MaterialKind; text: string } | undefined {
  const text = link?.summary;
  if (text === undefined || text.length === 0) return undefined;
  const kind: MaterialKind = source.readableState === "full-exposed" ? "exposed" : "summary";
  if (kind === "exposed" && !allowExposed) return undefined;
  return { kind, text };
}

/**
 * Removes every carrier of provider-authenticated state from a message crossing a domain boundary.
 *
 * TWO CARRIERS, and missing the second is the subtle half: `nativeState.items` is the obvious one,
 * but Anthropic-family `thinking.signature` and `redacted_thinking.data` ride IN THE CONTENT, as
 * in-dialect blocks, because the dialect defines them. A renderer that dropped only `nativeState`
 * would hand a target another provider's signed blocks verbatim -- which is exactly what §12.4's
 * "the target never receives the source opaque state" forbids, and which the identity renderer could
 * not do anything about because decoration (and therefore this strip) is Lane C's.
 */
function stripOpaque(message: ProviderMessageLike): { nativeState?: ProviderNativeState; content: string | ContentBlockLike[]; strippedBlocks: number } {
  const nativeState = message.nativeState;
  if (typeof message.content === "string") {
    return { ...(nativeState !== undefined ? { nativeState } : {}), content: message.content, strippedBlocks: 0 };
  }
  const kept = message.content.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking");
  return {
    ...(nativeState !== undefined ? { nativeState } : {}),
    content: kept.length === message.content.length ? message.content : kept,
    strippedBlocks: message.content.length - kept.length,
  };
}

function budgetFor(perDecoration: number | undefined, remaining: number | undefined): number | undefined {
  if (perDecoration === undefined) return remaining;
  if (remaining === undefined) return perDecoration;
  return Math.min(perDecoration, remaining);
}

/** What `applyDecorationToContent` did. `applied: false` always says WHY, and always returns the untouched content. */
export type DecorationPlacement =
  | { applied: true; content: string | ContentBlockLike[] }
  | { applied: false; reason: "no-decoration" | "thinking-channel-door"; content: string | ContentBlockLike[] };

/**
 * Places a TAG-door decoration into a message's own content, as ordinary text.
 *
 * OFFERED TO ADAPTERS, and it is what makes the door real: the renderer annotates, and the adapter
 * that owns a family's wire mapping decides where the annotation goes. For the tag door that is a
 * plain text block appended to the message the reasoning belongs to (text is the ONLY door into a
 * validating family); for the thinking-channel door it is the family's own plain reasoning field,
 * which only that adapter can address, so this helper deliberately refuses that case rather than
 * quietly turning it into text.
 */
export function applyDecorationToContent(message: ProviderMessageLike): DecorationPlacement {
  const decoration = message.decoration;
  if (decoration === undefined) return { applied: false, reason: "no-decoration", content: message.content };
  if (decoration.door !== "tag") {
    // DISCRIMINATED, not a silent pass-through. An adapter that called this on a thinking-channel
    // decoration and got its own content back would have dropped the decoration and had no way to
    // know -- the exact silence this whole lane exists to avoid.
    return { applied: false, reason: "thinking-channel-door", content: message.content };
  }
  if (typeof message.content === "string") return { applied: true, content: `${message.content}\n\n${decoration.text}` };
  return { applied: true, content: [...message.content, { type: "text", text: decoration.text }] };
}
