// A recorded input -> output corpus for `firstTurnMcpWaitDeadlineMs`: 800 generated combinations of
// the strict flag (true/false/absent and non-boolean junk), the explicit server map (absent, empty,
// in-process `sdk` entries, other transports, odd `type` spellings, null/array/primitive entries) and
// the configured MCP_TIMEOUT, with the deadline recorded for each. `{"$undefined": true}` encodes
// `undefined`, also inside the server map.
import { expect, test } from "bun:test";
import { firstTurnMcpWaitDeadlineMs } from "./lifecycle.ts";
import corpus from "./__corpus__/first-turn-mcp-wait.json";

const decode = (v: unknown): unknown => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  if ((v as { $undefined?: boolean }).$undefined === true) return undefined;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
};

test("the recorded corpus yields exactly the recorded deadlines", () => {
  const rows = corpus as Array<{ input: unknown; expected: number }>;
  expect(rows.length).toBe(800);
  const mismatches = rows.filter((row) => firstTurnMcpWaitDeadlineMs(decode(row.input) as Parameters<typeof firstTurnMcpWaitDeadlineMs>[0]) !== row.expected);
  expect(mismatches).toEqual([]);
});
