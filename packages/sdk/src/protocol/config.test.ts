// Task 9 (WS-08 §1): "unknown event names in config: accepted, preserved, inert (never an error,
// never silently renamed)." RuntimeHooksConfig is deliberately keyed by an OPEN string (config.ts's
// own header) rather than the closed `HookEvent` union `Options.hooks` itself uses -- this is the
// fixture proving that choice actually delivers the "accepted + preserved" half of the rule at the
// wire-shape level (the "inert" half is structural, not behavioral, at this task's layer: nothing at
// P2 consumes RuntimeConfig.hooks at all -- see the comment on the second test below -- and once a
// consumer exists, hooks/registry.ts's HookRegistry.matching() is typed against the CLOSED HookEvent
// union, so an unrecognized key can never become a live registration through that API regardless of
// how a future converter is written).
import { describe, test, expect } from "bun:test";
import type { RuntimeConfig, RuntimeHooksConfig } from "./config.ts";

describe("RuntimeConfig.hooks -- unknown event names (WS-08 §1)", () => {
  test("an unrecognized key type-checks (RuntimeHooksConfig is Partial<Record<string, ...>>, not Partial<Record<HookEvent, ...>>)", () => {
    // If this DIDN'T type-check, the test file itself would fail to compile -- the assertion is the
    // compile, not a runtime check; the expect() below just gives the test a body.
    const hooks: RuntimeHooksConfig = {
      PreToolUse: [{ hookCount: 1, source: "sdk" }],
      // A name from a FUTURE pinned version (0.3.251 added PreModelSwitch/PostModelSwitch per WS-08
      // §1's own drift note) or a straightforward typo -- either way, not a member of the 31-name
      // HookEvent union this task pins in types.ts.
      SomeFutureOrMisspelledEventName: [{ matcher: "Bash", hookCount: 2, timeoutSec: 45, source: "user" }],
    };
    expect(Object.keys(hooks)).toHaveLength(2);
  });

  test("an unknown key round-trips through JSON byte-identically (accepted + preserved, the actual --config-json transport a host uses)", () => {
    const config: RuntimeConfig = {
      sessionId: "s1",
      cwd: "/work",
      model: "sonnet",
      hooks: {
        PreToolUse: [{ hookCount: 1, source: "sdk" }],
        NotAKnownHookEventAtAll: [{ hookCount: 3, source: "managed", timeoutSec: 10 }],
      },
    };
    // The REAL serialization path (query.ts's --config-json argv, and whatever eventually parses it
    // runtime-side) is plain JSON -- no schema validation strips or rejects an unrecognized key
    // anywhere in that path today (no consumer of RuntimeConfig.hooks exists yet at all -- this is
    // itself the "inert" half: there is no code to mis-handle the unknown key, only the wire shape's
    // own openness to preserve it losslessly for whenever a consumer does exist).
    const roundTripped = JSON.parse(JSON.stringify(config)) as RuntimeConfig;
    expect(roundTripped).toEqual(config);
    expect(roundTripped.hooks?.["NotAKnownHookEventAtAll"]).toEqual([{ hookCount: 3, source: "managed", timeoutSec: 10 }]);
  });

  test("absent hooks entirely still round-trips (the default/no-registrations case every existing differential golden exercises)", () => {
    const config: RuntimeConfig = { sessionId: "s1", cwd: "/work", model: "sonnet" };
    const roundTripped = JSON.parse(JSON.stringify(config)) as RuntimeConfig;
    expect(roundTripped.hooks).toBeUndefined();
  });
});

// Phase 4 Task 3 (WS-10 §7/§9): the two child-identity wire fields -- see RuntimeConfig's own
// comment for why these exist only on a child engine's own config.
describe("RuntimeConfig.agentId / isolationPinnedCwd (WS-10 §7/§9)", () => {
  test("both round-trip when a child sets them", () => {
    const config: RuntimeConfig = { sessionId: "child-1", cwd: "/work", model: "sonnet", agentId: "a1", isolationPinnedCwd: true };
    const roundTripped = JSON.parse(JSON.stringify(config)) as RuntimeConfig;
    expect(roundTripped.agentId).toBe("a1");
    expect(roundTripped.isolationPinnedCwd).toBe(true);
  });

  test("both are absent for an ordinary (non-child) session -- byte-identical to before these fields existed", () => {
    const config: RuntimeConfig = { sessionId: "s1", cwd: "/work", model: "sonnet" };
    const roundTripped = JSON.parse(JSON.stringify(config)) as RuntimeConfig;
    expect(roundTripped.agentId).toBeUndefined();
    expect(roundTripped.isolationPinnedCwd).toBeUndefined();
    expect(Object.keys(roundTripped)).not.toContain("agentId");
    expect(Object.keys(roundTripped)).not.toContain("isolationPinnedCwd");
  });
});

// Phase 4 Task 3 (WS-04 addendum, sdk_mcp_call tool-discovery gap): McpSdkServerConfig.tools is a
// Winter-owned wire extension the pinned official declaration does not carry (see the field's own
// comment) -- proven here at the plain-type level; query.ts's own toWireMcpServers test coverage
// proves the PRODUCER side (an instance implementing listTools() populates it; one that doesn't,
// doesn't).
describe("McpSdkServerConfig.tools (Phase 4 Task 3, Winter-owned wire extension)", () => {
  test("round-trips a tool list when present", () => {
    const config: RuntimeConfig = {
      sessionId: "s1",
      cwd: "/work",
      model: "sonnet",
      mcpServers: { fixture: { type: "sdk", name: "fixture", tools: [{ name: "echo", inputSchema: { type: "object" } }] } },
    };
    const roundTripped = JSON.parse(JSON.stringify(config)) as RuntimeConfig;
    expect(roundTripped.mcpServers?.["fixture"]).toEqual({ type: "sdk", name: "fixture", tools: [{ name: "echo", inputSchema: { type: "object" } }] });
  });

  test("absent when the config never set it -- byte-identical to the pinned 3-field official shape", () => {
    const config: RuntimeConfig = { sessionId: "s1", cwd: "/work", model: "sonnet", mcpServers: { fixture: { type: "sdk", name: "fixture" } } };
    const roundTripped = JSON.parse(JSON.stringify(config)) as RuntimeConfig;
    expect(roundTripped.mcpServers?.["fixture"]).toEqual({ type: "sdk", name: "fixture" });
    expect(Object.keys(roundTripped.mcpServers?.["fixture"] as object)).not.toContain("tools");
  });
});
