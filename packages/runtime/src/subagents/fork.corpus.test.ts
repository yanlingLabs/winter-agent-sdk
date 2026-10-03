// A recorded input -> output corpus for `buildForkInitialMessages`: 1500 generated histories mixing
// user/assistant/tool roles, string and block content, tool_use / tool_result / text blocks over a small
// id pool (answered, unanswered, duplicated and missing ids), origin / uuid / nativeState decorations,
// and an absent history. The expected answer is stored by reference: `kept` lists the indices of the
// input messages returned, in order (the very same objects); `clone` is `[message index, block index]`
// of the tool_use block the clone carries, or `null` when nothing is cloned -- a clone is then followed
// by the placeholder tool_result answering the fork's id.
import { expect, test } from "bun:test";
import type { ProviderMessage } from "../engine.ts";
import { FORK_PLACEHOLDER_TOOL_RESULT, buildForkInitialMessages } from "./fork.ts";
import corpus from "./__corpus__/fork-history.json";

interface Row {
  messages?: ProviderMessage[];
  forkToolUseId: string;
  kept: number[];
  clone: [number, number] | null;
}

test("the recorded corpus filters and clones exactly as recorded", () => {
  const rows = corpus as unknown as Row[];
  expect(rows.length).toBe(1500);
  const mismatches = rows.filter((row) => {
    const messages = row.messages;
    const out = buildForkInitialMessages(messages !== undefined ? { messages } : {}, row.forkToolUseId);
    const all = messages ?? [];
    const expected: ProviderMessage[] = row.kept.map((i) => all[i]!);
    if (row.clone !== null) {
      const source = all[row.clone[0]]!;
      const block = (source.content as unknown[])[row.clone[1]];
      expected.push({ role: "assistant", content: [block], ...(source.origin !== undefined ? { origin: source.origin } : {}) } as ProviderMessage);
      expected.push({ role: "tool", content: [{ type: "tool_result", tool_use_id: row.forkToolUseId, content: FORK_PLACEHOLDER_TOOL_RESULT }] });
    }
    if (out.length !== expected.length) return true;
    return row.kept.some((_, i) => out[i] !== expected[i]) || !Bun.deepEquals(out, expected, true);
  });
  expect(mismatches.length).toBe(0);
});
