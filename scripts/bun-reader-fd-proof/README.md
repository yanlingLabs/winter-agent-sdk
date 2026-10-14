# Pinned Bun inherited-FD proof — source only

Prepared from SDK `56e3ea6ab2dd7a0d3da6211b2fe62ce1adaa2c79` on
`cowork/bun-reader-fd-proof`. Native target execution has **not** occurred.
No production adapter, native owner, Root service or transport authority is
implemented by this fixture. No VM, namespace, mount, root privileges, pathname
listener, TCP, credentials or live Winter files are used by its proposed run.
Mac two-disk/native-egress holds remain unaffected.

`python3 scripts/bun-reader-fd-proof/run.py` returns a structured **SKIP**, exit77,
before target imports, binary acquisition/execution, fixture creation or FD IO.
Do not interpret a skipped target, synthetic receipt test or source typecheck as
FD adoption/cleanup proof. No workflow or native auto-trigger is added.

## Exact target scope and pending admission

Before any real run, Root and reviewer45 must review/admit the frozen source tree,
the selected already-acquired Linux Bun artifact and its SHA256, runner/probe
digests, target environment, command and result oracle. This source checkpoint
grants no run, push, download/build, release, version/consumer pin or activation.
If a hosted workflow is later proposed, its exact source needs separate admission.
The CLI admission label records the external review; it is not a capability or
evidence of approval. No retry follows a failure without the required fresh review.

Pending exact target: non-root Linux/epoll, Bun **1.3.14**, full
`Bun.revision=0d9b296af33f2b851fcbf4df3e9ec89751734ba4`. Both binary and probe SHA256
must match the admitted values; no PATH search, download or fallback is allowed.
The process receives a disposable HOME/TMPDIR and a closed credential-free
environment. Python creates its own AF_UNIX SOCK_STREAM socketpair, an original
endpoint plus one duplicated FD, and two regular-file fixture FDs. Parent closes
its transferred copies immediately after spawn. The child has a retained fixture
original, not a fabricated production native owner. Each fixture process is reaped
on all runner exit paths. A failed child is left to process cleanup when transfer
ownership is uncertain; no raw numeric cleanup is guessed.

The future reviewed command has this shape (placeholders are deliberately inert):

```text
python3 scripts/bun-reader-fd-proof/run.py --admitted-run \
  --admission EXACT_ROOT_45_REVIEW_ID --bun /ABSOLUTE/ADMITTED/BUN \
  --bun-sha256 EXACT_64_HEX_SHA256 --probe-sha256 EXACT_64_HEX_SHA256
```

## Measurements and closed oracle

1. The private fixed `Bun.connect({fd,socket})` cast has no host/path/TLS options.
   The open callback stores its actual socket before return; it records exactly
   one synchronous open, a still-open transferred FD and matching promise socket.
2. Peer sends exactly `fixture-data`; child sends a deterministic 1MiB payload.
   SO_SNDBUF=4096 and peer refuses to read until the child reports a real short
   write. Child waits for actual drain callbacks, writes only the remaining
   suffix, and validates every count. The independent Python peer counts/hashes
   all bytes. Missing short-write/drain, excess/lost/reordered bytes, half-close,
   errors, deadline or unexpected output fails; no native result is mocked.
3. `F_GETFD` records raw flags/errno before and after terminate. The inherited
   duplicate must be EBADF immediately after terminate while the retained original
   remains open. A fresh regular-file open, followed only when needed by
   F_DUPFD_CLOEXEC at the released number, proves exact FD-number reuse. Repeated
   terminate plus a later event-loop turn must leave that reused FD alive.
   No dup2/preclose of uncertain descriptor numbers is used.
4. A valid inherited regular-file FD goes through the same private Bun call.
   Linux epoll cannot register an ordinary regular file. The required measured
   class is exactly one synchronous pre-open connectError, no open/post-open
   error, and raw FD still open in the callback and after the API outcome.
   Generic throw/rejection, absent callback or post-adoption failure is recorded
   separately and fails this proof. Callback error code is preserved in a bounded
   sanitized field; no assumed errno from Bun is substituted for measurement.
5. Only after that complete rejection receipt does the fixture close its own raw
   FD exactly once, verify EBADF, then reuse its exact number through a fresh
   regular-file open. Repeated detached-socket terminate and a later event-loop
   turn must preserve the reused FD and independent valid baseline descriptor.

The labeled F_GETFD trace is required by the pure receipt oracle. A failed
F_GETFD must report -1/EBADF, not merely any error. A PASS is this narrow runtime
contract proof, never Root/owner authority, native cleanup receipt, VM admission
or production activation. ChildReaped is process cleanup only.

**Production connectError numeric-close remains prohibited pending actual target
proof and exact45 acceptance.** Source inspection alone is not the measurement.
Do not weaken ownership because the probe is inconvenient or fails.

## Source verification and source-CI proposal

Performed locally: eleven inert Python source/gate/oracle tests and strict focused
TypeScript checking passed. No probe import, native compile, FD IO, Bun target
execution, push or hosted job was performed. Tests synthesize receipt DATA solely
to verify refusal logic; they do not emit native PASS receipts.

Ordinary source CI may run the following, with its existing source-only toolchain:

```sh
python3 -m unittest discover -s scripts/bun-reader-fd-proof -p 'test_source.py' -v
tsc --noEmit --strict --target ESNext --module ESNext \
  --moduleResolution Bundler --skipLibCheck --types bun \
  scripts/bun-reader-fd-proof/probe.ts
git diff --check
```

The local TSC used existing declarations via `--typeRoots` from the sibling SDK
source worktree, without installing packages or altering that worktree. CI should
use its normal existing SDK dependency setup. Never run or import `probe.ts` in
source CI; never add `--admitted-run` to ordinary tests. A default-gate regression
test mocks `target` to throw if it is accidentally reached.

## Primary-source rationale, not measured claims

Immutable Bun source attaches `group.fromFd` before synchronous onOpen:
[socket.zig](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/runtime/socket/socket.zig).
The Linux failed poll-registration branch frees poll allocation and returns:
[uSockets socket.c](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/packages/bun-usockets/src/socket.c).
These sources motivate the hypothesis; only the admitted measured receipt can
establish the exercised runtime ownership/closure behavior.
