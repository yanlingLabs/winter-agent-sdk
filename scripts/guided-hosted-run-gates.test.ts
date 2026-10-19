// Tripwires for `.github/workflows/guided-hosted-run-reviewed.yml`, the ONE-RUN hosted guided query
// (docs/guided-hosted-run.md). The author never triggers it; the owner approves the single run. A workflow that can
// never fire by accident and one that can look identical in a diff, so each property is asserted on the PARSED
// workflow. `violations()` is a pure function of the workflow text; the mutation table at the bottom feeds it a
// deliberately broken copy per gate and requires that every single removal is caught by its OWN named violation.
// Two guards are also run for real: the arming guard (bash, against throwaway git repositories) and the root
// launcher that hash-checks the runner before it executes a byte of it.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORKFLOWS_DIR = join(ROOT, ".github/workflows");
const WORKFLOW_NAME = "guided-hosted-run-reviewed.yml";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_NAME}`;
const WORKFLOW = readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
const TRIGGER_BRANCH = "cowork/guided-hosted-run";
const REPOSITORY = "yanlingLabs/winter-agent-sdk";
const RUNTIME_REPOSITORY = "yanlingLabs/winter-runtime-sdk";
const OPT_IN = "WINTER_GUIDED_HOSTED_ADMISSION";
const OPT_IN_VALUE = "disposable-linux-guided-hosted-run";
const RUNNER_PATH = "scripts/guest-hosted-guided/run.py";
const ZERO40 = "0".repeat(40);
const ZERO64 = "0".repeat(64);
// The run-2 binding the workflow must carry (runtime-sdk intake #23, merged at 04f82b13; compile run 39227365159, artifact 12174387240,
// zip sha256 a4d731f6...0296, expires 2026-10-26). A drift in any of them is caught here, not by the packet verifier at run time.
const EXPECTED_BINDING: Record<string, string> = {
  PACKET_RUN_ID: "39227365159",
  RUNTIME_SDK_HEAD: "04f82b13a2af965a487d16b15ccfee8afc99fc09",
  PACKET_PIN_SHA256: "220acd961ab11c0a02d3e8ea797e5b10c24e3ab595573e893b05d7a7418e77a2",
  VERIFIER_SHA256: "2ac6b1af5875690ab84fcd87c09dbb1ab67a3c703a0aee84845c29da962301f3",
  PACKET_ARTIFACT_ID: "12174387240",
  PACKET_ZIP_SHA256: "a4d731f6fbe7d03858522a85f28654d797ee82ff868e139edfd9f777de690296",
  PACKET_ARCHIVE_SHA256: "1bea0da978ac7ef731bb3b1dc89158f0efd29deeb551ec6df1b7fdc8279b98d1",
  PACKET_INVENTORY_SHA256: "18f5fa5b84b041a6982cf07ae3a203f42d095418b5d1991004d49301d80dce62",
};
const ACTIONS: Record<string, string> = {
  "actions/checkout": "34e114876b0b11c390a56381ad16ebd13914f8d5",
  "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact": "d3f86a106a0bac45b974a628896c90dbdf5c8093",
};
// Branches that already fired, or are armed for, another reviewed workflow: never reusable here.
const USED_BRANCHES = [
  "cowork/linux-host-query-fixture", "cowork/linux-host-query-utilities", "cowork/guided-owner-matrix-run", "cowork/guided-packet-compile-fixture",
  "cowork/instruction-reader-compile-fixture", "cowork/reader-hosted-dependency-probe", "cowork/reader-hosted-fixture-stderr", "cowork/guided-packet-build",
];

/** The arming guard, line for line. It runs before any reviewed code is checked out and refuses unless HOSTED_HEAD is
 * an ancestor of the pushed commit AND the whole difference is the one HOSTED_HEAD line of this workflow. */
const GUARD: Array<[string, string]> = [
  ["the strict shell", "set -euo pipefail"],
  ["the unarmed refusal", `test "$HOSTED_HEAD" != "${ZERO40}"`],
  ["the ancestor check", 'git merge-base --is-ancestor "$HOSTED_HEAD" "$GITHUB_SHA"'],
  ["the single-file check", `test "$(git diff --name-only "$HOSTED_HEAD" "$GITHUB_SHA")" = "${WORKFLOW_PATH}"`],
  ["the numstat check", `test "$(git diff --numstat "$HOSTED_HEAD" "$GITHUB_SHA")" = "$(printf '1\\t1\\t%s' ${WORKFLOW_PATH})"`],
  ["the diff capture", `armed_diff=$(git diff -U0 --no-color "$HOSTED_HEAD" "$GITHUB_SHA" | grep -E '^[-+][^-+]' || true)`],
  ["the exact one-line diff check", `test "$armed_diff" = "$(printf '%s\\n%s' "-  HOSTED_HEAD: '${ZERO40}'" "+  HOSTED_HEAD: '$HOSTED_HEAD'")"`],
  ["the reviewed-head checkout", 'git checkout --detach --quiet "$HOSTED_HEAD"'],
];
/** The unset-pin refusal, line for line. */
const PIN_REFUSAL: Array<[string, string]> = [
  ["the strict shell", "set -euo pipefail"],
  ["the run id refusal", `test "$PACKET_RUN_ID" != "0"`],
  ["the artifact id refusal", `test "$PACKET_ARTIFACT_ID" != "0"`],
  ["the zip digest refusal", `test "$PACKET_ZIP_SHA256" != "${ZERO64}"`],
  ["the runtime head refusal", `test "$RUNTIME_SDK_HEAD" != "${ZERO40}"`],
  ["the pin file digest refusal", `test "$PACKET_PIN_SHA256" != "${ZERO64}"`],
  ["the verifier digest refusal", `test "$VERIFIER_SHA256" != "${ZERO64}"`],
  ["the archive pin refusal", `test "$PACKET_ARCHIVE_SHA256" != "${ZERO64}"`],
  ["the inventory pin refusal", `test "$PACKET_INVENTORY_SHA256" != "${ZERO64}"`],
  ["the runner pin refusal", `test "$RUNNER_SHA256" != "${ZERO64}"`],
];
/** The verification step, line for line. */
const VERIFY: Array<[string, string]> = [
  ["the strict shell", "set -euo pipefail"],
  ["the exact two-file packet directory", `test "$(ls -A packet-download | LC_ALL=C sort | tr '\\n' ' ')" = "guided-packet.tar.gz packet-inventory.json "`],
  ["the strict packet digest check", `printf '%s  %s\\n' "$PACKET_ARCHIVE_SHA256" packet-download/guided-packet.tar.gz "$PACKET_INVENTORY_SHA256" packet-download/packet-inventory.json | sha256sum --check --strict -`],
  ["the strict runner digest check", `printf '%s  %s\\n' "$RUNNER_SHA256" ${RUNNER_PATH} | sha256sum --check --strict -`],
  ["the verifier and pin digest check", `printf '%s  %s\\n' "$VERIFIER_SHA256" origins/runtime/scripts/guest-guided-intake/verify_packet.py "$PACKET_PIN_SHA256" "origins/runtime/scripts/guest-guided-intake/compile-\${PACKET_RUN_ID}.pin.json" | sha256sum --check --strict -`],
  ["the packet verification", `/usr/bin/python3 -I -B origins/runtime/scripts/guest-guided-intake/verify_packet.py packet-download/guided-packet.tar.gz packet-download/packet-inventory.json --pin "origins/runtime/scripts/guest-guided-intake/compile-\${PACKET_RUN_ID}.pin.json" > "$RUNNER_TEMP/packet-verification.json"`],
  ["the platform check", "test \"$(uname -s)\" = Linux"],
  ["the architecture check", "test \"$(uname -m)\" = aarch64"],
  ["the output directory", 'mkdir -m 755 "$RUNNER_TEMP/guided-hosted-out"'],
];
/** The one non-checkout network step before the download: the artifact's id, name, run and zip digest are read at the API and must be the pinned ones. */
const API_CHECK: Array<[string, string]> = [
  ["the strict shell", "set -euo pipefail"],
  ["the interpreter", "/usr/bin/python3 -I -B - <<'PY'"],
  ["the imports", "import json, os, urllib.request"],
  ["the wanted record", "want = {'id': int(os.environ['PACKET_ARTIFACT_ID']), 'name': 'guided-packet-compile-' + os.environ['PACKET_RUN_ID'], 'digest': 'sha256:' + os.environ['PACKET_ZIP_SHA256']}"],
  ["the request", "request = urllib.request.Request('https://api.github.com/repos/yanlingLabs/winter-runtime-sdk/actions/artifacts/' + os.environ['PACKET_ARTIFACT_ID'], headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})"],
  ["the bounded read", "with urllib.request.urlopen(request, timeout=30) as response:"],
  ["the parse", "data = json.loads(response.read(1 << 20))"],
  ["the comparison", "if any(data.get(key) != value for key, value in want.items()) or data.get('expired') is not False or str((data.get('workflow_run') or {}).get('id')) != os.environ['PACKET_RUN_ID']:"],
  ["the refusal", "raise SystemExit('the packet artifact is not the pinned one')"],
  ["the end", "PY"],
];
const SUDO_LINE = `sudo -n env -i ${OPT_IN}=${OPT_IN_VALUE} /usr/bin/python3 -I -S -B - "$RUNNER_SHA256" ${RUNNER_PATH} packet-download "$RUNNER_TEMP/guided-hosted-out" origins/runtime/scripts/guest-guided-intake/verify_packet.py "$VERIFIER_SHA256" "origins/runtime/scripts/guest-guided-intake/compile-\${PACKET_RUN_ID}.pin.json" "$PACKET_PIN_SHA256" <<'PY'`;
/** What runs as root, byte for byte (the launcher hashes the runner, then executes exactly the bytes it hashed). */
const ROOT_PY = `import hashlib, os, stat, sys
digest, source, packet, out, *extra = sys.argv[1:]
if os.geteuid() != 0:
    raise SystemExit('root required')
fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
try:
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 16777216:
        raise SystemExit('runner identity refused')
    data = os.pread(fd, 16777217, 0)
finally:
    os.close(fd)
if len(data) != before.st_size or hashlib.sha256(data).hexdigest() != digest:
    raise SystemExit('unreviewed runner refused')
