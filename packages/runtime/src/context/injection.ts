// Phase 5 Lane C (task 6) -- the injection-safety primitives every file-sourced block shares.
//
// WINTER.md, the MEMORY.md index and an output-style body are all FILE CONTENT that ends up in a
// prompt position: a user-context block prepended to the turn's user message, or the system prompt
// itself. Three properties have to hold for every one of them, and holding them in three separate
// places is how one of them silently stops holding:
//
//  1. BOUNDED. A block that is re-attached to every single turn (Ruling R5-9's "always injected as
//     user-context") must have a byte ceiling, or one large checked-in file quietly costs the
//     session its context window. Every reader here takes a cap and reports when it hit it, so the
//     model can tell "this is the whole file" from "this is the start of the file".
//  2. UNABLE TO ESCAPE ITS WRAPPER. A block is labelled so the model can tell harness-injected
//     context from something the user typed. A literal `</system-reminder>` inside the file would
//     end that wrapper early and let the rest of the file read as a second, model-directed
//     instruction -- so the tag is neutralised in the body before wrapping.
//  3. NEVER FATAL. A missing, unreadable, empty or non-regular file yields no block at all, never
//     an exception and never an empty labelled block: context assembly runs on every turn and must
//     not be a way to break a session.
//
// (1) and (2) are Norma's shipped `context.ts` semantics, ported. The caps themselves are each
// owner's -- memory's 200 lines / 25 KB are pinned by WS-05 §11; WINTER.md's is Winter's own.
import { readFileSync, statSync } from "node:fs";

/** Appended to a block that was cut short, so the model knows it is reading a prefix. */
export const TRUNCATION_MARKER = "\n[…truncated]";

/**
 * Cap to `maxBytes` UTF-8 bytes on a valid boundary. A multibyte character split by the cut
 * degrades to U+FFFD rather than a lone surrogate (`Buffer.toString` guarantees this), which keeps
 * the result a well-formed string every JSON encoder on the path can carry.
 *
 * THE REPLACEMENT CHARACTER CAN PUSH THE RESULT BACK OVER THE CAP, which is why the trailing
 * U+FFFD is dropped when it does. Cutting mid-character consumes 1-3 bytes of the original and
 * emits a 3-byte U+FFFD in their place, so a naive `subarray(0, maxBytes).toString()` can re-encode
 * to `maxBytes + 2` -- Norma's shipped twin has exactly this hole. It is small, but a cap that only
 * approximately holds is not a cap, and this is the primitive every other ceiling in this lane is
 * expressed in terms of. Found by the fixture, not by reading: the assertion was written as
 * "<= maxBytes" and failed at 7 bytes for a 5-byte budget.
 */
export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  let cut = buf.subarray(0, maxBytes).toString("utf8");
  if (cut.endsWith("�") && Buffer.byteLength(cut) > maxBytes) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/**
 * Defuses a literal `<system-reminder>` / `</system-reminder>` inside untrusted file content.
 *
 * Deliberately does NOT collapse newlines (Norma's engine-side twin does, for tool results): these
 * are real multi-line markdown documents, and flattening an index or an instruction file would make
 * it unreadable. Only the tag itself is a containment problem here.
 */
export function neutralizeReminderTags(text: string): string {
  return text.replace(/<\/?system-reminder>/gi, "[tag]");
}

/**
 * Wraps a body as a labelled, harness-injected block. `label` is authored text (a caption naming
 * the file and why it is here); `body` is file content and is neutralised before wrapping.
 */
export function systemReminder(label: string, body: string): string {
  return `<system-reminder>\n${label}\n${neutralizeReminderTags(body)}\n</system-reminder>`;
}

/**
 * Read a UTF-8 file, capped at `maxBytes`. `null` for missing / unreadable / not-a-regular-file /
 * empty -- all four are "there is nothing to inject", which is not an error condition.
 */
export function readCapped(path: string, maxBytes: number): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    const raw = readFileSync(path, "utf8");
    if (raw.length === 0) return null;
    const { text, truncated } = capBytes(raw, maxBytes);
    return truncated ? text + TRUNCATION_MARKER : text;
  } catch {
    return null;
  }
}

/**
 * Read a UTF-8 file capped at `maxLines` AND `maxBytes`, WHICHEVER HITS FIRST (WS-05 §11's
 * memory-index rule; lines are counted before bytes so a 25 KB budget cannot smuggle in a
 * 10 000-line file). `null` on the same four "nothing to inject" cases as `readCapped`.
 */
export function readCappedLinesAndBytes(path: string, maxLines: number, maxBytes: number): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    let raw = readFileSync(path, "utf8");
    if (raw.length === 0) return null;
    let truncated = false;
    const lines = raw.split("\n");
    if (lines.length > maxLines) {
      raw = lines.slice(0, maxLines).join("\n");
      truncated = true;
    }
    const capped = capBytes(raw, maxBytes);
    return capped.truncated || truncated ? capped.text + TRUNCATION_MARKER : capped.text;
  } catch {
    return null;
  }
}
