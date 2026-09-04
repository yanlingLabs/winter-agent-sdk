import { describe, test, expect } from "bun:test";
import { capMcpOutput, estimateTokens } from "./output-cap.ts";

describe("estimateTokens", () => {
  test("empty string is 0 tokens", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("~4 chars/token, rounded up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("capMcpOutput", () => {
  test("under the cap: returned verbatim, not truncated", () => {
    const text = "hello world";
    const result = capMcpOutput(text, 1000);
    expect(result).toEqual({ text, truncated: false, originalTokens: estimateTokens(text), cappedTokens: estimateTokens(text) });
  });

  test("exactly at the cap: not truncated (boundary is inclusive)", () => {
    const text = "a".repeat(40); // exactly 10 tokens at 4 chars/token
    const result = capMcpOutput(text, 10);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
  });

  test("over the cap: clipped to the char budget and carries an explicit truncation marker", () => {
    const text = "a".repeat(100); // 25 tokens
    const result = capMcpOutput(text, 10); // budget: 40 chars
    expect(result.truncated).toBe(true);
    expect(result.originalTokens).toBe(25);
    expect(result.cappedTokens).toBe(10);
    expect(result.text.startsWith("a".repeat(40))).toBe(true);
    expect(result.text).not.toContain("a".repeat(41)); // never leaks a 41st raw char before the marker
    expect(result.text).toContain("[winter: MCP tool output truncated at 10 tokens (original ~25 tokens)");
    expect(result.text).toContain("Re-query with a narrower request to see more.");
  });

  test("marker names the cap and the original size distinctly, so a model can gauge how much was lost", () => {
    const result = capMcpOutput("x".repeat(400), 5);
    expect(result.text).toContain("truncated at 5 tokens");
    expect(result.text).toContain("original ~100 tokens");
  });

  test("non-positive maxOutputTokens degrades to a 1-token floor rather than throwing or going negative", () => {
    const result = capMcpOutput("hello world this is a longer string", 0);
    expect(result.truncated).toBe(true);
    expect(result.cappedTokens).toBe(1);
    expect(result.text.length).toBeGreaterThan(0);

    const negative = capMcpOutput("hello world this is a longer string", -5);
    expect(negative.cappedTokens).toBe(1);
  });

  test("fractional maxOutputTokens is truncated to an integer cap", () => {
    const text = "a".repeat(100);
    const result = capMcpOutput(text, 10.9);
    expect(result.cappedTokens).toBe(10);
  });
});
