import { test, expect, spyOn, describe } from "bun:test";
import { query, type QueryInternal } from "./query.ts";
import type { Options } from "./options.ts";
import { ResultError, WinterRpcError, InvalidBrandError } from "./errors.ts";
import { inMemoryProcess } from "winter-agent-runtime/testing";
import { echoProvider, testProviderByName } from "winter-agent-runtime";
import type { Provider, ProviderTurn } from "winter-agent-runtime";
import type { SpawnedRuntimeProcess, SpawnRuntimeOptions } from "./transport.ts";
import { encodeFrame } from "./protocol/codec.ts";
import { PROTOCOL_VERSION } from "./protocol/frames.ts";
import type { WinterFrame, ControlResponseFrame } from "./protocol/frames.ts";
import type { PermissionMode, PermissionResult, PermissionRequestPayload, HookInvocationPayload, HookInput, HookJSONOutput } from "./permissions/types.ts";
import type { ModelFamilyListing } from "./protocol/config.ts";
// P7a spine, Step 2 (D19): the brand profile the wrapper resolves onto every `--config-json`.
import { WINTER_BRAND } from "./brand.ts";
// Phase 5 Task 2: the P5 session-option constants (see this file's own P5 block at the bottom).
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_PLANS_DIRECTORY,
  DEFAULT_OUTPUT_STYLE,
} from "./options.ts";

test("query yields system/init, assistant, result in order", async () => {
  const seen: string[] = [];
  for await (const msg of query({
    prompt: "ping",
    options: { model: "winter-test/echo", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args) },
  })) {
    seen.push(msg.type);
  }
  expect(seen).toEqual(["system", "assistant", "result"]);
});

test("error-result-then-throw: the terminal error result is yielded, THEN the iterator throws ResultError", async () => {
  // Task 3: Provider moved from prompt-based to messages-based (ProviderTurn return) — shape
  // update only; the throwing behavior under test is unchanged.
  const boom = { async generate(): Promise<ProviderTurn> { throw new Error("down"); } };
  const yielded: string[] = [];
  let thrown: unknown;
  try {
    for await (const msg of query({
      prompt: "ping",
      options: { model: "winter-test/echo", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, boom) },
    })) {
      yielded.push(msg.type);
      if (msg.type === "result") { /* observe the error result before the throw */ expect((msg as { is_error?: boolean }).is_error).toBe(true); }
    }
  } catch (e) { thrown = e; }
  expect(yielded).toContain("result");        // result WAS yielded first (report §9)
  expect(thrown).toBeInstanceOf(ResultError); // …then the iterator threw
});

// --- Task 3: wrapper-side streaming input (replaces the P0 firstOf stub) -----------------------
//
// A hand-scripted SpawnedRuntimeProcess double (Task 2 precedent, transport.test.ts) that RECORDS
// every stdin write instead of simulating a real runtime. Its own "result" frame is gated on
// having already received `expectedWrites` stdin writes — not a fixed delay — so the test can
// safely drain `query()` to completion and then assert on `writes`, deterministically: by
// construction, the wrapper cannot have seen a terminal result before it finished sending
// everything under test, regardless of microtask interleaving between the send-loop and the
// read-loop (which Task 3 deliberately runs concurrently — see query.ts).
function recordingProcess(expectedWrites: number): { proc: SpawnedRuntimeProcess; writes: string[] } {
  const writes: string[] = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => { resolveReady = r; });
  const proc: SpawnedRuntimeProcess = {
    stdin: {
      write(chunk: string) {
        writes.push(chunk);
        if (writes.length >= expectedWrites) resolveReady();
      },
      end() {},
    },
    stdout: (async function* () {
      yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: "s", cwd: "/x", model: "sonnet", permissionMode: "default", tools: [] });
      await ready;
      yield encodeFrame({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "ok" } });
    })(),
    kill() {},
    exited: Promise.resolve({ code: 0, signal: null }),
    pid: null,
  };
  return { proc, writes };
}

function decodeWrites(writes: string[]): WinterFrame[] {
  return writes.join("").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as WinterFrame);
}

test("string prompt: the wrapper sends one user frame then end_input", async () => {
  const { proc, writes } = recordingProcess(2);
  for await (const _msg of query({ prompt: "hello", options: { spawnClaudeCodeProcess: () => proc } })) { /* drain */ }
  const sent = decodeWrites(writes);
  expect(sent.map((f) => f.type)).toEqual(["user", "control_request"]);
  expect((sent[0] as { text: string }).text).toBe("hello");
  expect((sent[1] as { subtype: string }).subtype).toBe("end_input");
});

test("AsyncIterable prompt: the wrapper sends each item as a user frame in arrival order, then end_input", async () => {
  const { proc, writes } = recordingProcess(4);
  async function* prompts() {
    yield "a"; yield "b"; yield "c";
  }
  for await (const _msg of query({ prompt: prompts(), options: { spawnClaudeCodeProcess: () => proc } })) { /* drain */ }
  const sent = decodeWrites(writes);
  expect(sent.map((f) => f.type)).toEqual(["user", "user", "user", "control_request"]);
  expect(sent.slice(0, 3).map((f) => (f as { text: string }).text)).toEqual(["a", "b", "c"]);
  expect((sent[3] as { subtype: string }).subtype).toBe("end_input");
});

// --- Task 9 (WS-05 §7): Options.{continue,resume,forkSession,resumeSessionAt,resumeDropsTurn,
// persistSession,sessionId} serialize into --config-json ------------------------------------------

function captureConfigJson(): { hook: (opts: SpawnRuntimeOptions) => SpawnedRuntimeProcess; get: () => Record<string, unknown> } {
  let captured: Record<string, unknown> | undefined;
  return {
    hook(opts: SpawnRuntimeOptions) {
      const idx = opts.args.indexOf("--config-json");
      captured = JSON.parse(opts.args[idx + 1] as string) as Record<string, unknown>;
      // Phase 6 Task 10: the CAPTURE is the subject of every assertion below and is taken from the
      // args VERBATIM, before this line. What actually RUNS is given a model in the reserved
      // `winter-test/<name>` namespace, because production selection is now catalog-first and
      // refuses a model it cannot resolve (R6-9) -- `Options.model`'s own default is the pinned
      // `"sonnet"` alias, which needs an anthropic credential this test has none of and must not
      // acquire. Substituting here rather than setting `model` on every one of these tests keeps
      // each one's assertion about the field it is actually testing.
      const runnable = JSON.stringify({ ...(captured as Record<string, unknown>), model: "winter-test/echo" });
      return inMemoryProcess([...opts.args.slice(0, idx + 1), runnable, ...opts.args.slice(idx + 2)]);
    },
    get() {
      if (captured === undefined) throw new Error("captureConfigJson: spawnClaudeCodeProcess was never invoked");
      return captured;
    },
  };
}

test("Task 9 + fix-wave Minor 3: every resume/continue/fork field, AND the pre-T9 maxTurns/model/permissionMode/cwd fields, are present in --config-json when set on Options", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({
    prompt: "ping",
    options: {
      sessionId: "11111111-1111-4111-8111-111111111111",
      model: "opus",
      permissionMode: "acceptEdits",
      cwd: "/winter-fixture-config-round-trip",
      maxTurns: 7,
      continue: true,
      resume: "22222222-2222-4222-8222-222222222222",
      forkSession: true,
      resumeSessionAt: "33333333-3333-4333-8333-333333333333",
      resumeDropsTurn: true,
      persistSession: false,
      spawnClaudeCodeProcess: capture.hook,
    },
  })) {
    /* drain */
  }

  expect(capture.get()).toMatchObject({
    sessionId: "11111111-1111-4111-8111-111111111111",
    model: "opus",
    permissionMode: "acceptEdits",
    cwd: "/winter-fixture-config-round-trip",
    maxTurns: 7,
    continue: true,
    resume: "22222222-2222-4222-8222-222222222222",
    forkSession: true,
    resumeSessionAt: "33333333-3333-4333-8333-333333333333",
    resumeDropsTurn: true,
    persistSession: false,
  });
});

test("Task 9 + fix-wave Minor 3: unset resume/continue/fork/maxTurns fields are OMITTED entirely, but model/permissionMode/cwd NEVER are — they always carry a (possibly defaulted) value", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  const config = capture.get();
  for (const key of ["continue", "resume", "forkSession", "resumeSessionAt", "resumeDropsTurn", "persistSession", "maxTurns"]) {
    expect(config).not.toHaveProperty(key);
  }
  expect(typeof config.sessionId).toBe("string"); // still auto-generated when Options.sessionId is unset
  // Unlike the genuinely-optional fields above, these three are NEVER omitted — query.ts computes
  // a default for each when Options doesn't set them, so --config-json always carries a value.
  expect(config.model).toBe("sonnet");
  expect(config.permissionMode).toBe("default");
  expect(config.cwd).toBe(process.cwd()); // query() runs in THIS same test process — an exact, non-flaky comparison
});

// --- Task 5 (WS-07 §3.3 / phase ruling 1): Options.{allowedTools,disallowedTools,permissions,
// settingSources} serialize into --config-json exactly like every prior field above (T9's own
// precedent, same captureConfigJson helper) --------------------------------------------------

test("Task 5: allowedTools/disallowedTools/permissions/settingSources are present in --config-json when set on Options", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({
    prompt: "ping",
    options: {
      allowedTools: ["Read", "Bash(ls *)"],
      disallowedTools: ["Bash(rm *)"],
      permissions: { allow: ["WebFetch(domain:example.com)"], ask: ["Bash(git push*)"], deny: ["Bash(curl *)"] },
      settingSources: ["user", "local"],
      spawnClaudeCodeProcess: capture.hook,
    },
  })) {
    /* drain */
  }

  expect(capture.get()).toMatchObject({
    allowedTools: ["Read", "Bash(ls *)"],
    disallowedTools: ["Bash(rm *)"],
    permissions: { allow: ["WebFetch(domain:example.com)"], ask: ["Bash(git push*)"], deny: ["Bash(curl *)"] },
    settingSources: ["user", "local"],
  });
});

test("Task 5: unset allowedTools/disallowedTools/permissions/settingSources are OMITTED entirely from --config-json", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  const config = capture.get();
  for (const key of ["allowedTools", "disallowedTools", "permissions", "settingSources"]) {
    expect(config).not.toHaveProperty(key);
  }
});

// --- Task 6 (WS-07 §6.4): allowDangerouslySkipPermissions + permissions.disableBypassPermissionsMode
// serialize into --config-json exactly like every prior field above (same captureConfigJson helper).

test("Task 6: allowDangerouslySkipPermissions and permissions.disableBypassPermissionsMode are present in --config-json when set on Options", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({
    prompt: "ping",
    options: {
      allowDangerouslySkipPermissions: true,
      permissions: { disableBypassPermissionsMode: true },
      spawnClaudeCodeProcess: capture.hook,
    },
  })) {
    /* drain */
  }

  expect(capture.get()).toMatchObject({
    allowDangerouslySkipPermissions: true,
    permissions: { disableBypassPermissionsMode: true },
  });
});

