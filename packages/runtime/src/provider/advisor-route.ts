// P7a LANE B (D29/D30, WS-06 §4's advisor amendment; WS-13's "Execution amendments — advisor
// route"): WHICH MODEL THE ADVISOR CONSULTS.
//
// The advisor tool is parameterless. The model it reviews with is therefore never something the
// worker model asks for — it is resolved, per session, from three sources in a fixed order:
//
//   1. `Options.advisor.model`     — the host said so on the wire (`RuntimeConfig.advisor.model`).
//   2. `settings.advisor.model`    — the USER said so in settings (hot; user/local/trusted-project).
//   3. the per-family DEFAULT      — D30: a `gpt` session -> `astra`, a `claude` session -> `fable`,
//                                    any other family -> that family's slot 1, a family with no
//                                    slots -> the session's own model.
//
// PRECEDENCE IS NOT A FALLBACK CHAIN, and that distinction is the whole of WS-13 §9 in this file.
// The first source that STATES a value is the only source consulted: a stated value that cannot be
// resolved is a REFUSAL naming what would have served it, never a quiet slide down to the next
// source. Falling through from an unresolvable `settings.advisor.model` to the family default would
// send this session's own conversation to a model the user did not choose and never be told about
// it — which is exactly the silent substitution the spec family forbids, with the transcript as the
// payload rather than a token bill.
//
// EVERY candidate — a slot name, a canonical model id, or a full `<providerId>/<model>` catalog key
// — is resolved through the ONE slot resolver (WS-13c §4, `slots.ts`'s `resolveSlotToProvider`), so
// the advisor obeys the same credential filter, the same `providers.<id>.enabled` gate and the same
// subscription-first vendor order the session's own model does. A second resolution path here is
// how the advisor would start choosing a provider `set_model` would refuse.
//
// PURE. No credential store, no provider construction, no I/O: this function answers "which row",
// and `session-provider.ts`'s advisor block turns that answer into a `Provider` under Ruling E-1's
// credential rule. That split is what makes "typed refusal, NO REQUEST" structural rather than
// careful — a refusal never reaches a code path that could build a provider at all.
import type { ProviderAuthKind, WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { CLAUDE_FAMILY_ID, familyOfModelKey } from "@yanlinglabs/winter-provider-catalog";
import type { SlotProviderResolution } from "./slots.ts";

/**
 * D30's per-family defaults, as the spec NAMES them rather than as "slot 1".
 *
 * Both happen to be slot 1 of their family in the shipped catalog, and that is a coincidence this
 * table refuses to rely on: D30 pins `astra` for a gpt session and `fable` for a claude session by
 * NAME, so a future re-ranking of a family's slots (which is a curation decision about the Agent
 * tool's option order, WS-13c §2 — "position is NOT a strength claim") must not silently move the
 * reviewer. Every OTHER family follows the ranked order, because that is all D30 says about them.
 */
const ADVISOR_FAMILY_DEFAULTS: Readonly<Record<string, string>> = {
  gpt: "astra",
  [CLAUDE_FAMILY_ID]: "fable",
};

/**
 * WS-13c §6 / D30: the credential kinds that may serve a CLAUDE-family reviewer on the Winter branch.
 *
 * D13/D14: a claude.ai SUBSCRIPTION OAuth login is not a Winter credential kind at all — it appears
 * in no provider row's `authKinds`, no adapter has an arm for it, and `console-oauth.ts` records by
 * name that the consumer authorize host is deliberately absent from every constant. So the honest
 * enforcement is not "detect a claude.ai token" (there is nothing to detect); it is that a claude
 * row is only ever reached through a path Winter can actually authenticate: the vendor's own
 * `anthropic` row on an API key or a Console OAuth token (`api-key` / `oauth-approved`), or one of
 * the other providers WS-13c §6 explicitly admits for a claude slot — Vertex, Bedrock and the
 * aggregators (`cloud-credential-chain` / `api-key`).
 *
 * `local-none` and `custom` are OUT. Neither names a credential Winter holds: `custom` is the
 * catalog's own "authenticated by something outside this vocabulary", and a keyless row claiming to
 * serve a Claude model is claiming something Anthropic does not sell. The refusal is typed and
 * happens BEFORE any provider is built, so nothing is ever sent to such a row.
 *
 * This gate is CLAUDE-ONLY on purpose. It is D13/D14's rule, which is about one vendor's consumer
 * login; widening it to every family would refuse local models for reasons that have nothing to do
 * with them.
 */
const WINTER_CLAUDE_REVIEWER_AUTH_KINDS: readonly ProviderAuthKind[] = ["api-key", "oauth-approved", "cloud-credential-chain"];

export interface AdvisorRouteInput {
  catalog: WinterCatalog;
  /** The session's LIVE effective model key (the engine's, not the wiring's start snapshot). Undefined for a session with no resolvable model. */
  sessionModelKey: string | undefined;
  /** `Options.advisor.model` / `RuntimeConfig.advisor.model`. */
  optionModel?: string;
  /** `settings.advisor.model`, read through the LIVE settings getter (hot, D30). */
  settingModel?: string;
  /** WS-13c §4, one argument: the slot layer already knows the session's model key. */
  resolveSlot: (requested: string) => SlotProviderResolution;
}

export type AdvisorRoute =
  | { ok: true; modelKey: string; providerId: string; source: "option" | "setting" | "family-default" | "own-model" }
  | { ok: false; reason: string };

/** The precedence step that named a candidate, and what it named. `undefined` = nothing states one. */
interface AdvisorCandidate {
  requested: string;
  source: "option" | "setting" | "family-default" | "own-model";
  /** How the refusal describes where this value came from, so the user knows WHICH knob to fix. */
  origin: string;
}

/** A settings/option value counts as STATED only when it is a non-blank string (an empty one is not a choice). */
function stated(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The ONE candidate this session's advisor uses, per D30's precedence.
 *
 * Exported for the tests that pin the precedence independently of whether a candidate happens to
 * RESOLVE — the two questions are separate, and conflating them is how a "default" test can pass
 * while precedence is broken.
 */
export function selectAdvisorCandidate(input: Pick<AdvisorRouteInput, "catalog" | "sessionModelKey" | "optionModel" | "settingModel">): AdvisorCandidate | undefined {
  const option = stated(input.optionModel);
  if (option !== undefined) return { requested: option, source: "option", origin: "`Options.advisor.model`" };
  const setting = stated(input.settingModel);
  if (setting !== undefined) return { requested: setting, source: "setting", origin: "`settings.advisor.model`" };

  const family = input.sessionModelKey !== undefined ? familyOfModelKey(input.catalog, input.sessionModelKey) : undefined;
  if (family !== undefined) {
    const pinned = ADVISOR_FAMILY_DEFAULTS[family.id];
    if (pinned !== undefined) return { requested: pinned, source: "family-default", origin: `the ${family.id}-family default (D30)` };
    const first = family.slots[0];
    if (first !== undefined) return { requested: first.name, source: "family-default", origin: `the ${family.id} family's first slot (D30)` };
  }
  // D30's last clause: a family with no slots (and a model in no family at all) reviews with the
  // session's OWN model. It goes through the resolver like every other candidate — a full catalog
  // key passes `resolveSlotToProvider`'s qualified-key door unfiltered, which is the same treatment
  // the session's own model gets everywhere else.
  if (input.sessionModelKey !== undefined) return { requested: input.sessionModelKey, source: "own-model", origin: "the session's own model (this family curates no slots)" };
  return undefined;
}

/**
 * WS-06 §4 / D30: the reviewer this session's advisor consults, or a typed reason it has none.
 *
 * NEVER A SUBSTITUTION. Three shapes of "no": nothing states a candidate at all; the stated
 * candidate does not resolve (the slot layer's own `slot-unservable`/`ambiguous-slot-name`/
 * `unknown-slot` message rides through verbatim, because it already names every row that WOULD have
 * served it and why each did not); or the resolved row is a Claude row Winter cannot authenticate.
 */
export function resolveAdvisorRoute(input: AdvisorRouteInput): AdvisorRoute {
  const candidate = selectAdvisorCandidate(input);
  if (candidate === undefined) {
    return {
      ok: false,
      reason:
        "no reviewer model is resolvable for this session: nothing sets `Options.advisor.model` or `settings.advisor.model`, and this session has no effective model to derive a per-family default from",
    };
  }

  const resolution = input.resolveSlot(candidate.requested);
  if (!resolution.ok) {
    return { ok: false, reason: `the advisor's reviewer "${candidate.requested}" (from ${candidate.origin}) does not resolve: ${resolution.message}` };
  }

  // The CLAUDE gate, on the row that actually won §4's ordering rather than on the request — an
  // aggregator can serve a claude canonical id, and it is that row's own `authKinds` that decide.
  const row = input.catalog.models.find((m) => m.key === resolution.modelKey);
  if (row?.modelFamily === CLAUDE_FAMILY_ID) {
    const provider = input.catalog.providers.find((p) => p.id === resolution.providerId);
    const kinds = provider?.authKinds ?? [];
    if (!kinds.some((kind) => WINTER_CLAUDE_REVIEWER_AUTH_KINDS.includes(kind))) {
      return {
        ok: false,
        reason:
          `the advisor's reviewer "${candidate.requested}" (from ${candidate.origin}) resolves to ${resolution.modelKey}, a Claude model served by "${resolution.providerId}", ` +
          `whose credential kinds (${kinds.length > 0 ? kinds.join(", ") : "none declared"}) are not ones Winter can authenticate a Claude reviewer with — ` +
          `a Claude reviewer on the Winter branch resolves only through an API key, an Anthropic Console OAuth login, or a cloud credential chain (WS-13c §6, D13/D14); ` +
          "no request was made",
      };
    }
  }

  return { ok: true, modelKey: resolution.modelKey, providerId: resolution.providerId, source: candidate.source };
}
