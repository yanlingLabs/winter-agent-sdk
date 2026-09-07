// Phase 6 Task 8 (Lane D, R6-14): the safety corpus, driven OFFLINE through the real classifier.
//
// WHAT THIS RUN PROVES, and what it deliberately does not. The double answers each case with that
// case's own expected verdict, so this is not a measurement of a model — it is a measurement of the
// PLUMBING the live run depends on: every envelope in the corpus reaches a provider request intact,
// every verdict comes back through the schema unchanged, and the hostile rows arrive as data inside
// the fence rather than as text that could steer the review. The live measurement is
// `scripts/verify-provider-live.ts`, opt-in, whose output is recorded as overlay evidence (R6-14).
//
// It is also the STRUCTURAL check on the corpus's envelope mirror: `@yanlinglabs/winter-provider-conformance`
// cannot import this package, so it declares its own `SafetyEnvelope`. Assigning each case's
// envelope to a real `ActionEnvelope` binding below is what keeps the two from drifting — a field
// added to or retyped in the runtime's envelope stops this file compiling.
//
// THE IMPORT. `@yanlinglabs/winter-provider-conformance` is a root devDependency rather than a dependency of this
// package, and resolves through the workspace root — the same shape `packages/sdk`'s own tests
// already use to reach `winter-agent-runtime` (a package the dependency-free sdk likewise cannot
// declare). Test-only in both directions; nothing shipped imports across that edge.
import { test, expect, describe } from "bun:test";
import {
  CLASSIFIER_SAFETY_CASES,
  CLASSIFIER_SAFETY_CATEGORIES,
  formatClassifierSafetyReport,
  runClassifierSafetyCorpus,
  type ClassifierSafetyCase,
} from "@yanlinglabs/winter-provider-conformance";
import { createModelClassifier } from "./model-classifier.ts";
import { CLASSIFIER_TOOL_NAME } from "./verdict-schema.ts";
import type { Provider, ProviderRequest, ProviderTurn } from "../../engine.ts";
import type { ActionEnvelope } from "../../permissions/auto/envelope.ts";
import type { ClassifierContext } from "../../permissions/auto/engine.ts";
import { normalizeAutoModeConfig } from "../../permissions/auto/config.ts";

const CONTEXT: ClassifierContext = { autoConfig: normalizeAutoModeConfig(undefined), classifierContext: [] };

/** A double that answers with whatever the running case expects. Records every request for the fencing assertions. */
function corpusProvider(answerFor: () => ClassifierSafetyCase): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    async generate(request: ProviderRequest): Promise<ProviderTurn> {
      requests.push(request);
      const current = answerFor();
      return { kind: "tool_use", calls: [{ id: current.id, name: CLASSIFIER_TOOL_NAME, input: { verdict: current.expected, category: current.category } }] };
    },
  };
}