test("Task 6: unset allowDangerouslySkipPermissions is OMITTED entirely from --config-json", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  expect(capture.get()).not.toHaveProperty("allowDangerouslySkipPermissions");
});

// --- Finding 6 (P2 fix-wave, IMPORTANT): Options.{permissionPromptToolName,additionalDirectories}
// serialize into --config-json exactly like every prior field above (same captureConfigJson
// helper) -- the drop-in Options-parity gap this fix wave closes (a consumer passing either field
// under strict object-literal checking previously got a compile error).

test("Finding 6: permissionPromptToolName and additionalDirectories are present in --config-json when set on Options (a compile-level fixture: both fields exist on the Options type at all)", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({
    prompt: "ping",
    options: {
      permissionPromptToolName: "mcp__approvals__prompt",
      additionalDirectories: ["/extra/one", "/extra/two"],
      spawnClaudeCodeProcess: capture.hook,
    },
  })) {
    /* drain */
  }

  expect(capture.get()).toMatchObject({
    permissionPromptToolName: "mcp__approvals__prompt",
    additionalDirectories: ["/extra/one", "/extra/two"],
  });
});

test("Finding 6: unset permissionPromptToolName/additionalDirectories are OMITTED entirely from --config-json", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  const config = capture.get();
  expect(config).not.toHaveProperty("permissionPromptToolName");
  expect(config).not.toHaveProperty("additionalDirectories");
});

// --- Phase 4 Task 2 (WS-09 derived-shapes item (a)/(c)/(d)): Options.{mcpServers,strictMcpConfig,
// toolAliases,agents,forwardSubagentText} serialize into --config-json exactly like every prior
// field above (same captureConfigJson helper) -----------------------------------------------------

test("Phase 4 Task 2: strictMcpConfig/toolAliases/agents/forwardSubagentText are present in --config-json when set on Options", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({
    prompt: "ping",
    options: {
      strictMcpConfig: true,
      toolAliases: { SendMessage: "mcp__winter__send_message" },
      agents: { reviewer: { description: "reviews code", prompt: "You review code.", permissionMode: "acceptEdits" } },
      forwardSubagentText: true,
      spawnClaudeCodeProcess: capture.hook,
    },
  })) {
    /* drain */
  }

  expect(capture.get()).toMatchObject({
    strictMcpConfig: true,
    toolAliases: { SendMessage: "mcp__winter__send_message" },
    agents: { reviewer: { description: "reviews code", prompt: "You review code.", permissionMode: "acceptEdits" } },
    forwardSubagentText: true,
  });
});

test("Phase 4 Task 2: unset strictMcpConfig/toolAliases/agents/forwardSubagentText/mcpServers are OMITTED entirely from --config-json", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  const config = capture.get();
  for (const key of ["strictMcpConfig", "toolAliases", "agents", "forwardSubagentText", "mcpServers"]) {
    expect(config).not.toHaveProperty(key);
  }
});

test("Phase 4 Task 2: mcpServers' stdio/http/sse variants pass through --config-json completely unchanged", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({
    prompt: "ping",
    options: {
      mcpServers: {
        gh: { command: "gh-mcp-server", args: ["--stdio"], env: { TOKEN: "x" } },
        remote: { type: "http", url: "https://example.com/mcp", timeout: 9000 },
        sse: { type: "sse", url: "https://example.com/sse", alwaysLoad: true },
      },
      spawnClaudeCodeProcess: capture.hook,
    },
  })) {
    /* drain */
  }

  expect(capture.get()).toMatchObject({
    mcpServers: {
      gh: { command: "gh-mcp-server", args: ["--stdio"], env: { TOKEN: "x" } },
      remote: { type: "http", url: "https://example.com/mcp", timeout: 9000 },
      sse: { type: "sse", url: "https://example.com/sse", alwaysLoad: true },
    },
  });
});

test("Phase 4 Task 2: an in-process SDK server config's `instance` is stripped before crossing the wire", async () => {
  const capture = captureConfigJson();
  const fakeInstance = { notJsonSafe: () => {} }; // a non-serializable stand-in -- if this leaked through raw, JSON.stringify would silently drop the function property rather than error, so the REAL proof is the assertion below: `instance` must not appear as a KEY at all.
  for await (const _msg of query({
    prompt: "ping",
    options: {
      mcpServers: { winterlike: { type: "sdk", name: "winterlike", timeout: 5000, instance: fakeInstance } },
      spawnClaudeCodeProcess: capture.hook,
    },
  })) {
    /* drain */
  }

  const config = capture.get();
  expect(config.mcpServers).toEqual({ winterlike: { type: "sdk", name: "winterlike", timeout: 5000 } });
  expect(JSON.stringify(config.mcpServers)).not.toContain("instance");
});

// --- Phase 4 Task 3 (WS-04 addendum, "sdk_mcp_call host-side bridge"): tool-discovery gap closed --

function fixtureMcpInstance(tools: Array<{ name: string; description?: string }> = [{ name: "echo" }]): {
  instance: { listTools: () => unknown[]; callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }> };
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    instance: {
      listTools: () => tools.map((t) => ({ name: t.name, ...(t.description !== undefined ? { description: t.description } : {}), inputSchema: { type: "object" } })),
      async callTool(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] };
      },
    },
  };
}

test("an instance implementing WinterMcpServerInstance populates McpSdkServerConfig.tools on the wire", async () => {
  const capture = captureConfigJson();
  const { instance } = fixtureMcpInstance([{ name: "echo", description: "echoes input" }]);
  for await (const _msg of query({
    prompt: "ping",
    options: { mcpServers: { fixture: { type: "sdk", name: "fixture", instance } }, spawnClaudeCodeProcess: capture.hook },
  })) {
    /* drain */
  }
  const config = capture.get();
  expect(config.mcpServers).toEqual({
    fixture: { type: "sdk", name: "fixture", tools: [{ name: "echo", description: "echoes input", inputSchema: { type: "object" } }] },
  });
});

test("an instance NOT implementing WinterMcpServerInstance still strips to the plain 3-field shape (no `tools` key at all)", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({
    prompt: "ping",
    options: { mcpServers: { fixture: { type: "sdk", name: "fixture", instance: { notCallable: true } } }, spawnClaudeCodeProcess: capture.hook },
  })) {
    /* drain */
  }
  const config = capture.get();
  expect(config.mcpServers).toEqual({ fixture: { type: "sdk", name: "fixture" } });
});

test("Task 9: a pre-allocated Options.sessionId round-trips into the init frame's sessionId", async () => {
  const explicitId = "44444444-4444-4444-8444-444444444444";
  let sawInitSessionId: string | undefined;
  for await (const msg of query({
    prompt: "ping",
    options: { sessionId: explicitId, persistSession: false, model: "winter-test/echo", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args) },
  })) {
    if (msg.type === "system" && msg.subtype === "init") sawInitSessionId = (msg as { session_id: string }).session_id;
  }
  expect(sawInitSessionId).toBe(explicitId);
});

// --- Task 2 (WS-04 §3.1, direction inversion): the wrapper's read loop now dispatches
// runtime-originated control_request frames to a handler registry (keyed by subtype), auto-
// answering an unregistered subtype so an old host never parks the runtime forever. Scripted
// double, in-memory only (Query.__internal is a Winter-only extension beyond the WS-03 §4 pinned
// surface — never something a real spawned child depends on for these two tests).

// A scripted double whose stdout emits ONE runtime-originated control_request (after the string
// prompt's user/end_input writes land on stdin, mirroring recordingProcess's own gating idiom
// above) and gates its terminal "result" frame on having OBSERVED the matching control_response
// arrive back on stdin — so asserting "the response landed runtime-side" is deterministic, never a
// timing guess.
function recordingProcessWithControlRequest(subtype: string, requestId: string): { proc: SpawnedRuntimeProcess; writes: string[] } {
  const writes: string[] = [];
  let resolveGotResponse!: () => void;
  const gotResponse = new Promise<void>((r) => {
    resolveGotResponse = r;
  });
  const proc: SpawnedRuntimeProcess = {
    stdin: {
      write(chunk: string) {
        writes.push(chunk);
        for (const line of chunk.split("\n").filter((l) => l.length > 0)) {
          const frame = JSON.parse(line) as { type: string; requestId?: string };
          if (frame.type === "control_response" && frame.requestId === requestId) resolveGotResponse();
        }
      },
      end() {},
    },
    stdout: (async function* () {
      yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: "s", cwd: "/x", model: "sonnet", permissionMode: "default", tools: [] });
      yield encodeFrame({ type: "control_request", requestId, subtype, payload: { probe: true } });
      await gotResponse;
      yield encodeFrame({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "ok" } });
    })(),
    kill() {},
    exited: Promise.resolve({ code: 0, signal: null }),
    pid: null,
  };
  return { proc, writes };
}

function decodeControlResponse(writes: string[], requestId: string): ControlResponseFrame | undefined {
  const sent = writes
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as WinterFrame);
  return sent.find((f) => f.type === "control_response" && (f as ControlResponseFrame).requestId === requestId) as ControlResponseFrame | undefined;
}

// Phase 4 Task 3: same idiom as recordingProcessWithControlRequest above, generalized to carry an
// arbitrary payload (that helper hardcodes `{probe: true}`, which the sdk_mcp_call/mcp_elicitation
// handlers below don't consume) -- kept as its own function rather than widening the existing
// helper's signature, so every pre-existing caller of it stays byte-for-byte unchanged.
function recordingProcessWithControlRequestPayload(subtype: string, requestId: string, payload: unknown): { proc: SpawnedRuntimeProcess; writes: string[] } {
  const writes: string[] = [];
  let resolveGotResponse!: () => void;
  const gotResponse = new Promise<void>((r) => {
    resolveGotResponse = r;
  });
  const proc: SpawnedRuntimeProcess = {
    stdin: {
      write(chunk: string) {
        writes.push(chunk);
        for (const line of chunk.split("\n").filter((l) => l.length > 0)) {
          const frame = JSON.parse(line) as { type: string; requestId?: string };
          if (frame.type === "control_response" && frame.requestId === requestId) resolveGotResponse();
        }
      },
      end() {},
    },
    stdout: (async function* () {
      yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: "s", cwd: "/x", model: "sonnet", permissionMode: "default", tools: [] });
      yield encodeFrame({ type: "control_request", requestId, subtype, payload });
      await gotResponse;
      yield encodeFrame({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "ok" } });
    })(),
    kill() {},
    exited: Promise.resolve({ code: 0, signal: null }),
    pid: null,
  };
  return { proc, writes };
}

