// Phase 6 Task 8 (Lane D, R6-14 / WS-07 §10.6-3/-4/-5): the real model-routed classifier.
//
// P2 shipped `alwaysNoVerdictClassifier` — a deliberate, permanent fail-closed stub — and named this
// file's job in its own header: "The real model-routed classifier is P6/D13's job". This is it.
//
// WHY IT LIVES RUNTIME-SIDE AND NOT IN `provider-runtime`. `ClassifierInterface` is declared in
// `permissions/auto/engine.ts`, and R6-4 makes the dependency strictly runtime -> provider-runtime.
// A classifier in the adapter package could not name the interface it implements. So it sits here,
// takes the ENGINE's `Provider` seam (the same one the agent loop drives), and is therefore
// indifferent to which family answers it — a scripted double in a fixture and a live adapter behind
// `adapterAsProvider` are the same shape to this file.
//
// THE CONTRACT, restated because every line below serves it (WS-07 §10.6-5): "extra/unparseable
// output, timeout, refusal, transport failure → `no_verdict` → fail closed". `classify()` therefore
// NEVER throws and NEVER rejects. Every failure mode is a `no_verdict` carrying the reason code that
// says which one it was — because `AutoEngine` treats a rejection as a bug (it would propagate out of
// `evaluate()` and take down the tool call with an unhandled error) while it treats `no_verdict` as
// a decision, and the decision is the one this file is responsible for producing.
//
// R6-G: an auxiliary generation. `sink` is OMITTED, never set to `undefined` — the engine's own
// comment on `ProviderRequest.sink` is explicit that absence is what marks a call auxiliary, and
// `stream_event` frames from a permission review would be frames the pinned runtime does not emit.
import type { AutoClassifierConfig, CredentialRef } from "@yanlinglabs/winter-agent-sdk";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import type { ClassifierContext, ClassifierInterface, ClassifierRawResult } from "../../permissions/auto/engine.ts";
import type { ActionEnvelope } from "../../permissions/auto/envelope.ts";
import type { Provider, ProviderRequest, ProviderTurn } from "../../engine.ts";
import { buildClassifierPrompt, CLASSIFIER_SYSTEM_PROMPT, type ClassifierPromptResult } from "./prompt.ts";
import { CLASSIFIER_TOOL_NAME, classifierVerdictToolSpec, noVerdict, parseClassifierVerdict, type ClassifierNoVerdictReason } from "./verdict-schema.ts";

/**
 * A DISCLOSED Winter default (no pinned counterpart — §10 documents no timeout).
 *
 * 15 s is chosen against what the failure costs rather than against a model's latency: every
 * expiry is a fail-closed denial the user then has to resolve by hand, so a value too low turns a
 * slow provider into a broken session, while a value too high makes a hung classifier feel like a
 * hung agent. A host that knows its route can pass its own.
 */
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 15_000;

export interface ModelClassifierOptions {
  /** The engine `Provider` seam. A scripted double in a fixture, `adapterAsProvider(...)` in production — this file cannot tell them apart, which is the point. */
  provider: Provider;
  /** The classifier's OWN model, pinned per session and independent of the worker model (§10.6-4). */
  model: string;
  timeoutMs?: number;
  /** P2 carry: the app-owned accumulated-context bound. See `prompt.ts`'s `DEFAULT_MAX_CONTEXT_CHARS`. */
  maxContextChars?: number;
  /** P7a fix wave (item 5, M-1): the running brand's instructions file, so the classifier prompt labels the operator's own file correctly. */
  instructionsFile?: string;
  /**
   * Test seam: observes what was actually sent and what came back, WITHOUT the classifier logging
   * anything itself. Nothing in this file writes to a log — a permission review's request contains
   * the envelope, and the envelope contains file paths and command lines.
   */
  onRequest?: (info: { request: ProviderRequest; prompt: ClassifierPromptResult }) => void;
}

/**
 * `createModelClassifier` — one forced tool call, one verdict, every failure collapsed.
 */
