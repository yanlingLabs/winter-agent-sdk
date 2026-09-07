// WS-13c §1–§3: the pure, catalog-level family helpers. No I/O, no runtime state — every lane imports these.
//
// Inside the sdk fence (tsconfig.sdk-fence.json) like the rest of this package: no Bun API, no
// fetch, no filesystem. Everything here is a total function over data the caller already holds, so
// the build pipeline, the validator, the runtime's slot resolver and the listing builder all reach
// the SAME answer rather than three near-identical re-derivations of "which family is this".
import type { FamilySlot, ModelFamilyDescriptor, WinterCatalog, WinterModelDescriptor } from "./types.ts";

export const SLOT_NAME_RE = /^[a-z0-9][a-z0-9.-]{0,31}$/;
export const FAMILY_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const CLAUDE_FAMILY_ID = "claude";
export const OTHER_FAMILY_ID = "other";
/** D25: reserved to the `claude` family, in the pinned order. */
export const CLAUDE_RESERVED_SLOT_NAMES: readonly string[] = ["fable", "opus", "sonnet", "haiku"];
/** "$10", "10 USD", "€2", "£1", "10 dollars" — pricing lives on rows, never in a slot description. */
export const CURRENCY_RE = /(?:[$€£]\s?\d)|(?:\d\s?(?:usd|dollars?)\b)/i;

const NAMESPACE_PREFIXES = ["models/", "anthropic/", "openai/", "google/", "deepseek-ai/", "meta-llama/", "meta/", "qwen/", "x-ai/", "xai/", "moonshotai/", "zai-org/", "z-ai/", "minimax/", "mistralai/", "nvidia/"] as const;
const BEDROCK_PREFIXES = ["us.", "eu.", "apac.", "global.", "anthropic."] as const;

/** The vendor's model identity with the provider's spelling removed (WS-13c §1, R13c-2). Deterministic; a per-row overlay `canonicalModelId` overrides it. */
export function canonicalModelIdOf(upstreamId: string): string {
  let id = upstreamId.trim().toLowerCase();
  const account = /^accounts\/[^/]+\/models\/(.+)$/.exec(id);
  if (account !== null) id = account[1]!;
  for (const prefix of NAMESPACE_PREFIXES) {
    if (id.startsWith(prefix)) { id = id.slice(prefix.length); break; }
  }
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const prefix of BEDROCK_PREFIXES) {
      if (id.startsWith(prefix)) { id = id.slice(prefix.length); stripped = true; }
    }
  }
  id = id.replace(/-v\d+:\d+$/, "");
  if (id.startsWith("zai-glm")) id = id.slice("zai-".length);
  // "claude-haiku-4-5-20251001" -> "claude-haiku-4.5-20251001": single-digit groups joined by "-" are one dotted version.
  id = id.replace(/-(\d)-(\d)(?=-|$)/g, "-$1.$2");
  return id;
}

export function familyIdOf(canonicalModelId: string, families: readonly ModelFamilyDescriptor[]): string {
  for (const family of families) {
    for (const matcher of family.matchers) {
      if (new RegExp(matcher.pattern).test(canonicalModelId)) return family.id;
    }
  }
  return OTHER_FAMILY_ID;
}

export function stampFamilyFields<T extends { upstreamId: string; canonicalModelId?: string; modelFamily?: string }>(
  rows: readonly T[],
  families: readonly ModelFamilyDescriptor[],
): Array<T & { canonicalModelId: string; modelFamily: string }> {
  return rows.map((row) => {
    const canonicalModelId = row.canonicalModelId ?? canonicalModelIdOf(row.upstreamId);
    const modelFamily = row.modelFamily ?? familyIdOf(canonicalModelId, families);
    return { ...row, canonicalModelId, modelFamily };
  });
}

export type SlotNameResolution =
  | { kind: "slot"; family: ModelFamilyDescriptor; slot: FamilySlot; advertised: boolean }
  | { kind: "ambiguous"; name: string; candidates: string[] }
  | { kind: "unknown"; name: string };

/** WS-13c §3 acceptance: active set first; the Claude names always into `claude`; a unique foreign name; else ambiguous/unknown. */
export function resolveSlotName(name: string, activeFamilyId: string | undefined, families: readonly ModelFamilyDescriptor[]): SlotNameResolution {
  const active = families.find((f) => f.id === activeFamilyId);
  const own = active?.slots.find((s) => s.name === name);
  if (active !== undefined && own !== undefined) return { kind: "slot", family: active, slot: own, advertised: true };
  if (CLAUDE_RESERVED_SLOT_NAMES.includes(name)) {
    const claude = families.find((f) => f.id === CLAUDE_FAMILY_ID);
    const slot = claude?.slots.find((s) => s.name === name);
    if (claude !== undefined && slot !== undefined) return { kind: "slot", family: claude, slot, advertised: false };
  }
  const hits: Array<{ family: ModelFamilyDescriptor; slot: FamilySlot }> = [];
  for (const family of families) for (const slot of family.slots) if (slot.name === name) hits.push({ family, slot });
  if (hits.length === 1) return { kind: "slot", family: hits[0]!.family, slot: hits[0]!.slot, advertised: false };
  if (hits.length > 1) return { kind: "ambiguous", name, candidates: hits.map((h) => `${h.family.id}/${h.slot.name}`) };
  return { kind: "unknown", name };
}

export function familyOfModelKey(catalog: WinterCatalog, modelKey: string): ModelFamilyDescriptor | undefined {
  const row = catalog.models.find((m) => m.key === modelKey);
  if (row === undefined) return undefined;
  return catalog.families.find((f) => f.id === row.modelFamily);
}

/** Candidate rows for a slot (WS-13c §4 step 1). */
export function rowsForCanonicalId(catalog: WinterCatalog, canonicalModelId: string): WinterModelDescriptor[] {
  return catalog.models.filter(
    (m) => m.canonicalModelId === canonicalModelId && m.status !== "blocked" && m.status !== "deprecated" && (m.endpoints.includes("chat") || m.endpoints.includes("responses")),
  );
}
