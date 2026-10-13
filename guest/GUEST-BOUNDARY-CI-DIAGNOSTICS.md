# Generic supervisor concurrency diagnostics

Isolated source base `fe007b5009f34621c9c54c605487c8c9c4f8272e`, branch `cowork/guest-boundary-diagnostics`. The passed first-SDK fixture/source/artifact tree remains frozen and unchanged. This leaf modifies the generic compiled runtime-UID fixture client plus a pure diagnostic formatter and portable tests. No production code, native helper, CI workflow, capacity or deadline changes.

## Observed failures

Completed generic CI job logs for that head:

| Run | Job | Architecture | Result |
| --- | --- | --- | --- |
| 38305539976 PR | 114998563204 | ARM64 | failed |
| 38305539976 PR | 114998563501 | x64 | passed |
| 38305537210 push | 114998553878 | x64 | failed |
| 38305537210 push | 114998554103 | ARM64 | passed |

Both failed the same `file reads remain available while two Bash processes run` conjunction in `scripts/guest-supervisor/client.ts`. Their prior guest-files native step passed. The assertion combines `buildsFinished === 0` with every concurrent Read returning non-error exact `hello` bytes; the old error lacks per-condition evidence. The failed supervisor steps took about 0.92 and 1.20 seconds, including setup and the raw Read probe, which does not support an 8-second command-deadline hypothesis.

This exact source already has entered markers, an explicit release-file barrier, an 8,000 ms command deadline, and finally release/await/abort/allSettled. It does not use fixed sleeps as build lifetimes. No barrier replacement is warranted. The ten concurrent Read requests are locally queued at four file calls, matching the server's four file slots per conversation. Two process calls plus four file calls match its six connection slots; reservation/reply timing still needs actual outcome evidence. No capacity or authority relaxation is inferred from the failure.

Readonly logs and job metadata are retained in the frozen first-fixture worktree under `out/generic-boundary-ci-fe007b50`. Cross-architecture pass/fail is an observation, not a diagnosis or a reason to label these failures flakes.

## Change

On this same assertion failure, the client now emits one bounded metadata record. It separates finished-build, Read-error and wrong-content conditions; reports at most two pending/fulfilled/rejected build observations; and counts at most ten Read outcomes. Build fulfillment contains only validated exit code and termination enum. Error codes are a fixed allowlist; unknown or oversized/custom values become `other`. Raw output, exception text, paths, authority, credentials and file contents never become fields. Nested build observations are copied and revalidated. Formatter/output failure cannot replace the original strict assertion.

An observation handler watches each original build promise without transforming its fulfillment/rejection. The exact shell barrier, entered markers, `.finally` counter, original conjunctive require, release marker and final exit/termination checks remain in place. Unknown effects are not replayed. All lifecycle, file-content, permission, cancellation and revocation oracles remain mandatory.

## Portable validation

```sh
bun test scripts/guest-supervisor/concurrency-diagnostic.test.ts
bun run typecheck
bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv scripts/guest-supervisor/client.ts --outfile out/guest-boundary-diagnostics/runtime-uid-client
git diff --check
```

Bun 1.3.14: **4 tests passed, 27 assertions**, both TypeScript configurations exit 0, ordinary client compilation exit 0 (479 bundled modules), whitespace check exit 0. The locally compiled client is unexecuted and is not the Linux CI artifact. Retained ordinary logs: `out/guest-boundary-diagnostics/{unit.log,types.log,compile.log}`.

The tests distinguish valid overlap, premature exit, timeout/output-limit outcomes, known Read denial versus wrong bytes, unknown error redaction and bounded cardinality. They use synthetic outcomes only. No kernel/private/native boundary was run locally; no root, mount, VM, daemon, live home, Keychain, real provider/credentials/network or held Mac/egress activity occurred. Root must independently review this exact source before any next generic Linux fixture CI. The cause of the original failing conjunct remains unknown until that evidence is observed.