test("sdk_mcp_call: a runtime-originated call for a configured SDK server's tool invokes the live instance and returns its CallToolResult", async () => {
  const requestId = "sdkcall-1";
  const { instance, calls } = fixtureMcpInstance();
  const { proc, writes } = recordingProcessWithControlRequestPayload("sdk_mcp_call", requestId, { server: "fixture", tool: "echo", arguments: { x: 1 } });
  for await (const _msg of query({ prompt: "hi", options: { mcpServers: { fixture: { type: "sdk", name: "fixture", instance } }, spawnClaudeCodeProcess: () => proc } })) {
    /* drain */
  }
  expect(calls).toEqual([{ name: "echo", args: { x: 1 } }]);
  const response = decodeControlResponse(writes, requestId);
  expect(response?.ok).toBe(true);
  expect(response?.payload).toEqual({ content: [{ type: "text", text: 'echo:{"x":1}' }] });
});

test("sdk_mcp_call: an unconfigured server name answers ok:false, unknown_sdk_server", async () => {
  const requestId = "sdkcall-2";
  const { instance } = fixtureMcpInstance();
  const { proc, writes } = recordingProcessWithControlRequestPayload("sdk_mcp_call", requestId, { server: "nope", tool: "echo", arguments: {} });
  for await (const _msg of query({ prompt: "hi", options: { mcpServers: { fixture: { type: "sdk", name: "fixture", instance } }, spawnClaudeCodeProcess: () => proc } })) {
    /* drain */
  }
  const response = decodeControlResponse(writes, requestId);
  expect(response?.ok).toBe(false);
  expect(response?.error?.code).toBe("unknown_sdk_server");
});

test("sdk_mcp_call: a configured server whose instance does not implement WinterMcpServerInstance answers ok:false, instance_not_callable", async () => {
  const requestId = "sdkcall-3";
  const { proc, writes } = recordingProcessWithControlRequestPayload("sdk_mcp_call", requestId, { server: "fixture", tool: "echo", arguments: {} });
  for await (const _msg of query({
    prompt: "hi",
    options: { mcpServers: { fixture: { type: "sdk", name: "fixture", instance: { notCallable: true } } }, spawnClaudeCodeProcess: () => proc },
  })) {
    /* drain */
  }
  const response = decodeControlResponse(writes, requestId);
  expect(response?.ok).toBe(false);
  expect(response?.error?.code).toBe("instance_not_callable");
});

test("sdk_mcp_call: a throwing callTool fails closed to ok:false, sdk_tool_threw -- never a dropped request", async () => {
  const requestId = "sdkcall-4";
  const instance = { listTools: () => [], callTool: async () => { throw new Error("boom"); } };
  const { proc, writes } = recordingProcessWithControlRequestPayload("sdk_mcp_call", requestId, { server: "fixture", tool: "echo", arguments: {} });
  for await (const _msg of query({ prompt: "hi", options: { mcpServers: { fixture: { type: "sdk", name: "fixture", instance } }, spawnClaudeCodeProcess: () => proc } })) {
    /* drain */
  }
  const response = decodeControlResponse(writes, requestId);
  expect(response?.ok).toBe(false);
  expect(response?.error?.code).toBe("sdk_tool_threw");
  expect(response?.error?.message).toContain("boom");
});

test("sdk_mcp_call: with no SDK-type server configured at all, falls to the generic unhandled_subtype fallback (identical to any other unregistered subtype)", async () => {
  const requestId = "sdkcall-5";
  const { proc, writes } = recordingProcessWithControlRequestPayload("sdk_mcp_call", requestId, { server: "fixture", tool: "echo", arguments: {} });
  for await (const _msg of query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } })) {
    /* drain */
  }
  const response = decodeControlResponse(writes, requestId);
  expect(response?.ok).toBe(false);
  expect(response?.error?.code).toBe("unhandled_subtype");
});

// --- Phase 4 Task 3 (WS-09 §5): mcp_elicitation --------------------------------------------------

test("mcp_elicitation: a configured onElicitation callback answers the runtime-originated request", async () => {
  const requestId = "elicit-1";
  let receivedRequest: unknown;
  const onElicitation = async (request: unknown) => {
    receivedRequest = request;
    return { action: "accept" as const, content: { name: "Ada" } };
  };
  const { proc, writes } = recordingProcessWithControlRequestPayload("mcp_elicitation", requestId, {
    serverName: "fixture",
    message: "what is your name?",
    requestedSchema: { type: "object" },
  });
  for await (const _msg of query({ prompt: "hi", options: { onElicitation, spawnClaudeCodeProcess: () => proc } })) {
    /* drain */
  }
  expect(receivedRequest).toMatchObject({ serverName: "fixture", message: "what is your name?", requestedSchema: { type: "object" } });
  const response = decodeControlResponse(writes, requestId);
  expect(response?.ok).toBe(true);
  expect(response?.payload).toEqual({ action: "accept", content: { name: "Ada" } });
});

test("mcp_elicitation: no onElicitation configured at all -- falls to unhandled_subtype (the runtime side maps this to a deterministic decline, WS-09 §5)", async () => {
  const requestId = "elicit-2";
  const { proc, writes } = recordingProcessWithControlRequestPayload("mcp_elicitation", requestId, { serverName: "fixture", message: "hi?" });
  for await (const _msg of query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } })) {
    /* drain */
  }
  const response = decodeControlResponse(writes, requestId);
  expect(response?.ok).toBe(false);
  expect(response?.error?.code).toBe("unhandled_subtype");
});

test("mcp_elicitation: a callback returning bare null declines deterministically (DELIBERATE safety deviation from the pinned hang-trap -- see Options.onElicitation's own header)", async () => {
  const requestId = "elicit-3";
  const onElicitation = async () => null;
  const { proc, writes } = recordingProcessWithControlRequestPayload("mcp_elicitation", requestId, { serverName: "fixture", message: "hi?" });
  for await (const _msg of query({ prompt: "hi", options: { onElicitation, spawnClaudeCodeProcess: () => proc } })) {
    /* drain */
  }
  const response = decodeControlResponse(writes, requestId);
  expect(response?.ok).toBe(true); // never a hang, never an unanswered request
  expect(response?.payload).toEqual({ action: "decline" });
});

test("mcp_elicitation: a throwing callback fails closed to a decline, never an unanswered request", async () => {
  const requestId = "elicit-4";
  const onElicitation = async () => {
    throw new Error("boom");
  };
  const { proc, writes } = recordingProcessWithControlRequestPayload("mcp_elicitation", requestId, { serverName: "fixture", message: "hi?" });
  for await (const _msg of query({ prompt: "hi", options: { onElicitation, spawnClaudeCodeProcess: () => proc } })) {
    /* drain */
  }
  const response = decodeControlResponse(writes, requestId);
  expect(response?.ok).toBe(true);
  expect(response?.payload).toEqual({ action: "decline" });
});

test("runtime-originated control_request reaches a registered handler; the response lands runtime-side", async () => {
  const requestId = "probe-1";
  const { proc, writes } = recordingProcessWithControlRequest("test_subtype", requestId);
  const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } });

  const internal = (gen as unknown as { __internal?: QueryInternal }).__internal;
  expect(internal).toBeDefined();
  let receivedPayload: unknown;
  internal!.registerControlRequestHandler("test_subtype", async (payload) => {
    receivedPayload = payload;
    return { ok: true, payload: { answer: 42 } };
  });

  for await (const _msg of gen) {
    /* drain */
  }

  expect(receivedPayload).toEqual({ probe: true });
  const response = decodeControlResponse(writes, requestId);
  expect(response).toBeDefined();
  expect(response!.ok).toBe(true);
  expect(response!.payload).toEqual({ answer: 42 });
});

test("an unregistered control subtype from the runtime is auto-answered ok:false, unhandled_subtype", async () => {
  const requestId = "probe-2";
  const { proc, writes } = recordingProcessWithControlRequest("nobody_handles_this", requestId);
  const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } });

  for await (const _msg of gen) {
    /* drain — no handler registered */
  }

  const response = decodeControlResponse(writes, requestId);
  expect(response).toBeDefined();
  expect(response!.ok).toBe(false);
  expect(response!.error?.code).toBe("unhandled_subtype");
});

// --- Task 8: T2's own control-request-handler mechanism had two branches no existing test ever
// exercised (both predate this task; T8's brief calls them out by name). Neither is
// permission-specific — makePermissionHandler (this task's own "permission" handler) never takes
// either path itself, since it always resolves a determinate {ok:true, payload} (see that
// function's own header) — these two prove the GENERIC registerControlRequestHandler mechanism
// any future subtype's handler shares.

test("T2: a registered handler resolving {ok:false, error} writes that exact error verbatim", async () => {
  const requestId = "probe-3";
  const { proc, writes } = recordingProcessWithControlRequest("test_subtype", requestId);
  const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } });

  const internal = (gen as unknown as { __internal?: QueryInternal }).__internal;
  internal!.registerControlRequestHandler("test_subtype", async () => ({ ok: false, error: { code: "custom_rejection", message: "no thanks" } }));

  for await (const _msg of gen) {
    /* drain */
  }

  const response = decodeControlResponse(writes, requestId);
  expect(response?.ok).toBe(false);
  expect(response?.error).toEqual({ code: "custom_rejection", message: "no thanks" });
});

test("T2: a registered handler that THROWS fails closed — ok:false, code handler_threw, never a dropped request or a wrapper crash", async () => {
  const requestId = "probe-4";
  const { proc, writes } = recordingProcessWithControlRequest("test_subtype", requestId);
  const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } });

  const internal = (gen as unknown as { __internal?: QueryInternal }).__internal;
  internal!.registerControlRequestHandler("test_subtype", async () => {
    throw new Error("handler exploded");
  });

  const seen: string[] = [];
  for await (const msg of gen) seen.push(msg.type);
  expect(seen).toContain("result"); // the throw never crashed the wrapper/query

  const response = decodeControlResponse(writes, requestId);
  expect(response?.ok).toBe(false);
  expect(response?.error?.code).toBe("handler_threw");
  expect(response?.error?.message).toBe("handler exploded");
});

// --- Task 2: real setPermissionMode()/interrupt() — replacing the P0/P1 stubs. Both send a real
// control_request and resolve/reject on the runtime's ack, correlated by requestId
// (pendingHostRequests in query.ts). Driven against the REAL engine (inMemoryProcess), never a
// scripted double, since what's under test is the engine's own set_permission_mode/interrupt
// handling reached THROUGH the wrapper — string prompts close stdin immediately (before any
// message is even yielded), so both tests use streaming input, gated open until after the control
// call's effect is observed, exactly like engine.test.ts's own interrupt precedent.

