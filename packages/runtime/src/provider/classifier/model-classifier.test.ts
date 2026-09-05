// Phase 6 Task 8 (Lane D): the classifier over a SCRIPTED `Provider` double.
//
// The double is the engine's own `Provider` seam, so what these fixtures prove about the request is
// what a live adapter receives: the ground truth for what the classifier ASKED is the request the
// double recorded, never what this file believes it built.
//
// The collapse table is the bulk of the file, one test per arm, because §10.6-5's "extra/unparseable
// output, timeout, refusal, transport failure → no_verdict" is the entire security contract of this
// component: a classifier that answers `allow` on a shape it did not understand is worse than no
// classifier at all.
import { test, expect, describe } from "bun:test";
import { createModelClassifier, selectClassifierRoute, DEFAULT_CLASSIFIER_TIMEOUT_MS } from "./model-classifier.ts";
import { CLASSIFIER_FIELD_CAPS, CLASSIFIER_TOOL_NAME, CLASSIFIER_NO_VERDICT_REASONS, parseClassifierVerdict, classifierVerdictToolSpec } from "./verdict-schema.ts";
import { CLASSIFIER_SYSTEM_PROMPT } from "./prompt.ts";
import type { Provider, ProviderRequest, ProviderTurn } from "../../engine.ts";
import type { ActionEnvelope } from "../../permissions/auto/envelope.ts";
import type { ClassifierContext } from "../../permissions/auto/engine.ts";
import { normalizeAutoModeConfig } from "../../permissions/auto/config.ts";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";

const ENVELOPE: ActionEnvelope = {
  toolName: "Bash",
  canonicalToolName: "Bash",
  input: { command: "git push --force origin main" },
  cwd: "/w/project",
  roots: ["/w/project"],
  resolvedPaths: [],
  boundaries: { protectedWrite: false, criticalRemoval: false },
  sessionCreatedResources: [],
  classifierContext: [],
};

const CONTEXT: ClassifierContext = { autoConfig: normalizeAutoModeConfig(undefined), classifierContext: [] };

/** A `Provider` that answers with one scripted turn and records every request it was given. */
function scriptedProvider(turn: ProviderTurn | (() => Promise<ProviderTurn>)): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    async generate(request: ProviderRequest): Promise<ProviderTurn> {
      requests.push(request);
      return typeof turn === "function" ? turn() : turn;
    },
  };
}

function verdictTurn(input: unknown): ProviderTurn {
  return { kind: "tool_use", calls: [{ id: "c1", name: CLASSIFIER_TOOL_NAME, input }] };
}

