// The model-id half of the lean-prompt rule, kept pure so it can be pinned on its own: given a model
// on Anthropic's own API, does it take the FULL interface texts or the LEAN ones? The first-party half
// (which provider the session is on) is the engine's, where the live identity is.
//
// Full: the claude-3 line, every haiku and sonnet, and the Opus 4.0, 4.1, 4.5, 4.6 and 4.7 builds.
// Lean: anything else first-party (Opus 4.8, Opus 5, the tier above Opus, an unknown id).

/** Whether a model key takes the full interface texts. */
export function claudeModelTakesFullPrompt(modelKey: string): boolean {
  const id = modelKey.slice(modelKey.lastIndexOf("/") + 1).toLowerCase();
  if (FULL_FAMILY_MARKERS.some((marker) => id.includes(marker))) return true;
  const match = OPUS_4_ID.exec(id);
  if (match === null) return false;
  // No minor written means the 4.0 build; a written minor is compared as text.
  const minor = match[1] ?? "0";
  return FULL_OPUS_4_MINORS.has(minor);
}

// Substrings that put any id on the full texts.
const FULL_FAMILY_MARKERS = ["claude-3-", "haiku", "sonnet"];

// `claude-opus-4`, an optional minor (`-` or `.` then one or two digits), an optional eight-digit
// snapshot date, and nothing else. Backtracking lets `claude-opus-4-20250514` read as "no minor + date".
const OPUS_4_ID = /^claude-opus-4(?:[-.](\d{1,2}))?(?:-\d{8})?$/;

// The Opus 4 minors that still take the full texts.
const FULL_OPUS_4_MINORS = new Set(["0", "1", "5", "6", "7"]);
