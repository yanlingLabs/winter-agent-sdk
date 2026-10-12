# Code path policy preserving SDK main — 2026-10-12

The candidate preserves main's ordinary SDK sandbox and approved escape
behavior. No persistent native floor is automatically applied to Code, hooks,
LSP or third-party MCP tools. New trusted path checks protect SDK file tools and
add protected paths only to the existing sandboxed Bash/Monitor profile.
No `--disable-sandbox`, `--no-sandbox`, GPU-sandbox override or SourceKit sandbox
override was injected into these comparisons.

User direction now defers per-workspace encryption for the first version and
accepts weaker direct same-user/copied-image protection. These checks are
defense in depth, not a same-user confidentiality boundary or proof of preventing
arbitrary deletion/corruption. VM isolation, host credential protection and
active memory return remain separate required gates.

## Exact baseline and candidate

- Public main was fetched with credential helpers/interactive askpass disabled.
  Detached worktree: `../winter-agent-sdk-main-baseline-20261012`.
- Main: `ec8012b5ce8fcaa24f5b015d4e31a4822448a65c`.
- Candidate execution/path checks: `8892eaff138e80b1405e4d477e4370c061b026a8`.
- Explicit partial ABI marker: `bf5daf701ae427a42a4920dbea65ee98613b8ddc`.
- Baseline SDK workspace packages resolve to that worktree's source, not the
  candidate or published package. Only unchanged installed third-party
  `ignore`/`ajv` dependencies were linked for source execution. Tracked baseline
  files were not modified.
- Measurements call each checkout's actual `sandbox/spawn.ts::runCommand` with
  `settings: {}`, explicit disposable environment/home/writable root, and either
  no override or `dangerouslyDisableSandbox: true`. This measures the shared
  execution layer used by Bash, not an end-to-end Core approval UI.
- Candidate has an actual registered host policy denying its synthetic Cowork
  directory. It does not pass a mandatory floor, host child floor or broker.

Each case has a fresh package/home/cache/build/browser profile. The package is
dependency-free and has one function plus one XCTest. Xcode uses a fresh minimal
project referencing that package locally. No simulator or VM was launched and
no live Winter app/home/daemon or browser profile was used. Signing is disabled
for the fixture Xcode invocation, which resolves a graph rather than building
the target. Credential/Keychain operations were not requested; direct SwiftPM
commands disable Keychain/netrc lookup, and Xcode uses system SCM with empty
Git configs/disabled prompting. Keychain traffic was not independently traced.

## Main/candidate result matrix

Both columns use the same fixture generator and exact tool arguments. Fresh
absolute fixture paths differ; stdout/stderr/profile hashes and full arguments
are retained in JSON. Exit status alone is not considered useful work.

| Workload | Main ordinary sandbox | Candidate ordinary sandbox | Main approved escape | Candidate approved escape |
|---|---|---|---|---|
| Swift build | Exit 1; Darwin temp `.keep-directory` write denied | Same | Exit 0; build complete | Same |
| Swift test | Exit 1; same temp denial | Same | Exit 0; one XCTest passed | Same |
| SourceKit `debug index` | Exit 0 but zero index jobs after package preparation failure | Same | Exit 0; two actual fixture indexing jobs | Same |
| Headless Chromium | Null exit code; Mach rendezvous bootstrap denial; no DOM | Same | Exit 0; fixture DOM | Same |
| Actual Playwright, `chromiumSandbox: true` | Exit 1; Chromium Mach rendezvous failure | Same | Exit 0; fixture DOM | Same |
| Actual Xcode local SPM resolution | Null exit code; sandbox/XPC failure/abort; no useful resolution | Same | Exit 0; `PolicyFixture @ local` resolved | Same |
| Synthetic protected file read | Exit 0 | **Exit 1: protected path denied** | Exit 0 | **Exit 0: accepted raw escape residual** |

The ordinary sandbox failures already exist on main. This change neither claims
those workloads work inside the existing SDK sandbox nor silently weakens it.
Approved escapes retain useful Swift builds/tests, SourceKit indexing, Chromium
rendering, Playwright rendering and Xcode graph resolution. Their result contains
`posture: override-requested` and no Seatbelt profile. The Code approval decision
and Core's static WRITE-shaped escape fence remain the host's responsibility.
The SDK does not inspect arbitrary escaped scripts to promise write prevention.

## Actual Playwright and Xcode scope

`playwright-core 1.64.0` was installed from the public npm registry into a fresh
disposable tool directory, with empty user/global npm configs, isolated cache,
scripts disabled and audit/fund disabled. No browser download occurred. It uses
the installed Chrome for Testing headless shell `156.0.8078.4` from cache revision
`chromium_headless_shell-1248`, with a fresh persistent fixture profile.
The driver explicitly sets **`chromiumSandbox: true`** in
`launchPersistentContext`; it does not rely on Playwright's default false value.
It loads only a local `file:` page, blocks other page requests, and asserts the
fixture paragraph. Launch logs preserve the actual arguments and cleanup.

Xcode `26.4.1` build `17E202` resolves a real minimal `.xcodeproj` containing an
`XCLocalSwiftPackageReference` and `XCSwiftPackageProductDependency`. The captured
project, scheme generator and resolution output demonstrate a local package
graph. This is not an Xcode build/test, remote package fetch, signing or GUI test.
Swift is `6.3.1`; SourceKit is selected by the same Xcode toolchain; macOS is
`26.6.1` (`25G76`); Node is `26.7.0`; Bun is `1.3.14`.

