// Phase 5 Task 3 (spine): the COMPACTION seam -- R5-4. Lane K (task 7) implements the controller
// (threshold policy, the summarizer prompt, retention); the ENGINE owns the sequence around it.
//
// THE SEQUENCE IS THE SPINE'S, NOT THE LANE'S, and it is fixed:
//
//   PreCompact hook  ->  controller.compact()  ->  persist (boundary + summary)
//                    ->  emit the compact_boundary frame  ->  PostCompact hook
//                    ->  registry.onCompaction(evidenced)  ->  swap the in-memory history
//
// Two orderings inside it are load-bearing rather than tidy:
//
//  - PostCompact fires AFTER `compact()` because its pinned input carries `compact_summary` as a
//    REQUIRED string (derived-shapes-p5 item (f)); the summary must exist before the hook can be
//    given its input at all.
//  - `onCompaction(evidenced)` runs after persistence, so a crash between them leaves a session whose
//    durable transcript and whose deferred loaded-set disagree in the SAFE direction (the set is
//    rebuilt from the transcript on resume; a reset that outlived an unpersisted summary would not be).
//
// NO VETO IS INVENTED (WS-08 OQ4 / R5-4). `PreCompact` has no hook-specific output type in the pinned
// declaration -- there is no shape in which a veto could be expressed -- so the engine records and
// forwards its output and compacts regardless. Concretely, "forwards" means the composite's
// `extraContext` is appended to `customInstructions`; it does not mean a hook can stop compaction.
//
// OPAQUE PROVIDER STATE (Global Constraints): the messages handed to `compact()` are the engine's own
// ProviderMessage history, which carries no `encrypted_content`/reasoning-item field at this phase.
// A future provider phase that adds one MUST redact before this seam, not after -- a summary is
// model-readable text and is persisted as such.
import type { ContextAccountant, Provider, ProviderMessage } from "../engine.ts";

export interface CompactionInput {
  messages: ProviderMessage[];
  trigger: "auto" | "manual";
  /** `/compact <instructions>` (manual) or a PreCompact hook's forwarded context; `null` when neither. */
  customInstructions: string | null;
  accountant: ContextAccountant;
  /** The SESSION's own provider -- R5-4: the summarizer runs on it, never on a second, separately-configured model. */
  provider: Provider;
}

export interface CompactionResult {
  summary: string;
  /**
   * The messages that survive the boundary, in order, ALREADY EXCLUDING anything the summary
   * replaces. The engine swaps its whole history for `[summary-as-user-message, ...retained]`, so a
   * controller that returns the full input here has compacted nothing and the engine will say so
   * rather than silently looping.
   */
  retained: ProviderMessage[];
  /** The reading `contextTokens()` gave BEFORE compaction -- lands on `compact_metadata.pre_tokens`. */
  preTokens: number;
  /**
   * Deferred tools referenced by the retained messages (WS-09 §8.5). Handed to
   * `registry.onCompaction`, which resets the session's loaded set to `evidenced ∩ still-registered`:
   * a tool the model can no longer see evidence of having loaded must not stay silently callable.
   */
  evidencedToolNames: string[];
}

export interface CompactionController {
  /**
   * The AUTO trigger. R5-4's own formula is `contextTokens() >= compactionThreshold * limit()`, but
   * the predicate lives with the controller rather than in the engine so the threshold, its default,
   * and any hysteresis are one lane's to own and to capture against.
   *
   * The engine calls this before each provider call of a turn and NEVER for a manual `/compact`.
   */
  shouldCompact(accountant: ContextAccountant): boolean;
  compact(input: CompactionInput): Promise<CompactionResult>;
}

/**
 * What the engine hands the store when a compaction commits. The dialect turns it into a
 * `compact_summary` entry plus a `compact_boundary` entry carrying the pinned six-field
 * `compact_metadata` (derived-shapes-p5 item (f)).
 *
 * `retainedCount` rather than the retained messages themselves: the pinned `preserved_messages` names
 * ALREADY-PERSISTED entries by uuid and relinks them, so the store identifies them from its own
 * append log instead of re-persisting copies. Re-persisting would double every surviving message in
 * the transcript a UI renders.
 */
export interface CompactBoundaryRecord {
  trigger: "auto" | "manual";
  preTokens: number;
  postTokens?: number;
  durationMs?: number;
  summary: string;
  retainedCount: number;
}

/**
 * The spine's test double. Summarizes by concatenating a marker with the message count and keeps the
 * last `keep` messages -- deterministic, authored-prose-free, and enough for an engine test to prove
 * the whole sequence ran in order.
 */
export function fakeCompactionController(opts?: {
  shouldCompact?: boolean | ((accountant: ContextAccountant) => boolean);
  keep?: number;
  summary?: string;
  evidencedToolNames?: string[];
  calls?: CompactionInput[];
  /** Throws instead of compacting -- the failure arm. */
  fail?: string;
}): CompactionController {
  return {
    shouldCompact(accountant: ContextAccountant): boolean {
      const s = opts?.shouldCompact;
      if (typeof s === "function") return s(accountant);
      return s ?? false;
    },
    async compact(input: CompactionInput): Promise<CompactionResult> {
      opts?.calls?.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      if (opts?.fail !== undefined) throw new Error(opts.fail);
      const keep = opts?.keep ?? 0;
      return {
        summary: opts?.summary ?? `[fake-summary of ${input.messages.length} messages; trigger=${input.trigger}; instructions=${input.customInstructions ?? "none"}]`,
        retained: keep > 0 ? input.messages.slice(-keep) : [],
        preTokens: input.accountant.contextTokens(),
        evidencedToolNames: opts?.evidencedToolNames ?? [],
      };
    },
  };
}
