// The `<sandbox_violations>` block is a macOS Seatbelt feature. The Linux Cowork guest runs the SAME
// Bash executor (`guest/process-tools.ts`'s `guestBash`, reached first from `bashExecutor`) and
// advertises the Bash description an engine renders on a host without `sandbox-exec`; both must stay
// byte-identical to what they were before the block existed. The goldens below were captured from
// origin/main 5183d3a9 (the commit this feature branched from), not computed from the code under test.
import { describe, expect, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createGuestFileSession } from "../guest/file-session.ts";
import type { GuestProcessPort, GuestProcessRequest } from "../guest/process-helper.ts";
import { buildRegistryToolExecutor, type RegistryToolExecutorDeps } from "./registry.ts";
import "./impl/index.ts";
import { runEngine, type Provider, type ProviderRequest } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { stubExecutor } from "../provider/mock.ts";
import { isSandboxAvailable } from "../sandbox/spawn.ts";
import { setViolationMonitorSpawnersForTest } from "../sandbox/violations.ts";
import { bashDescriptionFor } from "./descriptors/bash.ts";

// origin/main 5183d3a9: a guest Bash call whose process exited 1 with stdout and stderr.
const GOLDEN_GUEST_FAILURE = {
  output: "partial out\n[stderr]\nopen: Operation not permitted\n[Exit code: 1; cwd changes apply to this command only]",
  isError: true,
};
// origin/main 5183d3a9: the Bash description with no sandbox section -- what an engine advertises
// where `sandbox-exec` does not exist (engine.ts's `bashSandboxFacts` returns undefined there).
const GOLDEN_UNSANDBOXED_DESCRIPTION =
  "Fresh shell per call; cwd changes persist only within allowed working directories; env exports do not persist. run_in_background returns a background task. Recognized read-only forms are built-in pre-approvals.";

function guestExecutor() {
  const authority = { workspaceId: "workspace", sessionId: "guest", incarnationId: "boot", leaseEpoch: 1, configRevision: 2, grantRevision: 3, policyRevision: 4 };
  const port: GuestProcessPort = {
    async execute(request: GuestProcessRequest) {
      return {
        protocolVersion: 1,
        requestId: request.requestId,
        authority: request.authority,
        exitCode: 0,
        stdout: JSON.stringify({ version: 1, ok: true, exitCode: 1, termination: "exit", stdoutBase64: Buffer.from("partial out").toString("base64"), stderrBase64: Buffer.from("open: Operation not permitted").toString("base64") }),
      };
    },
  };
  const guest = createGuestFileSession({
    authority,
    roots: [{ id: "source", guestPath: "/workspace/source", readOnly: false }],
    expectedUid: 10001,
    port: { execute: async () => { throw new Error("file port must not execute"); } },
    processPort: port,
    maxOutputBytes: 1024,
  });
  const forbidden = () => { throw new Error("trusted runtime consumer reached"); };
  const deps = {
    executionPosture: "confined-guest", guestFiles: guest, sessionId: "guest", home: "/protected/runtime", getCwd: () => "/workspace/source/nested",
    getTempDir: forbidden, probeReadAccess: forbidden, readState: { lookup: forbidden, recordRead: forbidden }, emitFrame: forbidden, sandboxSettings: {}, env: {},
    session: { setCwd: forbidden, getSessionRoot: forbidden, getBoundedRoots: forbidden, setSessionRoot: forbidden, addBoundedRoot: forbidden, removeBoundedRoot: forbidden, getPermissionMode: forbidden, setPermissionMode: forbidden },
  } as unknown as RegistryToolExecutorDeps;
  return buildRegistryToolExecutor(deps);
}

async function advertisedBashDescription(): Promise<string> {
  const requests: ProviderRequest[] = [];
  const provider: Provider = { async generate(input) { requests.push(input); return { kind: "text", text: "done" }; } };
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({ config: { sessionId: "guest-pin", cwd: "/tmp/x", model: "sonnet", persistSession: false } as RuntimeConfig, input: runtime.input, output: runtime.output, provider, tools: stubExecutor } as never);
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  for await (const f of host.input) frames.push(f);
  await done;
  const bash = (requests[0]?.tools ?? []).find((t) => t.name === "Bash");
  if (bash === undefined) throw new Error("the session advertised no Bash tool");
  return bash.description;
}

describe("the Linux guest's Bash is untouched by the macOS <sandbox_violations> block", () => {
  test("a failing guest command's result is byte-identical to origin/main, and the guest path never starts a macOS log stream", async () => {
    let queries = 0;
    const restore = setViolationMonitorSpawnersForTest({
      stream() {
        queries++;
        throw new Error("no stream expected");
      },
      canary() {},
    });
    try {
      const result = await guestExecutor().execute({ id: "call", name: "Bash", input: { command: "open -a Safari" } });
      expect(result).toEqual(GOLDEN_GUEST_FAILURE);
      expect(queries).toBe(0);
    } finally {
      restore();
    }
  });

  test("the no-sandbox Bash description is byte-identical to origin/main", () => {
    expect(bashDescriptionFor(undefined)).toBe(GOLDEN_UNSANDBOXED_DESCRIPTION);
  });

  // Runs where the guest runs: a host with no `sandbox-exec` (Linux CI). There the engine advertises
  // no sandbox section at all, so the evidence line added to that section never reaches the guest.
  test.if(!isSandboxAvailable())("on a host without sandbox-exec the engine advertises exactly the origin/main description", async () => {
    expect(await advertisedBashDescription()).toBe(GOLDEN_UNSANDBOXED_DESCRIPTION);
  });
});
