# Measured real-utility fixture preparation

This is an independent source/capture/oracle slice. It prepares a disposable
Linux tool-compatibility fixture; it does not provide a runnable admitted native
runner yet. Nothing here launches a utility, native helper, namespace or VM.
The existing strict five-provider-turn/four-tool fresh-engine oracle is unchanged.
General tool availability and production activation remain false.

## Implemented components

- `closure.py` captures only an explicit externally reviewable manifest. Six
  executable destinations are fixed: Bash, cat, Git, Python 3.12, OpenSSL and
  mktemp. Libraries are limited to ARM64 GNU library/loader paths. Python input
  files are explicit `.py` and lib-dynload extension leaves under the fixed
  `/usr/lib/python3.12` prefix. Site/dist packages, tests, ensurepip and caches
  are excluded. There is no whole-root copy, recursive utility discovery, ldd
  execution, utility version execution, implicit config or real user home.
- The caller supplies canonical fixture-only origin paths and every file's
  SHA-256, length, source spelling, destination and role. Source paths are
  restricted to fixed executable spellings or library/stdlib paths. The capture
  walks origin directories with held nofollow directory FDs, opens each regular
  leaf nonblocking/nofollow, and hashes/copies its held FD while checking identity
  stability. Binary leaves must have ARM64 little-endian ELF headers. No ELF is
  executed. Partial captures are retained on failure; they carry no admission.
- Its receipt binds the manifest, exact output inventory, capture source files
  and running Python builder identity. There is no compiler in this byte-copy
  step. Native C and compiled SDK inputs/compiler/artifacts still require the
  separate existing compile/native receipts. `validate_capture` rejects changed,
  writable, missing, extra, symlinked or multiply linked output leaves and
  unmeasured directories. Each captured output leaf must retain link count one.
  It requires all completeness/execution/availability claims to remain false.
- `smoke.sh` is a non-executable source payload for a later bounded admitted
  process request. It checks the exact device inventory and flags, readable EOF
  stdin and closed inherited descriptors, null/zero/full behavior, private proc
  PID-1/UID/capability checks, absent protected paths and receipt/bootstrap
  socket descriptors, Python entropy/shared memory/semaphore/multiprocessing,
  OpenSSL entropy, Bash process substitution, mktemp and local Git init/commit.
  It uses no network, real credentials, push or interactive input.
- `oracle.py` accepts only the exact five stdout markers, empty stderr, integer
  shell exit zero and normal termination. Its metadata is not native execution
  or teardown proof; a matching native process and immutable parent wait receipt
  must still be supplied by the later reviewed runner.

Python 3.12 and GNU ARM64 are explicit fixture choices, not supported-platform
claims. The minimum manifest checks do **not** infer dependency completeness.
The real reviewed manifest must include every transitive interpreter/library/
stdlib dependency needed by the fixed payload. Native smoke is the completeness
gate. Python source code and ELF bytes in portable tests are synthetic and are
never imported/executed.

## Ordinary source/capture validation

Run from the SDK root, unprivileged:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest scripts/guest-utilities/test_fixture.py -v
```

Six portable tests check isolated CLI capture/refusal, exact synthetic-byte
capture and receipts, source/target and nofollow/FIFO refusals,
extra/writable/multiply linked output refusal, exact result negatives, Bash/Python
syntax only, and preservation of the existing oracle assertions.
The capture CLI itself requires isolated system Python `-I -S -B` and refuses
root before project imports. For a future explicit manifest and fixture-only
origin tree, its ordinary capture command is:

```sh
python3 -I -S -B scripts/guest-utilities/closure.py --utility-root /canonical/disposable/utility-origin --manifest /canonical/reviewed-input-manifest.json --out /canonical/new-capture
```

The manifest schema is `{formatVersion:1, kind:"winter-tool-utility-inputs",
target:"linux-arm64-gnu", files:{"/guest/path":{role,source,sha256,bytes}}}`.
`source` is relative to the fixture origin tree. No origin discovery or default
manifest is installed. No real Linux utility closure was captured in this task.

## Required next integration and admission

The current `scripts/guest-engine/stage.py` explicitly admits seven artifact
names and the original runtime/provider entry paths. This module does not mutate
that allowlist, monkeypatch global recipe constants, replace a measured copy with
an unmeasured host copy, or change its strict oracle. An independently reviewed
extension must bind the new utility receipt and every utility output to an
externally approved hash before privileged imports/staging. Copy via held FDs
into the existing root-owned immutable sealed tree and revalidate the closure.
Do not discover new host paths or run ldd in that privileged step.

The separate native utility entry must use the real inherited immutable owner
library and bootstrap FDs with `admitFreshLinuxSession`; execute this fixed payload
through its admitted file/process binding. Its user-facing model loop need not
replace or weaken the independent strict SDK fixture. Bind the command digest,
scope/revisions, native artifacts, utility capture receipt, compiled entry and
exact result to retained evidence. A second invocation must prove fresh private
tmp/shm. Require actual namespace-init wait receipt, service-owned native cleanup,
zero active/debt state and parent reaping before reporting fixture success.
The file-tool refusal and plan/read-only-source gates remain separate requirements.

Merge the independently reviewed fresh-input correction into the runner build
closure before relying on its existing five-turn/four-tool evidence. Native
utility admission, utilities actually staged, real Linux enforcement, cold
continuity, VM resource/storage integration and production availability remain
open. Neither held Mac two-disk nor native egress work is resumed by this slice.
