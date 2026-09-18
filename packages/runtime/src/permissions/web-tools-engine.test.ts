// The web tools' permission behaviour, END TO END through the real engine.
//
// `web-tools.test.ts` pins the evaluator's decisions and `tools/impl/web-fetch.test.ts` pins what the
// executor does with the approval marker. This file pins the WIRE BETWEEN THEM, which neither can
// see: that the session's own `web.fetch.privateAddressPolicy` reaches the evaluator, and that the
// decision's `explicitApproval` reaches the executor's `ToolExecutionContext.permission` -- through
// the fallback-wrapped registry adapter, which is the one a production session actually runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ControlRequestFrame, PermissionRequestPayload, PermissionResult, RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import "../tools/descriptors/index.ts";
import { runEngine } from "../engine.ts";
import { scriptedProvider, stubExecutor } from "../provider/mock.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { getRegisteredTool, registerTool, replaceExecutor, unregisterToolForTest, type RegisteredTool, type ToolExecutionContext } from "../tools/registry.ts";
import { resetWebSessionRuntimesForTest } from "../web/session-runtime.ts";

interface Executed {
  input: unknown;
  permission: ToolExecutionContext["permission"];
  hasSignal: boolean;
}

let original: RegisteredTool;
let executed: Executed[];

beforeEach(() => {
  original = getRegisteredTool("WebFetch")!;
  executed = [];
  // A CAPTURING executor in place of the real one: this file is about what the engine hands the
  // executor, not about fetching anything.
  replaceExecutor("WebFetch", {
    async execute(input, ctx) {
      executed.push({ input, permission: ctx.permission, hasSignal: ctx.signal !== undefined });
      return { output: "fetched" };
    },
  });
});

afterEach(() => {
  unregisterToolForTest("WebFetch");
  registerTool(original);
  resetWebSessionRuntimesForTest();
});

interface RunResult {
  permissionRequests: PermissionRequestPayload[];
  toolResults: string[];
}

let sessionCounter = 0;

async function runFetch(url: string, config: Partial<RuntimeConfig>, answer?: PermissionResult): Promise<RunResult> {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "toolu_1", name: "WebFetch", input: { url, prompt: "What is on this page?" } }] },
    { kind: "text", text: "done" },
  ]);
  const runtimeConfig = { sessionId: `web-perms-engine-${++sessionCounter}`, cwd: "/tmp/x", model: "winter-test/echo", persistSession: false, ...config } as RuntimeConfig;
  // NO `tools`: the engine builds its own registry-backed executor, wrapped with the fallback -- the
  // exact composition the production entry point uses.
  const done = runEngine({ config: runtimeConfig, input: runtime.input, output: runtime.output, provider, unregisteredToolExecutor: stubExecutor });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });

  const permissionRequests: PermissionRequestPayload[] = [];
  const toolResults: string[] = [];
  for await (const frame of host.input) {
    if (frame.type === "control_request" && (frame as ControlRequestFrame).subtype === "permission") {
      const request = frame as ControlRequestFrame;
      permissionRequests.push(request.payload as PermissionRequestPayload);
      if (answer !== undefined) host.output.write({ type: "control_response", requestId: request.requestId, ok: true, payload: answer });
      else host.output.write({ type: "control_response", requestId: request.requestId, ok: false, error: { code: "unhandled", message: "no canUseTool configured" } } as never);
    }
    if (frame.type === "data") {
      const message = (frame as { message?: { type?: string; message?: { content?: unknown } } }).message;
      const content = message?.type === "user" ? message.message?.content : undefined;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; content?: unknown }>) {
          if (block.type === "tool_result") toolResults.push(typeof block.content === "string" ? block.content : JSON.stringify(block.content));
        }
      }
    }
  }
  expect(await done).toBe(0);
  return { permissionRequests, toolResults };
}

const PRIVATE_URL = "http://192.168.1.10:8080/status";

describe("the session's privateAddressPolicy reaches the evaluator, and the approval marker reaches the executor", () => {
  test("DEFAULT policy (nothing configured) under bypassPermissions: a private target is still ASKED; an allow answer executes it marked 'prompt'", async () => {
    const run = await runFetch(PRIVATE_URL, { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }, { behavior: "allow" });
    expect(run.permissionRequests).toHaveLength(1);
    expect(run.permissionRequests[0]!.toolName).toBe("WebFetch");
    expect(run.permissionRequests[0]!.decisionReason).toContain("private or loopback address");
    expect(run.permissionRequests[0]!.suggestions).toEqual([{ type: "addRules", rules: [{ toolName: "WebFetch", ruleContent: "domain:192.168.1.10" }], behavior: "allow", destination: "session" }]);
    expect(executed).toEqual([{ input: { url: PRIVATE_URL, prompt: "What is on this page?" }, permission: { explicitApproval: "prompt" }, hasSignal: true }]);
    expect(run.toolResults).toEqual(["fetched"]);
  });

  test("the same ask, REFUSED: the executor never runs", async () => {
    const run = await runFetch(PRIVATE_URL, { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }, { behavior: "deny", message: "not on my network" });
    expect(run.permissionRequests).toHaveLength(1);
    expect(executed).toHaveLength(0);
    expect(run.toolResults.join("\n")).toContain("not on my network");
  });

  test("an allow rule naming the host: no ask at all, executed marked 'rule' -- even though the MODE is what allowed it", async () => {
    const run = await runFetch(PRIVATE_URL, { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, allowedTools: ["WebFetch(domain:192.168.1.10)"] });
    expect(run.permissionRequests).toHaveLength(0);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.permission).toEqual({ explicitApproval: "rule" });
  });

  test("a session that can never prompt (dontAsk) gets a DENIAL naming the rule -- not a hang, not an execution", async () => {
    const run = await runFetch(PRIVATE_URL, { permissionMode: "dontAsk" });
    expect(run.permissionRequests).toHaveLength(0);
    expect(executed).toHaveLength(0);
    expect(run.toolResults.join("\n")).toContain("WebFetch(domain:192.168.1.10)");
  });

  test("`web.fetch.privateAddressPolicy: 'deny'` is read from THIS session's config: denied with no ask, even with a rule naming the host", async () => {
    const run = await runFetch(PRIVATE_URL, { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, allowedTools: ["WebFetch(domain:192.168.1.10)"], web: { fetch: { privateAddressPolicy: "deny" } } }, { behavior: "allow" });
    expect(run.permissionRequests).toHaveLength(0);
    expect(executed).toHaveLength(0);
    expect(run.toolResults.join("\n")).toContain("policy denies WebFetch access to private addresses");
  });

  test("`web.fetch.privateAddressPolicy: 'allow'`: no ask; the mode allows it and it carries NO marker", async () => {
    const run = await runFetch(PRIVATE_URL, { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, web: { fetch: { privateAddressPolicy: "allow" } } });
    expect(run.permissionRequests).toHaveLength(0);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.permission).toBeUndefined();
  });

  test("a PREAPPROVED host is executed with no ask under dontAsk, and carries no marker; a public non-preapproved host is denied there", async () => {
    const preapproved = await runFetch("https://docs.python.org/3/library/asyncio.html", { permissionMode: "dontAsk" });
    expect(preapproved.permissionRequests).toHaveLength(0);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.permission).toBeUndefined();

    executed.length = 0;
    const ordinary = await runFetch("https://example.com/", { permissionMode: "dontAsk" });
    expect(ordinary.permissionRequests).toHaveLength(0);
    expect(executed).toHaveLength(0);
  });
});
