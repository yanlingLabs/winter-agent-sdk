// Phase 5 Task 7 (Lane K, R5-4): the real `CompactionController`.
//
// The SEQUENCE around this object belongs to the engine (compaction/seam.ts's header states it and
// why each ordering is load-bearing). What lives here is exactly what the seam left to the lane:
//
//   - the AUTO threshold predicate, `contextTokens() >= compactionThreshold * limit()`;
//   - the summary itself -- Winter's own instruction on the SESSION's provider (summarizer.ts);
//   - retention -- which messages survive the boundary (retention.ts);
//   - the evidenced-tool report WS-09 §8.5's loaded-set reset consumes.
//
// NO HYSTERESIS OF ITS OWN. The engine already suppresses the auto ASK while the accountant's
// reading has not moved since the last compaction (`lastCompactionTokens`, pinned by the seam
// contract test's re-entrancy case). A second guard here would stack with that one and silently skip
// the legitimate second compaction of a turn that genuinely grew past the threshold twice.
import { DEFAULT_COMPACTION_THRESHOLD } from "@yanlinglabs/winter-agent-sdk";
import type { CompactionController, CompactionInput, CompactionResult } from "./seam.ts";
import type { ContextAccountant, ProviderMessage } from "../engine.ts";
import { DEFAULT_RETAINED_PAIRS, evidencedToolNames, selectRetention } from "./retention.ts";
import { buildSummaryInstruction, redactForSummary, summarize, WINTER_SUMMARY_INSTRUCTION } from "./summarizer.ts";

export { DEFAULT_COMPACTION_THRESHOLD };

export interface CompactionControllerOptions {
  /**
   * R5-4's threshold, a DISCLOSED Winter session option (`RuntimeConfig.compactionThreshold`,
   * default 0.92 -- the constant is the SDK's, declared once in options.ts). A value outside
   * `(0, 1]` is ignored and the default stands, mirroring `createContextAccountant`'s own treatment
   * of a nonsense limit: a threshold of 0 would compact before every single provider call and a
   * threshold above 1 could never fire, and neither is a state a session should be able to reach by
   * typo.
   */
  compactionThreshold?: number;
  /** How many user/assistant pairs survive a boundary. Default 4 (DEFAULT_RETAINED_PAIRS). */
  retainedPairs?: number;
  /** Overrides Winter's authored summary instruction. For fixtures and for a host with its own house style. */
  instruction?: string;
  /** Bounds the per-`tool_use` input rendering in the summarizer's view of the transcript. */
  toolInputPreviewChars?: number;
}

export class NothingToCompactError extends Error {}

function resolveThreshold(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 1) return DEFAULT_COMPACTION_THRESHOLD;
  return raw;
}

export function createCompactionController(opts: CompactionControllerOptions = {}): CompactionController {
  const threshold = resolveThreshold(opts.compactionThreshold);
  const pairs = opts.retainedPairs ?? DEFAULT_RETAINED_PAIRS;
  const instruction = opts.instruction ?? WINTER_SUMMARY_INSTRUCTION;
  const previewOpts = opts.toolInputPreviewChars !== undefined ? { toolInputPreviewChars: opts.toolInputPreviewChars } : {};

  // The CARRY-FORWARD state, ported from Norma's compactor (the R5-4 vehicle): under repeated
  // re-compression a model reliably drops facts out of a summary it is asked to re-summarize, so an
  // earlier summary is concatenated forward VERBATIM and only the genuinely new material is sent to
  // the model. After a compaction the engine's history begins with `{role:"user", content: summary}`,
  // which is what the identity check below recognises.
  //
  // DISCLOSED LIMIT: this is per-controller state, so a RESUMED session (whose rebuilt history opens
  // with a summary this object never produced) re-summarizes that summary once. Recognising it
  // durably needs either a marker inside the model-readable summary text or a store-side signal --
  // both spine decisions, raised in the task report rather than invented here.
  let lastSummary: string | null = null;

  return {
    shouldCompact(accountant: ContextAccountant): boolean {
      return accountant.contextTokens() >= threshold * accountant.limit();
    },

    async compact(input: CompactionInput): Promise<CompactionResult> {
      // Read BEFORE the summarizer runs. `preTokens` is what the window measured when the boundary
      // was decided, and it lands verbatim on the pinned `compact_metadata.pre_tokens`.
      const preTokens = input.accountant.contextTokens();

      // THE CARRIED SUMMARY IS TAKEN OFF THE FRONT **BEFORE** RETENTION, never after. The engine
      // swaps its history for `[summary, ...retained]` and that summary is a `user` message, so it
      // reads as a TURN START like any other. Retaining over the whole list would therefore
      //   (a) silently spend one of the N pairs the caller asked to keep on a summary, and
      //   (b) on the next check of a still-running turn leave `summarized === [summary]` alone --
      //       which, carried forward verbatim, hands the model an EMPTY message list. A real
      //       provider rejects that, so the turn would report a failed compaction on every round
      //       while the window never shrank; and a tolerant one would append a summary of nothing.
      // Taking it off first also keeps the round-start degradation reachable after a compaction: a
      // long agentic turn plus a summary looks like two turns and would never take that path.
      const head = input.messages[0];
      const carried = lastSummary !== null && head !== undefined && head.role === "user" && head.content === lastSummary ? lastSummary : null;
      const body: ProviderMessage[] = carried === null ? [...input.messages] : input.messages.slice(1);

      const plan = selectRetention(body, { pairs });
      // Reported as a FAILED compaction (the engine's own arm writes the pinned
      // `compact_result: "failed"` status pair) rather than returned as a no-op: the engine takes
      // `retained` literally and swaps its history for `[summary, ...retained]`, so a controller
      // that handed back the whole input would make the history longer on every round, forever.
      const refuse = (why: string): never => {
        throw new NothingToCompactError(`there is nothing to compact: ${why}`);
      };
      if (!plan.foldable) {
        refuse(`the whole conversation (${body.length} message(s)) already fits inside the ${pairs}-pair retention window`);
      }

      // Belt and braces for the same failure at a different layer: a window can be foldable BY COUNT
      // and still leave the summarizer nothing legible (blank text, or blocks whose types the
      // redaction deliberately does not know). An empty request is never worth making.
      const redacted = redactForSummary(plan.summarized, previewOpts);
      if (redacted.length === 0) refuse("the messages it would replace carry no summarizable content");

      const fresh = await summarize(input.provider, redacted, buildSummaryInstruction(input.customInstructions, instruction));
      const summary = carried === null ? fresh : `${carried}\n\n${fresh}`;
      lastSummary = summary;

      return {
        summary,
        retained: plan.retained,
        preTokens,
        evidencedToolNames: evidencedToolNames(plan.retained),
      };
    },
  };
}
