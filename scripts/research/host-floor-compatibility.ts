// Disposable native compatibility measurement. No real homes, projects, credentials or browser
// profiles. Run from the SDK root: bun scripts/research/host-floor-compatibility.ts <output-dir>
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyMandatoryFloorToSpawnOptions, buildMandatoryFloorProfile, type HostExecutionFloor } from "../../packages/sdk/src/mandatory-floor.ts";

const output = resolve(process.argv[2] ?? "docs/research/2026-10-12-host-floor-compatibility-evidence");
const sourcekitOnly = process.argv.includes("--sourcekit-only");
mkdirSync(output, { recursive: true });
const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-host-floor-compat-")));
const protectedDir = join(root, "protected"), secret = join(protectedDir, "synthetic.txt");
mkdirSync(protectedDir);
writeFileSync(secret, "synthetic-floor-needle");
const floor: HostExecutionFloor = { denyReadPaths: [protectedDir], denyWritePaths: [protectedDir], protectAncestorsOf: [protectedDir] };
const profile = buildMandatoryFloorProfile(floor);
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const sdkCommit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 }).trim();
writeFileSync(join(output, "floor.sb"), profile + "\n");
const rows: unknown[] = [];
const runtimeBinary = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell");

function fixture(label: string) {
  const cwd = join(root, label), home = join(cwd, "home"), temp = join(cwd, "tmp");
  for (const path of [cwd, home, temp]) mkdirSync(path, { recursive: true });
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", HOME: home, CFFIXED_USER_HOME: home, TMPDIR: temp,
    XDG_CACHE_HOME: join(home, ".cache"), XDG_CONFIG_HOME: join(home, ".config"), CLANG_MODULE_CACHE_PATH: join(cwd, "clang-cache"), SWIFTPM_MODULECACHE_OVERRIDE: join(cwd, "swift-module-cache") };
  return { cwd, home, env };
}
function swiftPackage(cwd: string, probe = false) {
  mkdirSync(join(cwd, "Sources", "FloorFixture"), { recursive: true });
  mkdirSync(join(cwd, "Tests", "FloorFixtureTests"), { recursive: true });
  writeFileSync(join(cwd, "Package.swift"), `// swift-tools-version: 6.0
import PackageDescription
${probe ? `import Foundation
let readAllowed = (try? String(contentsOfFile: ${JSON.stringify(secret)}, encoding: .utf8)) != nil
let writeAllowed = (try? "modified".write(toFile: ${JSON.stringify(secret)}, atomically: false, encoding: .utf8)) != nil
let report = "readAllowed=\\(readAllowed),writeAllowed=\\(writeAllowed)"
try? report.write(toFile: ${JSON.stringify(join(cwd, "manifest-probe.txt"))}, atomically: false, encoding: .utf8)
` : ""}
let package = Package(name: "FloorFixture", products: [.library(name: "FloorFixture", targets: ["FloorFixture"])], targets: [.target(name: "FloorFixture"), .testTarget(name: "FloorFixtureTests", dependencies: ["FloorFixture"])])
`);
  writeFileSync(join(cwd, "Sources", "FloorFixture", "Fixture.swift"), "public func fixtureSum(_ a: Int, _ b: Int) -> Int { a + b }\n");
  writeFileSync(join(cwd, "Tests", "FloorFixtureTests", "FixtureTests.swift"), `import XCTest
@testable import FloorFixture
final class FixtureTests: XCTestCase { func testSum() { XCTAssertEqual(fixtureSum(2, 3), 5) } }
`);
}
async function run(label: string, command: string, args: string[], f: ReturnType<typeof fixture>, floored: boolean, timeoutMs = 60000) {
  const raw = { command, args, cwd: f.cwd, env: f.env };
  const actual = floored ? applyMandatoryFloorToSpawnOptions(raw, floor) : raw;
  const started = Date.now();
  let stdout = "", stderr = "", timedOut = false, outputExceeded = false, alive = true;
  const child = spawn(actual.command, actual.args, { cwd: f.cwd, env: f.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const stop = () => { if (alive && child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  child.stdout.on("data", chunk => { stdout += chunk.toString(); if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 262144) { outputExceeded = true; stop(); } });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 262144) { outputExceeded = true; stop(); } });
  const status = await new Promise<{ code: number | null; signal: string | null; spawnError?: string }>(done => {
    child.once("error", error => done({ code: null, signal: null, spawnError: error.message }));
    child.once("exit", () => { alive = false; clearTimeout(timer); });
    child.once("close", (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer);
  const row = { label, floored, command, args, cwd: f.cwd, env: f.env, ...status, timedOut, outputExceeded, durationMs: Date.now() - started,
    ...(existsSync(join(f.cwd, "manifest-probe.txt")) ? { manifestProbe: readFileSync(join(f.cwd, "manifest-probe.txt"), "utf8") } : {}),
    stdout, stderr, stdoutSha256: hash(stdout), stderrSha256: hash(stderr), ...(floored ? { profileSha256: hash(profile) } : {}) };
  rows.push(row);
  writeFileSync(join(output, `${label}.stdout.txt`), stdout);
  writeFileSync(join(output, `${label}.stderr.txt`), stderr);
  writeFileSync(join(output, "results.json"), JSON.stringify({ sdkCommit, floorSourceSha256: hash(readFileSync(new URL("../../packages/sdk/src/mandatory-floor.ts", import.meta.url))), fixtureRoot: root, protectedDir, floor, profileSha256: hash(profile), savedProfileSha256: hash(profile + "\n"), rows }, null, 2) + "\n");
  console.log(JSON.stringify({ label, code: status.code, signal: status.signal, timedOut, durationMs: row.durationMs, stdoutTail: stdout.slice(-600), stderrTail: stderr.slice(-1600) }));
  return row;
}

console.log(JSON.stringify({ fixtureRoot: root, output, profileSha256: hash(profile) }));
if (!sourcekitOnly) for (const floored of [false, true]) {
  const f = fixture(`floor-probe-${floored ? "floor" : "control"}`);
  await run(`floor-probe-${floored ? "floor" : "control"}`, "/bin/sh", ["-c", `cat '${secret}'; printf changed > '${secret}'`], f, floored, 5000);
}
// Restore the synthetic source after the ordinary positive write control.
writeFileSync(secret, "synthetic-floor-needle");
if (!sourcekitOnly) for (const operation of ["build", "test"]) {
  for (const floored of [false, true]) {
    const label = `swift-${operation}-${floored ? "floor" : "control"}`, f = fixture(label);
    swiftPackage(f.cwd);
    const args = [operation, "--package-path", f.cwd, "--scratch-path", join(f.cwd, ".build"), "--cache-path", join(f.cwd, "swift-cache"),
      "--config-path", join(f.cwd, "swift-config"), "--security-path", join(f.cwd, "swift-security"), "--disable-keychain", "--disable-netrc", "--disable-prefetching", "--disable-experimental-prebuilts", "--jobs", "2"];
    await run(label, "/usr/bin/swift", args, f, floored);
  }
  for (const floored of [false, true]) {
    const label = `swift-${operation}-disable-sandbox-${floored ? "floor" : "control"}`, f = fixture(label);
    writeFileSync(secret, "synthetic-floor-needle");
    swiftPackage(f.cwd, true);
    const args = [operation, "--disable-sandbox", "--package-path", f.cwd, "--scratch-path", join(f.cwd, ".build"), "--cache-path", join(f.cwd, "swift-cache"),
      "--config-path", join(f.cwd, "swift-config"), "--security-path", join(f.cwd, "swift-security"), "--disable-keychain", "--disable-netrc", "--disable-prefetching", "--disable-experimental-prebuilts", "--jobs", "2"];
    await run(label, "/usr/bin/swift", args, f, floored);
    writeFileSync(secret, "synthetic-floor-needle");
  }
}
if (!sourcekitOnly && existsSync(runtimeBinary)) {
  for (const variant of ["default", "disable-gpu-sandbox", "no-sandbox", "no-sandbox-protected-file"]) {
  for (const floored of [false, true]) {
    const label = `chromium-${variant}-${floored ? "floor" : "control"}`, f = fixture(label), page = join(f.cwd, "page.html");
    writeFileSync(page, '<!doctype html><title>Floor fixture</title><p id="proof">headless-fixture-ready</p>');
    const args = ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-domain-reliability",
      "--disable-sync", "--disable-default-apps", "--disable-extensions", "--metrics-recording-only", "--safebrowsing-disable-auto-update", "--use-mock-keychain", "--password-store=basic",
      "--host-resolver-rules=MAP * ~NOTFOUND", ...(variant === "disable-gpu-sandbox" ? ["--disable-gpu-sandbox"] : variant.startsWith("no-sandbox") ? ["--no-sandbox"] : []),
      `--user-data-dir=${join(f.cwd, "browser-profile")}`, "--dump-dom", `file://${variant === "no-sandbox-protected-file" ? secret : page}`];
    await run(label, runtimeBinary, args, f, floored, 15000);
  }
  }
}
if (sourcekitOnly) {
  for (const disableSandbox of [false, true]) {
    for (const floored of [false, true]) {
      const label = `sourcekit-index-${disableSandbox ? "disable-sandbox" : "default"}-${floored ? "floor" : "control"}`, f = fixture(label);
      swiftPackage(f.cwd);
      const configDir = join(f.cwd, ".sourcekit-lsp"); mkdirSync(configDir);
      writeFileSync(join(configDir, "config.json"), JSON.stringify({ swiftPM: { disableSandbox, scratchPath: join(f.cwd, ".build"),
        extraArguments: ["--disable-keychain", "--disable-netrc", "--disable-prefetching", "--disable-experimental-prebuilts", "--jobs", "2", "--cache-path", join(f.cwd, "swift-cache"), "--config-path", join(f.cwd, "swift-config"), "--security-path", join(f.cwd, "swift-security")] } }));
      await run(label, "/usr/bin/sourcekit-lsp", ["debug", "index", "--project", f.cwd], f, floored, 30000);
    }
  }
}
console.log(JSON.stringify({ complete: true, rows: rows.length, fixtureRoot: root, protectedSourceUnchanged: readFileSync(secret, "utf8") === "synthetic-floor-needle" }));