test("setPermissionMode(): sends a real control request mid-iteration; an invalid mode rejects with a typed error, a valid mode resolves", async () => {
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  async function* prompt() {
    yield "hi";
    await promptGate; // keep the stream open (WS-04 §3: streaming input) until the turn completes
  }

  const gen = query({ prompt: prompt(), options: { model: "winter-test/echo", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, echoProvider) } });

  let validPromise: Promise<void> | undefined;
  let invalidPromise: Promise<void> | undefined;
  for await (const msg of gen) {
    // Fired, NOT awaited, here: the ack is processed by THIS SAME read loop, so awaiting inline
    // would suspend the very loop that has to keep running to deliver it — a deadlock. Both
    // promises are awaited after the loop ends instead (already settled by then).
    if (msg.type === "system" && validPromise === undefined) {
      validPromise = gen.setPermissionMode("plan");
      // Ruling 8 tightened setPermissionMode's TS param to the six-value union — this cast simulates
      // a caller who bypasses the type system (a plain-JS consumer, or a stale/foreign client) so the
      // test can still exercise the RUNTIME's own invalid_mode rejection, which is unaffected by the
      // wrapper's compile-time type.
      invalidPromise = gen.setPermissionMode("not_a_real_mode" as PermissionMode);
    }
    if (msg.type === "result") releasePrompt();
  }

  await validPromise; // throws (failing the test) if the ack path is broken
  let invalidError: unknown;
  try {
    await invalidPromise;
  } catch (e) {
    invalidError = e;
  }
  expect(invalidError).toBeInstanceOf(WinterRpcError);
  expect((invalidError as WinterRpcError).code).toBe("invalid_mode");
});

test("interrupt(): sends a real control request and resolves on ack; drain semantics stay byte-identical to the raw-frame scenario", async () => {
  let enteredGenerate!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredGenerate = resolve;
  });
  const blockingProvider: Provider = {
    generate() {
      enteredGenerate();
      return new Promise(() => {}); // never resolves; the engine must abandon it on interrupt
    },
  };
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  async function* prompt() {
    yield "hang";
    await promptGate;
  }

  const gen = query({ prompt: prompt(), options: { model: "winter-test/echo", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, blockingProvider) } });

  let interruptPromise: Promise<void> | undefined;
  void (async () => {
    await entered; // deterministic: only interrupt once the engine is genuinely blocked inside generate()
    interruptPromise = gen.interrupt();
  })();

  const seen: string[] = [];
  for await (const msg of gen) {
    seen.push(msg.type);
    if (msg.type === "result") {
      expect((msg as { interrupted?: boolean }).interrupted).toBe(true);
      releasePrompt();
    }
  }

  expect(seen).toEqual(["system", "result"]);
  await interruptPromise; // already resolved during the loop above; surfaces any rejection here
});

// --- WS-13c §7 (P6.6 Lane C): Query.listModelFamilies() -----------------------------------------
//
// A scripted double answering ONE CLIENT-initiated control request — the mirror image of
// recordingProcessWithControlRequest above (which scripts a RUNTIME-initiated one). Here query.ts's
// own sendControlRequest is the requester, so the double must wait for the matching stdin write,
// read the requestId back out of it, and answer with a control_response frame of its own.
//
// The hand-built minimal "system"/"init" data frame is transport.test.ts's own systemFrame()
// precedent, rebuilt here rather than imported: recordingProcess() above never emits one (only the
// low-level init handshake), so a test that fires its control call on `msg.type === "system"` —
// the same fire-inside-the-loop-without-awaiting pattern setPermissionMode()/interrupt() use above,
// to avoid the self-deadlock their own comments call out — needs a double that actually sends one.
function scriptedProcessAnsweringControlRequest(subtype: string, payload: unknown): SpawnedRuntimeProcess {
  let resolveRequestId!: (requestId: string) => void;
  const gotRequest = new Promise<string>((resolve) => {
    resolveRequestId = resolve;
  });
  return {
    stdin: {
      write(chunk: string) {
        for (const line of chunk.split("\n").filter((l) => l.length > 0)) {
          const frame = JSON.parse(line) as { type: string; subtype?: string; requestId?: string };
          if (frame.type === "control_request" && frame.subtype === subtype) resolveRequestId(frame.requestId!);
        }
      },
      end() {},
    },
    stdout: (async function* () {
      yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: "s", cwd: "/x", model: "winter-test/echo", permissionMode: "default", tools: [] });
      yield encodeFrame({ type: "data", message: { type: "system", subtype: "init", session_id: "s", cwd: "/x", model: "winter-test/echo", permissionMode: "default", tools: [] } });
      const requestId = await gotRequest;
      yield encodeFrame({ type: "control_response", requestId, ok: true, payload });
      yield encodeFrame({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "ok" } });
    })(),
    kill() {},
    exited: Promise.resolve({ code: 0, signal: null }),
    pid: null,
  };
}

test("listModelFamilies(): resolves the listing the runtime answers over the list_model_families control request", async () => {
  const listing: ModelFamilyListing = {
    active: { family: "gpt", source: "family-default", slots: [{ name: "astra", canonicalModelId: "gpt-6-astra", description: "d", reason: "r" }] },
    families: [
      {
        id: "gpt",
        displayName: "GPT",
        vendor: "OpenAI",
        slots: [{ name: "astra", canonicalModelId: "gpt-6-astra", description: "d", reason: "r", resolvesTo: { providerId: "openai", key: "openai/gpt-6-astra" } }],
        models: [{ canonicalModelId: "gpt-6-astra", displayName: "GPT-6 Astra", rows: [{ key: "openai/gpt-6-astra", providerId: "openai", status: "candidate", pricingBasis: "token", servable: "present" }] }],
      },
    ],
  };
  const proc = scriptedProcessAnsweringControlRequest("list_model_families", listing);
  const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } });

  let resultPromise: Promise<ModelFamilyListing> | undefined;
  for await (const msg of gen) {
    // Fired, NOT awaited, here — same reasoning as setPermissionMode()/interrupt() above: awaiting
    // inline would suspend the very read loop that has to keep running to deliver the ack.
    if (msg.type === "system" && resultPromise === undefined) resultPromise = gen.listModelFamilies();
  }
  expect(await resultPromise).toEqual(listing);
});

test("listModelFamilies(): a malformed control-response payload degrades to { active: undefined, families: [] }, never a throw", async () => {
  const proc = scriptedProcessAnsweringControlRequest("list_model_families", { nonsense: true });
  const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } });

  let resultPromise: Promise<ModelFamilyListing> | undefined;
  for await (const msg of gen) {
    if (msg.type === "system" && resultPromise === undefined) resultPromise = gen.listModelFamilies();
  }
  expect(await resultPromise).toEqual({ active: undefined, families: [] });
});

// --- Task 8 (WS-07 §7): canUseTool end-to-end -------------------------------------------------
//
// Wrapper-isolated tests (this section's first half) drive a SCRIPTED double that emits a raw
// "permission" control_request directly — like recordingProcessWithControlRequest above, but with
// the full WS-07 §7.1 payload — so they exercise query.ts's own handler/response-mapping logic
// independent of whether the real runtime (packages/runtime) ever actually sends one yet. The
// integration tests further down (dontAsk cross-check + its default-mode positive control) drive
// the REAL engine (inMemoryProcess) and only turn green once evaluator.ts's real PromptStage is
// wired into engine.ts — see this task's report for the RED-before/GREEN-after sequencing.

function recordingProcessWithPermissionRequest(payload: PermissionRequestPayload): { proc: SpawnedRuntimeProcess; writes: string[] } {
  const writes: string[] = [];
  let resolveGotResponse!: () => void;
  const gotResponse = new Promise<void>((r) => {
    resolveGotResponse = r;
  });
  const proc: SpawnedRuntimeProcess = {
    stdin: {
      write(chunk: string) {
        writes.push(chunk);
        for (const line of chunk.split("\n").filter((l) => l.length > 0)) {
          const frame = JSON.parse(line) as { type: string; requestId?: string };
          if (frame.type === "control_response" && frame.requestId === payload.requestId) resolveGotResponse();
        }
      },
      end() {},
    },
    stdout: (async function* () {
      yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: "s", cwd: "/x", model: "sonnet", permissionMode: "default", tools: [] });
      yield encodeFrame({ type: "control_request", requestId: payload.requestId, subtype: "permission", payload });
      await gotResponse;
      yield encodeFrame({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "ok" } });
    })(),
    kill() {},
    exited: Promise.resolve({ code: 0, signal: null }),
    pid: null,
  };
  return { proc, writes };
}

function fullPermissionPayload(overrides: Partial<PermissionRequestPayload> = {}): PermissionRequestPayload {
  return {
    toolName: "Bash",
    input: { command: "rm -rf /tmp/x" },
    suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf /tmp/x" }], behavior: "allow", destination: "session" }],
    blockedPath: "/tmp/x",
    decisionReason: "unmatched action reached the prompt stage",
    title: "Run a shell command",
    displayName: "Bash",
    description: "Executes a shell command",
    toolUseID: "call-1",
    agentID: "agent-1",
    requestId: "perm-1",
    matchedAskRule: { source: "sdk", toolName: "Bash", ruleContent: "rm *" },
    policyVersion: 0,
    ...overrides,
  };
}

// Never actually iterated — used only by the shadow-warning tests below, which assert on a
// SYNCHRONOUS side effect of query() construction itself, before any iteration/spawn semantics
// matter at all.
function neverIteratedProc(): SpawnedRuntimeProcess {
  return {
    stdin: { write() {}, end() {} },
    stdout: (async function* () {})(),
    kill() {},
    exited: new Promise(() => {}),
    pid: null,
  };
}

test("canUseTool receives the verbatim WS-07 §7.1 field set", async () => {
  const payload = fullPermissionPayload();
  const { proc } = recordingProcessWithPermissionRequest(payload);
  let receivedToolName: string | undefined;
  let receivedInput: unknown;
  let receivedOpts: Record<string, unknown> | undefined;
  const gen = query({
    prompt: "hi",
    options: {
      spawnClaudeCodeProcess: () => proc,
      canUseTool: async (toolName, input, opts) => {
        receivedToolName = toolName;
        receivedInput = input;
        receivedOpts = { ...opts };
        return { behavior: "allow" };
      },
    },
  });
  for await (const _msg of gen) {
    /* drain */
  }
  expect(receivedToolName).toBe("Bash");
  expect(receivedInput).toEqual({ command: "rm -rf /tmp/x" });
  expect(receivedOpts?.signal).toBeInstanceOf(AbortSignal);
  const { signal: _signal, ...rest } = receivedOpts!;
  expect(rest).toEqual({
    suggestions: payload.suggestions,
    blockedPath: "/tmp/x",
    decisionReason: "unmatched action reached the prompt stage",
    title: "Run a shell command",
    displayName: "Bash",
    description: "Executes a shell command",
    toolUseID: "call-1",
    agentID: "agent-1",
    requestId: "perm-1",
    matchedAskRule: { source: "sdk", toolName: "Bash", ruleContent: "rm *" },
  });
});

