// Measure the requested repository's actual SDK command execution layer; no outer persistent
// floor and no tool sandbox workarounds. Every child receives a disposable explicit environment.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sdkRoot = resolve(process.argv[2]!);
const output = resolve(process.argv[3]!);
const candidate = process.argv.includes("--candidate");
const extraOnly = process.argv.includes("--extra-only");
const playwrightAt = process.argv.indexOf("--playwright-entry");
const playwrightEntry = playwrightAt === -1 ? undefined : resolve(process.argv[playwrightAt + 1]!);
const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-code-policy-compat-")));
mkdirSync(output, { recursive: true });
const hash = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
const commit = execFileSync("/usr/bin/git", ["-C", sdkRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const { runCommand } = await import(pathToFileURL(join(sdkRoot, "packages/runtime/src/sandbox/spawn.ts")).href);
const protectedDir = join(root, "cowork"), protectedData = join(protectedDir, "data.ext4");
mkdirSync(protectedDir); writeFileSync(protectedData, "synthetic-ciphertext-marker");
const lease = candidate ? (await import(pathToFileURL(join(sdkRoot, "packages/runtime/src/sandbox/host-code-protection.ts")).href)).installHostCodeProtection({ revision: 1, denyReadPaths: [protectedDir], denyWritePaths: [protectedDir] }) : undefined;
const rows: unknown[] = [];
const browser = join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
function fixture(label: string) {
  const cwd = join(root, label), home = join(cwd, "home"), temp = join(cwd, "tmp");
  for (const path of [cwd, home, temp]) mkdirSync(path, { recursive: true });
  return { cwd, home, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, CFFIXED_USER_HOME: home, TMPDIR: temp,
    XDG_CACHE_HOME: join(home, ".cache"), XDG_CONFIG_HOME: join(home, ".config"), CLANG_MODULE_CACHE_PATH: join(cwd, "clang-cache"), SWIFTPM_MODULECACHE_OVERRIDE: join(cwd, "swift-module-cache") } };
}
function swiftPackage(cwd: string) {
  mkdirSync(join(cwd, "Sources", "PolicyFixture"), { recursive: true }); mkdirSync(join(cwd, "Tests", "PolicyFixtureTests"), { recursive: true });
  writeFileSync(join(cwd, "Package.swift"), '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "PolicyFixture", products: [.library(name: "PolicyFixture", targets: ["PolicyFixture"])], targets: [.target(name: "PolicyFixture"), .testTarget(name: "PolicyFixtureTests", dependencies: ["PolicyFixture"])])\n');
  writeFileSync(join(cwd, "Sources", "PolicyFixture", "Fixture.swift"), "public func fixtureSum(_ a: Int, _ b: Int) -> Int { a + b }\n");
  writeFileSync(join(cwd, "Tests", "PolicyFixtureTests", "FixtureTests.swift"), "import XCTest\n@testable import PolicyFixture\nfinal class FixtureTests: XCTestCase { func testSum() { XCTAssertEqual(fixtureSum(2, 3), 5) } }\n");
}
async function run(label: string, argv: string[], f: ReturnType<typeof fixture>, escape: boolean, timeoutMs: number) {
  let stdout = "", stderr = "";
  const command = argv.map(quote).join(" "), started = Date.now();
  const result = await runCommand({ command, cwd: f.cwd, env: f.env, timeoutMs, maxStreamedBytes: 262144, settings: {},
    ...(escape ? { dangerouslyDisableSandbox: true } : {}), writableRoots: [f.cwd], home: f.home, winterHome: join(f.home, ".winter"),
    onStdout(chunk: Buffer) { stdout += chunk.toString(); }, onStderr(chunk: Buffer) { stderr += chunk.toString(); } });
  const { profile, ...status } = result;
  if (profile !== undefined) writeFileSync(join(output, label + ".sb"), profile);
  const rawStdoutSha256 = hash(stdout), rawStderrSha256 = hash(stderr);
  stdout = stdout.split(homedir() + "/").join("<USER_HOME>/"); stderr = stderr.split(homedir() + "/").join("<USER_HOME>/");
  const row = { label, candidate, escape, argv: argv.map(value => value.startsWith(homedir() + "/") ? "<USER_HOME>" + value.slice(homedir().length) : value), command: command.split(homedir() + "/").join("<USER_HOME>/"), cwd: f.cwd, env: f.env,
    ...status, durationMs: Date.now() - started, stdout, stderr, stdoutSha256: hash(stdout), stderrSha256: hash(stderr), ...(profile !== undefined ? { profileSha256: hash(profile) } : {}),
    rawStdoutSha256, rawStderrSha256,
    usefulBrowserDom: stdout.includes("code-policy-fixture-ready"), usefulIndexJobs: (stdout.match(/-index-file-path /g) ?? []).length,
    nestedSandboxFailure: (stdout + stderr).includes("sandbox_apply: Operation not permitted") };
  rows.push(row);
  writeFileSync(join(output, label + ".stdout.txt"), stdout); writeFileSync(join(output, label + ".stderr.txt"), stderr);
  writeFileSync(join(output, "results.json"), JSON.stringify({ commit, candidate, fixtureRoot: root, protectedDir,
    spawnSourceSha256: hash(readFileSync(join(sdkRoot, "packages/runtime/src/sandbox/spawn.ts"))), profileSourceSha256: hash(readFileSync(join(sdkRoot, "packages/runtime/src/sandbox/profile.ts"))), rows }, null, 2) + "\n");
  console.log(JSON.stringify({ label, ...status, durationMs: row.durationMs, usefulBrowserDom: row.usefulBrowserDom, usefulIndexJobs: row.usefulIndexJobs, nestedSandboxFailure: row.nestedSandboxFailure, stderrTail: stderr.slice(-500) }));
}

console.log(JSON.stringify({ commit, candidate, fixtureRoot: root }));
for (const escape of [false, true]) {
  const mode = escape ? "approved-escape" : "sandboxed";
  if (!extraOnly) for (const operation of ["build", "test"]) {
    const label = "swift-" + operation + "-" + mode, f = fixture(label); swiftPackage(f.cwd);
    await run(label, ["/usr/bin/swift", operation, "--package-path", f.cwd, "--scratch-path", join(f.cwd, ".build"), "--cache-path", join(f.cwd, "swift-cache"), "--config-path", join(f.cwd, "swift-config"), "--security-path", join(f.cwd, "swift-security"), "--disable-keychain", "--disable-netrc", "--disable-prefetching", "--disable-experimental-prebuilts", "--jobs", "2"], f, escape, 60000);
  }
  if (!extraOnly) {
  const indexLabel = "sourcekit-index-" + mode, index = fixture(indexLabel); swiftPackage(index.cwd);
  await run(indexLabel, ["/usr/bin/sourcekit-lsp", "debug", "index", "--project", index.cwd], index, escape, 30000);
  const browserLabel = "chromium-" + mode, f = fixture(browserLabel), page = join(f.cwd, "page.html");
  writeFileSync(page, '<!doctype html><title>Code policy fixture</title><p>code-policy-fixture-ready</p>');
  if (existsSync(browser)) await run(browserLabel, [browser, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync", "--disable-default-apps", "--disable-extensions", "--metrics-recording-only", "--safebrowsing-disable-auto-update", "--use-mock-keychain", "--password-store=basic", "--host-resolver-rules=MAP * ~NOTFOUND", "--user-data-dir=" + join(f.cwd, "browser-profile"), "--dump-dom", "file://" + page], f, escape, 15000);
  const probe = fixture("protected-read-" + mode);
  await run("protected-read-" + mode, ["/bin/cat", protectedData], probe, escape, 5000);
  }
  if (playwrightEntry) {
    const label = "playwright-" + mode, f = fixture(label), page = join(f.cwd, "page.html"), driver = join(f.cwd, "playwright-fixture.mjs");
    writeFileSync(page, '<!doctype html><title>Code policy fixture</title><p>code-policy-fixture-ready</p>');
    writeFileSync(driver, `import { chromium } from ${JSON.stringify(pathToFileURL(playwrightEntry).href)};
const context = await chromium.launchPersistentContext(${JSON.stringify(join(f.cwd, "browser-profile"))}, { executablePath: process.argv[2], headless: true, chromiumSandbox: true, timeout: 7000,
args: ['--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--metrics-recording-only', '--safebrowsing-disable-auto-update', '--use-mock-keychain', '--password-store=basic', '--host-resolver-rules=MAP * ~NOTFOUND'] });
try { const page = await context.newPage(); await page.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : route.abort()); await page.goto(${JSON.stringify(pathToFileURL(page).href)}, {timeout: 5000});
console.log(JSON.stringify({chromiumSandbox:true, text:await page.locator('p').textContent()})); } finally { await context.close(); }
`);
    await run(label, ["/opt/homebrew/bin/node", driver, browser], f, escape, 15000);
    writeFileSync(join(output, label + ".driver.mjs"), readFileSync(driver));
  }
  if (extraOnly) {
    const label = "xcode-resolve-" + mode, f = fixture(label), project = join(f.cwd, "FixtureApp.xcodeproj"), dependency = join(f.cwd, "PackageDependency");
    mkdirSync(project, { recursive: true }); swiftPackage(dependency);
    const pbx = `// !$*UTF8*$!
{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {
 A00000000000000000000001 = { isa = PBXProject; buildConfigurationList = A00000000000000000000010; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = A00000000000000000000002; productRefGroup = A00000000000000000000003; projectDirPath = ""; projectRoot = ""; targets = (A00000000000000000000004); packageReferences = (A00000000000000000000005); };
 A00000000000000000000002 = { isa = PBXGroup; children = (A00000000000000000000003); sourceTree = "<group>"; };
 A00000000000000000000003 = { isa = PBXGroup; children = (A00000000000000000000007); name = Products; sourceTree = "<group>"; };
 A00000000000000000000004 = { isa = PBXNativeTarget; buildConfigurationList = A00000000000000000000011; buildPhases = (); buildRules = (); dependencies = (); name = FixtureApp; productName = FixtureApp; productReference = A00000000000000000000007; productType = "com.apple.product-type.tool"; packageProductDependencies = (A00000000000000000000006); };
 A00000000000000000000005 = { isa = XCLocalSwiftPackageReference; relativePath = PackageDependency; };
 A00000000000000000000006 = { isa = XCSwiftPackageProductDependency; package = A00000000000000000000005; productName = PolicyFixture; };
 A00000000000000000000007 = { isa = PBXFileReference; explicitFileType = "compiled.mach-o.executable"; includeInIndex = 0; path = FixtureApp; sourceTree = BUILT_PRODUCTS_DIR; };
 A00000000000000000000010 = { isa = XCConfigurationList; buildConfigurations = (A00000000000000000000012); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
 A00000000000000000000011 = { isa = XCConfigurationList; buildConfigurations = (A00000000000000000000013); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
 A00000000000000000000012 = { isa = XCBuildConfiguration; buildSettings = { CODE_SIGNING_ALLOWED = NO; SDKROOT = macosx; MACOSX_DEPLOYMENT_TARGET = 14.0; SWIFT_VERSION = 6.0; }; name = Debug; };
 A00000000000000000000013 = { isa = XCBuildConfiguration; buildSettings = { CODE_SIGNING_ALLOWED = NO; SDKROOT = macosx; MACOSX_DEPLOYMENT_TARGET = 14.0; SWIFT_VERSION = 6.0; }; name = Debug; };
 }; rootObject = A00000000000000000000001; }
`;
    writeFileSync(join(project, "project.pbxproj"), pbx);
    const scheme = join(project, "xcshareddata", "xcschemes"); mkdirSync(scheme, { recursive: true });
    writeFileSync(join(scheme, "FixtureApp.xcscheme"), '<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2600" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A00000000000000000000004" BuildableName="FixtureApp" BlueprintName="FixtureApp" ReferencedContainer="container:FixtureApp.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction></Scheme>');
    f.env = { ...f.env, ...{ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false" } };
    await run(label, ["/usr/bin/xcodebuild", "-resolvePackageDependencies", "-project", project, "-scheme", "FixtureApp", "-clonedSourcePackagesDirPath", join(f.cwd, "cloned"), "-derivedDataPath", join(f.cwd, "derived"), "-packageCachePath", join(f.cwd, "package-cache"), "-disablePackageRepositoryCache", "-skipPackageUpdates", "-scmProvider", "system", "CODE_SIGNING_ALLOWED=NO"], f, escape, 30000);
    writeFileSync(join(output, label + ".pbxproj"), pbx);
  }
}
console.log(JSON.stringify({ complete: true, fixtureRoot: root, rows: rows.length }));
lease?.close();
