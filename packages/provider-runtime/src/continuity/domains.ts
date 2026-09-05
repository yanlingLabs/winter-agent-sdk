// Phase 6 Lane C: continuation-domain and reasoning-evidence FACTS.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE (WS-13 §8.2, continuity report §2.5): a continuation
// domain is a first-class fact, never inferred. Two endpoints that both speak `/v1/responses` do NOT
// share state -- DeepSeek's Responses endpoint accepts `reasoning.summary` without generating one and
// has neither `include` nor `previous_response_id` -- and the SAME provider across models is not
// automatically one domain either (Anthropic documents thinking blocks as tied to the producing
// model). So "OpenAI-compatible", URL shape, provider-id equality and family equality are all
// FORBIDDEN as the capability test, and none of them appears below.
//
// WHERE THE DOMAIN ID COMES FROM, and why nothing here recomputes it. `registry.ts` derives a
// model's domain id from its descriptor's own `reasoning.continuationDomain` evidence (falling back
// to the model key, which makes an uncertified model its own single-member domain), and the runtime
// STAMPS that id onto every `origin` and every `nativeState` it produces. A second derivation here
// that differed by one rule would put the renderer and the warning matrix into direct contradiction
// -- "replayed exactly" AND "warned lossy" for the same transfer -- and, per Task 3's own lesson 8,
// it would fail on the LIVE path while resumed sessions kept working. So: one derivation, in the
// registry, read through `resolve()`; this file only ever COMPARES stamped ids.

