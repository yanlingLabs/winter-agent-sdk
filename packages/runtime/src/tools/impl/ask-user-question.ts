// Task 7 (LANE E, WS-06 §3.3 "AskUserQuestion"): TOOL SURFACE ONLY. P2's T8 already landed the
// stage-3 mandatory-interaction routing (permissions/evaluator.ts's ASK_USER_QUESTION_TOOL_NAME
// constant + WS-07 §8's "routes through canUseTool... the host answers by returning `updatedInput`
// with `answers`") and the canUseTool `updatedInput.answers` protocol itself (WS-07 §7.2). This file
// builds NEITHER of those -- it is purely: (1) input validation against the WS-06 §3.3 pinned shape,
// and (2) the result echo once `input.answers` has already been populated by the host, upstream of
// this executor, exactly the same "if you run, it already happened" relationship ExitPlanMode has
// with its own gate (exit-plan-mode.ts's header).
//
// ANSWERS/ANNOTATIONS KEYING -- a genuine Lane E judgment call, T8 FLAG: WS-06 §3.3 types
// `answers?: Record<string, string>` and `annotations?: Record<string, {...}>` but never pins what
// the record KEY actually is. permissions/evaluator.ts's own comment is explicit that this is left
// to this file ("the tool itself (schema, real answer-application via `updatedInput.answers`) is
// P3's job"). This executor keys BOTH records by each question's own `header` -- the short
// (<=12-char), model-authored, per-question identifier that is already the natural "which question
// is this" label in any UI built around this schema. Duplicate headers within one call are therefore
// rejected as a validation error (see validateQuestions below) -- the keying convention is only
// self-consistent if headers are unique per call. Whichever host-side implementation lands at a
// later phase MUST either adopt this convention or this file (and its tests) need to move with it.
//
// askUserQuestionTimeout (WS-06 §3.3: "open indefinitely by default, `askUserQuestionTimeout` opts
// into 60s/5m/10m with activity reset... this timeout never auto-resolves permission or plan
// prompts"): this is HOST/SESSION config, never a per-call tool input field (it does not appear
// anywhere in the pinned input_schema code block) and never a timer this executor could own even in
// principle -- by the time this executor runs, the call has already been answered (or the whole
// question never reaches execution at all). Documented here, not implemented, per the brief.
import "../descriptors/ask-user-question.ts"; // self-sufficiency: guarantees the "AskUserQuestion" stub is registered before replaceExecutor runs below.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

interface OptionInput {
  label: string;
  description: string;
  preview?: string;
}

interface QuestionInput {
  question: string;
  header: string;
  options: OptionInput[];
  multiSelect: boolean;
}

type ValidationResult = { ok: true; questions: QuestionInput[] } | { ok: false; message: string };

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function validateOption(raw: unknown, qIndex: number, oIndex: number): { ok: true; option: OptionInput } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: `questions[${qIndex}].options[${oIndex}] must be an object` };
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.label !== "string" || rec.label.length === 0) {
    return { ok: false, message: `questions[${qIndex}].options[${oIndex}].label must be a non-empty string` };
  }
  if (typeof rec.description !== "string") {
    return { ok: false, message: `questions[${qIndex}].options[${oIndex}].description must be a string` };
  }
  const preview = typeof rec.preview === "string" ? rec.preview : undefined;
  return { ok: true, option: { label: rec.label, description: rec.description, ...(preview !== undefined ? { preview } : {}) } };
}

function validateQuestions(raw: unknown): ValidationResult {
  if (!Array.isArray(raw)) return { ok: false, message: "questions must be an array" };
  if (raw.length < 1 || raw.length > 4) {
    return { ok: false, message: `questions must contain between 1 and 4 entries (got ${raw.length})` };
  }
  const seenHeaders = new Set<string>();
  const questions: QuestionInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const q: unknown = raw[i];
    if (typeof q !== "object" || q === null || Array.isArray(q)) {
      return { ok: false, message: `questions[${i}] must be an object` };
    }
    const rec = q as Record<string, unknown>;
    if (typeof rec.question !== "string" || rec.question.length === 0) {
      return { ok: false, message: `questions[${i}].question must be a non-empty string` };
    }
    if (typeof rec.header !== "string" || rec.header.length === 0 || rec.header.length > 12) {
      return { ok: false, message: `questions[${i}].header must be a string of 1-12 characters (got ${JSON.stringify(rec.header)})` };
    }
    if (seenHeaders.has(rec.header)) {
      return {
        ok: false,
        message: `duplicate header ${JSON.stringify(rec.header)} across questions -- answers/annotations are keyed by header (Lane E convention, see this file's own header comment), so headers must be unique within one call`,
      };
    }
    seenHeaders.add(rec.header);
    if (!Array.isArray(rec.options) || rec.options.length < 2 || rec.options.length > 4) {
      return { ok: false, message: `questions[${i}].options must contain between 2 and 4 entries` };
    }
    const options: OptionInput[] = [];
    for (let j = 0; j < rec.options.length; j++) {
      const validated = validateOption(rec.options[j], i, j);
      if (!validated.ok) return validated;
      options.push(validated.option);
    }
    const multiSelect = rec.multiSelect === true;
    questions.push({ question: rec.question, header: rec.header, options, multiSelect });
  }
  return { ok: true, questions };
}

