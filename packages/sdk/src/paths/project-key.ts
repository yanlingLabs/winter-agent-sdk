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
//     - if sanitize(absPath).length <= 64: return it unchanged.
//     - else: return a prefix of the sanitized string, then "-", then a base-36 hash of the
//       ORIGINAL (pre-sanitize) absPath, sized so the total is ALWAYS EXACTLY 64 characters.
//       Getting the hash input backwards (hashing the truncated/sanitized prefix instead of the
//       original path) would still "work" (produce *a* key) but would silently diverge from the
//       pinned consumer's own hash for every long path, defeating the entire point of tracking its
//       algorithm at all.
//
//   PARITY BAND, carry #8: for any path whose sanitized form is <=64 chars, this key is byte-
//   identical to the vendor's own (both simply return the sanitized string) — the T11 capture-
//   derived observation confirmed this shape on a real cwd. Past 64 sanitized chars the vendor's
//   own key keeps going to 200 before IT truncates; ours truncates at 64 instead, because Winter
//   also hands this key to the OFFICIAL runtime itself as an override value it validates against
//   `^[A-Za-z0-9_-]{1,64}$` (CLAUDE_CODE_PROJECT_DIR_NAME; see project-dir-name.ts). So beyond the
//   parity band the two keys diverge BY DESIGN: ours is a well-formed, vendor-charset-compliant
//   key in its own right, not an attempt at vendor-exact equality for long paths.
//
// The hash is a classic multiply-add rolling hash over char codes with 32-bit signed wraparound
// at every step: h = ((h << 5) - h + charCode) | 0, i.e. h = (h*31 + charCode) mod 2^32
// (reinterpreted as signed). This is the SAME FAMILY as canonical djb2 (multiply-add with
// overflow-wrap) but is not djb2 itself: djb2 seeds at 5381 and multiplies by 33; this seeds at 0
// and multiplies by 31 — the same shape as Java's `String.hashCode()`. Because the exact routine
// was recoverable, the brief's djb2-fallback path was not needed; this is the real algorithm, not
// a provisional stand-in. Its magnitude never exceeds 2^31-1, whose base-36 form is at most 6
// digits (36^6 > 2^31-1), so the suffix below is always 1-6 characters.
//
// CAPTURE-PENDING (Minor 2, whole-branch review — the other standing provisionals in this codebase
// carry an in-code marker like this one; this recovery lacked one): the recovery above is high-
// confidence (call-site-traced against the real 0.3.250 artifact, not guessed — task-6-report.md),
// and a genuine official capture already confirmed the algorithm's SHAPE within the parity band
// (T11's capture-derived observation: memory_paths showed exactly this sanitizer's output on a
// real cwd, well under 64 chars). Because the >64 case is Winter-only by design (see the PARITY
// BAND note above), there is nothing further to capture-validate there: a real official run's key
// for a long path is EXPECTED to differ from ours past 64 chars, not match it.

export const TRANSCRIPT_PROJECT_KEY_MAX_LENGTH = 64;

const VENDOR_PROJECT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// The official runtime's own CLAUDE_CODE_PROJECT_DIR_NAME rule (router:src/official/
// env-allowlist.ts:590) — keep in lockstep. transcriptProjectKey's output always satisfies this;
// exported so a caller validating an independently-sourced or user-supplied key (e.g. a runtime
// override) can check it against the same rule without re-declaring the regex.
export function isVendorCompliantProjectKey(key: string): boolean {
  return VENDOR_PROJECT_KEY_PATTERN.test(key);
}

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
  if (sanitized.length <= TRANSCRIPT_PROJECT_KEY_MAX_LENGTH) return sanitized;
  const suffix = overflowSuffix(absPath);
  return sanitized.slice(0, TRANSCRIPT_PROJECT_KEY_MAX_LENGTH - 1 - suffix.length) + "-" + suffix;
}
