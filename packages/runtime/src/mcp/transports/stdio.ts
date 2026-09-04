// Phase 4 Task 4 (Lane A), WS-09 §1.1/§1.2: the stdio transport connector. WS-09 §1.2's own "Env
// allowlist" row is the load-bearing rule this whole file exists to enforce: "a stdio server's env
// is an explicit allowlist the host builds; Winter never leaks its own process environment
// wholesale into a server child." The real `@modelcontextprotocol/sdk` `StdioClientTransport`
// defaults an OMITTED `env` to `getDefaultEnvironment()` (a curated ambient-process-env subset,
// verified against the pinned 1.30.0 declaration) -- still a form of wholesale inheritance Winter's
// own contract forbids, so this file NEVER omits `env`: an absent `McpStdioServerConfig.env` becomes
// an explicit empty object, never `undefined`, defeating that fallback structurally rather than by
// convention.
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpStdioServerConfig } from "@yanlinglabs/winter-agent-sdk";

export function buildStdioTransport(cfg: McpStdioServerConfig): StdioClientTransport {
  return new StdioClientTransport({
    command: cfg.command,
    ...(cfg.args !== undefined ? { args: cfg.args } : {}),
    env: cfg.env ?? {},
    // No channel exists anywhere in this codebase for a THIRD process's stderr (WS-04 owns exactly
    // two stdio streams: the runtime's own stdin/stdout frame pipe, and the host's stderr
    // diagnostics callback for THIS process, `Options.stderr`) -- "ignore" avoids both leaking a
    // connected server's diagnostics into Winter's own stderr and the unbounded-memory-growth risk
    // of a "pipe" stream nothing ever drains. A future enhancement could pipe-and-tail the last N
    // lines into a `failed` state's own `error` message; not built here (capture-pending, not a
    // correctness gap -- a failed connection is still classified and reported without it).
    stderr: "ignore",
  });
}
