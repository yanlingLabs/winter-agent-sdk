// Tripwires for `.github/workflows/guided-owner-matrix-reviewed.yml`, the ONE-RUN workflow that runs the
// 12-entry guided owner matrix as root on a disposable runner (docs/guided-owner-matrix-run.md).
//
// A workflow that can never fire by accident and one that can look identical in a diff, so each property
// is asserted on the PARSED workflow. `violations()` is a pure function of the workflow text; the
// mutation table at the bottom feeds it a deliberately broken copy per gate and requires that every
// single removal is caught, so a gate that silently stopped checking fails here.
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORKFLOWS_DIR = join(ROOT, ".github/workflows");
const WORKFLOW_NAME = "guided-owner-matrix-reviewed.yml";
const WORKFLOW = readFileSync(join(WORKFLOWS_DIR, WORKFLOW_NAME), "utf8");
const TRIGGER_BRANCH = "cowork/guided-owner-matrix-run";
const REPOSITORY = "yanlingLabs/winter-agent-sdk";
const OPT_IN = "WINTER_GUIDED_OWNER_NATIVE_ADMISSION";
const FIXTURE_PATH = "scripts/guest-supervisor/guided_owner_native_fixture.c";
const MATRIX_PATH = "scripts/guest-supervisor/test_guided_owner.py";
const OWNER_PATH = "packages/runtime/src/guest/linux-session-owner.c";
const PIN_ENV: Record<string, string> = { FIXTURE_SHA256: FIXTURE_PATH, MATRIX_SHA256: MATRIX_PATH, OWNER_SHA256: OWNER_PATH };
const ALLOWED_ACTIONS = new Set(["actions/checkout", "actions/upload-artifact"]);
// Branches that already fired (or are armed for) another reviewed workflow: never reusable here.
const USED_BRANCHES = ["cowork/linux-host-query-fixture", "cowork/linux-host-query-utilities"];

type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Doc = {
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  env?: Record<string, unknown>;
  jobs?: Record<string, { if?: string; "runs-on"?: string; permissions?: unknown; env?: Record<string, unknown>; steps?: Step[]; "timeout-minutes"?: number }>;
};

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");

/** Every file the root compile can read: the fixture plus the recursive closure of its quoted #includes (repo-relative). */
export function includeClosure(entry: string, read: (path: string) => string = (p) => readFileSync(join(ROOT, p), "utf8")): string[] {
  const seen: string[] = [];
  const visit = (path: string) => {
    if (seen.includes(path)) return;
    seen.push(path);
    for (const m of read(path).matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) {
      const resolved = join(path, "..", m[1] as string);
      visit(resolved.replaceAll("\\", "/"));
    }
  };
  visit(entry);
  return seen;
}

