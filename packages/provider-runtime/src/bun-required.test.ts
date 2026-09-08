// P7a fix wave round 2 (item 3; re-review N1): THE BUN-ONLY GUARDS.
//
// `engines.node` means IMPORTABLE under Node, not runnable on every path — and the compiled emit is
// what made that distinction reachable: before it, a Node consumer failed at `import` and never got
// to a function. Now they do, so every Bun-only entry point reachable from a published barrel refuses
// with a typed `BunRequiredError` instead of a `ReferenceError: Bun is not defined` thrown from
// somewhere the caller never named.
//
// TWO LEVELS, because either alone would be a weaker claim than it looks:
//   * the PREDICATE, asserted directly here (this process IS Bun, so the guard cannot be made to fire
//     in-process without lying about the global);
//   * the REAL THING, in a `node -e` subprocess against the BUILT `dist/` — the exact artifact a
//     consumer installs, reached through the exact `default` condition they resolve. That leg also
//     re-proves the import itself works under Node, which is what `engines.node` claims.
import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunRequiredError, hasBunRuntime, requireBunRuntime } from "@yanlinglabs/winter-provider-runtime";
import { BunRequiredError as ConformanceBunRequiredError } from "@yanlinglabs/winter-conformance";
import { buildPackages } from "../../../scripts/build-packages.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("BunRequiredError / requireBunRuntime (the predicate)", () => {
  test("under Bun the guard is a no-op, and `hasBunRuntime` says so", () => {
    expect(hasBunRuntime()).toBe(true);
    expect(() => requireBunRuntime("f", "Bun.serve", "detail")).not.toThrow();
  });

  test("the error names the FUNCTION THE CALLER INVOKED, the Bun API, and what to do instead", () => {
    // The whole value over a `ReferenceError`: three facts the caller can act on. `functionName` and
    // `bunApi` are fields, not just message text, so a host can render its own message.
    const err = new BunRequiredError("startCodexLogin", "Bun.serve", "Run the login under Bun.");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BunRequiredError");
    expect(err.functionName).toBe("startCodexLogin");
    expect(err.bunApi).toBe("Bun.serve");
    expect(err.message).toContain("startCodexLogin() requires the Bun runtime");
    expect(err.message).toContain("Bun.serve");
    expect(err.message).toContain("Run the login under Bun.");
  });

  test("the two packages' errors are SEPARATE types -- catching one is not catching the other", () => {
    // Deliberate: `@yanlinglabs/winter-conformance` has no dependencies at all, so there is no module
    // both packages can reach, and a dependency edge added to share one eight-line class would be the
    // larger change. They are different packages' limits and a consumer catches the one they import.
    expect(new ConformanceBunRequiredError("runCapture", "Bun.spawn", "d")).not.toBeInstanceOf(BunRequiredError);
    expect(new ConformanceBunRequiredError("runCapture", "Bun.spawn", "d").name).toBe("BunRequiredError");
  });
});