function extractAnnotation(raw: unknown): { preview?: string; notes?: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const preview = typeof rec.preview === "string" ? rec.preview : undefined;
  const notes = typeof rec.notes === "string" ? rec.notes : undefined;
  if (preview === undefined && notes === undefined) return {};
  return { ...(preview !== undefined ? { preview } : {}), ...(notes !== undefined ? { notes } : {}) };
}

export const askUserQuestionExecutor: ToolExecutor = {
  async execute(input: unknown, _ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const record = asRecord(input);
    const validated = validateQuestions(record.questions);
    if (!validated.ok) {
      return { output: `Error: AskUserQuestion input is invalid: ${validated.message}`, isError: true };
    }
    const { questions } = validated;

    // "Unanswered (no `answers` present) = a legible error explaining the host contract" (brief,
    // verbatim). This is checked SEPARATELY from shape validation above: a well-formed `questions`
    // array with no `answers` at all is not a malformed CALL, it is evidence the host-side mandatory-
    // interaction routing (WS-07 §8) never ran for it.
    const rawAnswers = record.answers;
    if (rawAnswers === undefined) {
      return {
        output:
          'Error: AskUserQuestion received no "answers". This tool is mandatory interaction (WS-07 §8): the host must route the call through canUseTool and return `updatedInput.answers` before this executor ever runs. Receiving no answers means that host-side protocol did not execute for this call -- a host integration bug, not a model input error.',
        isError: true,
      };
    }
    if (typeof rawAnswers !== "object" || rawAnswers === null || Array.isArray(rawAnswers)) {
      return { output: 'Error: AskUserQuestion input.answers must be an object mapping question header to answer string.', isError: true };
    }
    const answers = rawAnswers as Record<string, unknown>;

    const rawAnnotations = record.annotations;
    const annotations =
      typeof rawAnnotations === "object" && rawAnnotations !== null && !Array.isArray(rawAnnotations) ? (rawAnnotations as Record<string, unknown>) : {};

    const rawMetadata = record.metadata;
    const metadataSource =
      typeof rawMetadata === "object" && rawMetadata !== null && !Array.isArray(rawMetadata) && typeof (rawMetadata as Record<string, unknown>).source === "string"
        ? ((rawMetadata as Record<string, unknown>).source as string)
        : undefined;

    const unanswered: string[] = [];
    const results = questions.map((q) => {
      const rawAnswer = answers[q.header];
      const answer = typeof rawAnswer === "string" ? rawAnswer : null;
      if (answer === null) unanswered.push(q.header);

      // "Runtime adds the free-form 'Other' path" (WS-06 §3.3 prose): an answer that does not match
      // any declared option's label is echoed as a free-form response. Restricted to single-select
      // questions ONLY -- for multiSelect, `answer` is whatever combined-selection string the host
      // chose to encode (the schema gives multi-select answers no structure beyond "one string"), and
      // this executor does not invent a delimiter/parsing convention the spec never pins; it is
      // echoed verbatim with no Other-detection judgment applied to it.
      const isOther = answer !== null && !q.multiSelect && !q.options.some((o) => o.label === answer);

      const annotation = extractAnnotation(annotations[q.header]);

      return {
        header: q.header,
        question: q.question,
        multiSelect: q.multiSelect,
        answer,
        ...(isOther ? { otherResponse: answer } : {}),
        ...(annotation !== undefined ? { annotation } : {}),
      };
    });

    return {
      output: JSON.stringify({
        results,
        // Missing per-question answers are surfaced explicitly (never silently dropped) -- an empty
        // array here is itself meaningful evidence that every declared question got an answer.
        unanswered,
        ...(metadataSource !== undefined ? { metadata: { source: metadataSource } } : {}),
      }),
    };
  },
};

replaceExecutor(ASK_USER_QUESTION_TOOL_NAME, askUserQuestionExecutor);
