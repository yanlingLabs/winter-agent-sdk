// WS-06 §3.2 "Bash" -- implement-now, captured, verbatim schema. [WS-12] owns the execution/sandbox
// contract (Lane C, Task 3); this file only pins the descriptor.
//
// THE SANDBOX SECTION (dist-session fixes E3, 2026-09-22). A model that is not told its shell has no
// network tells the user `curl` works and then watches every first network attempt fail inside the
// sandbox. claude's Bash tool carries a "command sandbox" section for exactly this. The strings below
// are claude's own INTERFACE strings (its Bash tool description's `## Bash command sandbox` section),
// shipped verbatim per the project owner's ruling -- WITH THESE DEVIATIONS, each because the claude
// text would be false for Winter:
//   - the restrictions block carries only the NETWORK line, in claude's `Network: {"allowedHosts":[]}`
//     form (an allowlist admitting nothing). claude's own section lists denied hosts / Unix sockets
//     and leans on a filtering-proxy sentence; Winter's Seatbelt profile denies the network outright
//     (`resolveNetworkPosture`), so the empty allowlist is the only claude-authored string that states
//     what the model was missing;
//   - claude's FILESYSTEM line (`{read:{denyOnly},write:{allowOnly,denyWithinAllow}}`) is OMITTED. Its
//     truthful content is per CALL, not per session: the writable roots follow the call's own `cwd`,
//     the session's bounded roots (which EnterWorktree and added directories move), `$TMPDIR`, the
//     outputs dir and `filesystem.allowWrite`, and the deny layers include per-root control-plane
//     literals, the backups store, the provider-state read regex and the per-user temp dir's
//     direct-children allowance (`buildSeatbeltProfile`). A line rendered once per request would state
//     a subset of that -- a claim the executor does not enforce as written;
//   - "Briefly explain what sandbox restriction likely caused the failure." is SHORTENED: its second
//     sentence names a `/sandbox` command Winter does not have;
//   - the "Network egress goes through a filtering proxy. Attempt requests and read the error rather
//     than predicting whether a host is reachable; denied connections are reported in a
//     `<sandbox_violations>` block explaining the reason" bullet is DROPPED: there is no proxy -- the
//     profile denies the network outright, so no host is reachable to attempt. claude's other sentence
//     naming the block ("If the `<sandbox_violations>` block names a denied host, re-run the command
//     with that host in its `allowed_domains` (auto mode); otherwise ...") is not carried either: it
//     names an `allowed_domains` parameter Winter does not have;
//   - the evidence list carries ONE item that is Winter's, not claude's: "A `<sandbox_violations>`
//     block in the output, listing what the sandbox denied while the command ran". Winter's Bash
//     result now carries that block (`sandbox/violations.ts`: a FAILED sandboxed command's own
//     Seatbelt denials, read from the macOS unified log, baseline start-up denials removed), and the
//     two claude sentences above are the only ones that name it -- both tied to a proxy or a
//     parameter Winter lacks. Only the override variant has an evidence list, so only it gains the item;
//   - claude's `open`/`osascript` bullet ("Opening an app, file or URL with `open` ... is blocked
//     inside this sandbox ... do not retry it with `dangerouslyDisableSandbox: true`. Tell the user
//     ...") is NOT carried: in Winter such a failure is retried with the override like any other
//     sandbox-caused failure (it goes through the permission gate), and the violations block shows the
//     refused LaunchServices lookup as the evidence;
//   - claude's counterweight to that retry advice IS carried, ADAPTED in one phrase: "A sandbox denial
//     on a credential, a file or a host that the task does not involve is the boundary above at work:
//     tell the user rather than retrying with `dangerouslyDisableSandbox: true`." -- "the boundary
//     above" becomes "the sandbox", because the boundary it points at in claude (a filesystem sentence
//     about Claude Code's own settings and the user's credentials) is not rendered here. It stands
//     where claude puts it, right after the "When you see evidence ..." list, in the override variant
//     only; with the violations block listing every denial a failed command hit, it is what keeps a
//     denial the task never needed (a credential read, a cache write) from becoming a retry.
// Under `sandbox.allowUnsandboxedCommands: false` the override guidance is replaced by claude's own
// "disabled by policy" bullets, verbatim -- true there, because the runtime then IGNORES the flag and
// runs the command sandboxed (`sandbox/spawn.ts`), as claude does.
//
// The override bullet is claude's "This goes through the permission gate", WITHOUT its
// parenthetical "(a user prompt, or the auto-mode classifier when auto mode is active)": an escape is
// decided by the permission gate as claude decides it -- an allow rule or bypass runs it, dontAsk
// denies it -- but one nothing sanctioned goes to the PermissionRequest hook and the host's
// `canUseTool` in EVERY other mode, auto included, never to the classifier
// (`permissions/evaluator.ts`'s `resolveSandboxEscape`). "Goes through the permission gate" is true of
// every one of those answers; the clause naming a classifier is not.
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

