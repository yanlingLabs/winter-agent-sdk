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

  // 6. Fixture hash pins: equal to the files now, enforced before compile and again by the root runner.
  const pins = doc.env ?? {};
  if (pins.FIXTURE_SHA256 !== sha256(FIXTURE_PATH)) bad("FIXTURE_SHA256 does not match the fixture file");
  if (pins.MATRIX_SHA256 !== sha256(MATRIX_PATH)) bad("MATRIX_SHA256 does not match the matrix file");
  const indexOf = (predicate: (s: Step) => boolean) => steps.findIndex(predicate);
  const verify = indexOf((s) => /sha256sum --check --strict/.test(s.run ?? "") && (s.run ?? "").includes(FIXTURE_PATH) && (s.run ?? "").includes(MATRIX_PATH));
  const compile = indexOf((s) => /\bcc\b[^\n]*guided_owner_native_fixture\.c/.test(s.run ?? ""));
  const root = indexOf((s) => s === holders[0]);
  if (verify < 0 || compile < 0 || root < 0 || !(verify < compile && compile < root)) bad("order must be hash check, cc compile, root run");
  if (root !== steps.length - 2) bad("the root run must be the last run step (only the upload follows)");
  const rootRun = holders[0]?.run ?? "";
  if (!rootRun.includes("unreviewed matrix bytes refused") || !/hashlib\.sha256/.test(rootRun)) bad("root runner must re-verify the pinned bytes");

  // 7. Result: one minimal JSON; exactly one upload, 7 days.
  for (const field of ["kernelRelease", "fixtureSha256", "headSha", "passed", "skipped", "failed", "tests", "matchesExpected11Plus1"]) {
    if (!rootRun.includes(`'${field}'`)) bad(`result lacks field ${field}`);
  }
  if (!rootRun.includes("platform.release()")) bad("result must record the kernel release");
  const uploads = steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
  if (uploads.length !== 1) bad("exactly one upload");
  const upload = uploads[0];
  if (upload?.with?.["retention-days"] !== 7) bad("retention must be 7 days");
  if (upload?.with?.path !== "out/guided-owner-matrix/result.json") bad("upload only the result json");
  if (steps[steps.length - 1] !== upload) bad("upload is the last step");
  return problems;
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
  ["fixture pin drifts", (t) => t.replace(/FIXTURE_SHA256: [0-9a-f]{64}/, `FIXTURE_SHA256: ${"0".repeat(64)}`)],
  ["matrix pin drifts", (t) => t.replace(/MATRIX_SHA256: [0-9a-f]{64}/, `MATRIX_SHA256: ${"0".repeat(64)}`)],
  ["hash check removed", (t) => t.replace(/ *printf '%s {2}%s\\n'[^\n]*\n/, "")],
  ["hash check not strict", (t) => t.replace("--check --strict", "--check")],
  ["root runner stops re-verifying", (t) => t.replace("unreviewed matrix bytes refused", "ignored")],
  ["compile step removed", (t) => t.replace(/ *cc -std=c11[^\n]*\n/, "")],
  ["upload keeps 90 days", (t) => t.replace("retention-days: 7", "retention-days: 90")],
  ["upload more than the result", (t) => t.replace("path: out/guided-owner-matrix/result.json", "path: out/")],
  ["second upload step", (t) => `${t}      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: extra\n          path: out/\n`],
  ["result drops the kernel", (t) => t.replace("'kernelRelease': kernel, ", "")],
  ["result drops the head sha", (t) => t.replace("'headSha': head, ", "")],
  ["two jobs", (t) => `${t}  second:\n    runs-on: ubuntu-24.04-arm\n    steps: []\n`],
  ["no timeout", (t) => t.replace("    timeout-minutes: 15\n", "")],
];

describe("every gate removal is caught", () => {
  for (const [name, mutate] of MUTATIONS) {
    test(`mutation: ${name}`, () => {
      const mutated = mutate(WORKFLOW);
      expect(mutated).not.toBe(WORKFLOW);
      expect(violations(mutated, others()).length).toBeGreaterThan(0);
    });
  }
  test("another workflow naming the trigger branch is caught", () => {
    expect(violations(WORKFLOW, { "x.yml": `on: { push: { branches: ['${TRIGGER_BRANCH}'] } }` }).length).toBeGreaterThan(0);
  });
});
