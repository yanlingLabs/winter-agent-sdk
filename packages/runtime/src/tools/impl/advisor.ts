// Task 7 (LANE E, WS-06 §4 "advisor"): the Winter-only capability, registered since P7a under the
// BARE NATIVE NAME `advisor` (D29 -- descriptors/advisor.ts's own header carries the full reasoning
// and pins the identity, output schema and the `winter.reviewer-model` capability gate).
//
// SINCE R-8-1 / RULING P-6, THE TOOL ITSELF LIVES IN `@yanlinglabs/winter-agent-sdk/tools`: the
// handler factory, the transcript assembler, the opaque-state floor and the narrow reviewer types.
// What stays HERE is the half that is genuinely this runtime's:
//
//   * REVIEWER RESOLUTION (D30). Which model reviews, by what precedence, and how a `set_model`
//     across families moves it, is a provider-layer decision -- the SDK takes a `ReviewerResolver`
//     and never resolves anything itself.
//   * THE REGISTRY SEAM. `ToolExecutor`/`ToolResultPayload` are registry types; the SDK returns the
//     host-neutral `{ text, isError? }` and this file translates.
//   * THE PROVIDER ADAPTER, three lines below. The SDK's `AdvisorReviewer` is deliberately narrow --
//     one method, plain-string message content -- because the only thing this tool needs of a
//     provider is "turn these messages into one text turn". This runtime's own `Provider` speaks the
//     engine's wire types (`ProviderMessage.content` may be a `ContentBlock[]`, and `ProviderRequest`
//     carries tools/model/effort/signal), so the two are not mutually assignable in either direction.
//     The adaptation belongs on THIS side: widening the published type to fit one host's provider
//     interface would drag the engine's wire shape into a package every other host must implement.
//
// THE INJECTABLE SEAMS ARE UNCHANGED (task-7 brief: "Assemble transcript context from an injectable
// TranscriptSource... constructor-injected seam; tests use fakes; the REAL source is wired at T8").
// `ToolExecutionContext` carries no transcript field, and real per-run turn history exists only
// inside engine.ts's own closure -- so engine.ts calls `createAdvisorExecutor` again with the live
// `messages` array (captured by REFERENCE, never a snapshot) and a real resolver, and
// `replaceExecutor`s over the inert module-load default at the bottom of this file.
import "../descriptors/advisor.ts"; // self-sufficiency: guarantees the "advisor" stub is registered before replaceExecutor runs below.
import type { Provider } from "../../engine.ts";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import {
  ADVISOR_DEFINITION,
  createAdvisorToolHandler,
  type AdvisorReviewer,
  type TranscriptEntry,
  type TranscriptSource,
} from "@yanlinglabs/winter-agent-sdk/tools";

/**
 * D29: the canonical name IS the advertised name, and it is bare. Read off the one definition, so
 * the registered name and the descriptor's can never disagree.
 */
export const ADVISOR_TOOL_NAME = ADVISOR_DEFINITION.builtinName ?? ADVISOR_DEFINITION.toolName;

// The transcript types are the SDK's now; re-exported under their existing names so engine.ts and
// the tests that already import them from here keep one import site.
export type { TranscriptEntry, TranscriptSource };
export { assembleReviewerMessages, ADVISOR_DEFAULT_MAX_CHARS, OPAQUE_MARKERS, stripOpaqueMarkers } from "@yanlinglabs/winter-agent-sdk/tools";

/**
 * Resolves BOTH the provider to call and the model id the result must report, TOGETHER: WS-06 §4's
 * result shape pins `model: string` as required, but `Provider` has no `model` field to read back --
 * whatever backs the `winter.reviewer-model` capability must hand back the model id alongside the
 * provider instance it resolved, in ONE seam, rather than two seams that could disagree.
 *
 * Typed against THIS runtime's `Provider` (not the SDK's `AdvisorReviewer`): the resolver is the
 * provider layer's own door, and the narrowing happens at the boundary below.
 */
export interface ResolvedReviewer {
  provider: Provider;
  model: string;
}
export type ReviewerResolver = () => ResolvedReviewer | undefined;

export interface AdvisorExecutorDeps {
  transcriptSource: TranscriptSource;
  resolveReviewer: ReviewerResolver;
  /** Injectable so tests can pin the truncation boundary without a multi-KB fixture transcript. */
  maxChars?: number;
}

/** The three-line adapter: the SDK's narrow reviewer request, widened onto a real `ProviderRequest`. */
function asAdvisorReviewer(provider: Provider): AdvisorReviewer {
  return {
    generate: (input) => provider.generate({ messages: input.messages.map((m) => ({ role: m.role, content: m.content })) }),
  };
}

/**
 * NO CACHE (WS-06 §4's closing line: "the advisor and the auto-mode classifier are separate routes
 * and MUST NOT share a verdict cache"). The SDK factory memoizes nothing, and neither does this
 * wrapper -- every call re-resolves the reviewer, re-assembles the transcript and re-generates.
 */
export function createAdvisorExecutor(deps: AdvisorExecutorDeps): ToolExecutor {
  const handler = createAdvisorToolHandler({
    transcriptSource: deps.transcriptSource,
    resolveReviewer: () => {
      const resolved = deps.resolveReviewer();
      return resolved === undefined ? undefined : { provider: asAdvisorReviewer(resolved.provider), model: resolved.model };
    },
    ...(deps.maxChars === undefined ? {} : { maxChars: deps.maxChars }),
  });
  return {
    async execute(input: unknown, _ctx: ToolExecutionContext): Promise<ToolResultPayload> {
      const { text, isError } = await handler(input);
      return { output: text, ...(isError === true ? { isError: true } : {}) };
    },
  };
}

// Module-load default (T8/engine.ts replaces this per RULING R3-2): no transcript, no reviewer --
// EVERY call resolves to the ordinary "reviewer unavailable" tool error until the engine calls
// createAdvisorExecutor again with the real turn-history source and a real resolved provider/model
// pair. This default never silently "half-works": resolveReviewer always returning undefined is
// indistinguishable, from the model's point of view, from a genuinely absent reviewer -- the same
// legible failure WS-06 §4 already specifies for that case.
replaceExecutor(
  ADVISOR_TOOL_NAME,
  createAdvisorExecutor({
    transcriptSource: { getEntries: () => [] },
    resolveReviewer: () => undefined,
  }),
);
