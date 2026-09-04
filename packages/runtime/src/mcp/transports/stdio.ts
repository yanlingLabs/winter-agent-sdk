// Phase 4 Task 4 (Lane A), WS-09 §1.1/§1.2 — RULING P4-H (fix round 1, MAJOR M1): Winter owns the
// stdio spawn. This file used to wrap the pinned @modelcontextprotocol/sdk's own
// `StdioClientTransport`; that transport's own env-isolation claim was FALSE at the pinned
// dependency (verified directly against the installed 1.30.0 source,
// `dist/esm/client/stdio.js:60-75`):
//
//   env: { ...getDefaultEnvironment(), ...this._serverParams.env }
//
// The six-name default environment (HOME, LOGNAME, PATH, SHELL, TERM, USER on non-Windows) is
// merged UNCONDITIONALLY underneath whatever `env` a caller supplies -- passing `env: {}` (this
// file's own original code) defeated NOTHING; those six names always reached the child regardless.
// `detached` is also never set on that transport, so no process-GROUP kill is possible -- only the
// direct child dies on close/timeout, leaving any grandchild (a shell wrapper, a forked helper)
// orphaned and reparented to init. Both facts were caught by review, not by this lane's own
// (insufficiently adversarial) test suite -- see the report's own Deviations for the full
// disclosure.
//
// `WinterStdioTransport` below is a from-scratch implementation of the SDK's own `Transport`
// interface (`shared/transport.d.ts`) over `node:child_process.spawn`, reusing the SDK's own wire
// framing (`ReadBuffer`/`serializeMessage`, `@modelcontextprotocol/sdk/shared/stdio.js` -- the
// package's own `./*` export wildcard makes this subpath reachable, verified before writing this
// file) so the actual JSON-RPC-over-newlines protocol stays byte-identical to the reference
// implementation; only the PROCESS LIFECYCLE (env, detachment, kill semantics) is Winter's own.
// `cross-spawn` (the reference's own dependency, needed for Windows shell-resolution quirks) is
// deliberately NOT used -- this repo's own OS floors are macOS/Linux only (CLAUDE.md's "Latest-OS
// floors" convention, carried from the wider product), so `node:child_process.spawn` alone suffices.
import { spawn, type ChildProcess } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpStdioServerConfig } from "@yanlinglabs/winter-agent-sdk";

// The upstream PARITY BASELINE, named explicitly rather than silently duplicated: this is the exact
// non-Windows `DEFAULT_INHERITED_ENV_VARS` list the pinned @modelcontextprotocol/sdk itself ships
// (`dist/esm/client/stdio.js`, "list inspired by the default env inheritance of sudo") -- Winter
// matches the SAME six names so a server author's own expectations ("stdio servers can assume a
// normal-looking minimal env") are not broken by this transport's replacement, but Winter builds
// this list EXPLICITLY and OWNS the merge order, rather than inheriting it unconditionally
// underneath a caller's own `env` the way the reference implementation does.
export const STDIO_BASE_ENV_NAMES = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"] as const;

// WS-09 §1.2: "a stdio server's env is an explicit allowlist the host builds; Winter never leaks
// its own process environment wholesale into a server child." Only the six baseline names are ever
// copied from this process's OWN `process.env` (and only when actually present there) -- nothing
// else from the host environment can reach the child through this function, by construction (no
// `...process.env` spread anywhere in this file). `cfgEnv` (the per-server config's own explicit
// `env` field) is applied ON TOP: config wins, for both overriding a baseline name and adding a
// name outside the baseline the host explicitly opted into.
export function buildStdioEnv(cfgEnv: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of STDIO_BASE_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...(cfgEnv ?? {}) };
}

export interface WinterStdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// Implements the SDK's own `Transport` interface directly (verified structurally compatible: the
// real `Client.connect()` only ever calls `start()`/`send()`/`close()` and assigns
// `onclose`/`onerror`/`onmessage` -- `sessionId`/`setProtocolVersion` are optional and this
// transport, like the reference stdio implementation, declares neither).
export class WinterStdioTransport implements Transport {
  private readonly opts: WinterStdioTransportOptions;
  private child: ChildProcess | undefined;
  private readonly readBuffer = new ReadBuffer();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(opts: WinterStdioTransportOptions) {
    this.opts = opts;
  }