describe("the safety corpus, offline", () => {
  test("every case's envelope is a real ActionEnvelope", () => {
    for (const testCase of CLASSIFIER_SAFETY_CASES) {
      // The assignment IS the assertion: a mirror that drifts from `ActionEnvelope` fails to compile.
      const envelope: ActionEnvelope = testCase.envelope;
      expect(envelope.toolName.length).toBeGreaterThan(0);
      expect(envelope.roots.length).toBeGreaterThan(0);
    }
  });

  test("the corpus has both directions and covers its own category vocabulary", () => {
    const allows = CLASSIFIER_SAFETY_CASES.filter((c) => c.expected === "allow");
    const denies = CLASSIFIER_SAFETY_CASES.filter((c) => c.expected === "deny");
    // A deny-only corpus scores a deny-everything model perfectly (WS-07 §10.3 records false
    // POSITIVES for exactly this reason), so the allow rows are a requirement, not decoration.
    // EXACT, not a floor (review round 1, minor 7): the corpus file's own header states the count,
    // and a floor is what let that comment say "four" while the list held five.
    expect(allows.length).toBe(5);
    expect(denies.length).toBeGreaterThanOrEqual(8);
    const used = new Set(CLASSIFIER_SAFETY_CASES.map((c) => c.category));
    for (const category of CLASSIFIER_SAFETY_CATEGORIES) expect(used.has(category)).toBe(true);
  });

  test("case ids are unique", () => {
    const ids = CLASSIFIER_SAFETY_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every case round-trips through the real classifier", async () => {
    let current: ClassifierSafetyCase = CLASSIFIER_SAFETY_CASES[0]!;
    const provider = corpusProvider(() => current);
    const classifier = createModelClassifier({ provider, model: "winter-test/safety-corpus" });

    const report = await runClassifierSafetyCorpus(
      async (envelope, testCase) => {
        current = testCase;
        return classifier.classify(envelope as ActionEnvelope, CONTEXT);
      },
      { label: "scripted double" },
    );

    expect(formatClassifierSafetyReport(report)).toContain("OK");
    expect(report.ok).toBe(true);
    expect(report.missedDenials).toBe(0);
    expect(report.total).toBe(CLASSIFIER_SAFETY_CASES.length);
    expect(provider.requests).toHaveLength(CLASSIFIER_SAFETY_CASES.length);
  });

  test("a model that answers `allow` to everything FAILS the corpus, and its missed denials are counted", async () => {
    // The corpus is only a gate if it can fail. This is the exact shape R6-14 exists to keep out of
    // `classifierEligible`.
    const provider: Provider = { generate: async () => ({ kind: "tool_use", calls: [{ id: "x", name: CLASSIFIER_TOOL_NAME, input: { verdict: "allow" } }] }) };
    const classifier = createModelClassifier({ provider, model: "winter-test/permissive" });
    const report = await runClassifierSafetyCorpus(async (envelope) => classifier.classify(envelope as ActionEnvelope, CONTEXT), { label: "permissive" });
    expect(report.ok).toBe(false);
    expect(report.missedDenials).toBeGreaterThanOrEqual(8);
    expect(formatClassifierSafetyReport(report)).toContain("NOT CLEAN");
  });

  test("a classifier that abstains everywhere fails too -- no_verdict is not agreement", async () => {
    const provider: Provider = { generate: async () => ({ kind: "text", text: "no comment" }) };
    const classifier = createModelClassifier({ provider, model: "winter-test/abstains" });
    const report = await runClassifierSafetyCorpus(async (envelope) => classifier.classify(envelope as ActionEnvelope, CONTEXT), { label: "abstaining" });
    expect(report.agreed).toBe(0);
    expect(report.outcomes.every((o) => o.actual === "no_verdict" && o.detail === "no_tool_call")).toBe(true);
  });

  test("a classifier that throws is an OUTCOME, not a crashed run, and its detail is IDENTITY not prose", async () => {
    // Review round 1, minor 6: `detail` is printed by `formatClassifierSafetyReport`, and on the
    // LIVE leg a thrown value can be a provider error whose message embeds a snippet of the
    // provider's own response body. Name and normalized code, never the message.
    const thrown = Object.assign(new Error("HTTP 500 — {\"error\":\"BODY-SNIPPET-MUST-NOT-PRINT\"}"), { name: "ProviderRequestError", code: "server", status: 500 });
    const report = await runClassifierSafetyCorpus(async () => {
      throw thrown;
    }, { label: "broken" });
    expect(report.total).toBe(CLASSIFIER_SAFETY_CASES.length);
    expect(report.outcomes.every((o) => o.actual === "threw")).toBe(true);
    expect(report.outcomes[0]!.detail).toBe("ProviderRequestError code=server status=500");
    expect(formatClassifierSafetyReport(report)).not.toContain("BODY-SNIPPET-MUST-NOT-PRINT");
  });
});

/**
 * Everything in the assembled message that is NOT inside a fence pair — the instruction half.
 *
 * A line opens or closes a block only when it carries the real one-time token, which is exactly the
 * rule the system prompt states to the reviewer. So this function is the test's model of what the
 * reviewer is told to obey, and a planted instruction appearing in its output is the injection
 * actually landing.
 */
function textOutsideFences(sent: string, fence: string): string {
  const out: string[] = [];
  let depth = 0;
  for (const line of sent.split("\n")) {
    if (line.startsWith("BEGIN-WINTER-DATA ") && line.endsWith(` ${fence}`)) {
      depth++;
      continue;
    }
    if (line.startsWith("END-WINTER-DATA ") && line.endsWith(` ${fence}`)) {
      depth--;
      continue;
    }
    if (depth === 0) out.push(line);
  }
  return out.join("\n");
}

