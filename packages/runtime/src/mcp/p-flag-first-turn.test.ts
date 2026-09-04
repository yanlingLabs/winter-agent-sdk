import { describe, test } from "bun:test";

// WS-09 §2 ("Non-interactive `-p` mode has additional first-turn waiting behavior and MUST be
// treated as a separate lifecycle path with its own fixtures") / §12 Open Question 5: the pinned
// report establishes THAT this separate path exists but not its deadline(s) or how they interact
// with `alwaysLoad`/the discovery cache -- WS-09 §12 Q5's own resolution is explicit that "this spec
// is amended with the captured semantics rather than guessing them now," not that Lane A should
// invent a plausible-looking number.
//
// This lane's own review (advisor guidance, before implementation) was explicit: do NOT implement
// `-p` first-turn semantics from guesswork. This file is the placeholder the brief itself asks for
// ("its own fixture path marked capture-pending") -- a real `test.skip`, not a bare TODO comment, so
// a future capture-driven task (once a real 0.3.250 `-p`-mode session is captured) has a named,
// discoverable home to drop the actual fixture into, and so `bun test`'s own output surfaces this as
// a deliberately-skipped, tracked gap rather than a silent absence.
//
// Scope note: packages/runtime has no "-p" concept of its own today (the CLI's `-p` flag, wherever
// it eventually lands, is a separate process/package entirely) -- there is nothing in THIS package
// for a real fixture to even attach to yet. That is itself part of why this stays a placeholder
// rather than a real (if empty) integration test.
describe("MCP -p (non-interactive one-shot) first-turn wait (WS-09 §2 / §12 Open Question 5)", () => {
  test.skip("CAPTURE-PENDING (R4-8): first-turn wait deadline(s) and alwaysLoad/discovery-cache interaction are not pinned by the report and are not guessed here -- author from a real 0.3.250 `-p`-mode capture", () => {
    // Intentionally empty -- see this file's own header for why no assertion belongs here yet.
  });
});