/** claude's counterweight to the retry advice, one phrase adapted (see the header). */
export const SANDBOX_DENIAL_COUNTERWEIGHT =
  "A sandbox denial on a credential, a file or a host that the task does not involve is the sandbox at work: tell the user rather than retrying with `dangerouslyDisableSandbox: true`.";

/** The evidence-list item naming the `<sandbox_violations>` block -- Winter's wording (see the header). */
export const SANDBOX_VIOLATIONS_EVIDENCE = "A `<sandbox_violations>` block in the output, listing what the sandbox denied while the command ran";

/** The facts the section is rendered from. Absent (`bashDescriptionFor(undefined)`) means commands do not run in a sandbox at all. */
export interface BashSandboxFacts {
  /** The Seatbelt profile's resolved network posture (`resolveNetworkPosture`). `false` in every v1 configuration. */
  networkAllowed: boolean;
  /**
   * Whether `dangerouslyDisableSandbox` can take a command out of the sandbox at all --
   * `sandbox.allowUnsandboxedCommands !== false`. When it cannot, claude's "disabled by policy"
   * bullets replace the override guidance (the runtime then ignores the flag, `sandbox/spawn.ts`).
   * Absent reads as allowed.
   */
  unsandboxedAllowed?: boolean;
}

/** claude's bullet format: a top-level item is ` - item`, a nested one `  - item`. */
function bullets(items: Array<string | string[]>): string[] {
  return items.flatMap((item) => (Array.isArray(item) ? item.map((sub) => `  - ${sub}`) : [` - ${item}`]));
}

export function bashSandboxSection(facts: BashSandboxFacts): string {
  const restrictions = facts.networkAllowed ? [] : ['Network: {"allowedHosts":[]}'];
  const overrideItems: Array<string | string[]> =
    facts.unsandboxedAllowed === false
      ? [
          "All commands MUST run in sandbox mode - the `dangerouslyDisableSandbox` parameter is disabled by policy.",
          "Commands cannot run outside the sandbox under any circumstances.",
          "If a command fails due to sandbox restrictions, work with the user to adjust sandbox settings instead.",
        ]
      : [
          "You should always default to running commands within the sandbox. Do NOT attempt to set `dangerouslyDisableSandbox: true` unless:",
          [
            "The user *explicitly* asks you to bypass sandbox",
            "A specific command just failed and you see evidence of sandbox restrictions causing the failure. Note that commands can fail for many reasons unrelated to the sandbox (missing files, wrong arguments, network issues, etc.).",
          ],
          "Evidence of sandbox-caused failures includes:",
          [
            '"Operation not permitted" errors for file/network operations',
            "Access denied to specific paths outside allowed directories",
            "Network connection failures to non-whitelisted hosts",
            "Unix socket connection errors",
            // Winter's own line, not claude's -- see this file's header.
            SANDBOX_VIOLATIONS_EVIDENCE,
          ],
          "When you see evidence of sandbox-caused failure:",
          ["Immediately retry with `dangerouslyDisableSandbox: true` (don't ask, just do it)", "Briefly explain what sandbox restriction likely caused the failure.", "This goes through the permission gate"],
          // claude's counterweight, "the boundary above" adapted to "the sandbox" -- see this file's header.
          SANDBOX_DENIAL_COUNTERWEIGHT,
          "Treat each command you execute with `dangerouslyDisableSandbox: true` individually. Even if you have recently run a command with this setting, you should default to running future commands within the sandbox.",
          "Do not suggest adding sensitive paths like ~/.bashrc, ~/.zshrc, ~/.ssh/*, or credential files to the sandbox allowlist.",
        ];
  const items: Array<string | string[]> = [
    ...overrideItems,
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
