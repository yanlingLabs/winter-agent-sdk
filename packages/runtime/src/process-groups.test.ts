// WS-24: the process-group ledger (process-groups.ts) and the spawn sites that feed it.
import { afterEach, describe, expect, test } from "bun:test";
import { liveProcessGroups, onProcessGroupChange, resetProcessGroupsForTest, trackProcessGroup, type ProcessGroupChange } from "./process-groups.ts";
import { runCommand } from "./sandbox/spawn.ts";
import { WinterStdioTransport } from "./mcp/transports/stdio.ts";

afterEach(() => resetProcessGroupsForTest());

function recordChanges(): { changes: ProcessGroupChange[]; stop: () => void } {
  const changes: ProcessGroupChange[] = [];
  const stop = onProcessGroupChange((c) => changes.push(c));
  return { changes, stop };
}

describe("the ledger", () => {
  test("a group is listed from track to release; the release is idempotent and notifies once", () => {
    const { changes, stop } = recordChanges();
    try {
      const release = trackProcessGroup(4242, "command");
      expect(liveProcessGroups()).toEqual([{ pgid: 4242, kind: "command" }]);
      release();
      release();
      expect(liveProcessGroups()).toEqual([]);
      expect(changes).toEqual([
        { op: "add", pgid: 4242, kind: "command" },
        { op: "remove", pgid: 4242, kind: "command" },
      ]);
    } finally {
      stop();
    }
  });

  test("a reused pid's NEW registration survives the old group's late release", () => {
    const releaseOld = trackProcessGroup(4242, "hook");
    const releaseNew = trackProcessGroup(4242, "hook"); // the OS handed the id out again
    releaseOld();
    expect(liveProcessGroups()).toEqual([{ pgid: 4242, kind: "hook" }]);
    releaseNew();
    expect(liveProcessGroups()).toEqual([]);
  });

  test("an id that is no group leader (0, 1, negative, fractional) is never recorded -- a host would SIGKILL -pgid", () => {
    for (const pgid of [0, 1, -3, 2.5, Number.NaN]) trackProcessGroup(pgid, "command")();
    expect(liveProcessGroups()).toEqual([]);
  });

  test("a throwing observer does not stop the others, nor the bookkeeping", () => {
    const stopBad = onProcessGroupChange(() => {
      throw new Error("observer bug");
    });
    const { changes, stop } = recordChanges();
    try {
      trackProcessGroup(5151, "workflow")();
      expect(changes.map((c) => c.op)).toEqual(["add", "remove"]);
    } finally {
      stopBad();
      stop();
    }
  });
});

describe("the spawn sites feed it", () => {
  test("a Bash/Monitor command (sandbox/spawn.ts): listed while running, gone once its leader closes", async () => {
    let listedWhileRunning = false;
    let pid = 0;
    const result = await runCommand({
      command: "sleep 0.2",
      cwd: "/",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: 10_000,
      settings: { enabled: false },
      onSpawned: (info) => {
        pid = info.pid;
        listedWhileRunning = liveProcessGroups().some((g) => g.pgid === info.pid && g.kind === "command");
      },
    });
    expect(result.exitCode).toBe(0);
    expect(pid).toBeGreaterThan(1);
    expect(listedWhileRunning).toBe(true);
    expect(liveProcessGroups()).toEqual([]);
  });

  test("a stdio MCP server (mcp/transports/stdio.ts): listed from start, gone after close()", async () => {
    const transport = new WinterStdioTransport({ command: "/bin/sh", args: ["-c", "sleep 30"], cwd: "/" });
    await transport.start();
    try {
      expect(liveProcessGroups()).toEqual([{ pgid: transport.pid!, kind: "mcp_stdio" }]);
    } finally {
      await transport.close();
    }
    expect(liveProcessGroups()).toEqual([]);
  });

  test("a stdio MCP server that exits on its own is released too", async () => {
    const transport = new WinterStdioTransport({ command: "/bin/sh", args: ["-c", "exit 0"], cwd: "/" });
    const closed = new Promise<void>((resolve) => (transport.onclose = resolve));
    await transport.start();
    await closed;
    expect(liveProcessGroups()).toEqual([]);
  });
});