test("an allow PermissionResult (with updatedInput/updatedPermissions/decisionClassification) is written back verbatim", async () => {
  const payload = fullPermissionPayload({ requestId: "perm-2" });
  const { proc, writes } = recordingProcessWithPermissionRequest(payload);
  const allowResult: PermissionResult = {
    behavior: "allow",
    updatedInput: { command: "rm -rf /tmp/x --safe" },
    updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf /tmp/x" }], behavior: "allow", destination: "session" }],
    decisionClassification: "user_temporary",
  };
  const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc, canUseTool: async () => allowResult } });
  for await (const _msg of gen) {
    /* drain */
  }
  const response = decodeControlResponse(writes, "perm-2");
  expect(response?.ok).toBe(true);
  expect(response?.payload).toEqual(allowResult);
});

test("a deny PermissionResult (with interrupt/decisionClassification) is written back verbatim", async () => {
  const payload = fullPermissionPayload({ requestId: "perm-3" });
  const { proc, writes } = recordingProcessWithPermissionRequest(payload);
  const denyResult: PermissionResult = { behavior: "deny", message: "no thanks", interrupt: true, decisionClassification: "user_reject" };
  const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc, canUseTool: async () => denyResult } });
  for await (const _msg of gen) {
    /* drain */
  }
  const response = decodeControlResponse(writes, "perm-3");
  expect(response?.ok).toBe(true);
  expect(response?.payload).toEqual(denyResult);
});

test("a throwing canUseTool callback fails closed: a deny PermissionResult is written, plus a console.error note; the query still completes", async () => {
  const payload = fullPermissionPayload({ requestId: "perm-4" });
  const { proc, writes } = recordingProcessWithPermissionRequest(payload);
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const gen = query({
      prompt: "hi",
      options: {
        spawnClaudeCodeProcess: () => proc,
        canUseTool: async () => {
          throw new Error("boom");
        },
      },
    });
    const seen: string[] = [];
    for await (const msg of gen) seen.push(msg.type);
    expect(seen).toContain("result"); // the throw never crashed the wrapper/query
    const response = decodeControlResponse(writes, "perm-4");
    expect(response?.ok).toBe(true);
    expect(response?.payload).toMatchObject({ behavior: "deny" });
    expect((response?.payload as { message: string }).message).toContain("boom");
    expect(errSpy.mock.calls.some((args) => args.some((a) => String(a).includes("boom")))).toBe(true);
  } finally {
    errSpy.mockRestore();
  }
});

test("canUseTool returning null with NO prior out-of-band response fails closed: deny + a console.error warning (accidental null, WS-07 §7.2)", async () => {
  const payload = fullPermissionPayload({ requestId: "perm-5" });
  const { proc, writes } = recordingProcessWithPermissionRequest(payload);
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc, canUseTool: async () => null } });
    for await (const _msg of gen) {
      /* drain */
    }
    const response = decodeControlResponse(writes, "perm-5");
    expect(response?.ok).toBe(true);
    expect(response?.payload).toMatchObject({ behavior: "deny" });
    expect(errSpy).toHaveBeenCalled();
  } finally {
    errSpy.mockRestore();
  }
});

// --- Task 10 (WS-08 §1/§2/§10): the "hook" control-request handler, wrapper-isolated -------------
//
// Mirrors recordingProcessWithPermissionRequest/fullPermissionPayload exactly, for a "hook"
// control_request instead of "permission" — proves query.ts's own dispatch/reconstruction/
// response-mapping logic independent of whether the real runtime (packages/runtime) sends one yet.

function recordingProcessWithHookRequest(payload: HookInvocationPayload): { proc: SpawnedRuntimeProcess; writes: string[] } {
  const writes: string[] = [];
  let resolveGotResponse!: () => void;
  const gotResponse = new Promise<void>((r) => {
    resolveGotResponse = r;
  });
  const proc: SpawnedRuntimeProcess = {
    stdin: {
      write(chunk: string) {
        writes.push(chunk);
        for (const line of chunk.split("\n").filter((l) => l.length > 0)) {
          const frame = JSON.parse(line) as { type: string; requestId?: string };
          if (frame.type === "control_response" && frame.requestId === payload.requestId) resolveGotResponse();
        }
      },
      end() {},
    },
    stdout: (async function* () {
      yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: "s", cwd: "/x", model: "sonnet", permissionMode: "default", tools: [] });
      yield encodeFrame({ type: "control_request", requestId: payload.requestId, subtype: "hook", payload });
      await gotResponse;
      yield encodeFrame({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "ok" } });
    })(),
    kill() {},
    exited: Promise.resolve({ code: 0, signal: null }),
    pid: null,
  };
  return { proc, writes };
}

function fullHookPayload(overrides: Partial<HookInvocationPayload> = {}): HookInvocationPayload {
  return {
    event: "PreToolUse",
    matchedMatcher: "Bash",
    sessionId: "s1",
    agentID: "agent-1",
    toolUseID: "call-1",
    toolName: "Bash",
    input: { command: "rm -rf /tmp/x" },
    policyVersion: "3",
    requestId: "hook-1",
    hookId: "PreToolUse:sdk:0:0",
    ...overrides,
  };
}

test("a hook callback receives a reconstructed HookInput with cwd/session/tool identity, and its answer is written back verbatim as ok:true", async () => {
  const payload = fullHookPayload();
  const { proc, writes } = recordingProcessWithHookRequest(payload);
  let received: { input?: HookInput; toolUseID?: string | undefined } = {};
  const answer: HookJSONOutput = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  const gen = query({
    prompt: "hi",
    options: {
      cwd: "/work",
      spawnClaudeCodeProcess: () => proc,
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input, toolUseID) => {
                received = { input, toolUseID };
                return answer;
              },
            ],
          },
        ],
      },
    },
  });
  for await (const _msg of gen) {
    /* drain */
  }
  expect(received.toolUseID).toBe("call-1");
  expect(received.input).toMatchObject({
    hook_event_name: "PreToolUse",
    session_id: "s1",
    cwd: "/work",
    agent_id: "agent-1",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /tmp/x" },
    tool_use_id: "call-1",
    transcript_path: "",
  });
  const response = decodeControlResponse(writes, "hook-1");
  expect(response?.ok).toBe(true);
  expect(response?.payload).toEqual(answer);
});

test("an unrecognized hookId answers ok:false, unknown_hook_id (a config/registry drift this handler defends against without crashing)", async () => {
  const payload = fullHookPayload({ hookId: "PreToolUse:sdk:0:99" });
  const { proc, writes } = recordingProcessWithHookRequest(payload);
  const gen = query({
    prompt: "hi",
    options: { spawnClaudeCodeProcess: () => proc, hooks: { PreToolUse: [{ hooks: [async () => ({})] }] } },
  });
  for await (const _msg of gen) {
    /* drain */
  }
  const response = decodeControlResponse(writes, "hook-1");
  expect(response?.ok).toBe(false);
  expect(response?.error?.code).toBe("unknown_hook_id");
});

test("a throwing hook callback fails closed to ok:false, hook_threw -- DELIBERATELY NOT a canUseTool-style typed deny (WS-08 §8: a hook error is that hook's own error, never a tool denial by itself)", async () => {
  const payload = fullHookPayload();
  const { proc, writes } = recordingProcessWithHookRequest(payload);
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const gen = query({
      prompt: "hi",
      options: {
        spawnClaudeCodeProcess: () => proc,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async () => {
                  throw new Error("hook exploded");
                },
              ],
            },
          ],
        },
      },
    });
    const seen: string[] = [];
    for await (const msg of gen) seen.push(msg.type);
    expect(seen).toContain("result"); // the throw never crashed the wrapper/query
    const response = decodeControlResponse(writes, "hook-1");
    expect(response?.ok).toBe(false);
    expect(response?.error?.code).toBe("hook_threw");
    expect(response?.error?.message).toBe("hook exploded");
    expect(errSpy.mock.calls.some((args) => args.some((a) => String(a).includes("hook exploded")))).toBe(true);
  } finally {
    errSpy.mockRestore();
  }
});

test("multiple hooks/groups/events resolve to distinct positional hookIds, each dispatching to the correct callback", async () => {
  const calls: string[] = [];
  const makeHook = (name: string) => async () => {
    calls.push(name);
    return {};
  };
  const gen = query({
    prompt: "hi",
    options: {
      spawnClaudeCodeProcess: () => {
        const payload1 = fullHookPayload({ requestId: "hook-a", hookId: "PreToolUse:sdk:0:1", event: "PreToolUse" });
        const payload2 = fullHookPayload({ requestId: "hook-b", hookId: "PreToolUse:sdk:1:0", event: "PreToolUse" });
        const payload3: HookInvocationPayload = {
          event: "SessionStart",
          sessionId: "s1",
          policyVersion: "3",
          requestId: "hook-c",
          hookId: "SessionStart:sdk:0:0",
        };
        const writes: string[] = [];
        const proc: SpawnedRuntimeProcess = {
          stdin: { write: (c: string) => writes.push(c), end() {} },
          stdout: (async function* () {
            yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: "s", cwd: "/x", model: "sonnet", permissionMode: "default", tools: [] });
            yield encodeFrame({ type: "control_request", requestId: payload1.requestId, subtype: "hook", payload: payload1 });
            yield encodeFrame({ type: "control_request", requestId: payload2.requestId, subtype: "hook", payload: payload2 });
            yield encodeFrame({ type: "control_request", requestId: payload3.requestId, subtype: "hook", payload: payload3 });
            yield encodeFrame({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "ok" } });
          })(),
          kill() {},
          exited: Promise.resolve({ code: 0, signal: null }),
          pid: null,
        };
        return proc;
      },
      hooks: {
        PreToolUse: [{ hooks: [makeHook("group0-hook0"), makeHook("group0-hook1")] }, { hooks: [makeHook("group1-hook0")] }],
        SessionStart: [{ hooks: [makeHook("sessionstart-hook0")] }],
      },
    },
  });
  for await (const _msg of gen) {
    /* drain */
  }
  expect(calls.sort()).toEqual(["group0-hook1", "group1-hook0", "sessionstart-hook0"]);
});

test("no Options.hooks at all: the 'hook' subtype is never registered -- falls to the generic unhandled_subtype fallback, identical to any other unregistered subtype", async () => {
  const requestId = "hook-none";
  const { proc, writes } = recordingProcessWithControlRequest("hook", requestId);
  const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } });
  for await (const _msg of gen) {
    /* drain */
  }
  const response = decodeControlResponse(writes, requestId);
  expect(response?.ok).toBe(false);
  expect(response?.error?.code).toBe("unhandled_subtype");
});

