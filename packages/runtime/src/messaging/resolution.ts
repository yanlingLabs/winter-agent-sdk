// Phase 4 Task 7 (Lane D, WS-10 §11): the resolution algorithm -- rules 1-6, MUST, in order. Consumes
// `ChildHandle` ONLY from subagents/child-handle.ts (R4-10) and the frozen RuntimeAddress/
// ListedRuntimeObject/serializeRuntimeAddress shapes from messaging/adapter.ts.
import type { ChildHandle } from "../subagents/child-handle.ts";
import { serializeRuntimeAddress, type RuntimeAddress, type ListedRuntimeObject } from "./adapter.ts";
import { buildChildAddress, parseRuntimeAddress } from "./addressing.ts";

// The one mapping site from a roster ChildHandle to its own ListedRuntimeObject row -- reused by
// both this file's own ambiguous-candidate construction and reference-adapter.ts's `listReachable`,
// so the two never drift apart on what a child "looks like" to the model.
export function childToListedRuntimeObject(parentSessionId: string, child: ChildHandle): ListedRuntimeObject {
  const running = child.status() === "running";
  return {
    address: serializeRuntimeAddress(buildChildAddress(parentSessionId, child.record.id)),
    ...(child.record.name !== undefined ? { name: child.record.name } : {}),
    objectKind: "agent",
    runtimeKind: "winter-agent",
    // "completed"/"stopped"/"failed" all bucket to "exited": none of WS-10 §11's 6-member
    // RuntimeStatus enum splits terminal children further, and all three are uniformly
    // "resume, don't steer" from SendMessage's own point of view (WS-10 §10.3).
    status: running ? "running" : "exited",
    // T8 FLAG: WS-10 §11 leaves `mode` untyped (just `string`); the companion doc's own
    // directory record types it as the SESSION/PRODUCT mode ("code"|"chat"|"cowork"|"dispatch"|
    // "build", Norma-global-messaging-spec.md), not a PermissionMode. A child has no product-mode
    // of its own visible on ChildHandle/ChildSessionRecord -- `effectiveMode` (permission axis) is
    // what's actually available here, substituted across axes. Nothing downstream consumes this
    // field yet; flagging so a real product-mode source (if one is added) doesn't silently collide
    // with this placeholder's shape.
    mode: child.record.permission.effectiveMode,
    capabilities: {
      message: running,
      resume: !running,
      notifyWhenIdle: false, // WS-10 §14: a subagent/child is never a valid notify_when_idle target
      reply: running, // T8 FLAG: unpinned anywhere in WS-10/the companion doc; mirrors `message`
    },
  };
}

export interface ResolutionInputs {
  to: string;
  // "The caller's owning parent" (WS-10 §11 rule 2): for a top-level caller this is its own
  // sessionId; for a CHILD caller it is still the OWNING top-level session id (WS-10 §10.3: a child
  // is "not reachable from another parent without routing through the owner," and children never
  // own other children -- there is exactly one owning parent per conversation).
  callerParentSessionId: string;
  // The FULL process-wide child roster (router.ts's own MessagingRouterSeam.children(), aggregated
  // across every session that has registered a roster source) -- filtered to the caller's own parent
  // below. Deliberately NOT pre-filtered by the caller: doing the filtering here (rather than
  // trusting a pre-scoped list) is what makes rule 2/3/5's "within the caller's owning parent"
  // wording an actual enforced check instead of an assumption about the input.
  children: readonly ChildHandle[];
  // Reachable peer top-level session rows (reference-adapter.ts's own PeerSessionHandle directory,
  // already mapped to ListedRuntimeObject). MAY include the caller's own session -- self-target
  // detection is router.ts's own job once a concrete address is resolved, not this function's.
  peers: readonly ListedRuntimeObject[];
}

export type ResolutionResult =
  | { kind: "resolved"; address: RuntimeAddress; child?: ChildHandle }
  | { kind: "ambiguous"; candidates: ListedRuntimeObject[] }
  | { kind: "stale"; message: string }
  | { kind: "not_found"; message: string };

