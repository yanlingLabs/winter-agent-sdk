# Proposed one-shot hosted Bun FD proof — SOURCE, unpushed

Worktree `.worktrees/sdk-bun-reader-fd-hosted-proof`, branch
`cowork/bun-reader-fd-hosted-proof`, based on reviewed prerequisite
`b6c8097803156993a38f65c06093efa5dc5176ff`. The original probe and runner are
unchanged, including their SHA256 pins. No Linux FD probe, hosted run, binary
archive download/extraction, build or push has occurred in preparing this source.
Only public official release metadata and checksum/signature **text DATA** were
retrieved. Local tests only parse source/DATA and synthetic ZIP/receipt bytes.

## Exact proposed workflow and admission

`.github/workflows/cowork-bun-fd-proof-reviewed.yml` runs on creation-push of only
the named branch in `yanlingLabs/winter-agent-sdk`. Job guards require the zero
before-SHA, exact branch/repository and `run_attempt == 1`. No manual dispatch,
PR trigger, retries or follow-up push is permitted. Concurrency does not cancel
an in-progress run. Runs on `ubuntu-24.04-arm`, timeout five minutes, with only
`contents: read`. There is no sudo, container, build, package install, SDK/Root
packet pipeline or production runtime execution. Checkout disables credential
persistence, LFS and submodules; every action uses a full immutable SHA:

- checkout: `11d5960a326750d5838078e36cf38b85af677262`
- upload-artifact: `ea165f8d65b6e75b540449e92b4886f43607fa02`

Both commit identities were checked through their official GitHub commit APIs.
Checkout uses the actual event SHA. Before any target operation, an inline
reviewed bootstrap reads the driver through O_NOFOLLOW, checks type/nlink/size,
checks read identity and SHA256, then executes only those exact source bytes.
The driver checks exact runner/probe/metadata/text pins before binary acquisition.
The broader existing CI push trigger narrowly ignores this experiment branch,
preventing its unrelated sudo/compile jobs from running on the one admitted push.
All other branches, tags and PR CI retain their original trigger coverage.

`python3 scripts/bun-reader-fd-proof/hosted.py` defaults to structured SKIP/exit77
before acquisition, extraction, process execution or fixture FD IO. Its explicit
target gate also checks actual Linux/aarch64 and real/effective non-root UID.
The driver and all child processes get closed environments; GitHub/runner tokens,
proxy variables, secrets and user config are never passed to the probe. The only
new process-group cleanup concerns the fresh session created for this fixture's
own Python runner/Bun child; no ambient groups or live processes are touched.

Root and reviewer45 must inspect and admit the exact final commit/tree, workflow
digest, source pins, official archive pin/signature residual, result oracle and
one-push/one-attempt command before the feature push. Source acceptance alone is
not execution admission. After that one push the branch remains frozen; no UI
rerun, dispatch or retry follows failure. Existing held Mac/native-egress lanes
remain held. No release, tag, consumer pin or production activation follows.

## Official artifact DATA and signature residual

Primary release API:
`https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.3.14`, observed
2026-10-14. Release320260981, published2026-05-13T03:48:28Z, target immutable
commit `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`.

Official archive URL:
`https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-aarch64.zip`
Asset418773677, exactly35700603 bytes, SHA256
`a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b`.
This agrees between official release API digest, SHASUMS256.txt and the matching
cleartext body of SHASUMS256.txt.asc. Retained text pins:

- SHASUMS256.txt:3431B, SHA256
  `0fec8a7c8c72e903dba7ca24b533f9e924da296e65dec32418f68389ccd26165`
- SHASUMS256.txt.asc:3709B, SHA256
  `f7dae34eb12b0752232f284a517457d9e7de44db90c8b8cfd6a494fcee410c9e`
- official-release-DATA.json: SHA256
  `ab6677c961b27a79e6473e8c3e2889c974684e93854675383bc31791c06ee02d`

**Residual:** no independent PGP signature verification against an authenticated
maintainer key occurred. Official API/TLS provenance and agreeing official texts
are accepted as a proposed archive integrity pin, not an independent signature
or reproduced-build guarantee. The hosted receipt explicitly sets
`signatureVerified:false`; exact45/Root must accept this residual before execution.

Proposed hosted acquisition disables proxies, allows HTTPS redirects only to
github.com and release-assets.githubusercontent.com, downloads at most expected
size+1 and checks exact size/hash before ZIP parsing. It allows only the single
`bun-linux-aarch64/bun` file plus an optional empty containing directory. No path
extraction occurs; duplicates, unexpected entries, symlinks, encrypted entries,
oversized bytes or non-ELF64/AArch64 fail. Only the checked member is written into
a new disposable directory, with executable mode0500. Its actual expanded hash
is recorded and passed to the pinned runner. The full Bun.version/revision gate
remains inside the probe before libc/FD operations.

## Result oracle and limits

The unchanged pinned runner requires actual synchronous open-before-return,
independent peer data/hash, real short writes/drains, labeled F_GETFD+errno closure
and exact number reuse, and the regular-file detached connectError class. Missing
features/notifications or wrong failure classes fail; target SKIP never becomes
PASS. See README.md for the full owned-fixture matrix.

Hosted driver bounds stdout and final result to65536B, rejects stderr/multiple
lines/target SKIP, and verifies that PASS remains only the CLI fixture scope with
actual child reaping reported and VM/activation flags false. It independently
reuses the hash-verified runner's inert full receipt oracle on
the received result, including all labeled FD states and the peer byte hash;
scope fields or a PASS label alone cannot establish success. Acquisition/target
failures retain a closed FAIL result. An always-run source finalizer records exact
result byte count and SHA256 before uploading only result.json and receipt.json,
with seven-day retention, no overwrite and missing files treated as error.

A PASS establishes only exercised **unprivileged CLI-Bun FD behavior**. It does
not prove compiled Winter/Bun behavior, guided session wiring, C owner/Root
authority/cleanup, guest isolation, VM admission or production readiness. A
single regular-file rejection case must never re-enable production connectError
numeric-close. Separate general ownership evidence and exact approval remain due.

## Inert verification / source CI proposal

Nineteen tests currently cover default skip, exact source/artifact DATA pins,
first-push/attempt/UID/architecture gates, closed ZIP parsing, scope/refusal oracle
and workflow action/source pins. The existing eleven FD receipt tests remain
synthetic DATA tests. The following source-only command is suitable for CI after
review; it performs no network/native target invocation:

```sh
python3 -B -m unittest discover -s scripts/bun-reader-fd-proof -p 'test_*.py' -v
git diff --check
```

No new liveness change was needed in the reviewed FD runner. The outer hosted
driver adds a40-second absolute runner timeout and terminates/reaps its own fresh
session's direct child on timeout; failure never invents descendant/native cleanup
evidence. The GitHub job timeout is a final ceiling, not cleanup proof.
