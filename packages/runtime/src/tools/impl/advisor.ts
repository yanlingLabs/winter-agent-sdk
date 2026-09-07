// Task 7 (LANE E, WS-06 §4 "advisor"): the Winter-only capability, registered since P7a under the
// BARE NATIVE NAME `advisor` (D29 -- descriptors/advisor.ts's own header carries the full reasoning
// and pins the identity, output schema and the `winter.reviewer-model` capability gate). RULING R3-2
// (docs/superpowers/plans/2026-09-03-winter-phase-03-tools-sandbox.md): P3 delivered "a directly-
// wired executor against the P1 provider seam" here, and the rename did not touch the executor at
// all -- only the name it registers under.
//
// THE INJECTABLE SEAMS (task-7 brief: "Assemble transcript context from an injectable
// TranscriptSource... constructor-injected seam you define in advisor.ts; tests use fakes; the REAL
// source is wired at T8"): ToolExecutionContext (registry.ts) carries no transcript/turn-history
// field at all at this phase -- its shape is exhaustive (cwd/home/sessionId/readState/emitFrame/
// permissions/tempDir/session) and none of those is "this session's conversation so far." Real
// per-run turn history only exists inside engine.ts's own closure (the `messages` array the round
// loop accumulates) and is not threaded onto ToolExecutionContext by any lane's own mandate --
// extending that shape is a registry.ts change, forbidden to lanes (R3-5). So this file defines its
// OWN constructor-injected seams (TranscriptSource, ReviewerResolver) or an executor built from them
// (createAdvisorExecutor), unit-tests them with fakes, and installs an inert-but-correct DEFAULT at
// module load (below) -- T8 (WS-06 §4's own "REAL source... wired at T8", RULING R3-2) is expected to
// call `createAdvisorExecutor` again, from wherever the engine's real turn history and resolved
// provider catalog actually live, and `replaceExecutor` a second time (registry.ts's replaceExecutor
// has no once-only guard, precisely so a later phase can upgrade a lane's own default this way).
import "../descriptors/advisor.ts"; // self-sufficiency: guarantees the "advisor" stub is registered before replaceExecutor runs below.
import type { Provider, ProviderMessage } from "../../engine.ts";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";

/**
 * D29: the canonical name IS the advertised name, and it is bare. Every consumer (engine.ts's
 * re-registration, the registry lookup, the conformance fixtures) reads it from here rather than
 * re-spelling it, so the rename was one edit rather than a sweep with a survivor.
 */
export const ADVISOR_TOOL_NAME = "advisor";

// One raw entry of whatever this session's real transcript is eventually shaped like -- deliberately
// narrower/speech-shaped (who said what) than engine.ts's own ProviderMessage (which additionally
// carries a "tool" role and structured ContentBlock[] content for wire purposes this assembler has no
// need of). assembleReviewerMessages below is what turns a list of these into the ProviderMessage[] a
// real Provider.generate() call actually consumes.
export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface TranscriptSource {
  getEntries(): TranscriptEntry[];
}

// Resolves BOTH the provider to call and the model id the result must report, TOGETHER: WS-06 §4's
// result shape pins `model: string` as required, but engine.ts's own `Provider` interface (the P1
// seam this forwards through) has no `model` field to read back -- whatever P6's catalog eventually
// backs the `winter.reviewer-model` capability (this tool's own descriptor gate) must hand back the
// model id alongside the provider instance it resolved, in one seam, rather than two seams that could
// disagree. `undefined` is the "no reviewer resolvable" case, folding into the ordinary tool-error
// result WS-06 §4 requires ("Reviewer unavailable/timeout -> ordinary tool error; never blocks the
// turn") the same way a resolved-but-throwing/timing-out provider does.
export interface ResolvedReviewer {
  provider: Provider;
  model: string;
}
export type ReviewerResolver = () => ResolvedReviewer | undefined;