describe("the guards fire under a REAL Node process, against the built dist", () => {
  beforeAll(async () => {
    // UNCONDITIONAL, not skip-if-present. `node` resolves the `default` condition -- `./dist/*.js` --
    // so a STALE dist is exactly the trap: this file's first run against one built before the guards
    // existed reported `ProviderRequestError` and looked like a missing guard rather than an old
    // artifact. `buildPackages()` cleans and rewrites, so building every time is the cheap correct
    // answer and the same precondition `compile-fixtures.test.ts` takes.
    await buildPackages();
  }, 240_000);

  /** Runs `code` under a REAL node, resolving the packages through the repo's own node_modules. */
  async function underNode(code: string): Promise<{ exitCode: number; out: string }> {
    const proc = Bun.spawn(["node", "--input-type=module", "-e", code], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, out: (stdout + stderr).trim() };
  }

  test("provider-runtime: `startCodexLogin` refuses with BunRequiredError, naming Bun.serve", async () => {
    const r = await underNode(`
      const m = await import("@yanlinglabs/winter-provider-runtime");
      try {
        await m.startCodexLogin({}, {});
        console.log("NO-THROW");
      } catch (e) {
        console.log(JSON.stringify({ ctor: e?.constructor?.name, name: e?.name, isTyped: e instanceof m.BunRequiredError, fn: e?.functionName, api: e?.bunApi, msg: String(e?.message ?? "") }));
      }
    `);
    expect([r.exitCode, r.out]).toEqual([0, expect.any(String)]);
    const parsed = JSON.parse(r.out) as { name: string; isTyped: boolean; fn: string; api: string; msg: string };
    expect(parsed.name).toBe("BunRequiredError");
    expect(parsed.isTyped).toBe(true); // the SAME class the barrel exports, not a look-alike
    expect(parsed.api).toBe("Bun.serve");
    expect(parsed.msg).toContain("requires the Bun runtime");
    // NOT the failure it replaces.
    expect(parsed.msg).not.toContain("Bun is not defined");
  }, 60_000);

  test("provider-runtime: `startAnthropicConsoleLogin` refuses the same way -- both logins share one guard", async () => {
    const r = await underNode(`
      const m = await import("@yanlinglabs/winter-provider-runtime");
      try { await m.startAnthropicConsoleLogin({}, {}); console.log("NO-THROW"); }
      catch (e) { console.log(JSON.stringify({ name: e?.name, isTyped: e instanceof m.BunRequiredError, api: e?.bunApi })); }
    `);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.out) as { name: string; isTyped: boolean; api: string };
    expect(parsed).toEqual({ name: "BunRequiredError", isTyped: true, api: "Bun.serve" });
  }, 60_000);

  test("provider-runtime/testing: both loopback fakes refuse", async () => {
    const r = await underNode(`
      const t = await import("@yanlinglabs/winter-provider-runtime/testing");
      const out = [];
      for (const fn of ["startXaiOauthFake", "startXaiChatFake"]) {
        try { await t[fn](); out.push([fn, "NO-THROW"]); }
        catch (e) { out.push([fn, e?.name, e instanceof t.BunRequiredError, e?.functionName]); }
      }
      console.log(JSON.stringify(out));
    `);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.out)).toEqual([
      ["startXaiOauthFake", "BunRequiredError", true, "startXaiOauthFake"],
      ["startXaiChatFake", "BunRequiredError", true, "startXaiChatFake"],
    ]);
  }, 60_000);

  test("conformance: `runCapture` refuses BEFORE it fetches or binds anything", async () => {
    // Ordering is the assertion that matters here: the guard runs first, so nothing has been
    // downloaded, no npm prefix exists and no port is bound when the caller is told.
    const r = await underNode(`
      const m = await import("@yanlinglabs/winter-conformance/official");
      try { await m.runCapture(); console.log("NO-THROW"); }
      catch (e) { console.log(JSON.stringify({ name: e?.name, isTyped: e instanceof m.BunRequiredError, fn: e?.functionName, api: e?.bunApi, msg: String(e?.message ?? "") })); }
    `);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.out) as { name: string; isTyped: boolean; fn: string; api: string; msg: string };
    expect(parsed.name).toBe("BunRequiredError");
    expect(parsed.isTyped).toBe(true);
    expect(parsed.fn).toBe("runCapture");
    expect(parsed.api).toBe("Bun.spawn and Bun.serve");
    expect(parsed.msg).toContain("capture-official-golden.ts");
  }, 60_000);

  // --- P7a fix wave r3 (F2): `instanceof` across SUBPATHS of one package, on the emit ---------------
  //
  // `build-packages.ts` runs `bun build` ONCE PER EXPORT ENTRY, so every entry bundle carries its own
  // copy of every internal module -- the class declared in one source file is TWO DISTINCT CLASSES at
  // runtime under Node. A consumer who imports the FUNCTION from one subpath and the CLASS from the
  // other (exactly what both READMEs teach) got a silent `false` and rethrew the error the guards
  // exist to make catchable. Under Bun the `bun` condition resolves both entries to the same
  // `src/*.ts`, so the classes ARE identical -- which is why no Bun-side test could see it, and why
  // this whole describe runs under real `node`.
  //
  // The fix is a package-scoped `Symbol.for` brand + `static [Symbol.hasInstance]`, and it is applied
  // to the CLASS of the problem: EVERY error class exported from more than one subpath of a package,
  // not just the one the READMEs happened to name. This test derives that set at run time, so a
  // class that gains a second subpath later is covered without editing it.
  test("F2: every class exported from BOTH entries of a package satisfies cross-entry `instanceof`", async () => {
    const r = await underNode(`
      const isClass = (v) => typeof v === "function" && /^class\\s/.test(Function.prototype.toString.call(v));
      const out = [];
      for (const [a, b] of [
        ["@yanlinglabs/winter-conformance", "@yanlinglabs/winter-conformance/official"],
        ["@yanlinglabs/winter-provider-runtime", "@yanlinglabs/winter-provider-runtime/testing"],
      ]) {
        const A = await import(a), B = await import(b);
        const shared = Object.keys(A).filter((k) => isClass(A[k]) && isClass(B[k]));
        for (const k of shared) {
          // Constructed from the SUBPATH entry's class, tested against the MAIN entry's -- the exact
          // direction a README reader takes, and the direction that used to be false.
          let inst;
          try { inst = new B[k]("fn", "Bun.serve", "detail"); } catch { inst = new B[k]("msg"); }
          out.push([a, k, B[k] === A[k], inst instanceof A[k], inst instanceof B[k]]);
        }
      }
      console.log(JSON.stringify(out));
    `);
    expect(r.exitCode, r.out).toBe(0);
    const rows = JSON.parse(r.out) as Array<[string, string, boolean, boolean, boolean]>;

    // The set really is the one the review measured -- three on conformance, one on provider-runtime.
    expect(rows.map(([pkg, cls]) => `${pkg}#${cls}`).sort()).toEqual([
      "@yanlinglabs/winter-conformance#BunRequiredError",
      "@yanlinglabs/winter-conformance#ChecksumMismatchError",
      "@yanlinglabs/winter-conformance#OfficialCompatUnavailableError",
      "@yanlinglabs/winter-provider-runtime#BunRequiredError",
    ]);
    for (const [pkg, cls, sameObject, crossEntry, ownEntry] of rows) {
      // The duplication is REAL and still there -- this test would be vacuous if the emit stopped
      // duplicating (which is the recorded `--splitting` carry), so it is asserted rather than assumed.
      expect([pkg, cls, "distinct objects", sameObject]).toEqual([pkg, cls, "distinct objects", false]);
      expect([pkg, cls, "cross-entry instanceof", crossEntry]).toEqual([pkg, cls, "cross-entry instanceof", true]);
      expect([pkg, cls, "own-entry instanceof", ownEntry]).toEqual([pkg, cls, "own-entry instanceof", true]);
    }
  }, 60_000);

  test("F2: a THROWN error is catchable through the OTHER subpath's class -- the README's own pattern", async () => {
    // The end-to-end statement, not a constructed instance: the error really thrown by a guarded
    // function imported from one subpath, matched against the class imported from the other.
    const r = await underNode(`
      const main = await import("@yanlinglabs/winter-conformance");
      const official = await import("@yanlinglabs/winter-conformance/official");
      const prMain = await import("@yanlinglabs/winter-provider-runtime");
      const prTesting = await import("@yanlinglabs/winter-provider-runtime/testing");
      const out = {};
      try { await official.runCapture(); } catch (e) { out.captureViaMainBarrel = e instanceof main.BunRequiredError; }
      try { await prTesting.startXaiOauthFake(); } catch (e) { out.fakeViaMainBarrel = e instanceof prMain.BunRequiredError; }
      try { await prMain.startCodexLogin({}, {}); } catch (e) { out.loginViaTestingBarrel = e instanceof prTesting.BunRequiredError; }
      console.log(JSON.stringify(out));
    `);
    expect(r.exitCode, r.out).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ captureViaMainBarrel: true, fakeViaMainBarrel: true, loginViaTestingBarrel: true });
  }, 60_000);

  test("F2: the brand is PACKAGE-scoped -- the two packages' classes still do not match, under Node too", async () => {
    // The property the fix must not break, asserted where it was previously only asserted in-process
    // under Bun: a `Symbol.for` key naming one package cannot be satisfied by the other's.
    const r = await underNode(`
      const c = await import("@yanlinglabs/winter-conformance");
      const p = await import("@yanlinglabs/winter-provider-runtime");
      console.log(JSON.stringify({
        conformanceInstanceVsProviderRuntimeClass: new c.BunRequiredError("f", "a", "d") instanceof p.BunRequiredError,
        providerRuntimeInstanceVsConformanceClass: new p.BunRequiredError("f", "a", "d") instanceof c.BunRequiredError,
      }));
    `);
    expect(r.exitCode, r.out).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ conformanceInstanceVsProviderRuntimeClass: false, providerRuntimeInstanceVsConformanceClass: false });
  }, 60_000);

  test("...and a NODE-SAFE export on the same barrels still works -- the guard is not a blanket refusal", async () => {
    // The control. Without it every assertion above would pass just as happily against a package that
    // threw `BunRequiredError` from everything, which is a different (and worse) bug.
    const r = await underNode(`
      const pr = await import("@yanlinglabs/winter-provider-runtime");
      const c = await import("@yanlinglabs/winter-conformance");
      const ref = pr.anthropicCredentialRef("acct-1");
      const goldens = c.listGoldens();
      console.log(JSON.stringify({ refKind: ref.kind, goldens: goldens.length > 0 }));
    `);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ refKind: "keychain", goldens: true });
  }, 60_000);
});