sys.argv = [source, packet, out, *extra]
exec(compile(data, source, 'exec'), {'__name__': '__main__', '__file__': source})
`;

type Step = { name?: string; id?: string; "continue-on-error"?: boolean; uses?: string; run?: string; if?: string; shell?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Doc = {
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  env?: Record<string, unknown>;
  jobs?: Record<string, { if?: string; "runs-on"?: string; permissions?: unknown; env?: Record<string, unknown>; steps?: Step[]; "timeout-minutes"?: number }>;
};
const yaml = (Bun as unknown as { YAML: { parse(source: string): unknown } }).YAML;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// The files the root runner may read from beside itself, each pinned in run.py by the SHA-256 of its bytes. Nothing else is named.
const SIBLINGS: Array<[string, string]> = [["ORACLE_SHA256", "oracle.py"], ["ADAPTER_SHA256", "roles_adapter.py"], ["SESSION_SHA256", "session.py"], ["FIXTURE_INPUTS_SHA256", "fixture-inputs.json"]];
// Every `subprocess.<name>` the root-loaded files may mention, with its exact count. A new primitive, or a second use of one, changes this and the gate fails.
const SUBPROCESS_USE: Record<string, Record<string, number>> = {
  "run.py": { DEVNULL: 1, SubprocessError: 1, run: 1 },
  "session.py": { DEVNULL: 4, PIPE: 2, Popen: 1, TimeoutExpired: 1, run: 1 },
};
const RUNNER_FILE_NAMES = new Set([...SIBLINGS.map(([, file]) => file), "packet-inventory.json", "guided-packet.tar.gz", "hostClient.metafile.json", "result.json"]);
export interface Context { others: Record<string, string>; runnerExists: boolean; runnerSha256: string; oracleTest: string; runnerText: string; sessionText: string; siblingSha256: Record<string, string>; adapterText: string; oracleText: string }
export function loadContext(): Context {
  const others: Record<string, string> = {};
  for (const name of readdirSync(WORKFLOWS_DIR)) if (name !== WORKFLOW_NAME && (name.endsWith(".yml") || name.endsWith(".yaml"))) others[name] = readFileSync(join(WORKFLOWS_DIR, name), "utf8");
  const runner = join(ROOT, RUNNER_PATH);
  const directory = join(ROOT, "scripts/guest-hosted-guided");
  const siblingSha256: Record<string, string> = {};
  for (const [, file] of SIBLINGS) siblingSha256[file] = existsSync(join(directory, file)) ? sha256(readFileSync(join(directory, file))) : "";
  return { others, runnerExists: existsSync(runner), runnerSha256: existsSync(runner) ? sha256(readFileSync(runner)) : "", oracleTest: readFileSync(join(directory, "test_oracle.py"), "utf8"),
    runnerText: existsSync(runner) ? readFileSync(runner, "utf8") : "", sessionText: readFileSync(join(directory, "session.py"), "utf8"), siblingSha256, adapterText: readFileSync(join(directory, "roles_adapter.py"), "utf8"), oracleText: readFileSync(join(directory, "oracle.py"), "utf8") };
}

/** The shell lines a step runs: comments and blanks dropped. */
function logicalLines(run: string): string[] {
  return run.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
}

/** What root may execute and read, derived from the runner's and the session's own text. The workflow hashes run.py; run.py hashes every file it
 * loads from beside itself (three modules and the fixture inputs) before it uses a byte of it; the one verifier it runs is hashed first too. */
export function runnerProblems(runnerText: string, sessionText: string, siblingSha256: Record<string, string>, adapterText = "", oracleText = ""): string[] {
  const problems: string[] = [];
  for (const [constant, file] of SIBLINGS) {
    const pinned = new RegExp(`^${constant} = '([0-9a-f]{64})'$`, "m").exec(runnerText)?.[1];
    if (pinned === undefined || pinned === ZERO64) problems.push(`run.py leaves ${file} unpinned`);
    else if (pinned !== siblingSha256[file]) problems.push(`run.py pins ${file} to a hash that differs from the file`);
  }
  const named = [...runnerText.matchAll(/'([A-Za-z0-9_-]+\.(?:py|json|gz))'/g)].map((m) => m[1] as string);
  for (const file of new Set(named)) if (!RUNNER_FILE_NAMES.has(file)) problems.push(`run.py names a file that is not pinned: ${file}`);
  if ((runnerText.match(/\bexec\(/g) ?? []).length !== 1 || !/def load_sibling\([\s\S]*?read_pinned\([\s\S]*?\bexec\(compile\(data,/.test(runnerText)) problems.push("run.py may execute code only in load_sibling, after read_pinned");
  // Every way to start, replace or reach another program, in all four files root loads. Not just `subprocess.run(`.
  for (const [file, text] of [["run.py", runnerText], ["session.py", sessionText], ["roles_adapter.py", adapterText], ["oracle.py", oracleText]] as const) {
    const code = text.split("\n").map((line) => line.replace(/(^|\s)#.*$/, "")).join("\n");
    if (/\bos\.(system|popen|exec\w*|spawn\w*|posix_spawn\w*|fork|forkpty)\b|\bpty\b|\bposix_spawn\b|\bmultiprocessing\b|\bctypes\b|\bcffi\b|\bimport\s+subprocess\s+as\b|\bfrom\s+subprocess\s+import\b|__import__|\bimportlib\b|\bimport_module\b|\beval\(|shell\s*=\s*True|\bpopen[23]\b|\brunpy\b/.test(code)) problems.push(`${file} reaches another way to execute code`);
    const names: Record<string, number> = {};
    for (const m of code.matchAll(/\bsubprocess\.(\w+)/g)) names[m[1] as string] = (names[m[1] as string] ?? 0) + 1;
    const imports = (code.match(/^\s*import\s+subprocess\s*$/gm) ?? []).length;
    const want = SUBPROCESS_USE[file] ?? {};
    if (JSON.stringify(Object.entries(names).sort()) !== JSON.stringify(Object.entries(want).sort()) || imports !== (Object.keys(want).length ? 1 : 0)) problems.push(`${file} uses subprocess primitives other than the reviewed ones`);
  }
  if ((runnerText.match(/subprocess\.run\(/g) ?? []).length !== 1 || !/verifier_bytes = read_pinned\(verifier, verifier_sha256\)[\s\S]*?private_copy\(work, os\.path\.basename\(verifier\), verifier_bytes\)[\s\S]*?\[sys\.executable, '-I', '-B', verifier_copy, archive, inventory, '--pin', pin_copy\]/.test(runnerText)) problems.push("run.py may run only the hashed verifier, with an explicit --pin");
  if ((sessionText.match(/\bexec\(/g) ?? []).length !== 1 || !/def load_supervisor\([\s\S]*?supervisor_matches_packet\([\s\S]*?\bexec\(compile\(data,/.test(sessionText)) problems.push("session.py may execute code only in load_supervisor, after the packet-hash comparison");
  return problems;
}

/** Every problem with this workflow text. Empty means every gate holds. */
export function violations(text: string, ctx: Context = loadContext()): string[] {
  const problems: string[] = [];
  const bad = (message: string) => problems.push(message);
  let doc: Doc;
  try { doc = yaml.parse(text) as Doc; } catch { return ["workflow does not parse"]; }

  // 1. Trigger: exactly one push of exactly one named, brand-new branch. Nothing a PR, a button, a tag or a clock can fire.
  const on = doc.on ?? {};
  if (JSON.stringify(Object.keys(on)) !== JSON.stringify(["push"])) bad(`on: must be exactly {push}, got ${Object.keys(on).join(",")}`);
  if (JSON.stringify(on.push ?? {}) !== JSON.stringify({ branches: [TRIGGER_BRANCH] })) bad("on.push must be exactly one literal branch and nothing else");
  for (const [name, other] of Object.entries(ctx.others)) if (other.includes(TRIGGER_BRANCH)) bad(`${name} names the trigger branch`);

  // 1b. CLOSED key sets. Every key a workflow, a job or a step may carry is on an allowlist, so nothing can be added that this gate has not read:
  // no `defaults`, `services`, `container`, `strategy`, `outputs`, `needs`, `environment`, no step-level `if` outside the one diagnostics upload,
  // no `working-directory`, `id` or `continue-on-error`, and the concurrency group never cancels a run in progress.
  if (JSON.stringify(Object.keys(doc).sort()) !== JSON.stringify(["concurrency", "env", "jobs", "name", "on", "permissions"])) bad("workflow keys must be exactly name, on, permissions, env, concurrency, jobs");
  if (JSON.stringify((doc as { concurrency?: unknown }).concurrency) !== JSON.stringify({ group: "guided-hosted-run", "cancel-in-progress": false })) bad("concurrency must be exactly the guided-hosted-run group with cancel-in-progress false");
  const jobKeys = Object.keys(Object.values(doc.jobs ?? {})[0] ?? {}).sort();
  if (JSON.stringify(jobKeys) !== JSON.stringify(["if", "runs-on", "steps", "timeout-minutes"])) bad("job keys must be exactly if, runs-on, timeout-minutes, steps");
  const stepKeys = (Object.values(doc.jobs ?? {})[0]?.steps ?? []).map((step) => Object.keys(step).sort().join("+"));
  const wantStepKeys = ["uses+with", "name+run+shell", "name+run+shell", "uses+with", "env+name+run+shell", "name+uses+with", "name+run+shell", "name+run+timeout-minutes", "name+uses+with", "if+name+uses+with"];
  if (JSON.stringify(stepKeys) !== JSON.stringify(wantStepKeys)) bad("step keys are not the reviewed closed sets");
  for (const step of Object.values(doc.jobs ?? {})[0]?.steps ?? []) if (step.shell !== undefined && step.shell !== "bash") bad("a step shell must be bash");

  // 2. Least privilege, no secrets. The only token use is the cross-run download's own input.
  if (JSON.stringify(doc.permissions) !== JSON.stringify({ contents: "read", actions: "read" })) bad("permissions must be exactly contents: read and actions: read");
  const jobs = doc.jobs ?? {};
  if (Object.keys(jobs).length !== 1) bad("exactly one job");
  const job = Object.values(jobs)[0] ?? {};
  if (job.permissions !== undefined) bad("job must not override permissions");
  if (/secrets\.|GITHUB_TOKEN|id-token|persist-credentials:\s*true/i.test(text)) bad("secrets/token/id-token/credential persistence");
  if ((text.match(/github\.token/g) ?? []).length !== 2) bad("github.token may appear exactly twice: the artifact API check's GH_TOKEN and the download's own input");
  if (job.env !== undefined || (job.steps ?? []).some((s) => s.env !== undefined && s !== (job.steps ?? [])[4])) bad("env is only allowed at workflow level and on the artifact API check");
  if (JSON.stringify((job.steps ?? [])[4]?.env ?? {}) !== JSON.stringify({ GH_TOKEN: "${{ github.token }}" })) bad("the artifact API check carries exactly GH_TOKEN");
  if (/continue-on-error/.test(text)) bad("continue-on-error anywhere");

  // 3. The firing gate, every conjunct.
  const gate = job.if ?? "";
  for (const piece of [`github.repository == '${REPOSITORY}'`, "github.event_name == 'push'", `github.ref == 'refs/heads/${TRIGGER_BRANCH}'`, "github.event.created == true", "github.run_attempt == '1'"]) if (!gate.includes(piece)) bad(`job if lacks: ${piece}`);
  if (/\|\||\bor\b/.test(gate)) bad("job if must be a pure conjunction");
  if (job["runs-on"] !== "ubuntu-24.04-arm") bad("runs-on must be ubuntu-24.04-arm");
  if (typeof job["timeout-minutes"] !== "number" || job["timeout-minutes"] > 30) bad("bounded timeout required");

  // 4. Pinned actions only: exactly the three allowed, each the commit this gate names.
  const steps = job.steps ?? [];
  for (const step of steps) {
    if (!step.uses) continue;
    const [action, ref] = step.uses.split("@");
    if (!(action && action in ACTIONS)) bad(`action not allowed: ${action}`);
    else if (!/^[0-9a-f]{40}$/.test(ref ?? "")) bad(`action not pinned to a full SHA: ${step.uses}`);
    else if (ACTIONS[action] !== ref) bad(`action SHA differs from the reviewed pin: ${step.uses}`);
  }
  if (/actions\/cache|setup-bun|setup-node|setup-python|pnpm\/action-setup|github-script/.test(text)) bad("unexpected action");

  // 5. The first two steps: the pushed-commit checkout with full history, then the arming guard.
  const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
  if (checkouts.length !== 2) bad("exactly two checkouts");
  const runtimeCheckout = checkouts[1];
  if (JSON.stringify(runtimeCheckout?.with ?? {}) !== JSON.stringify({ repository: RUNTIME_REPOSITORY, ref: "${{ env.RUNTIME_SDK_HEAD }}", path: "origins/runtime", "persist-credentials": false })) bad("the second checkout must be the runtime repository at RUNTIME_SDK_HEAD, credential-free");
  if (runtimeCheckout && steps.indexOf(runtimeCheckout) !== 3) bad("the runtime checkout must follow the pin refusal");
  const first = steps[0];
  if (first !== checkouts[0] || first?.with?.ref !== "${{ github.sha }}" || first?.with?.["fetch-depth"] !== 0 || first?.with?.["persist-credentials"] !== false) bad("the first step must be the pushed-commit checkout with full history, credential-free");
  if (JSON.stringify(Object.keys(first?.with ?? {}).sort()) !== JSON.stringify(["fetch-depth", "persist-credentials", "ref"])) bad("checkout has extra with: keys");
  const guardLines = logicalLines(steps[1]?.run ?? "");
  for (const [label, line] of GUARD) if (!guardLines.includes(line)) bad(`arming guard lacks ${label}`);
  if (JSON.stringify(guardLines) !== JSON.stringify(GUARD.map(([, line]) => line))) bad("arming guard is not exactly the reviewed script");
  const pinLines = logicalLines(steps[2]?.run ?? "");
  for (const [label, line] of PIN_REFUSAL) if (!pinLines.includes(line)) bad(`pin refusal lacks ${label}`);
  if (JSON.stringify(pinLines) !== JSON.stringify(PIN_REFUSAL.map(([, line]) => line))) bad("pin refusal is not exactly the reviewed script");

  // 6. The env block: unarmed or armed with plain hex, never a branch name; the digests match the files they name.
  const env = (doc.env ?? {}) as Record<string, unknown>;
  if (JSON.stringify(Object.keys(env).sort()) !== JSON.stringify(["HOSTED_HEAD", "PACKET_ARCHIVE_SHA256", "PACKET_ARTIFACT_ID", "PACKET_INVENTORY_SHA256", "PACKET_PIN_SHA256", "PACKET_RUN_ID", "PACKET_ZIP_SHA256", "RUNNER_SHA256", "RUNTIME_SDK_HEAD", "VERIFIER_SHA256"])) bad("env keys must be exactly the reviewed pins");
  if (typeof env.HOSTED_HEAD !== "string" || !/^[0-9a-f]{40}$/.test(env.HOSTED_HEAD)) bad("HOSTED_HEAD must be a 40-hex commit (all zeros while unarmed)");
  if (typeof env.RUNTIME_SDK_HEAD !== "string" || !/^[0-9a-f]{40}$/.test(env.RUNTIME_SDK_HEAD)) bad("RUNTIME_SDK_HEAD must be a 40-hex commit (all zeros while unset)");
  for (const key of ["PACKET_ARCHIVE_SHA256", "PACKET_INVENTORY_SHA256", "RUNNER_SHA256", "PACKET_PIN_SHA256", "VERIFIER_SHA256", "PACKET_ZIP_SHA256"]) if (typeof env[key] !== "string" || !/^[0-9a-f]{64}$/.test(env[key] as string)) bad(`${key} must be 64-hex (all zeros while unset)`);
  if (typeof env.PACKET_RUN_ID !== "string" || !/^(0|[1-9][0-9]{8,12})$/.test(env.PACKET_RUN_ID)) bad("PACKET_RUN_ID must be a plain run id (0 while unset)");
  if (typeof env.PACKET_ARTIFACT_ID !== "string" || !/^(0|[1-9][0-9]{8,12})$/.test(env.PACKET_ARTIFACT_ID)) bad("PACKET_ARTIFACT_ID must be a plain artifact id (0 while unset)");
  if (env.PACKET_RUN_ID === "39165162201") bad("the first guided packet (placeholder roles) must never be bound");
  for (const [key, want] of Object.entries(EXPECTED_BINDING)) if (env[key] !== want) bad(`${key} is not the reviewed run-2 value`);
  // The runner is committed, so its pin is always the real hash of the file; it is never a placeholder.
  if (!ctx.runnerExists) bad("RUNNER_SHA256 is set but the runner file does not exist");
  else if (ctx.runnerSha256 !== env.RUNNER_SHA256) bad("RUNNER_SHA256 does not match the runner file");
  if (env.HOSTED_HEAD !== ZERO40 && (env.PACKET_RUN_ID === "0" || env.RUNTIME_SDK_HEAD === ZERO40 || [env.PACKET_ARCHIVE_SHA256, env.PACKET_INVENTORY_SHA256, env.PACKET_PIN_SHA256, env.VERIFIER_SHA256, env.PACKET_ZIP_SHA256].some((v) => v === ZERO64))) bad("armed with an unset pin");

  // 7. The download: the first network step, before anything privileged, and only the one named artifact of the one named run.
  const downloads = steps.filter((s) => s.uses?.startsWith("actions/download-artifact@"));
  if (downloads.length !== 1) bad("exactly one download");
  const download = downloads[0];
  const wantWith = { name: "guided-packet-compile-${{ env.PACKET_RUN_ID }}", "run-id": "${{ env.PACKET_RUN_ID }}", repository: RUNTIME_REPOSITORY, "github-token": "${{ github.token }}", path: "packet-download" };
  if (JSON.stringify(download?.with ?? {}) !== JSON.stringify(wantWith)) bad("the download must name exactly the packet artifact of PACKET_RUN_ID in the runtime repository");
  const downloadAt = download ? steps.indexOf(download) : -1;
  const verifyAt = steps.findIndex((s) => (s.run ?? "").includes("sha256sum --check --strict"));
  const sudoAt = steps.findIndex((s) => /\bsudo\b/.test(logicalLines(s.run ?? "").join("\n")));
  if (!(downloadAt === 5 && verifyAt === 6 && sudoAt === 7)) bad("order must be checkout, guard, pin refusal, runtime checkout, artifact check, download, verify, sudo");
  const apiAt = steps.findIndex((s) => (s.run ?? "").includes("urllib"));
  if (apiAt !== 4) bad("the artifact API check must be the step right before the download");
  const apiLines = logicalLines(steps[apiAt]?.run ?? "");
  for (const [label, line] of API_CHECK) if (!apiLines.includes(line)) bad(`artifact check lacks ${label}`);
  if (JSON.stringify(apiLines) !== JSON.stringify(API_CHECK.map(([, line]) => line))) bad("artifact check is not exactly the reviewed script");
  if ((text.match(/urllib/g) ?? []).length !== 3 || (text.match(/https?:\/\//g) ?? []).length !== 1) bad("the artifact check is the only code that reaches a URL");

  // 8. Verification before anything privileged: the exact lines.
  const verifyLines = logicalLines(steps[verifyAt]?.run ?? "");
  for (const [label, line] of VERIFY) if (!verifyLines.includes(line)) bad(`verify step lacks ${label}`);
  if (JSON.stringify(verifyLines) !== JSON.stringify(VERIFY.map(([, line]) => line))) bad("verify step is not exactly the reviewed script");

  // 9. The single privileged step: one sudo, the exact opt-in command, the exact root launcher.
  if (text.split(OPT_IN).length - 1 !== 1) bad("opt-in variable must appear exactly once in the workflow");
  const commandText = steps.map((s) => logicalLines(s.run ?? "").join("\n")).join("\n");
  if ((commandText.match(/\bsudo\b/g) ?? []).length !== 1) bad("exactly one sudo command");
  const sudoStep = steps[sudoAt];
  const sudoRun = sudoStep?.run ?? "";
  const sudoLines = logicalLines(sudoRun);
  if (sudoLines[0] !== SUDO_LINE) bad("the sudo line must be exactly the reviewed command");
  if (typeof sudoStep?.["timeout-minutes"] !== "number" || typeof job["timeout-minutes"] !== "number" || sudoStep["timeout-minutes"] >= job["timeout-minutes"] - 2) bad("the sudo step needs its own timeout, below the job's, so the failure diagnostics still upload");
  const heredoc = sudoRun.slice(sudoRun.indexOf("<<'PY'\n") + 7, sudoRun.lastIndexOf("\nPY") + 1);
  if (heredoc !== ROOT_PY) bad("the root launcher must be exactly the reviewed text");
  if (sudoLines[sudoLines.length - 1] !== "PY") bad("the root launcher must end the step");
  if (steps.filter((s) => (s.run ?? "").includes(OPT_IN)).length !== 1) bad("opt-in only in the one sudo step");
  if (/WINTER_GUIDED_OWNER_NATIVE_ADMISSION/.test(text)) bad("the owner-matrix admission variable must not appear here");

  // 9b. The privileged step runs ONE file, the hashed runner, and the runner executes only bytes it hashed first.
  for (const problem of runnerProblems(ctx.runnerText, ctx.sessionText, ctx.siblingSha256, ctx.adapterText, ctx.oracleText)) bad(problem);

  // 10. The network: nothing but the checkout and the one download.
  if (/\b(curl|wget|nc|ncat|ssh|scp|apt(-get)?|pip3?|npm|npx|pnpm|yarn|corepack|bun\s+(install|add|x)|git\s+(clone|fetch|pull|push|remote|submodule)|docker|gh)\b/.test(commandText.replace(/--tlsv1\.2/g, ""))) bad("a step reaches the network or installs something");

  // 11. Results: one success upload, one failure-only diagnostics upload, 7 days, after the privileged step.
  const uploads = steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
  if (uploads.length !== 2) bad("exactly two uploads");
  const [result, diagnostics] = uploads;
  if (result?.if !== undefined) bad("the result upload must run on success only (no if:)");
  if (JSON.stringify(result?.with ?? {}) !== JSON.stringify({ name: "guided-hosted-result-${{ github.run_id }}", path: "${{ runner.temp }}/guided-hosted-out/result.json", "if-no-files-found": "error", "retention-days": 7 })) bad("the result upload must carry only result.json for 7 days");
  if (diagnostics?.if !== "failure()") bad("the diagnostics upload must run on failure only");
  if (JSON.stringify(diagnostics?.with ?? {}) !== JSON.stringify({ name: "guided-hosted-diagnostics-${{ github.run_id }}", path: "${{ runner.temp }}/guided-hosted-out/result.json", "if-no-files-found": "ignore", "retention-days": 7 })) bad("the diagnostics upload must carry only bounded records for 7 days");
  if (result && diagnostics && !(sudoAt >= 0 && steps.indexOf(result) === sudoAt + 1 && steps.indexOf(diagnostics) === sudoAt + 2 && steps[steps.length - 1] === diagnostics)) bad("order must be sudo, result upload, diagnostics upload");
  return problems;
}

describe("guided hosted run workflow gates", () => {
  test("the committed workflow satisfies every gate", () => {
    expect(violations(WORKFLOW)).toEqual([]);
  });

  test("the trigger is the exact first-creation push of one new branch, and nothing else", () => {
    const doc = yaml.parse(WORKFLOW) as Doc;
    expect(doc.on).toEqual({ push: { branches: [TRIGGER_BRANCH] } });
    for (const name of ["pull_request", "pull_request_target", "workflow_dispatch", "schedule", "workflow_run", "repository_dispatch", "release", "issue_comment"]) expect(Object.keys(doc.on ?? {})).not.toContain(name);
    expect(USED_BRANCHES).not.toContain(TRIGGER_BRANCH);
  });

  test("the workflow runs runtime-sdk's verifier with an explicit --pin and refuses on any non-zero exit (two pins now exist, so the default lookup exits 2)", () => {
    const steps = (yaml.parse(WORKFLOW) as Doc).jobs?.["guided-hosted-run"]?.steps ?? [];
    const verify = logicalLines(steps[6]?.run ?? "");
    const call = verify.filter((l) => l.includes("verify_packet.py") && l.startsWith("/usr/bin/python3"));
    expect(call).toHaveLength(1);
    expect(call[0]).toContain('--pin "origins/runtime/scripts/guest-guided-intake/compile-${PACKET_RUN_ID}.pin.json"');
    expect(call[0]).toContain("packet-download/guided-packet.tar.gz packet-download/packet-inventory.json");
    expect(call[0]).not.toMatch(/\|\||;|&&/);
    expect(verify[0]).toBe("set -euo pipefail");
    // the root step carries the same pin file, and the runner passes --pin itself
    expect(steps[7]?.run).toContain('"origins/runtime/scripts/guest-guided-intake/compile-${PACKET_RUN_ID}.pin.json" "$PACKET_PIN_SHA256"');
    expect(readFileSync(join(ROOT, "scripts/guest-hosted-guided/run.py"), "utf8")).toContain("'--pin', pin");
    expect(`compile-${EXPECTED_BINDING.PACKET_RUN_ID}.pin.json`).toBe("compile-39227365159.pin.json");
  });

  test("the trigger branch is absent from every other workflow", () => {
    for (const [name, text] of Object.entries(loadContext().others)) expect([name, text.includes(TRIGGER_BRANCH)]).toEqual([name, false]);
  });

  test("the committed state is unarmed: only the head is unset, so the first step refuses; the packet is bound to run 39227365159", () => {
    const env = (yaml.parse(WORKFLOW) as Doc).env as Record<string, string>;
    expect(env.HOSTED_HEAD).toBe(ZERO40);
    for (const [key, want] of Object.entries(EXPECTED_BINDING)) expect([key, env[key]]).toEqual([key, want]);
    // The digests are set in an ordinary reviewed commit; until then they are zero and the refusal step stops the run.
    for (const key of ["PACKET_ARCHIVE_SHA256", "PACKET_INVENTORY_SHA256", "RUNNER_SHA256"]) expect([key, /^[0-9a-f]{64}$/.test(env[key] as string)]).toEqual([key, true]);
  });

  test("the doc states the trigger, the owner approval, the freeze and the blockers", () => {
    const doc = readFileSync(join(ROOT, "docs/guided-hosted-run.md"), "utf8");
    expect(doc).toContain(TRIGGER_BRANCH);
    expect(doc.toLowerCase()).toContain("frozen");
    expect(doc).toContain("placeholder");
    expect(doc).toContain("if an automated safety flag fires on follow-on work, that work stops and is surfaced to the owner, never reworded or rerouted.");
    expect(doc).not.toMatch(/C59 (is|was) explained/i);
  });

  test("the runner the pin names is covered by an oracle test that exists", () => {
    expect(existsSync(join(ROOT, "scripts/guest-hosted-guided/oracle.py"))).toBe(true);
    expect(loadContext().oracleTest).toContain("test_zero_further_provider_requests_after_revocation");
  });
});

// Each entry removes or breaks exactly one gate. Every one must make `violations` contain its own named message.
const sub = (from: string | RegExp, to: string) => (t: string) => t.replace(from, to);
const subAll = (from: string, to: string) => (t: string) => t.replaceAll(from, to);
const MUTATIONS: Array<[string, (text: string) => string, string, Partial<Context>?]> = [
  // trigger
  ["add pull_request trigger", sub("on:\n  push:", "on:\n  pull_request:\n  push:"), "on: must be exactly {push}, got pull_request,push"],
  ["add pull_request_target trigger", sub("on:\n  push:", "on:\n  pull_request_target:\n  push:"), "on: must be exactly {push}, got pull_request_target,push"],
  ["add workflow_dispatch trigger", sub("on:\n  push:", "on:\n  workflow_dispatch:\n  push:"), "on: must be exactly {push}, got workflow_dispatch,push"],
  ["add schedule trigger", sub("on:\n  push:", "on:\n  schedule:\n    - cron: '0 0 * * *'\n  push:"), "on: must be exactly {push}, got schedule,push"],
  ["add workflow_run trigger", sub("on:\n  push:", "on:\n  workflow_run:\n    workflows: [ci]\n  push:"), "on: must be exactly {push}, got workflow_run,push"],
  ["widen the branch to a glob", sub("[cowork/guided-hosted-run]", "[cowork/**]"), "on.push must be exactly one literal branch and nothing else"],
  ["add a tags filter", sub("  push:\n    branches:", "  push:\n    tags: ['*']\n    branches:"), "on.push must be exactly one literal branch and nothing else"],
  ["add a paths filter", sub("    branches: [cowork/guided-hosted-run]\n", "    branches: [cowork/guided-hosted-run]\n    paths: ['x']\n"), "on.push must be exactly one literal branch and nothing else"],
  ["swap to a used branch", subAll("cowork/guided-hosted-run", "cowork/guided-owner-matrix-run"), "on.push must be exactly one literal branch and nothing else"],
  // permissions, secrets
  ["drop top-level permissions", sub("permissions:\n  contents: read\n  actions: read\n", ""), "permissions must be exactly contents: read and actions: read"],
  ["widen contents to write", sub("contents: read", "contents: write"), "permissions must be exactly contents: read and actions: read"],
  ["add id-token", sub("actions: read\n", "actions: read\n  id-token: write\n"), "secrets/token/id-token/credential persistence"],
  ["job-level permission override", sub("    runs-on:", "    permissions:\n      contents: read\n    runs-on:"), "job must not override permissions"],
  ["use a secret", sub("          path: packet-download\n", "          path: packet-download\n          extra: ${{ secrets.K }}\n"), "secrets/token/id-token/credential persistence"],
  ["use GITHUB_TOKEN", sub("test \"$(uname -s)\" = Linux", "test \"$(uname -s)\" = Linux; echo $GITHUB_TOKEN"), "secrets/token/id-token/credential persistence"],
  ["second github.token use", sub("test \"$(uname -s)\" = Linux", "test \"$(uname -s)\" = Linux; echo ${{ github.token }}"), "github.token may appear exactly twice: the artifact API check's GH_TOKEN and the download's own input"],
  ["checkout keeps credentials", sub("persist-credentials: false", "persist-credentials: true"), "secrets/token/id-token/credential persistence"],
  ["job env", sub("    timeout-minutes: 20\n", "    timeout-minutes: 20\n    env:\n      X: y\n"), "env is only allowed at workflow level and on the artifact API check"],
  ["continue-on-error on a step", sub("      - name: Retain the bounded result\n", "      - continue-on-error: true\n        name: Retain the bounded result\n"), "continue-on-error anywhere"],
  // firing gate
  ["drop the repository gate", sub("github.repository == 'yanlingLabs/winter-agent-sdk' && ", ""), "job if lacks: github.repository == 'yanlingLabs/winter-agent-sdk'"],
  ["drop the event-name gate", sub("github.event_name == 'push' && ", ""), "job if lacks: github.event_name == 'push'"],
  ["drop the exact-ref gate", sub(" && github.ref == 'refs/heads/cowork/guided-hosted-run'", ""), "job if lacks: github.ref == 'refs/heads/cowork/guided-hosted-run'"],
  ["drop the first-creation gate", sub(" && github.event.created == true", ""), "job if lacks: github.event.created == true"],
  ["drop the run_attempt gate", sub(" && github.run_attempt == '1'", ""), "job if lacks: github.run_attempt == '1'"],
  ["gate becomes a disjunction", sub("github.event.created == true &&", "github.event.created == true ||"), "job if must be a pure conjunction"],
  ["wrong runner", sub("ubuntu-24.04-arm", "ubuntu-latest"), "runs-on must be ubuntu-24.04-arm"],
  ["no timeout", sub("    timeout-minutes: 20\n", ""), "bounded timeout required"],
  // actions
  ["unpin checkout", sub(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v4"), "action not pinned to a full SHA: actions/checkout@v4"],
  ["unpin download-artifact", sub(/actions\/download-artifact@[0-9a-f]{40}/, "actions/download-artifact@v4"), "action not pinned to a full SHA: actions/download-artifact@v4"],
  ["unpin upload-artifact", sub(/actions\/upload-artifact@[0-9a-f]{40}/, "actions/upload-artifact@v4"), "action not pinned to a full SHA: actions/upload-artifact@v4"],
  ["swap a pinned sha", sub(/actions\/checkout@[0-9a-f]{40}/, `actions/checkout@${"a".repeat(40)}`), `action SHA differs from the reviewed pin: actions/checkout@${"a".repeat(40)}`],
  ["add github-script", sub("      - name: Retain the bounded result\n", "      - uses: actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b\n      - name: Retain the bounded result\n"), "unexpected action"],
  // checkout and arming guard
  ["checkout fetches submodules", sub("          fetch-depth: 0\n", "          fetch-depth: 0\n          submodules: recursive\n"), "checkout has extra with: keys"],
  ["checkout loses full history", sub("          fetch-depth: 0\n", ""), "the first step must be the pushed-commit checkout with full history, credential-free"],
  ["third checkout", sub("      - name: Refuse while", "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n      - name: Refuse while"), "exactly two checkouts"],
  ["runtime checkout: wrong repository", sub("repository: yanlingLabs/winter-runtime-sdk\n          ref: ${{ env.RUNTIME_SDK_HEAD }}", "repository: someone/else\n          ref: ${{ env.RUNTIME_SDK_HEAD }}"), "the second checkout must be the runtime repository at RUNTIME_SDK_HEAD, credential-free"],
  ["runtime checkout moves after the download", (t) => t.replace(/(      - uses: actions\/checkout@[0-9a-f]{40}\n        with:\n          repository: [\s\S]*?persist-credentials: false\n)([\s\S]*?path: packet-download\n)/, "$2$1"), "the runtime checkout must follow the pin refusal"],
  ["runtime checkout: a branch ref", sub("ref: ${{ env.RUNTIME_SDK_HEAD }}", "ref: main"), "the second checkout must be the runtime repository at RUNTIME_SDK_HEAD, credential-free"],
  ["runtime checkout: keeps credentials", sub("          path: origins/runtime\n          persist-credentials: false", "          path: origins/runtime\n          persist-credentials: true"), "the second checkout must be the runtime repository at RUNTIME_SDK_HEAD, credential-free"],
  ["guard: unarmed refusal removed", sub(/ *test "\$HOSTED_HEAD" != "0+"\n/, ""), "arming guard lacks the unarmed refusal"],
  ["guard: ancestor check removed", sub(/ *git merge-base --is-ancestor[^\n]*\n/, ""), "arming guard lacks the ancestor check"],
  ["guard: ancestor check made advisory", sub('"$GITHUB_SHA"\n          test "$(git diff --name-only', '"$GITHUB_SHA" || true\n          test "$(git diff --name-only'), "arming guard lacks the ancestor check"],
  ["guard: single-file check removed", sub(/ *test "\$\(git diff --name-only[^\n]*\n/, ""), "arming guard lacks the single-file check"],
  ["guard: single-file check allows another file", sub(`= "${WORKFLOW_PATH}"`, '!= ""'), "arming guard lacks the single-file check"],
  ["guard: numstat check removed", sub(/ *test "\$\(git diff --numstat[^\n]*\n/, ""), "arming guard lacks the numstat check"],
  ["guard: numstat allows two added lines", sub("'1\\t1\\t%s'", "'2\\t1\\t%s'"), "arming guard lacks the numstat check"],
  ["guard: diff capture removed", sub(/ *armed_diff=\$\([^\n]*\n/, ""), "arming guard lacks the diff capture"],
  ["guard: one-line diff check removed", sub(/ *test "\$armed_diff"[^\n]*\n/, ""), "arming guard lacks the exact one-line diff check"],
  ["guard: diff filter accepts two lines", sub("grep -E '^[-+][^-+]'", "grep -E '^[+][^+]'"), "arming guard lacks the diff capture"],
  ["guard: reviewed-head checkout removed", sub(/ *git checkout --detach --quiet[^\n]*\n/, ""), "arming guard lacks the reviewed-head checkout"],
  ["guard: an extra line after the checkout", sub('git checkout --detach --quiet "$HOSTED_HEAD"\n', 'git checkout --detach --quiet "$HOSTED_HEAD"\n          git submodule update --init\n'), "arming guard is not exactly the reviewed script"],
  ["guard: strict shell removed", sub("          set -euo pipefail\n          test \"$HOSTED_HEAD\"", "          test \"$HOSTED_HEAD\""), "arming guard lacks the strict shell"],
  // pins and the unset refusal
  ["pin refusal: archive removed", sub(/ *test "\$PACKET_ARCHIVE_SHA256" != "0+"\n/, ""), "pin refusal lacks the archive pin refusal"],
  ["pin refusal: inventory removed", sub(/ *test "\$PACKET_INVENTORY_SHA256" != "0+"\n/, ""), "pin refusal lacks the inventory pin refusal"],
  ["pin refusal: runner removed", sub(/ *test "\$RUNNER_SHA256" != "0+"\n/, ""), "pin refusal lacks the runner pin refusal"],
  ["pin refusal: an extra command", sub(`test "$RUNNER_SHA256" != "${ZERO64}"\n`, `test "$RUNNER_SHA256" != "${ZERO64}"\n          echo ok\n`), "pin refusal is not exactly the reviewed script"],
  ["pin refusal: made advisory", sub('test "$RUNNER_SHA256" != "' + ZERO64 + '"', 'test "$RUNNER_SHA256" != "' + ZERO64 + '" || true'), "pin refusal lacks the runner pin refusal"],
  ["env: a pin key added", sub("  RUNNER_SHA256:", "  EXTRA: 'x'\n  RUNNER_SHA256:"), "env keys must be exactly the reviewed pins"],
  ["env: HOSTED_HEAD becomes a branch name", sub(`HOSTED_HEAD: '${ZERO40}'`, "HOSTED_HEAD: 'main'"), "HOSTED_HEAD must be a 40-hex commit (all zeros while unarmed)"],
  ["env: archive pin becomes short", sub(/PACKET_ARCHIVE_SHA256: '[0-9a-f]{64}'/, "PACKET_ARCHIVE_SHA256: 'abc'"), "PACKET_ARCHIVE_SHA256 must be 64-hex (all zeros while unset)"],
  ["env: run id becomes a name", sub("PACKET_RUN_ID: '39227365159'", "PACKET_RUN_ID: 'latest'"), "PACKET_RUN_ID must be a plain run id (0 while unset)"],
  ["env: archive digest drifts", sub(/PACKET_ARCHIVE_SHA256: '[0-9a-f]{64}'/, `PACKET_ARCHIVE_SHA256: '${"5".repeat(64)}'`), "PACKET_ARCHIVE_SHA256 is not the reviewed run-2 value"],
  ["env: inventory digest drifts", sub(/PACKET_INVENTORY_SHA256: '[0-9a-f]{64}'/, `PACKET_INVENTORY_SHA256: '${"5".repeat(64)}'`), "PACKET_INVENTORY_SHA256 is not the reviewed run-2 value"],
  ["env: pin digest drifts", sub(/PACKET_PIN_SHA256: '[0-9a-f]{64}'/, `PACKET_PIN_SHA256: '${"5".repeat(64)}'`), "PACKET_PIN_SHA256 is not the reviewed run-2 value"],
  ["env: verifier digest drifts", sub(/VERIFIER_SHA256: '[0-9a-f]{64}'/, `VERIFIER_SHA256: '${"5".repeat(64)}'`), "VERIFIER_SHA256 is not the reviewed run-2 value"],
  ["env: runtime head drifts", sub(/RUNTIME_SDK_HEAD: '[0-9a-f]{40}'/, `RUNTIME_SDK_HEAD: '${"5".repeat(40)}'`), "RUNTIME_SDK_HEAD is not the reviewed run-2 value"],
  ["env: run id drifts", sub("PACKET_RUN_ID: '39227365159'", "PACKET_RUN_ID: '39227365160'"), "PACKET_RUN_ID is not the reviewed run-2 value"],
  ["env: the first (placeholder-role) packet is bound", sub("PACKET_RUN_ID: '39227365159'", "PACKET_RUN_ID: '39165162201'"), "the first guided packet (placeholder roles) must never be bound"],
  ["pin refusal: run id removed", sub(/ *test "\$PACKET_RUN_ID" != "0"\n/, ""), "pin refusal lacks the run id refusal"],
  ["env: runner pin is not the runner file's hash", sub(/RUNNER_SHA256: '[0-9a-f]{64}'/, `RUNNER_SHA256: '${"1".repeat(64)}'`), "RUNNER_SHA256 does not match the runner file"],
  ["env: runner file missing", sub(/RUNNER_SHA256: '[0-9a-f]{64}'/, `RUNNER_SHA256: '${"1".repeat(64)}'`), "RUNNER_SHA256 is set but the runner file does not exist", { runnerExists: false, runnerSha256: "" }],
  ["env: runtime head becomes a branch name", sub(/RUNTIME_SDK_HEAD: '[0-9a-f]{40}'/, "RUNTIME_SDK_HEAD: 'main'"), "RUNTIME_SDK_HEAD must be a 40-hex commit (all zeros while unset)"],
  ["env: verifier pin becomes short", sub(/VERIFIER_SHA256: '[0-9a-f]{64}'/, "VERIFIER_SHA256: 'abc'"), "VERIFIER_SHA256 must be 64-hex (all zeros while unset)"],
  ["pin refusal: runtime head removed", sub(/ *test "\$RUNTIME_SDK_HEAD" != "0+"\n/, ""), "pin refusal lacks the runtime head refusal"],
  ["pin refusal: pin digest removed", sub(/ *test "\$PACKET_PIN_SHA256" != "0+"\n/, ""), "pin refusal lacks the pin file digest refusal"],
  ["pin refusal: verifier digest removed", sub(/ *test "\$VERIFIER_SHA256" != "0+"\n/, ""), "pin refusal lacks the verifier digest refusal"],
  ["env: armed with an unset pin", (t) => t.replace(`HOSTED_HEAD: '${ZERO40}'`, `HOSTED_HEAD: '${"2".repeat(40)}'`).replace(/VERIFIER_SHA256: '[0-9a-f]{64}'/, `VERIFIER_SHA256: '${ZERO64}'`), "armed with an unset pin"],
  // download
  ["download: wrong repository", sub(`repository: ${RUNTIME_REPOSITORY}\n          github-token`, "repository: someone/else\n          github-token"), "the download must name exactly the packet artifact of PACKET_RUN_ID in the runtime repository"],
  ["download: a different artifact name", sub("name: guided-packet-compile-${{ env.PACKET_RUN_ID }}", "name: other"), "the download must name exactly the packet artifact of PACKET_RUN_ID in the runtime repository"],
  ["download: a second artifact via pattern", sub("          path: packet-download\n", "          path: packet-download\n          pattern: '*'\n"), "the download must name exactly the packet artifact of PACKET_RUN_ID in the runtime repository"],
  ["download: no run id", sub("          run-id: ${{ env.PACKET_RUN_ID }}\n", ""), "the download must name exactly the packet artifact of PACKET_RUN_ID in the runtime repository"],
  ["download: second download", sub("      - name: Verify the packet", "      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093\n      - name: Verify the packet"), "exactly one download"],
  ["download moves after verify", (t) => t.replace(/(      - name: Download[\s\S]*?path: packet-download\n)([\s\S]*?)(      - name: Run the guided)/, "$2$1$3"), "order must be checkout, guard, pin refusal, runtime checkout, artifact check, download, verify, sudo"],
  // verification
  ["verify: strict packet check removed", sub(/ *printf '%s  %s\\n' "\$PACKET_ARCHIVE_SHA256"[^\n]*\n/, ""), "verify step lacks the strict packet digest check"],
  ["verify: packet check not strict", sub(/(PACKET_ARCHIVE_SHA256[^\n]*)--strict/, "$1"), "verify step lacks the strict packet digest check"],
  ["verify: runner check removed", sub(/ *printf '%s  %s\\n' "\$RUNNER_SHA256"[^\n]*\n/, ""), "verify step lacks the strict runner digest check"],
  ["verify: two-file directory check removed", sub(/ *test "\$\(ls -A packet-download[^\n]*\n/, ""), "verify step lacks the exact two-file packet directory"],
  ["verify: verifier and pin digest check removed", sub(/ *printf '%s  %s\\n' "\$VERIFIER_SHA256"[^\n]*\n/, ""), "verify step lacks the verifier and pin digest check"],
  ["verify: packet verification removed", sub(/ *\/usr\/bin\/python3 -I -B origins\/runtime\/scripts\/guest-guided-intake\/verify_packet.py[^\n]*\n/, ""), "verify step lacks the packet verification"],
  ["verify: packet verification made advisory", sub('> "$RUNNER_TEMP/packet-verification.json"', '> "$RUNNER_TEMP/packet-verification.json" || true'), "verify step lacks the packet verification"],
  ["verify: verifier run against a different pin", sub('--pin "origins/runtime/scripts/guest-guided-intake/compile-\${PACKET_RUN_ID}.pin.json" >', '--pin other.json >'), "verify step lacks the packet verification"],
  ["verify: architecture check removed", sub(/ *test "\$\(uname -m\)" = aarch64\n/, ""), "verify step lacks the architecture check"],
  ["verify: an extra command", sub('mkdir -m 755 "$RUNNER_TEMP/guided-hosted-out"\n', 'mkdir -m 755 "$RUNNER_TEMP/guided-hosted-out"\n          chmod 777 "$RUNNER_TEMP/guided-hosted-out"\n'), "verify step is not exactly the reviewed script"],
  // the privileged step
  ["sudo: opt-in in the verify step", sub('test "$(uname -s)" = Linux', `test "$(uname -s)" = Linux; export ${OPT_IN}=x`), "opt-in variable must appear exactly once in the workflow"],
  ["sudo: opt-in in workflow env", sub("env:\n  HOSTED_HEAD", `env:\n  ${OPT_IN}: x\n  HOSTED_HEAD`), "opt-in variable must appear exactly once in the workflow"],
  ["sudo: opt-in loses sudo -n env", sub(`sudo -n env -i ${OPT_IN}=`, `${OPT_IN}=`), "the sudo line must be exactly the reviewed command"],
  ["sudo: verifier arguments dropped", sub(' origins/runtime/scripts/guest-guided-intake/verify_packet.py "$VERIFIER_SHA256" "origins/runtime/scripts/guest-guided-intake/compile-${PACKET_RUN_ID}.pin.json" "$PACKET_PIN_SHA256" <<\'PY\'', " <<'PY'"), "the sudo line must be exactly the reviewed command"],
  ["sudo: the launcher drops the extra arguments", sub("sys.argv = [source, packet, out, *extra]", "sys.argv = [source, packet, out]"), "the root launcher must be exactly the reviewed text"],
  ["sudo: interpreter loses -I", sub("python3 -I -S -B - ", "python3 -S -B - "), "the sudo line must be exactly the reviewed command"],
  ["sudo: a different runner path", sub(`${RUNNER_PATH} packet-download`, "scripts/other.py packet-download"), "the sudo line must be exactly the reviewed command"],
  ["sudo: an extra sudo command", sub('mkdir -m 755 "$RUNNER_TEMP/guided-hosted-out"\n', 'mkdir -m 755 "$RUNNER_TEMP/guided-hosted-out"\n          sudo -n true\n'), "exactly one sudo command"],
  ["sudo: the launcher stops comparing digests", sub("hashlib.sha256(data).hexdigest() != digest", "False"), "the root launcher must be exactly the reviewed text"],
  ["sudo: the launcher stops requiring root", sub("if os.geteuid() != 0:", "if False:"), "the root launcher must be exactly the reviewed text"],
  ["sudo: the launcher follows symlinks", sub("os.O_NOFOLLOW | ", ""), "the root launcher must be exactly the reviewed text"],
  ["sudo: the launcher runs something else", sub("exec(compile(data, source, 'exec')", "exec(compile(open(source).read(), source, 'exec')"), "the root launcher must be exactly the reviewed text"],
  ["sudo: the launcher is followed by another command", (t) => t.replace(/(\n          PY\n)(      - name: Retain the bounded result)/, "$1          echo done\n$2"), "the root launcher must end the step"],
  ["sudo: the opt-in is removed from the command", sub(`sudo -n env -i ${OPT_IN}=${OPT_IN_VALUE} `, "sudo -n "), "opt-in only in the one sudo step"],
  ["sudo: a second privileged step reuses the opt-in", sub("      - name: Retain the bounded result\n", `      - run: echo ${OPT_IN}\n      - name: Retain the bounded result\n`), "opt-in variable must appear exactly once in the workflow"],
  ["sudo: the owner-matrix admission variable appears", sub("# ONE-RUN hosted", "# WINTER_GUIDED_OWNER_NATIVE_ADMISSION ONE-RUN hosted"), "the owner-matrix admission variable must not appear here"],
  // network
  ["network: curl step", sub('mkdir -m 755 "$RUNNER_TEMP/guided-hosted-out"\n', 'mkdir -m 755 "$RUNNER_TEMP/guided-hosted-out"\n          curl -sSf https://example.invalid\n'), "a step reaches the network or installs something"],
  ["network: pip install", sub('mkdir -m 755 "$RUNNER_TEMP/guided-hosted-out"\n', 'mkdir -m 755 "$RUNNER_TEMP/guided-hosted-out"\n          pip install x\n'), "a step reaches the network or installs something"],
  // results
  ["result upload keeps 90 days", sub(/(guided-hosted-result[\s\S]*?retention-days: )7/, "$190"), "the result upload must carry only result.json for 7 days"],
  ["result upload carries a directory", sub("path: ${{ runner.temp }}/guided-hosted-out/result.json\n          if-no-files-found: error", "path: ${{ runner.temp }}/guided-hosted-out\n          if-no-files-found: error"), "the result upload must carry only result.json for 7 days"],
  ["result upload runs on failure too", sub("      - name: Retain the bounded result\n", "      - name: Retain the bounded result\n        if: always()\n"), "the result upload must run on success only (no if:)"],
  ["diagnostics upload always runs", sub("if: failure()", "if: always()"), "the diagnostics upload must run on failure only"],
  ["diagnostics upload carries the whole directory", sub(/(name: guided-hosted-diagnostics[^\n]*\n          path: )[^\n]*/, "$1${{ runner.temp }}/guided-hosted-out/"), "the diagnostics upload must carry only bounded records for 7 days"],
  ["diagnostics upload keeps 90 days", sub(/(guided-hosted-diagnostics[\s\S]*?retention-days: )7/, "$190"), "the diagnostics upload must carry only bounded records for 7 days"],
  ["a third upload", (t) => `${t}      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: extra\n          path: .\n`, "exactly two uploads"],
  ["uploads move before the privileged step", (t) => t.replace(/(      - name: Run the guided[\s\S]*?\n          PY\n)([\s\S]*)/, "$2$1"), "order must be sudo, result upload, diagnostics upload"],
  ["two jobs", (t) => `${t}  second:\n    runs-on: ubuntu-24.04-arm\n    steps: []\n`, "exactly one job"],
  // closed key sets: nothing may be added to the workflow, the job or a step that the gate has not read
  ["workflow: defaults.run.shell", sub("concurrency:\n", "defaults:\n  run:\n    shell: bash -c\nconcurrency:\n"), "workflow keys must be exactly name, on, permissions, env, concurrency, jobs"],
  ["workflow: a second env-like key", sub("concurrency:\n", "run-name: x\nconcurrency:\n"), "workflow keys must be exactly name, on, permissions, env, concurrency, jobs"],
  ["concurrency cancels in progress", sub("cancel-in-progress: false", "cancel-in-progress: true"), "concurrency must be exactly the guided-hosted-run group with cancel-in-progress false"],
  ["concurrency group changes", sub("group: guided-hosted-run", "group: other"), "concurrency must be exactly the guided-hosted-run group with cancel-in-progress false"],
  ["job: services", sub("    timeout-minutes: 20\n", "    timeout-minutes: 20\n    services:\n      db:\n        image: x\n"), "job keys must be exactly if, runs-on, timeout-minutes, steps"],
  ["job: container", sub("    timeout-minutes: 20\n", "    timeout-minutes: 20\n    container: ubuntu\n"), "job keys must be exactly if, runs-on, timeout-minutes, steps"],
  ["job: strategy", sub("    timeout-minutes: 20\n", "    timeout-minutes: 20\n    strategy:\n      matrix:\n        a: [1]\n"), "job keys must be exactly if, runs-on, timeout-minutes, steps"],
  ["job: needs", sub("    timeout-minutes: 20\n", "    timeout-minutes: 20\n    needs: [x]\n"), "job keys must be exactly if, runs-on, timeout-minutes, steps"],
  ["job: outputs", sub("    timeout-minutes: 20\n", "    timeout-minutes: 20\n    outputs:\n      a: b\n"), "job keys must be exactly if, runs-on, timeout-minutes, steps"],
  ["job: environment", sub("    timeout-minutes: 20\n", "    timeout-minutes: 20\n    environment: prod\n"), "job keys must be exactly if, runs-on, timeout-minutes, steps"],
  ["job: defaults", sub("    timeout-minutes: 20\n", "    timeout-minutes: 20\n    defaults:\n      run:\n        shell: sh\n"), "job keys must be exactly if, runs-on, timeout-minutes, steps"],
  ["job: continue-on-error", sub("    timeout-minutes: 20\n", "    timeout-minutes: 20\n    continue-on-error: true\n"), "job keys must be exactly if, runs-on, timeout-minutes, steps"],
  ["verify step: if always()", sub("      - name: Verify the packet bytes against the pins before anything privileged\n", "      - name: Verify the packet bytes against the pins before anything privileged\n        if: always()\n"), "step keys are not the reviewed closed sets"],
  ["sudo step: if always()", sub("        timeout-minutes: 15\n", "        timeout-minutes: 15\n        if: always()\n"), "step keys are not the reviewed closed sets"],
  ["sudo step: working-directory", sub("        timeout-minutes: 15\n", "        timeout-minutes: 15\n        working-directory: /tmp\n"), "step keys are not the reviewed closed sets"],
  ["sudo step: env", sub("        timeout-minutes: 15\n", "        timeout-minutes: 15\n        env:\n          X: y\n"), "step keys are not the reviewed closed sets"],
  ["sudo step: an id", sub("        timeout-minutes: 15\n", "        timeout-minutes: 15\n        id: root\n"), "step keys are not the reviewed closed sets"],
  ["sudo step: a shell", sub("        timeout-minutes: 15\n", "        timeout-minutes: 15\n        shell: sh\n"), "step keys are not the reviewed closed sets"],
  ["verify step: another shell", sub("      - name: Verify the packet bytes against the pins before anything privileged\n        shell: bash\n", "      - name: Verify the packet bytes against the pins before anything privileged\n        shell: sh\n"), "a step shell must be bash"],
  ["download step: continue-on-error", sub("      - name: Download the pinned guided packet (the first network step; nothing privileged has run)\n", "      - name: Download the pinned guided packet (the first network step; nothing privileged has run)\n        continue-on-error: true\n"), "step keys are not the reviewed closed sets"],
  ["a step is added", sub("      - name: Retain the bounded result\n", "      - name: extra\n        run: echo\n      - name: Retain the bounded result\n"), "step keys are not the reviewed closed sets"],
  ["result upload gets an if", sub("      - name: Retain the bounded result\n", "      - name: Retain the bounded result\n        if: always()\n"), "step keys are not the reviewed closed sets"],
  ["sudo step loses its own timeout", sub("        timeout-minutes: 15\n", ""), "step keys are not the reviewed closed sets"],
  ["sudo step timeout reaches the job's", sub("timeout-minutes: 15", "timeout-minutes: 19"), "the sudo step needs its own timeout, below the job's, so the failure diagnostics still upload"],
  // the packet artifact's id and zip digest are bound and checked at the API
  ["artifact id drifts", sub(/PACKET_ARTIFACT_ID: '[0-9]+'/, "PACKET_ARTIFACT_ID: '12174387241'"), "PACKET_ARTIFACT_ID is not the reviewed run-2 value"],
  ["artifact id unset but armed", sub(/PACKET_ARTIFACT_ID: '[0-9]+'/, "PACKET_ARTIFACT_ID: 'abc'"), "PACKET_ARTIFACT_ID must be a plain artifact id (0 while unset)"],
  ["zip digest drifts", sub(/PACKET_ZIP_SHA256: '[0-9a-f]{64}'/, `PACKET_ZIP_SHA256: '${"6".repeat(64)}'`), "PACKET_ZIP_SHA256 is not the reviewed run-2 value"],
  ["zip digest short", sub(/PACKET_ZIP_SHA256: '[0-9a-f]{64}'/, "PACKET_ZIP_SHA256: 'abc'"), "PACKET_ZIP_SHA256 must be 64-hex (all zeros while unset)"],
  ["pin refusal: artifact id removed", sub(/ *test "\$PACKET_ARTIFACT_ID" != "0"\n/, ""), "pin refusal lacks the artifact id refusal"],
  ["pin refusal: zip digest removed", sub(/ *test "\$PACKET_ZIP_SHA256" != "0+"\n/, ""), "pin refusal lacks the zip digest refusal"],
  ["artifact check: removed", (t) => t.replace(/      - name: Check the packet artifact[\s\S]*?          PY\n(?=      - name: Download)/, ""), "the artifact API check must be the step right before the download"],
  ["artifact check: digest comparison dropped", sub(" 'digest': 'sha256:' + os.environ['PACKET_ZIP_SHA256']}", " 'digest': 'sha256:' + os.environ['PACKET_ZIP_SHA256']}  # unchecked"), "artifact check lacks the wanted record"],
  ["artifact check: refusal made advisory", sub("raise SystemExit('the packet artifact is not the pinned one')", "print('the packet artifact is not the pinned one')"), "artifact check lacks the refusal"],
  ["artifact check: another URL", sub("repos/yanlingLabs/winter-runtime-sdk/actions/artifacts/", "repos/someone/else/actions/artifacts/"), "artifact check lacks the request"],
  ["artifact check: expiry ignored", sub("data.get('expired') is not False or ", ""), "artifact check lacks the comparison"],
  ["artifact check: a second environment variable", sub("          GH_TOKEN: ${{ github.token }}\n", "          GH_TOKEN: ${{ github.token }}\n          X: y\n"), "the artifact API check carries exactly GH_TOKEN"],
  ["artifact check: an extra statement", sub("          raise SystemExit('the packet artifact is not the pinned one')\n", "          raise SystemExit('the packet artifact is not the pinned one')\n          print(data)\n") , "artifact check is not exactly the reviewed script"],
  ["another step reaches a URL", sub("test \"$(uname -m)\" = aarch64", "test \"$(uname -m)\" = aarch64; python3 -c 'import urllib.request; urllib.request.urlopen(\"https://example.invalid\")'"), "the artifact check is the only code that reaches a URL"],
  ["sudo: python is found on PATH", sub("/usr/bin/python3 -I -S -B -", "python3 -I -S -B -"), "the sudo line must be exactly the reviewed command"],
  ["sudo: the environment is not cleared", sub("sudo -n env -i ", "sudo -n env "), "the sudo line must be exactly the reviewed command"],
  ["verify: python is found on PATH", sub("/usr/bin/python3 -I -B origins", "python3 -I -B origins"), "verify step lacks the packet verification"],
];

describe("every gate removal is caught by its own named violation", () => {
  for (const [name, mutate, expected, override] of MUTATIONS) {
    test(`mutation: ${name}`, () => {
      const mutated = mutate(WORKFLOW);
      expect(mutated).not.toBe(WORKFLOW);
      expect(violations(mutated, { ...loadContext(), ...override })).toContain(expected);
    });
  }
  test("a mutation table entry exists for every violation message the gate can emit", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const emitted = [...source.matchAll(/\bbad\(`?"?([^"`$]{12,}?)["`]\)/g)].map((m) => m[1] as string);
    expect(emitted.length).toBeGreaterThan(20);
    const covered = new Set(MUTATIONS.map(([, , expected]) => expected));
    const uncovered = emitted.filter((message) => ![...covered].some((c) => c === message || c.startsWith(message.split("${")[0] as string)));
    expect(uncovered).toEqual([]);
  });
  test("another workflow naming the trigger branch is caught", () => {
    expect(violations(WORKFLOW, { ...loadContext(), others: { "x.yml": `on: { push: { branches: ['${TRIGGER_BRANCH}'] } }` } })).toContain("x.yml names the trigger branch");
  });
  test("a runner pin that differs from the runner file is caught", () => {
    const armed = WORKFLOW.replace(/RUNNER_SHA256: '[0-9a-f]{64}'/, `RUNNER_SHA256: '${"3".repeat(64)}'`);
    expect(violations(armed, { ...loadContext(), runnerExists: true, runnerSha256: "4".repeat(64) })).toContain("RUNNER_SHA256 does not match the runner file");
    expect(violations(armed, { ...loadContext(), runnerExists: true, runnerSha256: "3".repeat(64) })).not.toContain("RUNNER_SHA256 does not match the runner file");
  });
});

