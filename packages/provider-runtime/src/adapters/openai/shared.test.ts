// The family's shared rules, as pure functions.
//
// Everything here is decided BEFORE a request exists, which is exactly why it is testable without a
// server: WS-13 §8.2's rule is that an unmappable effort, an unrepresentable thinking config, an
// over-limit request and an unrepresentable tool are refused before anything reaches the wire. The
// live half — "and the fake recorded zero requests" — is in the conformance package, against a real
// loopback server.

import { describe, expect, test } from "bun:test";
import { createEndpointPolicy } from "../../endpoint-policy.ts";
import {
  EFFORT_LADDER,
  EventQueue,
  assertRepresentableTools,
  assertWithinLimits,
  buildHeaders,
  capabilitiesFrom,
  mapEffortAgainst,
  pumpEvents,
  resolveEndpoint,
  resolveReasoning,
  rowToModel,
  snapNumericEffort,
  toolResultText,
} from "./shared.ts";
import { descriptor, testContext } from "./testing.ts";
import type { ProviderEvent, TurnRequest } from "../../types.ts";

const GENERATED = "https://api.openai.com/v1";
/** The explicit "this model has no catalog evidence" lookup (ruling on finding I3) — these fixtures exercise addressing, not capability. */
const NO_DESCRIPTORS = (): undefined => undefined;

function policyFor(generated: boolean): ReturnType<typeof createEndpointPolicy> extends infer _ ? NonNullable<Extract<ReturnType<typeof createEndpointPolicy>, { ok: true }>["policy"]> : never {
  const built = createEndpointPolicy(generated ? GENERATED : "https://proxy.example.test", { generated });
  if (!built.ok) throw new Error(built.reason);
  return built.policy;
}

function req(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return { model: "o4-mini", messages: [], ...overrides };
}