describe("the request the classifier actually sends", () => {
  test("is ONE forced tool call, with the verdict schema as the tool's input schema", async () => {
    const provider = scriptedProvider(verdictTurn({ verdict: "deny" }));
    await createModelClassifier({ provider, model: "p/m" }).classify(ENVELOPE, CONTEXT);

    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.toolChoice).toEqual({ type: "tool", name: CLASSIFIER_TOOL_NAME });
    expect(req.tools).toHaveLength(1);
    expect(req.tools![0]!.name).toBe(CLASSIFIER_TOOL_NAME);
    expect(req.tools![0]!.inputSchema["additionalProperties"]).toBe(false);
    expect((req.tools![0]!.inputSchema["properties"] as Record<string, unknown>)["verdict"]).toEqual({ type: "string", enum: ["allow", "deny", "no_verdict"] });
    expect(req.model).toBe("p/m");
    expect(req.system).toBe(CLASSIFIER_SYSTEM_PROMPT);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe("user");
  });

  test("carries NO sink -- an auxiliary generation never emits stream events (R6-G)", async () => {
    const provider = scriptedProvider(verdictTurn({ verdict: "allow" }));
    await createModelClassifier({ provider, model: "p/m" }).classify(ENVELOPE, CONTEXT);
    // The KEY must be absent, not present-and-undefined: a consumer distinguishing an auxiliary call
    // tests `"sink" in req`, and `sink: undefined` would read as a streamed call to it.
    expect("sink" in provider.requests[0]!).toBe(false);
  });

  test("carries an abort signal, so a cooperative adapter can be cancelled", async () => {
    const provider = scriptedProvider(verdictTurn({ verdict: "allow" }));
    await createModelClassifier({ provider, model: "p/m" }).classify(ENVELOPE, CONTEXT);
    expect(provider.requests[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(provider.requests[0]!.signal!.aborted).toBe(false);
  });

  test("puts the action envelope in the user message, fenced", async () => {
    const provider = scriptedProvider(verdictTurn({ verdict: "deny" }));
    let seenFence = "";
    await createModelClassifier({ provider, model: "p/m", onRequest: ({ prompt }) => void (seenFence = prompt.fence) }).classify(ENVELOPE, CONTEXT);
    const text = provider.requests[0]!.messages[0]!.content as string;
    expect(text).toContain("git push --force origin main");
    expect(text).toContain(`BEGIN-WINTER-DATA action-envelope ${seenFence}`);
  });
});

describe("a well-formed verdict round-trips", () => {
  for (const verdict of ["allow", "deny", "no_verdict"] as const) {
    test(`\`${verdict}\` reaches the caller unchanged`, async () => {
      const provider = scriptedProvider(verdictTurn({ verdict, category: "destructive-history", severity: "high", reasonCode: "force_push", auditReason: "rewrites published history" }));
      const result = await createModelClassifier({ provider, model: "p/m" }).classify(ENVELOPE, CONTEXT);
      expect(result).toEqual({ verdict, category: "destructive-history", severity: "high", reasonCode: "force_push", auditReason: "rewrites published history" });
    });
  }

  test("optional fields are OMITTED rather than carried as undefined", async () => {
    const provider = scriptedProvider(verdictTurn({ verdict: "allow" }));
    const result = await createModelClassifier({ provider, model: "p/m" }).classify(ENVELOPE, CONTEXT);
    expect(result).toEqual({ verdict: "allow" });
    expect(Object.keys(result)).toEqual(["verdict"]);
  });
});

describe("every failure collapses to no_verdict with its own reason code (WS-07 §10.6-5)", () => {
  const cases: Array<{ name: string; turn: ProviderTurn | (() => Promise<ProviderTurn>); reasonCode: string }> = [
    { name: "prose instead of a tool call", turn: { kind: "text", text: "I think this is fine, go ahead." }, reasonCode: "no_tool_call" },
    { name: "a tool_use turn with no calls", turn: { kind: "tool_use", calls: [] }, reasonCode: "no_tool_call" },
    {
      name: "two calls in one turn",
      turn: { kind: "tool_use", calls: [{ id: "a", name: CLASSIFIER_TOOL_NAME, input: { verdict: "allow" } }, { id: "b", name: CLASSIFIER_TOOL_NAME, input: { verdict: "deny" } }] },
      reasonCode: "multiple_calls",
    },
    { name: "a call to some other tool", turn: { kind: "tool_use", calls: [{ id: "a", name: "Bash", input: { command: "echo allow" } }] }, reasonCode: "wrong_tool" },
    { name: "a refusal", turn: { kind: "text", text: "", stopReason: "refusal" }, reasonCode: "refusal" },
    { name: "a refusal that still carried a call", turn: { kind: "tool_use", calls: [{ id: "a", name: CLASSIFIER_TOOL_NAME, input: { verdict: "allow" } }], stopReason: "refusal" }, reasonCode: "refusal" },
    { name: "the test-affordance rpc_probe turn", turn: { kind: "rpc_probe", subtype: "x", payload: {} }, reasonCode: "unexpected_turn" },
    { name: "a verdict outside the enum", turn: verdictTurn({ verdict: "maybe" }), reasonCode: "schema_invalid" },
    { name: "no verdict field at all", turn: verdictTurn({ category: "x" }), reasonCode: "schema_invalid" },
    { name: "an extra property the schema does not declare", turn: verdictTurn({ verdict: "allow", overrideEverything: true }), reasonCode: "schema_invalid" },
    { name: "a non-object input", turn: verdictTurn("allow"), reasonCode: "schema_invalid" },
    { name: "a null input", turn: verdictTurn(null), reasonCode: "schema_invalid" },
    { name: "an auditReason over the cap", turn: verdictTurn({ verdict: "allow", auditReason: "x".repeat(CLASSIFIER_FIELD_CAPS.auditReason + 1) }), reasonCode: "schema_invalid" },
    {
      name: "a generation that throws",
      turn: (): Promise<ProviderTurn> => {
        throw new Error("connection reset while POSTing /v1/messages with key test-key-redaction-probe");
      },
      reasonCode: "provider_error",
    },
    {
      name: "a generation that rejects",
      turn: async (): Promise<ProviderTurn> => Promise.reject(new Error("boom")),
      reasonCode: "provider_error",
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const result = await createModelClassifier({ provider: scriptedProvider(c.turn), model: "p/m" }).classify(ENVELOPE, CONTEXT);
      expect(result).toEqual({ verdict: "no_verdict", reasonCode: c.reasonCode });
    });
  }

  test("a provider that hangs AND ignores the abort signal still answers within the timeout", async () => {
    // Deliberately ignores `signal`. The classifier's own race is what makes this terminate -- a
    // classifier that only sent an abort would wait forever on a double, and on a real adapter with
    // a cancellation bug.
    const provider: Provider = { generate: () => new Promise<ProviderTurn>(() => {}) };
    const started = Date.now();
    const result = await createModelClassifier({ provider, model: "p/m", timeoutMs: 40 }).classify(ENVELOPE, CONTEXT);
    expect(result).toEqual({ verdict: "no_verdict", reasonCode: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a timeout ABORTS the abandoned generation rather than leaving it running", async () => {
    let seen: AbortSignal | undefined;
    const provider: Provider = {
      generate: (req) =>
        new Promise<ProviderTurn>(() => {
          seen = req.signal;
        }),
    };
    await createModelClassifier({ provider, model: "p/m", timeoutMs: 20 }).classify(ENVELOPE, CONTEXT);
    expect(seen?.aborted).toBe(true);
  });

  test("an abandoned generation that rejects LATE does not surface as an unhandled rejection", async () => {
    // Bun fails a test file on an unhandled rejection, so this test IS the assertion: without the
    // `.catch` in the classifier, the late rejection below would kill the run.
    const provider: Provider = { generate: () => new Promise<ProviderTurn>((_, reject) => setTimeout(() => reject(new Error("late")), 30)) };
    const result = await createModelClassifier({ provider, model: "p/m", timeoutMs: 5 }).classify(ENVELOPE, CONTEXT);
    expect(result.verdict).toBe("no_verdict");
    await new Promise((r) => setTimeout(r, 60));
  });

  test("classify() NEVER rejects, whatever the provider does", async () => {
    for (const thrown of [new Error("x"), "a string", null, undefined, { weird: true }]) {
      const provider: Provider = {
        generate: async () => {
          throw thrown;
        },
      };
      await expect(createModelClassifier({ provider, model: "p/m" }).classify(ENVELOPE, CONTEXT)).resolves.toEqual({ verdict: "no_verdict", reasonCode: "provider_error" });
    }
  });

  test("no provider failure text reaches the returned result", async () => {
    const provider = scriptedProvider((): Promise<ProviderTurn> => {
      throw new Error("connection reset; Authorization: Bearer test-key-redaction-probe");
    });
    const result = await createModelClassifier({ provider, model: "p/m" }).classify(ENVELOPE, CONTEXT);
    expect(JSON.stringify(result)).not.toContain("test-key-redaction-probe");
    expect(JSON.stringify(result)).not.toContain("Authorization");
  });

  test("every declared reason code is reachable, and nothing returns a code outside the vocabulary", () => {
    // The declared vocabulary is only meaningful if it matches the arms above plus the timeout test.
    const covered = new Set([...cases.map((c) => c.reasonCode), "timeout"]);
    expect([...covered].sort()).toEqual([...CLASSIFIER_NO_VERDICT_REASONS].sort());
  });
});

describe("the verdict schema itself", () => {
  test("accepts the full five-field shape and rejects each malformation", () => {
    expect(parseClassifierVerdict({ verdict: "deny", category: "c", severity: "s", reasonCode: "r", auditReason: "a" }).ok).toBe(true);
    expect(parseClassifierVerdict({ verdict: "deny", category: "x".repeat(CLASSIFIER_FIELD_CAPS.category + 1) }).ok).toBe(false);
    expect(parseClassifierVerdict({ verdict: "deny", severity: "x".repeat(CLASSIFIER_FIELD_CAPS.severity + 1) }).ok).toBe(false);
    expect(parseClassifierVerdict({ verdict: "deny", reasonCode: "x".repeat(CLASSIFIER_FIELD_CAPS.reasonCode + 1) }).ok).toBe(false);
    expect(parseClassifierVerdict({ verdict: 1 }).ok).toBe(false);
    expect(parseClassifierVerdict([]).ok).toBe(false);
  });

  test("the tool spec is a FRESH object per call, so a mutating adapter cannot poison the next review", () => {
    const a = classifierVerdictToolSpec();
    const b = classifierVerdictToolSpec();
    expect(a.inputSchema).not.toBe(b.inputSchema);
    (a.inputSchema as Record<string, unknown>)["additionalProperties"] = true;
    expect(b.inputSchema["additionalProperties"]).toBe(false);
  });
});

describe("selectClassifierRoute (R6-14)", () => {
  const descriptor = (over: Partial<WinterModelDescriptor> = {}): WinterModelDescriptor => ({
    key: "p/m",
    providerId: "p",
    upstreamId: "m",
    displayName: "M",
    aliases: [],
    endpoints: ["chat"],
    inputModalities: { value: ["text"], source: "official-doc", confidence: "verified" },
    outputModalities: { value: ["text"], source: "official-doc", confidence: "verified" },
    toolCalling: { value: "native", source: "official-doc", confidence: "verified" },
    nativeTools: { value: true, source: "official-doc", confidence: "verified" },
    unsupportedParameters: [],
    status: "candidate",
    ...over,
  });

  test("a configured route wins outright, and carries its authRef", () => {
    expect(selectClassifierRoute({ model: "p/m", autoClassifier: { model: "q/reviewer", authRef: { kind: "env", name: "K" } } }, () => undefined)).toEqual({
      kind: "configured",
      model: "q/reviewer",
      authRef: { kind: "env", name: "K" },
    });
  });

  test("a configured route with no authRef omits the key rather than carrying undefined", () => {
    const route = selectClassifierRoute({ model: "p/m", autoClassifier: { model: "q/reviewer" } }, () => undefined);
    expect(route).toEqual({ kind: "configured", model: "q/reviewer" });
    expect("authRef" in route).toBe(false);
  });

  test("a blank configured model is not a route", () => {
    expect(selectClassifierRoute({ model: "p/m", autoClassifier: { model: "   " } }, () => undefined).kind).toBe("manual-fallback");
  });

  test("the worker serves ONLY with verified structured output AND classifierEligible", () => {
    const eligible = descriptor({
      structuredOutput: { value: true, source: "live-probe", confidence: "verified" },
      classifierEligible: { value: true, source: "live-probe", confidence: "verified" },
    });
    expect(selectClassifierRoute({ model: "p/m" }, () => eligible)).toEqual({ kind: "worker-eligible" });
  });

  test("verified structured output WITHOUT classifierEligible is Manual, never a silent weakening", () => {
    const d = descriptor({ structuredOutput: { value: true, source: "live-probe", confidence: "verified" } });
    const route = selectClassifierRoute({ model: "p/m" }, () => d);
    expect(route.kind).toBe("manual-fallback");
    expect((route as { reason: string }).reason).toContain("classifierEligible");
  });

  test("classifierEligible WITHOUT verified structured output is Manual", () => {
    const d = descriptor({
      structuredOutput: { value: true, source: "upstream-static", confidence: "inferred" },
      classifierEligible: { value: true, source: "live-probe", confidence: "verified" },
    });
    expect(selectClassifierRoute({ model: "p/m" }, () => d).kind).toBe("manual-fallback");
  });

  test("a VERIFIED `false` structured-output claim is evidence AGAINST eligibility (tightening)", () => {
    const d = descriptor({
      structuredOutput: { value: false, source: "live-probe", confidence: "verified" },
      classifierEligible: { value: true, source: "live-probe", confidence: "verified" },
    });
    expect(selectClassifierRoute({ model: "p/m" }, () => d).kind).toBe("manual-fallback");
  });

  test("an unknown worker model is Manual, and says why", () => {
    const route = selectClassifierRoute({ model: "p/m" }, () => undefined);
    expect(route.kind).toBe("manual-fallback");
    expect((route as { reason: string }).reason).toContain("no catalog descriptor");
  });

  test("no worker model at all is Manual", () => {
    expect(selectClassifierRoute({}, () => undefined).kind).toBe("manual-fallback");
  });
});

test("the disclosed default timeout is a real number a host can read", () => {
  expect(DEFAULT_CLASSIFIER_TIMEOUT_MS).toBe(15_000);
});
