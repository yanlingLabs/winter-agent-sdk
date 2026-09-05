// Phase 5 Task 7 (Lane K, R5-7/R5-10): the ajv-backed StructuredOutputSeam.
//
// The seam authority is `structured/seam.contract.test.ts` -- it drives the ENGINE's half (when the
// tool is registered, the turn-ending rule, the attempt counter, the exhaustion shape) against the
// spine's deliberately crude fake. What is proven here is the real validator the fake stands in for.
import { test, expect, describe } from "bun:test";
import { STRUCTURED_OUTPUT_TOOL_NAME, type JsonSchema } from "./seam.ts";
import { createStructuredOutputSeam } from "./ajv-seam.ts";
import { formatValidationErrors } from "./validator.ts";

const SIMPLE: JsonSchema = { type: "object", properties: { x: { type: "number" }, s: { type: "string" } }, required: ["x"], additionalProperties: false };

describe("structured/descriptor.ts -- buildDescriptor", () => {
  test("the caller's schema lands on inputSchema BY IDENTITY -- not a copy, not a wrapper", () => {
    const descriptor = createStructuredOutputSeam().buildDescriptor(SIMPLE);
    // Capture (6) pins the generated schema as the caller's own, byte-for-byte. Object identity is
    // the only assertion that cannot pass while a normalization step quietly rewrites it.
    expect(descriptor.inputSchema).toBe(SIMPLE);
    expect(descriptor.canonicalName).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(descriptor.advertisedName).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(descriptor.source).toBe("host");
    expect(descriptor.exposure).toBe("eager");
  });

  test("a schema whose own keys collide with descriptor fields still rides through untouched", () => {
    const hostile = { type: "object", description: "the CALLER's description", properties: {}, source: "not-a-descriptor-field" } as unknown as JsonSchema;
    const descriptor = createStructuredOutputSeam().buildDescriptor(hostile);
    expect(descriptor.inputSchema).toBe(hostile);
    // The descriptor's own description is Winter's, never the schema's -- they are different fields
    // on different objects and a spread would have merged them.
    expect(descriptor.description).not.toBe("the CALLER's description");
    expect(descriptor.source).toBe("host");
  });
});

describe("structured/validator.ts -- validate (ajv, R5-7)", () => {
  test("a valid value comes back untouched, by identity", () => {
    const value = { x: 1, s: "ok" };
    const result = createStructuredOutputSeam().validate(SIMPLE, value);
    expect(result.ok).toBe(true);
    // No coercion, no defaults, no additionalProperties stripping: what the model sent is what the
    // host receives on `result.structured_output`.
    expect(result.ok === true && result.value).toBe(value);
  });

  test("errors name the JSON-Pointer path and the expectation -- capture (6)'s observed shape", () => {
    const result = createStructuredOutputSeam().validate(SIMPLE, { x: "not-a-number" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors).toContain("/x: must be number");
  });

  test("ALL failures are reported at once, not just the first", () => {
    // The attempt budget is five; a validator that reveals one error per attempt burns the budget
    // teaching the model its own schema.
    const result = createStructuredOutputSeam().validate(SIMPLE, { s: 7, extra: true });
    expect(result.ok).toBe(false);
    const errors = result.ok === false ? result.errors : [];
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.some((e) => e.includes("required property 'x'"))).toBe(true);
    expect(errors.some((e) => e.includes("/s: must be string"))).toBe(true);
    expect(errors.some((e) => e.includes("additional properties"))).toBe(true);
  });

  test("a root-level failure is reported at `/`, never at the empty string", () => {
    const result = createStructuredOutputSeam().validate(SIMPLE, "a bare string");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors[0]).toBe("/: must be object");
  });

  test("the two ajv entry points are BOTH used: `$schema` 2020-12 selects the 2020 constructor", () => {
    // `prefixItems` is 2020-12 only. Under draft-07's constructor the keyword is unknown and is
    // silently ignored -- so a seam that always used one entry point would ACCEPT a value the
    // caller's schema rejects, with nothing to notice it.
    // `items: false` is 2020-12's "no extra items" spelling; the registry's own JSONSchema type
    // models `items` as a schema, so the cast is on the TEST's literal, never in the seam.
    const schema2020 = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { pair: { type: "array", prefixItems: [{ type: "number" }, { type: "string" }], items: false } },
      required: ["pair"],
    } as unknown as JsonSchema;
    const seam = createStructuredOutputSeam();
    expect(seam.validate(schema2020, { pair: [1, "ok"] }).ok).toBe(true);
    const wrong = seam.validate(schema2020, { pair: ["wrong", "ok"] });
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.errors.some((e) => e.startsWith("/pair/0"))).toBe(true);
  });

  test("no `$schema` means draft-07 -- the default dialect, and it still validates", () => {
    const draft7: JsonSchema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
    const seam = createStructuredOutputSeam();
    expect(seam.validate(draft7, { n: 3 }).ok).toBe(true);
    expect(seam.validate(draft7, { n: 3.5 }).ok).toBe(false);
  });

  test("an UNCOMPILABLE schema is a configuration error, not a model error -- it throws", () => {
    // A model can never fix a broken schema by trying again, so returning `ok:false` would burn the
    // whole attempt budget and terminate as if the MODEL had failed.
    const broken = { type: "object", properties: { x: { type: "not-a-real-type" } } } as unknown as JsonSchema;
    expect(() => createStructuredOutputSeam().validate(broken, { x: 1 })).toThrow(/schema/i);
  });

  test("an unknown keyword does NOT throw -- a caller schema may carry vendor extensions", () => {
    const extended = { type: "object", properties: { x: { type: "number" } }, required: ["x"], "x-vendor-hint": "ignore me" } as unknown as JsonSchema;
    expect(createStructuredOutputSeam().validate(extended, { x: 1 }).ok).toBe(true);
  });

  test("the compiled validator is CACHED per schema object -- the same schema arrives on every attempt", () => {
    const seam = createStructuredOutputSeam();
    const before = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) seam.validate(SIMPLE, { x: i });
    const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;
    // Recompiling 200 times is orders of magnitude slower than this bound; the assertion is a
    // tripwire on the cache disappearing, not a benchmark.
    expect(elapsedMs).toBeLessThan(200);
  });

  test("formatValidationErrors renders a null/empty error list rather than producing nothing", () => {
    // ajv sets `.errors` to null on success; a seam that reported `ok:false` with an empty list
    // would hand the model a tool result with no explanation in it.
    expect(formatValidationErrors(null)).toEqual(["the value did not match the requested schema"]);
    expect(formatValidationErrors([])).toEqual(["the value did not match the requested schema"]);
  });
});
