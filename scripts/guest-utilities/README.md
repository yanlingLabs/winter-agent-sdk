# Measured real-utility fixture preparation

This is an independent source/capture/oracle slice. It prepares a disposable
Linux tool-compatibility fixture. The native runner is implemented as source and
requires separate exact source/artifact admission before execution. No native
runner, utility, helper, namespace or VM was executed for this slice.
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
  Every input/output leaf records a strict boolean execution intent. The six
  programs require X. Exactly two measured loader spellings also require X while
  retaining the `library` role: `/lib/ld-linux-aarch64.so.1` and
  `/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1`. All other libraries, extensions
  and stdlib leaves require non-executable modes. No additional program is added.
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
target:"linux-arm64-gnu", files:{"/guest/path":{role,source,sha256,bytes,executable}}}`.
`source` is relative to the fixture origin tree. No origin discovery or default
manifest is installed. No real Linux utility closure was captured in this task.

## Separate executable fixture and admission

`utilityClient` is an explicitly named compiled Bun client for direct native tool
views. It is neither `runtimeEntry` nor the actual SDK/provider loop. It uses the
existing UID-authenticated supervisor's file/process port with fixed scopes,
roots and tool/runtime UIDs. The first SDK fixture's strict five provider turns,
four tool results and transcript/native-state oracle remain unchanged.

The client runs the fixed smoke payload twice; each starts with empty private
tmp/shm. The first leaves private canaries that cannot enter the second view.
Additional requests check file-helper runtime/control/store and source-symlink
refusal, readonly and plan mounts, a setsid descendant after foreground exit,
and cancellation with uncertain effects. Success also requires positive source
canaries, absent orphan writes after a bounded delay, exact zero active/debt
status, the existing supervisor's immutable namespace-init wait receipts, client
reaping and a clean service close/wait. No timeout, EOF or kill() substitutes for
native wait confirmation. Result/client records and every failure directory are
retained; no automatic unmount or ignoring EROFS is available.

The fixed descendant payload writes its readiness marker only in the child,
after successful `setsid()`. Its foreground parent waits at most two seconds for
that exact marker before exiting; cancellation observes the same child marker.
The source and readonly fixture directories both have tool-owned/group-writable
2770 permissions. The smoke checks exact RW/RO mount flags and matching inode
ownership/modes, writes a positive control to the writable source and preserves
the readonly grant. Thus the readonly negative has no independent DAC denial.
The tool's primary UID/GID remain 10001; workspace GID 10000 is supplementary.
The smoke checks that membership and each directory's fixed workspace group
separately instead of equating the directory group with the primary GID.

`stage.py` is a separate stdlib-only externally hash-admitted parent. Its archive
contains the entire measured SDK source/dependency closure, utilityClient and
normalized metafile, three native tool artifacts and their source/header/scripts,
fixed smoke bytes, native/Bun compiler recipes and identities, build workflow,
utility capture/origin receipts and only the fixed utility environment. It
checks exact archive/receipt/parent hashes, bounded unique paths and bytes, no
archive hardlinks/devices/traversal, internal source-only symlinks, exact compiler
and utility roles, compile graph and fixed six-executable ceiling. Only after
those checks does it create a root-owned immutable sealed tree and revalidate
all owners/modes/links/bytes. The runner rechecks that tree before loading any
project module. The source bootstrap itself must be byte-checked by an external
isolated system-Python invocation before executing the parent; unsigned hashes
reported by an untrusted build are not authority.

The changed native launcher now makes each detached admitted/device mount
explicitly `MS_PRIVATE` before namespace transfer. The destination namespace's
existing recursive private-root operation remains. The runner records the
original outer mountinfo before launch, samples it during work, and compares it
after service wait. Any observed addition/change or reader failure is retained
as failure; a later equal snapshot cannot erase an observed transient change.
This sampled observer is an additional regression oracle, not a continuous
kernel trace. No native enforcement claim follows from its portable tests.

## Ordinary build-only workflow

`.github/workflows/cowork-tool-utilities-build.yml` runs ordinary Linux ARM64 build
steps only. Its fixed input collector copies just the six existing utilities,
selected explicit Python 3.12 modules/packages/extensions and recursively needed
libraries identified by bounded readelf metadata. It never executes those input
ELFs or copies a general host root/usr tree. The origin receipt records readelf
and Python identities and metadata command hashes. Dependency completeness
remains false until the admitted smoke actually passes.

The workflow verifies the existing pinned Bun archive/base hashes, compiles only
the named utilityClient with no autoload flags, captures the explicit utility
manifest, compiles three native helpers, and constructs/revalidates the complete
receipt/archive. No sudo, native fixture run or production activation is wired
into that workflow. Linux C toolchain system headers are supplied by the trusted
ordinary CI build environment; this is measured build provenance, not a fully
hermetic toolchain claim. A local Mac ARM64 client cross-compile is compile-only
and is refused for native admission by the parent, which requires a fresh Linux
ARM64 builder identity in the client receipt.

Build `38308107043` compiled the named client, then failed during input collection
because the selection expected `zipfile.py`. Python 3.12 supplies the
[`zipfile` package](https://github.com/python/cpython/tree/v3.12.0/Lib/zipfile).
The fixed package selection now captures its initializer and nested `.py` leaves
through the same measured copy path. Missing package initializers or required
modules still refuse; this source correction does not establish a completed
Linux utility closure, artifact admission or native execution.

The admitted run `38377350513` passed the stdin, inventory and boundary markers,
then failed importing multiprocessing. Static inspection of its pinned pickle
source found an unconditional `import _compat_pickle` whose leaf was absent.
The explicit module selection now includes `_compat_pickle.py`. Before emitting
the input manifest, a focused AST guard reads the measured origin copies of
`pickle.py` and `_compat_pickle.py` through held nofollow descriptors, checks
their exact recorded bytes, and requires that direct module-body import.
Imports nested under try/if cannot satisfy it. Pickle's two `_pickle` accelerator
imports have explicit ImportError fallbacks; they are optional paths, separate
from this required pure-source edge. No guest Python module or input ELF runs.
This guard proves only that fixed edge and selected leaf, not the full static
graph, platform branches, dynamic imports or runtime completeness. A fresh
source/build/artifact review and separately admitted run remain required.

Artifact audit of build `38333923765` found that loader bytes were measured but
captured/copied as 0444. Execution intent now binds capture modes (0555/0444),
bundle metadata, immutable staging modes (0500/0400), and verified runtime copy
modes (0555/0444). Validators reject a missing loader X bit, X on any other
library, and mode changes even when bytes/hash are unchanged. Old mode-less
receipts refuse and need a fresh source/build/artifact review. The first SDK
bundle is unchanged, and no native utility fixture execution is implied here.
The audited build's actual checkout was PR merge
`077e6c036e472656b1aab238a7af0f5296588a4b`, not branch head `33ce2179`.
Its measured graph must retain that identity; the new metadata requires a new
archive and review rather than relabeling the old bundle.

Portable source validation:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/guest-utilities -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest scripts/guest-engine/test_tool_devices.py scripts/guest-engine/test_shell_stdin.py scripts/guest-engine/test_runtime_entropy.py scripts/guest-engine/test_parent_remap.py -v
pnpm exec tsc --noEmit -p tsconfig.typecheck.json
```

A later externally byte-checked parent may receive only the exact independently
approved archive/receipt/parent hashes and `--run` for an isolated disposable
Linux runner. No execution command or approval identity is preinstalled. The
new native utility fixture remains unexecuted and unadmitted. General tool
availability stays false even if this limited fixture later passes; first SDK,
VM integration, cold continuity and resource/storage acceptance are separate.
Neither held Mac two-disk nor native egress work is resumed by this slice.
