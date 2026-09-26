// WS-23 fix round 1 (review C1): EVERY hook contribution that reaches the model or the host is BOUNDED.
//
// Why this is not optional. Hook text is appended to the HISTORY (hooks/additional-context.ts), so it
// is re-sent on every later request and persisted for resume. An unbounded contribution therefore does
// not cost one request, it costs the session: the reviewer's probe fed a 5 MB PostToolUse
// `additionalContext`, the engine's 4 MiB per-message cap (`assertMessagesWithinCap`) refused the next
// request, and -- because the attachment was already recorded -- every later prompt AND every resume
// failed the same way. A hook is third-party code (a plugin's script, a settings command); its output
// size is not something the session may trust.
//
// THE BOUNDS, and why each:
//  - MAX_HOOK_TEXT_CHARS (10,000 characters) for model/host TEXT a hook contributes: `additionalContext`,
//    Stop/SubagentStop feedback, block and deny reasons, `systemMessage`, `stopReason`, and plain-text
//    stdout (which becomes `additionalContext`). Such text is an instruction or a status snapshot: a
//    diagnostics block after an edit is a few hundred characters, a project briefing a few thousand.
//    10,000 characters (~2.5k tokens) leaves room for the largest honest use while keeping even several
//    hooks per call far below the per-message cap -- and the history cost of a chatty hook bounded.
//  - MAX_HOOK_TOOL_OUTPUT_CHARS (100,000) for `updatedToolOutput` / `updatedMCPToolOutput`. A
//    replacement stands in for a tool's OWN result, which is legitimately larger than a note (a
//    redacted file, a filtered listing); 100k characters is the scale of a large tool result and still
//    ~40x below the 4 MiB per-message cap.
//  - MAX_HOOK_STDOUT_CAPTURE (1 MiB) for a command hook's stdout, captured the way stderr already is.
//    Larger than any legitimate JSON answer (a 100k-character replacement survives even fully
//    JSON-escaped); anything beyond it is truncated at capture, so a flooding script costs a bounded
//    buffer, and a truncated JSON document then fails to parse -- that hook's error (a deny under
//    fail-closed), never a giant value.
//
// Truncation is VISIBLE: the cut text ends with a marker naming the bound, so the model (or a human
// reading the transcript) can tell a clipped note from a complete one.
export const MAX_HOOK_TEXT_CHARS = 10_000;
export const MAX_HOOK_TOOL_OUTPUT_CHARS = 100_000;
export const MAX_HOOK_STDOUT_CAPTURE = 1024 * 1024;

export function hookTruncationMarker(limit: number): string {
  return `\n[…truncated: hook output exceeded ${limit} characters]`;
}

/** `text` unchanged when within `limit`, else its first `limit` characters plus the visible marker. */
export function capHookText(text: string, limit: number = MAX_HOOK_TEXT_CHARS): string {
  if (text.length <= limit) return text;
  // Never split a surrogate pair: a lone high surrogate is not valid UTF-16 text on any wire.
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${hookTruncationMarker(limit)}`;
}