describe("effort: mapped onto the model's verified vocabulary, or refused", () => {
  test("a named tier the model verifies passes through verbatim", () => {
    expect(mapEffortAgainst("high", descriptor())).toEqual({ ok: true, value: "high" });
  });

  test("a named tier the model does NOT verify is refused, never downgraded", () => {
    // A silent downgrade to the provider's default is precisely what WS-13 §8.2 prohibits.
    const out = mapEffortAgainst("xhigh", descriptor({ efforts: ["low", "medium", "high"] }));
    expect(out.ok).toBe(false);
    expect(out.ok === false ? out.reason : "").toContain("verified vocabulary");
  });

  test("a model with NO reasoning evidence refuses every effort", () => {
    const out = mapEffortAgainst("low", descriptor({ noReasoning: true }));
    expect(out.ok).toBe(false);
  });

  test("a NUMERIC effort snaps to the nearest tier the model verifies", () => {
    // The ladder position is the number's meaning (1=low … 5=max), then the nearest VERIFIED
    // neighbour. On a low/medium/high model, 5 ("max") has to come back as "high".
    const three = descriptor({ efforts: ["low", "medium", "high"] });
    expect(mapEffortAgainst(1, three)).toEqual({ ok: true, value: "low" });
    expect(mapEffortAgainst(3, three)).toEqual({ ok: true, value: "high" });
    expect(mapEffortAgainst(5, three)).toEqual({ ok: true, value: "high" });
    // On a model that verifies only the ends, an EQUIDISTANT number takes the LOWER tier: 3 is
    // ladder position 2, exactly two steps from `low` (0) and from `max` (4), and Winter resolves
    // that tie downward rather than spending more reasoning than the caller can be shown to have
    // asked for. 4 is genuinely closer to `max`.
    expect(snapNumericEffort(3, ["low", "max"])).toBe("low");
    expect(snapNumericEffort(4, ["low", "max"])).toBe("max");
  });

  test("a numeric effort is REFUSED when there is no descriptor to snap against", () => {
    // The allowUnlisted gateway case: a named tier is honoured (the pin defines it and Winter has no
    // evidence to contradict it), but a number needs a vocabulary that does not exist.
    expect(mapEffortAgainst("high", undefined)).toEqual({ ok: true, value: "high" });
    const numeric = mapEffortAgainst(4, undefined);
    expect(numeric.ok).toBe(false);
    expect(numeric.ok === false ? numeric.reason : "").toContain("no catalog descriptor");
  });

  test("the ladder is exactly the pinned five, in order", () => {
    expect([...EFFORT_LADDER]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("thinking: represented, or refused before the request", () => {
  test("a token BUDGET is refused — this family has no budget knob at all", () => {
    expect(() => resolveReasoning(req({ thinking: { type: "enabled", budgetTokens: 8000 } }), descriptor())).toThrow(/budgetTokens/);
  });

  test("`adaptive` with no explicit effort falls back to the model's OWN declared default", () => {
    const plan = resolveReasoning(req({ thinking: { type: "adaptive" } }), descriptor({ defaultEffort: "medium" }));
    expect(plan.effort).toBe("medium");
    expect(plan.wantsEncryptedContent).toBe(true);
  });

  test("`disabled` asks for no reasoning and no encrypted continuation", () => {
    const plan = resolveReasoning(req({ thinking: { type: "disabled" } }), descriptor());
    expect(plan.enabled).toBe(false);
    expect(plan.wantsEncryptedContent).toBe(false);
  });

  test("`disabled` AND an effort is a contradiction, refused rather than silently resolved one way", () => {
    expect(() => resolveReasoning(req({ thinking: { type: "disabled" }, effort: "high" }), descriptor())).toThrow(/contradict/);
  });

  test("a thinking config on a model with no reasoning evidence is refused", () => {
    expect(() => resolveReasoning(req({ thinking: { type: "adaptive" } }), descriptor({ noReasoning: true }))).toThrow(/declares no reasoning capability/);
  });

  test("a summary is requested ONLY where the descriptor says which field and value to use", () => {
    // Guessing a summary value is how a request 400s on a model that has the field but not that member.
    const without = resolveReasoning(req({ effort: "high", requestSummary: true }), descriptor());
    expect(without.summary).toBeUndefined();
    const with_ = resolveReasoning(req({ effort: "high", requestSummary: true }), descriptor({ summaryValues: ["detailed", "concise"] }));
    expect(with_.summary).toBe("detailed");
  });

  test("no effort and no thinking asks for no continuation state at all", () => {
    const plan = resolveReasoning(req(), descriptor());
    expect(plan.wantsEncryptedContent).toBe(false);
    expect(plan.effort).toBeUndefined();
  });
});

describe("limits and tools: refused before the request", () => {
  test("more output tokens than the model declares is refused", () => {
    expect(() => assertWithinLimits(req({ maxOutputTokens: 100_000 }), descriptor({ maxOutputTokens: 32_000 }), [])).toThrow(/declares a maximum of 32000/);
  });

  test("a parameter the model lists as unsupported is refused when the request would send it", () => {
    expect(() => assertWithinLimits(req(), descriptor({ unsupportedParameters: ["reasoning.summary"] }), ["reasoning.summary"])).toThrow(/unsupported parameters/);
  });

  test("no descriptor means no limit claim to check — and no invented one", () => {
    expect(() => assertWithinLimits(req({ maxOutputTokens: 10_000_000 }), undefined, ["reasoning"])).not.toThrow();
  });

  test("a tool with no name or a non-object schema is an ERROR, never a dropped tool", () => {
    expect(() => assertRepresentableTools([{ name: "", description: "d", inputSchema: { type: "object" } }])).toThrow(/dropping the tool silently/);
    expect(() => assertRepresentableTools([{ name: "Read", description: "d", inputSchema: [] as unknown as Record<string, unknown> }])).toThrow(/dropping the tool silently/);
    expect(() => assertRepresentableTools([{ name: "Read", description: "d", inputSchema: { type: "object" } }])).not.toThrow();
  });
});

describe("R6-L: privileged headers reach a GENERATED endpoint and no other", () => {
  test("an organisation identifier rides a generated endpoint", () => {
    const headers = buildHeaders({ policy: policyFor(true), protocol: { "content-type": "application/json" }, privileged: { "OpenAI-Organization": "org-test" } });
    expect(headers["OpenAI-Organization"]).toBe("org-test");
  });

  test("the SAME identifier is dropped for a user endpoint", () => {
    // Sending it would disclose the operator's account topology to a host the reviewed catalog never
    // named — which is the entire reason `applyPrivilegedHeaders` exists.
    const headers = buildHeaders({ policy: policyFor(false), protocol: { "content-type": "application/json" }, privileged: { "OpenAI-Organization": "org-test" } });
    expect(headers["OpenAI-Organization"]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });

  test("a credential-shaped header in the profile is DROPPED — a connection profile is non-secret metadata by contract", () => {
    const headers = buildHeaders({
      policy: policyFor(true),
      protocol: { authorization: "Bearer real" },
      userSupplied: { authorization: "Bearer smuggled", "x-api-key": "smuggled", "HTTP-Referer": "https://example.test" },
    });
    expect(headers.authorization).toBe("Bearer real");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["HTTP-Referer"]).toBe("https://example.test");
  });
});

describe("endpoint selection", () => {
  test("no baseUrl means the ADAPTER's own generated endpoint, and it is treated as generated", () => {
    const endpoint = resolveEndpoint(testContext(), { generatedBaseUrl: GENERATED, descriptors: NO_DESCRIPTORS });
    expect(endpoint.generated).toBe(true);
    expect(endpoint.baseUrl).toBe(GENERATED);
  });

  test("a profile baseUrl is a USER endpoint, whatever it points at", () => {
    const endpoint = resolveEndpoint(testContext({ baseUrl: "https://proxy.example.test/v1" }), { generatedBaseUrl: GENERATED, descriptors: NO_DESCRIPTORS });
    expect(endpoint.generated).toBe(false);
    expect(endpoint.policy.generated).toBe(false);
  });

  test("a plain-http loopback needs the host's own `local: true` declaration", () => {
    expect(() => resolveEndpoint(testContext({ baseUrl: "http://127.0.0.1:11434/v1" }), { descriptors: NO_DESCRIPTORS })).toThrow(/not declared local/);
    const declared = resolveEndpoint(testContext({ baseUrl: "http://127.0.0.1:11434/v1", local: true }), { descriptors: NO_DESCRIPTORS });
    expect(declared.policy.local).toBe(true);
  });

  test("an adapter with no generated default and no baseUrl refuses rather than guessing", () => {
    expect(() => resolveEndpoint(testContext(), { descriptors: NO_DESCRIPTORS })).toThrow(/has no endpoint/);
  });
});

describe("small mappings", () => {
  test("a blocks-valued tool_result flattens to the plain text every OpenAI surface carries", () => {
    expect(
      toolResultText([
        { type: "text", text: "line one" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "text", text: "line two" },
      ]),
    ).toBe("line one\n[image]\nline two");
  });

  test("a `/v1/models` row keeps only what it actually carried", () => {
    expect(rowToModel({ id: "gpt-4.1", context_window: 1000 })).toEqual({ id: "gpt-4.1", contextWindow: 1000 });
    expect(rowToModel({ nope: true })).toEqual({ id: "" });
  });

  test("capabilities derive the continuation domain from the descriptor's own evidence", () => {
    expect(capabilitiesFrom(descriptor({ continuationDomain: ["z/model", "a/model"] }))).toEqual({ toolCalling: "native", continuationDomain: "a/model", readableState: "summary" });
    expect(capabilitiesFrom(descriptor({ noReasoning: true }))).toEqual({ toolCalling: "native", readableState: "none" });
  });
});

describe("the observation pump: a retry is yielded BEFORE the work it precedes finishes", () => {
  test("events queued by a synchronous callback are yielded while the work is still running", async () => {
    const queue = new EventQueue();
    let released!: () => void;
    const work = new Promise<string>((resolve) => {
      released = () => resolve("done");
    });
    const seen: ProviderEvent[] = [];
    const generator = (async function* () {
      return yield* pumpEvents(queue, work);
    })();

    queue.push({ type: "retry", attempt: 1, maxRetries: 10, retryDelayMs: 5, error: "overloaded" });
    const first = await generator.next();
    expect(first.done).toBe(false);
    seen.push(first.value as ProviderEvent);
    // The work has NOT finished, and the observation is already out. A post-hoc flush would have
    // produced this only after `released()`.
    expect(seen.map((e) => e.type)).toEqual(["retry"]);
    released();
    const last = await generator.next();
    expect(last.done).toBe(true);
    expect(last.value).toBe("done");
  });

  test("a rejected work promise still drains what was queued, then throws", async () => {
    const queue = new EventQueue();
    const failure = new Error("boom");
    const generator = (async function* () {
      return yield* pumpEvents(queue, Promise.reject(failure));
    })();
    queue.push({ type: "auth_status", isAuthenticating: true });
    const first = await generator.next();
    expect((first.value as ProviderEvent).type).toBe("auth_status");
    await expect(generator.next()).rejects.toThrow("boom");
  });
});
