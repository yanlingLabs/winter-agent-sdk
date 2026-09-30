// Code-mode images: the per-request image budget (image-budget.ts).
import { describe, expect, test } from "bun:test";
import type { ContentBlockLike, ProviderMessageLike } from "../types.ts";
import { IMAGE_BUDGET_NOTE, imageBudgetFor, withinImageBudget } from "./image-budget.ts";
import { normalizeHttpError } from "../errors.ts";

const image = (tag: string, bytes = 10): ContentBlockLike => ({ type: "image", source: { type: "base64", media_type: "image/png", data: tag.padEnd(bytes, "=") } });

/** A history of `n` image Reads, one tool round each, image `i` tagged `IMG<i>`. */
function history(n: number, bytes = 10): ProviderMessageLike[] {
  const out: ProviderMessageLike[] = [{ role: "user", content: [{ type: "text", text: "look" }, image("IMG0", bytes)] }];
  for (let i = 1; i < n; i++) {
    out.push({ role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "Read", input: {} }] });
    out.push({ role: "tool", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: [image(`IMG${i}`, bytes)] }] });
  }
  return out;
}

/** The tags of the images still present, in order. */
function kept(messages: readonly ProviderMessageLike[]): string[] {
  const tags: string[] = [];
  const visit = (blocks: string | ContentBlockLike[]): void => {
    if (typeof blocks === "string") return;
    for (const b of blocks) {
      if (b.type === "image") tags.push(b.source.data.replace(/=+$/, ""));
      else if (b.type === "tool_result") visit(b.content);
    }
  };
  for (const m of messages) visit(m.content);
  return tags;
}

function notes(messages: readonly ProviderMessageLike[]): number {
  return (JSON.stringify(messages).match(new RegExp(IMAGE_BUDGET_NOTE.replace(/[[\]]/g, "\\$&"), "g")) ?? []).length;
}

describe("withinImageBudget", () => {
  test("a request within budget is returned by identity", () => {
    const messages = history(3);
    expect(withinImageBudget(messages, { maxImages: 8, maxBytes: 1_000 })).toBe(messages);
  });

  test("over the COUNT: the OLDEST images become the note (nested in tool results too), the newest stay", () => {
    const out = withinImageBudget(history(9), { maxImages: 8, maxBytes: 1_000_000 });
    // 9 images, 8 allowed: 1 must go, rounded up to a step of 2 (a quarter of 8).
    expect(kept(out)).toEqual(["IMG2", "IMG3", "IMG4", "IMG5", "IMG6", "IMG7", "IMG8"]);
    expect(notes(out)).toBe(2);
  });

  test("the cache trade-off: between step boundaries the older part of the request is byte-identical", () => {
    const budget = { maxImages: 8, maxBytes: 1_000_000 };
    const nine = withinImageBudget(history(9), budget);
    const ten = withinImageBudget(history(10), budget);
    // 10 images: 2 must go -- the same 2 as with 9, so the shared prefix does not move.
    expect(kept(ten)).toEqual(["IMG2", "IMG3", "IMG4", "IMG5", "IMG6", "IMG7", "IMG8", "IMG9"]);
    expect(JSON.stringify(ten.slice(0, nine.length))).toBe(JSON.stringify(nine));
    // 11 images: the next step drops 4.
    expect(kept(withinImageBudget(history(11), budget))[0]).toBe("IMG4");
  });

  test("over the BYTES: the oldest go until the rest fits", () => {
    const out = withinImageBudget(history(6, 100), { maxImages: 100, maxBytes: 350 });
    expect(kept(out)).toEqual(["IMG3", "IMG4", "IMG5"]);
    expect(kept(out).length * 100).toBeLessThanOrEqual(350);
  });

  test("deterministic: the same history always gives the same request (a resumed session drops what the live one did)", () => {
    const budget = { maxImages: 4, maxBytes: 1_000_000 };
    expect(JSON.stringify(withinImageBudget(history(7), budget))).toBe(JSON.stringify(withinImageBudget(history(7), budget)));
  });

  test("text, tool calls and the result structure are untouched", () => {
    const out = withinImageBudget(history(3), { maxImages: 1, maxBytes: 1_000_000 });
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect((out[2]!.content as ContentBlockLike[])[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: IMAGE_BUDGET_NOTE }] });
  });
});

describe("imageBudgetFor: the documented per-request limits", () => {
  test("per provider family", () => {
    expect(imageBudgetFor({ family: "anthropic", providerId: "anthropic", contextWindow: 200_000 })).toEqual({ maxImages: 100, maxBytes: 24 * 1024 * 1024 });
    expect(imageBudgetFor({ family: "anthropic", providerId: "anthropic", contextWindow: 1_000_000 })).toEqual({ maxImages: 600, maxBytes: 24 * 1024 * 1024 });
    expect(imageBudgetFor({ family: "bedrock", providerId: "bedrock" })).toEqual({ maxImages: 20, maxBytes: 14 * 1024 * 1024 });
    expect(imageBudgetFor({ family: "google", providerId: "google" }).maxBytes).toBe(14 * 1024 * 1024);
    expect(imageBudgetFor({ family: "openai", providerId: "mistral" })).toEqual({ maxImages: 8, maxBytes: 20 * 1024 * 1024 });
    expect(imageBudgetFor({ family: "openai", providerId: "openai" })).toEqual({ maxImages: 1500, maxBytes: 256 * 1024 * 1024 });
    expect(imageBudgetFor({ family: "openai", providerId: "deepseek" })).toEqual({ maxImages: 20, maxBytes: 20 * 1024 * 1024 });
  });
});

describe("an oversized request is an OVERFLOW the engine recovers from (not an ordinary 400)", () => {
  test("413, Anthropic's request_too_large and the image-count refusals set contextOverflow", () => {
    const headers = new Headers();
    expect(normalizeHttpError(413, headers, "Request Entity Too Large").contextOverflow).toBe(true);
    expect(normalizeHttpError(413, headers, JSON.stringify({ type: "error", error: { type: "request_too_large", message: "Request exceeds the maximum allowed number of bytes." } })).contextOverflow).toBe(true);
    expect(normalizeHttpError(400, headers, JSON.stringify({ error: { message: "Too many images in request. Max is 8." } })).contextOverflow).toBe(true);
    expect(normalizeHttpError(400, headers, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.3.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels" } })).contextOverflow).toBe(true);
    // An unrelated 400 stays an ordinary bad request.
    expect(normalizeHttpError(400, headers, JSON.stringify({ error: { message: "Invalid value for temperature" } })).contextOverflow).toBeUndefined();
  });
});
