// Review r1, M-3: the guard's own proof. Each case runs a nested `bun test` on a one-test fixture that
// reaches a TEST-NET-1 address (RFC 5737, never routed) through one door, and asserts the guard failed it.
// Nothing leaves the machine: the in-process doors throw before connecting, and the proxy backstop
// answers 403 itself.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "test-network-guard.ts");

async function nested(body: string): Promise<{ code: number; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "winter-guard-proof-"));
  try {
    writeFileSync(join(dir, "door.test.ts"), `import { test } from "bun:test";\ntest("door", async () => {\n${body}\n});\n`);
    const env: Record<string, string | undefined> = { ...process.env };
    // The nested runner is a fresh test process: it must set up its own guard, not report to ours.
    for (const k of Object.keys(env)) if (k.startsWith("WINTER_TEST_NETWORK_GUARD_") || /^(https?_proxy|no_proxy)$/i.test(k)) delete env[k];
    const proc = Bun.spawn([process.execPath, "test", "--preload", GUARD, "./door.test.ts"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const [o, e, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out: o + e };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the test network guard closes the doors review r1 found open", () => {
  test("new net.Socket().connect()", async () => {
    const r = await nested(`const net = await import("node:net"); try { new net.Socket().connect(443, "192.0.2.1"); } catch {}`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("192.0.2.1");
  });

  test("Bun.fetch (unwrappable) is caught by the recording proxy", async () => {
    const r = await nested(`try { await Bun.fetch("http://192.0.2.1/"); } catch {}`);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/proxy[^\n]*192\.0\.2\.1/);
  });

  test("a child bun the test spawns, even with an empty environment", async () => {
    const r = await nested(`const p = Bun.spawn([process.execPath, "-e", "try { require('node:net').connect(443, '192.0.2.1') } catch {}"], { env: {}, stdout: "ignore", stderr: "ignore" }); await p.exited;`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("child");
    expect(r.out).toContain("192.0.2.1");
  });

  test("loopback stays open", async () => {
    const r = await nested(`const s = Bun.serve({ port: 0, fetch: () => new Response("ok") }); try { await fetch(\`http://127.0.0.1:\${s.port}/\`); } finally { s.stop(true); }`);
    expect(r.code).toBe(0);
  });
});
