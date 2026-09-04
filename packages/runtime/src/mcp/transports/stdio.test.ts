import { describe, test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildStdioTransport, WinterStdioTransport, buildStdioEnv, STDIO_BASE_ENV_NAMES } from "./stdio.ts";
import { stdioFixtureCommand, grandchildSpawningCommand } from "../test-fixtures.ts";

// Every test in this file spawns a REAL child process (the fixture at
// __fixtures__/stdio-server.ts) -- the lane protocol's own stall discipline requires killing it in
// `finally` with a deadline, every test, since a leaked child process hangs the linux runner.
// `client.close()` reliably kills a direct (non-shell-wrapped) bun-script child in the success
// path (verified empirically before writing this file); the `transport.pid`-based manual SIGKILL
// below is the belt-and-suspenders fallback, since `transport.pid` is empirically NULLED OUT by the
// SDK's own error handling on a failed/timed-out connect before a caller ever gets to read it --
// captured proactively via a short poll instead so the fallback still has a real pid to act on.
async function withStdioConnection<T>(
  env: Record<string, string>,
  fn: (client: Client, getPid: () => number | null) => Promise<T>,
): Promise<{ result: T; pid: number | null }> {
  const { command, args } = stdioFixtureCommand();
  const transport = buildStdioTransport({ command, args, env });
  const client = new Client({ name: "stdio-transport-test", version: "1.0.0" });

  let capturedPid: number | null = null;
  const pollTimer = setInterval(() => {
    if (capturedPid === null && transport.pid !== null) capturedPid = transport.pid;
  }, 2);

  try {
    await client.connect(transport, { timeout: 5000 });
    const result = await fn(client, () => capturedPid);
    return { result, pid: capturedPid };
  } finally {
    clearInterval(pollTimer);
    await client.close().catch(() => {});
    if (capturedPid !== null) {
      // Fix round 1 (MAJOR M1): `WinterStdioTransport.close()` now performs its own unconditional
      // process-GROUP kill (`detached: true` + `process.kill(-pid, "SIGKILL")`), so this is a true
      // last-resort belt-and-suspenders rather than the primary kill path -- and it checks/kills the
      // GROUP (`-pid`), consistent with `detached: true`, not the single pid.
      const pid = capturedPid;
      const deadline = Date.now() + 1000;
      let alive = true;
      while (Date.now() < deadline) {
        try {
          process.kill(-pid, 0); // throws ESRCH once the whole group is gone
        } catch {
          alive = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      if (alive) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone by the time we got here */
        }
      }
    }
  }
}

describe("buildStdioTransport: a real out-of-process stdio MCP server", () => {
  test("connects, lists tools, and calls a tool over a real child process spawned with an explicit (here: empty) env", async () => {
    const { result } = await withStdioConnection({}, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["boom", "echo", "env_dump"]);
      return client.callTool({ name: "echo", arguments: { text: "hi" } }, undefined, { timeout: 5000 });
    });
    expect(result).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
  });

  test("reads a text resource and a blob resource (base64) over the real child process", async () => {
    const { result } = await withStdioConnection({}, async (client) => {
      const textRes = await client.readResource({ uri: "fixture://text.txt" });
      const blobRes = await client.readResource({ uri: "fixture://blob.bin" });
      return { textRes, blobRes };
    });
    expect(result.textRes.contents).toEqual([{ uri: "fixture://text.txt", mimeType: "text/plain", text: "hello fixture world" }]);
    expect(result.blobRes.contents).toEqual([
      { uri: "fixture://blob.bin", mimeType: "application/octet-stream", blob: Buffer.from([1, 2, 3, 4]).toString("base64") },
    ]);
  });

  test("an isError tool result is surfaced, not thrown", async () => {
    const { result } = await withStdioConnection({}, (client) => client.callTool({ name: "boom", arguments: {} }, undefined, { timeout: 5000 }));
    expect(result).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
  });

  test("the spawned child process is reliably terminated once the connection's finally block runs (no leaked process)", async () => {
    const { pid } = await withStdioConnection({}, async (client) => {
      await client.listTools(); // just needs a real, completed exchange so the pid was captured
    });
    expect(pid).not.toBeNull();
    // withStdioConnection's own finally has already run by the time this line executes (it is
    // awaited above) -- either client.close() killed it, or the deadline-bounded SIGKILL fallback
    // did. Either way, the pid must be unreachable NOW, proving this test file's own cleanup
    // discipline actually works rather than merely hoping the SDK's close() is sufficient.
    expect(() => process.kill(-pid!, 0)).toThrow();
  });
});

