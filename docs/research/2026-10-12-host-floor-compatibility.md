# Native host floor compatibility measurement — 2026-10-12

The current persistent macOS host floor breaks ordinary SwiftPM build/test and
Chromium's own sandbox initialization in isolated native fixtures. Disabling each
tool's inner sandbox restored these fixtures while the outer floor continued to
deny the planted protected path. Those flags change the tool's security behavior;
they were measured only and are not adopted by Winter or the SDK.

This is a compatibility result, not VM feasibility, production integration or
global same-user isolation evidence. The user-selected private VM protection
remains encryption at rest, with required native helper key custody. This
measurement does not implement that storage contract. SDK path checks and
the native host floor are defense in depth for enrolled operations. They do not
establish confidentiality against arbitrary same-user processes or delegated
services, and this measurement does not justify blocking normal approved Code
escapes simply because Cowork storage exists.

## Candidate and environment

- SDK source commit: `d76114b042dba42ec768c8e9e99325dd3280bb84`.
- Renderer source SHA-256: `4ba5a05321a15d2241388130b6a4cfa439cc643a0aee5266c3b8ee6014f3e07b`.
- macOS `26.6.1`, build `25G76`; arm64.
- Xcode `26.4.1`, build `17E202`; Swift `6.3.1`
  (`swiftlang-6.3.1.1.2`, clang `2100.0.123.102`, swift-driver `1.148.6`).
- SourceKit-LSP: executable selected by that Xcode toolchain. Its installed CLI
  rejects `--version`; the executable hash below identifies the measured binary.
- Installed Chrome for Testing headless shell: `156.0.8078.4`, Playwright cache
  revision directory `chromium_headless_shell-1248`.
- Runner: Bun `1.3.14`; installed Node `26.7.0` was inventoried but not needed.

| Artifact | SHA-256 |
|---|---|
| Toolchain `usr/bin/swift` | `e9971c1976b63811ec21583c948ab3dd34a5ac664179f256f6925cf84209600f` |
| Toolchain `usr/bin/sourcekit-lsp` | `5e4359b1d6609ce9b3fd7d7e5ec32bb8f3b69fc8415e5d5ab2b5940fcfd69ed2` |
| Installed headless shell executable | `77d8278b1ac9d0687fad4e817ea83023ede09b1deef36e1864b49ba194ac9634` |
| Installed SDK `usr/include/sandbox.h` | `5baa98c212110d6323f7d73f4b42b0072a4c66a826a46c8bfd8fb850305f9416` |
| Build/browser profile passed as the native argument | `5cc1a1d508825e0b0658c63962e05b5f7dd30d8a7cacf3361fb06c137d6de471` |
| Normalized published build/browser `floor.sb`, including its final newline | `f91789bc369c10d01be8c4a40db5295d7193195fc86092b87b2b08892a95ce1e` |
| SourceKit profile passed as the native argument | `88cf1466bc66eda2b5e4ae8419de498087fc30379201d6d9884f924423de1502` |
| Normalized published SourceKit `floor.sb`, including its final newline | `62f1abc9b9d36f7e927bcfd48ba54aa3b9a5b0ece9b26fe1d7fdf10cc2d1b8f3` |

The profile came from the actual SDK `buildMandatoryFloorProfile` and was applied
with `applyMandatoryFloorToSpawnOptions`, not a hand-written approximation. It
denies reads/writes/links beneath a synthetic protected directory and protects
its literal ancestors, while retaining the renderer's ordinary allow-default
stance. It intentionally does not contain a denial of sandbox initialization.
Paths are different between the two fresh fixture roots, hence different hashes.

## Isolation and measurement boundary

All packages, homes, caches, security/config directories, build products and
browser profiles were newly created disposable fixtures. The Swift package has
one library function, one XCTest and no dependencies, plugins or external code.
SwiftPM received explicit disposable paths and `--disable-keychain`,
`--disable-netrc`, `--disable-prefetching`, and
`--disable-experimental-prebuilts`. SourceKit's fixture-only config requests the
same extra SwiftPM arguments and sets an owned scratch path. The installed
binary's logged preparation commands do **not** forward those extra arguments;
their forwarding is therefore unverified. SourceKit used the fresh home/temp/
module-cache environment and the same no-dependency package. Its captured config
files are retained alongside the logs.

