// Host messaging end to end: `Options.hostMessaging` on the real `query()`, the real runtime, and the
// model's own `SendMessage`/`ListAgents` calls (the prompt-scripted `winter-test/calls` double), in BOTH
// host topologies the Winter daemon uses -- the in-memory leg (`main.ts`'s own wiring, standing in for the
// spawned `winter` process, which runs the identical engine over the identical frame stream) and an
// embedded session in its own Worker. Every home is a temp dir; nothing reaches a network or a Keychain.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type HostMessageListRequest, type HostMessageSendAnswer, type HostMessageSendRequest, type HostMessagingHandler, type Options, type SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "../testing.ts";
import { spawnEmbeddedWorker } from "../embedded-host.ts";
import { testProviderForNamespace } from "../provider/mock.ts";

const WORKER_ENTRY = join(import.meta.dir, "..", "embedded-worker.ts");
const TEMP_ROOTS: string[] = [];
afterAll(() => {
  for (const dir of TEMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `winter-host-messaging-${label}-`));
  TEMP_ROOTS.push(dir);
  return dir;
}

type Leg = "in-memory" | "worker";
const LEGS: Leg[] = ["in-memory", "worker"];

interface ToolOutcome {
  name: string | null;
  isError: boolean;
  content: string;
}

/** Run one turn whose prompt is a `CALL` script; answer with the calls double's own JSON of every result. */
async function runCalls(leg: Leg, script: string, hostMessaging: HostMessagingHandler | undefined): Promise<ToolOutcome[]> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", WINTER_HOME: tempDir("home"), WINTER_DISABLE_GIT_INSTRUCTIONS: "1" };
  const options: Options = {
    model: "winter-test/calls",
    cwd: tempDir("cwd"),
    env,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    toolSearchEnabled: false,
    settingSources: [],
    capabilities: ["winter.subagents"],
    ...(hostMessaging !== undefined ? { hostMessaging } : {}),
    spawnClaudeCodeProcess: (o) => (leg === "worker" ? spawnEmbeddedWorker({ workerEntry: WORKER_ENTRY, spawn: o }) : inMemoryProcess(o.args, testProviderForNamespace("calls"), undefined, o.env)),
  };
  const messages: SdkMessage[] = [];
  for await (const m of query({ prompt: script, options })) messages.push(m);
  const result = messages.find((m) => (m as { type?: string }).type === "result") as { result?: string; subtype?: string } | undefined;
  expect(result?.subtype).toBe("success");
  return JSON.parse(result?.result ?? "[]") as ToolOutcome[];
}

/** A recording host: answers `send` with `answer`, lists `rows`. */
function recordingHost(answer: HostMessageSendAnswer | (() => Promise<HostMessageSendAnswer>), rows: Awaited<ReturnType<HostMessagingHandler["list"]>>["sessions"] = []) {
  const sends: HostMessageSendRequest[] = [];
  const lists: HostMessageListRequest[] = [];
  const stops: string[] = [];
  const handler: HostMessagingHandler = {
    async send(request) {
      sends.push(request);
      return typeof answer === "function" ? answer() : answer;
    },
    async list(request) {
      lists.push(request);
      return { sessions: rows, omitted: 3 };
    },
    async stop(request) {
      stops.push(request.id);
      return request.id === "s_running" ? { status: "stopped", note: "1 queued message waits for the next one" } : request.id === "s_idle" ? { status: "not_running" } : { status: "refused", reason: "a dispatch session cannot be stopped" };
    },
  };
  return { handler, sends, lists, stops };
}

