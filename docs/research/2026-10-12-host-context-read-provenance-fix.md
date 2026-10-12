# Source origin correction candidate — 2026-10-12

This follow-up fixes the P1 canonical-provenance blocker found by independent
review of `32b9b753740fc35d64c7cea999a2399ca8aa2250`. The original review and its
four reproductions are retained unchanged in
[the review report](2026-10-12-host-context-read-independent-review.md) and
`host-context-read-independent-fixtures/`. The two old leak-confirming tests
passed on that frozen commit because they intentionally asserted the bug.
They are historical evidence, not acceptance tests of the corrected candidate.

## Correction

The shared reader captures a frozen origin before I/O: the requested spelling,
resolved target/chain and canonical path. It reads the captured canonical path
and rechecks every original path under current policy before returning bytes.
A policy denial of A therefore refuses a pending read of A even if the requested
alias is retargeted to allowed B before Promise delivery. B's current spelling
cannot authorize A's old bytes. Fresh B reads remain available.

Cached parsed values inherit the exact pre-I/O origin through a private WeakMap.
This provenance is neither serialized data nor an exemption supplied by source
content, environment or RuntimeConfig. It survives transformations through:

- conditional rules and their later attachment emission;
- plugin agents and definition consumption;
- skill parsing, bounded discovery, plugin contributions and index metadata;
- plugin command parsing/contributions and command enumeration/listing;
- workflow discovery/listing, production synthetic-skill construction and
  cached descriptions/when-to-use/phases/body text.

When original content is no longer authorized, these consumers refuse it or
reload the current source with the guarded reader. Conditional rules, plugin
agents, ordinary skill metadata and plugin command metadata can consume fresh
allowed replacements. Synthetic workflow bodies are rebuilt from freshly
parsed allowed script metadata; the old generated body is not re-authorized by
an alias change. A concurrent owner's denial remains effective when another
owner relaxes its own policy. Relaxed policy permits newly authorized reads
again; the change does not permanently disable sources after any update.

The original canonical-provenance P1 was independently accepted at `9092a4e`.
Two narrow synthetic refresh findings and their correction are recorded in the
[synthetic workflow follow-up](2026-10-12-synthetic-workflow-refresh-fix.md).

No command wrapper, approved-escape posture, tool-owned sandbox flag, native
floor enrollment or own-MCP exception changed. The frozen `d7d4688b` workload
parity matrix was not repeated. `contextReadChecksVersion: 1` remains an explicit
candidate implementation claim awaiting re-review and Core activation acceptance.
There is no transcript/model-state scrub or running-native-child drain claim.
Arbitrary same-user hardlink and external filesystem mutation races remain the
previously documented defense-in-depth residual; the deterministic reviewed
alias transitions no longer release stale protected content.

## Regressions and positive controls

`packages/runtime/src/sandbox/source-read-retarget.test.ts` converts the cache
reproducer into absence expectations and adds allowed replacement guidance,
policy relaxation, concurrent-owner denial, plugin command/skill contribution
and synthetic workflow metadata controls. It runs in ordinary test discovery.

`packages/runtime/src/sandbox/source-read-async-retarget.isolated.ts` converts
the held real-read reproducer into refusal plus successful fresh B-read
expectations. It holds the actual fs/promises read result, rather than fabricating
bytes. Run it in its own process because it deliberately mocks that module:

```sh
bun test ./packages/runtime/src/sandbox/source-read-async-retarget.isolated.ts
```

Actual native-child/embedded startup and own-control exception probes remain
in the independent fixture directory and are rerun explicitly with `./` paths:

```sh
bun test ./docs/research/host-context-read-independent-fixtures/startup.repro.ts ./docs/research/host-context-read-independent-fixtures/control.repro.ts
```

Final validation: source/retarget/live-path suites **21 passed / 124 expectations**;
separate held async read **1 passed / 2 expectations**; actual native/embedded
startup and own-control probes **3 passed / 16 expectations**; focused loader/
production compatibility **556 passed / 1,208 expectations across 11 files**.
Both SDK TypeScript configurations passed after the final pre-I/O origin changes. Tests use only disposable synthetic homes/files and the repository
safety preloads. No live Winter app/home/Keychain or VM operation, publication,
release/pin, full-suite repeat or native workload matrix repeat occurred.