import type { EvidenceConfidence, ReasoningCapabilities, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { WinterProviderResolutionError, type ProviderRegistry } from "../registry.ts";
import type { MessageOrigin } from "../types.ts";

/** What a readable-reasoning capability can be. Mirrors `ProviderAdapter.capabilities().readableState` and the descriptor's own evidence. */
export type ReadableState = "none" | "summary" | "full-exposed";

/**
 * One side of a transfer: who produced (or will consume) a message, and what its reasoning transport
 * can do. Built from a stamped `MessageOrigin` plus whatever the catalog knows about that model.
 */
export interface ContinuityEndpoint {
  providerId: string;
  modelKey: string;
  family: string;
  /** The STAMPED continuation-domain id. Absent means "this model's native state is not documented to be replayable anywhere" -- never "any domain". */
  continuationDomain?: string;
  /**
   * The model's reasoning TRANSPORT, straight from its descriptor. `"none"` is the fact that matters
   * here: a model with no reasoning at all has no hidden state to lose, so a switch away from it must
   * not warn about reasoning (review I1 -- `readableState: "none"` alone conflates "no readable
   * summary" with "no reasoning", and a chat model warned about losing state it never had).
   *
   * ABSENT MEANS UNKNOWN, and unknown warns: the fallback endpoint (no catalog row) cannot prove the
   * source was reasoning-free, and silence about a reasoning model is the expensive mistake.
   */
  continuation?: ReasoningCapabilities["continuation"];
  readableState: ReadableState;
  /** Whether this model documents a way to ASK for a readable summary (§9.1's proactive-summary policy). */
  summaryRequest?: { field: string; values: string[] };
}

/** The subset of an endpoint the domain test reads. Deliberately tiny: a `nativeState` and a render target are both valid arguments. */
export interface DomainFacts {
  continuationDomain?: string;
}

/**
 * Do these two sides share a continuation domain?
 *
 * TRUE requires BOTH sides to carry a stamped id AND the ids to be equal. Every other shape is false,
 * including the one that looks safest: two sides that both have NO domain id are NOT the same domain,
 * because absence means "undocumented", and two undocumented transports are not thereby the same
 * transport. Reading absence as a wildcard is how an OpenAI reasoning item would be replayed into
 * Anthropic on a session where neither model happened to carry evidence.
 *
 * There is deliberately no `providerId`/`family` argument. Adding one would make it possible to write
 * the forbidden test.
 */
export function sameDomain(a: DomainFacts | undefined, b: DomainFacts | undefined): boolean {
  const left = a?.continuationDomain;
  const right = b?.continuationDomain;
  if (left === undefined || right === undefined) return false;
  return left === right;
}

/** The evidence confidences that CERTIFY a shared continuation domain (§8.4's own word). Anything weaker is a guess, and a guess must not buy a suppressed warning. */
export const CERTIFIED_DOMAIN_CONFIDENCES: ReadonlySet<EvidenceConfidence> = new Set<EvidenceConfidence>(["verified", "declared"]);

/** Whether two sides belong to the same wire family. NEVER a substitute for `sameDomain` -- two Claude models are one family and (absent evidence) two domains. */
export function sameFamily(a: { family: string } | undefined, b: { family: string } | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.family === b.family;
}

/** The descriptor's readable-reasoning evidence, or `"none"` when it declares none. Reading a bare `supported: true` as "has a summary" would be exactly the timeless boolean WS-13 §4 forbids. */
export function readableStateOf(descriptor: WinterModelDescriptor | undefined): ReadableState {
  return descriptor?.reasoning?.readableState?.value ?? "none";
}

/** The provider's own documented summary-request field and its accepted values (Anthropic `display`, OpenAI `reasoning.summary`, Gemini `includeThoughts`). */
export function summaryRequestOf(descriptor: WinterModelDescriptor | undefined): { field: string; values: string[] } | undefined {
  return descriptor?.reasoning?.summaryRequest?.value;
}

/**
 * §9.1's proactive-summary policy: ask for a summary from session start whenever the model documents
 * HOW to ask.
 *
 * THE TEST IS `summaryRequest`, NOT `readableState`, and the difference is a live provider rather
 * than a nicety: DeepSeek's readable state is `full-exposed` (it returns `reasoning_content`) while
 * its Responses compatibility does not generate REQUESTED summaries at all -- so a policy keyed on
 * readable state asks DeepSeek for something it will never produce, on every request of the session.
 * A model with no `summaryRequest` evidence is one Winter does not know how to ask, and asking anyway
 * is the silent assumption §9.1 closes with ("do not silently assume summaries are free or
 * universally available").
 */
export function shouldRequestSummary(descriptor: WinterModelDescriptor | undefined): boolean {
  return summaryRequestOf(descriptor) !== undefined;
}

/**
 * Turns a stamped `MessageOrigin` into the full endpoint facts, through the REGISTRY.
 *
 * The registry is the only capability authority (R6-12: Lane C reads capability facts through T2's
 * registry). `resolve()` returns an ERROR OBJECT rather than throwing, and the fallback for one is
 * the stamped origin itself: a message produced by a model that has since left the catalog still
 * knows its own provider, model and domain, and degrading it to "unknown" would drop a valid native
 * replay because a catalog row was renamed.
 *
 * Cached per `modelKey` for the lifetime of the returned function: one render pass asks about the
 * same handful of models once per message, and `resolve` walks the catalog indexes each time.
 */
export function createEndpointResolver(registry: ProviderRegistry): (origin: MessageOrigin) => ContinuityEndpoint {
  const cache = new Map<string, ContinuityEndpoint>();
  return (origin: MessageOrigin): ContinuityEndpoint => {
    const cached = cache.get(origin.modelKey);
    if (cached !== undefined) return cached;
    const facts = endpointFromRegistry(registry, origin);
    cache.set(origin.modelKey, facts);
    return facts;
  };
}

function endpointFromRegistry(registry: ProviderRegistry, origin: MessageOrigin): ContinuityEndpoint {
  const resolved = registry.resolve({ model: origin.modelKey, provider: { providerId: origin.providerId } });
  if (resolved instanceof WinterProviderResolutionError) return endpointFromOrigin(origin);
  const descriptor = resolved.descriptor;
  const summaryRequest = summaryRequestOf(descriptor);
  // Review I2: an id derived from `inferred`/`unknown`-confidence evidence is a GUESS that a domain
  // is shared, and §8.4 suppresses the warning only for a CERTIFIED one. The gate is applied on the
  // SOURCE side, in the safe direction: an uncertified claim yields no domain id at all, so the
  // native state is stripped and the switch warns. (The asymmetry against the bridge's
  // `target.continuationDomain`, which the registry computes ungated, is deliberate and disclosed --
  // it can only ever cause MORE stripping, never less.)
  const domain = certifiedDomain(resolved.continuationDomain, descriptor);
  return {
    providerId: resolved.providerId,
    modelKey: resolved.modelKey,
    family: origin.family,
    // The registry's OWN id wins over the stamped one when both exist -- a catalog refresh that
    // certifies a new domain should take effect for messages already in the history, which is the
    // §9.7 "returning to an earlier provider" case seen from the other side.
    ...(domain !== undefined
      ? { continuationDomain: domain }
      : resolved.continuationDomain === undefined && origin.continuationDomain !== undefined
        ? { continuationDomain: origin.continuationDomain }
        : {}),
    // A descriptor with no `reasoning` block at all is a POSITIVE fact -- this model does not reason
    // -- and is recorded as `"none"`. Only a resolution with no descriptor leaves it unknown.
    ...(descriptor !== undefined ? { continuation: descriptor.reasoning?.continuation ?? "none" } : {}),
    readableState: readableStateOf(descriptor),
    ...(summaryRequest !== undefined ? { summaryRequest } : {}),
  };
}

/**
 * Applies the certification rule to a derived domain id -- as TWO SEPARATE QUESTIONS, because they
 * are two different claims and only one of them needs certifying.
 *
 *   SELF-REPLAY  ("this model accepts its own state")  -- never needs certification. A model
 *                replaying what it just produced is not an interoperability claim at all, so no
 *                amount of weak evidence can make it wrong.
 *   PAIR-SHARING ("these models accept each other's state") -- always needs it. That is the claim
 *                §8.4 calls certified, and the one a guess must never buy.
 *
 * ROUND 2's CRITICAL WAS THE COST OF CONFLATING THEM. The round-1 gate kept the key-derived id only
 * when a row carried NO domain evidence -- and every `opaque-provider-state` row in the shipped
 * catalog carries a single-member list naming ITSELF at `confidence: "unknown"`, so the carve-out
 * never fired on a real row. Five of the six reasoning models in the product lost same-model native
 * replay, while `classifySwitch(X, X)` went on reporting `lossless-native` with zero warnings: a
 * lossless claim standing beside real loss, on every leg, with no switch involved. Testing the
 * MEMBER LIST rather than the derived id is what separates the two claims -- see the `[a, b]` case
 * below for why id equality is not good enough.
 */
function certifiedDomain(domain: string | undefined, descriptor: WinterModelDescriptor | undefined): string | undefined {
  if (domain === undefined) return undefined;
  const evidence = descriptor?.reasoning?.continuationDomain;
  // No evidence at all: the registry fell back to the model's own key. A self identity, certified by
  // construction.
  if (evidence === undefined) return domain;
  // A certified claim rides as-is, however many members it names.
  if (CERTIFIED_DOMAIN_CONFIDENCES.has(evidence.confidence)) return domain;

  // Uncertified. A list naming exactly this model and nothing else is a SELF claim wearing an
  // evidence wrapper -- it asserts no sharing, so there is nothing to certify and the id stands.
  //
  // THE TEST IS THE LIST, NOT `domain === descriptor.key`, and the difference is a real hole: the
  // registry derives the id as the alphabetically first member, so an uncertified `openai/o-a` whose
  // list is `["openai/o-a", "openai/o-b"]` ALSO derives `"openai/o-a"` -- equal to its own key. Under
  // an id-equality test it would survive and then pair with a CERTIFIED `openai/o-b` that derives the
  // same id, and the guess would have bought exactly the shared domain this gate exists to refuse.
  const key = descriptor?.key;
  if (key !== undefined && evidence.value.length === 1 && evidence.value[0] === key) return key;

  // An uncertified MULTI-member list is a sharing claim with no evidence behind it: refused, so the
  // state is stripped and the switch warns. Self-replay for such a row is collateral (the bridge
  // computes the TARGET's id from the ungated registry, so the two sides disagree) -- no row in the
  // shipped catalog has this shape, and the honest fix is upstream: evidence that names more than one
  // model should be `declared` at least, since somebody had to decide the models belong together.
  return undefined;
}

/** The registry-free fallback: everything the stamp itself carries, and `readableState: "none"` because absence of evidence is not evidence of a summary. */
export function endpointFromOrigin(origin: MessageOrigin): ContinuityEndpoint {
  return {
    providerId: origin.providerId,
    modelKey: origin.modelKey,
    family: typeof origin.family === "string" ? origin.family : String(origin.family),
    ...(origin.continuationDomain !== undefined ? { continuationDomain: origin.continuationDomain } : {}),
    readableState: "none",
  };
}
