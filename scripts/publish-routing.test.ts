// P7a pre-publish round 3 (review C1 + C2): WHERE DOES EACH PUBLISH ACTUALLY GO?
//
// THE FINDING THIS EXISTS FOR. `--registry https://registry.npmjs.org` on the command line does NOT
// decide where a `@yanlinglabs/*` package is published: `--registry` sets `registries.default`, and
// both pnpm (`pickRegistryForPackage`) and npm (`npm-registry-fetch`'s `pickRegistry`) consult the
// SCOPE binding first. With `@yanlinglabs:registry=https://npm.pkg.github.com` committed in the
// project `.npmrc` -- as it was -- every "npm" publish went to GitHub Packages. Nothing reached npm,
// and no test could see it, because every assertion read the workflow's YAML text.
//
// So this asserts the BEHAVIOUR, and does it with no network: `npm publish <tarball> --dry-run`
// resolves its target registry, prints `Publishing to <url> …`, and exits without uploading. Each
// case reproduces one job's exact configuration -- the env and a temp userconfig written the way
// `actions/setup-node` writes one (`@scope:registry` + `//<host>/:_authToken`, `NPM_CONFIG_USERCONFIG`
// pointing at it) -- and reads the line back.
//
// THE TARBALLS COME FROM `pnpm pack`, through `releasePack()`, because the published manifest is
// dist-only via `publishConfig` overrides that plain `npm pack` ignores. Packing any other way here
// would test a manifest the release never produces.
//
// OPT-IN: `releasePack()` packs five packages (~4 s) and each dry-run reads a tarball. Gated on the
// same harness variable as every other packaging leg, and CI sets `CI` so it always runs there.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePack, type PackedPackage } from "./release-pack.ts";
import { npmPublishOrder, npmPublishSet } from "./npm-publish-set.ts";

const ENABLED = (process.env["CI"] ?? "") !== "" || process.env["WINTER_TEST_PACK_SMOKE"] === "1";
if (!ENABLED) {
  console.log(
    "[publish-routing] SKIPPING the dry-run routing gate (it packs all five packages). " +
      "Run it with WINTER_TEST_PACK_SMOKE=1 bun test scripts/publish-routing.test.ts; CI always runs it.",
  );
}

const GITHUB_PACKAGES = "https://npm.pkg.github.com";
const NPMJS = "https://registry.npmjs.org";

/**
 * A userconfig in the shape `actions/setup-node` writes when given `registry-url` + `scope`.
 *
 * Both lines matter and they are why the workflow uses setup-node rather than a committed file: ONE
 * mechanism binds the scope to a registry AND supplies that registry's credential, per job. A
 * committed `.npmrc` can only ever pin one, globally, and there are two registries.
 */
function setupNodeUserconfig(dir: string, registryUrl: string, scope = "@yanlinglabs"): string {
  // BYTE-FAITHFUL to `actions/setup-node@v4` (review N1). Its `auth-util` normalises the registry to a
  // TRAILING SLASH, writes the scope line first, then `always-auth=false`, then the auth line keyed on
  // the slash-terminated URL with the token as the literal `${NODE_AUTH_TOKEN}` for npm to expand from
  // the environment. Round 3 wrote no trailing slash, a literal token and no `always-auth`; the
  // conclusions were the same (the reviewer re-ran every case against the real bytes), but a gate whose
  // entire point is fidelity to setup-node should write setup-node's bytes.
  const withSlash = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  const host = withSlash.replace(/^https?:/, "");
  const path = join(dir, ".npmrc");
  writeFileSync(path, `${scope}:registry=${withSlash}\nalways-auth=false\n${host}:_authToken=\${NODE_AUTH_TOKEN}\n`);
  return path;
}

