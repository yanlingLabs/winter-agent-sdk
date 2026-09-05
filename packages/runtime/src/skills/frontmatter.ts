// Phase 5 Lane S (WS-11 §2.1/§2.5): SKILL.md parsing, the slug jail, and the byte caps -- PORTED
// from Norma's `packages/core/src/agent/skills.ts`, semantics only.
//
// WHAT CARRIES OVER, verbatim in behaviour: the frontmatter reader (a `---` fence at the very top,
// flat `key: value` lines, `name`/`description` both REQUIRED, quotes stripped), the slug jail
// `[a-z0-9][a-z0-9-]{0,63}` checked BEFORE any fs op touches a name, and the byte-boundary body cap.
//
// WHAT DOES NOT: the `claudeFormat` compat preamble RETIRES (WS-11 §2.5 -- Winter's tools are
// CC-shaped natively, so no tool-name translation context is needed). `author` stamping is KEPT as a
// flagged Winter extension, and is the only field beyond name/description this parser reads.
//
// WHY NOT `subagents/definitions.ts`'s `parseFrontmatter`: that one is TOTAL (an unterminated fence
// yields `{attrs:{}, body: raw}` -- an agent file with no frontmatter is still a usable prompt). A
// SKILL.md with no parseable frontmatter is NOT a usable skill: `description` is what the listing
// carries and what the model selects on, so the absence of one must make the whole file invisible,
// never a nameless entry in the index. Two different totality contracts over the same file shape;
// sharing one function would have to lose one of them.

/** WS-11 §2.5's jail, verbatim: lowercase alnum + dash, 1-64 chars, no separators/dots/underscores/uppercase. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A PLUGIN name may additionally carry the leading dot the canonical project plugin has
 * (`.winter`, WS-01 §2.4 / WS-11 §4) -- so the qualified form `.winter:<skill>` is expressible.
 * Otherwise the same jail: no path separators, no `..`, no whitespace.
 */
export const PLUGIN_NAME_PATTERN = /^\.?[a-z0-9][a-z0-9-]{0,63}$/;

/** Norma parity: the body cap applied at LOAD time (never at index time -- bodies are not read at index time at all). */
export const DEFAULT_SKILL_BODY_BYTES = 32_768;

/**
 * WINTER ADDITION, disclosed: a description byte cap applied at PARSE time so a pathological
 * SKILL.md cannot grow the in-memory index without bound. Deliberately far above
 * `skillListingMaxDescChars`' pinned default of 1536 CHARS (listing.ts), so the observable listing
 * is decided by that cap and never by this one -- this bounds memory, not presentation.
 */
export const DEFAULT_SKILL_DESCRIPTION_BYTES = 4_096;

/** Norma parity, byte-for-byte. */
export const SKILL_TRUNCATION_MARKER = "\n[…truncated]";

/**
 * `null` when the name is a legal slug; an error string otherwise.
 *
 * WHEN IT RUNS, precisely (fix round 1, corrected -- this used to say "before any fs op", which is
 * true of only one of the two callers): on the EXECUTOR path (`isLegalSkillIdentity`) it runs before
 * anything touches the filesystem, because the name comes from the model. On the INDEX path
 * (`SkillIndex.build`) the SKILL.md has already been read by then -- the jail is applied to the
 * RESOLVED name, which may come from the file's own `name:` frontmatter and so cannot be known
 * earlier. That is safe because the PATH the index reads is always built from `readdirSync` output,
 * never from a declared name; the jail's job there is to keep an escaping declared name out of the
 * index, not to protect the read.
 */
export function skillNameError(name: string): string | null {
  return SKILL_NAME_PATTERN.test(name) ? null : `invalid skill name "${name}"`;
}

/** `null` when the plugin name is legal (the leading-dot form included). */
export function pluginNameError(name: string): string | null {
  return PLUGIN_NAME_PATTERN.test(name) ? null : `invalid plugin name "${name}"`;
}

export interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
  /** Winter extension (WS-11 §2.5): the `author:` stamp `self`-tier skills carry. */
  author?: string;
}

/**
 * Cap `s` to `maxBytes` UTF-8 bytes on a byte boundary, appending the truncation marker when cut.
 * Norma's `capBytes`, unchanged -- including the deliberate detail that `subarray` may split a
 * multi-byte sequence, which `toString("utf8")` then renders as a replacement character rather than
 * throwing. A byte cap that silently became a character cap would stop bounding memory.
 */
export function capBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  return buf.byteLength <= maxBytes ? s : buf.subarray(0, maxBytes).toString("utf8") + SKILL_TRUNCATION_MARKER;
}

/**
 * Parse a SKILL.md's raw text. `null` for anything that is not a usable skill: no leading fence, an
 * unterminated fence, or a missing `description` (a missing `name` falls back to the DIRECTORY name,
 * which is how a skill authored without one still works).
 *
 * The fence must start at byte 0 -- a `---` deeper in the file is body text, never frontmatter.
 */
export function parseSkillFile(raw: string, fallbackName: string): ParsedSkillFile | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null;
  const fm = raw.slice(3, end);
  // Consume the REST of the closing fence LINE (so `---\r\n` and a fence with trailing characters
  // both work), then one optional blank separator line. Norma's port stripped only a single leading
  // newline, which left the conventional blank line after the fence at the head of every body --
  // harmless there, visible here because a skill body is handed to the model verbatim.
  const afterFence = raw.slice(end + 4);
  const eol = afterFence.indexOf("\n");
  const body = (eol === -1 ? "" : afterFence.slice(eol + 1)).replace(/^\r?\n/, "");
  let name = "";
  let description = "";
  let author = "";
  for (const line of fm.split("\n")) {
    const m = /^\s*(name|description|author)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (m[1] === "name") name = v;
    else if (m[1] === "description") description = v;
    else author = v;
  }
  if (!name) name = fallbackName;
  if (!name || !description) return null;
  return {
    name,
    description: capBytes(description, DEFAULT_SKILL_DESCRIPTION_BYTES),
    body,
    ...(author ? { author } : {}),
  };
}
