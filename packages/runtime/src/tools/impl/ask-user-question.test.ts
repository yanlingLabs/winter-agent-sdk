import { describe, test, expect } from "bun:test";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import { ASK_USER_QUESTION_TOOL_NAME, askUserQuestionExecutor } from "./ask-user-question.ts";

function makeCtx(): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId: "test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/tmp/winter-test",
    session: { setCwd() {}, addBoundedRoot() {}, setPermissionMode() {} },
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
    const input = { ...oneQuestion(), answers: { Approach: "A" } };
    const result = await askUserQuestionExecutor.execute(input, makeCtx());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed.unanswered).toEqual([]);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toMatchObject({ header: "Approach", answer: "A", multiSelect: false });
    expect(parsed.results[0].otherResponse).toBeUndefined();
  });

  test("single-select answer not matching any option label -> echoed as otherResponse (free-form Other path)", async () => {
    const input = { ...oneQuestion(), answers: { Approach: "Something else entirely" } };
    const result = await askUserQuestionExecutor.execute(input, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.results[0].answer).toBe("Something else entirely");
    expect(parsed.results[0].otherResponse).toBe("Something else entirely");
  });

  test("multiSelect answer never gets otherResponse, even when it matches no single option label verbatim", async () => {
    const input = { ...oneQuestion({ multiSelect: true }), answers: { Approach: "A,B" } };
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
      answers: { Q1: "A" },
    };
    const result = await askUserQuestionExecutor.execute(twoQuestions, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.unanswered).toEqual(["Q2"]);
    const q2 = parsed.results.find((r: { header: string }) => r.header === "Q2");
    expect(q2.answer).toBeNull();
  });

  test("annotations pass through, keyed by header, alongside answers", async () => {
    const input = {
      ...oneQuestion(),
      answers: { Approach: "A" },
      annotations: { Approach: { preview: "preview text", notes: "some notes" } },
    };
    const result = await askUserQuestionExecutor.execute(input, makeCtx());
    const parsed = JSON.parse(result.output);
    expect(parsed.results[0].annotation).toEqual({ preview: "preview text", notes: "some notes" });
  });

  test("metadata.source passes through when present, omitted when absent", async () => {
    const withMeta = await askUserQuestionExecutor.execute({ ...oneQuestion(), answers: { Approach: "A" }, metadata: { source: "chat" } }, makeCtx());
    expect(JSON.parse(withMeta.output).metadata).toEqual({ source: "chat" });

    const withoutMeta = await askUserQuestionExecutor.execute({ ...oneQuestion(), answers: { Approach: "A" } }, makeCtx());
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

    test("duplicate headers across questions are rejected", async () => {
      const dup = {
        questions: [
          { question: "Q1?", header: "Same", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
          { question: "Q2?", header: "Same", options: [{ label: "C", description: "c" }, { label: "D", description: "d" }] },
        ],
      };
      const result = await askUserQuestionExecutor.execute(dup, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("duplicate header");
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
});