The browser ran headlessly on local `file:` pages with a fresh `--user-data-dir`,
background networking/component updates/sync/extensions disabled, DNS hosts
mapped to no result, and `--use-mock-keychain --password-store=basic`. There was
no browser UI, account, live browser profile, dependency download or remote page.
No live Winter app, daemon, home, real credentials or VM was used. No credential
or Keychain operation was requested; SwiftPM's direct runs explicitly disabled
Keychain lookup. SourceKit's Keychain traffic was not independently traced.
Network traffic was not independently packet-captured; the fixture contains no
network content and the runner did not request external tool traffic.

The runner used owned detached process groups, 60 s Swift deadlines, 30 s
SourceKit deadlines, 15 s browser deadlines and a 256 KiB output threshold. It
does not signal a group after its leader's exit event. The only timeout was the
partial Chromium workaround; its owned group was killed and reaped. A final
process inventory found no rows carrying any of the three fixture-root names.
The three owned fixture roots were then removed; the retained report/logs and
runner are the durable artifacts. SourceKit's UUID output-map paths were checked
against the owned fixture root before any cleanup of those specific files.
Native child closure does not establish ownership of arbitrary detached
descendants; no such broader claim is made.

## Classified results

Times describe this run, not a performance benchmark. Raw commands, environments,
logs and output hashes are in the linked JSON evidence.
The browser executable's personal home prefix is represented as `<USER_HOME>`
in committed evidence to satisfy the repository's local identity guard. The
remaining installed relative path and executable SHA-256 are exact; the runner
resolves the prefix from the launching user's home before creating fixture homes.

| Workload | Ordinary control | Same native floor | Classification |
|---|---|---|---|
| Planted protected read and write | Exit 0; permitted | Exit 1; both denied | Floor negative/positive controls |
| `swift build` | Exit 0; 2.16 s | Exit 1; 0.85 s | Nested manifest sandbox failure |
| `swift test` | Exit 0; one XCTest passed; 10.74 s | Exit 1; 0.86 s | Nested manifest sandbox failure |
| `swift build --disable-sandbox` | Exit 0; 2.77 s | Exit 0; 2.55 s | Workaround restores this fixture |
| `swift test --disable-sandbox` | Exit 0; one XCTest passed; 11.40 s | Exit 0; one XCTest passed; 11.58 s | Workaround restores this fixture |
| Headless Chromium with normal inner sandboxes | Exit 0; fixture DOM rendered | SIGTRAP after 0.17 s; no DOM | Repeated GPU sandbox initialization failure then fatal |
| Chromium `--disable-gpu-sandbox` | Exit 0; fixture DOM rendered | 15 s timeout, owned SIGKILL; no DOM | Narrower flag insufficient; later stall cause unproven |
| Chromium `--no-sandbox` | Exit 0; fixture DOM rendered | Exit 0; fixture DOM rendered | Workaround restores this fixture |
| Chromium `--no-sandbox`, planted protected `file:` URL | Exit 0; planted text rendered | Exit 1; no planted text; `ERR_FILE_NOT_FOUND` | Outer floor remains effective despite browser flag |
| SourceKit `debug index`, normal SwiftPM sandbox | Exit 0; two actual `-index-file-path` jobs; 12.91 s | **Exit 0**, nested sandbox failure, zero index jobs; 0.74 s | Exit code alone is a false positive |
| SourceKit `debug index`, fixture-local `swiftPM.disableSandbox: true` | Exit 0; two index jobs; 12.22 s | Exit 0; two index jobs; 12.26 s | Scoped workaround restores package indexing |

The failing SwiftPM logs contain `sandbox-exec: sandbox_apply: Operation not
permitted`. The default Chromium floor logs contain repeated `sandbox
initialization failed: Operation not permitted` and a GPU-process fatal. These
are initialization failures rather than a denial of a fixture source/cache path.

The Swift workaround manifests deliberately attempted to read and overwrite the
planted protected file, then recorded results in an allowed fixture file. Both
ordinary controls report `readAllowed=true,writeAllowed=true`; both floored
workaround runs report `readAllowed=false,writeAllowed=false`. The protected
source was restored after ordinary controls and remained unchanged after the
floored operations. Thus success is not explained by accidentally dropping the
outer floor. It still says nothing about preserving SwiftPM's original policy
outside the narrow protected paths.

SourceKit's floored default output ends with an indexing-finished message and a
zero exit status despite the manifest failure. Its two control runs and scoped
workaround show actual indexing invocations for the library and test sources;
the floored default has none. Production acceptance must examine useful work or
diagnostics, not only the debug command's numeric exit code.

## Supported mechanisms and their limits

