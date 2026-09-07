// STUB created by the P6.6 SPINE; FILLED BY LANE A (the Agent tool per family + slot resolution).
// The signatures below are the pinned cross-lane contract — Lane A replaces the bodies and adds
// `slots.test.ts`; nobody else edits this file.
//
// WS-13c §3/§4: which slots a session ADVERTISES, how they render into the Agent tool, and how a
// slot name becomes a concrete provider + model key.
//
// The bodies THROW rather than return an empty value, deliberately: an empty active slot set would
// render an Agent tool with no `model` enum at all, and a `resolveSlotToProvider` that answered
// `ok: false` would be indistinguishable from a real `slot-unservable` refusal. A stub that is
// reachable in production must fail loudly, not degrade into something that reads as an answer.
import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { ActiveSlotSet, ModelSlotSetting } from "@yanlinglabs/winter-agent-sdk";

const NOT_IMPLEMENTED = "P6.6 Lane A: not implemented";

export interface ActiveSlotSetInput {
  catalog: WinterCatalog;
  currentModelKey: string | undefined;
  customSlots: readonly ModelSlotSetting[] | undefined;
}

/**
 * The slots this session offers (WS-13c §3).
 *
 * Lane A's obligations: the effective main model's family's slots; custom slots replace them (§5)
 * EXCEPT on a Claude model, where the pinned four win and the ignore is recorded (D25); a family
 * with no curated slots (or `other`) renders the session's own model as the single slot.
 */
export function computeActiveSlotSet(input: ActiveSlotSetInput): ActiveSlotSet {
  void input;
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * The two things the Agent tool renders from the active set (WS-13c §3): the `model` property's
 * `enum` (slot names in order) and one description line per slot, appended to the tool description
 * as `<name> — <canonicalModelId>: <description> (<reason>)`.
 *
 * The tool SHAPE never changes — only these two.
 */
export function renderAgentModelSchema(active: ActiveSlotSet): { enum: string[]; descriptionLines: string[] } {
  void active;
  throw new Error(NOT_IMPLEMENTED);
}

export interface SlotProviderResolutionInput {
  catalog: WinterCatalog;
  active: ActiveSlotSet;
  requested: string;
  hasCredential: (providerId: string) => boolean;
  providerEnabled: (providerId: string) => boolean;
  preferredProviders: readonly string[];
}

export type SlotProviderResolution =
  | { ok: true; modelKey: string; providerId: string; canonicalModelId: string; slot: { family: string; name: string; source: ActiveSlotSet["source"] } }
  | { ok: false; code: "slot-unservable" | "ambiguous-slot-name" | "unknown-slot"; message: string; wouldServe: Array<{ key: string; providerId: string; why: string }> };

/**
 * Slot name -> provider + model key (WS-13c §4).
 *
 * NEVER A SUBSTITUTION (WS-13 §9): a failure is typed and carries `wouldServe` — the rows that would
 * have served it and why each did not (no credential / disabled / pinned provider absent) — because
 * "it did not work" and "you have no OpenAI key" are different problems for the user.
 */
export function resolveSlotToProvider(input: SlotProviderResolutionInput): SlotProviderResolution {
  void input;
  throw new Error(NOT_IMPLEMENTED);
}
