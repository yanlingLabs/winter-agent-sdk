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
import { stdioFixtureCommand } from "./test-fixtures.ts";

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

// --- Fix wave follow-up (3) / whole-branch M2 ------------------------------------------------------
//
// "A session with zero declared MCP servers can never gain one": the engine built no lifecycle at all
// unless `config.mcpServers` was non-empty, so `mcp_set_servers` -- WS-09 §3's own "setMcpServers
// replaces the configured set live" -- answered `mcp_unavailable` forever from an empty start, and
// `winter.mcp` was frozen false at startup with no way back.
//
// The trap this had to be written around (named in the first round's report): making the lifecycle
// unconditional ALSO makes `effectiveMcpStateSource` always defined, and the first round's B-M1
// derived `hasMcpServers` from exactly that. Left alone, every session would advertise the whole
// winter.mcp family and every committed `init.tools` golden would churn -- contradicting the
// 24-tool capture. So the fact is re-derived from the LIVE SLOT COUNT instead.
describe("M2: a session that declared no MCP servers can still gain one", () => {
  async function withEngine(
    fn: (host: { output: { write(f: WinterFrame): void } }, collected: WinterFrame[]) => Promise<void>,
    overrides: Partial<RuntimeConfig> = {},
  ): Promise<WinterFrame[]> {
    const { host, runtime } = createInMemoryChannel();
    const config: RuntimeConfig = { sessionId: "m2-empty-start", cwd: "/tmp/winter-m2", model: "sonnet", ...overrides };
    const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: echoProvider });
    const collected: WinterFrame[] = [];
    const reader = (async () => {
      for await (const f of host.input) collected.push(f);
    })();
    await fn(host, collected);
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await reader;
    await done;
    return collected;
  }

  function responseTo(frames: WinterFrame[], requestId: string): { ok: boolean; payload?: { added?: string[]; errors?: Record<string, string> }; error?: { code: string } } | undefined {
    return frames.find((f) => f.type === "control_response" && (f as { requestId?: string }).requestId === requestId) as never;
  }

  test("mcp_set_servers on a session with NO declared servers connects one for real (was: mcp_unavailable forever)", async () => {
    let answer: ReturnType<typeof responseTo>;
    await withEngine(async (host, collected) => {
      host.output.write({ type: "user", text: "hi" });
      const { command, args } = stdioFixtureCommand();
      host.output.write({ type: "control_request", requestId: "set", subtype: "mcp_set_servers", payload: { servers: { late: { command, args, env: {} } } } });
      // Wait for the answer on the host's own stream rather than racing a bare timer.
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && answer === undefined) {
        await new Promise((r) => setTimeout(r, 10));
        answer = responseTo(collected, "set");
      }
    });
    expect(answer, "mcp_set_servers never answered").toBeDefined();
    // THE M2 ASSERTION. Pre-fix: `{ ok: false, error: { code: "mcp_unavailable" } }`, forever, because
    // the engine built no lifecycle (hence no control seam) for a session that declared no servers.
    expect(answer!.error?.code).toBeUndefined();
    expect(answer!.ok).toBe(true);
    expect(answer!.payload?.added).toEqual(["late"]);
    expect(answer!.payload?.errors).toEqual({});
  }, 20_000);

  test("...and a session that gains no server still advertises NONE of the winter.mcp family (no golden churn)", async () => {
    const frames = await withEngine(async (host) => {
      host.output.write({ type: "user", text: "hi" });
    });
    const init = frames.find((f) => f.type === "init") as { tools: string[]; mcp_servers?: unknown[] };
    for (const name of MCP_FAMILY) expect(init.tools).not.toContain(name);
    // The other half of the trap: `mcp_servers` must stay ABSENT, not become `[]`, or every committed
    // golden's init frame changes shape.
    expect(init.mcp_servers, "an empty lifecycle must not put an empty mcp_servers on the wire").toBeUndefined();
  });
});