test("the null escape: query.__internal.respondPermission sends the out-of-band response; the callback's subsequent null does NOT write a duplicate", async () => {
  const payload = fullPermissionPayload({ requestId: "perm-6" });
  const { proc, writes } = recordingProcessWithPermissionRequest(payload);
  const outOfBandResult: PermissionResult = { behavior: "allow", decisionClassification: "user_permanent" };
  const internalRef: { current?: QueryInternal } = {};
  const gen = query({
    prompt: "hi",
    options: {
      spawnClaudeCodeProcess: () => proc,
      canUseTool: async (_toolName, _input, opts) => {
        internalRef.current!.respondPermission(opts.requestId, outOfBandResult);
        return null;
      },
    },
  });
  internalRef.current = (gen as unknown as { __internal: QueryInternal }).__internal;
  for await (const _msg of gen) {
    /* drain */
  }
  const responses = writes
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as WinterFrame)
    .filter((f): f is ControlResponseFrame => f.type === "control_response" && (f as ControlResponseFrame).requestId === "perm-6");
  expect(responses.length).toBe(1); // never a duplicate write for the same requestId
  expect(responses[0]!.payload).toEqual(outOfBandResult);
});

// --- Task 8 (WS-07 §7.3): the shadow warning — static, one-time, at query() CONSTRUCTION time ----

test("shadow warning: canUseTool + permissionMode 'bypassPermissions' -> exactly one WINTER_SDK_CAN_USE_TOOL_SHADOWED warning", () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    query({
      prompt: "hi",
      options: { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, canUseTool: async () => null, spawnClaudeCodeProcess: () => neverIteratedProc() },
    });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("WINTER_SDK_CAN_USE_TOOL_SHADOWED");
  } finally {
    errSpy.mockRestore();
  }
});

test("shadow warning: canUseTool + a BARE allowedTools entry -> exactly one warning", () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    query({ prompt: "hi", options: { allowedTools: ["Bash"], canUseTool: async () => null, spawnClaudeCodeProcess: () => neverIteratedProc() } });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("WINTER_SDK_CAN_USE_TOOL_SHADOWED");
  } finally {
    errSpy.mockRestore();
  }
});

test("shadow warning: a SCOPED allowedTools entry (has a specifier) does NOT warn", () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    query({ prompt: "hi", options: { allowedTools: ["Bash(ls:*)"], canUseTool: async () => null, spawnClaudeCodeProcess: () => neverIteratedProc() } });
    expect(errSpy).not.toHaveBeenCalled();
  } finally {
    errSpy.mockRestore();
  }
});

// WS-07 §3 pins `Tool(*)` as bare-equivalent ("treated like bare Bash, including schema removal") —
// found missing from the static check by review: it initially only matched entries with NO
// parenthesized specifier at all, so a wildcard specifier slipped through as "scoped."
test("shadow warning: an allowedTools entry with a bare wildcard specifier, e.g. 'Bash(*)', warns exactly like the truly-bare form (WS-07 §3: bare-equivalent)", () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    query({ prompt: "hi", options: { allowedTools: ["Bash(*)"], canUseTool: async () => null, spawnClaudeCodeProcess: () => neverIteratedProc() } });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("WINTER_SDK_CAN_USE_TOOL_SHADOWED");
  } finally {
    errSpy.mockRestore();
  }
});

test("shadow warning: canUseTool alone, default mode, no allowedTools -> never warns", () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    query({ prompt: "hi", options: { canUseTool: async () => null, spawnClaudeCodeProcess: () => neverIteratedProc() } });
    expect(errSpy).not.toHaveBeenCalled();
  } finally {
    errSpy.mockRestore();
  }
});

test("shadow warning: bypassPermissions with NO canUseTool configured never warns (nothing is being shadowed)", () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    query({ prompt: "hi", options: { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, spawnClaudeCodeProcess: () => neverIteratedProc() } });
    expect(errSpy).not.toHaveBeenCalled();
  } finally {
    errSpy.mockRestore();
  }
});

// --- Task 8: integration cross-check against T6's dontAsk semantics (real engine) ------------------
//
// These two drive the REAL engine (inMemoryProcess) rather than a scripted double — "dontAsk never
// calls canUseTool" is only a meaningful claim once default mode (the positive control right above
// it) provably DOES reach it through the same real stack. Both are RED until evaluator.ts's real
// PromptStage is wired into engine.ts (this task's Step 2) — see the task report.

test("default mode: an unmatched tool call reaches canUseTool through the REAL engine (positive control for the dontAsk cross-check below)", async () => {
  let called = false;
  const gen = query({
    prompt: "go",
    options: {
      canUseTool: async () => {
        called = true;
        return { behavior: "allow" };
      },
      model: "winter-test/tooluse",
      spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, testProviderByName("tooluse")),
    },
  });
  for await (const _msg of gen) {
    /* drain */
  }
  expect(called).toBe(true);
});

test("the null escape through the REAL engine+bridge (Task 8 review fix regression net): respondPermission's answer is correlated correctly even though the RUNTIME's own bridge mints the wire envelope id, not this test's fixture", async () => {
  // The wrapper-isolated "null escape" test above uses a hand-rolled scripted process where the
  // envelope id and payload.requestId happen to be constructed as the SAME string by the test
  // fixture itself — it never exercises whether the REAL runtime actually keeps them aligned.
  // Before the review fix, rpc/bridge.ts's `request()` always minted its OWN fresh envelope id,
  // independent of `payload.requestId` (the only id this callback ever sees) — so this exact
  // scenario, driven through the real engine, either hung (bridge.request() never resolving) or
  // threw (an ok:true-with-no-payload fallback write resolving it to `undefined`). This test is
  // the genuine end-to-end proof the ids are now forced to match.
  let called = false;
  const internalRef: { current?: QueryInternal } = {};
  const gen = query({
    prompt: "go",
    options: {
      canUseTool: async (_toolName, _input, opts) => {
        called = true;
        internalRef.current!.respondPermission(opts.requestId, { behavior: "allow" });
        return null; // the legitimate null escape: already answered out of band, above
      },
      model: "winter-test/tooluse",
      spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, testProviderByName("tooluse")),
    },
  });
  internalRef.current = (gen as unknown as { __internal: QueryInternal }).__internal;
  const userMessages: Array<{ content: Array<{ type: string; denied?: boolean; content?: string }> }> = [];
  for await (const msg of gen) {
    const raw = msg as unknown as { type: string; message?: { content: Array<{ type: string; denied?: boolean; content?: string }> } };
    if (raw.type === "user" && raw.message) userMessages.push(raw.message);
  }
  expect(called).toBe(true);
  const resultBlock = userMessages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
  // Genuine execution, not a fail-closed denial and not a hang: proves the out-of-band allow
  // actually reached the waiting bridge.request() promise.
  expect(resultBlock?.denied).toBeUndefined();
  expect(resultBlock?.content).toBe('test_tool:{"probe":true}');
});

test("dontAsk mode: canUseTool is NEVER invoked through the REAL engine, even for a call that would otherwise reach it (WS-07 §6.3 cross-check)", async () => {
  let called = false;
  const gen = query({
    prompt: "go",
    options: {
      permissionMode: "dontAsk",
      canUseTool: async () => {
        called = true;
        return { behavior: "allow" };
      },
      model: "winter-test/tooluse",
      spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, testProviderByName("tooluse")),
    },
  });
  const userMessages: Array<{ content: Array<{ type: string; denied?: boolean }> }> = [];
  for await (const msg of gen) {
    // Note: the "user" tool_result frame is yielded at RUNTIME (iterate() forwards a data frame's
    // message verbatim, unfiltered) even though the closed SdkMessage TYPE only names
    // system/assistant/result — a pre-existing SDK-surface gap, out of this task's scope. Widen to
    // `unknown` to inspect it without fighting that type.
    const raw = msg as unknown as { type: string; message?: { content: Array<{ type: string; denied?: boolean }> } };
    if (raw.type === "user" && raw.message) userMessages.push(raw.message);
  }
  expect(called).toBe(false);
  const deniedBlock = userMessages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
  expect(deniedBlock?.denied).toBe(true);
});

// Item 1 (P2 fix-wave): a control call issued AFTER the generator has already completed used to
// register a promise nothing could ever settle (the runtime connection is torn down; stdin may
// already be silently no-op-ing post-.end()) -- hanging the caller forever with no diagnostic.
// Mirrors rpc/bridge.ts's own `closed` latch (runtime side) on the wrapper side.
test("Item 1: a control call issued AFTER the generator completes rejects immediately with a typed error, instead of hanging forever", async () => {
  const gen = query({ prompt: "hi", options: { model: "winter-test/echo", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args) } });
  for await (const _msg of gen) {
    /* drain to natural completion (sawTerminal) */
  }

  let caught: unknown;
  try {
    await gen.interrupt();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(WinterRpcError);
  expect((caught as WinterRpcError).code).toBe("connection_closed");
});

test("Item 1: setPermissionMode issued AFTER the generator completes ALSO rejects immediately (the guard is not interrupt-specific)", async () => {
  const gen = query({ prompt: "hi", options: { model: "winter-test/echo", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args) } });
  for await (const _msg of gen) {
    /* drain to natural completion */
  }

  let caught: unknown;
  try {
    await gen.setPermissionMode("plan");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(WinterRpcError);
});

test("Item 1: a control call issued an early consumer .return() away from the generator (never drained to sawTerminal) ALSO rejects, not just the natural-completion path", async () => {
  const gen = query({ prompt: "hi", options: { model: "winter-test/echo", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args) } });
  for await (const _msg of gen) {
    break; // an early exit -- triggers the generator's own finally via an implicit .return()
  }

  let caught: unknown;
  try {
    await gen.interrupt();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(WinterRpcError);
});

test("Item 1: BEFORE the generator has ever been iterated, a control call still proceeds normally (the guard only trips AFTER completion)", async () => {
  const { proc, writes } = recordingProcess(3); // user + end_input (sent once iteration starts) + this interrupt call
  const gen = query({ prompt: "hi", options: { spawnClaudeCodeProcess: () => proc } });
  // Deliberately NOT iterating `gen` before this call -- an async generator's BODY (and therefore
  // its own `finally`, which is what actually sets generatorTerminated) never runs until first
  // advanced, so the guard cannot have tripped yet purely from construction. `sendControlRequest`
  // itself lives OUTSIDE iterate()'s body, so this write happens immediately regardless.
  const interruptPromise = gen.interrupt();
  interruptPromise.catch(() => {}); // never actually acked in this fixture -- avoid an unhandled rejection
  for await (const _msg of gen) {
    /* drives iterate()'s own body, which sends user+end_input -- together with the interrupt
       write above, this reaches recordingProcess's own expectedWrites=3 gate and lets it complete. */
  }
  expect(decodeWrites(writes).some((f) => f.type === "control_request" && (f as { subtype: string }).subtype === "interrupt")).toBe(true);
});

// --- Phase 5 Task 2 (WS-11; R5-3/R5-4/R5-9/R5-10/R5-11 as amended after Task 1): the P5 session
// options serialize into --config-json exactly like every prior field above (same captureConfigJson
// helper, same conditional-spread convention -- query.ts interprets none of them).

