// A recorded corpus for the agent listing and the history folds around it: 500 generated scenarios
// (an available agent set with every tools/disallowedTools/lean-text shape, a history of well-formed
// and malformed `agent_listing_delta` / `skill_listing` / other attachments, the delta options, and one
// free-standing delta payload) with, as recorded: each entry's tool spec and line (plain and lean),
// the announced set, the computed delta and its rendered text, the free payload's rendered text, and the
// skill-listing resume seed.
import { expect, test } from "bun:test";
import type { ProviderMessage } from "../engine.ts";
import { computeAgentListingDelta, renderAgentListingLine, renderAgentToolSpec, type AgentListingEntry } from "./agent-listing.ts";
import { announcedAgentTypes, renderAttachment, skillListingResumeSeed, type AttachmentPayload } from "./attachments.ts";
import corpus from "./__corpus__/agent-listing.json";

interface Row {
  available: AgentListingEntry[];
  history: ProviderMessage[];
  opts: { leanModel?: boolean; showConcurrencyNote?: boolean };
  payload: AttachmentPayload;
  expected: unknown;
}

test("the recorded corpus reproduces exactly", () => {
  const rows = corpus as unknown as Row[];
  expect(rows.length).toBe(500);
  const mismatches = rows.filter((s) => {
    const delta = computeAgentListingDelta(s.available, s.history, s.opts);
    const got = {
      specs: s.available.map((e) => renderAgentToolSpec(e)),
      lines: s.available.map((e) => [renderAgentListingLine(e), renderAgentListingLine(e, true)]),
      announced: [...announcedAgentTypes(s.history)],
      delta: delta ?? null,
      deltaText: delta === undefined ? null : (renderAttachment(delta) ?? null),
      payloadText: renderAttachment(s.payload) ?? null,
      skillSeed: skillListingResumeSeed(s.history),
    };
    return JSON.stringify(got) !== JSON.stringify(s.expected);
  });
  expect(mismatches).toEqual([]);
});
