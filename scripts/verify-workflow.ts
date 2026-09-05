// Phase 5 Lane W (task 4), WS-11 §1.7: `bun run verify:workflow` -- the COMPILED-BINARY proof gate,
// carried over from Norma ("`verify:workflow` stays the compiled-binary proof gate").
//
// WHY A SEPARATE SCRIPT AT ALL, when `worker.darwin.test.ts` already runs a real sandboxed worker:
// because a compiled `$bunfs` single-file executable and `bun src/main.ts` are NOT guaranteed to
// behave the same. Dynamic `import()` of a computed path, `import.meta.dir`-relative loads and
// runtime `require.resolve` all work in dev and silently break once bundled -- and the workflow
// worker is reached through exactly the mechanism most likely to trip on that: the binary re-invoking
// ITSELF with an argv flag. Nothing but an actual compile can prove that leg, which is the same
// reason `verify:compiled` exists next door.
//
// WHAT IT PROVES, end to end, on the real artifact:
//   compiled binary -> main.ts's `__workflow-worker` dispatch -> workflowWorkerMain -> the script API
//   -> an `agent()` request over the NDJSON bridge -> the parent's service loop -> a `done` frame ->
//   a completed run whose result is the script's return value.
//
// THE `78` REPORT. `WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE` is what a worker returns when it was
// reached but is not being driven -- which is precisely the answer a spine-only build gives for EVERY
// invocation, driven or not. So a run that dies with `code 78` is reported as "the dispatch works,
// the worker is not implemented" rather than as an indistinguishable failure. That is the RED half of
// this gate, and it is reachable on demand with `--bin` (see below).
//
// Usage:
//   bun run scripts/verify-workflow.ts              # compile to a temp path, then verify
//   bun run scripts/verify-workflow.ts --bin <path> # verify an EXISTING binary (how the RED half is proved)
//   bun run scripts/verify-workflow.ts --keep       # leave the compiled binary in place for inspection
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntime } from "./build-runtime.ts";
import { WorkflowRuntime, realWorkerSpawner } from "../packages/runtime/src/workflows/runtime.ts";
import { WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG } from "../packages/runtime/src/workflows/subprocess-entry.ts";
import { WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE } from "../packages/runtime/src/workflows/subprocess-entry.ts";
import { workflowSandboxAvailable } from "../packages/runtime/src/workflows/sandbox.ts";
import { fakeWorkflowRunHost } from "../packages/runtime/src/workflows/seam.ts";
import { fakeStructuredOutputSeam } from "../packages/runtime/src/structured/seam.ts";
import { createContextAccountant } from "../packages/runtime/src/engine.ts";
import type { ChildHandle, ChildResult } from "../packages/runtime/src/subagents/child-handle.ts";

// One `agent()` call, one `phase()`, one `log()`, and a return value derived from the agent's answer:
// enough that a worker which merely STARTS cannot produce it by accident.
const SCRIPT = `export const meta = { name: "verify", description: "the compiled-binary proof workflow" };
phase("Verify");
log("asking one agent");
const answer = await agent("what is the answer");
return { answer, doubled: answer + answer };
`;

const EXPECTED = JSON.stringify({ answer: "42", doubled: "4242" });

function stubChild(content: string): ChildHandle {
  const result: ChildResult = { status: "completed", content };
  return {
    record: {
      id: "verify-child",
      parentSessionId: "verify",
      parentToolUseId: "verify",
      transcript: "",
      status: "completed",
      runtime: "winter-agent",
      model: { effectiveModel: "verify", effectiveEffort: "medium" },
      permission: { effectiveMode: "default", parentPolicyHash: "h", parentPolicyVersion: 1 },
    },
    status: () => "completed",
    steer: async () => ({ status: "delivered", messageId: "m" }),
    resume: async () => ({ status: "resumed_and_delivered", messageId: "m" }),
    result: async () => result,
    stop: async () => {},
  };
}

export interface VerifyWorkflowResult {
  ok: boolean;
  /** True when the run died with the not-implemented exit code -- "dispatch works, worker unimplemented". */
  workerUnimplemented: boolean;
  status: string;
  detail: string;
}