The installed Apple SDK `sandbox.h:23` documents that a process already in a
sandbox rejects a new `sandbox_init` profile. That local SDK fact and the native
failure logs support the nested-sandbox classification. The header also marks
the API deprecated. This measurement found no supported flag that makes the
already-applied SDK floor coexist with unchanged tool sandbox initialization.
It is not an exhaustive audit of all Apple private APIs.

SwiftPM's current [Sandbox implementation](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/Basics/Sandbox.swift)
uses `sandbox-exec` on macOS. Its [documented command option](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/PackageManagerDocs/Documentation.docc/Package/PackagePlugin.md)
disables subprocess sandboxing. The native build/test variants confirm that
option restores this dependency-free fixture. It removes SwiftPM's inner
restrictions on network and filesystem modifications, while the SDK's narrow
outer denies remain. Macro/plugin-heavy projects were not measured.

SourceKit-LSP supports [workspace configuration](https://github.com/swiftlang/sourcekit-lsp/blob/main/Documentation/Configuration%20File.md)
for `swiftPM.disableSandbox`; upstream explicitly describes nested-sandbox
compatibility as its purpose. This is narrower **configuration scope** than
altering global app settings, and worked in the measured binary. It still
disables the same inner SwiftPM subprocess policy. It is not a solution that
retains both original policies unchanged.

Chromium's [Mac sandbox design](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/sandbox/mac/README.md)
assigns sandbox policies to child process roles and applies them after launch.
Its [switch definitions](https://github.com/chromium/chromium/blob/main/sandbox/policy/switches.cc)
identify a GPU-only switch and a switch disabling all normally sandboxed process
types; the latter is described for browser-level testing. The GPU-only variant
did not restore this fixture. `--no-sandbox` does, but loses Chromium's renderer,
GPU and utility policy separation. The SDK floor's allow-default profile does
not replace those policies.

[Playwright's supported `chromiumSandbox` launch option](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox)
defaults to false. Therefore the raw Chromium result must **not** be generalized
to every Playwright default launch: a Playwright launch may already disable the
inner Chromium sandbox. No installed Playwright JS package was found in the
inspected SDK/browser-plugin locations, so a real Playwright API session was not
run or claimed. The installed headless shell was measured directly.

`xcodebuild -resolvePackageDependencies` was not measured: this fixture is a
standalone package without an Xcode project/workspace, and no separate
credential-free Xcode fixture was prepared. SourceKit package loading/indexing
provided the practical additional toolchain probe. Xcode project resolution,
GUI browsing, downloaded dependencies, build-tool plugins and macros remain
UNKNOWN.

## Integration consequence

The SDK persistent floor is not transparent to ordinary macOS Code workloads.
Silently injecting `--disable-sandbox`, `--no-sandbox` or workspace LSP overrides
would change existing tool security behavior, even though the protected-path
probes remain denied. This report does not adopt those workarounds.

Before activation, the host design must resolve the compatibility requirement
alongside the accepted encryption-at-rest threat model. Possible design work
includes keeping filesystem/API safeguards separate from approved native Code
execution, or deliberate tool-specific sandbox integration that retains the
needed restrictions. Both require explicit policy and validation; neither is
implemented or proven here. Requiring a persistent pre-applied floor while also
requiring unchanged self-sandboxing tools is contradicted by these fixtures.

## Reproduction and evidence

From the SDK repository root, the committed runner creates new fixtures:

```sh
bun scripts/research/host-floor-compatibility.ts /tmp/winter-floor-compat-evidence
bun scripts/research/host-floor-compatibility.ts /tmp/winter-floor-sourcekit-evidence --sourcekit-only
```

- [Build/browser evidence: 18 cases](2026-10-12-host-floor-compatibility-evidence-full/results.json)
- [Build/browser actual saved profile](2026-10-12-host-floor-compatibility-evidence-full/floor.sb)
- [SourceKit evidence: four cases](2026-10-12-host-floor-sourcekit-evidence/results.json)
- [SourceKit actual saved profile](2026-10-12-host-floor-sourcekit-evidence/floor.sb)
- [Runner](../../scripts/research/host-floor-compatibility.ts)
- [Owned fixture cleanup record](2026-10-12-host-floor-cleanup.json)

Each evidence directory retains separate stdout/stderr logs. The first eight-case
measurement was superseded by the complete eighteen-case run, which reproduced
its conclusions. The report and captured hashes refer to that complete run and
the SourceKit run.

Public evidence paths and ancestor literals are synthetic. Published capture/profile hashes refer to normalized copies; retained raw/native hashes refer to the original measurements. No workload was rerun for this publication change.
