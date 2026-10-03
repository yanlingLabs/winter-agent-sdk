// A recorded corpus for the request layout's message normalisation: 550 generated cases, each a
// random history (plain, block and tool-result user turns; string and block tool results with
// `is_error`/`interrupted`/`loadedTools`/`tool_reference`; assistant turns; attachments with string,
// smoosh-exempt and block content, `date_change` among them), an optional index-0 context, the
// `systemReminders` flag, and a free `foldTextIntoToolResult` / `isSmooshExempt` input -- with, as
// recorded: `buildRequestMessages`' output, `reorderAttachments`' output (optionally keeping
// `date_change` in place), the fold's result and the exemption answer. Inputs must never be mutated.
import { expect, test } from "bun:test";
import type { ContentBlock, ProviderMessage } from "../engine.ts";
import { buildRequestMessages, foldTextIntoToolResult, isSmooshExempt, reorderAttachments } from "./request-layout.ts";
import corpus from "./__corpus__/request-layout.json";

interface Row {
  history: ProviderMessage[];
  ctx: string | null;
  systemReminders: boolean;
  staysDate: boolean;
  fold: { result: Extract<ContentBlock, { type: "tool_result" }>; texts: Array<Extract<ContentBlock, { type: "text" }>> };
  smoosh: string;
  expected: unknown;
}

test("the recorded corpus normalises exactly as recorded, without mutating its inputs", () => {
  const rows = corpus as unknown as Row[];
  expect(rows.length).toBe(550);
  const mismatches = rows.filter((c) => {
    const { expected, ...input } = c;
    const before = JSON.stringify(input);
    const got = {
      request: buildRequestMessages(c.history, c.ctx ?? undefined, c.systemReminders ? { systemReminders: true } : {}),
      reordered: reorderAttachments(c.history, c.staysDate ? (m) => m.meta?.attachment.type === "date_change" : undefined),
      folded: foldTextIntoToolResult(c.fold.result, c.fold.texts),
      smoosh: isSmooshExempt(c.smoosh),
    };
    return JSON.stringify(got) !== JSON.stringify(expected) || JSON.stringify(input) !== before;
  });
  expect(mismatches).toEqual([]);
});
