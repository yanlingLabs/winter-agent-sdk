// P9a-7 (P8d-27 carry, made structural): building `winter` directly from this checkout bakes the
// developer's own home path into the compiled binary (bun's module-boundary comments name the
// source tree it compiled from). Neither test below runs a real ~two-minute compile —
// `copyCheckoutExcludingGit` is exercised against a small fixture directory, and
// `assertBinaryDoesNotEmbedPath` against fake binary files. The real wiring — that `buildRuntime()`
// actually calls these before compiling — is proven once, for real, by `bun run verify:compiled`'s
// existing run (Task S.1's own checkpoint), never re-proven here with a second full build.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBinaryDoesNotEmbedPath, copyCheckoutExcludingGit } from "./build-runtime.ts";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("copyCheckoutExcludingGit (P9a-7's path-neutral copy)", () => {
  test("copies real content but EXCLUDES .git entirely", () => {
    const src = mkdtempSync(join(tmpdir(), "build-runtime-copysrc-"));
    temps.push(src);
    mkdirSync(join(src, ".git"), { recursive: true });
    writeFileSync(join(src, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(src, "packages", "runtime", "src"), { recursive: true });
    writeFileSync(join(src, "packages", "runtime", "src", "main.ts"), "export const x = 1;\n");
    writeFileSync(join(src, "package.json"), "{}\n");

    const dest = mkdtempSync(join(tmpdir(), "build-runtime-copydest-"));
    temps.push(dest);
    copyCheckoutExcludingGit(src, dest);

    expect(existsSync(join(dest, ".git"))).toBe(false);
    expect(existsSync(join(dest, "package.json"))).toBe(true);
    expect(existsSync(join(dest, "packages", "runtime", "src", "main.ts"))).toBe(true);
  });

  test("relative symlinks inside the tree survive the copy (mirrors pnpm's own node_modules layout)", () => {
    const src = mkdtempSync(join(tmpdir(), "build-runtime-copysrc2-"));
    temps.push(src);
    mkdirSync(join(src, "node_modules", ".pnpm", "some-pkg@1.0.0", "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(join(src, "node_modules", ".pnpm", "some-pkg@1.0.0", "node_modules", "some-pkg", "index.js"), "module.exports = 1;\n");
    mkdirSync(join(src, "node_modules", "@yanlinglabs"), { recursive: true });
    spawnSync("ln", ["-s", "../.pnpm/some-pkg@1.0.0/node_modules/some-pkg", join(src, "node_modules", "@yanlinglabs", "some-pkg")]);

    const dest = mkdtempSync(join(tmpdir(), "build-runtime-copydest2-"));
    temps.push(dest);
    copyCheckoutExcludingGit(src, dest);

    const linked = join(dest, "node_modules", "@yanlinglabs", "some-pkg");
    expect(existsSync(linked)).toBe(true); // existsSync follows the symlink — proves it resolves
    expect(readdirSync(join(dest, "node_modules", "@yanlinglabs"))).toContain("some-pkg");
  });
});

describe("assertBinaryDoesNotEmbedPath (P9a-7's release-blocking gate)", () => {
  test("throws — without ever echoing the path itself — when the binary contains the checkout's absolute path", () => {
    const dir = mkdtempSync(join(tmpdir(), "build-runtime-embed-"));
    temps.push(dir);
    const secretPath = "/Users/some-developer/dev/winter-agent-sdk";
    const fake = join(dir, "fake-binary-with-path");
    writeFileSync(fake, `some binary bytes\n// ../../../../../../..${secretPath}/packages/runtime/src/main.ts\nmore bytes\n`);

    let thrown: unknown;
    try {
      assertBinaryDoesNotEmbedPath(fake, secretPath);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain(secretPath);
    expect(message).not.toContain("some-developer");
    expect(message).toContain(String(secretPath.length));
  });

  test("passes cleanly when the binary does NOT contain the checkout's path", () => {
    const dir = mkdtempSync(join(tmpdir(), "build-runtime-noembed-"));
    temps.push(dir);
    const fake = join(dir, "fake-binary-clean");
    writeFileSync(fake, "some binary bytes with no paths in it at all\n");
    expect(() => assertBinaryDoesNotEmbedPath(fake, "/Users/some-developer/dev/winter-agent-sdk")).not.toThrow();
  });

  test("works on real (non-UTF8-safe) binary bytes, not just text", () => {
    const dir = mkdtempSync(join(tmpdir(), "build-runtime-binarybytes-"));
    temps.push(dir);
    const fake = join(dir, "fake-binary-bytes");
    const secretPath = "/Users/some-developer/dev/winter-agent-sdk";
    const prefix = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0xff, 0xfe, 0xfd]); // arbitrary non-UTF8 bytes
    const body = Buffer.concat([prefix, Buffer.from(`...${secretPath}...`), Buffer.from([0x00, 0x01, 0x02])]);
    writeFileSync(fake, body);
    expect(() => assertBinaryDoesNotEmbedPath(fake, secretPath)).toThrow();
  });
});

describe("buildRuntime's mutual-exclusivity guard (no build triggered)", () => {
  test("`out` and `platformPackage` together throw before any compile is attempted", async () => {
    const { buildRuntime } = await import("./build-runtime.ts");
    await expect(buildRuntime({ out: "/tmp/x", platformPackage: true })).rejects.toThrow(/mutually exclusive/);
  });
});
