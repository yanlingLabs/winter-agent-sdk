// T8-review M1 (here B-M1): `winter.mcp` must derive from the EFFECTIVE MCP state source, not from
// `config.mcpServers` alone.
//
// `init.mcp_servers` has always been built from `effectiveMcpStateSource = mcpServerStateSource ??
// mcpLifecycle?.stateSource` (engine.ts), while the capability fact was read off `config.mcpServers`
// only. So a host that owns its own MCP stack and injects `mcpServerStateSource` -- verbatim the case
// the precedence block's own comment exists for ("a future host that owns its own MCP stack, a daemon
// managing connections across sessions, hands one in") -- got a populated `mcp_servers` list on the
// wire while every tool in the `winter.mcp` family stayed UNADVERTISED and, via rider 27's
// dispatch-time availability check, was refused even if called anyway.
//
// Latent at 9c41d49 (the only injectors were T3's contract fakes), which is exactly why it needed a
// test rather than a note: P5's host wiring is the first real injector.
import { describe, test, expect } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine } from "../engine.ts";
import { echoProvider } from "../provider/mock.ts";
import "../tools/impl/index.ts"; // the MCP bridge executors must be registered for winter.mcp to derive
import { createFakeMcpServerStateSource } from "./state.ts";

const MCP_FAMILY = ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool", "RefreshMcpTools", "WaitForMcpServers"] as const;

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

async function initFrame(overrides: Partial<RuntimeConfig>, injected?: ReturnType<typeof createFakeMcpServerStateSource>) {
  const { host, runtime } = createInMemoryChannel();
  const config: RuntimeConfig = { sessionId: "mcp-caps", cwd: "/tmp/winter-mcp-caps", model: "sonnet", ...overrides };
  const done = runEngine({
    config,
    input: runtime.input,
    output: runtime.output,
    provider: echoProvider,
    ...(injected !== undefined ? { mcpServerStateSource: injected } : {}),
  });
  host.output.write({ type: "user", text: "hi" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;
  return frames.find((f) => f.type === "init") as { tools: string[]; mcp_servers?: unknown[] } | undefined;
}

describe("B-M1: winter.mcp derives from the EFFECTIVE MCP state source", () => {
  test("a caller-injected mcpServerStateSource with NO config.mcpServers advertises the whole winter.mcp family", async () => {
    const injected = createFakeMcpServerStateSource([{ name: "gh", state: "connected", toolNames: [] }]);
    const init = await initFrame({}, injected);
    expect(init).toBeDefined();
    // The wire half has always worked -- this is the asymmetry's own evidence.
    expect(init!.mcp_servers, "init.mcp_servers is built from the effective source, so it was already populated").toHaveLength(1);
    for (const name of MCP_FAMILY) {
      // THE B-M1 ASSERTION. Pre-fix every one of these was absent: the capability fact read
      // `config.mcpServers`, which this session does not set.
      expect(init!.tools, `"${name}" must be advertised for a host that injects its own MCP state source`).toContain(name);
    }
  });

  test("control: no injected source and no declared servers still advertises NONE of the family", async () => {
    const init = await initFrame({});
    expect(init!.mcp_servers).toBeUndefined();
    for (const name of MCP_FAMILY) {
      expect(init!.tools).not.toContain(name);
    }
  });

  test("control: a declared config.mcpServers still advertises the family (the pre-existing path is untouched)", async () => {
    const init = await initFrame({
      mcpServers: { probe: { type: "sdk", name: "probe", tools: [{ name: "echo", inputSchema: { type: "object" } }] } },
    });
    for (const name of MCP_FAMILY) {
      expect(init!.tools).toContain(name);
    }
  });

  test("control: an EMPTY config.mcpServers map advertises none of the family (an empty declaration is not a declaration)", async () => {
    const init = await initFrame({ mcpServers: {} });
    for (const name of MCP_FAMILY) {
      expect(init!.tools).not.toContain(name);
    }
  });
});