test("P5 T2: the P5 option block is present in --config-json when set on Options", async () => {
  const capture = captureConfigJson();
  try {
  for await (const _msg of query({
    prompt: "ping",
    options: {
      settingSources: ["project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code", append: "extra", excludeDynamicSections: true },
      plugins: [{ type: "local", path: "/plugins/a", skipMcpDiscovery: true }],
      skills: ["writing", "review"],
      outputFormat: { type: "json_schema", schema: { type: "object" } },
      enableFileCheckpointing: true,
      contextWindowTokens: 123456,
      compactionThreshold: 0.5,
      trustedWorkspace: true,
      plansDirectory: "custom/plans",
      outputStyle: "explanatory",
      spawnClaudeCodeProcess: capture.hook,
    },
  })) {
    /* drain */
  }
  } catch {
    // Phase 5 Task 3: `outputFormat` now has a real engine consumer, and this fixture supplies no
    // structured-output seam, so the RUN legitimately terminates with the R5-10 configuration error
    // (which query() surfaces by rejecting). That is the behaviour a separate contract test pins;
    // THIS test is about the WIRE -- what `--config-json` carried -- which is captured before the
    // run gets anywhere near a provider call.
  }

  expect(capture.get()).toMatchObject({
    settingSources: ["project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code", append: "extra", excludeDynamicSections: true },
    plugins: [{ type: "local", path: "/plugins/a", skipMcpDiscovery: true }],
    skills: ["writing", "review"],
    outputFormat: { type: "json_schema", schema: { type: "object" } },
    enableFileCheckpointing: true,
    contextWindowTokens: 123456,
    compactionThreshold: 0.5,
    trustedWorkspace: true,
    plansDirectory: "custom/plans",
    outputStyle: "explanatory",
  });
});

test("P5 T2: the string[] arm of systemPrompt round-trips verbatim, sentinel included", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({
    prompt: "ping",
    options: { systemPrompt: ["static", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "session-specific"], spawnClaudeCodeProcess: capture.hook },
  })) {
    /* drain */
  }
  expect(capture.get()["systemPrompt"]).toEqual(["static", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "session-specific"]);
});

test("P5 T2: every unset P5 option is OMITTED entirely from --config-json (defaults are applied runtime-side, never here)", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  const config = capture.get();
  for (const key of [
    "systemPrompt",
    "plugins",
    "skills",
    "outputFormat",
    "enableFileCheckpointing",
    "contextWindowTokens",
    "compactionThreshold",
    "trustedWorkspace",
    "plansDirectory",
    "outputStyle",
  ]) {
    expect(config).not.toHaveProperty(key);
  }
});

test("P5 T2: the pinned session defaults are exported as constants rather than baked into the wire", () => {
  expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(200000);
  expect(DEFAULT_COMPACTION_THRESHOLD).toBe(0.92);
  expect(DEFAULT_PLANS_DIRECTORY).toBe(".winter/plans");
  expect(DEFAULT_OUTPUT_STYLE).toBe("default");
  expect(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).toBe("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
});

// ================================================================================================
// T8 rider 6 / RULING P5-E: the two construction-time rejections, compared VERBATIM against the
// pinned artifact with the brand rename applied.
// ================================================================================================
//
// Capture (2) (`compat/anthropic/0.3.250/derived-shapes-p5.md`) recorded both messages, both classes,
// and the VALIDATION ORDER, from a real run against the pinned 0.3.250 runtime. P5-E's rule is that
// pinned error strings keep their wording except brand names, which follow WS-01 §2.5's rename --
// so a parity fixture compares WITH the rename applied, and this is that fixture.
//
// THE STRINGS BELOW ARE THE CAPTURED ONES, transformed by exactly one substitution
// (`CLAUDE_CONFIG_DIR` -> `WINTER_HOME`). Nothing else about either message may move: the reason
// clause ("backup blobs are not mirrored, so rewindFiles() fails after a store-backed resume") is
// what makes WS-11 §9's "stays correctly unavailable" the right long-term framing rather than a
// vague deferral, and a host that greps for it would not find a paraphrase.
//
// Hermetic: no artifact is fetched here. These are transcriptions of an already-recorded capture,
// which is the same footing every other conformance fixture in this repository stands on.
describe("rider 6 / P5-E: the pinned rejection messages, with the brand rename applied", () => {
  const PINNED_CHECKPOINTING_MESSAGE =
    "enableFileCheckpointing is not yet supported with sessionStore (backup blobs are not mirrored, so rewindFiles() fails after a store-backed resume).";
  // The ONE renamed token, and the only difference from the captured text.
  const PINNED_PERSIST_SESSION_MESSAGE =
    "sessionStore cannot be used with persistSession: false -- the storage adapter requires local writes to mirror from. Use WINTER_HOME=/tmp for ephemeral local writes with external mirroring.";

  const fakeStore = { load: async () => null, append: async () => {}, list: async () => [] } as unknown as NonNullable<Options["sessionStore"]>;

  function constructionError(options: Partial<Options>): Error {
    try {
      // `query()` throws SYNCHRONOUSLY from the call itself (capture (2): request count 0, zero
      // messages yielded) -- so the throw is caught here, not on the first `for await`.
      query({ prompt: "x", options: { ...options, spawnClaudeCodeProcess: () => { throw new Error("unreachable -- the constructor must throw first"); } } as Options });
    } catch (err) {
      return err as Error;
    }
    throw new Error("expected query() to throw at construction");
  }

  test("enableFileCheckpointing + sessionStore: a PLAIN Error, verbatim", () => {
    const err = constructionError({ enableFileCheckpointing: true, sessionStore: fakeStore });
    // A plain built-in `Error`, NOT a named subclass -- capture (2) is explicit that a typed class
    // would be STRICTER than the pin, which is a divergence to disclose rather than parity.
    expect(err.constructor).toBe(Error);
    expect(err.name).toBe("Error");
    expect(err.message).toBe(PINNED_CHECKPOINTING_MESSAGE);
  });

  test("sessionStore + persistSession:false: the other message, verbatim, with WINTER_HOME for CLAUDE_CONFIG_DIR", () => {
    const err = constructionError({ sessionStore: fakeStore, persistSession: false });
    expect(err.constructor).toBe(Error);
    expect(err.message).toBe(PINNED_PERSIST_SESSION_MESSAGE);
    // The rename, asserted as a property rather than only as a literal: no branded name survives.
    expect(err.message).not.toContain("CLAUDE_CONFIG_DIR");
  });

  test("VALIDATION ORDER is observable, and matches: persistSession is checked FIRST and wins", () => {
    // Capture (2)'s third refinement, and the one a re-implementation gets wrong silently: with all
    // three conflicting, the pin reports the `persistSession` message. A Winter that checked in the
    // other order would produce a different message for the same call, and every single-conflict
    // test above would still pass.
    const err = constructionError({ enableFileCheckpointing: true, sessionStore: fakeStore, persistSession: false });
    expect(err.message).toBe(PINNED_PERSIST_SESSION_MESSAGE);
  });
});

// --- Phase 6 Task 2 (WS-13): the provider option fields serialize into --config-json ---------------
//
// The reason this test exists rather than being taken on faith: a RuntimeConfig field with no
// PRODUCER is this repo's own recorded defect shape (options.ts's comments on
// `permissionPromptToolName` and `additionalDirectories` are two prior instances, both found only
// during a later fix wave). Declaring `provider?: ProviderSelection` on both sides type-checks
// perfectly while the value never crosses the wire — and R6-9 makes `config.provider.providerId`
// the ONLY resolution input for a bare model id, so silence there is a session that cannot
// resolve a model at all.

test("Phase 6 Task 2: every provider-layer option is present in --config-json when set on Options", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({
    prompt: "ping",
    options: {
      provider: {
        providerId: "openai",
        authRef: { kind: "env", name: "WINTER_TEST_OPENAI_KEY" },
        connection: { baseUrl: "https://api.example.test/v1", region: "us-east-1", local: false },
        allowUnlisted: false,
      },
      fallbackModel: "anthropic/claude-haiku-4-5-20251001,anthropic/claude-sonnet-5",
      thinking: { type: "enabled", budgetTokens: 4096, display: "summarized" },
      effort: "high",
      maxThinkingTokens: 0,
      includePartialMessages: true,
      maxBudgetUsd: 2.5,
      providerStallTimeoutMs: 45000,
      keychainService: "com.winter.core.dev",
      autoClassifier: { model: "openai/gpt-4.1", authRef: { kind: "none" } },
      advisor: { model: "anthropic/claude-sonnet-5" },
      spawnClaudeCodeProcess: capture.hook,
    },
  })) {
    /* drain */
  }
  const config = capture.get();
  expect(config["provider"]).toEqual({
    providerId: "openai",
    authRef: { kind: "env", name: "WINTER_TEST_OPENAI_KEY" },
    connection: { baseUrl: "https://api.example.test/v1", region: "us-east-1", local: false },
    allowUnlisted: false,
  });
  // The comma-separated STRING form, not an array (derived-shapes-p6.md item (g), finding 1).
  expect(config["fallbackModel"]).toBe("anthropic/claude-haiku-4-5-20251001,anthropic/claude-sonnet-5");
  expect(config["thinking"]).toEqual({ type: "enabled", budgetTokens: 4096, display: "summarized" });
  expect(config["effort"]).toBe("high");
  // `0` is the deprecated field's DISABLE spelling — it must survive a falsy-check-shaped bug.
  expect(config["maxThinkingTokens"]).toBe(0);
  expect(config["includePartialMessages"]).toBe(true);
  expect(config["maxBudgetUsd"]).toBe(2.5);
  expect(config["providerStallTimeoutMs"]).toBe(45000);
  expect(config["keychainService"]).toBe("com.winter.core.dev");
  expect(config["autoClassifier"]).toEqual({ model: "openai/gpt-4.1", authRef: { kind: "none" } });
  expect(config["advisor"]).toEqual({ model: "anthropic/claude-sonnet-5" });
});

test("Phase 6 Task 2: unset provider-layer options are OMITTED entirely — an unconfigured session's wire is byte-identical to before they existed", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  const config = capture.get();
  for (const key of [
    "provider", "fallbackModel", "thinking", "effort", "maxThinkingTokens", "includePartialMessages",
    "maxBudgetUsd", "providerStallTimeoutMs", "keychainService", "autoClassifier", "advisor",
  ]) {
    expect(key in config).toBe(false);
  }
});

// --- Phase 6 Task 3 (R6-F): a PROVIDER failure yields its result AND throws -------------------------
//
// Capture (I): both hermetic runs yielded the `result` and THEN threw. A host that only iterates and
// never wraps the loop in `try` sees an uncaught throw on every provider failure -- which is the
// pinned behaviour, and is why this is asserted rather than assumed from the `is_error` path alone.
function resultOnlyProcess(result: Record<string, unknown>): SpawnedRuntimeProcess {
  return {
    stdin: { write() {}, end() {} },
    stdout: (async function* () {
      yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: "s", cwd: "/x", model: "sonnet", permissionMode: "default", tools: [] });
      yield encodeFrame({ type: "data", message: result as never });
    })(),
    kill() {},
    exited: Promise.resolve({ code: 0, signal: null }),
    pid: null,
  };
}