// --- the sweep stays complete ---------------------------------------------------------------------
//
// The guards above are worth exactly as much as the claim that they cover EVERY Bun-only path
// reachable from a published barrel. That claim was true when it was made by reading the tree; this
// makes it stay true. A new `Bun.` use in a package that declares `engines.node` fails BY NAME, and
// clearing the failure means either guarding its entry point or writing down why it needs none.
describe("every Bun API use in a Node-declaring package is accounted for", () => {
  /**
   * file -> why it is safe. Keyed on the FILE, because the guard is at that file's exported entry.
   *
   * The two `bun-required.ts` modules are deliberately ABSENT: they probe
   * `(globalThis as {Bun?: unknown}).Bun` rather than accessing `Bun.<member>`, so the scan does not
   * see them -- which is right, since reading the global to decide whether to throw is not a use of
   * a Bun API.
   */
  const ACCOUNTED: Readonly<Record<string, string>> = {
    "packages/provider-runtime/src/adapters/openai/pkce.ts": "`Bun.serve` in `runLoginFlow`, which guards first; both published logins funnel through it",
    "packages/provider-runtime/src/adapters/openai/xai-oauth.testing.ts": "`Bun.serve` in the two loopback fakes, each guarded at its own entry",
    "packages/conformance/src/official/capture.ts": "`Bun.spawn` + `Bun.serve` throughout, and `runCapture` is the file's ONLY export, guarded as its first statement",
  };

  test("the tree's Bun-using non-test files are exactly the accounted-for set", () => {
    const roots = ["packages/provider-runtime/src", "packages/conformance/src"]; // the two publishable packages declaring `engines.node` that use Bun at all
    const found: string[] = [];
    const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(next, `${rel}${entry.name}/`);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test-support.ts")) continue;
        // CODE ONLY. Whole-line comments are dropped first: eight files in these two packages carry a
        // `Bun.secrets`/`Bun.hash` mention in prose, and every one of them says the file does NOT use
        // it (`credentials/memory.ts`: "never `Bun.secrets`"). Counting those would fill this list
        // with entries whose rationale is "a comment", which is how an allowlist stops being read.
        // A line-level filter is enough here: every such mention is a `//` line or a ` * ` jsdoc
        // continuation, and a `Bun.` sharing a line with real code is not a comment at all.
        const code = readFileSync(join(REPO_ROOT, next), "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join("\n");
        if (/(?:^|[^A-Za-z_.$])Bun\.[a-zA-Z]/.test(code) || /from\s+["']bun["']/.test(code)) found.push(next);
      }
    };
    for (const root of roots) walk(root, "");
    expect(found.sort()).toEqual(Object.keys(ACCOUNTED).sort());
  });

  test("every rationale is a real sentence, and the set is not empty", () => {
    expect(Object.keys(ACCOUNTED).length).toBeGreaterThanOrEqual(3);
    for (const [file, why] of Object.entries(ACCOUNTED)) expect([file, why.length > 30]).toEqual([file, true]);
  });

  test("`@yanlinglabs/winter-provider-conformance` needs no guards -- it declares `engines.bun` and nothing else", () => {
    // The package that stands up loopback servers with `Bun.serve` throughout is Bun-only WHOLE: its
    // manifest says so, and `scripts/smoke-installed.ts`'s `runtimesFor` skips it under Node on that
    // declaration. Guarding functions in a package a Node consumer is never told they can import
    // would be noise; this pins the reason.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "packages/provider-conformance/package.json"), "utf8")) as { engines?: Record<string, string> };
    expect(manifest.engines?.["bun"]).toBeDefined();
    expect(manifest.engines?.["node"]).toBeUndefined();
  });
});
