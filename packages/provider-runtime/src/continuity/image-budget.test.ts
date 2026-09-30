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

  test("over the BYTES: the oldest go, rounded up to a whole step, and never the newest", () => {
    // 6 images of 100 bytes, 350 allowed: 3 must go, rounded up to a step of 4 (a quarter of 100, at most 4).
    const out = withinImageBudget(history(6, 100), { maxImages: 100, maxBytes: 350 });
    expect(kept(out)).toEqual(["IMG4", "IMG5"]);
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
  test("per provider", () => {
    const MiB = 1024 * 1024;
    expect(imageBudgetFor({ family: "anthropic", providerId: "anthropic", contextWindow: 200_000 })).toEqual({ maxImages: 100, maxBytes: 24 * MiB });
    expect(imageBudgetFor({ family: "anthropic", providerId: "console", contextWindow: 1_000_000 })).toEqual({ maxImages: 600, maxBytes: 24 * MiB });
    // A Claude row whose window is unknown gets the SAFE count.
    expect(imageBudgetFor({ family: "anthropic", providerId: "anthropic" })).toEqual({ maxImages: 100, maxBytes: 24 * MiB });
    // Anthropic-DIALECT third parties publish none of Claude's limits.
    for (const providerId of ["deepseek-anthropic", "kimi-coding", "minimax-anthropic", "zai-anthropic"]) {
      expect(imageBudgetFor({ family: "anthropic", providerId, contextWindow: 1_000_000 })).toEqual({ maxImages: 20, maxBytes: 20 * MiB });
    }
    expect(imageBudgetFor({ family: "bedrock", providerId: "bedrock" })).toEqual({ maxImages: 20, maxBytes: 14 * MiB });
    expect(imageBudgetFor({ family: "google", providerId: "google" }).maxBytes).toBe(14 * MiB);
    expect(imageBudgetFor({ family: "openai", providerId: "mistral" })).toEqual({ maxImages: 8, maxBytes: 20 * MiB });
    expect(imageBudgetFor({ family: "openai", providerId: "codestral" })).toEqual({ maxImages: 8, maxBytes: 20 * MiB });
    expect(imageBudgetFor({ family: "openai", providerId: "openai" })).toEqual({ maxImages: 1500, maxBytes: 256 * MiB });
    expect(imageBudgetFor({ family: "openai", providerId: "azure-openai" })).toEqual({ maxImages: 50, maxBytes: 20 * MiB });
    for (const providerId of ["codex-oauth", "deepseek", "xai", "ollama-local"]) expect(imageBudgetFor({ family: "openai", providerId })).toEqual({ maxImages: 20, maxBytes: 20 * MiB });
  });
});

describe("the review's probes: a growing history never loses the newest image, and a dropped image never comes back", () => {
  const MiB = 1024 * 1024;
  const cases: Array<{ name: string; budget: { maxImages: number; maxBytes: number }; imageBytes: number }> = [
    { name: "Gemini: 14 MiB of 5 MiB images (byte-limited)", budget: imageBudgetFor({ family: "google", providerId: "google" }), imageBytes: 5 * MiB },
    { name: "Claude: 24 MiB of 3 MiB images (byte-limited)", budget: imageBudgetFor({ family: "anthropic", providerId: "anthropic", contextWindow: 200_000 }), imageBytes: 3 * MiB },
    { name: "Mistral: 8 small images (count-limited)", budget: imageBudgetFor({ family: "openai", providerId: "mistral" }), imageBytes: 1_000 },
    { name: "Claude 200k: 100 small images (count-limited)", budget: imageBudgetFor({ family: "anthropic", providerId: "anthropic", contextWindow: 200_000 }), imageBytes: 1_000 },
  ];
  for (const { name, budget, imageBytes } of cases) {
    test(name, () => {
      let previousDrop = 0;
      for (let n = 1; n <= 130; n++) {
        const out = withinImageBudget(history(n, imageBytes), budget);
        const left = kept(out);
        const drop = n - left.length;
        // The newest image fits on its own, so it is ALWAYS still there.
        expect(left.at(-1)).toBe(`IMG${n - 1}`);
        expect(left.length).toBeGreaterThanOrEqual(1);
        // What is kept fits.
        expect(left.length).toBeLessThanOrEqual(budget.maxImages);
        expect(left.length * imageBytes).toBeLessThanOrEqual(budget.maxBytes);
        // Monotonic: never fewer dropped than with a shorter history -- nothing comes back.
        expect(drop).toBeGreaterThanOrEqual(previousDrop);
        previousDrop = drop;
      }
    });
  }

  test("an image too big for the budget on its own is dropped too (nothing can make it fit)", () => {
    const out = withinImageBudget(history(2, 100), { maxImages: 10, maxBytes: 50 });
    expect(kept(out)).toEqual([]);
  });
});

