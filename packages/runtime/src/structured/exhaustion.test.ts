// Phase 5 Task 7 (Lane K, R5-10): the exhaustion path THROUGH THE ENGINE SEAM, driven by the REAL
// ajv-backed seam rather than the spine's crude fake.
//
// derived-shapes-p5 item (d) warns that this is wrong in a way NO TYPE-CHECKER CATCHES: two
// different spellings live on two different fields of the same message --
// `subtype: "error_max_structured_output_retries"` and
// `terminal_reason: "structured_output_retry_exhausted"` (no `error_` prefix, `retry` singular,
// different word order) -- and `structured_output` is declared on the SUCCESS variant only, so an
// exhausted run carries none at all rather than a null one. Capture (6) confirmed all three on the
// wire. Every one of them is a string literal, so only a fixture can hold them.
import { test, expect, describe } from "bun:test";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider, type ProviderTurn } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { MAX_STRUCTURED_OUTPUT_RETRIES_ENV, STRUCTURED_OUTPUT_TOOL_NAME, type JsonSchema } from "./seam.ts";
import { createStructuredOutputSeam } from "./ajv-seam.ts";

const SCHEMA: JsonSchema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false };

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

/** Answers every round with a StructuredOutput call carrying the next scripted input. */
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

async function run(opts: { inputs: unknown[]; env?: Record<string, string | undefined> }): Promise<SdkMessage[]> {
  const { host, runtime } = createInMemoryChannel();
  const config: RuntimeConfig = { sessionId: "s", cwd: "/tmp/x", model: "sonnet", outputFormat: { type: "json_schema", schema: SCHEMA as Record<string, unknown> } };
  const done = runEngine({
    config,
    input: runtime.input,
    output: runtime.output,
    provider: structuredCaller(opts.inputs),
    tools: stubExecutor,
    structuredOutput: createStructuredOutputSeam(),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  // A raw runEngine fixture MUST write both frames or the run never terminates.
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;
  return dataMessages(frames);
}

function toolResultTexts(messages: SdkMessage[]): string[] {
  return messages
    .filter((m) => m.type === "user")
    .flatMap((m) => ((m as { message: { content: Array<Record<string, unknown>> } }).message.content ?? []))
    .map((b) => (typeof b.content === "string" ? b.content : ""))
    .filter((t) => t.length > 0);
}

describe("structured output -- the exhaustion path on the real ajv seam (R5-10)", () => {
  test("EXHAUSTION carries BOTH pinned spellings, on their own fields, and NO structured_output", async () => {
    const messages = await run({ inputs: [{ answer: "forty-two" }], env: { [MAX_STRUCTURED_OUTPUT_RETRIES_ENV]: "3" } });
    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    const result = results[0] as { subtype: string; is_error?: boolean; result?: string; terminal_reason?: string };
    expect(result.subtype).toBe("error_max_structured_output_retries");
    expect(result.terminal_reason).toBe("structured_output_retry_exhausted");
    expect(result.is_error).toBe(true);
    expect(result.result).toBe("Failed to provide valid structured output after 3 attempts");
    // Declared on the SUCCESS variant only -- absent, never null.
    expect("structured_output" in result).toBe(false);
  });

  test("the budget counts ATTEMPTS: the default is five validation failures, not six", async () => {
    const messages = await run({ inputs: [{ answer: "nope" }] });
    const failures = toolResultTexts(messages).filter((t) => t.startsWith("Structured output validation failed"));
    expect(failures).toHaveLength(5);
    expect((messages.filter((m) => m.type === "result")[0] as { result?: string }).result).toBe("Failed to provide valid structured output after 5 attempts");
  });

  test("every failed attempt hands the model AJV's own error text, not a bare rejection", async () => {
    const messages = await run({ inputs: [{ answer: "nope", extra: 1 }], env: { [MAX_STRUCTURED_OUTPUT_RETRIES_ENV]: "1" } });
    const failure = toolResultTexts(messages).find((t) => t.startsWith("Structured output validation failed"));
    expect(failure).toBeDefined();
    // The JSON-Pointer path and the expected type -- capture (6)'s observed shape, and the thing
    // that makes a retry more likely to succeed than the one before it.
    expect(failure).toContain("/answer: must be number");
    // ALL of the round's failures, not merely the first: the budget is five, and a validator that
    // reveals one error per attempt spends it teaching the model its own schema.
    expect(failure).toContain("additional properties");
  });

  test("a VALID call ends the turn with structured_output and NO terminal_reason", async () => {
    const messages = await run({ inputs: [{ answer: 42 }] });
    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ subtype: "success", is_error: false, structured_output: { answer: 42 } });
    expect((results[0] as { terminal_reason?: string }).terminal_reason).toBeUndefined();
  });

  test("an invalid attempt followed by a valid one succeeds -- the failure is a retry, not a terminal state", async () => {
    const messages = await run({ inputs: [{ answer: "nope" }, { answer: 7 }] });
    const results = messages.filter((m) => m.type === "result");
    expect(results[0]).toMatchObject({ subtype: "success", structured_output: { answer: 7 } });
    expect(toolResultTexts(messages).filter((t) => t.startsWith("Structured output validation failed"))).toHaveLength(1);
  });

  test("the advertised schema IS the caller's schema -- what the model is shown is what it is validated against", async () => {
    const messages = await run({ inputs: [{ answer: 1 }] });
    const init = messages.find((m) => (m as { subtype?: string }).subtype === "init") as { tools: string[] };
    expect(init.tools).toContain(STRUCTURED_OUTPUT_TOOL_NAME);
  });
});
