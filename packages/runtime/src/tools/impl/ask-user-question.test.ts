import { describe, test, expect } from "bun:test";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import { ASK_USER_QUESTION_TOOL_NAME, ASK_USER_QUESTION_ANSWER_KEY_FIELD, askUserQuestionExecutor } from "./ask-user-question.ts";

function makeCtx(): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId: "test-session",
    readState: createSessionReadState({ cwd: process.cwd() }),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/tmp/winter-test",
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
  };
}

function oneQuestion(overrides?: Partial<{ header: string; multiSelect: boolean }>) {
  return {
    questions: [
      {
        question: "Which approach?",
        header: overrides?.header ?? "Approach",
        options: [
          { label: "A", description: "Option A" },
          { label: "B", description: "Option B" },
        ],
        ...(overrides?.multiSelect !== undefined ? { multiSelect: overrides.multiSelect } : {}),
      },
    ],
  };
}

describe("AskUserQuestion (task-7 brief, tool-surface-only)", () => {
  test("module load installs a real executor over the WS-06 stub", () => {
    const registered = getRegisteredTool(ASK_USER_QUESTION_TOOL_NAME);
    expect(registered?.executor).toBeDefined();
  });

  test("no answers at all -> legible host-contract error, not a validation error", async () => {
    const result = await askUserQuestionExecutor.execute(oneQuestion(), makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("received no");
    expect(result.output).toContain("answers");
    expect(result.output.toLowerCase()).toContain("host");
  });

  test("answered single-select matching a declared option -> no otherResponse, unanswered empty", async () => {
    const input = { ...oneQuestion(), answers: { "Which approach?": "A" } };
    const result = await askUserQuestionExecutor.execute(input, makeCtx());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed.unanswered).toEqual([]);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toMatchObject({ header: "Approach", answer: "A", multiSelect: false });
    expect(parsed.results[0].otherResponse).toBeUndefined();
  });

  test("single-select answer not matching any option label -> echoed as otherResponse (free-form Other path)", async () => {
    const input = { ...oneQuestion(), answers: { "Which approach?": "Something else entirely" } };
    const result = await askUserQuestionExecutor.execute(input, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.results[0].answer).toBe("Something else entirely");
    expect(parsed.results[0].otherResponse).toBe("Something else entirely");
  });

  test("multiSelect answer never gets otherResponse, even when it matches no single option label verbatim", async () => {
    const input = { ...oneQuestion({ multiSelect: true }), answers: { "Which approach?": "A,B" } };
    const result = await askUserQuestionExecutor.execute(input, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.results[0].answer).toBe("A,B");
    expect(parsed.results[0].multiSelect).toBe(true);
    expect(parsed.results[0].otherResponse).toBeUndefined();
  });

  test("a question with no matching entry in answers is visible as null + listed in unanswered, never silently dropped", async () => {
    const twoQuestions = {
      questions: [
        { question: "Q1?", header: "Q1", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
        { question: "Q2?", header: "Q2", options: [{ label: "C", description: "c" }, { label: "D", description: "d" }] },
      ],
      answers: { "Q1?": "A" },
    };
    const result = await askUserQuestionExecutor.execute(twoQuestions, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.unanswered).toEqual(["Q2?"]);
    const q2 = parsed.results.find((r: { header: string }) => r.header === "Q2");
    expect(q2.answer).toBeNull();
  });

  test("annotations pass through, keyed by question text, alongside answers", async () => {
    const input = {
      ...oneQuestion(),
      answers: { "Which approach?": "A" },
      annotations: { "Which approach?": { preview: "preview text", notes: "some notes" } },
    };
    const result = await askUserQuestionExecutor.execute(input, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.results[0].annotation).toEqual({ preview: "preview text", notes: "some notes" });
  });

  test("metadata.source passes through when present, omitted when absent", async () => {
    const withMeta = await askUserQuestionExecutor.execute({ ...oneQuestion(), answers: { "Which approach?": "A" }, metadata: { source: "chat" } }, makeCtx());
    expect(JSON.parse(withMeta.output).metadata).toEqual({ source: "chat" });

    const withoutMeta = await askUserQuestionExecutor.execute({ ...oneQuestion(), answers: { "Which approach?": "A" } }, makeCtx());
    expect("metadata" in JSON.parse(withoutMeta.output)).toBe(false);
  });

  describe("input validation", () => {
    test("questions must be an array", async () => {
      const result = await askUserQuestionExecutor.execute({ questions: "nope" }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("questions must be an array");
    });

    test("questions count must be 1-4", async () => {
      const zero = await askUserQuestionExecutor.execute({ questions: [] }, makeCtx());
      expect(zero.isError).toBe(true);
      const five = await askUserQuestionExecutor.execute(
        { questions: Array.from({ length: 5 }, (_, i) => oneQuestion({ header: `H${i}` }).questions[0]) },
        makeCtx(),
      );
      expect(five.isError).toBe(true);
      expect(five.output).toContain("between 1 and 4");
    });

    test("header must be <= 12 chars and non-empty", async () => {
      const tooLong = await askUserQuestionExecutor.execute(oneQuestion({ header: "WayTooLongHeaderText" }), makeCtx());
      expect(tooLong.isError).toBe(true);
      expect(tooLong.output).toContain("header");

      const empty = await askUserQuestionExecutor.execute(oneQuestion({ header: "" }), makeCtx());
      expect(empty.isError).toBe(true);
    });

    // RULING P5-C: REPLACED, not merely amended -- the old assertion here ("duplicate headers ...
    // are rejected") pinned the defect capture (5) falsified. The uniqueness constraint now lives on
    // the answer key (question text); both directions are pinned in the M7/P5-C block below.
    test("duplicate question text across questions is rejected", async () => {
      const dup = {
        questions: [
          { question: "Same?", header: "H1", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
          { question: "Same?", header: "H2", options: [{ label: "C", description: "c" }, { label: "D", description: "d" }] },
        ],
      };
      const result = await askUserQuestionExecutor.execute(dup, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("duplicate question text");
    });

    test("options count must be 2-4", async () => {
      const oneOption = {
        questions: [{ question: "Q?", header: "H", options: [{ label: "A", description: "a" }] }],
      };
      const result = await askUserQuestionExecutor.execute(oneOption, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("between 2 and 4");
    });

    test("option label/description must be strings", async () => {
      const badOption = {
        questions: [{ question: "Q?", header: "H", options: [{ label: "", description: "a" }, { label: "B", description: "b" }] }],
      };
      const result = await askUserQuestionExecutor.execute(badOption, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("label");
    });

    test("non-object / missing questions input is a legible validation error, never a throw", async () => {
      for (const bad of [undefined, null, {}, "nope", 42]) {
        await expect(askUserQuestionExecutor.execute(bad, makeCtx())).resolves.toBeDefined();
        const result = await askUserQuestionExecutor.execute(bad, makeCtx());
        expect(result.isError).toBe(true);
      }
    });
  });

  describe("free-text questions (options absent or empty)", () => {
    const freeText = (extra?: Record<string, unknown>) => ({ question: "What should the service be called?", header: "Name", ...extra });

    test("a free-text-only call (options absent) is valid and returns the typed answer plainly", async () => {
      const result = await askUserQuestionExecutor.execute({ questions: [freeText({ placeholder: "e.g. billing-api" })], answers: { "What should the service be called?": "ledger-svc" } }, makeCtx());
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.unanswered).toEqual([]);
      expect(parsed.results[0]).toEqual({ header: "Name", question: "What should the service be called?", multiSelect: false, freeText: true, answer: "ledger-svc" });
    });

    test("options: [] is a free-text question too", async () => {
      const result = await askUserQuestionExecutor.execute({ questions: [freeText({ options: [] })], answers: { "What should the service be called?": "x" } }, makeCtx());
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.results[0]).toMatchObject({ freeText: true, answer: "x" });
      expect(parsed.results[0].otherResponse).toBeUndefined();
    });

    test("mixed option and free-text questions in one call", async () => {
      const input = {
        questions: [oneQuestion().questions[0], freeText()],
        answers: { "Which approach?": "A", "What should the service be called?": "ledger-svc" },
      };
      const result = await askUserQuestionExecutor.execute(input, makeCtx());
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.unanswered).toEqual([]);
      expect(parsed.results[0]).toEqual({ header: "Approach", question: "Which approach?", multiSelect: false, freeText: false, answer: "A" });
      expect(parsed.results[1]).toEqual({ header: "Name", question: "What should the service be called?", multiSelect: false, freeText: true, answer: "ledger-svc" });
    });

    test("an option question's typed answer still comes back as otherResponse", async () => {
      const result = await askUserQuestionExecutor.execute({ ...oneQuestion(), answers: { "Which approach?": "Neither" } }, makeCtx());
      const parsed = JSON.parse(result.output);
      expect(parsed.results[0]).toEqual({ header: "Approach", question: "Which approach?", multiSelect: false, freeText: false, answer: "Neither", otherResponse: "Neither" });
    });

    test("an empty or whitespace-only free-text answer counts as skipped (null + unanswered)", async () => {
      for (const empty of ["", "   "]) {
        const result = await askUserQuestionExecutor.execute({ questions: [freeText()], answers: { "What should the service be called?": empty } }, makeCtx());
        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.output);
        expect(parsed.results[0]).toEqual({ header: "Name", question: "What should the service be called?", multiSelect: false, freeText: true, answer: null });
        expect(parsed.unanswered).toEqual(["What should the service be called?"]);
      }
    });

    test("an empty answer to an option question is skipped too, never an empty otherResponse", async () => {
      const parsed = JSON.parse((await askUserQuestionExecutor.execute({ ...oneQuestion(), answers: { "Which approach?": "" } }, makeCtx())).output);
      expect(parsed.results[0].answer).toBeNull();
      expect(parsed.results[0].otherResponse).toBeUndefined();
      expect(parsed.unanswered).toEqual(["Which approach?"]);
    });

    test("multiSelect on a free-text question is normalized to false", async () => {
      const parsed = JSON.parse((await askUserQuestionExecutor.execute({ questions: [freeText({ multiSelect: true })], answers: { "What should the service be called?": "a" } }, makeCtx())).output);
      expect(parsed.results[0]).toMatchObject({ multiSelect: false, freeText: true, answer: "a" });
    });

    test("1 option is rejected", async () => {
      const result = await askUserQuestionExecutor.execute({ questions: [freeText({ options: [{ label: "A", description: "a" }] })] }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("between 2 and 4");
    });

    test("5 options are rejected", async () => {
      const five = Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, description: "d" }));
      const result = await askUserQuestionExecutor.execute({ questions: [freeText({ options: five })] }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("between 2 and 4");
    });

    test("options that is not an array is rejected", async () => {
      const result = await askUserQuestionExecutor.execute({ questions: [freeText({ options: "A,B" })] }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("options must be an array");
    });

    test("placeholder up to 80 characters is accepted; longer or non-string is rejected", async () => {
      const ok = await askUserQuestionExecutor.execute({ questions: [freeText({ placeholder: "x".repeat(80) })], answers: { "What should the service be called?": "a" } }, makeCtx());
      expect(ok.isError).toBeUndefined();
      const tooLong = await askUserQuestionExecutor.execute({ questions: [freeText({ placeholder: "x".repeat(81) })] }, makeCtx());
      expect(tooLong.isError).toBe(true);
      expect(tooLong.output).toContain("placeholder");
      const notString = await askUserQuestionExecutor.execute({ questions: [freeText({ placeholder: 5 })] }, makeCtx());
      expect(notString.isError).toBe(true);
    });

    test("placeholder is accepted on an option question too", async () => {
      const q = { ...oneQuestion().questions[0], placeholder: "or describe your own" };
      const result = await askUserQuestionExecutor.execute({ questions: [q], answers: { "Which approach?": "A" } }, makeCtx());
      expect(result.isError).toBeUndefined();
    });
  });

  describe("advertised schema", () => {
    test("options is optional with no minItems, placeholder is capped at 80, no oneOf anywhere", () => {
      const schema = getRegisteredTool(ASK_USER_QUESTION_TOOL_NAME)!.descriptor.inputSchema as Record<string, any>;
      const item = schema.properties.questions.items;
      expect(item.required).toEqual(["question", "header"]);
      expect(item.properties.options.minItems).toBeUndefined();
      expect(item.properties.options.maxItems).toBe(4);
      expect(item.properties.placeholder).toMatchObject({ type: "string", maxLength: 80 });
      expect(JSON.stringify(schema)).not.toMatch(/"(oneOf|anyOf|allOf)"/);
    });

    test("the description is model guidance, not the host contract", () => {
      const description = getRegisteredTool(ASK_USER_QUESTION_TOOL_NAME)!.descriptor.description;
      expect(description).toContain("(Recommended)");
      expect(description).toContain("plain text");
      expect(description).not.toContain("canUseTool");
    });
  });

  // M7 (fix wave, ledger carry, P3 close-out) — RULING P5-C (Phase 5 Task 3): the answers/
  // annotations keying convention is exported as ONE named constant
  // (ASK_USER_QUESTION_ANSWER_KEY_FIELD) so nothing hand-copies the literal string -- this test
  // proves the executor actually READS that constant (not just that it happens to equal the right
  // string by coincidence): keying `answers`/`annotations` by whatever the constant currently names
  // is what the executor's own lookups use.
  //
  // The VALUE moved from "header" to "question" in P5 T3. derived-shapes-p5.md capture (5) ran the
  // pinned runtime both ways: keyed by question text, both questions reported answered; keyed by
  // header, both reported UNANSWERED. The declaration agrees independently
  // (`AskUserQuestionOutput.answers`/`annotations` are both documented as question-text-keyed). The
  // P3-era `header` choice was a Lane E convention taken when the key looked unpinned; it is now a
  // pinned fact, so the constant, this test, and the duplicate-key validation all move together.
  describe("M7/P5-C: ASK_USER_QUESTION_ANSWER_KEY_FIELD is the real keying convention, not just documentation", () => {
    test("the constant names 'question' -- the pinned key (capture (5)), not the P3-era 'header'", () => {
      expect(ASK_USER_QUESTION_ANSWER_KEY_FIELD).toBe("question");
    });

    test("answers/annotations are keyed by the question's OWN value at that field", async () => {
      const input = {
        questions: [{ question: "Pick one", header: "Q1", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
        answers: { "Pick one": "A" },
        annotations: { "Pick one": { notes: "picked A" } },
      };
      const result = await askUserQuestionExecutor.execute(input, makeCtx());
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.output);
      expect(parsed.results[0].answer).toBe("A");
      expect(parsed.results[0].annotation).toEqual({ notes: "picked A" });
    });

    // Capture (5)'s discriminator, reproduced as a regression test: the OLD convention must now
    // MISS. Without this, flipping the constant back would still pass every other test in this file
    // (they all use inputs whose question text and header differ only in spelling, so a lookup by
    // either key finds *something* in a hand-written fixture that supplies both).
    test("keying by header (the P3-era convention) now reports the question UNANSWERED -- capture (5) run B", async () => {
      const input = {
        questions: [{ question: "Which approach?", header: "Approach", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
        answers: { Approach: "A" },
      };
      const result = await askUserQuestionExecutor.execute(input, makeCtx());
      const parsed = JSON.parse(result.output);
      expect(parsed.results[0].answer).toBeNull();
      expect(parsed.unanswered).toEqual(["Which approach?"]);
    });

    // The duplicate-key validation moves with the key: two questions may now share a header (it is
    // only a display label once it stops being the answer key) but never their question text.
    test("duplicate QUESTION TEXT is rejected; a duplicate header is not", async () => {
      const dupQuestion = await askUserQuestionExecutor.execute(
        {
          questions: [
            { question: "Same?", header: "H1", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
            { question: "Same?", header: "H2", options: [{ label: "C", description: "c" }, { label: "D", description: "d" }] },
          ],
          answers: {},
        },
        makeCtx(),
      );
      expect(dupQuestion.isError).toBe(true);
      expect(dupQuestion.output).toContain("duplicate question");

      const dupHeader = await askUserQuestionExecutor.execute(
        {
          questions: [
            { question: "Q1?", header: "Same", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
            { question: "Q2?", header: "Same", options: [{ label: "C", description: "c" }, { label: "D", description: "d" }] },
          ],
          answers: { "Q1?": "A", "Q2?": "C" },
        },
        makeCtx(),
      );
      expect(dupHeader.isError).toBeUndefined();
      const parsed = JSON.parse(dupHeader.output);
      expect(parsed.unanswered).toEqual([]);
    });
  });
});