export interface AdvisorExecutorDeps {
  transcriptSource: TranscriptSource;
  resolveReviewer: ReviewerResolver;
  // Injectable so tests can pin the truncation boundary without a multi-KB fixture transcript. The
  // module-load default below is a conservative placeholder character budget, not a tuned production
  // value -- P6's real provider/context-window accounting is expected to own the real number.
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 20_000;

// RULING R3-3 (docs/superpowers/plans/2026-09-03-winter-phase-03-tools-sandbox.md): "P3's assembler
// enforces the enforceable floor now -- provider-opaque state (encrypted_content, signatures,
// reasoning items) is NEVER included." Structural note mirroring hooks/runner.ts's own §10 REDACTION
// precedent: engine.ts's ProviderMessage/ProviderTurn types carry NO encrypted_content/reasoning_item
// field at all at this phase, and TranscriptEntry above is a plain {role, text} shape with nowhere to
// hide one either -- so there is structurally nothing of that SHAPE for this file to accidentally
// forward today. The active scan below is the belt to that structural suspender anyway: the day a
// real TranscriptSource (T8) or a future ProviderMessage grows a field shaped like one of these, or a
// provider inlines one as literal text this source happens to forward verbatim, this still strips it
// instead of silently starting to leak it. Full alignment with compaction's own redaction rules is a
// P5 obligation (RULING R3-3) -- this is the floor, not the ceiling.
const OPAQUE_MARKERS = ["encrypted_content", "reasoning_item", "signature"] as const;

function stripOpaqueMarkers(text: string): string {
  // Line-oriented and conservative: a whole line mentioning a marker key is DROPPED, never partially
  // redacted -- a review channel should fail toward "the reviewer sees less" rather than "the
  // reviewer sees a mangled fragment of something sensitive." Case-insensitive since the CC-shape
  // keys this guards against get re-cased across providers/SDKs.
  return text
    .split("\n")
    .filter((line) => !OPAQUE_MARKERS.some((marker) => line.toLowerCase().includes(marker)))
    .join("\n");
}

// Keeps the transcript TAIL (recent turns are what advice needs) and reports `truncated: true` only
// when something was actually clipped. Opaque-marker stripping runs PER ENTRY before truncation is
// measured, so a kept entry is always a whole, already-cleaned entry -- truncation never bisects one.
export function assembleReviewerMessages(entries: readonly TranscriptEntry[], maxChars: number = DEFAULT_MAX_CHARS): { messages: ProviderMessage[]; truncated: boolean } {
  const cleaned = entries.map((e) => ({ role: e.role, text: stripOpaqueMarkers(e.text) }));
  const kept: typeof cleaned = [];
  let total = 0;
  let truncated = false;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const entry = cleaned[i];
    if (!entry) continue;
    if (total + entry.text.length > maxChars) {
      if (kept.length === 0) {
        // This is the single most-recent entry under consideration and it ALONE exceeds the budget
        // (nothing has been kept yet) -- keep it clipped to its own tail-most `maxChars` characters
        // rather than sending the reviewer nothing at all. Once this fires, the budget is fully
        // spent by construction, so stopping here (never considering older entries) is correct
        // either way.
        kept.unshift({ role: entry.role, text: entry.text.slice(Math.max(0, entry.text.length - maxChars)) });
      }
      truncated = true;
      break;
    }
    kept.unshift(entry);
    total += entry.text.length;
  }
  const messages: ProviderMessage[] = kept.map((e) => ({ role: e.role, content: e.text }));
  return { messages, truncated };
}

// NO CACHE (WS-06 §4 closing line: "the advisor and the auto-mode classifier are separate routes and
// MUST NOT share a verdict cache"). Every call re-resolves the reviewer, re-assembles the transcript,
// and re-generates from scratch; nothing in this module is memoized, so there is nothing here that
// COULD be shared with permissions/auto/caches.ts's classifier verdict cache even by accident.
export function createAdvisorExecutor(deps: AdvisorExecutorDeps): ToolExecutor {
  return {
    async execute(_input: unknown, _ctx: ToolExecutionContext): Promise<ToolResultPayload> {
      let reviewer: ResolvedReviewer | undefined;
      try {
        reviewer = deps.resolveReviewer();
      } catch (err) {
        return { output: `Error: advisor failed to resolve a reviewer model: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      if (!reviewer) {
        return {
          output:
            'Error: advisor is unavailable -- no reviewer model is resolvable in this session\'s provider catalog (WS-06 §4: "Reviewer unavailable/timeout -> ordinary tool error; never blocks the turn").',
          isError: true,
        };
      }

      let entries: TranscriptEntry[];
      try {
        entries = deps.transcriptSource.getEntries();
      } catch (err) {
        return { output: `Error: advisor failed to assemble the session transcript: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      const { messages, truncated } = assembleReviewerMessages(entries, deps.maxChars ?? DEFAULT_MAX_CHARS);

      let turn;
      try {
        turn = await reviewer.provider.generate({ messages });
      } catch (err) {
        return { output: `Error: advisor's reviewer model failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }

      if (turn.kind !== "text") {
        // The advisor is a single-shot review channel with no tool-execution loop of its own (WS-06
        // §4's input is `{}` -- there is nothing for a reviewer to call a tool WITH even if it tried).
        // A non-text turn means the resolved reviewer either ignored the absence of a tools array or
        // is wired to the wrong kind of provider -- surfaced as an ordinary tool error rather than
        // attempting to dispatch calls this path was never built to execute.
        return {
          output: `Error: advisor's reviewer model returned a non-text response (kind: "${turn.kind}"); advisor has no tool-execution loop to act on it.`,
          isError: true,
        };
      }

      return {
        output: JSON.stringify({
          advice: turn.text,
          model: reviewer.model,
          ...(truncated ? { truncated: true } : {}),
        }),
      };
    },
  };
}

// Module-load default (T8 replaces this per RULING R3-2): no transcript, no reviewer -- EVERY call
// resolves to the ordinary "reviewer unavailable" tool error until a later task calls
// createAdvisorExecutor again with the real engine-turn-history source and a real resolved
// provider/model pair, then replaceExecutor(ADVISOR_TOOL_NAME, ...) a second time. This default never
// silently "half-works": resolveReviewer always returning undefined is indistinguishable, from the
// model's point of view, from a genuinely absent reviewer -- the same legible failure WS-06 §4
// already specifies for that case, so shipping this default is never worse than shipping no executor
// at all (the registry's own "not-yet-executable" stub result), while still being a REAL, fully
// tested executor the moment T8 supplies real deps.
replaceExecutor(
  ADVISOR_TOOL_NAME,
  createAdvisorExecutor({
    transcriptSource: { getEntries: () => [] },
    resolveReviewer: () => undefined,
  }),
);
