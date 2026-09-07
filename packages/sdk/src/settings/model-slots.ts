// FILLED BY LANE B (P6.6, WS-13c §5): settings `modelSlots` + `preferredProviders` validation.
// The two exported interfaces/types below were the spine's pinned cross-lane contract; this lane
// replaced the stub body and added `model-slots.test.ts`.
//
// WS-13c §5 (D27): whole-set validation of the user's own four options.
//
// WHOLE-SET, never partial, and that is the design rather than a simplification: a set with one
// unresolvable `model` applied minus that entry is a lineup the user did not choose, silently. The
// failure carries a `reason` so the runtime can record `modelSlotsIgnored: "invalid"` beside the
// entry that broke it. Concretely: this function returns on the FIRST invalid entry it finds (never
// collects multiple errors, never returns a partially-filtered `slots` array).
//
// Node-portable like the rest of `packages/sdk/src` (tsconfig.sdk-fence.json): no Bun API, no
// filesystem. `@yanlinglabs/winter-provider-catalog` is fence-resident (tsconfig.sdk-fence.json
// includes its `src/**/*.ts` alongside the sdk's own), so the THREE PURE, DATA-FREE helpers this
// module imports from it (`SLOT_NAME_RE`, `CLAUDE_RESERVED_SLOT_NAMES`, `CURRENCY_RE` — a regex and
// two constants, no `WinterCatalog` instance) stay inside the fence.
//
// CORRECTED (P6.6 Lane B, fix round 1, review Important-2): an earlier version of this comment
// claimed this module "never imports the CATALOG ITSELF". That is false on the path that matters.
// `@yanlinglabs/winter-provider-catalog`'s `package.json` `exports` map has only one entry (`"."` ->
// `src/index.ts`; Bun enforces the map, so no subpath import can reach `families.ts` alone), and
// `src/index.ts` unconditionally does `import catalogJson from "../generated/catalog.json" with {
// type: "json" }` at the top level -- a 1.4 MB static import with no guard. So importing the three
// named helpers from the PACKAGE NAME, as this file does, loads the entire bundled catalog into the
// process on every UNBUNDLED path (`bun test`, dev mode, any source consumer of the sdk) -- measured
// at ~12 MB RSS for this file alone. `bun build --compile` tree-shakes the unused catalog value back
// out (the compiled artifact pays nothing extra), so this is a real cost only off that one path, not
// a correctness bug -- but it is a cost, and the previous wording denied it existed. What this
// module genuinely never does is USE the loaded catalog value: the session's view of which rows
// exist is a runtime fact, not a bundled one, so `rowsForCanonicalId`/`keyToCanonicalId` still arrive
// injected as `ModelSlotsLookup` rather than being read off the bundled `WinterCatalog`. A data-free
// import would need a `"./families"` subpath export added to `packages/provider-catalog/package.json`
// (or a cross-package relative import, precedented only in a test harness elsewhere in this repo) --
// both are spine-owned edits, out of this lane's file list; flagged for the controller instead.
// R-6c-19: the DATA-FREE subpath -- `families.ts` imports only `./types.ts`, so the sdk's unbundled
// graph never loads generated/catalog.json (the barrel `"."` does, 1.4 MB, on the unbundled path).
import { CLAUDE_RESERVED_SLOT_NAMES, CURRENCY_RE, SLOT_NAME_RE } from "@yanlinglabs/winter-provider-catalog/families";
import type { ModelSlotSetting } from "../protocol/config.ts";

/**
 * The catalog questions validation needs, injected.
 *
 * `model` in a `ModelSlotSetting` may be a `canonicalModelId` OR a catalog key (both are things a
 * user has to hand), so validation needs to go both ways: canonical id -> the rows serving it, and
 * key -> its canonical id.
 */
export interface ModelSlotsLookup {
  rowsForCanonicalId(id: string): Array<{ key: string; providerId: string }>;
  keyToCanonicalId(key: string): string | undefined;
}

export type ModelSlotsValidation = { ok: true; slots: ModelSlotSetting[] } | { ok: false; reason: string };

const MAX_SLOTS = 4;
const MAX_DESCRIPTION_LENGTH = 200;

/**
 * WS-13c §5's currency check, widened for CUSTOM slots specifically (P6.6 Lane B addendum on
 * `CURRENCY_RE`).
 *
 * `CURRENCY_RE` (imported above) is the shared, catalog-level regex `families.ts` also uses to gate
 * the REVIEWED slot descriptions in `overlay/families.json` — and the addendum flags it as
 * deliberately PARTIAL there: it catches "$10", "€2", "£1", "10 USD", "5 dollars", and by its own
 * comment misses "0.25 EUR", "¥5", "10c"/cents. That gap is acceptable for `families.json` because a
 * human reviews every string that goes in. A custom slot's `description` is the opposite: UNREVIEWED
 * end-user input that ships straight to the Agent tool's description line, so this module does not
 * accept the same gap silently.
 *
 * The fix is additive, not a rewrite: `hasCurrencyAmount` is `CURRENCY_RE` OR `EXTRA_CURRENCY_RE`, so
 * every string the shared regex flags is still flagged here. `EXTRA_CURRENCY_RE` adds exactly the
 * four spellings the addendum names — EUR, ¥, ¢, and the word "cent(s)" — each still requiring a
 * digit amount immediately adjacent (a bare currency WORD with no amount, e.g. "GLM Coding plan" or
 * "cost-effective", never matches). It deliberately stops there rather than growing into a
 * multi-currency detector (JPY/CNY/KRW codes, "pounds", "yen", "won" as a bare English word...): the
 * addendum asked for these four, and each further addition trades a real but rare catch for a wider
 * false-positive surface on ordinary English slot text — "the top 10 choices" must never flag merely
 * because a widened regex started treating a bare trailing "c" as cents. See `model-slots.test.ts`
 * for the cases this covers (and the one it deliberately does not: bare "10c" shorthand).
 */
