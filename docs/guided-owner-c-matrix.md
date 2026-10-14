# Guided C owner source and target matrix

This lane applies the reviewed C DATA delta and adds source validation. It does
not admit or execute a native target, build a runtime artifact, publish a release,
change a consumer pin, launch a VM or enable Cowork.

The accepted delta is `docs/research/guided-owner-envelope-DATA.patch`, SHA256
`22e69ddc41ba7ef2bbf2e00ab65bd5f0705af81983920c4bf0522ce99c7b51b1`.
The resulting production `linux-session-owner.c` must have SHA256
`c149d451eaa79442dfd41e9375c891ae8c9a06135d2cfc85851bcc8b5ce51fd8`.

Applied unchanged after the reviewed W1/W6 construction cleanup prerequisite:
original commit `b766e7bc13505aa481ae8e22332856e69dde47cd`, cherry-picked as
`ba3ef733` on branch `cowork/guided-owner-c`, based on `fbec8856`.
The resulting tracked C hash was verified to match the accepted reconstruction.

## Portable evidence

`scripts/guest-supervisor/test_guided_owner.py` extracts the actual parser,
envelope branch, file/type/alias prefix and inode identity function. Appleclang
compiles and executes that validation slice with fixed portable test headers.
The slice covers all eight 4/5-descriptor × guided/v1 × registration
presence combinations plus all four profile-absent fresh combinations,
non-object registration, FD4 aliasing each prior role,
FD4 aliasing the exact bootstrap endpoint and a distinct non-socket file.
These are parser/predicate results; no successful predicate admits an owner.

A second test checks source ownership invariants: bootstrap authentication only
at open, reader authentication on later checks, pidfs/service/runtime comparison,
single CLOEXEC transfer, no numeric close of a caller-owned duplicate, terminal
shutdown and stream half-close refusal. Static assertions are source evidence.
A third source test checks the fixture's pre-effect opt-in guard, baseline and
shutdown oracles without compiling or executing the target fixture.

The existing `test_native_parser.py` now excludes Linux authority headers from
its exact portable parser extraction, so adding `sys/vfs.h` to production C does
not make parser-only tests require a Linux sysroot.

Source suite:

```sh
python3 -m unittest discover -s scripts/guest-supervisor -p test_guided_owner.py -v
python3 -m unittest discover -s scripts/guest-supervisor -p test_native_parser.py -v
```

Observed on Darwin on 2026-10-14: the first command passed exactly **3 portable
source tests** and skipped all **12 target entries**. The second passed exactly
**1 parser test**. `git diff --check` and Python syntax parsing passed. These four
portable passes do not include any native ownership or Linux whole-source compile
result. The target fixture has not been compiled or launched.

## Target-only evidence still required

The twelve target test entries require a separately reviewed disposable Linux
execution target. Default discovery checks prerequisites before target compilation
or setup and reports each unavailable case as **skipped**, never passed.
Linux >=6.9, actual Root-created socket peers, UID20001/PID1 private namespaces,
a compiler and explicit target admission are needed for the success/lifetime
matrix. Actual absence of pidfs additionally needs a pre-6.9 target, so that case
is separately skipped on a newer kernel. Version alone does not prove features:
an actual missing feature on a declared compatible target fails the positive case.

`guided_owner_native_fixture.c` includes production C unchanged. It uses actual
pidfds and `SO_PEERPIDFD`, private mount/PID namespaces, a fixture-only chroot,
procfs and store. No native checks are replaced by doubles. Both the Python
runner and compiled fixture require the exact fixed test opt-in before setup;
the runner forwards only that fixed token after its prerequisites pass. The child retains
only its bootstrap/control endpoints before admission; Root closes its copy of
the reader endpoint after SCM_RIGHTS transfer. The runner supplies no inherited
credential environment and requests process-group SIGKILL after failure or
timeout. This signal is not a namespace-child reaping/cleanup observation:
abnormal paths explicitly report cleanup unconfirmed. Successful direct-child
`waitpid` is observed by the fixture; no broader native cleanup claim follows.
It does not use network, real workspace files, Winter homes or keys.

| Target entry | Actual required observation |
| --- | --- |
| Crossed envelope | Only guided+five+registration, v1+four+no-registration and profile-absent fresh+four+no-registration open successfully; other nine refuse |
| FD4 aliases 0, 1, 2, 3 | Each actual transferred alias refuses at non-socket validation; portable all-socket aliases independently cover the inode-comparison branch |
| FD4 bootstrap alias | Same receiving-endpoint inode refuses |
| FD4 non-socket | Distinct regular-file descriptor refuses |
| pidfs absent before 6.9 | First actual older-kernel v1+four+no-registration admission succeeds, then guided admission refuses |
| Claim twice | First CLOEXEC duplicate succeeds, second refuses; owner close preserves a reused caller-owned FD number |
| Reader shutdown | Shutdown leaves caller duplicate owned, makes `owner_check` return `owner_lost`, and makes actual duplicate recv return EOF and send return EPIPE |
| Bootstrap peer closed | Closing Root bootstrap after open leaves reader owner valid |
| Stream half-close | Root reader peer `SHUT_WR` makes `owner_check` return `owner_lost` |

The environment opt-in `WINTER_GUIDED_OWNER_NATIVE_ADMISSION` with the value
`disposable-linux-guided-owner-matrix` is a test execution gate, **not approval or
production authority**. It must only be provided after separate exact target
review/admission. Ordinary Linux source CI must leave it unset.

## Remaining limits

No local Linux sysroot/compiler is admitted. Full Linux C/fixture compilation and
all actual target matrix observations remain unexecuted. Portable compilation
is not whole-source Linux syntax proof. The target fixture itself also remains
uncompiled and unexecuted until separately admitted.

Reader registration metadata is not authenticated by this C patch. The TS layer
must bind its closed metadata through the actual native admission WeakMap, and
Root must exclusively bind the delivered endpoint to the runtime incarnation.
Creator credentials do not authenticate an arbitrary later endpoint holder.
Actual pinned Bun duplicate adoption/cleanup, Root EOF/debt/drain, guided engine
execution and production integration remain independent unfinished gates.