export function resolveTarget(input: ResolutionInputs): ResolutionResult {
  const ownChildren = input.children.filter((c) => c.record.parentSessionId === input.callerParentSessionId);

  // Rule 1: an exact canonical address wins.
  const parsed = parseRuntimeAddress(input.to);
  if (parsed !== undefined) {
    if (parsed.objectKind === "agent") {
      const owningParent = parsed.parentWinterSessionId ?? parsed.winterSessionId;
      if (owningParent !== input.callerParentSessionId) {
        // WS-10 §10.3/§15: a child is reachable ONLY through its owning parent -- from any OTHER
        // caller's point of view this is indistinguishable from "no such object."
        return { kind: "not_found", message: `"${input.to}" is not reachable from this session (a child agent is only addressable within its owning parent)` };
      }
      const child = ownChildren.find((c) => c.record.id === parsed.childId);
      if (child === undefined) return { kind: "not_found", message: `no child at canonical address "${input.to}"` };
      return { kind: "resolved", address: parsed, child };
    }
    const peer = input.peers.find((p) => p.address === input.to);
    if (peer === undefined) return { kind: "not_found", message: `no live session at canonical address "${input.to}"` };
    return { kind: "resolved", address: parsed };
  }

  // Rule 2: a stable child ID within the caller's owning parent wins over a name.
  const byId = ownChildren.find((c) => c.record.id === input.to);
  if (byId !== undefined) {
    return { kind: "resolved", address: buildChildAddress(input.callerParentSessionId, byId.record.id), child: byId };
  }

  // Rules 3/4/5: name resolution, among this parent's own children plus reachable peers.
  const childrenNamed = ownChildren.filter((c) => c.record.name === input.to);
  const distinctChildIds = new Set(childrenNamed.map((c) => c.record.id));

  // Rule 5: this name was EVER used by more than one distinct child in this conversation -> a stale
  // refusal, regardless of how many are currently live -- addressing by this plain name is unsafe
  // from here on; canonical addressing (rule 1, already tried above) is the only way to reach either
  // one now.
  if (distinctChildIds.size > 1) {
    return {
      kind: "stale",
      message: `"${input.to}" has been used by more than one agent in this conversation; address the one you mean by its canonical address from ListAgents`,
    };
  }

  const peersNamed = input.peers.filter((p) => p.name === input.to);
  const uniqueChild = distinctChildIds.size === 1 ? childrenNamed[0] : undefined;
  const totalCandidates = (uniqueChild !== undefined ? 1 : 0) + peersNamed.length;

  if (totalCandidates === 0) {
    return { kind: "not_found", message: `no agent or session named "${input.to}" is currently reachable` };
  }
  if (totalCandidates > 1) {
    const candidates: ListedRuntimeObject[] = [...(uniqueChild !== undefined ? [childToListedRuntimeObject(input.callerParentSessionId, uniqueChild)] : []), ...peersNamed];
    return { kind: "ambiguous", candidates };
  }

  // Rule 3: exactly one eligible object owns this name.
  if (uniqueChild !== undefined) {
    return { kind: "resolved", address: buildChildAddress(input.callerParentSessionId, uniqueChild.record.id), child: uniqueChild };
  }
  const peer = peersNamed[0];
  if (peer === undefined) {
    /* c8 ignore next */
    return { kind: "not_found", message: `no agent or session named "${input.to}" is currently reachable` }; // unreachable: totalCandidates === 1 with no uniqueChild implies peersNamed.length === 1
  }
  const peerAddr = parseRuntimeAddress(peer.address);
  if (peerAddr === undefined) {
    /* c8 ignore next */
    return { kind: "not_found", message: `internal: malformed peer address for "${input.to}"` }; // defensive; every peer row's address is produced by serializeRuntimeAddress
  }
  return { kind: "resolved", address: peerAddr };
}
