// Phase 6 Task 3 (R6-7): re-attaching the continuation chain to a RESUMED history.
//
// Extracted from `engine.ts` in review round 1 (M8). It is a pure function of a message array and a
// persistence seam, so it belongs beside the codec it consumes rather than inside a turn loop.
//
// A resumed history comes back from `rebuildProviderMessages` as content plus, on every assistant
// message, the entry's own uuid -- and nothing else. The provider-state records that say WHICH
// provider produced each of those messages, and what opaque continuation state it left behind, live
// in the sidecar. This is where the two halves are put back together.
import type { SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { buildContinuationChain, type ContinuationChain, type ProviderStateRecord } from "./provider-state.ts";

/** The half of `SessionPersistence` this needs. Narrowed so a caller can hand it a two-method double. */
export interface ContinuationChainSource {
  loadProviderState?(): Promise<ProviderStateRecord[]>;
  loadProviderIdentity?(): Promise<{ providerId: string; modelKey: string } | undefined>;
}

/** The shape this mutates. Deliberately structural rather than importing `ProviderMessage` from `engine.ts` -- that direction is the circular one `store/` must not take. */
export interface AttachableMessage {
  role: "user" | "assistant" | "tool";
  uuid?: string;
  origin?: unknown;
  nativeState?: unknown;
}

export interface AttachContinuationChainOptions {
  messages: AttachableMessage[];
  store: ContinuationChainSource;
  sessionId: string;
  /** Emits one Winter-only `system/continuity_warning`. Called at most once. */
  warn: (message: SdkMessage) => void;
  /** Injected so a fixture's warning uuid is deterministic. */
  newUuid: () => string;
  /**
   * P6 fix wave (T10 r1 Minor): the persisted identity, ALREADY LOADED by the caller. The engine reads
   * it once for the resume-time switch comparison; without this the zero-records branch below re-read
   * it -- one extra summary I/O per resumed run. Absent -> `store.loadProviderIdentity` as before.
   */
  identity?: () => Promise<{ providerId: string; modelKey: string } | undefined>;
}

/**
 * Folds the sidecar chain back onto a resumed history, and REPORTS a gap.
 *
 * An assistant message with no `origin` record degrades to summary-level and the session says so.
 * That is R6-7's own rule, and the reason it cannot be silent is that the degradation is observable
 * to the model: it will not get its exact native replay, so a user who sees a worse continuation than
 * they expected deserves to know why.
 */
export async function attachContinuationChain(opts: AttachContinuationChainOptions): Promise<ContinuationChain> {
  const { messages, store, sessionId, warn, newUuid } = opts;
  // The chain is RETURNED (fix wave, Ruling E-2) so the engine can keep the resumed half beside the
  // records it writes itself -- the portable handoff at a later switch reads a source message's
  // summary off it. Empty for every early return: nothing folded, nothing to hand back.
  const empty: ContinuationChain = new Map();
  if (store.loadProviderState === undefined || messages.length === 0) return empty;

  let records: ProviderStateRecord[];
  try {
    records = await store.loadProviderState();
  } catch {
    // An unreadable sidecar is a DEGRADED resume, not a failed one: the conversation is intact, only
    // its native continuation is not.
    warn({
      type: "system",
      subtype: "continuity_warning",
      warning: "sidecar_unreadable",
      detail: "the provider-state sidecar could not be read; this session resumes without native continuation state.",
      uuid: newUuid(),
      session_id: sessionId,
    });
    return empty;
  }

  // AN ANCHOR THAT ALREADY CARRIES `origin` IN MEMORY IS PROVENANCE-COMPLETE, and it is excluded from
  // everything below (review round 2).
  //
  // The case this exists for is a FORKED CHILD, and its mechanism is worth stating because it is not
  // visible from any one file. A child writer's key reuses the PARENT's `sessionId` with a `subpath`,
  // so an identity lookup by session matches the PARENT's row -- while the child's own fresh writer
  // has zero records. Fork inheritance hands the child the parent's ALREADY-ANNOTATED messages, whose
  // assistant entries carry uuids. Every precondition for "the sidecar was deleted" is therefore met
  // by a perfectly healthy fork, and the resulting frame escapes to the PARENT's host stream.
  //
  // The rule that closes it is not a special case for forks: a message the engine already annotated
  // has its provenance, and a sidecar it was never written to says nothing about it. Anchors WITHOUT
  // an in-memory origin are still counted, so this is not a blanket suppression -- a mixed history
  // warns for exactly the messages that genuinely lost their records.
  const unresolved = messages.filter((m) => m.role === "assistant" && m.uuid !== undefined && m.origin === undefined);
  const anchors = new Set(unresolved.map((m) => m.uuid!));
  if (anchors.size === 0) return empty;

  // ZERO RECORDS IS TWO DIFFERENT SITUATIONS, and the dialect record's identity block is what
  // separates them (review round 1, I1).
  //
  // A session that NEVER had provider state -- every session written before this phase, and every
  // session run before selection is wired -- has nothing to degrade FROM: its resume is byte-for-byte
  // the resume it always had. Warning on those would fire on essentially every resumed session in the
  // product and train a reader to ignore the frame, which is what would make it useless on the day it
  // means something.
  //
  // A session whose sidecar was DELETED is the opposite: it HAD provider state, every message is now
  // degraded to summary-level, and R6-7 is explicit that a degradation carries the loss warning. The
  // identity block is the "record of expectation" that tells the two apart.
  if (records.length === 0) {
    const hadIdentity = opts.identity !== undefined ? await opts.identity() : store.loadProviderIdentity !== undefined ? await store.loadProviderIdentity() : undefined;
    if (hadIdentity === undefined) return empty;
    warn({
      type: "system",
      subtype: "continuity_warning",
      warning: "provider_state_deleted",
      detail: `this session recorded a provider identity but its provider-state sidecar is gone; ${anchors.size} resumed assistant message${anchors.size === 1 ? "" : "s"} ${anchors.size === 1 ? "was" : "were"} degraded to summary-level.`,
      uuid: newUuid(),
      session_id: sessionId,
    });
    return empty;
  }

  const chain = buildContinuationChain(records, anchors);
  let degraded = 0;
  for (const message of unresolved) {
    const link = chain.get(message.uuid!);
    if (link?.origin === undefined) {
      degraded++;
      continue;
    }
    message.origin = link.origin;
    // The opaque half is re-attached only when it exists. The RENDERER decides whether it may be
    // replayed (the identity renderer drops it across a domain boundary) -- re-attaching it here is
    // not a decision to send it.
    if (link.nativeState !== undefined) message.nativeState = link.nativeState;
  }

  if (degraded > 0) {
    warn({
      type: "system",
      subtype: "continuity_warning",
      warning: "provider_state_missing",
      // COUNTS AND IDENTITY ONLY. This string is a frame and a log line, and the records it is about
      // hold opaque provider state (Global Constraints).
      detail: `${degraded} resumed assistant message${degraded === 1 ? "" : "s"} ${degraded === 1 ? "has" : "have"} no provider-state origin record; ${degraded === 1 ? "it was" : "they were"} degraded to summary-level.`,
      uuid: newUuid(),
      session_id: sessionId,
    });
  }
  return chain;
}
