// Phase 4 Task 4 (Lane A), WS-09 §3: the REAL `McpControlSeam` implementation (mcp/control-seam.ts's
// own header: "the REAL implementation... is Lane A's own job"). A thin adapter over
// `McpLifecycleInternals` (mcp/lifecycle.ts) -- this file owns none of the connection/registration
// logic itself, only the mapping from the three mutating control subtypes'
// (`mcp_reconnect`/`mcp_toggle`/`mcp_set_servers`) already-pinned contract onto that seam.
//
// Type-only import from mcp/lifecycle.ts (see that file's own header): lifecycle.ts is this file's
// only caller (it constructs `McpLifecycleInternals` and passes it to `createMcpControlSeam` inside
// `createMcpLifecycle`), so the dependency is genuinely one-directional at RUNTIME despite the
// mutual TYPE reference -- erased entirely at build time, never a real circular import.
import type { McpServerConfigForProcessTransport } from "@yanlinglabs/winter-agent-sdk";
import type { McpControlSeam, McpSetServersResult } from "./control-seam.ts";
import type { McpLifecycleInternals, McpConfigSourceOrigin } from "./lifecycle.ts";
import { validateServerConfig } from "./lifecycle.ts";
import { WINTER_SERVER_NAME } from "./winter-server.ts";

// derived-shapes-p4.md item (b) (this lane's own shape authority): `setMcpServers`'s doc-asserted
// scope is narrower than WS-09 §3's own blanket "replaces the configured set live" -- "the method's
// replace-semantics reach only the servers that arrived through this same method or through the
// SDK's own dynamic-server options in the first place." A settings/project/plugin-origin server
// SURVIVES an omission from the payload untouched; the only way to displace one is to name it
// explicitly in a call's own payload (handled below by simply letting a same-name entry in
// `servers` win regardless of its PRIOR origin -- re-tagged "dynamic" from that point on).
const REPLACE_ELIGIBLE_ORIGINS: ReadonlySet<McpConfigSourceOrigin> = new Set<McpConfigSourceOrigin>(["explicit", "dynamic"]);

export function createMcpControlSeam(internals: McpLifecycleInternals): McpControlSeam {
  return {
    async reconnect(serverName: string): Promise<void> {
      if (!internals.hasSlot(serverName)) {
        throw new Error(`mcp: reconnect: unknown server "${serverName}"`);
      }
      // Matches the pinned `Query.reconnectMcpServer(serverName): Promise<void>` contract verbatim
      // ("throws on failure", derived-shapes-p4.md item (b)) -- `reconnectExisting` itself already
      // throws on a failed/needsAuth outcome; this method adds only the unknown-name guard.
      await internals.reconnectExisting(serverName);
    },
    async toggle(serverName: string, enabled: boolean): Promise<void> {
      if (!internals.hasSlot(serverName)) {
        throw new Error(`mcp: toggle: unknown server "${serverName}"`);
      }
      if (enabled) {
        await internals.enableSlot(serverName);
      } else {
        internals.disableSlot(serverName);
      }
    },
    async setServers(servers: Record<string, McpServerConfigForProcessTransport>): Promise<McpSetServersResult> {
      const added: string[] = [];
      const removed: string[] = [];
      const errors: Record<string, string> = {};

      // Validate every incoming config FIRST -- WS-09 §1.1's runtime rejection (claudeai-proxy/
      // unknown `type`) applies here exactly as it does at startup resolution; an invalid entry is
      // reported in `errors` and never partially applied.
      const validated = new Map<string, McpServerConfigForProcessTransport>();
      for (const [name, raw] of Object.entries(servers)) {
        // Whole-branch review M1 (fix wave): the RESERVED-NAME check belongs HERE, ahead of any
        // spawn or connect. `resolveMcpServerSources` (lifecycle.ts) refuses "winter" at STARTUP
        // resolution, but `addAndConnect` bypasses that function entirely -- so a live
        // `mcp_set_servers` naming "winter" used to spawn a real stdio child, assign `slot.client`,
        // and only THEN hit `registerMcpServerTools`' own reserved-name throw (registry.ts), leaving
        // a connected client in a `failed` slot with its child process reaped no earlier than
        // `dispose()`. Reported as an ordinary per-entry error, matching every other rejection on
        // this path: never partially applied, never a thrown seam.
        if (name === WINTER_SERVER_NAME) {
          errors[name] = `"${WINTER_SERVER_NAME}" is a reserved server identity (RULING P4-B, the standing Winter server) -- no source may configure a live MCP server under this name`;
          continue;
        }
        const result = validateServerConfig(raw);
        if (!result.ok) {
          errors[name] = result.reason;
          continue;
        }
        validated.set(name, result.config);
      }

      const incomingNames = new Set(validated.keys());
      for (const name of internals.listSlotNames()) {
        const origin = internals.getSlotOrigin(name);
        const isReplaceEligible = origin !== undefined && REPLACE_ELIGIBLE_ORIGINS.has(origin);
        if (isReplaceEligible && !incomingNames.has(name)) {
          await internals.removeSlot(name);
          removed.push(name);
        }
        // A settings/project/plugin-origin server that is simply ABSENT from `servers` survives
        // untouched (derived-shapes item (b)'s own doc-asserted nuance) -- no action, no report.
      }

      for (const [name, config] of validated) {
        // Re-adding under "dynamic": whether this name is brand-new, was already "dynamic", or is
        // being explicitly displaced away from a settings/project/plugin origin (the ONE way
        // derived-shapes item (b) says a call CAN override those), the outcome is identical --
        // this call now owns it, going forward, as a live-managed entry.
        await internals.addAndConnect(name, "dynamic", config);
        added.push(name);
      }

      return { added, removed, errors };
    },
  };
}
