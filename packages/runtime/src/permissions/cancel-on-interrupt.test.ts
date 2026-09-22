// Lane C (C2), claude parity: an interrupt while a permission prompt is open CANCELS the request at
// its source. claude's structuredIO.sendRequest writes `control_cancel_request {request_id}` the
// moment the turn's abort signal fires (cli/structuredIO.ts), and its SDK aborts the pending
// canUseTool callback. The Winter child used to abandon the request silently: the host's callback
// (and the daemon's approval card) kept waiting for an answer nobody would read.
import { expect, test } from "bun:test";
import type { ControlRequestFrame, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine } from "../engine.ts";
import { scriptedProvider, stubExecutor } from "../provider/mock.ts";

const config = { sessionId: "c2", cwd: "/tmp/x", model: "sonnet", persistSession: false } as RuntimeConfig;

test("an interrupt during an open permission prompt emits control_cancel_request for THAT request, then the interrupted result", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "mystery_tool", input: {} }] },
    { kind: "text", text: "unreachable" },
  ]);
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, tools: stubExecutor });
  host.output.write({ type: "user", text: "go" });

  const seen: WinterFrame[] = [];
  let permissionReq: ControlRequestFrame | undefined;
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission") {
      permissionReq = f as ControlRequestFrame;
      break;
    }
  }
  expect(permissionReq).toBeDefined();

  // The host never answers the prompt; the user interrupts instead.
  host.output.write({ type: "control_request", requestId: "int1", subtype: "interrupt", payload: { scope: "turn" } });
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "data" && (f as { message: { type: string } }).message.type === "result") break;
  }

  const cancels = seen.filter((f) => f.type === "control_cancel_request");
  expect(cancels).toEqual([{ type: "control_cancel_request", requestId: permissionReq!.requestId }]);
  const cancelAt = seen.findIndex((f) => f.type === "control_cancel_request");
  const resultAt = seen.findIndex((f) => f.type === "data" && (f as { message: { type: string; interrupted?: boolean } }).message.interrupted === true);
  expect(resultAt).toBeGreaterThan(cancelAt);

  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  for await (const _ of host.input) void _;
  expect(await done).toBe(0);
});