/** Every problem with this workflow text. Empty means every gate holds. */
export function violations(text: string, otherWorkflows: Record<string, string> = {}): string[] {
  const problems: string[] = [];
  const bad = (message: string) => problems.push(message);
  let doc: Doc;
  try {
    doc = Bun.YAML.parse(text) as Doc;
  } catch {
    return ["workflow does not parse"];
  }

  // 1. Trigger: exactly one push of exactly one named branch. Nothing a PR, a button, a tag or a clock can fire.
  const on = doc.on ?? {};
  if (JSON.stringify(Object.keys(on)) !== JSON.stringify(["push"])) bad(`on: must be exactly {push}, got ${Object.keys(on).join(",")}`);
  const push = (on.push ?? {}) as { branches?: unknown };
  if (JSON.stringify(push) !== JSON.stringify({ branches: [TRIGGER_BRANCH] })) bad("on.push must be exactly one literal branch and nothing else");
  if (USED_BRANCHES.includes(TRIGGER_BRANCH)) bad("trigger branch was used before");
  for (const [name, other] of Object.entries(otherWorkflows)) {
    if (other.includes(TRIGGER_BRANCH)) bad(`${name} names the trigger branch`);
  }

  // 2. Least privilege, no secrets, no token, no network beyond the pinned checkout.
  if (JSON.stringify(doc.permissions) !== JSON.stringify({ contents: "read" })) bad("permissions must be exactly contents: read");
  const jobs = doc.jobs ?? {};
  if (Object.keys(jobs).length !== 1) bad("exactly one job");
  const job = Object.values(jobs)[0] ?? {};
  if (job.permissions !== undefined) bad("job must not override permissions");
  if (/secrets\.|GITHUB_TOKEN|github\.token|id-token|persist-credentials:\s*true/i.test(text)) bad("secrets/token/id-token/credential persistence");
  if (/\b(curl|wget|nc|ncat|ssh|scp|apt(-get)?|pip3?|npm|pnpm|yarn|bun\s+(install|add)|git\s+(clone|fetch|pull|push|remote)|docker)\b/.test(commandText(job.steps ?? []))) bad("a step reaches the network or installs something");
  if (/download-artifact|actions\/cache|setup-bun|setup-node|setup-python/.test(text)) bad("unexpected action");

  // 3. The firing gate, every conjunct.
  const gate = job.if ?? "";
  const conjuncts = [
    `github.repository == '${REPOSITORY}'`,
    "github.event_name == 'push'",
    `github.ref == 'refs/heads/${TRIGGER_BRANCH}'`,
    "github.event.created == true",
    "github.run_attempt == '1'",
  ];
  for (const piece of conjuncts) if (!gate.includes(piece)) bad(`job if lacks: ${piece}`);
  if (/\|\||\bor\b/.test(gate)) bad("job if must be a pure conjunction");
  if (job["runs-on"] !== "ubuntu-24.04-arm") bad("runs-on must be ubuntu-24.04-arm");
  if (typeof job["timeout-minutes"] !== "number" || job["timeout-minutes"] > 20) bad("bounded timeout required");

  // 4. Pinned actions only; exactly the allowed two.
  const steps = job.steps ?? [];
  for (const step of steps) {
    if (!step.uses) continue;
    const [action, ref] = step.uses.split("@");
    if (!ALLOWED_ACTIONS.has(action ?? "")) bad(`action not allowed: ${action}`);
    if (!/^[0-9a-f]{40}$/.test(ref ?? "")) bad(`action not pinned to a full SHA: ${step.uses}`);
  }
  const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  if (!checkout || checkout.with?.["persist-credentials"] !== false) bad("checkout must set persist-credentials: false");
  if (checkout && checkout.with?.ref !== "${{ github.sha }}") bad("checkout must use github.sha");

  // 5. The opt-in variable: once in the file, only in the one sudo step, never in any env block.
  if (text.split(OPT_IN).length - 1 !== 1) bad("opt-in variable must appear exactly once in the workflow");
  const holders = steps.filter((s) => (s.run ?? "").includes(OPT_IN));
  if (holders.length !== 1 || !/sudo -n env WINTER_GUIDED_OWNER_NATIVE_ADMISSION=disposable-linux-guided-owner-matrix /.test(holders[0]?.run ?? "")) bad("opt-in only in the one sudo step, set via sudo -n env");
  if (JSON.stringify([doc.env, job.env, ...steps.map((s) => s.env)]).includes(OPT_IN)) bad("opt-in variable in an env block");
  const privileged = steps.filter((s) => /\bsudo\b/.test(commandText([s])));
  if (privileged.length !== 1 || privileged[0] !== holders[0]) bad("sudo only in the opt-in step");

  // 6. Hash pins: every file the root compile reads (fixture, its whole include closure) plus the matrix itself.
  const pins = doc.env ?? {};
  const closure = includeClosure(FIXTURE_PATH);
  const expectedFiles = new Set([MATRIX_PATH, ...closure]);
  if (JSON.stringify([...expectedFiles].sort()) !== JSON.stringify(Object.values(PIN_ENV).sort())) bad("pinned set is not the matrix plus the full include closure");
  for (const [variable, path] of Object.entries(PIN_ENV)) {
    if (pins[variable] !== sha256(path)) bad(`${variable} does not match ${path}`);
  }
  const indexOf = (predicate: (s: Step) => boolean) => steps.findIndex(predicate);
  const verify = indexOf((s) => /sha256sum --check --strict/.test(s.run ?? "") && [...expectedFiles].every((f) => (s.run ?? "").includes(f)) && Object.keys(PIN_ENV).every((v) => (s.run ?? "").includes(`"$${v}"`)));
  const compile = indexOf((s) => /\bcc\b[^\n]*guided_owner_native_fixture\.c/.test(s.run ?? ""));
  const root = indexOf((s) => s === holders[0]);
  if (verify < 0) bad("a strict sha256sum check covering every pinned file is required");
  if (compile < 0) bad("the unprivileged cc compile step is required");
  if (verify >= 0 && compile >= 0 && root >= 0 && !(verify < compile && compile < root)) bad("order must be hash check, cc compile, root run");
  if (root !== steps.length - 2) bad("the root run must be the last run step (only the upload follows)");
  const rootRun = holders[0]?.run ?? "";
  for (const [variable, path] of Object.entries(PIN_ENV)) {
    if (!rootRun.includes(`"${path}=$${variable}"`)) bad(`root step does not receive the pin for ${path}`);
  }
  const python = rootPython(rootRun);
  if (python === null) bad("root heredoc not found");
  else bad_python(python, bad);

  // 7. Result: one minimal JSON; exactly one upload, 7 days, always uploaded.
  if (!/\bpython3 -I -S -B - "\$GITHUB_SHA" /.test(rootRun) || /\bpython3 -I -S -B -\S/.test(rootRun)) bad("root interpreter line must be exactly python3 -I -S -B -");
  const uploads = steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
  if (uploads.length !== 1) bad("exactly one upload");
  const upload = uploads[0];
  if (upload?.with?.["retention-days"] !== 7) bad("retention must be 7 days");
  if (upload?.with?.path !== "out/guided-owner-matrix/result.json") bad("upload only the result json");
  if (steps[steps.length - 1] !== upload) bad("upload is the last step");
  if (upload?.if !== "always()") bad("upload must keep if: always()");
  if (Object.keys(upload?.with ?? {}).sort().join() !== "if-no-files-found,name,path,retention-days") bad("upload keys");
  if (JSON.stringify(Object.keys(checkout?.with ?? {}).sort()) !== JSON.stringify(["persist-credentials", "ref"])) bad("checkout has extra with: keys");
  if (/continue-on-error/.test(text)) bad("continue-on-error anywhere");
  return problems;
}

