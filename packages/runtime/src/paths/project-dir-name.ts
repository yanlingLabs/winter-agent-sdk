// Controller Ruling P1-N (WS-05 §3.2): `<PREFIX>PROJECT_DIR_NAME` overrides ONLY the persistent
// transcript-project directory name — the <projectKey> segment of a SessionStore consumer's
// `<home>/projects/<projectKey>/...` — under the same segment-validation rules paths/temp.ts's
// sessionTempDir applies to ITS own segments (assertSafeSegment's alphabet: non-empty
// [A-Za-z0-9-]+, no separators, no traversal). It NEVER renames the temp cwd segment: this file
// does not touch, wrap, or otherwise influence sessionTempDir/compatibilityKeys at all — a caller
// who wants the temp-side tempProjectKey keeps computing it exactly as Task 6 shipped it.
//
// This is a pure "what name should the store use right now" decision, nothing more: it is the
// caller's job (a SessionStore consumer — e.g. resume/session-open code) to call this when
// building the projectKey it passes as SessionKey.projectKey. Recording the override alongside a
// session so a LATER resume re-applies the SAME name even if the env var has since changed, or is
// unset, is explicitly Task 9's obligation, not this helper's — see task-7-report.md's seam note.
// home.ts moved to the sdk package (Task 10, WS-05 §6); temp.ts stays runtime-private.
import { isUnset, WINTER_BRAND, envName, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import { WinterPathsError } from "./temp.ts";

// Re-declared rather than imported from temp.ts: assertSafeSegment there is private (this task's
// paths-module reuse list is resolveWinterHome/transcriptProjectKey/compatibilityKeys/
// sessionTempDir/ensureTasksDir only), and this validates a DIFFERENT kind of input — an
// env-supplied override string, not a derived key — so a same-alphabet, independently-declared
// regex has no coupling to temp.ts's internals to keep in sync with beyond the alphabet itself.
//
// Aligned to the vendor's own CLAUDE_CODE_PROJECT_DIR_NAME rule (carry #8; sdk's
// isVendorCompliantProjectKey / TRANSCRIPT_PROJECT_KEY_MAX_LENGTH mirror this exact bound): an
// override this permissive is also handed straight to the OFFICIAL runtime as that env var, which
// rejects anything outside `^[A-Za-z0-9_-]{1,64}$` -- so Winter's own override validation refuses
// up front rather than accepting a value the official runtime would then bounce.
const SAFE_DIR_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// `<PREFIX>PROJECT_DIR_NAME` || defaultProjectKey. `env` is injectable so tests never read the real
// process environment (mirrors resolveWinterHome/resolveTempBase's own pattern in this module).
//
// P7a (D19): the env NAME is derived from the session's brand and read INSIDE this function, never
// spelled and never at module load — the brand arrives with `--config-json`. It also reaches the
// REFUSAL MESSAGE: a reuser whose prefix is `ACME_`, told to fix `<PREFIX>PROJECT_DIR_NAME` under
// Winter's spelling, has been handed the name of a variable that does not exist in their product.
export function resolveProjectDirName(defaultProjectKey: string, env?: Record<string, string | undefined>, brand?: Pick<BrandProfile, "envPrefix">): string {
  const varName = envName(brand ?? WINTER_BRAND, "PROJECT_DIR_NAME");
  const override = (env ?? process.env)[varName];
  if (isUnset(override)) return defaultProjectKey;
  if (!SAFE_DIR_NAME.test(override as string)) {
    throw new WinterPathsError(
      `invalid ${varName} ${JSON.stringify(override)}: expected 1-64 chars of [A-Za-z0-9_-] (no path separators or traversal)`,
    );
  }
  return override as string;
}
