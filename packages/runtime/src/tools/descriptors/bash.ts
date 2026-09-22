// WS-06 §3.2 "Bash" -- implement-now, captured, verbatim schema. [WS-12] owns the execution/sandbox
// contract (Lane C, Task 3); this file only pins the descriptor.
//
// THE SANDBOX SECTION (dist-session fixes E3, 2026-09-22). A model that is not told its shell has no
// network tells the user `curl` works and then watches every first network attempt fail inside the
// sandbox. claude's Bash tool carries a "command sandbox" section for exactly this; the strings below
// are COPIED VERBATIM from claude (the pinned 0.3.250 binary's `## <Bash> command sandbox` builder,
// except the one line named below) per the project owner's ruling that claude INTERFACE strings may
// ship verbatim -- only this comment block and the identifiers are Winter's own. Three things claude says are NOT carried, because each
// is false here and saying it would add behaviour claude's text promises and Winter does not have:
//   - "Be sure to mention that the user can use the `/sandbox` command to manage restrictions." --
//     Winter has no `/sandbox` command;
//   - "Network egress goes through a filtering proxy ... `<sandbox_violations>` block" -- Winter's
//     Seatbelt profile denies the network outright (`resolveNetworkPosture`); there is no proxy and no
//     violations block;
//   - "This goes through the permission gate (a user prompt, or the auto-mode classifier when auto
//     mode is active)" -- Winter makes the override MANDATORY INTERACTION (RULING P3-J), never
//     classifier-approved, so claude's earlier wording of the same bullet, "This will prompt the user
//     for permission", is the one that is true.
// ONE LINE IS NOT FROM THE PINNED BINARY, deliberately: the restrictions line `Network:
// {"allowedHosts":[]}`. It is claude's own `networkConfig` rendering from its Bash prompt SOURCE (an
// `allowedHosts` list, here empty) -- the pinned 0.3.250 builder renders only `deniedHosts` and
// `allowUnixSockets` and instead tells the model "attempt requests and read the error" through the
// filtering proxy, which is false here. For Winter's deny-all Seatbelt posture the empty allowlist is
// the only claude-authored string that states the fact the model was missing: nothing is reachable.
//
// PER SESSION, like WebFetch's lean/full choice: a descriptor is a process-wide singleton and cannot see
// a session's sandbox, so the static registration carries the base description and `engine.ts`'s
// `toolSpecFor` renders `bashDescriptionFor(...)` per request from the session's effective settings.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

/** The name `engine.ts`'s `toolSpecFor` branches on, so no tool name is a literal there. */
export const BASH_CANONICAL_NAME = "Bash";

/** The static, sandbox-agnostic description -- what a session with no sandbox advertises, and what any reader outside a session sees. */
export const BASH_DESCRIPTION =
  "Fresh shell per call; cwd changes persist only within allowed working directories; env exports do not persist. run_in_background returns a background task. Recognized read-only forms are built-in pre-approvals.";

export const BASH_SANDBOX_HEADING = "## Bash command sandbox";

/** The facts the section is rendered from. Absent (`bashDescriptionFor(undefined)`) means commands do not run in a sandbox at all. */
export interface BashSandboxFacts {
  /** The Seatbelt profile's resolved network posture (`resolveNetworkPosture`). `false` in every v1 configuration. */
  networkAllowed: boolean;
}

/** claude's `prependBullets`: a top-level item is ` - item`, a nested one `  - item`. */
function bullets(items: Array<string | string[]>): string[] {
  return items.flatMap((item) => (Array.isArray(item) ? item.map((sub) => `  - ${sub}`) : [` - ${item}`]));
}

export function bashSandboxSection(facts: BashSandboxFacts): string {
  const restrictions = facts.networkAllowed ? [] : ['Network: {"allowedHosts":[]}'];
  const items: Array<string | string[]> = [
    "You should always default to running commands within the sandbox. Do NOT attempt to set `dangerouslyDisableSandbox: true` unless:",
    [
      "The user *explicitly* asks you to bypass sandbox",
      "A specific command just failed and you see evidence of sandbox restrictions causing the failure. Note that commands can fail for many reasons unrelated to the sandbox (missing files, wrong arguments, network issues, etc.).",
    ],
    "Evidence of sandbox-caused failures includes:",
    ['"Operation not permitted" errors for file/network operations', "Access denied to specific paths outside allowed directories", "Network connection failures to non-whitelisted hosts", "Unix socket connection errors"],
    "When you see evidence of sandbox-caused failure:",
    ["Immediately retry with `dangerouslyDisableSandbox: true` (don't ask, just do it)", "Briefly explain what sandbox restriction likely caused the failure.", "This will prompt the user for permission"],
    "Treat each command you execute with `dangerouslyDisableSandbox: true` individually. Even if you have recently run a command with this setting, you should default to running future commands within the sandbox.",
    "Do not suggest adding sensitive paths like ~/.bashrc, ~/.zshrc, ~/.ssh/*, or credential files to the sandbox allowlist.",
    "For temporary files, always use the `$TMPDIR` environment variable. TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode. Do NOT use `/tmp` directly - use `$TMPDIR` instead.",
  ];
  return [
    BASH_SANDBOX_HEADING,
    "By default, Bash tool commands run in a sandbox. This sandbox controls which directories and network hosts commands may access or modify without an explicit override.",
    "",
    ...(restrictions.length > 0 ? ["The sandbox has the following restrictions:", ...restrictions, ""] : []),
    ...bullets(items),
  ].join("\n");
}

/** The description a session advertises: the base text, plus the sandbox section when its commands run sandboxed. */
export function bashDescriptionFor(facts: BashSandboxFacts | undefined): string {
  return facts === undefined ? BASH_DESCRIPTION : `${BASH_DESCRIPTION}\n\n${bashSandboxSection(facts)}`;
}

stub({
  canonicalName: BASH_CANONICAL_NAME,
  advertisedName: BASH_CANONICAL_NAME,
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number", description: "ms; 2 min default, 10 min ordinary ceiling, declaration caps at 600000" },
      description: { type: "string" },
      run_in_background: { type: "boolean" },
      // claude's own field text, verbatim (E3). The override still never bypasses permission policy:
      // RULING P3-J makes it mandatory interaction, which the sandbox section above now tells the model.
      dangerouslyDisableSandbox: { type: "boolean", description: "Set this to true to dangerously override sandbox mode and run commands without sandboxing." },
    },
    required: ["command"],
  },
  description: BASH_DESCRIPTION,
  exposure: "eager",
  permissionClass: "execute",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
