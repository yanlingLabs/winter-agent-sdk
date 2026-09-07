// WS-10 §3: model + effort resolution -- the ALIAS-RESOLUTION layer Lane C owns on top of
// engine.ts's own STRUCTURAL precedence chain (`resolveChildModel`/`buildChildInheritance`,
// engine.ts -- frozen: `WINTER_SUBAGENT_MODEL -> invocation -> definition -> session`, "inherit"
// continues resolving, a fork ignores an override by contract). That chain already hands
// child-engine.ts a single resolved model STRING (`ChildInheritance.model`) with no
// alias-to-provider-identifier mapping applied -- THIS module is where such a mapping would be
// applied, once a real provider model catalog exists ([WS-13]).
//
// No such catalog exists anywhere in this codebase today (verified: packages/sdk/src/query.ts's own
// `options.model ?? "sonnet"` treats "model" as an opaque pass-through string everywhere, not just
// for subagents -- there is no alias table, no `availableModels` list, nothing) -- so `catalog`
// below is an OPTIONAL, INJECTABLE parameter that defaults to "nothing to resolve against," matching
// this whole phase's own established CAPTURE-PENDING posture (T3's own report:
// providerSupportsToolSearch/deferrableContextShare are the identical class of disclosed gap). The
// moment [WS-13] lands a real catalog, wiring it through this SAME parameter activates real
// substitution/rejection with no change to this function's own contract.
// TYPE-ONLY, and it must stay that way: `child-handle.ts` is the seam file both lanes bind to, and a
// runtime import here would close a cycle that `import type` erases entirely.
import type { ChildInheritance } from "./child-handle.ts";

export interface ModelCatalog {
  // Maps one of the four AgentInput aliases (or any other requested string) to a REAL provider model
  // identifier. An absent entry for a requested value means "this catalog has no opinion" (passed
  // through unchanged), never "reject" -- rejection is `availableModels`'s own job, below.
  aliases?: Readonly<Record<string, string>>;
  // WS-10 §3.1: "organization availableModels MAY substitute or fall back when a requested value is
  // blocked." When supplied, a resolved identifier NOT in this list is substituted to
  // `fallbackModel` (recorded as a substitution, never silent) -- or, with no fallback configured,
  // rejected as UnresolvableModelAliasError. "Never a silent substitution" (WS-10 §3.1) means never
  // an UNRECORDED one, not "never substituted at all" -- §3.1 explicitly allows substitution as long
  // as it is recorded, which `ResolvedModel.substitutedFrom` below does.
  availableModels?: readonly string[];
  fallbackModel?: string;
}

export class UnresolvableModelAliasError extends Error {
  constructor(public readonly requested: string) {
    super(`winter: subagent model "${requested}" is not resolvable for this session's provider (WS-10 §3.1) -- no fallback configured`);
    this.name = "UnresolvableModelAliasError";
  }
}

export interface ResolvedModel {
  effectiveModel: string;
  // Present only when the catalog's own `availableModels` list forced a substitution away from the
  // literally-requested/aliased identifier.
  substitutedFrom?: string;
}

export function resolveModelAlias(requested: string, catalog?: ModelCatalog): ResolvedModel {
  const aliased = catalog?.aliases?.[requested] ?? requested;
  if (catalog?.availableModels === undefined || catalog.availableModels.includes(aliased)) {
    return { effectiveModel: aliased };
  }
  if (catalog.fallbackModel !== undefined) {
    return { effectiveModel: catalog.fallbackModel, substitutedFrom: aliased };
  }
  throw new UnresolvableModelAliasError(aliased);
}