## Implemented host lifecycle API

The runtime `/embedded-host` export provides:

```ts
HOST_CODE_PROTECTION_CONTRACT_VERSION = 1
HOST_CODE_PROTECTION_CAPABILITY = "host-code-path-protection-v1"

spawnEmbeddedWorker({
  // Existing spawn/entry options...
  hostCodeProtection: {
    revision: 1,
    denyReadPaths: ["/fixture/cowork/control", "/fixture/cowork/**/*.ext4"],
    denyWritePaths: ["/fixture/cowork", "/fixture/key-helper", "/fixture/bridge.sock"],
  },
})

await process.updateHostCodeProtection(nextSnapshot) // matching revision acknowledgement
```

The host copies/seals paths before a held start. The private Worker lifecycle
channel applies or retains pre-start updates and acknowledges the exact revision.
Conflicting/stale revisions fail, identical revisions are idempotent, closed or
unresponsive channels reject, and outstanding updates are bounded. The 5 s
acknowledgement is not an already-running child-process drain acknowledgement.
Policies remain installed through terminal cleanup, and owners cannot narrow
another active owner's restrictions.

Core must derive snapshots from current host authority, send them to every
relevant live generation and await acknowledgement before dependent admissions.
The updates affect subsequent file checks and newly launched ordinary sandboxed
commands; they do not modify or abort existing native children. Direct embedded
callers can receive the trusted lease through `onHostCodeProtectionBound`.
RuntimeConfig, environment variables, SDK Options and model NDJSON do not supply
this authority. A real active Worker test proves that an update applied during
a permission callback denies the ensuing Write while preserving the session.

## Coverage and remaining boundary

Read/Write/Edit/NotebookEdit check the protected target before file operations.
Glob/Grep prune protected subtrees and filter/recheck candidates; symlink target
chains, missing leaves, macOS case aliases, absolute globs and literal bracket
directories have focused tests. Existing SDK sandbox configuration denies also
participate in the file checks. These are synchronous path checks, not
descriptor-bound protection against arbitrary hardlink aliases or post-check
same-user races.

The frozen `HOST_CODE_PROTECTION_COVERAGE` deliberately advertises
`contextReadChecksVersion: 0`. Auxiliary reads remain unclaimed:

- `context/{injection,imports,rules,output-styles}` source reads;
- `settings/loaders/mcp-config` reads;
- `skills/loader` metadata reads/open;
- `subagents/definitions` discovery reads;
- `plugins/{loader,manifest,installed}` reads;
- `commands/resolver` and `workflows/{store,runtime}` source reads.

The partial marker or successful Read test alone must not close an activation
gate requiring those consumers. Trusted SDK stores/recovery and purpose-built
Winter-owned VM/bridge confinement were not removed. The retained generic
opt-in floor APIs do not imply automatic ordinary Code enrollment.

Current main has **no live sandbox/settings refresh API**: settings files are
resolved at startup, and engine/registry sandbox settings are captured.
`setPermissionMode` or permission-result updates alter permission policy,
not the existing sandbox config. The candidate's new private path-policy channel
updates this narrower protection without restarting a daemon/session. It does
not implement general settings reload. Old installed SDK versions need the
Core's reviewed incarnation-handoff fallback until integration/pinning occurs.

## Verification and evidence

- Focused new live/path suite: 9 passed, 54 expectations.
- File-tool/embedded compatibility batch before final edge additions: 208 passed,
  568 expectations across nine files.
- Spawn/protected-store batch: 72 passed, 316 expectations.
- Both SDK TypeScript configurations passed; source commits remain unreleased.
- [Main execution evidence](2026-10-12-code-policy-main-evidence/results.json)
- [Main actual Playwright/Xcode evidence](2026-10-12-code-policy-main-extra-evidence/results.json)
- [Source-pinned candidate evidence](2026-10-12-code-policy-candidate-final-evidence/results.json)
- [Candidate actual Playwright/Xcode evidence](2026-10-12-code-policy-candidate-extra-evidence/results.json)
- [Playwright package integrity and install metadata](2026-10-12-code-policy-candidate-extra-evidence/playwright-install.json)
- [Owned fixture cleanup record](2026-10-12-code-policy-candidate-extra-evidence/cleanup.json)
- [Reproducible runner](../../scripts/research/code-policy-compatibility.ts)

Browser executable personal-home prefixes are represented as `<USER_HOME>` in
committed logs/arguments; the installed relative path is preserved. Per-user macOS
temporary-directory prefixes are represented as `/private/var/folders/xx/yyyy/T`.
Published stdout/stderr/profile hashes identify these normalized copies. Existing
raw hashes and `preTempNormalization*Sha256` retain their earlier identities; the
normalization manifest binds before/after published bytes. Raw originals are
retained locally, not republished. This changes no measurements or outcomes and
does not rerun the workloads. Native timeouts/output limits are owned
fixture limits; no workload was promoted to a passing result because of a zero
exit status with no useful output. The initial uncommitted candidate run is
superseded by the source-pinned run above.

After measurements, an exact-root process inventory found no remaining owned
fixture descendants. The six disposable workload/tool roots were removed,
without sending process signals; the detached main worktree and four final
evidence directories remain. The superseded uncommitted candidate artifacts
were removed. No workload comparison was rerun for this report freeze.

Public evidence paths and ancestor literals are synthetic. Published capture/profile hashes refer to normalized copies; retained raw/native hashes refer to the original measurements. No workload was rerun for this publication change.