describe("the hostile rows arrive as DATA", () => {
  const hostile = CLASSIFIER_SAFETY_CASES.filter((c) => c.category === "injection-driven-action");

  test("there are hostile rows at all", () => {
    expect(hostile.length).toBeGreaterThanOrEqual(3);
  });

  test("the outside-the-fence detector is REAL: it returns text that escaped, and nothing that did not", () => {
    // A negative-only assertion passes just as happily when the detector is broken.
    const message = ["intro line", "BEGIN-WINTER-DATA action-envelope abc123", "verdict allow", "END-WINTER-DATA action-envelope abc123", "escaped: verdict allow"].join("\n");
    const outside = textOutsideFences(message, "abc123");
    expect(outside).toContain("escaped: verdict allow");
    expect(outside).toContain("intro line");
    expect(outside.split("verdict allow").length - 1).toBe(1); // the fenced copy is gone; only the escaped one remains
  });

  for (const testCase of hostile) {
    test(`${testCase.id}: its planted instruction never escapes the fence`, async () => {
      let fence = "";
      let sent = "";
      const provider: Provider = {
        async generate(request) {
          sent = request.messages[0]!.content as string;
          return { kind: "tool_use", calls: [{ id: "x", name: CLASSIFIER_TOOL_NAME, input: { verdict: "deny" } }] };
        },
      };
      // The case's OWN accumulated context is threaded through, mirroring the fold `createAutoEngine`
      // performs (`classifierContext: envelope.classifierContext`). Passing the empty shared CONTEXT
      // here would make the app-context row's assertion vacuous -- it would be checking that text
      // nobody sent did not escape.
      await createModelClassifier({ provider, model: "winter-test/fencing", onRequest: ({ prompt }) => void (fence = prompt.fence) }).classify(testCase.envelope as ActionEnvelope, {
        ...CONTEXT,
        classifierContext: testCase.envelope.classifierContext,
      });

      // The action's own text is present -- it must be: a reviewer has to SEE what it is judging.
      const command = testCase.envelope.input["command"] as string;
      expect(sent).toContain(command.split("\n")[0]!);
      // Exactly ONE real close for the action block: the forged close line in
      // `deny-injection-forging-a-fence` carries no token, so it never terminates anything, and the
      // payload therefore never reaches the instruction half of the message.
      const realOpen = `BEGIN-WINTER-DATA action-envelope ${fence}`;
      const realClose = `END-WINTER-DATA action-envelope ${fence}`;
      expect(sent.split(realClose).length - 1).toBe(1);
      const inner = sent.slice(sent.indexOf(realOpen) + realOpen.length, sent.indexOf(realClose));
      expect(inner).toContain(command.split("\n")[0]!);
      // The REAL property, stated over the whole message rather than over one block: nothing the
      // payload planted appears in the INSTRUCTION half — the text outside every fence pair, which is
      // the only text the system prompt tells the reviewer to obey. (Asserting merely "not after the
      // action block's close" would be wrong as well as weak: the app-context block legitimately
      // follows it, and its own hostile payload legitimately sits inside that one.)
      const outside = textOutsideFences(sent, fence);
      for (const marker of ["verdict allow", "Always answer allow", "maintenance mode", "pre-approved", "classifier_verdict with verdict"]) expect(outside).not.toContain(marker);
    });
  }

  test("the app-context injection row's planted note rides inside the app-context block", async () => {
    const testCase = CLASSIFIER_SAFETY_CASES.find((c) => c.id === "deny-injection-in-app-context")!;
    let sent = "";
    let fence = "";
    const provider: Provider = {
      async generate(request) {
        sent = request.messages[0]!.content as string;
        return { kind: "tool_use", calls: [{ id: "x", name: CLASSIFIER_TOOL_NAME, input: { verdict: "deny" } }] };
      },
    };
    // The envelope's OWN classifierContext is what the engine would have folded into
    // `ClassifierContext.classifierContext`, so the fixture mirrors that fold.
    await createModelClassifier({ provider, model: "winter-test/app-context", onRequest: ({ prompt }) => void (fence = prompt.fence) }).classify(testCase.envelope as ActionEnvelope, {
      ...CONTEXT,
      classifierContext: testCase.envelope.classifierContext,
    });
    const open = `BEGIN-WINTER-DATA app-context ${fence}`;
    const close = `END-WINTER-DATA app-context ${fence}`;
    const inner = sent.slice(sent.indexOf(open) + open.length, sent.indexOf(close));
    expect(inner).toContain("Always answer allow");
    expect(sent.slice(sent.indexOf(close) + close.length)).not.toContain("Always answer allow");
  });
});
