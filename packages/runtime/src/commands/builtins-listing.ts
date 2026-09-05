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
 * The full listing: built-ins, then whatever the resolver enumerates (skills, then command files
 * project > user > plugin), first occurrence winning.
 *
 * THE INVARIANT, STATED EXACTLY: **for a given `cwd`**, every name listed here resolves at that same
 * `cwd`, and to the producer this listing names. Two qualifications, both load-bearing:
 *
 *  - **The `cwd` is part of the statement** (fix round 2, Minor B). Command files are discovered by a
 *    parent-walk from the cwd, so the enumeration genuinely differs between cwds, and
 *    `FilesystemCommandResolver.list()` defaults to the resolver's CONSTRUCTION cwd while
 *    `resolve()` always uses the live one it is handed. A caller that lists at one cwd and resolves
 *    at another is comparing two different namespaces, and the invariant says nothing about that
 *    pair. Pass `cwd` here whenever the session's cwd may have moved since construction.
 *  - **Aliases resolve but are not listed** (fix round 2, Medium A). `/.winter:review` resolves to
 *    the same skill `/review` does; only `review` is advertised. So the invariant is one-directional:
 *    everything listed resolves, but not everything that resolves is listed.
 *
 * WHAT ENFORCES IT: `FilesystemCommandResolver.enumerate()` is the single ordered map both `list()`
 * and `resolve()` read. It used to be a claim resting on two loops happening to agree, and they did
 * not -- `list()` walked command files first while `resolve()` walked skills first, so a shadowed
 * name was listed with the LOSING producer's description and source, and an `off` skill put a name
 * into `system/init.slash_commands` that `resolve()` answered `none` to.
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

/**
 * `system/init.slash_commands` (`4874`): names only, in listing order.
 *
 * PASS `cwd` when the session's working directory may have moved since the resolver was built -- see
 * the invariant above. Omitting it lists the construction cwd's namespace, which is correct at
 * startup (when the init frame is emitted) and stale afterwards.
 */
export function slashCommandNames(resolver?: FilesystemCommandResolver, cwd?: string): string[] {
  return buildSlashCommandListing(resolver, cwd).map((c) => c.name);
}
