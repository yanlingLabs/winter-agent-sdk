// FILLED BY LANE A (P6.6). The signatures are the spine's pinned cross-lane contract; the bodies
// and the two additive fields documented below are Lane A's.
//
// WS-13c §3/§4: which slots a session ADVERTISES, how they render into the Agent tool, and how a
// slot name becomes a concrete provider + model key.
//
// NEVER A SILENT SUBSTITUTION (WS-13 §9, WS-13c §3-§4). Every failure here is typed and names what
// would have served: "it did not work", "you have no OpenAI key" and "two families call a model
// `flash`" are three different problems for the user, and collapsing them into one refusal (or, far
// worse, into a quiet resolution onto a model nobody asked for) is the exact behaviour the whole
// spec family forbids.
import type { FamilySlot, ModelFamilyDescriptor, WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { CLAUDE_FAMILY_ID, OTHER_FAMILY_ID, SLOT_NAME_RE, canonicalModelIdOf, familyOfModelKey, resolveSlotName, rowsForCanonicalId } from "@yanlinglabs/winter-provider-catalog";
import type { ActiveSlotSet, ModelSlotSetting, SlotView } from "@yanlinglabs/winter-agent-sdk";

/**
 * The marker the Agent descriptor's static description carries, and the block it lives in.
 *
 * DECLARED HERE rather than in `tools/descriptors/agent.ts` on purpose: the engine has to strip the
 * block when no active slot set is wired, and importing the descriptor module for a string would
 * run its `stub(...)` registration as a side effect of loading the engine. This module has no side
 * effects at all, so both ends can name the same constant.
 */
export const AGENT_MODEL_SLOTS_MARKER = "{{MODEL_SLOTS}}";
export const AGENT_MODEL_SLOTS_BLOCK = `\n\nModel options for this session:\n${AGENT_MODEL_SLOTS_MARKER}`;
/**
 * The WS-06 canonical name of the one tool whose schema is rendered per family.
 *
 * Declared beside the marker for the same reason: the engine needs to recognise the descriptor and
 * cannot import the descriptor (or the executor) module for a string without taking its
 * registration side effects. `descriptors/agent.ts` and `tools/impl/agent.ts` both read it from
 * here, so the name has one producer rather than three spellings that could drift.
 */
export const AGENT_TOOL_CANONICAL_NAME = "Agent";

export interface ActiveSlotSetInput {
  catalog: WinterCatalog;
  currentModelKey: string | undefined;
  customSlots: readonly ModelSlotSetting[] | undefined;
}

function toView(slot: FamilySlot): SlotView {
  return { name: slot.name, canonicalModelId: slot.canonicalModelId, description: slot.description, reason: slot.reason };
}

/** A `ModelSlotSetting.model` is a canonical id OR a catalog key (both are things a user has to hand). */
function canonicalIdOfSetting(catalog: WinterCatalog, model: string): string {
  return catalog.models.find((m) => m.key === model)?.canonicalModelId ?? model;
}

/**
 * Winter's own description for a canonical model, wherever a family happens to curate one.
 *
 * SEARCHES EVERY FAMILY, not the active one. D27's own example is a cross-family set (Astra / Opus /
 * Sonnet / Luna), so a lookup confined to the session's family would drop Winter's text for exactly
 * the models a custom set borrows and fall through to the row's bare `displayName`.
 */
function curatedSlotFor(families: readonly ModelFamilyDescriptor[], canonicalModelId: string): FamilySlot | undefined {
  for (const family of families) for (const slot of family.slots) if (slot.canonicalModelId === canonicalModelId) return slot;
  return undefined;
}

/**
 * The slots this session offers (WS-13c §3).
 *
 * TOTAL BY CONSTRUCTION — it never throws. It is called on every turn to render the Agent tool, and
 * a session whose model failed to resolve (or one running a scripted double, or one on an
 * `allowUnlisted` pass-through with no catalog row) still renders tools. An exception here would
 * take down the tool advertisement itself, which is a strictly worse answer than an honest
 * `own-model` set naming the model the session is actually on.
 */
export function computeActiveSlotSet(input: ActiveSlotSetInput): ActiveSlotSet {
  const { catalog, currentModelKey, customSlots } = input;
  const family = currentModelKey !== undefined ? familyOfModelKey(catalog, currentModelKey) : undefined;

  // D25, and it is FIRST because it is unconditional: a Claude session advertises exactly the four
  // pinned names with Winter's Claude descriptions, whatever the settings say. The `modelSlots`
  // ignore is RECORDED by the wiring (`modelSlotsIgnored: "claude-pinned"`), not swallowed here.
  if (family !== undefined && family.id === CLAUDE_FAMILY_ID) {
    return { family: CLAUDE_FAMILY_ID, source: "claude-pinned", slots: family.slots.map(toView) };
  }

  if (customSlots !== undefined && customSlots.length > 0) {
    return {
      family: family?.id ?? OTHER_FAMILY_ID,
      source: "custom",
      slots: customSlots.map((custom) => {
        const canonicalModelId = canonicalIdOfSetting(catalog, custom.model);
        const curated = curatedSlotFor(catalog.families, canonicalModelId);
        const row = catalog.models.find((m) => m.canonicalModelId === canonicalModelId);
        return {
          name: custom.name,
          canonicalModelId,
          // §5's precedence, verbatim: the user's own description, else Winter's slot description for
          // that canonical model, else the row's displayName.
          description: custom.description ?? curated?.description ?? row?.displayName ?? canonicalModelId,
          reason: "custom slot",
        };
      }),
    };
  }

  if (family !== undefined && family.slots.length > 0) {
    return { family: family.id, source: "family-default", slots: family.slots.map(toView) };
  }

  // §3's minimum of one: a family with no curated slots (or `other`) renders the session's OWN
  // effective model, named by its canonical id.
  const row = currentModelKey !== undefined ? catalog.models.find((m) => m.key === currentModelKey) : undefined;
  const canonicalModelId = row?.canonicalModelId ?? (currentModelKey !== undefined ? canonicalModelIdOf(stripProviderPrefix(currentModelKey)) : undefined);
  if (canonicalModelId === undefined) {
    // No effective model at all. An EMPTY set, not a fabricated one — the engine keeps the Agent
    // descriptor's static default rather than advertising an enum with nothing in it.
    return { family: family?.id ?? OTHER_FAMILY_ID, source: "own-model", slots: [] };
  }
  const name = ownModelSlotName(canonicalModelId);
  if (name === undefined) {
    // No legal token can be derived. An EMPTY set rather than an illegal one: the engine keeps the
    // Agent descriptor's static default and strips the marker block, which is a truthful "this
    // session has no curated options" — an enum entry the grammar forbids would not be.
    return { family: family?.id ?? OTHER_FAMILY_ID, source: "own-model", slots: [] };
  }
  // R-6c-26: an UNCATALOGUED model (an `allowUnlisted` / custom-base-URL session, which WS-13
  // supports on purpose) has no rows for its canonical id, so §4's candidate search finds nothing and
  // the ONE option this session advertises would refuse `slot-unservable` every single time. The
  // spine's `SlotView.resolvesTo` is exactly the field for "this slot already knows what it is": the
  // session's own key, on the session's own provider. `resolveSlotToProvider` honours it verbatim,
  // unfiltered, for the same reason a full catalog key passes through unfiltered — the registry and
  // the child's own provider resolution already judge it, and judging it twice, differently, is how
  // an advertised option becomes untakeable.
  const ownProviderId = row === undefined && currentModelKey !== undefined ? providerPrefixOf(currentModelKey) : undefined;
  return {
    family: family?.id ?? OTHER_FAMILY_ID,
    source: "own-model",
    slots: [
      {
        name,
        canonicalModelId,
        description: row?.displayName ?? canonicalModelId,
        reason: "the session's own model (no curated slots for this family)",
        ...(ownProviderId !== undefined && currentModelKey !== undefined ? { resolvesTo: { providerId: ownProviderId, key: currentModelKey } } : {}),
      },
    ],
  };
}

/** `<providerId>/<rest>` -> `<rest>`, first slash only (a gateway's own upstream id is slash-bearing). */
function stripProviderPrefix(modelKey: string): string {
  const slash = modelKey.indexOf("/");
  return slash > 0 ? modelKey.slice(slash + 1) : modelKey;
}

/** The provider half of a catalog key, or `undefined` for a bare id (which names no provider). */
function providerPrefixOf(modelKey: string): string | undefined {
  const slash = modelKey.indexOf("/");
  return slash > 0 ? modelKey.slice(0, slash) : undefined;
}

/**
 * A canonical id turned into a LEGAL slot token, or `undefined` when it cannot be (R-6c-26).
 *
 * The own-model slot is the one place a slot name is DERIVED rather than authored, so it is the one
 * place the pinned grammar (`SLOT_NAME_RE`) can be broken: a gateway-nested id keeps a `/`
 * (`openrouter/some-vendor/unlisted-thing` -> `some-vendor/unlisted-thing`) and a non-size Ollama tag
 * keeps a `:` (`llama3.1:latest`) — both of which the normaliser deliberately leaves alone, because
 * they are part of the model's real identity. They are not part of an ENUM TOKEN, though: the token
 * is what a model types into `AgentInput.model`, and the catalog's own integrity rule is that every
 * slot name matches the grammar.
 *
 * Every path segment before the last is dropped and everything from the first `:` is cut; the
 * canonical id itself is untouched (it stays the model's identity on the `SlotView`). `undefined`
 * when nothing legal survives — the caller then advertises NO slot rather than an illegal one.
 */
function ownModelSlotName(canonicalModelId: string): string | undefined {
  const lastSegment = canonicalModelId.slice(canonicalModelId.lastIndexOf("/") + 1);
  const colon = lastSegment.indexOf(":");
  const name = (colon >= 0 ? lastSegment.slice(0, colon) : lastSegment).toLowerCase().slice(0, 32);
  return SLOT_NAME_RE.test(name) ? name : undefined;
}

/**
 * The two things the Agent tool renders from the active set (WS-13c §3): the `model` property's
 * `enum` (slot names in order) and one description line per slot, appended to the tool description
 * as `<name> — <canonicalModelId>: <description> (<reason>)`.
 *
 * The tool SHAPE never changes — only these two.
 */
export function renderAgentModelSchema(active: ActiveSlotSet): { enum: string[]; descriptionLines: string[] } {
  return {
    enum: active.slots.map((s) => s.name),
    descriptionLines: active.slots.map((s) => `${s.name} — ${s.canonicalModelId}: ${s.description} (${s.reason})`),
  };
}

/**
 * WS-13c §4 step 2, as three states rather than two (R-6c-27).
 *
 * `CredentialStore.get` is asynchronous (a Keychain read) while this whole resolver is synchronous,
 * so a caller genuinely cannot always answer. Collapsing that to `true` made a COLD subscription row
 * win §4 step 3-i over a WARM token row the user actually has — an openai-API-key-only session's
 * first `Agent(model: "astra")` chose `codex-oauth`, and `set_model` reported success and only failed
 * at the next generation. Collapsing it to `false` is worse: it writes "no credential configured"
 * into a `wouldServe` line about a provider that may well be configured, which is a false statement
 * about the user's setup rather than a missing one.
 *
 * So: `absent` filters the row out and names the reason; `unknown` keeps it, but orders it AFTER
 * every `present` row in the same §4 tier.
 */
export type CredentialPresence = "present" | "absent" | "unknown";

export interface SlotProviderResolutionInput {
  catalog: WinterCatalog;
  active: ActiveSlotSet;
  requested: string;
  hasCredential: (providerId: string) => CredentialPresence;
  providerEnabled: (providerId: string) => boolean;
  preferredProviders: readonly string[];
  /**
   * LANE A ADDITION to the spine's pinned input (optional, so every pinned call site still compiles).
   *
   * `ActiveSlotSet`/`SlotView` are the PUBLIC, host-facing shapes and carry no `provider` field, so a
   * custom slot's pin (`modelSlots[].provider`, WS-13c §4 step 4) has nowhere to ride into this
   * function. Without it a pinned slot would resolve to whatever step 3 ordered first — a silent
   * substitution of one provider for another, which is the single thing §4 step 4 exists to prevent.
   * Matched BY NAME (a validated set has unique names), never by index.
   */
  customSlots?: readonly ModelSlotSetting[];
}

export type SlotProviderResolution =
  | {
      ok: true;
      modelKey: string;
      providerId: string;
      canonicalModelId: string;
      slot: { family: string; name: string; source: ActiveSlotSet["source"] };
      /**
       * LANE A ADDITION: TRUE when `requested` was a slot NAME.
       *
       * A full catalog key or a canonical id passes through (§3: "`AgentInput.model` is slot names
       * only" governs what the MODEL is offered; a host-side `AgentDefinition.model`,
       * `WINTER_SUBAGENT_MODEL` and the inherited `config.model` are full identifiers and reach the
       * same resolver). `slot` still carries the active family/source so the pinned shape stays
       * total, so a consumer that RECORDS the slot on a child must gate on this flag — otherwise
       * every pre-P6.6 spawn, whose model is the parent's own `config.model`, grows a `slot` record
       * naming a slot nobody asked for (WS-13c §3: "the slot the request named, IF it named one").
       */
      viaSlotName: boolean;
    }
  | { ok: false; code: "slot-unservable" | "ambiguous-slot-name" | "unknown-slot"; message: string; wouldServe: Array<{ key: string; providerId: string; why: string }> };

/** §4 step 3-iii's tie-break, in the spec's own order. */
const TIER_RANK: Readonly<Record<string, number>> = { "fetched-document": 0, "spec-ruling": 1, audit: 2, local: 3, "pinned-upstream": 4 };

interface OrderInput {
  catalog: WinterCatalog;
  vendorProviders: readonly string[];
  preferredProviders: readonly string[];
  hasCredential: (providerId: string) => CredentialPresence;
}

/**
 * §4 step 3, as a total order over the surviving rows.
 *
 * (i) the family's `vendorProviders` in their listed order, a configured SUBSCRIPTION row before a
 * token row of the same vendor; (ii) `settings.preferredProviders`; (iii) `admission.tier` then
 * provider id. Deterministic at every level — two rows can never compare equal unless they are the
 * same provider, which `rowsForCanonicalId` cannot produce twice for one canonical id.
 */
function orderCandidates(rows: readonly WinterModelDescriptor[], order: OrderInput): WinterModelDescriptor[] {
  const { catalog, vendorProviders, preferredProviders, hasCredential } = order;
  // R-6c-27: WITHIN a tier, a row whose credential is KNOWN PRESENT outranks one whose credential is
  // merely not known to be absent. That is what stops a cold subscription row taking the vendor
  // group's first place from a token row the user actually configured -- the ordering never has to
  // guess, it just prefers the thing it can see.
  const presenceRank = (row: WinterModelDescriptor): number => (hasCredential(row.providerId) === "present" ? 0 : 1);
  const rank = (row: WinterModelDescriptor): [number, number, number, number, string] => {
    const vendorIdx = vendorProviders.indexOf(row.providerId);
    if (vendorIdx >= 0) {
      // The subscription/token split is computed from the PROVIDER ROW's own `pricingBasis` rather
      // than trusted to the overlay's authoring order: the ruling ("a paid subscription's marginal
      // cost is zero") is about what the credential is billed, which is data.
      const basis = catalog.providers.find((p) => p.id === row.providerId)?.pricingBasis;
      return [0, presenceRank(row), basis === "subscription" ? 0 : 1, vendorIdx, row.providerId];
    }
    const preferredIdx = preferredProviders.indexOf(row.providerId);
    if (preferredIdx >= 0) return [1, presenceRank(row), 0, preferredIdx, row.providerId];
    const tier = catalog.providers.find((p) => p.id === row.providerId)?.admission.tier;
    return [2, presenceRank(row), 0, tier !== undefined ? (TIER_RANK[tier] ?? TIER_RANK["pinned-upstream"]!) : TIER_RANK["pinned-upstream"]!, row.providerId];
  };
  return [...rows].sort((a, b) => {
    const [a0, a1, a2, a3, a4] = rank(a);
    const [b0, b1, b2, b3, b4] = rank(b);
    return a0 - b0 || a1 - b1 || a2 - b2 || a3 - b3 || a4.localeCompare(b4);
  });
}

interface CanonicalResolutionInput extends SlotProviderResolutionInput {
  canonicalModelId: string;
  vendorProviders: readonly string[];
  pinnedProvider: string | undefined;
  slot: { family: string; name: string; source: ActiveSlotSet["source"] };
  viaSlotName: boolean;
}

/** §4 steps 1-6 for one canonical model: candidates, the two filters, the order, and the typed refusal. */
function resolveCanonical(input: CanonicalResolutionInput): SlotProviderResolution {
  const { catalog, canonicalModelId, pinnedProvider, hasCredential, providerEnabled, preferredProviders, vendorProviders, slot, viaSlotName } = input;
  const candidates = rowsForCanonicalId(catalog, canonicalModelId);
  const wouldServe: Array<{ key: string; providerId: string; why: string }> = [];
  const survivors: WinterModelDescriptor[] = [];
  for (const row of candidates) {
    // Step 4 FIRST: a pin is a statement about which provider, so a pinned-out row is reported as
    // pinned out rather than as "no credential" — which would be a false claim about the user's
    // configuration.
    if (pinnedProvider !== undefined && row.providerId !== pinnedProvider) {
      wouldServe.push({ key: row.key, providerId: row.providerId, why: `pinned provider is "${pinnedProvider}"` });
      continue;
    }
    // ONLY a known `absent` filters a row out. `unknown` survives and is ordered last within its tier
    // (see `orderCandidates`) -- reporting "no credential configured" for a provider nobody has looked
    // at yet would be a false claim about the user's configuration.
    if (hasCredential(row.providerId) === "absent") {
      wouldServe.push({ key: row.key, providerId: row.providerId, why: "no credential configured" });
      continue;
    }
    if (!providerEnabled(row.providerId)) {
      wouldServe.push({ key: row.key, providerId: row.providerId, why: "disabled in settings" });
      continue;
    }
    survivors.push(row);
  }
  const chosen = orderCandidates(survivors, { catalog, vendorProviders, preferredProviders, hasCredential })[0];
  if (chosen === undefined) {
    // The EXPLICIT empty-candidates branch (spine addendum): a validated catalog does not guarantee
    // a slot still has a servable row at resolution time, and "no configured provider serves it" with
    // an empty `wouldServe` is the honest answer for a slot whose every row is blocked, deprecated or
    // chat-incapable.
    const detail = wouldServe.length > 0 ? wouldServe.map((w) => `${w.key} (${w.providerId}) — ${w.why}`).join("; ") : "no catalog row can serve it at all (every row is blocked, deprecated, or has no chat/responses endpoint)";
    return { ok: false, code: "slot-unservable", message: `no configured provider serves ${canonicalModelId}: ${detail}`, wouldServe };
  }
  return { ok: true, modelKey: chosen.key, providerId: chosen.providerId, canonicalModelId: chosen.canonicalModelId, slot, viaSlotName };
}

/** The `vendorProviders` that order a canonical model's rows: the family the SLOT belongs to, else the rows' own family. */
function vendorProvidersFor(catalog: WinterCatalog, familyId: string | undefined, canonicalModelId: string): readonly string[] {
  const named = familyId !== undefined ? catalog.families.find((f) => f.id === familyId) : undefined;
  if (named !== undefined && named.vendorProviders.length > 0) return named.vendorProviders;
  const row = catalog.models.find((m) => m.canonicalModelId === canonicalModelId);
  return catalog.families.find((f) => f.id === row?.modelFamily)?.vendorProviders ?? [];
}

/**
 * Slot name -> provider + model key (WS-13c §4).
 *
 * NEVER A SUBSTITUTION (WS-13 §9): a failure is typed and carries `wouldServe` — the rows that would
 * have served it and why each did not (no credential / disabled / pinned provider absent) — because
 * "it did not work" and "you have no OpenAI key" are different problems for the user.
 */
export function resolveSlotToProvider(input: SlotProviderResolutionInput): SlotProviderResolution {
  const { catalog, active, requested } = input;

  // (1) A name the ACTIVE set advertises and no family can explain: a custom slot's facing name, or
  //     the own-model set's single slot. `resolveSlotName` cannot answer for either — a custom name
  //     is in no family at all, and the own-model name is a canonical id truncated to 32 characters —
  //     so this door has to come first, and it is also what makes a custom name WIN over a family
  //     slot that happens to share it (the user's set IS the active set, §5).
  if (active.source === "custom" || active.source === "own-model") {
    const view = active.slots.find((s) => s.name === requested);
    if (view !== undefined && view.resolvesTo !== undefined) {
      // R-6c-26: the slot already knows what it is (the own-model set of an uncatalogued session).
      // PASS THROUGH UNFILTERED, on the same regression-floor reasoning as the qualified-key door
      // below: this key names the session's own provider, which is by definition configured.
      return {
        ok: true,
        modelKey: view.resolvesTo.key,
        providerId: view.resolvesTo.providerId,
        canonicalModelId: view.canonicalModelId,
        slot: { family: active.family, name: requested, source: active.source },
        viaSlotName: true,
      };
    }
    if (view !== undefined) {
      const pinnedProvider = active.source === "custom" ? input.customSlots?.find((c) => c.name === requested)?.provider : undefined;
      return resolveCanonical({
        ...input,
        canonicalModelId: view.canonicalModelId,
        vendorProviders: vendorProvidersFor(catalog, undefined, view.canonicalModelId),
        pinnedProvider,
        slot: { family: active.family, name: requested, source: active.source },
        viaSlotName: true,
      });
    }
  }

  // (2) A FULL CATALOG KEY passes through UNFILTERED and unchanged.
  //
  //     This is the regression floor, not a convenience. `AgentDefinition.model`,
  //     `WINTER_SUBAGENT_MODEL` and the inherited `config.model` are all full identifiers, and
  //     `config.model` may be an `allowUnlisted` pass-through with no catalog row anywhere. Filtering
  //     a key on credentials here would refuse every child spawn such a session has ever made, and
  //     refusing an uncatalogued key would break the reserved `winter-test/<name>` namespace outright.
  //     The registry and the child's own provider resolution already judge a key; this layer must not
  //     judge it a second time, differently.
  if (requested.includes("/")) {
    const known = catalog.models.find((m) => m.key === requested);
    const providerId = known?.providerId ?? requested.slice(0, requested.indexOf("/"));
    return {
      ok: true,
      modelKey: requested,
      providerId,
      canonicalModelId: known?.canonicalModelId ?? canonicalModelIdOf(stripProviderPrefix(requested)),
      slot: { family: active.family, name: requested, source: active.source },
      viaSlotName: false,
    };
  }

  // (3) §3's acceptance rule: the active family's own slot, the four Claude names, a unique foreign
  //     name, or a typed ambiguity.
  const named = resolveSlotName(requested, active.family, catalog.families);
  if (named.kind === "ambiguous") {
    return {
      ok: false,
      code: "ambiguous-slot-name",
      message: `"${requested}" is a slot in ${named.candidates.join(", ")}; the active family is ${active.family} — name the family's own slot or a full model key`,
      wouldServe: [],
    };
  }
  if (named.kind === "slot") {
    return resolveCanonical({
      ...input,
      canonicalModelId: named.slot.canonicalModelId,
      vendorProviders: vendorProvidersFor(catalog, named.family.id, named.slot.canonicalModelId),
      pinnedProvider: named.slot.provider,
      slot: {
        family: named.family.id,
        name: named.slot.name,
        // M-1: the source of the slot that RESOLVED, not of the set that happened to be active. An
        // UNADVERTISED foreign name (§3 acceptance (b)/(d)) came out of a family's curated table, so
        // it is `family-default` however the session's own set was built -- labelling `luna` from a
        // Claude session `claude-pinned` writes a false statement into a persisted child record.
        source: named.advertised ? active.source : "family-default",
      },
      viaSlotName: true,
    });
  }

  // (4) A bare CANONICAL ID (§4 step 6: `set_model` accepts one, and so does a host-side model
  //     value). It goes through the same filters a slot does — unlike a full key, a canonical id
  //     names no provider, so this layer is the only thing that can choose one.
  const rows = rowsForCanonicalId(catalog, requested);
  if (rows.length > 0) {
    return resolveCanonical({
      ...input,
      canonicalModelId: requested,
      vendorProviders: vendorProvidersFor(catalog, undefined, requested),
      pinnedProvider: undefined,
      slot: { family: active.family, name: requested, source: active.source },
      viaSlotName: false,
    });
  }

  return {
    ok: false,
    code: "unknown-slot",
    message: `"${requested}" is not a slot of the active family (${active.family}), not a slot name any family holds, and not a model in this catalog — the options are ${active.slots.map((s) => s.name).join(", ") || "(none)"}, or a full "<providerId>/<model>" key`,
    wouldServe: [],
  };
}
