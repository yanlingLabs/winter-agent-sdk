// Phase 5 Task 2 — the workspace-trust seam (R5-6, as AMENDED into RULING P5-A by Task 1).
//
// WHAT THE CAPTURE ACTUALLY FOUND, and why this file is as small as it is.
//
// R5-6 was written expecting one of two outcomes: either the pinned SDK treats "I selected
// 'project' as a settings source" AS trust, or it has no trust concept in SDK mode. Capture (1)
// found a third thing, and it discriminates: the pinned SDK HAS a trust concept and it is a
// per-TIER FILTER ON PERMISSIVE RULES, not a per-directory trust bit.
//
//   * a project-tier `allow` LOADS but does not widen (cells B/I/O — the prompt still fires);
//   * a local-tier or user-tier `allow` DOES widen (cells D/J/P/N);
//   * a project-tier `deny` is honored and BEATS a local `allow` (cells K/L);
//   * selecting a tier is orthogonal: a rule in an unselected tier's file has no effect (C/H).
//
// The rival "project `allow` widens only inside a TRUSTED DIRECTORY, and every mkdtemp cwd is
// untrusted" reading produces identical observables on all 13 cells, so it was struck out
// separately, three ways: `<CLAUDE_CONFIG_DIR>/.claude.json` carries no trust-/onboarding-/accept-
// named key; its `projects` map is EMPTY after a control run (the SDK path records no per-project
// state at all); and pre-seeding that map with the interactive CLI's trust flags all true changed
// nothing. `filterEscalatingDefaultMode`'s own documented condition is likewise purely tier-based.
//
// SO THE FILTER LIVES IN THE SETTINGS LAYER, NOT HERE. `applyWorkspaceTrust`
// (packages/sdk/src/settings/resolve.ts) is where the per-tier rule actually runs. THIS file is the
// one thing that remains: Winter's own product extension ABOVE that filter — a host-declared bit
// that lifts the project-tier restriction for a workspace the host vouches for, because the daemon
// has a trust notion the SDK does not. What P5-A forbids is deriving the tier filter FROM this bit,
// which would leave an untrusted-but-project-`deny` repo silently unenforced.
//
// It replaces the `const trustedWorkspace = false` engine.ts has carried since P2 (shared, by
// design, between the permission evaluator, the hook registry, the MCP source resolver and the
// child-rule mirror — one value, so those four can never drift). Absent/false keeps every one of
// them byte-identical to before this seam existed.
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";

/**
 * Two reasons, not four.
 *
 * The Task 2 brief's union also carried `"project-source-selected"` and
 * `"captured-no-trust-concept"` — the two outcomes R5-6 was hedging between. Capture (1)
 * DISCRIMINATED, and neither is reachable: selecting `'project'` is not trust, and the pin does have
 * a trust concept. They are removed rather than left as dead members a lane might one day produce,
 * which would be a verdict no consumer could act on. Narrowing here is a deliberate divergence from
 * the brief's literal type, recorded in the Task 2 report.
 */
export type TrustVerdictReason = "host-declared" | "untrusted-default";

export interface TrustVerdict {
  trusted: boolean;
  reason: TrustVerdictReason;
}

/**
 * The seam engine.ts consults. `cwd` is part of the signature because a HOST-supplied source may
 * legitimately vary by directory (a daemon that remembers which repositories a user has approved);
 * Winter's own `defaultTrustSource` deliberately does not, per the capture.
 */
export interface WorkspaceTrustSource {
  verdict(cwd: string): TrustVerdict;
}

const TRUSTED: TrustVerdict = Object.freeze({ trusted: true, reason: "host-declared" });
const UNTRUSTED: TrustVerdict = Object.freeze({ trusted: false, reason: "untrusted-default" });

/**
 * The default source: trusted iff the host explicitly declared `trustedWorkspace: true`.
 *
 * `settingSources` is in the parameter type and is deliberately NOT read — the signature keeps it so
 * a future host-side source can see what the session selected, and so the ONE thing capture (1)
 * rules out (inferring trust from source selection) is visibly not done rather than merely absent.
 * An exact `=== true` check, never a truthy coercion: this value crosses a JSON wire, where a
 * `"false"` string would otherwise grant trust.
 */
export function defaultTrustSource(config: Pick<RuntimeConfig, "settingSources" | "trustedWorkspace">): WorkspaceTrustSource {
  const trusted = config.trustedWorkspace === true;
  return { verdict: () => (trusted ? TRUSTED : UNTRUSTED) };
}

/** A constant source, for tests and for a host that has already made the decision elsewhere. */
export function fixedTrustSource(trusted: boolean): WorkspaceTrustSource {
  return { verdict: () => (trusted ? TRUSTED : UNTRUSTED) };
}