/** `npm publish <tarball> --dry-run` under one userconfig; returns the `Publishing to …` line. */
async function dryRunTarget(tarballPath: string, userconfig: string, extraArgs: string[] = []): Promise<string> {
  const proc = Bun.spawn(["npm", "publish", tarballPath, "--dry-run", ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NPM_CONFIG_USERCONFIG: userconfig, NODE_AUTH_TOKEN: "test-token-not-a-credential" },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const line = (stdout + stderr).split("\n").find((l) => l.includes("Publishing to"));
  return line ?? `NO "Publishing to" LINE:\n${stdout}${stderr}`;
}

describe.skipIf(!ENABLED)("publish routing: each job reaches its own registry (review C1/C2)", () => {
  let outDir: string;
  let packed: PackedPackage[];
  let scratch: string;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), "winter-routing-pack-"));
    scratch = mkdtempSync(join(tmpdir(), "winter-routing-cfg-"));
    const result = await releasePack({ outDir });
    expect(result.violations).toEqual([]);
    packed = result.packages;
  }, 300_000);
  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  test("job 1's config sends EVERY publishable package to GitHub Packages", async () => {
    const dir = mkdtempSync(join(scratch, "gh-"));
    const userconfig = setupNodeUserconfig(dir, GITHUB_PACKAGES);
    expect(packed).toHaveLength(5);
    for (const pkg of packed) {
      const line = await dryRunTarget(pkg.tarballPath, userconfig);
      expect([pkg.name, line.includes(GITHUB_PACKAGES)]).toEqual([pkg.name, true]);
      expect([pkg.name, line.includes(NPMJS)]).toEqual([pkg.name, false]);
    }
  }, 300_000);

  test("r4 (I1): the npm set publishes in TOPOLOGICAL order -- the dependency's line comes first", async () => {
    // The finding: the plan was alphabetical, so `winter-agent-sdk` reached npm BEFORE
    // `winter-provider-catalog`, the dependency its own packed manifest pins at that exact version --
    // and for that interval `npm install @yanlinglabs/winter-agent-sdk` 404'd on the dependency, on a
    // registry from which the version can never be withdrawn.
    //
    // Asserted on the ORDER OF THE DRY-RUN LINES, not on the array: this is the sequence a real run
    // would produce, one step short of the upload.
    const dir = mkdtempSync(join(scratch, "order-"));
    const userconfig = setupNodeUserconfig(dir, NPMJS);
    const order = npmPublishOrder().map((p) => p.name);
    const lines: string[] = [];
    for (const name of order) {
      const pkg = packed.find((p) => p.name === name)!;
      lines.push(`${name} :: ${await dryRunTarget(pkg.tarballPath, userconfig, ["--access", "public"])}`);
    }
    // R-7b-5 took this from two lines to five. Asserted as a PROPERTY of the order rather than by
    // position: every package's line must come AFTER the line of each of its in-set workspace
    // dependencies, read from the PACKED manifests (which is where the exact-version pin that makes
    // the order load-bearing actually lives). Position assertions would have to be rewritten every
    // time the set grows, and rewriting an order assertion is exactly how one stops being checked.
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line).toContain(NPMJS);
    const indexOf = (name: string): number => lines.findIndex((l) => l.startsWith(`${name} ::`));
    for (const name of order) {
      const dir = mkdtempSync(join(scratch, "packed-"));
      const proc = Bun.spawn(["tar", "-xzf", packed.find((p) => p.name === name)!.tarballPath, "-C", dir], { stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(0);
      const manifest = JSON.parse(readFileSync(join(dir, "package", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (indexOf(dep) === -1) continue; // not in the npm set -- a different problem, caught by release-gates
        expect([name, dep, indexOf(dep) < indexOf(name)]).toEqual([name, dep, true]);
      }
    }

    // ...and the sdk really does pin the catalog at this exact version in its PACKED manifest, which
    // is what makes the order load-bearing rather than cosmetic. (The loop above already proves this
    // for every edge; this keeps the ORIGINAL finding's own pair named, since it is the one that
    // actually 404'd.)
    const dirSdk = mkdtempSync(join(scratch, "manifest-"));
    const sdk = packed.find((p) => p.name === "@yanlinglabs/winter-agent-sdk")!;
    const proc = Bun.spawn(["tar", "-xzf", sdk.tarballPath, "-C", dirSdk], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dirSdk, "package", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).toContain("@yanlinglabs/winter-provider-catalog");
  }, 300_000);

  test("job 2's config sends the npm set -- and only it -- to npmjs, with public access", async () => {
    const dir = mkdtempSync(join(scratch, "npm-"));
    const userconfig = setupNodeUserconfig(dir, NPMJS);
    const npmNames = new Set(npmPublishSet().map((p) => p.name));
    expect(npmNames.size).toBe(5); // R-7b-5: the wrapper's closure plus the two harness roots and what they pull in
    for (const pkg of packed.filter((p) => npmNames.has(p.name))) {
      // `--access public` because `publishConfig.access` stays `restricted` (GitHub Packages'
      // setting) and npm filters a `publishConfig` key that is also a CLI flag.
      const line = await dryRunTarget(pkg.tarballPath, userconfig, ["--access", "public"]);
      expect([pkg.name, line.includes(NPMJS)]).toEqual([pkg.name, true]);
      expect([pkg.name, line.includes(GITHUB_PACKAGES)]).toEqual([pkg.name, false]);
      expect([pkg.name, line.includes("public access")]).toEqual([pkg.name, true]);
    }
  }, 300_000);

  test("THE NEGATIVE: a scope pin in the project `.npmrc` HIJACKS the npm job -- which is why there is none", async () => {
    // The measured cause of C1, reproduced. A project-level `@yanlinglabs:registry` pointing at
    // GitHub Packages beats the job's own npmjs binding, and every "npm" publish silently lands on
    // the wrong registry with the wrong credential. Run from a directory carrying such a file, with
    // the SAME userconfig the passing case above uses -- the only difference is the project file.
    const dir = mkdtempSync(join(scratch, "hijack-"));
    const userconfig = setupNodeUserconfig(dir, NPMJS);
    const projectDir = mkdtempSync(join(scratch, "project-"));
    writeFileSync(join(projectDir, ".npmrc"), `@yanlinglabs:registry=${GITHUB_PACKAGES}\n`);
    const sdk = packed.find((p) => p.name === "@yanlinglabs/winter-agent-sdk")!;

    const proc = Bun.spawn(["npm", "publish", sdk.tarballPath, "--dry-run", "--access", "public"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NPM_CONFIG_USERCONFIG: userconfig, NODE_AUTH_TOKEN: "test-token-not-a-credential" },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const line = (stdout + stderr).split("\n").find((l) => l.includes("Publishing to")) ?? "";
    expect(line).toContain(GITHUB_PACKAGES); // the hijack, demonstrated
    expect(line).not.toContain(NPMJS);
  }, 120_000);

  test("...and THIS repository's committed `.npmrc` carries no such pin, so the hijack cannot happen here", async () => {
    // The positive control on the negative: same userconfig, run from the REPO ROOT. If anyone
    // re-adds a scope line to `.npmrc`, this flips and names the file.
    const dir = mkdtempSync(join(scratch, "repo-"));
    const userconfig = setupNodeUserconfig(dir, NPMJS);
    const sdk = packed.find((p) => p.name === "@yanlinglabs/winter-agent-sdk")!;
    const proc = Bun.spawn(["npm", "publish", sdk.tarballPath, "--dry-run", "--access", "public"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NPM_CONFIG_USERCONFIG: userconfig, NODE_AUTH_TOKEN: "test-token-not-a-credential" },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const line = (stdout + stderr).split("\n").find((l) => l.includes("Publishing to")) ?? "";
    expect(line, "the project .npmrc must not pin the @yanlinglabs scope -- see its own header").toContain(NPMJS);
  }, 120_000);
});