test("R6-F: a result with terminal_reason 'api_error' is YIELDED and then thrown, with the reason in the message", async () => {
  const yielded: string[] = [];
  let threw: Error | undefined;
  try {
    for await (const m of query({
      prompt: "go",
      options: {
        spawnClaudeCodeProcess: () =>
          resultOnlyProcess({
            type: "result",
            subtype: "success",
            is_error: true,
            result: "provider request failed (server): upstream exploded",
            terminal_reason: "api_error",
            api_error_status: 529,
            permission_denials: [],
          }),
      },
    })) {
      yielded.push(m.type);
    }
  } catch (err) {
    threw = err as Error;
  }
  // The result reached the consumer BEFORE the throw -- a host that inspects results still sees it.
  expect(yielded).toEqual(["result"]);
  expect(threw).toBeDefined();
  // `result error: success` would name the one field that does NOT describe the failure.
  expect(threw!.message).toContain("provider request failed");
  expect(threw!.message).toContain("upstream exploded");
  expect((threw as ResultError).result.api_error_status).toBe(529);
});

test("R6-F: an ordinary error result keeps its pre-P6 message, byte-identical", async () => {
  let threw: Error | undefined;
  try {
    for await (const _ of query({
      prompt: "go",
      options: { spawnClaudeCodeProcess: () => resultOnlyProcess({ type: "result", subtype: "error_during_execution", is_error: true, result: "a plain bug", permission_denials: [] }) },
    })) {
      void _;
    }
  } catch (err) {
    threw = err as Error;
  }
  expect(threw!.message).toBe("result error: error_during_execution");
});

// ================================================================================================
// P7a spine, Step 2 (D19): `Options.brand` -> `RuntimeConfig.brand`.
//
// The scripted double is the whole proof surface here: `brand` is not observable anywhere else in
// this package (nothing the wrapper does with it changes a frame), so what has to be pinned is that
// the FULL resolved profile reaches `--config-json` — including for a session that never mentioned
// the option, which is the case a "conditional spread like every other field" implementation would
// silently get wrong.
// ================================================================================================

test("P7a: an unbranded session still carries the FULL resolved Winter profile on the wire", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  // Unconditional, unlike every other optional option: the runtime never defaults a missing brand
  // (protocol/config.ts's own field comment), so an absent key would be a session with no names.
  expect(capture.get()["brand"]).toEqual(WINTER_BRAND);
});

test("P7a: a partial brand folds onto Winter's defaults and the WHOLE profile rides the wire", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({
    prompt: "ping",
    options: {
      brand: { productName: "Acme", homeDirName: ".acme", projectDirName: ".acme", envPrefix: "ACME_", codexOriginator: "acme", mcpServerName: "acme" },
      spawnClaudeCodeProcess: capture.hook,
    },
  })) {
    /* drain */
  }
  const brand = capture.get()["brand"] as Record<string, unknown>;
  expect(brand["productName"]).toBe("Acme");
  expect(brand["homeDirName"]).toBe(".acme");
  expect(brand["envPrefix"]).toBe("ACME_");
  expect(brand["mcpServerName"]).toBe("acme");
  // Not supplied -> Winter's, and PRESENT: the runtime reads the profile as a whole, so a folded
  // profile that dropped its un-overridden fields would leave the child with holes to guess at.
  expect(brand["packageName"]).toBe(WINTER_BRAND.packageName);
  expect(brand["instructionsFile"]).toBe(WINTER_BRAND.instructionsFile);
  expect(brand["presetName"]).toBe(WINTER_BRAND.presetName);
  expect(brand["tempRootName"]).toBe(WINTER_BRAND.tempRootName);
  expect(brand["pluginManifestDir"]).toBe(WINTER_BRAND.pluginManifestDir);
  expect(Object.keys(brand).sort()).toEqual(Object.keys(WINTER_BRAND).sort());
});

test("P7a: an invalid brand is a typed InvalidBrandError thrown SYNCHRONOUSLY from query(), naming the field", () => {
  // Synchronous, like the two sessionStore rejections: nothing spawns, nothing is yielded, and the
  // host learns at construction rather than on the first `for await`.
  let threw: unknown;
  try {
    query({ prompt: "ping", options: { brand: { envPrefix: "acme" }, spawnClaudeCodeProcess: () => inMemoryProcess([]) } });
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(InvalidBrandError);
  expect((threw as InvalidBrandError).code).toBe("invalid_brand");
  expect((threw as InvalidBrandError).reason).toContain("envPrefix");
  expect((threw as Error).message).toContain("invalid_brand");
});

test("P7a: a first-party codexOriginator is refused at query() — the impersonation rule reaches the option", () => {
  expect(() => query({ prompt: "ping", options: { brand: { codexOriginator: "anthropic" }, spawnClaudeCodeProcess: () => inMemoryProcess([]) } })).toThrow(InvalidBrandError);
});

test("P7a: the DEPRECATED keychainService option wins over brand.keychainService, and the loss is warned about", async () => {
  const warned: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    warned.push(args.join(" "));
  });
  try {
    const capture = captureConfigJson();
    for await (const _msg of query({
      prompt: "ping",
      options: { keychainService: "com.acme.core.dev", brand: { keychainService: "com.acme.core" }, spawnClaudeCodeProcess: capture.hook },
    })) {
      /* drain */
    }
    const config = capture.get();
    // BOTH surfaces agree — the fold happens BEFORE resolution (fix r1, Important-2), so there is
    // one validated value and the wire emit reads it from the resolved profile.
    expect(config["keychainService"]).toBe("com.acme.core.dev");
    expect((config["brand"] as Record<string, unknown>)["keychainService"]).toBe("com.acme.core.dev");
    expect(warned.some((w) => w.includes("keychainService") && w.includes("com.acme.core.dev") && w.includes("com.acme.core"))).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("P7a: setting BOTH keychain services to the SAME value warns about nothing", async () => {
  const warned: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    warned.push(args.join(" "));
  });
  try {
    const capture = captureConfigJson();
    for await (const _msg of query({
      prompt: "ping",
      options: { keychainService: "com.acme.core", brand: { keychainService: "com.acme.core" }, spawnClaudeCodeProcess: capture.hook },
    })) {
      /* drain */
    }
    expect((capture.get()["brand"] as Record<string, unknown>)["keychainService"]).toBe("com.acme.core");
    expect(warned.filter((w) => w.includes("keychainService"))).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test("P7a fix r1 (Important-1): the two keychain surfaces AGREE whenever the wire key is present", async () => {
  // THE BUG THIS REPLACES. This test used to assert that `brand.keychainService` alone left the
  // top-level wire key ABSENT -- which pinned the defect: every runtime consumer reads the top-level
  // key (session-provider's store construction and its `authRef` spread), so a host that chose its
  // service through the profile had its credentials resolve under Winter's default anyway, silently,
  // for the headline use case of the whole option.
  //
  // Three surfaces, one value. Asserted for both ways of choosing a service, because a fix that
  // emitted from `options.keychainService` rather than from the resolved profile would still pass
  // the deprecated-option case alone.
  for (const [label, options] of [
    ["through the profile", { brand: { keychainService: "com.acme.core" } }],
    ["through the deprecated option", { keychainService: "com.acme.core" }],
    ["through both, agreeing", { keychainService: "com.acme.core", brand: { keychainService: "com.acme.core" } }],
  ] as const) {
    const capture = captureConfigJson();
    for await (const _msg of query({ prompt: "ping", options: { ...options, spawnClaudeCodeProcess: capture.hook } })) {
      /* drain */
    }
    const config = capture.get();
    expect([label, config["keychainService"]]).toEqual([label, "com.acme.core"]);
    expect([label, (config["brand"] as Record<string, unknown>)["keychainService"]]).toEqual([label, "com.acme.core"]);
  }
});

test("P7a fix r1 (Important-1): a session that chose NO service is byte-identical — the wire key stays absent", async () => {
  // The other half of the conditional, and the reason it is a conditional at all: emitting
  // `brand.keychainService` unconditionally would put `com.winter.core` on every session's wire,
  // break the pinned omitted-keys contract, and widen every credential `authRef` with a `service`
  // field that reaches persisted records.
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  const config = capture.get();
  expect("keychainService" in config).toBe(false);
  // The profile still carries Winter's default, so a runtime reading the single source is correct
  // either way -- absence on the wire means "nobody chose", never "no service".
  expect((config["brand"] as Record<string, unknown>)["keychainService"]).toBe("com.winter.core");
});

test("P7a fix r1 (Important-1): a brand that sets a NON-keychain field still leaves the wire key absent", async () => {
  // The condition keys on the VALUE, not on "a brand was supplied" -- a host branding its home dir
  // and nothing else has chosen no service, and must not start emitting one.
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { brand: { homeDirName: ".acme" }, spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  expect("keychainService" in capture.get()).toBe(false);
});

test("P7a fix r1 (Important-2): an invalid deprecated keychainService is refused as invalid_brand and never reaches the wire", () => {
  // The alias used to be assigned onto the profile AFTER resolveBrand, so it skipped the profile's
  // own grammar entirely and `RuntimeConfig.brand` could carry a value that did not satisfy the
  // invariant `BrandProfile` advertises -- the one assumption every downstream reader makes about it.
  let threw: unknown;
  let spawned = false;
  try {
    query({
      prompt: "ping",
      options: {
        keychainService: "NOT A VALID Service!!! ***",
        spawnClaudeCodeProcess: () => {
          spawned = true;
          return inMemoryProcess([]);
        },
      },
    });
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(InvalidBrandError);
  expect((threw as InvalidBrandError).reason).toContain("keychainService");
  expect(spawned).toBe(false);
});

test("P7a fix r1 (Important-2): an invalid brand.keychainService is refused the same way — one gate, both surfaces", () => {
  expect(() => query({ prompt: "ping", options: { brand: { keychainService: "Com.Acme.Core" }, spawnClaudeCodeProcess: () => inMemoryProcess([]) } })).toThrow(InvalidBrandError);
});

test("P7a: query() cannot be made to mutate WINTER_BRAND through the profile it hands the wire", async () => {
  const capture = captureConfigJson();
  for await (const _msg of query({ prompt: "ping", options: { keychainService: "com.acme.core", spawnClaudeCodeProcess: capture.hook } })) {
    /* drain */
  }
  // The fold assigns into the resolved profile; if resolveBrand returned the frozen singleton this
  // would either throw or corrupt every later session in the process.
  expect(WINTER_BRAND.keychainService).toBe("com.winter.core");
  expect((capture.get()["brand"] as Record<string, unknown>)["keychainService"]).toBe("com.acme.core");
});