export async function verifyWorkflow(binPath: string): Promise<VerifyWorkflowResult> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-verify-wf-home-"));
  const sessionTempDir = mkdtempSync(join(tmpdir(), "winter-verify-wf-temp-"));
  // On a host without `sandbox-exec` (the linux CI runner) the worker is spawned unsandboxed and the
  // run says so -- this gate's subject is the COMPILED dispatch, and refusing to run it at all on
  // linux would leave the compiled leg unverified there. The seatbelt itself has its own darwin-gated
  // proof (`workflows/worker.darwin.test.ts`), which is where that claim belongs.
  const sandbox = workflowSandboxAvailable();
  const runtime = new WorkflowRuntime({
    session: {
      winterHome,
      projectKey: "-verify",
      sessionTempDir,
      structured: fakeStructuredOutputSeam(),
      accountant: createContextAccountant({ limit: 100_000 }),
    },
    workerCommand: () => ({ file: binPath, args: [WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG] }),
    spawnWorker: realWorkerSpawner({ sandbox }),
    requireSandbox: false,
  });
  const host = fakeWorkflowRunHost({
    structured: fakeStructuredOutputSeam(),
    accountant: createContextAccountant({ limit: 100_000 }),
    spawnAgent: async () => stubChild("42"),
  });

  const launched = runtime.launch(
    {
      sessionId: "verify-session",
      cwd: sessionTempDir,
      trustedWorkspace: false,
      parentToolUseId: "tooluse-e2e",
      source: SCRIPT,
      meta: { name: "verify", description: "the compiled-binary proof workflow" },
    },
    host,
  );
  try {
    const view = await runtime.await(launched.runId);
    const detail = view.status === "completed" ? (view.result ?? "") : (view.error ?? "");
    return {
      ok: view.status === "completed" && detail === EXPECTED,
      workerUnimplemented: detail.includes(`code ${WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE}`),
      status: view.status,
      detail,
    };
  } finally {
    runtime.killWorkerForTest(launched.runId);
    rmSync(winterHome, { recursive: true, force: true });
    rmSync(sessionTempDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const binIdx = process.argv.indexOf("--bin");
  const providedBin = binIdx === -1 ? undefined : process.argv[binIdx + 1];
  const keep = process.argv.includes("--keep");
  const workDir = providedBin === undefined ? mkdtempSync(join(tmpdir(), "winter-verify-workflow-")) : undefined;
  try {
    let binPath: string;
    if (providedBin !== undefined) {
      if (!existsSync(providedBin)) {
        console.error(`verify:workflow -- no binary at ${providedBin}`);
        process.exitCode = 1;
        throw new Error("stop");
      }
      binPath = providedBin;
      console.log(`verify:workflow -- using the provided binary ${binPath}`);
    } else {
      binPath = join(workDir!, "winter");
      console.log("verify:workflow -- compiling the winter runtime to a temp path...");
      await buildRuntime({ out: binPath });
    }

    console.log(`verify:workflow -- running one real workflow through ${binPath} ${WORKFLOW_WORKER_ARGV_FLAG} ...`);
    const result = await verifyWorkflow(binPath);
    if (result.ok) {
      console.log(`verify:workflow OK -- the compiled binary ran the workflow end to end and returned ${result.detail}`);
    } else if (result.workerUnimplemented) {
      // The RED half, reported as itself. This is the exact message a spine-only build produces, and
      // the reason exit code 78 is distinct from a generic 1.
      console.error(
        `verify:workflow FAILED -- the argv dispatch WORKS (the binary reached __workflow-worker) but the worker is not implemented: it exited ${WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE}.\n  detail: ${result.detail}`,
      );
      process.exitCode = 1;
    } else {
      console.error(`verify:workflow FAILED -- run status ${result.status}\n  expected: ${EXPECTED}\n  actual:   ${result.detail}`);
      process.exitCode = 1;
    }
  } catch (err) {
    if (!(err instanceof Error && err.message === "stop")) {
      console.error(`verify:workflow FAILED -- ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exitCode = 1;
    }
  } finally {
    // `process.exitCode`, never `process.exit()` -- exiting here would skip this cleanup and leak a
    // ~60MB binary into the real $TMPDIR on every failing run (verify-protocol-compiled.ts's own
    // Finding A, and the same fix).
    if (workDir !== undefined && !keep) rmSync(workDir, { recursive: true, force: true });
  }
}
