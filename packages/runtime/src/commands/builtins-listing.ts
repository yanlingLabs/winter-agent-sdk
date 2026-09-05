// Phase 5 Lane S: the `system/init.slash_commands` producer (`sdk.d.ts:4874`, `string[]`).
//
// The init frame must list EVERY `/name` a session answers to, which spans two owners: the ENGINE's
// built-ins (commands/seam.ts's `resolveBuiltinCommand`, claimed before any resolver is consulted)
// and this lane's filesystem/plugin/skill commands. Neither side can produce the list alone, so it
// is composed here -- and the built-ins go FIRST, which is also the order they are matched in.
//
// `SlashCommand` (`sdk.d.ts:7932-7949`) is `{ name, description, argumentHint, aliases? }` -- the
// richer shape a control-channel `reloadSkills()` response traffics in. `system/init` itself carries
// only names, so both producers are exported: `buildSlashCommandListing` for the full shape and
// `slashCommandNames` for the init field.
import type { FilesystemCommandResolver, SlashCommandInfo } from "./resolver.ts";

/**
 * The engine's own commands. DELIBERATELY ONE ENTRY: R5-14 ships `/compact [instructions]` and marks
 * every other built-in capture-pending, and `CommandResolution`'s `builtin` arm is a single literal
 * for the same reason. Adding one here without adding the engine branch would advertise a command
 * that resolves to nothing.
 */
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommandInfo[] = [
  { name: "compact", description: "Compact the conversation, optionally with custom instructions.", argumentHint: "[instructions]", source: "builtin" },
] as const;

/**
 * The full listing: built-ins, then command files (project > user > plugin), then skills. Names are
 * deduplicated across all three, first occurrence winning -- which is exactly the order `resolve()`
 * consults them in, so the listing can never advertise a name that a different producer answers.
 */
export function buildSlashCommandListing(resolver?: FilesystemCommandResolver, cwd?: string): SlashCommandInfo[] {
  const out: SlashCommandInfo[] = [];
  const seen = new Set<string>();
  for (const builtin of BUILTIN_SLASH_COMMANDS) {
    seen.add(builtin.name);
    out.push({ ...builtin });
  }
  for (const command of resolver?.list(cwd) ?? []) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    out.push(command);
  }
  return out;
}

/** `system/init.slash_commands` (`4874`): names only, in listing order. */
export function slashCommandNames(resolver?: FilesystemCommandResolver, cwd?: string): string[] {
  return buildSlashCommandListing(resolver, cwd).map((c) => c.name);
}
