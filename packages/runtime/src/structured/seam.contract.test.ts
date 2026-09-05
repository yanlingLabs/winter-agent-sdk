// Phase 5 Task 3 (R5-2): the SEAM AUTHORITY for `structured/seam.ts`. Lane K keeps this green
// against its real ajv-backed seam; the engine keeps it green against registration, the turn-ending
// rule, the attempt counter and the exhaustion shape.
import { test, expect, describe } from "bun:test";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider, type ProviderTurn } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { getRegisteredTool, registerHostGeneratedTool, registerTool, unregisterToolForTest, type ToolDescriptor } from "../tools/registry.ts";
import {
  DEFAULT_MAX_STRUCTURED_OUTPUT_ATTEMPTS,
  HOST_GENERATABLE_TOOL_NAMES,
  MAX_STRUCTURED_OUTPUT_RETRIES_ENV,
  STRUCTURED_OUTPUT_TOOL_NAME,
  fakeStructuredOutputSeam,
  resolveMaxStructuredOutputAttempts,
  type JsonSchema,
} from "./seam.ts";

const SCHEMA: JsonSchema = { type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false };

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ sessionId: "s", cwd: "/tmp/x", model: "sonnet", ...overrides });

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

/** Emits a StructuredOutput call with the given input on every turn, forever. */
function structuredCaller(inputs: unknown[]): Provider {
  let i = 0;
  return {
    async generate(): Promise<ProviderTurn> {
      const input = inputs[Math.min(i, inputs.length - 1)];
      i++;
      return { kind: "tool_use", calls: [{ id: `so-${i}`, name: STRUCTURED_OUTPUT_TOOL_NAME, input }] };
    },
  };
}

async function runStructured(opts: { inputs: unknown[]; env?: Record<string, string | undefined>; withSeam?: boolean; advertised?: string[] }): Promise<SdkMessage[]> {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: baseConfig({ outputFormat: { type: "json_schema", schema: SCHEMA as Record<string, unknown> } }),
    input: runtime.input,
    output: runtime.output,
    provider: structuredCaller(opts.inputs),
    tools: stubExecutor,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.withSeam === false ? {} : { structuredOutput: fakeStructuredOutputSeam() }),
  });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;
  if (opts.advertised !== undefined) opts.advertised.push(...((dataMessages(frames).find((m) => (m as { subtype?: string }).subtype === "init") as { tools?: string[] } | undefined)?.tools ?? []));
  return dataMessages(frames);
}

