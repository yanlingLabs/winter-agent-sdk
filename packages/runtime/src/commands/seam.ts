// Phase 5 Task 3 (spine): SLASH-COMMAND RESOLUTION -- R5-14. Lane S (task 5) implements the
// filesystem half (a project `commands/<name>.md`, a project `skills/<name>/SKILL.md`, plugin-supplied
// commands); the ENGINE owns the built-ins and owns the ordering between the two.
//
// The contract in one line: a user envelope is resolved to a CommandResolution BEFORE the model sees
// it. That "before" is the whole point -- `/name args` must expand to its body with `$ARGUMENTS`
// substituted, and the model must never observe the un-expanded form, which is why this cannot be a
// tool and cannot live downstream of the provider call.
//
// ORDERING, decided here rather than left to a lane: the engine recognises its OWN built-ins first,
// and only an unrecognised `/name` reaches the resolver. A filesystem command file named `compact`
// therefore cannot shadow `/compact`. The alternative (resolver first) would let an untrusted
// repository redefine a built-in that has real engine-side power, which is the same self-grant shape
// P5-A closes on the settings side.
//
// A prompt that does not begin with `/` never reaches the resolver at all -- resolution is not a
// general prompt-rewriting hook, and a lane must not treat it as one.

/**
 * `{ kind: "builtin" }` -- an engine-owned command. The union is deliberately a SINGLE literal today
 * (`"compact"`): R5-14 ships `/compact [instructions]` now and marks every other built-in
 * capture-pending, so a wider union would be inventing names the pinned surface has not been
 * observed to have. Adding one later is a one-line widening plus an engine branch; a lane never
 * produces this arm.
 *
 * `{ kind: "expand" }` -- `text` is the FULLY EXPANDED prompt (body with `$ARGUMENTS` already
 * substituted); the engine substitutes nothing itself. `source` is a human-readable provenance
 * string for diagnostics (e.g. a file path or `plugin:<name>`), never parsed.
 *
 * `{ kind: "none" }` -- not a command; the prompt is used verbatim.
 */
export type CommandResolution = { kind: "builtin"; name: "compact"; args: string } | { kind: "expand"; text: string; source: string } | { kind: "none" };

export interface CommandResolver {
  resolve(prompt: string, cwd: string): Promise<CommandResolution>;
}

/**
 * The one built-in, recognised by the engine before any resolver is consulted.
 *
 * Returns `undefined` for anything that is not a built-in -- including a bare `/` and any other
 * `/name`, both of which fall through to the resolver.
 *
 * Grammar, deliberately narrow: `/compact` optionally followed by whitespace and free-form
 * instructions, which are passed through verbatim (trimmed) as `custom_instructions`. `/compaction`
 * is NOT a match -- the name must be the whole first token.
 */
export function resolveBuiltinCommand(prompt: string): Extract<CommandResolution, { kind: "builtin" }> | undefined {
  if (!prompt.startsWith("/")) return undefined;
  const trimmed = prompt.trimEnd();
  const firstSpace = trimmed.search(/\s/);
  const name = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).slice(1);
  if (name !== "compact") return undefined;
  const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();
  return { kind: "builtin", name: "compact", args };
}

/** True for anything the engine should offer to a resolver at all -- see this file's header. */
export function looksLikeCommand(prompt: string): boolean {
  return prompt.startsWith("/") && prompt.length > 1 && !prompt.startsWith("//");
}

/**
 * The spine's test double: a resolver over a literal map of `name -> body`. `$ARGUMENTS` is
 * substituted exactly as R5-14 requires so an engine test proves the engine passes the EXPANDED text
 * on, and a lane has a producer to develop against.
 */
export function fakeCommandResolver(commands: Record<string, string>, opts?: { calls?: Array<{ prompt: string; cwd: string }> }): CommandResolver {
  return {
    async resolve(prompt: string, cwd: string): Promise<CommandResolution> {
      opts?.calls?.push({ prompt, cwd });
      if (!looksLikeCommand(prompt)) return { kind: "none" };
      const trimmed = prompt.trimEnd();
      const firstSpace = trimmed.search(/\s/);
      const name = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).slice(1);
      const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();
      const body = commands[name];
      if (body === undefined) return { kind: "none" };
      return { kind: "expand", text: body.split("$ARGUMENTS").join(args), source: `fake:${name}` };
    },
  };
}