// The arming guard is run for real, as bash, against throwaway Git repositories: each way an arming commit can be wrong must fail.
describe("arming guard behaviour (runs the workflow's own guard script against temporary repositories)", () => {
  const doc = yaml.parse(WORKFLOW) as Doc;
  const script = (Object.values(doc.jobs ?? {})[0]?.steps ?? [])[1]?.run ?? "";
  const workflow = (head: string, extra = "") => `name: x\nenv:\n  HOSTED_HEAD: '${head}'\n  OTHER: 1\n${extra}`;
  function git(cwd: string, ...args: string[]): string {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }
  /** Builds: reviewed commit B (unarmed workflow), then a pushed commit C produced by `arm`. Returns the guard's exit status. */
  function run(arm: (dir: string, reviewed: string) => string | void, options: { headOverride?: (reviewed: string, dir: string) => string } = {}): number {
    const dir = mkdtempSync(join(tmpdir(), "guided-hosted-arming-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(join(dir, WORKFLOW_PATH), workflow(ZERO40));
      writeFileSync(join(dir, "reviewed.txt"), "reviewed\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "reviewed");
      const reviewed = git(dir, "rev-parse", "HEAD");
      const head = arm(dir, reviewed) ?? reviewed;
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "arming");
      const pushed = git(dir, "rev-parse", "HEAD");
      const hostedHead = options.headOverride ? options.headOverride(reviewed, dir) : head;
      return spawnSync("bash", ["-c", script], { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", HOSTED_HEAD: hostedHead, GITHUB_SHA: pushed } }).status ?? -1;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const armLine = (dir: string, reviewed: string) => { writeFileSync(join(dir, WORKFLOW_PATH), workflow(reviewed)); return reviewed; };

  test("the extracted script is the guard under test", () => {
    expect(script).toContain("git merge-base --is-ancestor");
  });
  test("an arming commit that changes exactly the HOSTED_HEAD line passes", () => {
    expect(run(armLine)).toBe(0);
  });
  test("unarmed (all zeros) still fails closed", () => {
    expect(run((dir) => { writeFileSync(join(dir, "note.txt"), "x"); return ZERO40; })).not.toBe(0);
  });
  test("caught: an arming commit with an extra empty file (no diff line, so only the file-list check sees it)", () => {
    expect(run((dir, reviewed) => { armLine(dir, reviewed); writeFileSync(join(dir, "extra-empty-file"), ""); return reviewed; })).not.toBe(0);
  });
  test("caught: an arming commit that also edits a reviewed file", () => {
    expect(run((dir, reviewed) => { armLine(dir, reviewed); writeFileSync(join(dir, "reviewed.txt"), "changed\n"); return reviewed; })).not.toBe(0);
  });
  test("caught: a HOSTED_HEAD that is not an ancestor, with an otherwise perfect one-line diff", () => {
    expect(run((dir, reviewed) => { const side = git(dir, "commit-tree", `${reviewed}^{tree}`, "-m", "side"); writeFileSync(join(dir, WORKFLOW_PATH), workflow(side)); return side; })).not.toBe(0);
    // Control: the same shape with an ancestor passes, so the failure above is the ancestry and nothing else.
    expect(run((dir, reviewed) => { const child = git(dir, "commit-tree", `${reviewed}^{tree}`, "-p", reviewed, "-m", "child"); git(dir, "reset", "-q", "--soft", child); writeFileSync(join(dir, WORKFLOW_PATH), workflow(child)); return child; })).toBe(0);
  });
  test("caught by the numstat check alone: a `---` line the changed-line filter cannot see", () => {
    expect(run((dir, reviewed) => { writeFileSync(join(dir, WORKFLOW_PATH), `${workflow(reviewed)}---\n`); return reviewed; })).not.toBe(0);
  });
  test("caught by the numstat check alone: an added line starting with a plus", () => {
    expect(run((dir, reviewed) => { writeFileSync(join(dir, WORKFLOW_PATH), `${workflow(reviewed)}+x\n`); return reviewed; })).not.toBe(0);
  });
  test("caught: a two-line diff (the HOSTED_HEAD line plus another line)", () => {
    expect(run((dir, reviewed) => { writeFileSync(join(dir, WORKFLOW_PATH), workflow(reviewed).replace("OTHER: 1", "OTHER: 2")); return reviewed; })).not.toBe(0);
  });
  test("caught: a HOSTED_HEAD line written with a different spelling than the reviewed one", () => {
    expect(run((dir, reviewed) => { writeFileSync(join(dir, WORKFLOW_PATH), workflow(reviewed).replace(`'${reviewed}'`, reviewed)); return reviewed; })).not.toBe(0);
  });
  test("caught: an arming commit that arms to a commit other than the recorded reviewed head", () => {
    expect(run(armLine, { headOverride: () => "1".repeat(40) })).not.toBe(0);
  });
});

// The root launcher is run for real too, with its root check removed (the only line that needs a privilege), against a
// throwaway directory: the hash gate must run exactly the hashed bytes and refuse everything else before executing any.
describe("root launcher behaviour (the workflow's own launcher, minus the uid line)", () => {
  const doc = yaml.parse(WORKFLOW) as Doc;
  const sudoRun = (Object.values(doc.jobs ?? {})[0]?.steps ?? [])[7]?.run ?? "";
  const launcher = sudoRun.slice(sudoRun.indexOf("<<'PY'\n") + 7, sudoRun.lastIndexOf("\nPY") + 1).replace("if os.geteuid() != 0:\n    raise SystemExit('root required')\n", "");
  const runner = "import sys, os\nopen(os.path.join(sys.argv[2], 'ran'), 'w').write('|'.join(sys.argv[1:]))\n";
  function launch(prepare: (dir: string) => { digest: string; source: string }): { status: number; ran: string | null; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "guided-hosted-launcher-"));
    try {
      const out = join(dir, "out");
      mkdirSync(out);
      const { digest, source } = prepare(dir);
      const r = spawnSync("python3", ["-I", "-S", "-B", "-", digest, source, "packet", out], { input: launcher, cwd: dir, encoding: "utf8" });
      const ran = join(out, "ran");
      return { status: r.status ?? -1, ran: existsSync(ran) ? readFileSync(ran, "utf8") : null, out };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const write = (dir: string, text = runner) => { const path = join(dir, "run.py"); writeFileSync(path, text); return path; };

  test("the extracted launcher is the one under test", () => {
    expect(launcher).toContain("unreviewed runner refused");
    expect(launcher).not.toContain("geteuid");
  });
  test("a runner whose bytes match the pin runs, with exactly the packet and the output directory as arguments", () => {
    const result = launch((dir) => ({ digest: sha256(runner), source: write(dir) }));
    expect(result.status).toBe(0);
    expect(result.ran).toBe(`packet|${result.out}`);
  });
  test("caught: a runner with one changed byte never runs", () => {
    const result = launch((dir) => ({ digest: sha256(runner), source: write(dir, `${runner}#`) }));
    expect(result.status).not.toBe(0);
    expect(result.ran).toBeNull();
  });
  test("caught: a wrong or empty pin never runs the runner", () => {
    for (const digest of [ZERO64, "", sha256("x")]) {
      const result = launch((dir) => ({ digest, source: write(dir) }));
      expect([digest, result.status !== 0, result.ran]).toEqual([digest, true, null]);
    }
  });
  test("caught: a symlinked runner never runs, even when the target has the right bytes", () => {
    const result = launch((dir) => { const target = write(dir); const link = join(dir, "link.py"); symlinkSync(target, link); return { digest: sha256(runner), source: link }; });
    expect(result.status).not.toBe(0);
    expect(result.ran).toBeNull();
  });
  test("caught: a hard-linked runner (link count above one) never runs", () => {
    const result = launch((dir) => { const target = write(dir); linkSync(target, join(dir, "second.py")); return { digest: sha256(runner), source: target }; });
    expect(result.status).not.toBe(0);
    expect(result.ran).toBeNull();
  });
  test("caught: a directory or a missing path never runs", () => {
    expect(launch((dir) => ({ digest: sha256(runner), source: dir })).ran).toBeNull();
    expect(launch((dir) => ({ digest: sha256(runner), source: join(dir, "absent.py") })).ran).toBeNull();
  });
  test("caught: an oversized runner never runs", () => {
    const big = `${runner}#${"x".repeat(16777216)}\n`;
    const result = launch((dir) => ({ digest: sha256(big), source: write(dir, big) }));
    expect(result.status).not.toBe(0);
    expect(result.ran).toBeNull();
  });
});

// The sudo step runs ONE file (the hashed run.py), and run.py executes or reads only bytes it hashed first. These are gates on the committed text of
// run.py and session.py, each mutation caught by its own named problem.
describe("the privileged step runs only hashed bytes", () => {
  const ctx = loadContext();
  const problemsOf = (change: (runner: string, session: string, siblings: Record<string, string>) => [string, string, Record<string, string>]) => {
    const [runner, session, siblings] = change(ctx.runnerText, ctx.sessionText, { ...ctx.siblingSha256 });
    return runnerProblems(runner, session, siblings, ctx.adapterText, ctx.oracleText);
  };
  const problemsOfOthers = (adapter: string, oracle: string) => runnerProblems(ctx.runnerText, ctx.sessionText, ctx.siblingSha256, adapter, oracle);
  test("the committed runner and session satisfy every one of them, and the workflow gate includes them", () => {
    expect(runnerProblems(ctx.runnerText, ctx.sessionText, ctx.siblingSha256, ctx.adapterText, ctx.oracleText)).toEqual([]);
    expect(violations(WORKFLOW, ctx)).toEqual([]);
    for (const [, file] of SIBLINGS) expect(ctx.siblingSha256[file]).toMatch(/^[0-9a-f]{64}$/);
  });
  const CASES: Array<[string, (r: string, s: string, h: Record<string, string>) => [string, string, Record<string, string>], string]> = [
    ["the fixture inputs change", (r, s, h) => [r, s, { ...h, "fixture-inputs.json": "9".repeat(64) }], "run.py pins fixture-inputs.json to a hash that differs from the file"],
    ["the oracle changes", (r, s, h) => [r, s, { ...h, "oracle.py": "9".repeat(64) }], "run.py pins oracle.py to a hash that differs from the file"],
    ["the adapter changes", (r, s, h) => [r, s, { ...h, "roles_adapter.py": "9".repeat(64) }], "run.py pins roles_adapter.py to a hash that differs from the file"],
    ["the session changes", (r, s, h) => [r, s, { ...h, "session.py": "9".repeat(64) }], "run.py pins session.py to a hash that differs from the file"],
    ["the fixture inputs are unpinned", (r, s, h) => [r.replace(/^FIXTURE_INPUTS_SHA256 = '[0-9a-f]{64}'$/m, `FIXTURE_INPUTS_SHA256 = '${ZERO64}'`), s, h], "run.py leaves fixture-inputs.json unpinned"],
    ["the oracle pin is removed", (r, s, h) => [r.replace(/^ORACLE_SHA256 = .*$/m, ""), s, h], "run.py leaves oracle.py unpinned"],
    ["an unpinned sibling is named", (r, s, h) => [r + "\nEXTRA = 'helper.py'\n", s, h], "run.py names a file that is not pinned: helper.py"],
    ["an unpinned data file is named", (r, s, h) => [r + "\nEXTRA = 'more-inputs.json'\n", s, h], "run.py names a file that is not pinned: more-inputs.json"],
    ["a second exec", (r, s, h) => [r + "\nexec(compile(b'', 'x', 'exec'))\n", s, h], "run.py may execute code only in load_sibling, after read_pinned"],
    ["load_sibling stops hashing first", (r, s, h) => [r.replace("data = read_pinned(os.path.join(directory, name), expected_sha256)", "data = open(os.path.join(directory, name), 'rb').read()"), s, h], "run.py may execute code only in load_sibling, after read_pinned"],
    ["a second subprocess.run", (r, s, h) => [r + "\nsubprocess.run(['true'])\n", s, h], "run.py may run only the hashed verifier, with an explicit --pin"],
    ["the verifier loses --pin", (r, s, h) => [r.replace(", '--pin', pin_copy]", "]"), s, h], "run.py may run only the hashed verifier, with an explicit --pin"],
    ["the verifier is no longer hashed first", (r, s, h) => [r.replace("read_pinned(verifier, verifier_sha256)", "pass"), s, h], "run.py may run only the hashed verifier, with an explicit --pin"],
    ["the supervisor is run without the packet-hash comparison", (r, s, h) => [r, s.replace("if not supervisor_matches_packet(sha256_hex(data), staged.inventory):", "if False:"), h], "session.py may execute code only in load_supervisor, after the packet-hash comparison"],
    ["a second exec in the session", (r, s, h) => [r, s + "\nexec(compile(b'', 'x', 'exec'))\n", h], "session.py may execute code only in load_supervisor, after the packet-hash comparison"],
  ];
  const PRIMITIVES: Array<[string, string]> = [
    ["os.system", "os.system('true')"], ["os.execv", "os.execv('/bin/true', ['true'])"], ["os.execvp", "os.execvp('true', ['true'])"], ["os.spawnl", "os.spawnl(os.P_WAIT, '/bin/true', 'true')"],
    ["os.posix_spawn", "os.posix_spawn('/bin/true', ['true'], {})"], ["os.popen", "os.popen('true')"], ["os.fork", "os.fork()"], ["pty.spawn", "import pty\npty.spawn(['true'])"],
    ["multiprocessing", "import multiprocessing"], ["ctypes", "import ctypes"], ["subprocess aliased", "import subprocess as sp"], ["from subprocess import", "from subprocess import Popen"],
    ["shell=True", "x = dict(shell=True)"], ["__import__", "__import__('os')"], ["eval", "eval('1')"], ["importlib", "import importlib"],
  ];
  for (const [name, line] of PRIMITIVES) {
    for (const file of ["run.py", "session.py", "roles_adapter.py", "oracle.py"] as const) {
      test(`caught: ${name} in ${file}`, () => {
        const add = (t: string) => t + "\n" + line + "\n";
        const problems = file === "run.py" ? problemsOf((r, s, h) => [add(r), s, h]) : file === "session.py" ? problemsOf((r, s, h) => [r, add(s), h])
          : problemsOfOthers(file === "roles_adapter.py" ? add(ctx.adapterText) : ctx.adapterText, file === "oracle.py" ? add(ctx.oracleText) : ctx.oracleText);
        expect(problems).toContain(`${file} reaches another way to execute code`);
      });
    }
  }
  const SUBPROCESS: Array<[string, string, string]> = [
    ["a Popen call in run.py", "run.py", "subprocess.Popen(['true'])"], ["a check_output call in run.py", "run.py", "subprocess.check_output(['true'])"],
    ["a call in session.py", "session.py", "subprocess.call(['true'])"], ["a second Popen reference in session.py", "session.py", "x = subprocess.Popen"], ["subprocess in the adapter", "roles_adapter.py", "import subprocess\nsubprocess.run(['true'])"],
    ["subprocess in the oracle", "oracle.py", "subprocess.run(['true'])"],
  ];
  for (const [name, file, line] of SUBPROCESS) {
    test(`caught: ${name}`, () => {
      const add = (t: string) => t + "\n" + line + "\n";
      const problems = file === "run.py" ? problemsOf((r, s, h) => [add(r), s, h]) : file === "session.py" ? problemsOf((r, s, h) => [r, add(s), h])
        : problemsOfOthers(file === "roles_adapter.py" ? add(ctx.adapterText) : ctx.adapterText, file === "oracle.py" ? add(ctx.oracleText) : ctx.oracleText);
      expect(problems).toContain(`${file} uses subprocess primitives other than the reviewed ones`);
    });
  }
  test("a commented-out primitive is not a finding and a real one on the same line is", () => {
    expect(problemsOf((r, s, h) => [r + "\n# os.system('x')\nx = 1  # os.fork()\n", s, h])).toEqual([]);
    expect(problemsOf((r, s, h) => [r + "\nx = os.fork()  # fine\n", s, h])).toContain("run.py reaches another way to execute code");
  });
  for (const [name, change, expected] of CASES) {
    test(`caught: ${name}`, () => {
      const problems = problemsOf(change);
      expect(problems).toContain(expected);
    });
  }
  test("every problem the runner gate can emit has a case above", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export function runnerProblems"), source.indexOf("/** Every problem with this workflow text"));
    const emitted = [...body.matchAll(/problems\.push\(["`]([^"`$]+)/g)].map((m) => m[1] as string);
    expect(emitted.length).toBeGreaterThanOrEqual(6);
    const expected = CASES.map(([, , message]) => message);
    for (const message of emitted) expect(expected.some((e) => e === message || e.startsWith(message))).toBe(true);
  });
});