describe("structured/seam.ts -- StructuredOutputSeam (Lane K implements over ajv)", () => {
  test("the attempt budget is 5 ATTEMPTS by default, and MAX_STRUCTURED_OUTPUT_RETRIES overrides it", () => {
    expect(DEFAULT_MAX_STRUCTURED_OUTPUT_ATTEMPTS).toBe(5);
    expect(resolveMaxStructuredOutputAttempts({})).toBe(5);
    expect(resolveMaxStructuredOutputAttempts({ [MAX_STRUCTURED_OUTPUT_RETRIES_ENV]: "2" })).toBe(2);
    // Junk and non-positive values leave the default standing rather than producing an unsatisfiable budget.
    expect(resolveMaxStructuredOutputAttempts({ [MAX_STRUCTURED_OUTPUT_RETRIES_ENV]: "nope" })).toBe(5);
    expect(resolveMaxStructuredOutputAttempts({ [MAX_STRUCTURED_OUTPUT_RETRIES_ENV]: "0" })).toBe(5);
  });

  test("buildDescriptor puts the caller's schema on inputSchema VERBATIM -- the same object, not a copy or a wrapper", () => {
    const descriptor = fakeStructuredOutputSeam().buildDescriptor(SCHEMA);
    expect(descriptor.canonicalName).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(descriptor.inputSchema).toBe(SCHEMA); // identity: capture (6) pins byte-for-byte
    expect(descriptor.source).toBe("host");
  });

  // --- registerHostGeneratedTool ---------------------------------------------------------------------

  test("registerHostGeneratedTool is idempotent within a run and returns an IDENTITY-CHECKED disposer", () => {
    const before = getRegisteredTool(STRUCTURED_OUTPUT_TOOL_NAME);
    const make = (): ToolDescriptor => fakeStructuredOutputSeam().buildDescriptor(SCHEMA);
    const disposeA = registerHostGeneratedTool({ descriptor: make() });
    expect(getRegisteredTool(STRUCTURED_OUTPUT_TOOL_NAME)?.descriptor.inputSchema).toBe(SCHEMA);
    // A second run re-registers under the same name; the FIRST run's disposer must then be a no-op,
    // or one in-memory run's teardown would unregister a concurrent run's live tool.
    const disposeB = registerHostGeneratedTool({ descriptor: make() });
    disposeA();
    expect(getRegisteredTool(STRUCTURED_OUTPUT_TOOL_NAME)?.descriptor.inputSchema).toBe(SCHEMA);
    disposeB();
    expect(getRegisteredTool(STRUCTURED_OUTPUT_TOOL_NAME)).toEqual(before!);
  });

  // Fix round 1 (M1). EIGHT registered WS-06 descriptors carry `source: "host"` -- Artifact,
  // ClaudeDesign, Projects, RemoteTrigger, SendUserFile, ShareOnboardingGuide,
  // ShowOnboardingRolePicker and StructuredOutput -- so a `source === "host"` guard excluded nothing:
  // registering under "Artifact" replaced the real descriptor and the disposer then DELETED it from
  // the process-wide registry for the rest of the process.
  test("M1: a name outside the host-generatable set is REFUSED, even though its descriptor is itself source:'host'", () => {
    const before = getRegisteredTool("Artifact");
    expect(before, "fixture assumption: Artifact is a registered WS-06 descriptor").toBeDefined();
    expect(before!.descriptor.source, "and it is source:'host', which is exactly why the old guard missed it").toBe("host");

    expect(() =>
      registerHostGeneratedTool({ descriptor: { ...fakeStructuredOutputSeam().buildDescriptor(SCHEMA), canonicalName: "Artifact", advertisedName: "Artifact" } }),
    ).toThrow(/not a host-generatable name/);

    // Byte-identical afterwards: same object, untouched description and schema.
    expect(getRegisteredTool("Artifact")).toBe(before!);
  });

  test("M1: the host-generatable set is exactly the names WS-06 declares as generated-per-session", () => {
    expect([...HOST_GENERATABLE_TOOL_NAMES]).toEqual([STRUCTURED_OUTPUT_TOOL_NAME]);
    for (const name of HOST_GENERATABLE_TOOL_NAMES) {
      expect(getRegisteredTool(name), `${name} must have a WS-06 stub to shadow`).toBeDefined();
    }
  });

  test("M1: disposing a host-generated registration RESTORES the WS-06 stub it shadowed -- the registry is byte-identical", () => {
    const stub = getRegisteredTool(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(stub).toBeDefined();
    const dispose = registerHostGeneratedTool({ descriptor: fakeStructuredOutputSeam().buildDescriptor(SCHEMA) });
    expect(getRegisteredTool(STRUCTURED_OUTPUT_TOOL_NAME)).not.toBe(stub!);
    dispose();
    expect(getRegisteredTool(STRUCTURED_OUTPUT_TOOL_NAME)).toBe(stub!);
  });

  test("M1: a registration claiming a name nothing holds is deleted on dispose, not resurrected as undefined", () => {
    // Guards the other direction of the restore: `undefined` must mean "delete", never "set undefined".
    const name = STRUCTURED_OUTPUT_TOOL_NAME;
    const stub = getRegisteredTool(name)!;
    unregisterToolForTest(name);
    try {
      const dispose = registerHostGeneratedTool({ descriptor: fakeStructuredOutputSeam().buildDescriptor(SCHEMA) });
      expect(getRegisteredTool(name)).toBeDefined();
      dispose();
      expect(getRegisteredTool(name)).toBeUndefined();
    } finally {
      registerTool(stub); // put the WS-06 stub back for every later test in this process
    }
  });

  // --- The engine's half -----------------------------------------------------------------------------

  test("StructuredOutput is advertised ONLY when outputFormat is set (capture (4): not in the default 24)", async () => {
    const withFormat: string[] = [];
    await runStructured({ inputs: [{ x: 1 }], advertised: withFormat });
    expect(withFormat).toContain(STRUCTURED_OUTPUT_TOOL_NAME);

    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: { async generate() { return { kind: "text", text: "hi" }; } }, tools: stubExecutor });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    const init = dataMessages(frames).find((m) => (m as { subtype?: string }).subtype === "init") as { tools: string[] };
    expect(init.tools).not.toContain(STRUCTURED_OUTPUT_TOOL_NAME);
    // ...and the run's own registration was withdrawn, leaving the WS-06 stub exactly as it found it.
    // This previously asserted `toBeUndefined()`, which was OBSERVING M1: the disposer had deleted the
    // P3 stub from the process-wide registry along with the per-run descriptor.
    const afterRun = getRegisteredTool(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(afterRun).toBeDefined();
    expect(afterRun!.descriptor.inputSchema).not.toBe(SCHEMA);
  });

  test("a VALID call ends the turn with result.structured_output", async () => {
    const messages = await runStructured({ inputs: [{ x: 42 }] });
    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ subtype: "success", is_error: false, structured_output: { x: 42 } });
    // `terminal_reason` belongs to the exhaustion path only.
    expect((results[0] as { terminal_reason?: string }).terminal_reason).toBeUndefined();
  });

  test("an INVALID call returns a validation-error tool result and lets the model retry", async () => {
    const messages = await runStructured({ inputs: [{ x: "not-a-number" }, { x: 7 }] });
    const toolResults = messages.filter((m) => m.type === "user").flatMap((m) => ((m as { message: { content: Array<Record<string, unknown>> } }).message.content ?? []));
    expect(toolResults.some((b) => typeof b.content === "string" && b.content.includes("must be number"))).toBe(true);
    const results = messages.filter((m) => m.type === "result");
    expect(results[0]).toMatchObject({ subtype: "success", structured_output: { x: 7 } });
  });

  test("EXHAUSTION carries BOTH pinned spellings, on their own fields, and NO structured_output", async () => {
    const messages = await runStructured({ inputs: [{ x: "bad" }], env: { [MAX_STRUCTURED_OUTPUT_RETRIES_ENV]: "3" } });
    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    const result = results[0] as { subtype: string; is_error?: boolean; result?: string; terminal_reason?: string; structured_output?: unknown };
    expect(result.subtype).toBe("error_max_structured_output_retries");
    expect(result.terminal_reason).toBe("structured_output_retry_exhausted");
    expect(result.is_error).toBe(true);
    expect(result.result).toBe("Failed to provide valid structured output after 3 attempts");
    expect("structured_output" in result).toBe(false);
  });

  test("the counter counts ATTEMPTS: MAX_STRUCTURED_OUTPUT_RETRIES=2 produces exactly two validation failures", async () => {
    const messages = await runStructured({ inputs: [{ x: "bad" }], env: { [MAX_STRUCTURED_OUTPUT_RETRIES_ENV]: "2" } });
    const failures = messages
      .filter((m) => m.type === "user")
      .flatMap((m) => ((m as { message: { content: Array<Record<string, unknown>> } }).message.content ?? []))
      .filter((b) => typeof b.content === "string" && b.content.startsWith("Structured output validation failed"));
    expect(failures).toHaveLength(2);
  });

  test("outputFormat with NO seam fails loudly on the first round, before any tokens are spent", async () => {
    const messages = await runStructured({ inputs: [{ x: 1 }], withSeam: false });
    const results = messages.filter((m) => m.type === "result");
    expect(results[0]).toMatchObject({ subtype: "error_during_execution", is_error: true });
    expect((results[0] as { result?: string }).result).toContain("no structured-output seam");
  });

  test("a StructuredOutput call that ends the turn still pairs every tool_use in its round with a tool_result", async () => {
    const { host, runtime } = createInMemoryChannel();
    const provider: Provider = {
      async generate(): Promise<ProviderTurn> {
        return {
          kind: "tool_use",
          calls: [
            { id: "so-1", name: STRUCTURED_OUTPUT_TOOL_NAME, input: { x: 1 } },
            { id: "other-1", name: "test_tool", input: {} },
          ],
        };
      },
    };
    const done = runEngine({
      config: baseConfig({ outputFormat: { type: "json_schema", schema: SCHEMA as Record<string, unknown> } }),
      input: runtime.input,
      output: runtime.output,
      provider,
      tools: stubExecutor,
      structuredOutput: fakeStructuredOutputSeam(),
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    const blocks = dataMessages(frames)
      .filter((m) => m.type === "user")
      .flatMap((m) => ((m as { message: { content: Array<Record<string, unknown>> } }).message.content ?? []));
    expect(blocks.map((b) => b.tool_use_id).sort()).toEqual(["other-1", "so-1"]);
  });
});
