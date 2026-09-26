// WS-23 (embedded chat/dispatch): the postMessage contract between a HOST thread and the embedded
// runtime's Worker entry (`embedded-worker.ts`).
//
// DECLARATION-ONLY, and that is load-bearing. This module is imported by BOTH sides: the Worker
// entry, which evaluates the whole runtime graph, and the host bridge (`embedded-host.ts`), which a
// daemon imports on its MAIN thread. The runtime's module graph is not free to evaluate -- it
// registers every built-in tool into a module-level registry, installs identity/brand stacks and a
// child-engine factory (the per-realm singletons `subagents/register-default-factory.ts`'s
// ONE-LIVE-SESSION-PER-PROCESS note describes) -- and a host thread that evaluated it would carry a
// dead copy of all of it for its whole lifetime. So nothing here imports anything at runtime.
//
// THE SHAPE mirrors a child process on purpose: stdin chunks in, stdout/stderr chunks and an exit
// code out. The wire INSIDE those chunks is the unchanged NDJSON frame stream (WS-04 §2), so the
// wrapper's `query()`, the projector, the approval bridge and `sdk_mcp_call` cannot tell a Worker
// from a spawned `winter` -- which is the whole point: one protocol, two topologies.

/** A worker-side spawn command (the workflow worker's `(file, args)`), structurally `workflows/sandbox.ts`'s `WorkerCommand`. */
export interface EmbeddedWorkflowWorkerCommand {
  file: string;
  args: string[];
}

/** Host → Worker. `start` is sent exactly once, first; everything else may follow in any order. */
export type EmbeddedHostMessage =
  | {
      kind: "start";
      /** The same argv a spawned child gets (`--run --config-json <json>`); found by flag NAME, never by position. */
      argv: string[];
      /**
       * The workflow worker's spawn command as the HOST must spell it. Absent = the runtime's own
       * default (`process.execPath __workflow-worker --bridge`), which is WRONG inside a host binary
       * whose main routes `__workflow-worker` somewhere else -- see `workflows/sandbox.ts`.
       */
      workflowWorkerCommand?: EmbeddedWorkflowWorkerCommand;
    }
  | { kind: "stdin"; chunk: string }
  | { kind: "stdin-end" }
  /** The embedded SIGTERM: kill background process groups, end the turn, let the engine return. */
  | { kind: "abort" };

/** Worker → Host. `exit` is the last message a healthy Worker posts; the Worker closes right after it. */
export type EmbeddedWorkerMessage =
  | { kind: "stdout"; chunk: string }
  | { kind: "stderr"; chunk: string }
  | EmbeddedProcessGroupMessage
  | { kind: "exit"; code: number };

/**
 * WS-24: a process group the session's realm started (`add`) or saw end (`remove`) -- Bash/Monitor
 * commands, stdio MCP servers, command hooks, the workflow worker (`process-groups.ts`). The host keeps
 * the live set so that a Worker which dies WITHOUT running its own kill doors (a `terminate()` of a
 * spinning Worker, a crash) does not orphan them: `setsid` detached every one from the host process,
 * so nothing else will ever reap them. Posted in order with `stdout`, so by the time a healthy Worker's
 * `exit` arrives every group its teardown ended has already been removed.
 *
 * ADDITIVE: a host that predates it ignores an unknown `kind` (`embedded-host.ts`'s switch has no
 * default arm), and a runtime that predates it simply never posts one.
 */
export interface EmbeddedProcessGroupMessage {
  kind: "process-group";
  op: "add" | "remove";
  pgid: number;
}

/**
 * The request ids of the two control frames an ABORT synthesizes (`embedded.ts`). Fixed strings, not
 * UUIDs, so the output filter can recognise their acknowledgements without state: no host ever
 * mints a request id in this namespace (the wrapper uses `randomUUID()`).
 */
export const EMBEDDED_ABORT_END_INPUT_REQUEST_ID = "embedded-abort:end_input";
export const EMBEDDED_ABORT_INTERRUPT_REQUEST_ID = "embedded-abort:interrupt";
