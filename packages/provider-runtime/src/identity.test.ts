import { describe, expect, test } from "bun:test";
import { winterUserAgent } from "./identity.ts";
import pkg from "../package.json";

describe("WS-13b honest identity", () => {
  test("the user agent names Winter and its version, never an editor or vendor CLI", () => {
    expect(winterUserAgent()).toBe(`winter-agent-sdk/${pkg.version}`);
    expect(winterUserAgent()).not.toMatch(/vscode|cursor|claude|codex|grok|copilot/i);
  });

  // The rule this file exists to keep true is not "the string is right" but "the string is OURS".
  // WS-13 §5 / D21: a client-identity header is never imported, and every adapter family authors its
  // own -- so the one place that authors it must be incapable of naming somebody else's product.
  test("it is a single well-formed product token — no vendor originator can be appended to it", () => {
    expect(winterUserAgent()).toMatch(/^winter-agent-sdk\/\S+$/);
    expect(winterUserAgent().includes(" ")).toBe(false);
  });
});
