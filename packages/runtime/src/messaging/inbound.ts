// Phase 4 Task 7 (Lane D, WS-10 §13): CrossSessionInbound policy -- the accept/hold/refuse class
// matrix, its default-vs-explicit resolution, the fromMode mapping named by derived-shapes-p4.md
// item (e)'s Open Question 7, and the bounded held/accepted mailbox.
//
// SCOPE BOUNDARY (WS-10 §10.3, cited again at the call site in reference-adapter.ts's own
// deliverToSession): this whole file applies
// ONLY on the deliverToSession (peer top-level session) path. Steering a running child or resuming a
// terminal one is "delivered inside the OWNING PARENT session" (WS-10 §10.3) -- there is no separate
// receiver to apply an inbound policy against; the child already runs under the parent's own
// permission mode. Nothing in this file is consulted for a `RuntimeAddress` whose `objectKind` is
// `"agent"`.
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";
import { HELD_INBOX_CAP, ACCEPTED_QUEUE_CAP, DEFAULT_HOLD_EXPIRY_MS } from "./outcomes.ts";

export type PermissionClassLabel = "prompts" | "bypasses" | "unknown";
export type CrossSessionInbound = "accept" | "hold" | "refuse";

const PROMPTING_MODES: ReadonlySet<PermissionMode> = new Set(["default", "acceptEdits", "dontAsk", "auto"]);

// WS-10 §13: "classify default, acceptEdits, dontAsk, and auto as prompts; bypassPermissions as
// bypasses; plan is classified as bypassing when bypass permissions are available to that session --
// preserved as a versioned compatibility fixture, not re-derived from the mode name." `bypassAvailable`
// is a REQUIRED parameter (no default): whether bypass is actually available to a given session is a
// fact about THAT session's own gate configuration (permissions/policy-state.ts's own
// `BypassGateConfig`, owned by another lane and not imported here to avoid a cross-lane coupling on
// its shape) -- this function never guesses it, the caller must state it explicitly.
export function classifyPermissionMode(mode: PermissionMode, opts: { bypassAvailable: boolean }): PermissionClassLabel {
  if (mode === "bypassPermissions") return "bypasses";
  if (mode === "plan") return opts.bypassAvailable ? "bypasses" : "prompts";
  if (PROMPTING_MODES.has(mode)) return "prompts";
  /* c8 ignore next */
  return "prompts"; // exhaustive over the 6-member PermissionMode union above; unreachable in practice
}

// Open Question 7 (derived-shapes-p4.md item (e)): the pinned artifact's own `SDKMessageOrigin`
// 'peer' branch spells this field `fromMode?: 'bypass' | 'prompting'` -- singular, 2-member,
// OPTIONAL (absence is a third implicit state) -- where WS-10 §15's own
// `RuntimeMessagingAdapter.senderPermissionClass` returns the PLURAL 3-member
// `"prompts" | "bypasses" | "unknown"` with an explicit "unknown" literal. This is the ONE place
// that mapping would happen if a future caller needs to interpret a pinned-shaped `fromMode` value;
// it is exported and tested for that reason but called by NO production path in this reference
// (R4-5 is in-process only -- nothing here ever parses a real `SDKMessageOrigin` wire object).
// Per the task brief: "map internally, never expose a third spelling" -- this function's OUTPUT
// type enforces that; only its INPUT accepts the pinned singular spelling.
export function mapFromModeToPermissionClass(fromMode: "bypass" | "prompting" | undefined): PermissionClassLabel {
  if (fromMode === "bypass") return "bypasses";
  if (fromMode === "prompting") return "prompts";
  return "unknown";
}

// WS-10 §13's own five-row table, DEFAULT (no explicit CrossSessionInbound setting) result only.
// Returns "accept" or "hold" -- an explicit "refuse" only ever comes from a receiver's own explicit
// setting or the unauthenticated-route rule (resolveInboundDecision below), never from this matrix.
export function defaultInboundResult(receiverClass: PermissionClassLabel, senderClass: PermissionClassLabel): "accept" | "hold" {
  if (receiverClass === "prompts") return senderClass === "bypasses" ? "hold" : "accept"; // prompts×prompts, prompts×unknown -> accept; prompts×bypasses -> hold
  return senderClass === "bypasses" ? "accept" : "hold"; // bypasses×bypasses -> accept; bypasses×{prompts,unknown} -> hold
}

export interface InboundDecisionParams {
  authenticated: boolean;
  explicitSetting?: CrossSessionInbound;
  receiverClass: PermissionClassLabel;
  senderClass: PermissionClassLabel;
}

// WS-10 §13: "An authenticated route that cannot prove sender class uses `unknown`; an
// unauthenticated route is refused before the matrix" -- checked first. Then the receiver's own
// explicit `crossSessionInbound` setting, which derived-shapes-p4.md item (e)'s own reading of the
// pinned `Settings.crossSessionInbound` doc comment confirms "always wins." Only once neither
// applies does the default matrix run.
export function resolveInboundDecision(params: InboundDecisionParams): CrossSessionInbound {
  if (!params.authenticated) return "refuse";
  if (params.explicitSetting !== undefined) return params.explicitSetting;
  return defaultInboundResult(params.receiverClass, params.senderClass);
}