// Purely DESCRIPTIVE (WS-10 §3.4 record-keeping) -- this NEVER re-implements or re-decides
// engine.ts's own precedence chain (`resolveChildModel`, frozen). It only asks "did anything
// upstream of the eventual session fallback name a specific model," so `requestedModel` can be
// recorded honestly even though the ACTUAL effective chain (including WINTER_SUBAGENT_MODEL, which
// is invisible from a tool executor) already ran, inside engine.ts, before `inherit.model` ever
// reached this lane's code.
export function describeRequestedModel(req: { model?: string; definition?: { model?: string } }): string | undefined {
  if (req.model !== undefined && req.model !== "inherit") return req.model;
  if (req.definition?.model !== undefined && req.definition.model !== "inherit") return req.definition.model;
  return undefined;
}

// WS-10 §3.2's own table, reduced to the one thing not already structurally enforced elsewhere:
// `AgentInput` has no `effort` field at all (T1's own pinned schema, derived-shapes-p4.md item (d)),
// and `SpawnChildRequest` mirrors that absence (T3-frozen: no `effort` field) -- "a model-authored
// Agent invocation cannot set effort" is therefore already true BY CONSTRUCTION; there is nothing to
// enforce here. What IS this function's own job: recording both requested/effective per WS-10 §3.4
// from whatever `ChildInheritance.effort` engine.ts's own `buildChildInheritance` already computed
// (`req.definition?.effort` when set, else the literal string `"inherit"` -- that file's own
// Deviations note). `"inherit"` genuinely has no session-level value to resolve to: RuntimeConfig
// carries no effort field anywhere in this codebase yet (a disclosed, WS-13-shaped gap, same class
// as the model catalog above) -- returned verbatim as an honest placeholder rather than a fabricated
// concrete value.
export interface ResolvedEffort {
  requestedEffort?: string;
  effectiveEffort: string;
}

export function resolveEffort(inheritedEffort: string): ResolvedEffort {
  if (inheritedEffort === "inherit") return { effectiveEffort: "inherit" };
  return { requestedEffort: inheritedEffort, effectiveEffort: inheritedEffort };
}

// WS-10 §3.4: the four fields recorded on every child, verbatim -- plus WS-13c §3's two.
export interface RecordedModelEffort {
  requestedModel?: string;
  effectiveModel: string;
  requestedEffort?: string;
  effectiveEffort: string;
  /**
   * WS-13c §3: the provider the child's model actually resolved to.
   *
   * `effectiveModel` is a catalog KEY, whose provider half is only readable by string-splitting it --
   * and a child spawned onto another family reaches a provider the parent's own record never names.
   * WS-13c §8 makes the child's own record AUTHORITATIVE on resume, so the provider has to be a field
   * here rather than something re-derived from the parent's live selection at resume time.
   */
  effectiveProvider?: string;
  /**
   * WS-13c §3: the SLOT the request named, if it named one.
   *
   * `requestedModel` is the raw string; this says what it meant and where it came from. Typed as
   * `ChildInheritance["slot"]` rather than re-declared, so the record and the inheritance that
   * produced it cannot drift apart on the `source` union.
   */
  slot?: ChildInheritance["slot"];
}

export function recordModelEffort(opts: {
  requestedModel?: string;
  resolved: ResolvedModel;
  effort: ResolvedEffort;
  effectiveProvider?: string;
  slot?: ChildInheritance["slot"];
}): RecordedModelEffort {
  return {
    ...(opts.requestedModel !== undefined ? { requestedModel: opts.requestedModel } : {}),
    effectiveModel: opts.resolved.effectiveModel,
    ...(opts.effort.requestedEffort !== undefined ? { requestedEffort: opts.effort.requestedEffort } : {}),
    effectiveEffort: opts.effort.effectiveEffort,
    // PASSED THROUGH ONLY WHEN GIVEN. An absent key is "the caller resolved no slot / no provider",
    // which is every pre-WS-13c call site and every test double; writing `undefined` instead would
    // put the key on the child's record and make a JSON round trip disagree with a fresh one.
    ...(opts.effectiveProvider !== undefined ? { effectiveProvider: opts.effectiveProvider } : {}),
    ...(opts.slot !== undefined ? { slot: opts.slot } : {}),
  };
}
