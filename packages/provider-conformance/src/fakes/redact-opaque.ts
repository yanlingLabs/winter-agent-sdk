// Phase 6 Task 6 (Lane B): opaque-field redaction for the messages a family fake's ASSERTIONS build.
//
// The frozen base deliberately does not redact request BODIES (`fakes/server.ts` says so: a body is
// what a serialization assertion is about, and credentials ride headers). That is right for what it
// records. It is not right for what a FAILING ASSERTION PRINTS: this lane's replay fixtures put a
// thinking `signature`, a `redacted_thinking.data` and a Gemini `thoughtSignature` into the request
// body on purpose, so a failure message that echoes the whole body puts opaque provider state into
// test output — the one place the Global Constraints say it must never reach, and the place most
// likely to be pasted into a report.
//
// The base's own body policy is a fix-wave question. The messages THIS lane builds are this lane's,
// so they are redacted here.
//
// Structural first, textual as a fallback: a JSON body is walked and its opaque VALUES replaced, so
// a signature that happens to contain an escape sequence is still caught; a body that is not JSON
// (a truncated one, a form encoding) falls back to a field-scoped regex rather than being printed
// raw.

/** The field names whose VALUES are opaque provider state wherever they appear. */
export const OPAQUE_FIELD_NAMES: readonly string[] = ["signature", "thoughtSignature", "data"];

const MARKER = "[redacted: opaque provider state]";

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    // `data` is the `redacted_thinking` payload AND the base64 of an inline image. Both are opaque
    // for this purpose: neither belongs in a failure message, and an image's base64 would drown one.
    out[key] = OPAQUE_FIELD_NAMES.includes(key) && typeof inner === "string" ? MARKER : walk(inner);
  }
  return out;
}

/** A recorded body, safe to print. */
export function redactOpaqueFields(body: string): string {
  if (body.length === 0) return body;
  try {
    return JSON.stringify(walk(JSON.parse(body) as unknown));
  } catch {
    // Not JSON — scope the substitution to the field names so an unrelated string is not mangled.
    return body.replace(new RegExp(`"(${OPAQUE_FIELD_NAMES.join("|")})"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`, "g"), (m) => `${m.slice(0, m.indexOf(":") + 1)}"${MARKER}"`);
  }
}