/** The python heredoc of the root step (already dedented by YAML), or null. */
function rootPython(run: string): string | null {
  const start = run.indexOf("<<'PY'\n");
  if (start < 0) return null;
  const end = run.lastIndexOf("\nPY");
  return end < 0 ? null : run.slice(start + 7, end + 1);
}

const RESULT_KEYS = ["schema", "headSha", "kernelRelease", "machine", "pinnedSha256", "total", "passed", "skipped", "failed", "matchesExpected11Plus1", "tests"];
const EXPECTED_LINE =
  "expected = major_minor >= (6, 9) and len(tests) == 12 and count('pass') == 11 and count('fail') == 0 and skipped == ['test_actual_pidfs_absent_before_69']";
const IMPORT_LINE = "import hashlib, json, os, platform, re, sys, types, unittest";
const EXEC_LINE = "exec(compile(matrix, module.__file__, 'exec'), module.__dict__)";

/** Exact checks on what runs as root. The python is small enough to pin by its shape, not by substring. */
function bad_python(py: string, bad: (message: string) => void): void {
  const lines = py.split("\n");
  const imports = lines.filter((l) => /^\s*(import|from)\s/.test(l));
  if (imports.length !== 1 || imports[0] !== IMPORT_LINE) bad("root python imports must be exactly the allowlist");
  if (/sys\.path|__import__|importlib|subprocess|\beval\(|runpy|ctypes|pickle|marshal|socket|urllib|http/.test(py)) bad("root python uses a forbidden facility");
  if ((py.match(/\bexec\(/g) ?? []).length !== 1 || !lines.some((l) => l.trim() === EXEC_LINE)) bad("root python exec must be exactly the hashed matrix bytes");
  if ((py.match(/(?<![\w.])open\(/g) ?? []).length !== 1 || !py.includes("with open(name, 'rb') as handle:")) bad("root python may open() only the pinned files for reading");
  if ((py.match(/\bcompile\(/g) ?? []).length !== 1) bad("root python compile() count");
  if (lines[lines.length - 2]?.trim() !== "raise SystemExit(0 if expected else 1)" || (py.match(/SystemExit\(0/g) ?? []).length !== 1) bad("exit line must be exactly raise SystemExit(0 if expected else 1)");
  if (!lines.some((l) => l.trim() === EXPECTED_LINE)) bad("expected must have every conjunct exactly");
  const result = /result = \{([^\n]*)\}\n/.exec(py);
  const keys = result ? [...(result[1] as string).matchAll(/'(\w+)':/g)].map((m) => m[1]) : [];
  if (JSON.stringify(keys) !== JSON.stringify(RESULT_KEYS)) bad("result keys must be exactly the intended set");
  if (/node\(\)|gethostname|getfqdn|uname\(\)|getenv|environ|RUNNER_|HOSTNAME|getlogin|getpass/.test(py)) bad("root python reads a machine or runner identity");
  if (!py.includes("platform.release()")) bad("result must record the kernel release");
  if (!py.includes("unreviewed matrix bytes refused") || !/hashlib\.sha256/.test(py)) bad("root runner must re-verify the pinned bytes");
  const failureClasses = [...py.matchAll(/return '([a-z-]+)'/g)].map((m) => m[1]).sort().join();
  if (failureClasses !== "assertion,compile-error,missing-kernel-feature,timeout") bad("failure classes must be the bounded set");
  if (!py.includes("'failureClass': cls")) bad("each test row records its failure class");
}

/** The command text of steps (shell comments and blank lines dropped). */
function commandText(steps: Step[]): string {
  return steps
    .map((s) => s.run ?? "")
    .join("\n")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .join("\n");
}

function others(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(WORKFLOWS_DIR)) {
    if (name !== WORKFLOW_NAME && (name.endsWith(".yml") || name.endsWith(".yaml"))) result[name] = readFileSync(join(WORKFLOWS_DIR, name), "utf8");
  }
  return result;
}

describe("guided owner matrix workflow gates", () => {
  test("the committed workflow satisfies every gate", () => {
    expect(violations(WORKFLOW, others())).toEqual([]);
  });

  test("the trigger is the exact first-creation push of one new branch, and nothing else", () => {
    const doc = Bun.YAML.parse(WORKFLOW) as Doc;
    expect(doc.on).toEqual({ push: { branches: [TRIGGER_BRANCH] } });
    for (const name of ["pull_request", "pull_request_target", "workflow_dispatch", "schedule", "workflow_run", "repository_dispatch"]) {
      expect(Object.keys(doc.on ?? {})).not.toContain(name);
    }
  });

  test("no other workflow mentions the trigger branch", () => {
    for (const [name, text] of Object.entries(others())) expect([name, text.includes(TRIGGER_BRANCH)]).toEqual([name, false]);
  });

  test("the doc exists and states the trigger, the expected 11+1 and the freeze", () => {
    const doc = readFileSync(join(ROOT, "docs/guided-owner-matrix-run.md"), "utf8");
    expect(existsSync(join(ROOT, "docs/guided-owner-matrix-run.md"))).toBe(true);
    expect(doc).toContain(TRIGGER_BRANCH);
    expect(doc).toContain("11 pass");
    expect(doc).toContain("1 skip");
    expect(doc.toLowerCase()).toContain("frozen");
  });
});

// Each entry removes or breaks exactly one gate. Every one must make `violations` non-empty.
const IMPORTS = "import hashlib, json, os, platform, re, sys, types, unittest";
const MUTATIONS: Array<[string, (text: string) => string]> = [
  ["add pull_request trigger", (t) => t.replace("on:\n  push:", "on:\n  pull_request:\n  push:")],
  ["add pull_request_target trigger", (t) => t.replace("on:\n  push:", "on:\n  pull_request_target:\n  push:")],
  ["add workflow_dispatch trigger", (t) => t.replace("on:\n  push:", "on:\n  workflow_dispatch:\n  push:")],
  ["add schedule trigger", (t) => t.replace("on:\n  push:", "on:\n  schedule:\n    - cron: '0 0 * * *'\n  push:")],
  ["widen the branch to a glob", (t) => t.replace("'cowork/guided-owner-matrix-run'", "'cowork/**'")],
  ["add a tags filter", (t) => t.replace("    branches:\n", "    tags: ['*']\n    branches:\n")],
  ["swap to a previously used branch", (t) => t.replaceAll("cowork/guided-owner-matrix-run", "cowork/linux-host-query-fixture")],
  ["drop the repository gate", (t) => t.replace("github.repository == 'yanlingLabs/winter-agent-sdk' && ", "")],
  ["drop the event-name gate", (t) => t.replace("github.event_name == 'push' && ", "")],
  ["drop the exact-ref gate", (t) => t.replace(" && github.ref == 'refs/heads/cowork/guided-owner-matrix-run'", "")],
  ["drop the first-creation gate", (t) => t.replace(" && github.event.created == true", "")],
  ["drop the run_attempt gate", (t) => t.replace(" && github.run_attempt == '1'", "")],
  ["turn the gate into a disjunction", (t) => t.replace("github.event.created == true &&", "github.event.created == true ||")],
  ["remove the job if entirely", (t) => t.replace(/    if: .*\n/, "")],
  ["wrong runner", (t) => t.replace("ubuntu-24.04-arm", "ubuntu-latest")],
  ["drop top-level permissions", (t) => t.replace("permissions:\n  contents: read\n", "")],
  ["widen permissions", (t) => t.replace("contents: read", "contents: write")],
  ["add id-token permission", (t) => t.replace("contents: read", "contents: read\n  id-token: write")],
  ["job-level permission override", (t) => t.replace("    runs-on:", "    permissions:\n      contents: read\n    runs-on:")],
  ["unpin checkout", (t) => t.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v4")],
  ["unpin upload-artifact", (t) => t.replace(/actions\/upload-artifact@[0-9a-f]{40}/, "actions/upload-artifact@v4")],
  ["checkout keeps credentials", (t) => t.replace("persist-credentials: false", "persist-credentials: true")],
  ["checkout a mutable ref", (t) => t.replace("ref: ${{ github.sha }}", "ref: main")],
  ["use a secret", (t) => t.replace("        run: |\n          set -eu\n          test", "        env:\n          K: ${{ secrets.K }}\n        run: |\n          set -eu\n          test")],
  ["use the token", (t) => t.replace("test \"$(uname -s)\" = Linux", "test \"$(uname -s)\" = Linux; echo ${{ github.token }}")],
  ["network fetch step", (t) => t.replace("command -v cc", "command -v cc\n          curl -sSf https://example.invalid")],
  ["download-artifact step", (t) => t.replace("      - name: Compile", "      - uses: actions/download-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n      - name: Compile")],
  ["opt-in in job env", (t) => t.replace("    timeout-minutes: 15\n", "    timeout-minutes: 15\n    env:\n      WINTER_GUIDED_OWNER_NATIVE_ADMISSION: disposable-linux-guided-owner-matrix\n")],
  ["opt-in in the compile step", (t) => t.replace("      - name: Compile the fixture without privilege\n        run: |", "      - name: Compile the fixture without privilege\n        run: |\n          export WINTER_GUIDED_OWNER_NATIVE_ADMISSION=x")],
  ["opt-in step loses sudo -n env", (t) => t.replace("sudo -n env WINTER_GUIDED_OWNER_NATIVE_ADMISSION=", "WINTER_GUIDED_OWNER_NATIVE_ADMISSION=")],
  ["extra sudo step", (t) => t.replace("command -v cc", "command -v cc\n          sudo -n true")],
  ["owner pin drifts", (t) => t.replace(/OWNER_SHA256: [0-9a-f]{64}/, `OWNER_SHA256: ${"0".repeat(64)}`)],
  ["owner pin removed from env", (t) => t.replace(/ +OWNER_SHA256: [0-9a-f]{64}\n/, "")],
  ["owner pin dropped from the unprivileged check", (t) => t.replace(' "$OWNER_SHA256" packages/runtime/src/guest/linux-session-owner.c | sha256sum', " | sha256sum")],
  ["owner pin not handed to the root step", (t) => t.replace(' "packages/runtime/src/guest/linux-session-owner.c=$OWNER_SHA256"', "")],
  ["root python drops -I", (t) => t.replace("python3 -I -S -B - ", "python3 -S -B - ")],
  ["root python gains -c style suffix", (t) => t.replace("python3 -I -S -B - ", "python3 -I -S -B -u - ")],
  ["unpinned import after sys.path edit", (t) => t.replace("          head, destination", "          sys.path.insert(0, 'x')\n          import helper\n          head, destination")],
  ["extra import", (t) => t.replace(IMPORTS, IMPORTS + ", subprocess")],
  ["extra exec of a file", (t) => t.replace("          def classify", "          exec(open('x.py').read())\n          def classify")],
  ["extra open of a file", (t) => t.replace("          def classify", "          extra = open('x.py').read()\n          def classify")],
  ["exit always zero", (t) => t.replace("raise SystemExit(0 if expected else 1)", "raise SystemExit(0)")],
  ["expected drops the fail count", (t) => t.replace(" and count('fail') == 0", "")],
  ["expected drops the kernel bound", (t) => t.replace("major_minor >= (6, 9) and ", "")],
  ["expected drops the skip identity", (t) => t.replace(" and skipped == ['test_actual_pidfs_absent_before_69']", "")],
  ["result adds the node name", (t) => t.replace("'machine': platform.machine(), ", "'machine': platform.machine(), 'node': platform.node(), ")],
  ["result adds a runner name key", (t) => t.replace("'total': len(tests), ", "'total': len(tests), 'runner': os.environ.get('RUNNER_NAME'), ")],
  ["result drops pinned hashes", (t) => t.replace("'pinnedSha256': hashes, ", "")],
  ["checkout fetches submodules", (t) => t.replace("          persist-credentials: false\n", "          persist-credentials: false\n          submodules: recursive\n")],
  ["continue-on-error on the root step", (t) => t.replace("      - name: Run the matrix", "      - continue-on-error: true\n        name: Run the matrix")],
  ["continue-on-error on the job", (t) => t.replace("    timeout-minutes: 15\n", "    timeout-minutes: 15\n    continue-on-error: true\n")],
  ["upload loses if: always()", (t) => t.replace("        if: always()\n", "")],
  ["upload only on success", (t) => t.replace("if: always()", "if: success()")],
  ["failure classes widened", (t) => t.replace("return 'timeout'", "return str(err[1])")],
  ["failure class not recorded", (t) => t.replace(", 'failureClass': cls", "")],
  ["fixture pin drifts", (t) => t.replace(/FIXTURE_SHA256: [0-9a-f]{64}/, `FIXTURE_SHA256: ${"0".repeat(64)}`)],
  ["matrix pin drifts", (t) => t.replace(/MATRIX_SHA256: [0-9a-f]{64}/, `MATRIX_SHA256: ${"0".repeat(64)}`)],
  ["hash check removed", (t) => t.replace(/ *printf '%s {2}%s\\n'[^\n]*\n/, "")],
  ["hash check not strict", (t) => t.replace("--check --strict", "--check")],
  ["root runner stops re-verifying", (t) => t.replaceAll("unreviewed matrix bytes refused", "ignored")],
  ["compile step removed", (t) => t.replace(/ *cc -std=c11[^\n]*\n/, "")],
  ["upload keeps 90 days", (t) => t.replace("retention-days: 7", "retention-days: 90")],
  ["upload more than the result", (t) => t.replace("path: out/guided-owner-matrix/result.json", "path: out/")],
  ["second upload step", (t) => `${t}      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: extra\n          path: out/\n`],
  ["result drops the kernel", (t) => t.replace("'kernelRelease': kernel, ", "")],
  ["result drops the head sha", (t) => t.replace("'headSha': head, ", "")],
  ["two jobs", (t) => `${t}  second:\n    runs-on: ubuntu-24.04-arm\n    steps: []\n`],
  ["no timeout", (t) => t.replace("    timeout-minutes: 15\n", "")],
];

const EXPECT: Record<string, string> = {
  "add pull_request trigger": "on: must be exactly {push}, got pull_request,push",
  "add pull_request_target trigger": "on: must be exactly {push}, got pull_request_target,push",
  "add workflow_dispatch trigger": "on: must be exactly {push}, got workflow_dispatch,push",
  "add schedule trigger": "on: must be exactly {push}, got schedule,push",
  "widen the branch to a glob": "on.push must be exactly one literal branch and nothing else",
  "add a tags filter": "on.push must be exactly one literal branch and nothing else",
  "swap to a previously used branch": "on.push must be exactly one literal branch and nothing else",
  "drop the repository gate": "job if lacks: github.repository == 'yanlingLabs/winter-agent-sdk'",
  "drop the event-name gate": "job if lacks: github.event_name == 'push'",
  "drop the exact-ref gate": "job if lacks: github.ref == 'refs/heads/cowork/guided-owner-matrix-run'",
  "drop the first-creation gate": "job if lacks: github.event.created == true",
  "drop the run_attempt gate": "job if lacks: github.run_attempt == '1'",
  "turn the gate into a disjunction": "job if must be a pure conjunction",
  "remove the job if entirely": "job if lacks: github.repository == 'yanlingLabs/winter-agent-sdk'",
  "wrong runner": "runs-on must be ubuntu-24.04-arm",
  "drop top-level permissions": "permissions must be exactly contents: read",
  "widen permissions": "permissions must be exactly contents: read",
  "add id-token permission": "permissions must be exactly contents: read",
  "job-level permission override": "job must not override permissions",
  "unpin checkout": "action not pinned to a full SHA: actions/checkout@v4",
  "unpin upload-artifact": "action not pinned to a full SHA: actions/upload-artifact@v4",
  "checkout keeps credentials": "secrets/token/id-token/credential persistence",
  "checkout a mutable ref": "checkout must use github.sha",
  "use a secret": "secrets/token/id-token/credential persistence",
  "use the token": "secrets/token/id-token/credential persistence",
  "network fetch step": "a step reaches the network or installs something",
  "download-artifact step": "unexpected action",
  "opt-in in job env": "opt-in variable must appear exactly once in the workflow",
  "opt-in in the compile step": "opt-in variable must appear exactly once in the workflow",
  "opt-in step loses sudo -n env": "opt-in only in the one sudo step, set via sudo -n env",
  "extra sudo step": "sudo only in the opt-in step",
  "owner pin drifts": "OWNER_SHA256 does not match packages/runtime/src/guest/linux-session-owner.c",
  "owner pin removed from env": "OWNER_SHA256 does not match packages/runtime/src/guest/linux-session-owner.c",
  "owner pin dropped from the unprivileged check": "a strict sha256sum check covering every pinned file is required",
  "owner pin not handed to the root step": "root step does not receive the pin for packages/runtime/src/guest/linux-session-owner.c",
  "root python drops -I": "root interpreter line must be exactly python3 -I -S -B -",
  "root python gains -c style suffix": "root interpreter line must be exactly python3 -I -S -B -",
  "unpinned import after sys.path edit": "root python imports must be exactly the allowlist",
  "extra import": "root python imports must be exactly the allowlist",
  "extra exec of a file": "root python exec must be exactly the hashed matrix bytes",
  "extra open of a file": "root python may open() only the pinned files for reading",
  "exit always zero": "exit line must be exactly raise SystemExit(0 if expected else 1)",
  "expected drops the fail count": "expected must have every conjunct exactly",
  "expected drops the kernel bound": "expected must have every conjunct exactly",
  "expected drops the skip identity": "expected must have every conjunct exactly",
  "result adds the node name": "result keys must be exactly the intended set",
  "result adds a runner name key": "result keys must be exactly the intended set",
  "result drops pinned hashes": "result keys must be exactly the intended set",
  "checkout fetches submodules": "checkout has extra with: keys",
  "continue-on-error on the root step": "continue-on-error anywhere",
  "continue-on-error on the job": "continue-on-error anywhere",
  "upload loses if: always()": "upload must keep if: always()",
  "upload only on success": "upload must keep if: always()",
  "failure classes widened": "failure classes must be the bounded set",
  "failure class not recorded": "each test row records its failure class",
  "fixture pin drifts": "FIXTURE_SHA256 does not match scripts/guest-supervisor/guided_owner_native_fixture.c",
  "matrix pin drifts": "MATRIX_SHA256 does not match scripts/guest-supervisor/test_guided_owner.py",
  "hash check removed": "a strict sha256sum check covering every pinned file is required",
  "hash check not strict": "a strict sha256sum check covering every pinned file is required",
  "root runner stops re-verifying": "root runner must re-verify the pinned bytes",
  "compile step removed": "the unprivileged cc compile step is required",
  "upload keeps 90 days": "retention must be 7 days",
  "upload more than the result": "upload only the result json",
  "second upload step": "exactly one upload",
  "result drops the kernel": "result keys must be exactly the intended set",
  "result drops the head sha": "result keys must be exactly the intended set",
  "two jobs": "exactly one job",
  "no timeout": "bounded timeout required",
};

describe("every gate removal is caught", () => {
  for (const [name, mutate] of MUTATIONS) {
    test(`mutation: ${name}`, () => {
      const mutated = mutate(WORKFLOW);
      expect(mutated).not.toBe(WORKFLOW);
      const found = violations(mutated, others());
      expect(found.length).toBeGreaterThan(0);
      // Caught by its OWN named violation, not incidentally by another gate.
      expect(found).toContain(EXPECT[name] as string);
    });
  }
  test("every mutation has a named expectation", () => {
    expect(Object.keys(EXPECT).sort()).toEqual(MUTATIONS.map(([name]) => name).sort());
  });
  test("the include closure is the real one and grows with a new quoted include", () => {
    expect(includeClosure(FIXTURE_PATH).sort()).toEqual([FIXTURE_PATH, OWNER_PATH].sort());
    const fake = (path: string) => (path === FIXTURE_PATH ? '#include "../../packages/runtime/src/guest/linux-session-owner.c"\n#include "extra.h"\n' : path.endsWith("extra.h") ? '#include "deeper.h"\n' : "");
    expect(includeClosure(FIXTURE_PATH, fake)).toEqual([FIXTURE_PATH, OWNER_PATH, "scripts/guest-supervisor/extra.h", "scripts/guest-supervisor/deeper.h"]);
  });
  test("an unpinned closure member is caught by the pinned-set gate", () => {
    const original = PIN_ENV.OWNER_SHA256;
    delete PIN_ENV.OWNER_SHA256;
    try {
      expect(violations(WORKFLOW, others())).toContain("pinned set is not the matrix plus the full include closure");
    } finally {
      PIN_ENV.OWNER_SHA256 = original as string;
    }
  });
  test("another workflow naming the trigger branch is caught", () => {
    expect(violations(WORKFLOW, { "x.yml": `on: { push: { branches: ['${TRIGGER_BRANCH}'] } }` }).length).toBeGreaterThan(0);
  });
});