// --- Fix round 1 (MAJOR M1) -----------------------------------------------------------------
//
// Two independent claims were caught as FALSE by review at the pinned @modelcontextprotocol/sdk
// dependency (1.30.0): (1) the old `env: cfg.env ?? {}` wrapper around `StdioClientTransport` did
// NOT isolate the child's env (that transport merges its own six-name default env underneath
// whatever `env` a caller supplies, unconditionally); (2) that transport never sets `detached`, so
// only the direct child dies on close/timeout -- any grandchild it forks (a shell wrapper, etc.) is
// orphaned. `WinterStdioTransport` (this file's own `./stdio.ts`) replaces it entirely. The two
// describe blocks below are deliberately split by what they actually PROVE:
//
//  - "env allowlist" is the CONTRACT (WS-09 §1.2) `buildStdioEnv` must satisfy -- but every one of
//    these assertions passes against the OLD wrapper too (the six baseline names and the
//    config-wins merge order were already correct in practice; only the docstring's CLAIM about
//    why was false). These are disclosed as PINS, not RED-first regression tests.
//  - "process-GROUP semantics" is where the actual bug lived, and each test below is a genuine
//    RED-then-GREEN discriminator: verified via a standalone reproduction that drives the SDK's own
//    `StdioClientTransport` directly (the OLD code's exact call shape, `env: cfg.env ?? {}`) against
//    the same grandchild-spawning command -- it empirically fails both the process-group-leader
//    check (ESRCH on `kill(-pid, 0)` while alive) and the grandchild-survives-close() check, exactly
//    as these three tests predict (see the fix-round report's own M1 section for the transcript).

describe("fix round 1 (MAJOR M1): env allowlist over a REAL spawned child, via the env_dump fixture tool (PINS -- see header)", () => {
  interface EnvDumpPayload {
    keys: string[];
    values: Record<string, string>;
  }

  function parseEnvDump(result: unknown): EnvDumpPayload {
    return JSON.parse((result as { content: { text: string }[] }).content[0]!.text) as EnvDumpPayload;
  }

  test("a canary set in the PARENT's own process.env never reaches the child, even though the real baseline names do", async () => {
    const previous = process.env.WINTER_CANARY_SECRET;
    process.env.WINTER_CANARY_SECRET = "leak-if-you-see-me";
    try {
      const { result } = await withStdioConnection({}, (client) =>
        client.callTool({ name: "env_dump", arguments: {} }, undefined, { timeout: 5000 }),
      );
      const payload = parseEnvDump(result);
      expect(payload.keys).not.toContain("WINTER_CANARY_SECRET");
      expect(payload.values.WINTER_CANARY_SECRET).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.WINTER_CANARY_SECRET;
      else process.env.WINTER_CANARY_SECRET = previous;
    }
  });

  test("each STDIO_BASE_ENV_NAMES entry appears in the child iff the parent process actually has it, with the same value", async () => {
    const { result } = await withStdioConnection({}, (client) =>
      client.callTool({ name: "env_dump", arguments: {} }, undefined, { timeout: 5000 }),
    );
    const payload = parseEnvDump(result);
    for (const name of STDIO_BASE_ENV_NAMES) {
      const parentValue = process.env[name];
      if (parentValue === undefined) {
        expect(payload.keys).not.toContain(name);
      } else {
        expect(payload.values[name]).toBe(parentValue);
      }
    }
  });

  test("a config env value overrides the baseline for the same name, and adds a name outside the baseline", async () => {
    const { result } = await withStdioConnection(
      { PATH: "/custom/override/path", WINTER_TEST_CUSTOM_VAR: "custom-value" },
      (client) => client.callTool({ name: "env_dump", arguments: {} }, undefined, { timeout: 5000 }),
    );
    const payload = parseEnvDump(result);
    expect(payload.values.PATH).toBe("/custom/override/path");
    expect(payload.values.WINTER_TEST_CUSTOM_VAR).toBe("custom-value");
  });

  test("buildStdioEnv (pure unit check): merge order and allowlist boundary, no spawn involved", () => {
    const overridden = buildStdioEnv({ HOME: "/overridden/home", EXTRA: "yes" });
    expect(overridden.HOME).toBe("/overridden/home");
    expect(overridden.EXTRA).toBe("yes");

    const bare = buildStdioEnv({});
    const bareKeys = Object.keys(bare).sort();
    const expectedKeys = STDIO_BASE_ENV_NAMES.filter((n) => process.env[n] !== undefined)
      .slice()
      .sort();
    expect(bareKeys).toEqual(expectedKeys);
  });
});

