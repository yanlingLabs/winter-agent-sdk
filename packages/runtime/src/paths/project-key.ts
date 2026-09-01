// The pinned Claude project-key algorithm (WS-05 §3.1). Recovered by ephemerally inspecting the
// checksum-verified 0.3.250 upstream artifact (Task 6: fetch -> pattern-search the bundled
// sdk.mjs -> confirm via its OWN call sites into a `~/.claude/projects/<key>` directory join, so
// this is provably the function that names that directory, not a lookalike -> delete the
// artifact) and re-expressed here in our own code — never copied verbatim. Full derivation and
// evidence trail: task-6-report.md.
//
// The algorithm, in two pieces:
//
//   sanitize(path)   Every UTF-16 code unit outside ASCII [A-Za-z0-9] becomes "-", one for one —
//                    runs of punctuation are NOT collapsed, and the leading slash is included.
//                    Because a single JS `.replace(/[^a-zA-Z0-9]/g, "-")` call operates per
//                    UTF-16 code unit (no `u` flag), an astral character — a surrogate PAIR —
//                    contributes two dashes, automatically matching the pinned consumer's own
//                    behavior with zero special-casing on our side (same engine-level string
//                    representation, same regex semantics).
//
//   transcriptProjectKey(absPath):
//     - if sanitize(absPath).length <= 200: return it unchanged.
//     - else: return the first 200 sanitized characters, then "-", then a base-36 hash of the
//       ORIGINAL (pre-sanitize) absPath — deliberately NOT of the truncated/sanitized prefix.
//       Getting this input backwards would still "work" (produce *a* key) but would silently
//       diverge from the pinned consumer's key for every long path, defeating the entire point of
//       "exact CC-compatible" keys.
//
// The hash is a classic multiply-add rolling hash over char codes with 32-bit signed wraparound
// at every step: h = ((h << 5) - h + charCode) | 0, i.e. h = (h*31 + charCode) mod 2^32
// (reinterpreted as signed). This is the SAME FAMILY as canonical djb2 (multiply-add with
// overflow-wrap) but is not djb2 itself: djb2 seeds at 5381 and multiplies by 33; this seeds at 0
// and multiplies by 31 — the same shape as Java's `String.hashCode()`. Because the exact routine
// was recoverable, the brief's djb2-fallback path was not needed; this is the real algorithm, not
// a provisional stand-in.

const MAX_UNSUFFIXED_LENGTH = 200;

function sanitize(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, "-");
}

function rollingHash32(raw: string): number {
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return hash;
}

function overflowSuffix(rawAbsPath: string): string {
  return Math.abs(rollingHash32(rawAbsPath)).toString(36);
}

export function transcriptProjectKey(absPath: string): string {
  const sanitized = sanitize(absPath);
  if (sanitized.length <= MAX_UNSUFFIXED_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_UNSUFFIXED_LENGTH)}-${overflowSuffix(absPath)}`;
}
