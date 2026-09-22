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

// Review of f2bbe09: a POLICY-CHANGE RETRY of an evaluation the interrupt abandoned must keep ITS OWN
// turn's signal. The retry (`evaluateWithFreshPolicy`) used to rebuild the context from the mutable
// current-turn signal, so if the next turn had started by then, the abandoned call raised a permission
// prompt on a live signal -- a prompt no turn was waiting on.
test("a policy-change retry of an abandoned evaluation raises NO permission prompt on the next turn", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "mystery_tool", input: {} }] },
    { kind: "text", text: "second turn" },
    { kind: "text", text: "spare" },
  ]);
  const hooked = { ...config, hooks: { PermissionRequest: [{ hookCount: 1, source: "sdk" }] } } as RuntimeConfig;
  const done = runEngine({ config: hooked, input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const waitFor = async (predicate: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  const hookRequests = (): ControlRequestFrame[] => frames.filter((f): f is ControlRequestFrame => f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook");
  const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;

  host.output.write({ type: "user", text: "go" });
  await waitFor(() => hookRequests().length === 1, "the first PermissionRequest hook");
  // The hook is still out when the user interrupts; turn 1 ends, its evaluation is abandoned.
  host.output.write({ type: "control_request", requestId: "int1", subtype: "interrupt", payload: { scope: "turn" } });
  await waitFor(() => results() === 1, "turn 1's interrupted result");
  // Turn 2 starts (and finishes) -- the engine now holds a NEW, live turn signal.
  host.output.write({ type: "user", text: "next" });
  await waitFor(() => results() === 2, "turn 2's result");
  // The policy moves, so the abandoned evaluation will be RETRIED once its hook answers.
  host.output.write({ type: "control_request", requestId: "mode1", subtype: "set_permission_mode", payload: "acceptEdits" });
  await waitFor(() => frames.some((f) => f.type === "control_response" && (f as { requestId?: string }).requestId === "mode1"), "the mode change ack");
  host.output.write({ type: "control_response", requestId: hookRequests()[0]!.requestId, ok: true, payload: {} });
  // The retry asks the hook again (hooks take no signal); no opinion there either.
  await waitFor(() => hookRequests().length === 2, "the retry's PermissionRequest hook");
  host.output.write({ type: "control_response", requestId: hookRequests()[1]!.requestId, ok: true, payload: {} });
  await new Promise((r) => setTimeout(r, 50));

  expect(frames.filter((f) => f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission")).toHaveLength(0);
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await reader;
  await done;
});