describe.each(LEGS)("host messaging over the %s leg", (leg) => {
  test("SendMessage to a target no in-process resolution knows is asked of the host, and the host's outcome (with its note) is the result", async () => {
    const host = recordingHost({ status: "resumed_and_delivered", note: "you will be woken when it finishes" });
    const [send] = await runCalls(leg, 'CALL SendMessage {"to":"s_0123abcd","message":"please also run the tests","summary":"run tests"}', host.handler);
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]).toMatchObject({ to: "s_0123abcd", message: "please also run the tests", summary: "run tests" });
    expect(typeof host.sends[0]!.messageId).toBe("string");
    expect(host.sends[0]!.fromAgentId).toBeUndefined();
    expect(send!.isError).toBe(false);
    const payload = JSON.parse(send!.content) as Record<string, unknown>;
    expect(payload).toEqual({ status: "resumed_and_delivered", messageId: host.sends[0]!.messageId, note: "you will be woken when it finishes" });
  }, 60_000);

  test("a host refusal is an error result carrying the host's reason", async () => {
    const host = recordingHost({ status: "refused", reason: "that session is archived" });
    const [send] = await runCalls(leg, 'CALL SendMessage {"to":"session:s_99","message":"hi","summary":"hi"}', host.handler);
    expect(host.sends[0]?.to).toBe("session:s_99");
    expect(send!.isError).toBe(true);
    expect(JSON.parse(send!.content)).toMatchObject({ status: "refused", reason: "that session is archived" });
  }, 60_000);

  test("a host whose send THROWS is delivery_uncertain, never not_found", async () => {
    const host = recordingHost(async () => {
      throw new Error("boom with the message body in it");
    });
    const [send] = await runCalls(leg, 'CALL SendMessage {"to":"s_x","message":"hi","summary":"hi"}', host.handler);
    expect(host.sends).toHaveLength(1);
    const payload = JSON.parse(send!.content) as { status: string; reason: string };
    expect(payload.status).toBe("delivery_uncertain");
    expect(payload.reason).not.toContain("message body");
  }, 60_000);

  test("a malformed host answer is delivery_uncertain", async () => {
    const host = recordingHost({ status: "teleported" } as unknown as HostMessageSendAnswer);
    const [send] = await runCalls(leg, 'CALL SendMessage {"to":"s_x","message":"hi","summary":"hi"}', host.handler);
    expect(JSON.parse(send!.content)).toMatchObject({ status: "delivery_uncertain" });
  }, 60_000);

  test("ListAgents adds the host's sessions (malformed rows dropped) after the in-process rows", async () => {
    const host = recordingHost({ status: "delivered" }, [
      { address: "session:s_live1", name: "Fix the login bug", status: "running", mode: "code", cwd: "/tmp/repo" },
      { address: "bad\naddress", status: "running", mode: "code" },
    ]);
    const [list] = await runCalls(leg, "CALL ListAgents {}", host.handler);
    expect(host.lists).toHaveLength(1);
    expect(list!.isError).toBe(false);
    const listing = (JSON.parse(list!.content) as { listing: string }).listing;
    expect(listing).toBe("- Fix the login bug (session:s_live1) [session/winter-agent] status=running mode=code\n(3 more reachable sessions not listed)");
  }, 60_000);

  test("TaskStop with an id that is no task of this session asks the host to stop that session", async () => {
    const host = recordingHost({ status: "delivered" });
    const [running, idle, refused] = await runCalls(leg, 'CALL TaskStop {"task_id":"s_running"}\nCALL TaskStop {"task_id":"s_idle"}\nCALL TaskStop {"task_id":"s_dispatch"}', host.handler);
    expect(host.stops).toEqual(["s_running", "s_idle", "s_dispatch"]);
    expect(running!.isError).toBe(false);
    expect(JSON.parse(running!.content)).toEqual({ message: "stopped session s_running: its running turn was interrupted. 1 queued message waits for the next one", task_id: "s_running", task_type: "session" });
    expect(idle!.isError).toBe(false);
    expect(JSON.parse(idle!.content)).toMatchObject({ task_id: "s_idle", task_type: "session" });
    expect(refused!.isError).toBe(true);
    expect(refused!.content).toBe("Error: TaskStop: a dispatch session cannot be stopped");
  }, 60_000);

  test("without a host handler nothing changes: SendMessage is not_found, ListAgents lists nothing, TaskStop is unknown", async () => {
    const [stop] = await runCalls(leg, 'CALL TaskStop {"task_id":"s_running"}', undefined);
    expect(stop!.isError).toBe(true);
    expect(stop!.content).toBe('Error: TaskStop: unknown task_id "s_running"');
    const [send, list] = await runCalls(leg, 'CALL SendMessage {"to":"s_0123abcd","message":"hi","summary":"hi"}\nCALL ListAgents {}', undefined);
    expect(send!.isError).toBe(true);
    expect(JSON.parse(send!.content)).toMatchObject({ status: "not_found", reason: 'no agent or session named "s_0123abcd" is currently reachable' });
    expect(JSON.parse(list!.content)).toEqual({ listing: "No agents or sessions are currently reachable." });
  }, 60_000);
});
