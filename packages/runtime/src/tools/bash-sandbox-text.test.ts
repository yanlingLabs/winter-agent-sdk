// E3 (dist-session fixes, 2026-09-22): the model must know the Bash sandbox has NO network, and when to
// ask for `dangerouslyDisableSandbox`.
//
// What the installed app did (s_67c3894258d2): the assistant told the user "`curl` is there too", and
// every first network attempt (gh, curl) failed inside the sandbox before a `dangerouslyDisableSandbox`
// retry -- the Bash tool's description said nothing about the sandbox, its network posture or the
// override. claude's Bash tool carries a "command sandbox" section for exactly this; these tests pin
// that Winter now advertises claude's own text (the pinned 0.3.250 binary's strings plus the
// `Network: {"allowedHosts":[]}` line from claude's prompt SOURCE, with the deviations the descriptor's
// header lists) for a sandboxed session, rendered from the session's REAL sandbox posture, and nothing
// that is false for Winter.
import { describe, expect, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { runEngine, type Provider, type ProviderRequest } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { stubExecutor } from "../provider/mock.ts";
import { isSandboxAvailable } from "../sandbox/spawn.ts";
import { BASH_DESCRIPTION, BASH_SANDBOX_HEADING, bashDescriptionFor, bashSandboxSection } from "./descriptors/bash.ts";

// claude's own strings, spelled out here rather than imported: a test that read them from the module
// under test could not notice the module drifting from claude.
const CLAUDE_INTRO = "By default, Bash tool commands run in a sandbox. This sandbox controls which directories and network hosts commands may access or modify without an explicit override.";
const CLAUDE_OVERRIDE_BULLETS = [
  " - You should always default to running commands within the sandbox. Do NOT attempt to set `dangerouslyDisableSandbox: true` unless:",
  "  - The user *explicitly* asks you to bypass sandbox",
  "  - A specific command just failed and you see evidence of sandbox restrictions causing the failure. Note that commands can fail for many reasons unrelated to the sandbox (missing files, wrong arguments, network issues, etc.).",
  " - Evidence of sandbox-caused failures includes:",
  '  - "Operation not permitted" errors for file/network operations',
  "  - Access denied to specific paths outside allowed directories",
  "  - Network connection failures to non-whitelisted hosts",
  "  - Unix socket connection errors",
  " - When you see evidence of sandbox-caused failure:",
  "  - Immediately retry with `dangerouslyDisableSandbox: true` (don't ask, just do it)",
  "  - Briefly explain what sandbox restriction likely caused the failure.",
  "  - This goes through the permission gate (a user prompt, or the auto-mode classifier when auto mode is active)",
  " - Treat each command you execute with `dangerouslyDisableSandbox: true` individually. Even if you have recently run a command with this setting, you should default to running future commands within the sandbox.",
  " - Do not suggest adding sensitive paths like ~/.bashrc, ~/.zshrc, ~/.ssh/*, or credential files to the sandbox allowlist.",
  " - For temporary files, always use the `$TMPDIR` environment variable. TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode. Do NOT use `/tmp` directly - use `$TMPDIR` instead.",
];

describe("the Bash sandbox section (pure)", () => {
  test("a network-denied sandbox: claude's heading, intro, an empty host allowlist, and claude's override guidance -- in that order", () => {
    const section = bashSandboxSection({ networkAllowed: false });
    expect(section).toBe(
      [BASH_SANDBOX_HEADING, CLAUDE_INTRO, "", "The sandbox has the following restrictions:", 'Network: {"allowedHosts":[]}', "", ...CLAUDE_OVERRIDE_BULLETS].join("\n"),
    );
    expect(BASH_SANDBOX_HEADING).toBe("## Bash command sandbox");
  });

  test("nothing claude says that is FALSE for Winter: no `/sandbox` command, no filtering proxy, no <sandbox_violations> block", () => {
    const section = bashSandboxSection({ networkAllowed: false });
    expect(section).not.toContain("/sandbox");
    expect(section).not.toContain("filtering proxy");
    expect(section).not.toContain("sandbox_violations");
  });

  test("a sandbox whose network is open states no network restriction", () => {
    const section = bashSandboxSection({ networkAllowed: true });
    expect(section).not.toContain("Network:");
    expect(section).not.toContain("The sandbox has the following restrictions:");
    expect(section).toContain(CLAUDE_INTRO);
  });

  test("no sandbox -> the base description, byte-identical to the static registration", () => {
    expect(bashDescriptionFor(undefined)).toBe(BASH_DESCRIPTION);
    expect(bashDescriptionFor({ networkAllowed: false })).toBe(`${BASH_DESCRIPTION}\n\n${bashSandboxSection({ networkAllowed: false })}`);
  });
});

// --- what a real session advertises ---------------------------------------------------------------

function recordingProvider(): { provider: Provider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    provider: {
      async generate(input) {
        requests.push(input);
        return { kind: "text", text: "done" };
      },
    },
  };
}

async function advertisedBash(config: Partial<RuntimeConfig>): Promise<{ description: string; inputSchema: Record<string, unknown> }> {
  const { provider, requests } = recordingProvider();
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({ config: { sessionId: "e3", cwd: "/tmp/x", model: "sonnet", persistSession: false, ...config } as RuntimeConfig, input: runtime.input, output: runtime.output, provider, tools: stubExecutor } as never);
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  for await (const f of host.input) frames.push(f);
  await done;
  const bash = (requests[0]?.tools ?? []).find((t) => t.name === "Bash");
  if (bash === undefined) throw new Error("the session advertised no Bash tool");
  return { description: bash.description, inputSchema: bash.inputSchema as Record<string, unknown> };
}

describe("the Bash tool a session advertises", () => {
  test.if(isSandboxAvailable())("a default (sandboxed, network-denied) session tells the model the sandbox has no network and when to override", async () => {
    const { description } = await advertisedBash({});
    expect(description.startsWith(BASH_DESCRIPTION)).toBe(true);
    expect(description).toContain(BASH_SANDBOX_HEADING);
    expect(description).toContain('Network: {"allowedHosts":[]}');
    expect(description).toContain("  - Network connection failures to non-whitelisted hosts");
  });

  test("a session with the sandbox switched OFF advertises no sandbox section at all (claude: none when sandboxing is disabled)", async () => {
    const { description } = await advertisedBash({ sandbox: { enabled: false } } as Partial<RuntimeConfig>);
    expect(description).toBe(BASH_DESCRIPTION);
  });

  test("the override field reads as claude's own", async () => {
    const { inputSchema } = await advertisedBash({});
    const property = (inputSchema["properties"] as Record<string, { description?: string }>)["dangerouslyDisableSandbox"];
    expect(property?.description).toBe("Set this to true to dangerously override sandbox mode and run commands without sandboxing.");
  });
});