  // Only available once `start()` has spawned the child -- mirrors the reference transport's own
  // `pid` getter exactly (both name and "null until started/after exit" semantics), since
  // mcp/client.ts's own pid-based bookkeeping was written against that contract.
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error("WinterStdioTransport already started");
    }
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.opts.command, this.opts.args ?? [], {
        env: buildStdioEnv(this.opts.env),
        // stderr is ALWAYS piped, never inherited -- WS-04 owns exactly two stdio streams already
        // (this process's own stdin/stdout frame pipe, and the host's stderr diagnostics callback
        // for THIS process); a daemon process must never let a connected server's stderr fall
        // through to a TTY or fd it does not own. Piped-but-drained below (see the "data" listener)
        // so a chatty server's own stderr writes can never block on a full, unread pipe.
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        // RULING P4-H: `detached: true` makes this child its own session/process-group leader
        // (POSIX setsid semantics under Node) -- the load-bearing flag the reference transport never
        // sets, and the reason a negative-pid signal below can reap the ENTIRE group (this process
        // plus any grandchild it forks, e.g. a shell wrapper) rather than only the direct child.
        detached: true,
      });
      this.child = child;

      child.on("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.on("spawn", () => resolve());
      child.on("close", () => {
        this.child = undefined;
        this.onclose?.();
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.readBuffer.append(chunk);
          this.processReadBuffer();
        } catch (error) {
          this.onerror?.(error as Error);
          // Mirrors the reference implementation exactly (dist/esm/client/stdio.js): a buffer
          // overflow (ReadBuffer's own max-size guard) is fatal to the connection, not merely
          // reported -- closing here, not just surfacing onerror, is what actually stops further
          // reads/writes to a transport whose framing state is no longer trustworthy.
          this.close().catch(() => {});
        }
      });
      child.stdout?.on("error", (error) => this.onerror?.(error));
      // Drained, never surfaced anywhere (no channel exists for a connected server's own stderr --
      // see this file's own header): the ONLY purpose of attaching a listener at all is to prevent
      // an unread pipe from eventually applying backpressure to the child's own stderr writes.
      // Nothing is buffered, retained, or logged.
      child.stderr?.on("data", () => {});
    });
  }

  private processReadBuffer(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (error) {
        this.onerror?.(error as Error);
        return;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.child?.stdin) {
        reject(new Error("WinterStdioTransport: not connected"));
        return;
      }
      const json = serializeMessage(message);
      if (this.child.stdin.write(json)) resolve();
      else this.child.stdin.once("drain", resolve);
    });
  }

  // RULING P4-H: unconditional process-GROUP kill, on every close path (an ordinary close, a
  // failed/timed-out connect calling this from mcp/client.ts's own catch block, or
  // mcp/lifecycle.ts's dispose()) -- there is exactly ONE place in this whole lane that kills a
  // stdio child now, and every caller reaches it through this same method. Mirrors
  // `packages/runtime/src/sandbox/spawn.ts`'s own `killGroup` closure pattern (`detached: true` +
  // `process.kill(-pid, "SIGKILL")`) rather than importing it: that module's own `runCommand` is a
  // foreground-shell-command abstraction (timeouts, streamed-output caps, sandbox profiles) with a
  // very different lifecycle and options surface than an MCP transport's `Transport.close()`
  // contract -- duplicating these two lines is cheaper and clearer than adapting either shape to
  // the other, and the ruling's own wording ("mirror... rather than inventing one") permits
  // mirroring the PATTERN without importing the module.
  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.pid === undefined) {
      this.readBuffer.clear();
      return;
    }
    const pid = child.pid;
    const exited = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    try {
      child.stdin?.end();
    } catch {
      /* stdin may already be gone */
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* group already gone */
    }
    // Bounded, not indefinite: a signal-killed process is normally reaped almost immediately, but
    // this must never let a single stuck close() hang whatever awaits it (mirrors the reference
    // transport's own 2s bound on each of its two wait phases).
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.())]);
    this.readBuffer.clear();
  }
}

export function buildStdioTransport(cfg: McpStdioServerConfig): WinterStdioTransport {
  return new WinterStdioTransport({
    command: cfg.command,
    ...(cfg.args !== undefined ? { args: cfg.args } : {}),
    ...(cfg.env !== undefined ? { env: cfg.env } : {}),
  });
}