export function createModelClassifier(opts: ModelClassifierOptions): ClassifierInterface {
  const timeoutMs = opts.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_CLASSIFIER_TIMEOUT_MS;

  return {
    async classify(envelope: ActionEnvelope, context: ClassifierContext): Promise<ClassifierRawResult> {
      const prompt = buildClassifierPrompt(envelope, context, {
        ...(opts.maxContextChars !== undefined ? { maxContextChars: opts.maxContextChars } : {}),
        ...(opts.instructionsFile !== undefined ? { instructionsFile: opts.instructionsFile } : {}),
      });
      const controller = new AbortController();
      const request: ProviderRequest = {
        messages: [{ role: "user", content: prompt.text }],
        system: CLASSIFIER_SYSTEM_PROMPT,
        model: opts.model,
        tools: [classifierVerdictToolSpec()],
        // §10.6-5's "strict result schema" enforced at the provider's own structured-output layer:
        // the model is not asked to choose whether to answer, only what the answer is.
        toolChoice: { type: "tool", name: CLASSIFIER_TOOL_NAME },
        signal: controller.signal,
        // NO `sink` KEY (R6-G). Deliberately not `sink: undefined` — `exactOptionalPropertyTypes`
        // would accept it and the request would then be indistinguishable from a streamed one to a
        // consumer testing `"sink" in req`.
      };
      opts.onRequest?.({ request, prompt });

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A RACE, not merely the abort signal. The signal is honoured by a real adapter, but this
        // classifier's contract is to answer within its own budget REGARDLESS of whether the
        // provider it was handed honours cancellation at all — a double that ignores `signal`, or an
        // adapter with a bug, would otherwise hang a permission decision forever. The abort is still
        // sent, so a cooperative adapter also stops doing work.
        const generation = opts.provider.generate(request);
        // The losing side of the race is abandoned; without this its later rejection would surface as
        // an unhandled promise rejection long after the verdict was returned.
        generation.catch(() => {});
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        const outcome = await Promise.race([generation, timeout]);
        if (outcome === "timeout") {
          controller.abort();
          return noVerdict("timeout");
        }
        return collapseTurn(outcome);
      } catch {
        // Every throw is the same answer, and the error itself is DISCARDED rather than logged or
        // attached: a provider error can quote a request body, and this request body is the action
        // envelope. The reason code says "the provider failed"; the audit stream is not the place to
        // learn how.
        return noVerdict("provider_error");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

/** The turn -> verdict collapse, as a table. One arm per way a turn can fail to be an answer, each with its own reason code. */
function collapseTurn(turn: ProviderTurn): ClassifierRawResult {
  // Checked FIRST, and on every kind: §10.6-5 names "safety refusal" as its own arm, and a refusal
  // that also happened to carry a tool call is still a refusal to review.
  if ("stopReason" in turn && turn.stopReason === "refusal") return noVerdict("refusal");
  if (turn.kind === "text") return noVerdict("no_tool_call");
  // The `unexpected_turn` arm used to live here for the engine's `rpc_probe` kind, which T10 removed
  // (R6-13). Its reason CODE went with it, and deliberately: `model-classifier.test.ts`'s own
  // "every declared reason code is reachable" test is what keeps this vocabulary honest, and a
  // member nothing can produce is exactly the lie that test exists to catch. A future turn kind that
  // needs one adds it back with the arm that reaches it.
  if (turn.calls.length === 0) return noVerdict("no_tool_call");
  if (turn.calls.length > 1) return noVerdict("multiple_calls");
  const call = turn.calls[0]!;
  if (call.name !== CLASSIFIER_TOOL_NAME) return noVerdict("wrong_tool");
  const parsed = parseClassifierVerdict(call.input);
  return parsed.ok ? parsed.result : noVerdict(parsed.reasonCode);
}

// -------------------------------------------------------------------------------------------------
// Route selection (R6-14). PURE — it decides WHICH classifier a session should get; T10 wires the
// decision into a real provider and records the session pin (`classifierPin` on the dialect record
// plus a `fallback_state` audit event), which needs session state this function deliberately has none
// of.
// -------------------------------------------------------------------------------------------------

export type ClassifierRoute =
  /** `config.autoClassifier` named a model. It resolves through the SAME selection path as the session model (§10.6-4: "chosen via WS-13"). */
  | { kind: "configured"; model: string; authRef?: CredentialRef }
  /** No route configured, and the worker model itself clears the bar in R6-14. */
  | { kind: "worker-eligible" }
  /** Neither. §10.6-4: "otherwise fall back to Manual, never silently weaken." */
  | { kind: "manual-fallback"; reason: string };

/** The narrow shape this needs from a session config. Structural so `RuntimeConfig` satisfies it and a fixture need not build one. */
export interface ClassifierRouteConfig {
  model?: string;
  autoClassifier?: AutoClassifierConfig;
}

/**
 * R6-14's route rule, and it is a ONE-WAY door: a session either gets a classifier it has real
 * evidence for, or it gets Manual.
 *
 * The worker-eligible bar is `structuredOutput.confidence === "verified"` AND `classifierEligible`.
 * Both halves are required and neither is a formality:
 *
 *   - `structuredOutput` verified means someone OBSERVED this model honour a forced tool schema. On
 *     today's seed catalog every `structuredOutput` row is `inferred`, so nothing is worker-eligible
 *     — which is the correct state, not a gap: an inferred capability is a guess, and a guess about
 *     schema adherence is a guess about whether the security reviewer can be parsed at all.
 *   - `classifierEligible` is set only after the safety corpus passes LIVE against that model
 *     (R6-14's own wording, and the descriptor field's own comment). It is the evidence that the
 *     model answers the security questions correctly, which schema adherence says nothing about.
 *
 * TIGHTENED, deliberately, past the ruling's literal wording: `structuredOutput.value === true` is
 * required as well as its confidence. A `verified` claim that the model does NOT support structured
 * output is verified evidence AGAINST eligibility, and reading the confidence without the value
 * would turn it into evidence for. Strictness only; disclosed in the task report.
 */
export function selectClassifierRoute(config: ClassifierRouteConfig, descriptorOf: (modelKey: string) => WinterModelDescriptor | undefined): ClassifierRoute {
  const configured = config.autoClassifier;
  if (configured !== undefined && configured.model.trim().length > 0) {
    return { kind: "configured", model: configured.model, ...(configured.authRef !== undefined ? { authRef: configured.authRef } : {}) };
  }

  const workerModel = config.model;
  if (workerModel === undefined || workerModel.trim().length === 0) {
    return { kind: "manual-fallback", reason: "no classifier route is configured and this session has no worker model to fall back to" };
  }
  const descriptor = descriptorOf(workerModel);
  if (descriptor === undefined) {
    return { kind: "manual-fallback", reason: `no classifier route is configured and no catalog descriptor is known for the worker model "${workerModel}", so its structured-output and classifier evidence cannot be read` };
  }
  const structured = descriptor.structuredOutput;
  if (structured === undefined || structured.value !== true || structured.confidence !== "verified") {
    return {
      kind: "manual-fallback",
      reason: `no classifier route is configured and the worker model "${descriptor.key}" does not carry VERIFIED structured-output evidence (${structured === undefined ? "no evidence at all" : `value=${String(structured.value)}, confidence=${structured.confidence}`}); Winter falls back to Manual rather than trusting an unverified reviewer`,
    };
  }
  if (descriptor.classifierEligible?.value !== true) {
    return {
      kind: "manual-fallback",
      reason: `no classifier route is configured and the worker model "${descriptor.key}" is not marked \`classifierEligible\` (set only after the safety corpus passes live), so it may not review its own actions`,
    };
  }
  return { kind: "worker-eligible" };
}

export type { ClassifierNoVerdictReason };
