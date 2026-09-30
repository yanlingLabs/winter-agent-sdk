// Code-mode images through the REAL child-process topology: a spawned `winter` (runtime main.ts under
// bun) reads a 3.5 MB image with the real Read tool, and the host drives it through `query()` with the
// DEFAULT `maxBufferSize` (1 MiB). The image's base64 (~4.7 MB) would not fit one stdout line under that
// bound -- a `ProtocolDecodeError` would end the session -- so the tool-round frame the host receives
// carries the image block with its `data` emptied, while the model's own request (in the child) carries
// the bytes. The embedded (Worker) topology has no such bound, which is why this runs on the child leg.
import { afterAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "./query.ts";
import { defaultSpawn, type SpawnRuntimeOptions } from "./transport.ts";
import { TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_MEMORY } from "./options.ts";

const mainPath = fileURLToPath(new URL("../../runtime/src/main.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "winter-read-image-frame-"));
const home = mkdtempSync(join(tmpdir(), "winter-read-image-frame-home-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A PNG signature + IHDR (so the Read tool sniffs it as a PNG) padded to `bytes`. */
function bigPng(bytes: number): Buffer {
  const head = Buffer.from("89504e470d0a1a0a0000000d49484452000000400000003008020000000000000000", "hex");
  return Buffer.concat([head, Buffer.alloc(bytes - head.length, 7)]);
}

describe("an image Read on the child-process topology", () => {
  test("the host's tool-round frame fits the default 1 MiB line buffer: the image block arrives with its data emptied", async () => {
    const image = join(dir, "big.png");
    const bytes = bigPng(3_500_000);
    writeFileSync(image, bytes);
    // The premise: the image's base64 alone is several times the host's default line bound.
    expect(bytes.toString("base64").length).toBeGreaterThan(4 * 1024 * 1024);

    const messages: Array<Record<string, unknown>> = [];
    for await (const message of query({
      prompt: "look at big.png",
      options: {
        model: "winter-test/readimage",
        cwd: dir,
        spawnClaudeCodeProcess: (opts: SpawnRuntimeOptions) =>
          defaultSpawn({
            ...opts,
            command: process.execPath,
            args: [mainPath, ...opts.args],
            env: { ...opts.env, WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1", WINTER_TEST_READ_IMAGE: image, [TEST_KEYCHAIN_ENV]: TEST_KEYCHAIN_MEMORY },
          }),
      },
    })) {
      messages.push(message as unknown as Record<string, unknown>);
    }

    const toolRound = messages.find((m) => {
      const content = (m["message"] as { content?: unknown } | undefined)?.content;
      return m["type"] === "user" && Array.isArray(content) && (content as Array<{ type?: string }>).some((b) => b.type === "tool_result");
    });
    expect(toolRound).toBeDefined();
    expect((toolRound!["message"] as { content: unknown }).content).toEqual([
      { type: "tool_result", tool_use_id: "test-read-image", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }] },
    ]);
    const result = messages.find((m) => m["type"] === "result");
    expect(result?.["subtype"]).toBe("success");
    expect(result?.["result"]).toBe("image read done");
  }, 60_000);
});
