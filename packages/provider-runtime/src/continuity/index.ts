// Phase 6 Lane C: the continuity package's own barrel.
//
// SEPARATE FROM `provider-runtime`'s package barrel deliberately -- that file is frozen (R6-12) and
// this lane never edits it. Until T10 adds the one re-export line named in the Lane C report, a
// consumer reaches this module by path (`.../provider-runtime/src/continuity/index.ts`); after it,
// by package name. Nothing else about the module changes either way.
//
// `fixtures.ts` is NOT exported here: it is test support for this directory's own fixtures, and a
// package surface that hands out catalog builders invites production code to build a catalog.

export { RECOVERED_REASONING_TAG, MIN_DECORATION_BODY_CHARS, buildDecoration, decorationOverhead, doorFor, escapeAttribute, escapeInline, neutralizeDelimiters, trimToBudget } from "./decoration.ts";
export type { Decoration, DecorationDoor, DecorationInput, DecorationSource } from "./decoration.ts";

export { createEndpointResolver, endpointFromOrigin, readableStateOf, sameDomain, sameFamily, shouldRequestSummary, summaryRequestOf } from "./domains.ts";
export type { ContinuityEndpoint, DomainFacts, ReadableState } from "./domains.ts";

export { applyDecorationToContent, createHistoryRenderer } from "./renderer.ts";
export type { ContinuationChainLike, ContinuationLinkLike, HistoryRendererOptions, HistoryTarget, MaterialKind, RenderReport, RenderedDecoration, WinterHistoryRenderer } from "./renderer.ts";

export { classifySwitch } from "./warnings.ts";
export type { LossClass, SwitchClassification, SwitchFacts } from "./warnings.ts";

// P6 fix wave (Ruling E-2): `createSwitchCoordinator` is RETIRED FROM PRODUCTION. Its bookkeeping --
// the pending slot, the trigger-to-reason mapping, the "owner cancels" contract -- was a second copy
// of state the engine already owns (`pendingModelSwitch`, `interruptCurrentTurn`), and a second copy
// is how the two disagree. What the switch point actually needs are the two PURE functions above and
// below: `classifySwitch` (the loss matrix) and `buildPortableHandoff` (the boundary handoff), wired
// by the runtime's `applyPendingModelSwitch` through the `resolveModelSwitch` seam
// (`provider/session-provider.ts`). The coordinator survives as a TEST HELPER: exported from THIS
// sub-barrel for the conformance corpus's scripted §12.3 cases, and deliberately NOT from the package
// barrel (`../index.ts` lists this module's exports by name for exactly that reason).
export { createSwitchCoordinator } from "./coordinator.ts";
export type { ApplyContext, AppliedSwitch, DiscardReport, ImmediateContext, PendingSwitch, SwitchAction, SwitchCoordinator, SwitchDecision, SwitchMode, SwitchOwner, SwitchRequest } from "./coordinator.ts";

export { INSTRUCTION_FILE_BASENAMES, PRIOR_MODEL_HANDOFF_TAG, buildPortableHandoff, handoffDecoration } from "./handoff.ts";
export type { HandoffToolFact, PortableHandoff, PortableHandoffOptions, PortableHandoffSections } from "./handoff.ts";
