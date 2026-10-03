// The transcript project key (WS-05 §3.1): the directory name, under `projects/`, that a session's
// transcripts are filed under. The format is an on-disk interface shared with the official runtime:
// for any path whose sanitized form is at most 64 characters, the key is identical to the one the
// official runtime uses (observed on a real cwd in a captured official run). Longer paths are
// shortened to exactly 64 characters, because Winter also hands this key to the official runtime as
// a `CLAUDE_CODE_PROJECT_DIR_NAME` override, which that runtime validates against
// `^[A-Za-z0-9_-]{1,64}$` (see project-dir-name.ts). Past 64 characters the two runtimes' keys differ
// by design. Spec: the clean-room `project-key` spec; tests: paths.test.ts,
// project-key.edge.test.ts, project-key.corpus.test.ts.

export const TRANSCRIPT_PROJECT_KEY_MAX_LENGTH = 64;

const VENDOR_PROJECT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// The official runtime's own CLAUDE_CODE_PROJECT_DIR_NAME rule (router:src/official/
// env-allowlist.ts:590) — keep in lockstep. transcriptProjectKey's output always satisfies this;
// exported so a caller validating an independently-sourced or user-supplied key (e.g. a runtime
// override) can check it against the same rule without re-declaring the regex.
export function isVendorCompliantProjectKey(key: string): boolean {
  return VENDOR_PROJECT_KEY_PATTERN.test(key);
}

// True for the UTF-16 code units of the ASCII letters and digits, the only characters a key keeps.
function isAsciiAlphanumeric(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) // a-z
  );
}

// Replaces every code unit that is not an ASCII letter or digit with one `-`; the output has the
// same length as the input (runs are not collapsed, a surrogate pair becomes two dashes).
function sanitizeForKey(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += isAsciiAlphanumeric(code) ? text[i] : "-";
  }
  return out;
}

// The 31-multiplier polynomial hash over the UTF-16 code units, wrapped to a signed 32-bit integer
// after every step (the same value Java's String.hashCode gives), rendered as the base-36 text of its
// absolute value. Math.abs on a JS number keeps -2^31 as 2^31, so that case yields "zik0zk".
function hashSuffix(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** The transcript project key for an absolute path. */
export function transcriptProjectKey(absPath: string): string {
  const sanitized = sanitizeForKey(absPath);
  if (sanitized.length <= TRANSCRIPT_PROJECT_KEY_MAX_LENGTH) return sanitized;
  // Too long: keep a sanitized prefix and append a hash of the original text, so two long paths
  // that sanitize alike still get distinct keys. The result is exactly the maximum length.
  const suffix = hashSuffix(absPath);
  const prefixLength = TRANSCRIPT_PROJECT_KEY_MAX_LENGTH - 1 - suffix.length;
  return `${sanitized.slice(0, prefixLength)}-${suffix}`;
}