describe("refusals the engine can recover from, classified off the PARSED message only", () => {
  const headers = new Headers();
  const anthropic = (status: number, type: string, message: string) => normalizeHttpError(status, headers, JSON.stringify({ type: "error", error: { type, message } }));

  test("image refusals set imageOverflow (not contextOverflow): too many images, the many-image dimension limit, Azure's image count", () => {
    const manyImage = anthropic(400, "invalid_request_error", "messages.3.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels");
    expect(manyImage.imageOverflow).toBe(true);
    expect(manyImage.contextOverflow).toBeUndefined();
    expect(normalizeHttpError(400, headers, JSON.stringify({ error: { message: "Too many images in request. Max is 8." } })).imageOverflow).toBe(true);
    expect(normalizeHttpError(400, headers, JSON.stringify({ error: { message: "Exceeded maximum number of images (50) allowed in a request." } })).imageOverflow).toBe(true);
  });

  test("a 413 is an overflow only when the provider says the request is too large -- never a bare 413", () => {
    expect(anthropic(413, "request_too_large", "Request exceeds the maximum allowed number of bytes.").contextOverflow).toBe(true);
    expect(normalizeHttpError(413, headers, JSON.stringify({ message: "Request payload is too large" })).contextOverflow).toBe(true);
    expect(normalizeHttpError(413, headers, "Request Entity Too Large").contextOverflow).toBeUndefined();
    expect(normalizeHttpError(413, headers, "").contextOverflow).toBeUndefined();
  });

  test("the RAW body never trips a classifier: a phrase outside the message (an echoed field) is ignored", () => {
    const echoed = JSON.stringify({ error: { message: "Invalid value for temperature" }, request: { note: "too many images; maximum context length is 5" } });
    const result = normalizeHttpError(400, headers, echoed);
    expect(result.imageOverflow).toBeUndefined();
    expect(result.contextOverflow).toBeUndefined();
    // A count phrasing WITHOUT the word image is not an image refusal.
    expect(normalizeHttpError(400, headers, JSON.stringify({ error: { message: "maximum number of tools exceeded" } })).imageOverflow).toBeUndefined();
  });

  test("the context-overflow phrasings every vendor actually sends -- one each", () => {
    const cases: Array<[string, number, string]> = [
      ["Gemini", 400, JSON.stringify({ error: { code: 400, message: "The input token count (461428) exceeds the maximum number of tokens allowed (131072).", status: "INVALID_ARGUMENT" } })],
      ["Bedrock", 400, JSON.stringify({ message: "Input is too long for requested model." })],
      ["Claude (API / Bedrock)", 400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } })],
      ["Mistral", 400, JSON.stringify({ object: "error", message: "Prompt contains 65000 tokens and 0 draft tokens, too large for model with 32768 maximum context length", type: "invalid_request_error" })],
      ["Kimi", 400, JSON.stringify({ error: { message: "Invalid request: Your request exceeded model token limit: 262144", type: "invalid_request_error" } })],
      ["llama.cpp", 400, JSON.stringify({ error: { code: 400, message: "request (33056 tokens) exceeds the available context size (32768 tokens), try increasing it", type: "exceed_context_size_error", n_prompt_tokens: 33056, n_ctx: 32768 } })],
    ];
    for (const [vendor, status, body] of cases) expect({ vendor, overflow: normalizeHttpError(status, headers, body).contextOverflow }).toEqual({ vendor, overflow: true });
  });

  test("the message is found in every body shape: a JSON array, `detail`, `errors[0].message`", () => {
    expect(normalizeHttpError(400, headers, JSON.stringify([{ error: { code: 400, message: "The input token count (2551556) exceeds the maximum number of tokens allowed (1048576).", status: "INVALID_ARGUMENT" } }])).contextOverflow).toBe(true);
    expect(normalizeHttpError(400, headers, JSON.stringify({ detail: "This model's maximum context length is 8192 tokens." })).contextOverflow).toBe(true);
    expect(normalizeHttpError(400, headers, JSON.stringify({ detail: { message: "Too many images in request" } })).imageOverflow).toBe(true);
    expect(normalizeHttpError(400, headers, JSON.stringify({ errors: [{ message: "Too many images: maximum number of images is 8" }] })).imageOverflow).toBe(true);
  });

  test("an unrelated 400 stays an ordinary bad request", () => {
    const result = normalizeHttpError(400, headers, JSON.stringify({ error: { message: "Invalid value for temperature" } }));
    expect(result.contextOverflow).toBeUndefined();
    expect(result.imageOverflow).toBeUndefined();
  });
});
