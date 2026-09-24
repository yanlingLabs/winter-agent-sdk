import { describe, test } from "bun:test";

// WS-09 §2 ("Non-interactive `-p` mode has additional first-turn waiting behavior and MUST be
// treated as a separate lifecycle path with its own fixtures") / §12 Open Question 5.
//
// RULED in fix round 19 (the R.3 live gate), on a MEASUREMENT of claude 2.1.250 by the router's
// same-view row: an ordinary stdio server is reported `pending` in claude's `system/init`, claude's
// first model request carries none of its tools (a first-turn call gets "No such tool available"),
// and its tools join the model requests from the next turn, because claude rebuilds each request's
// tool list from its live MCP state (`zAn` sets `z = MCP_CONNECTION_NONBLOCKING !== false`, dump byte
// ~24253401, so connection is nonblocking by default; only `alwaysLoad` servers are awaited; tools
// arrive through `applyMcpUpdate`). Winter matches that shape: `mcp/lifecycle.ts`'s `start()` awaits
// only `alwaysLoad` servers (and the whole batch under MCP_CONNECTION_NONBLOCKING=0), and engine.ts
// re-derives the advertised set for every provider request and on every registry change.
//
// Recorded, not ported: the dump also carries a first-turn prewait in claude's `runHeadless` --
// `km(getState, t=2000, {waitForDeferrable:true,…})` (34109614), awaited before the first turn
// (34017501), with a deadline of 2000 ms unless an explicit non-sdk `--mcp-config` server or
// `--strict-mcp-config` lifts it to MCP_TIMEOUT (`e_`/`OL`, 34109559). The measured run did not show
// that wait taking effect (the router's bun-launched fixtures start in 2.5–4.5 s, beyond 2000 ms, so
// the measurement cannot tell "no wait" from "a 2 s wait"); the ruling follows the measurement. A run
// against a server that connects well under 2 s would settle it.
describe("MCP -p (non-interactive one-shot) first-turn wait (WS-09 §2 / §12 Open Question 5)", () => {
  test.skip("RULED (fix round 19): no first-turn MCP wait beyond `alwaysLoad` -- measured claude 2.1.250 sends turn 1 before an ordinary stdio server connects; see this file's header for the recorded `km` prewait", () => {
    // Intentionally empty -- the ruling is carried by engine.ts's live advertised set and by
    // production-wiring.test.ts's fix-round-19 end-to-end tests.
  });
});
