// Review r1, M-3: the guard's own proof. Each case runs a nested `bun test` on a one-test fixture that
// reaches a TEST-NET-1 address (RFC 5737, never routed) through one door, and asserts the guard failed it.
// Nothing leaves the machine: the in-process doors throw before connecting, and the proxy backstop
// answers 403 itself.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NPM_REGISTRY_HOST, npmRegistryAccessOpen, withNpmRegistryAccess } from "./test-network-registry.ts";

const GUARD = join(import.meta.dir, "test-network-guard.ts");
const REGISTRY = join(import.meta.dir, "test-network-registry.ts");

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

  test("a reserved name (.invalid, .test) bypasses the proxy and fails at DNS, as before", async () => {
    const r = await nested(`const e = await Bun.fetch("http://winter-guard-probe.invalid/").then(() => undefined, (err) => err); if (e === undefined) throw new Error("reached something"); const t = await Bun.fetch("http://winter-guard-probe.test/").then(() => undefined, (err) => err); if (t === undefined) throw new Error("reached something");`);
    expect(r.code).toBe(0);
  });

  test("loopback stays open", async () => {
    const r = await nested(`const s = Bun.serve({ port: 0, fetch: () => new Response("ok") }); try { await fetch(\`http://127.0.0.1:\${s.port}/\`); } finally { s.stop(true); }`);
    expect(r.code).toBe(0);
  });
});

// The release CI fix: the one hole (`test-network-registry.ts`). Every case below is REFUSED before a
// byte leaves -- the positive path (a real anonymous read of the registry) is what the network legs
// themselves exercise (`smoke-installed.test.ts`, `compile-fixtures.test.ts`), under CI's flag.
describe("the npm-registry hole is one host, one call, and never a credential", () => {
  const inScope = (body: string): string => `const { withNpmRegistryAccess } = await import(${JSON.stringify(REGISTRY)});\nawait withNpmRegistryAccess(async () => {\n${body}\n});`;

  test("outside a withNpmRegistryAccess call the registry is refused like any other host", async () => {
    const r = await nested(`try { await fetch("https://${NPM_REGISTRY_HOST}/ajv"); } catch {}`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`fetch -> https://${NPM_REGISTRY_HOST}`);
  });

  test("inside one, a registry request carrying an Authorization header is refused", async () => {
    const r = await nested(inScope(`try { await fetch("https://${NPM_REGISTRY_HOST}/ajv", { headers: { Authorization: "Bearer not-a-real-token" } }); } catch {}`));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`fetch -> https://${NPM_REGISTRY_HOST}`);
  });

  test("inside one, plain http to the registry and every OTHER host stay refused", async () => {
    const http = await nested(inScope(`try { await fetch("http://${NPM_REGISTRY_HOST}/ajv"); } catch {}`));
    expect(http.code).not.toBe(0);
    expect(http.out).toContain(`fetch -> http://${NPM_REGISTRY_HOST}`);
    const other = await nested(inScope(`try { await fetch("https://192.0.2.1/"); } catch {}`));
    expect(other.code).not.toBe(0);
    expect(other.out).toContain("192.0.2.1");
  });

  test("the environment a child inherits carries no registry credential, and is restored afterwards", async () => {
    const planted: Record<string, string> = {
      NODE_AUTH_TOKEN: "planted-node-auth-token",
      NPM_TOKEN: "planted-npm-token",
      NPM_CONFIG_USERCONFIG: "/nonexistent/planted-npmrc",
      "npm_config_//registry.npmjs.org/:_authToken": "planted-config-token",
    };
    // Read by NAME, never by enumerating: Bun 1.3 leaves a proxy variable that was absent at startup and
    // set later (the guard's own) out of `Object.keys(process.env)`, while 1.4 lists it.
    const watched = [...Object.keys(planted), "npm_config_userconfig", "npm_config_globalconfig", "npm_config_registry", "NO_PROXY", "no_proxy", "HTTPS_PROXY"];
    const read = (): Record<string, string | undefined> => Object.fromEntries(watched.map((name) => [name, process.env[name]]));
    const before = read();
    Object.assign(process.env, planted);
    try {
      const seen = await withNpmRegistryAccess(async () => {
        expect(npmRegistryAccessOpen()).toBe(true);
        for (const name of ["npm_config_userconfig", "npm_config_globalconfig"]) expect(readFileSync(process.env[name]!, "utf8")).toBe(""); // removed when the call settles
        expect(Object.values({ ...process.env }).some((v) => typeof v === "string" && v.startsWith("planted-"))).toBe(false);
        return read();
      });
      for (const name of Object.keys(planted)) expect(seen[name]).toBeUndefined();
      expect(seen["npm_config_globalconfig"]).toBeString();
      expect(seen["npm_config_globalconfig"]).not.toBe(seen["npm_config_userconfig"]); // npm refuses one file as both
      expect(seen["npm_config_registry"]).toBe(`https://${NPM_REGISTRY_HOST}/`);
      expect(seen["NO_PROXY"]!.split(",")).toContain(NPM_REGISTRY_HOST);
      expect(seen["no_proxy"]!.split(",")).toContain(NPM_REGISTRY_HOST);
      expect(seen["HTTPS_PROXY"]).toBe(before["HTTPS_PROXY"]); // every OTHER host still goes to the recording proxy
      // Afterwards: the scope is closed, and every variable is back as it was (planted ones included).
      expect(npmRegistryAccessOpen()).toBe(false);
      expect(read()).toEqual({ ...before, ...planted });
    } finally {
      for (const name of Object.keys(planted)) delete process.env[name];
    }
    expect(read()).toEqual(before);
  });
});
