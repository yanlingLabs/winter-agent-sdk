import { describe, test, expect } from "bun:test";
import { resolveForkInitialMessages, isForkRequest } from "./fork.ts";

describe("resolveForkInitialMessages (WS-10 §3.5)", () => {
  test("no messages on the inheritance -> empty array (a bare/definition-backed child)", () => {
    expect(resolveForkInitialMessages({})).toEqual([]);
  });

  test("fork messages are copied verbatim, in order", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    expect(resolveForkInitialMessages({ messages })).toEqual(messages);
  });

  test("the returned array is a genuine COPY -- mutating it never touches the original inherit.messages", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    const inherit = { messages };
    const result = resolveForkInitialMessages(inherit);
    result.push({ role: "assistant", content: "mutated" });
    expect(inherit.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(result.length).toBe(2);
  });
});

describe("isForkRequest", () => {
  test("true only when fork is literally true", () => {
    expect(isForkRequest({ fork: true })).toBe(true);
    expect(isForkRequest({})).toBe(false);
  });
});