// --- The bounded held/accepted mailbox (WS-10 §13) --------------------------------------------------

export interface HeldEntry {
  messageId: string;
  reason: string;
  kind: "default" | "explicit"; // "an explicit hold persists ... a default-class hold" expires (below)
  heldAt: number;
  expiresAt?: number; // present only for kind "default"
}

interface ReceiverBox {
  held: HeldEntry[];
  acceptedCount: number;
}

export interface Mailbox {
  // false = the held cap (100) is already full for this receiver -- caller must surface a visible
  // refusal, never a silent drop.
  hold(receiverKey: string, entry: HeldEntry): boolean;
  // false = the accepted-queue cap (50) is already full for this receiver.
  accept(receiverKey: string): boolean;
  releaseAccepted(receiverKey: string, n?: number): void;
  heldCount(receiverKey: string): number;
  acceptedCount(receiverKey: string): number;
  listHeld(receiverKey: string): readonly HeldEntry[];
  takeHeld(receiverKey: string, messageId: string): HeldEntry | undefined;
  // WS-10 §13: "held messages are re-evaluated when the receiver's mode or settings change." Re-runs
  // `decide` for every currently-held DEFAULT-class entry only -- an explicit hold "persists ...
  // until a later applicable accept," never auto-promoted by a mode change alone -- and removes+
  // returns every one `decide` no longer classifies as "hold".
  reevaluate(receiverKey: string, decide: (entry: HeldEntry) => CrossSessionInbound): Array<{ entry: HeldEntry; next: CrossSessionInbound }>;
  // WS-10 §13's default-class 5-minute dialog expiry: removes+returns every DEFAULT-class entry
  // whose expiresAt has passed. Explicit holds are never swept here.
  sweepExpired(receiverKey: string, now: number): HeldEntry[];
}

export function createMailbox(): Mailbox {
  const boxes = new Map<string, ReceiverBox>();
  function boxFor(key: string): ReceiverBox {
    let box = boxes.get(key);
    if (box === undefined) {
      box = { held: [], acceptedCount: 0 };
      boxes.set(key, box);
    }
    return box;
  }

  return {
    hold(receiverKey, entry) {
      const box = boxFor(receiverKey);
      if (box.held.length >= HELD_INBOX_CAP) return false;
      box.held.push(entry);
      return true;
    },
    accept(receiverKey) {
      const box = boxFor(receiverKey);
      if (box.acceptedCount >= ACCEPTED_QUEUE_CAP) return false;
      box.acceptedCount += 1;
      return true;
    },
    releaseAccepted(receiverKey, n = 1) {
      const box = boxFor(receiverKey);
      box.acceptedCount = Math.max(0, box.acceptedCount - n);
    },
    heldCount(receiverKey) {
      return boxes.get(receiverKey)?.held.length ?? 0;
    },
    acceptedCount(receiverKey) {
      return boxes.get(receiverKey)?.acceptedCount ?? 0;
    },
    listHeld(receiverKey) {
      return boxes.get(receiverKey)?.held ?? [];
    },
    takeHeld(receiverKey, messageId) {
      const box = boxes.get(receiverKey);
      if (box === undefined) return undefined;
      const idx = box.held.findIndex((e) => e.messageId === messageId);
      if (idx === -1) return undefined;
      const [removed] = box.held.splice(idx, 1);
      return removed;
    },
    reevaluate(receiverKey, decide) {
      const box = boxes.get(receiverKey);
      if (box === undefined) return [];
      const promoted: Array<{ entry: HeldEntry; next: CrossSessionInbound }> = [];
      box.held = box.held.filter((entry) => {
        if (entry.kind !== "default") return true; // explicit holds are never auto-reevaluated away
        const next = decide(entry);
        if (next === "hold") return true;
        promoted.push({ entry, next });
        return false;
      });
      return promoted;
    },
    sweepExpired(receiverKey, now) {
      const box = boxes.get(receiverKey);
      if (box === undefined) return [];
      const expired: HeldEntry[] = [];
      box.held = box.held.filter((entry) => {
        if (entry.kind === "default" && entry.expiresAt !== undefined && entry.expiresAt <= now) {
          expired.push(entry);
          return false;
        }
        return true;
      });
      return expired;
    },
  };
}

// Convenience: builds a fresh default-class HeldEntry with the pinned 5-minute expiry.
export function buildDefaultHoldEntry(messageId: string, reason: string, now: number): HeldEntry {
  return { messageId, reason, kind: "default", heldAt: now, expiresAt: now + DEFAULT_HOLD_EXPIRY_MS };
}

export function buildExplicitHoldEntry(messageId: string, reason: string, now: number): HeldEntry {
  return { messageId, reason, kind: "explicit", heldAt: now };
}
