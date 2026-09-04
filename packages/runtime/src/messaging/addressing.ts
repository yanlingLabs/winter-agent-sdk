// Phase 4 Task 7 (Lane D, WS-10 §10.1/§11): `to`-field syntax validation plus the INVERSE of T3's
// own `serializeRuntimeAddress` (messaging/adapter.ts, frozen -- read-only from here). That file
// owns RuntimeAddress -> string; this file owns string -> RuntimeAddress, since resolution (rule 1,
// "an exact canonical address wins") needs to recognize and parse one back out of the model-supplied
// `to` string.
import { serializeRuntimeAddress, type RuntimeAddress, type RuntimeKind } from "./adapter.ts";

// R4-5: this in-process reference only ever PRODUCES/PARSES its own "winter-agent" addresses.
// Recognizing a real "claude-agent" official-runtime peer address is a P8/host-integration concern
// (WS-15's own RuntimeDirectory owns cross-runtime identity) -- never fabricated here.
export const REFERENCE_RUNTIME_KIND: RuntimeKind = "winter-agent";

export type ToFieldValidation = { ok: true } | { ok: false; message: string };

const MAX_TO_LENGTH = 300; // WS-10 §10.1 verbatim

// WS-10 §10.1's own `to` constraints: required, non-empty, <=300 chars, no newline, no "*" (broadcast
// forbidden). Deliberately does NOT check resolvability -- a syntactically valid `to` that resolves
// to nothing is a `not_found` DeliveryOutcome (resolution.ts), not a validation error (router.ts's
// own split between "malformed call" and "messaging-system outcome").
export function validateToField(to: unknown): ToFieldValidation {
  if (typeof to !== "string" || to.length === 0) return { ok: false, message: "to must be a non-empty string" };
  if (to.length > MAX_TO_LENGTH) return { ok: false, message: `to must be at most ${MAX_TO_LENGTH} characters (got ${to.length})` };
  if (to.includes("\n") || to.includes("\r")) return { ok: false, message: "to must not contain a newline" };
  if (to.includes("*")) return { ok: false, message: 'to must not contain "*" ("*" broadcast is forbidden, WS-10 §10.1)' };
  return { ok: true };
}

export function buildSessionAddress(winterSessionId: string): RuntimeAddress {
  return { objectKind: "session", runtimeKind: REFERENCE_RUNTIME_KIND, winterSessionId };
}

export function buildChildAddress(parentWinterSessionId: string, childId: string): RuntimeAddress {
  return { objectKind: "agent", runtimeKind: REFERENCE_RUNTIME_KIND, winterSessionId: parentWinterSessionId, parentWinterSessionId, childId };
}

// The inverse of serializeRuntimeAddress's own two forms. Returns undefined for anything else
// (a plain display name, a bare child id, garbage) -- resolution rule 1 tries this FIRST and falls
// through to name/child-id resolution when it returns undefined; it never throws on malformed input.
export function parseRuntimeAddress(serialized: string): RuntimeAddress | undefined {
  if (serialized.startsWith("session:")) {
    const id = serialized.slice("session:".length);
    if (id.length === 0) return undefined;
    return buildSessionAddress(id);
  }
  if (serialized.startsWith("agent:")) {
    const rest = serialized.slice("agent:".length);
    const sep = rest.indexOf(":");
    if (sep <= 0 || sep === rest.length - 1) return undefined; // both halves must be non-empty
    const parent = rest.slice(0, sep);
    const childId = rest.slice(sep + 1);
    return buildChildAddress(parent, childId);
  }
  return undefined;
}

// Self-target detection (WS-10 §16's own named proof point) compares by CANONICAL serialization --
// serializeRuntimeAddress's own header notes runtime kind/backend ids "live in the directory
// record," so two addresses naming the same opaque identity are the same target regardless of which
// optional fields happen to be populated on each RuntimeAddress value.
export function sameAddress(a: RuntimeAddress, b: RuntimeAddress): boolean {
  try {
    return serializeRuntimeAddress(a) === serializeRuntimeAddress(b);
  } catch {
    return false;
  }
}