describe("fix round 1 (MAJOR M1): process-GROUP semantics (detached: true) -- genuine RED/GREEN discriminators", () => {
  test("the spawned child is its own process-group leader: process.kill(-pid, 0) succeeds while it is alive", async () => {
    const { command, args } = stdioFixtureCommand();
    const transport = new WinterStdioTransport({ command, args, env: {} });
    await transport.start();
    const pid = transport.pid;
    expect(pid).not.toBeNull();
    try {
      expect(() => process.kill(-pid!, 0)).not.toThrow();
    } finally {
      await transport.close();
    }
  });

  test("close() reaps the WHOLE PROCESS GROUP, including a forked grandchild -- not just the direct child", async () => {
    const { command, args } = grandchildSpawningCommand();
    const transport = new WinterStdioTransport({ command, args, env: {} });
    await transport.start();
    const pid = transport.pid;
    expect(pid).not.toBeNull();

    // Find the grandchild BEFORE closing (a short deadline: the shell needs one scheduling tick to
    // fork+background `sleep` before `pgrep` can see it).
    let grandchildPid: number | null = null;
    const findDeadline = Date.now() + 500;
    while (grandchildPid === null && Date.now() < findDeadline) {
      try {
        const out = execSync(`pgrep -P ${pid}`, { encoding: "utf8" }).trim();
        if (out) grandchildPid = Number(out.split("\n")[0]);
      } catch {
        /* pgrep exits non-zero while there is no child to find yet */
      }
      if (grandchildPid === null) await new Promise((r) => setTimeout(r, 20));
    }
    expect(grandchildPid).not.toBeNull();
    expect(() => process.kill(grandchildPid!, 0)).not.toThrow(); // alive before close()

    await transport.close();

    const deadline = Date.now() + 1000;
    let groupGone = false;
    while (Date.now() < deadline) {
      try {
        process.kill(-pid!, 0);
      } catch {
        groupGone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(groupGone).toBe(true);
    expect(() => process.kill(grandchildPid!, 0)).toThrow(); // the grandchild is reaped too, not orphaned
  });

  test("a failed/timed-out connect ALSO reaps the whole group (mirrors mcp/client.ts's own catch-block close path)", async () => {
    const { command, args } = grandchildSpawningCommand();
    const transport = new WinterStdioTransport({ command, args, env: {} });
    const client = new Client({ name: "stdio-timeout-test", version: "1.0.0" });
    let capturedPid: number | null = null;
    const pollTimer = setInterval(() => {
      if (capturedPid === null && transport.pid !== null) capturedPid = transport.pid;
    }, 2);
    let threw = false;
    try {
      // This command never speaks MCP at all -- the initialize request must time out, exactly like
      // a genuinely hung real-world server would.
      await client.connect(transport, { timeout: 200 });
    } catch {
      threw = true;
    } finally {
      clearInterval(pollTimer);
    }
    expect(threw).toBe(true);
    expect(capturedPid).not.toBeNull();
    const pid = capturedPid!;

    // mcp/client.ts's own catch block calls `transport.close()` unconditionally on any connect
    // failure -- reproduced directly here since this test talks to the transport without going
    // through connectMcpServer.
    await transport.close().catch(() => {});

    const deadline = Date.now() + 1000;
    let groupGone = false;
    while (Date.now() < deadline) {
      try {
        process.kill(-pid, 0);
      } catch {
        groupGone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(groupGone).toBe(true);
  });
});