const EXTRA_CURRENCY_RE = /(?:[¥¢]\s?\d)|(?:\d\s?¢)|(?:\d+(?:\.\d+)?\s?(?:eur|euros?|cents?)\b)/i;

function hasCurrencyAmount(text: string): boolean {
  return CURRENCY_RE.test(text) || EXTRA_CURRENCY_RE.test(text);
}

/**
 * `model` -> `canonicalModelId`, the two spellings `ModelSlotSetting.model`'s own doc names: a catalog
 * KEY (resolved through `keyToCanonicalId`) or a canonical id already (resolved by asking
 * `rowsForCanonicalId` whether anything serves it). Tried in that order — the lookup's authoritative
 * answer first, a bare-canonical-id guess second — and nothing else: a third heuristic (e.g.
 * stripping a `"foo/"` prefix off an unrecognised key and hoping the remainder is canonical) would
 * let a slot validate against a provider prefix the lookup never confirmed, which is exactly the
 * validator/resolver drift `isSlotServableRow`'s own comment (`families.ts`) describes fixing one
 * layer down. An unresolvable `model` returns `undefined` and the caller reports "no catalog row".
 */
function resolveCanonicalId(model: string, lookup: ModelSlotsLookup): string | undefined {
  const viaKey = lookup.keyToCanonicalId(model);
  if (viaKey !== undefined) return viaKey;
  if (lookup.rowsForCanonicalId(model).length > 0) return model;
  return undefined;
}

/**
 * Validates a raw `settings.modelSlots` value (WS-13c §5).
 *
 * Lane B's obligations, from the spec: 1–4 entries; names match the slot token grammar and are
 * unique; NO name is a reserved Claude name (D25); every `model` resolves in the catalog; a given
 * `provider` actually serves it; `description` is ≤ 200 characters and carries no currency amount.
 *
 * WHOLE-SET: the first invalid entry (in array order) is where this returns, with a `reason` that
 * names what failed. It never validates some entries and drops others.
 */
export function validateModelSlots(raw: unknown, lookup: ModelSlotsLookup): ModelSlotsValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `"modelSlots" must be an array, got ${raw === null ? "null" : typeof raw}` };
  }
  if (raw.length === 0) {
    return { ok: false, reason: `"modelSlots" must contain at least one entry (1–${MAX_SLOTS}, WS-13c §5)` };
  }
  if (raw.length > MAX_SLOTS) {
    return { ok: false, reason: `"modelSlots" must contain at most four entries (got ${raw.length})` };
  }

  const slots: ModelSlotSetting[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const where = `modelSlots[${i}]`;

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `${where} must be an object, got ${entry === null ? "null" : Array.isArray(entry) ? "an array" : typeof entry}` };
    }
    const record = entry as Record<string, unknown>;
    const { name, model, provider, description } = record;

    if (typeof name !== "string" || !SLOT_NAME_RE.test(name)) {
      return { ok: false, reason: `${where}.name must match the slot name grammar (${SLOT_NAME_RE.source}), got ${JSON.stringify(name)}` };
    }
    // D25 "no false information": the four Claude names are reserved to the `claude` family and may
    // never be reused as a facing name for a different model, custom or otherwise.
    if (CLAUDE_RESERVED_SLOT_NAMES.includes(name)) {
      return { ok: false, reason: `${where}.name ${JSON.stringify(name)} is reserved to the claude family (${CLAUDE_RESERVED_SLOT_NAMES.join(", ")}) and cannot be used as a custom slot name` };
    }
    if (seenNames.has(name)) {
      return { ok: false, reason: `${where}.name ${JSON.stringify(name)} is a duplicate slot name` };
    }
    seenNames.add(name);

    if (typeof model !== "string" || model.length === 0) {
      return { ok: false, reason: `${where}.model must be a non-empty string, got ${JSON.stringify(model)}` };
    }
    const canonicalId = resolveCanonicalId(model, lookup);
    const rows = canonicalId !== undefined ? lookup.rowsForCanonicalId(canonicalId) : [];
    if (canonicalId === undefined || rows.length === 0) {
      return { ok: false, reason: `${where}.model ${JSON.stringify(model)} has no catalog row (not a known catalog key or canonical model id with a servable row)` };
    }

    if (provider !== undefined) {
      if (typeof provider !== "string" || provider.length === 0) {
        return { ok: false, reason: `${where}.provider must be a non-empty string, got ${JSON.stringify(provider)}` };
      }
      if (!rows.some((row) => row.providerId === provider)) {
        const servedBy = rows.map((row) => row.providerId);
        return { ok: false, reason: `${where}.provider ${JSON.stringify(provider)} does not serve ${JSON.stringify(model)} (served by: ${servedBy.length > 0 ? servedBy.join(", ") : "nobody"})` };
      }
    }

    if (description !== undefined) {
      if (typeof description !== "string") {
        return { ok: false, reason: `${where}.description must be a string, got ${typeof description}` };
      }
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        return { ok: false, reason: `${where}.description exceeds ${MAX_DESCRIPTION_LENGTH} characters (got ${description.length})` };
      }
      if (hasCurrencyAmount(description)) {
        return { ok: false, reason: `${where}.description must not carry a currency amount (pricing lives on catalog rows), got ${JSON.stringify(description)}` };
      }
    }

    slots.push({
      name,
      model,
      ...(provider !== undefined ? { provider: provider as string } : {}),
      ...(description !== undefined ? { description: description as string } : {}),
    });
  }

  return { ok: true, slots };
}
