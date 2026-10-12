# Fresh-engine trusted staging parent — 2026-10-12

This source slice follows accepted build/evidence correction `7d61273bab7b33e4360570d1a6d987d84fa2258d`, on isolated branch `cowork/fresh-engine-staging`. It implements the previously open import/staging boundary. All evidence below is source, portable no-effect tests and typechecks. No privileged staging, namespace/helper/guest ELF execution, VM, held Mac lane or native egress activity occurred.

## Trust boundary

`scripts/guest-engine/stage.py` uses only isolated system standard library. The parent itself must be byte-hash-admitted **before execution** by a trusted system-Python bootstrap using the independently approved parent digest. Its native receipt digest is a separate explicit external approval input. A computed checksum, unsigned JSON, CLI flag, environment value or successful byte check does not establish approval or privilege. The operator/trusted CI job supplies these after independent source/artifact/build-provenance admission. Initial source/native build jobs run unprivileged; native build's direct elevated CLI refuses before its project helper import.

The parent checks native receipt format2, measured compile receipt, full packages/scripts/config/installed dependency tree, relative internal resolution links, mandatory native sources, all seven ARM64 artifacts and both normalized metafiles before repository imports. It requires the exact current measured inventory, closed recipes/fields, finite byte/count budgets and **fresh Linux ARM64 compiler provenance**. Mac compilation remains compilation evidence; its receipt cannot admit this Linux privileged runner. Lost, stale or changed dependency/source/artifact bytes, path escapes, link cycles, omitted/unlisted closure members, duplicate JSON fields, altered recipes or invented positive execution claims refuse.

Every original input read walks components with descriptor-relative nofollow opens. Source and artifact directory FDs stay pinned, so caller path rename/substitution cannot redirect later copies. Standard pnpm source hardlinks may be measured and copied; their aliases cannot mutate bytes unnoticed. Original artifacts and all copied immutable leaves require unique links. Copy operations stream bounded chunks, verify exact expected bytes/hash and descriptor identity before/after, and never reopen a checked original pathname as an authority fallback. Capture failure creates no staging tree or runner. Copy failure retains partial audit files and launches nothing; even destination-open failure closes the owned source FD. Directory enumeration streams entries under count limits before bulk allocation.

Staging is a direct child of **fixed `/tmp`**, independent of `TMPDIR`, under prefix `winter-fresh-reviewed-`. `/` and `/tmp` must be real Root-owned directories; `/` is not group/other writable, and writable `/tmp` must be sticky. The Root-owned child is0700 during construction then0500, nested directories0500, code/data0400 and executable artifacts0500. The sealed tree is exactly `source/` plus `artifacts/`; complete hashes, ownership/modes and closed inventory are revalidated. Another UID cannot rename the Root child under the proven sticky parent. Arbitrary caller-owned ancestor substitution is refused.

The runner uses protected fixed system Python in a new `-I -S -B` process with a fixed small environment and `/tmp` cwd. Its initial inline code is standard-library-only: prove ancestry, pin the stage directory, validate and hash-admit the staged parent bytes, revalidate the **whole sealed closure**, then read the verifier bytes and execute them. It mints a process-private admission holding the pinned stage FD, directory identity, process identity and approved receipt/parent/verifier hashes. The verifier checks this admission plus actual Root-owned sealed ancestry and exact bytes **before** importing `build.py` or `provenance.py`. Direct checkout CLI/elevated project imports and forged environment values refuse before a hostile project import marker can run. A private marker alone is not authority; the protected filesystem and externally approved hash chain are required. The staged parent is trusted hash-admitted parent code, not an unvalidated project import.

This is a fixture launch boundary. It is not signed Cowork worker admission, HomeIdentity registration, a host folder grant, proof a guest/tool died, or permission to activate Cowork. The existing native wait/reap/drain requirements and false production gates remain unchanged. Root-held stage inputs are retained for audit, including after successful future fixture execution; this parent never deletes them as a death proof.

## Fresh Linux build/run recipe

Root owns CI execution planning. The following is a **source recipe for a future separately admitted disposable ARM64 Linux job**, not an authorization or command executed here:

1. Use a pinned trusted Linux ARM64 image/system Python, Bun1.3.14 and native compiler. Install the locked SDK dependencies as the ordinary builder UID. Preserve the exact source/dependency snapshot.
2. Freshly compile both entries with this checkout's `compile.ts` and the independently pinned Linux Bun base into a new output directory; do not reuse or relabel old Mac/Linux entries.
3. Unprivileged `python3 -I -S -B scripts/guest-engine/build.py --output <new-native-dir> --runtime-entry <fresh-entries>/runtimeEntry --provider-worker <fresh-entries>/providerWorker --compile-receipt <fresh-entries>/compile-receipt.json` compiles native artifacts and emits native receipt format2 from the same checkout/dependency snapshot.
4. Independently admit exact source, compiler/image/build provenance, parent bytes and native/compile receipts/artifact hashes. Record the approved parent and native receipt SHA256 values externally. Source review or unsigned JSON alone is insufficient.
5. An explicitly authorized Root job uses `/usr/bin/python3 -I -S -B` with the initial stdlib byte-check wrapper below. Only after the parent bytes match the externally approved digest may it execute that parent. Its arguments include both approved digests plus original source/artifact/receipt paths. The parent's own check corroborates the supplied parent digest; it is not the initial admission mechanism.

Initial wrapper body (supply argv and externally approved digests through the trusted job; no elevated invocation occurred here):

```python
import hashlib, os, stat, sys
parent_path, approved_parent_sha = sys.argv[1:3]
fd = os.open(parent_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_size > 16 * 1024 * 1024:
        raise SystemExit('parent input identity/limit')
    wire = os.pread(fd, 16 * 1024 * 1024 + 1, 0)
finally:
    os.close(fd)
if len(wire) != info.st_size or hashlib.sha256(wire).hexdigest() != approved_parent_sha:
    raise SystemExit('external parent byte admission refused')
sys.argv = [parent_path, *sys.argv[3:]]
exec(compile(wire, parent_path, 'exec'), {'__name__': '__main__', '__file__': parent_path})
```

The job must obtain the approved hash from the independent admission record rather than compute it from an unreviewed checkout immediately before execution. Parent args: `--source`, `--artifacts`, `--receipt`, `--approved-receipt-sha256`, `--approved-parent-sha256`. No boolean can enable a privileged checkout verifier. Root/caller environments cannot select staging ancestry, import search paths or an alternative interpreter through these arguments.

## Validation and limits

- `python3 -I -S -B scripts/guest-engine/test_stage.py`: **37 passed**. Synthetic ELF bytes are never executed; Root checks use injected metadata on disposable trees.
- `python3 -I -S -B -m unittest discover -s scripts/guest-engine -p 'test_*.py' -v`: **73 passed**. Includes the earlier portable exact-source C framing harness with substituted kernel authority; no actual native owner/helper admission follows from it.
- `python3 -I -S -B -m unittest discover -s scripts/guest-supervisor -p 'test_*.py' -v`: **32 run,31 passed,1 Linux-only skip**.
- `bun run typecheck`: both projects passed, exit0. Dependency inputs were read-only copies from the frozen prior worktree; no install/global modification.
- Isolated bootstrap Python syntax parsed without execution. `git diff --check` passed.

Tests cover complete synthetic closure; all seven artifact mutations; changed/missing/unlisted sources and installed dependencies; stale/omitted metadata; receipt/link/aggregate/per-file bounds; duplicate native/compile/metafile JSON; escaped, changed, cyclic or external links; source hardlink alias mutation and unique copy; artifact hardlinks; exact recipes/platform and false execution claims; each owned FD closed on refusal; source directory substitution with pinned original bytes; input mutation during measure/copy; Root/sticky/non-symlink ancestry; hostile `TMPDIR`; malformed/tampered/extra/writable stage files; wrong parent digest; forged process/environment admission and direct verifier refusal before malicious project import; exact isolated runner argv/environment with mocked launch. No Root ownership change or real privileged stage was performed.

Retained logs are under ignored/untracked `out/fresh-engine-staging/`. The final parent source hash and log digests are recorded below after freezing. The reviewed prior worktree and all earlier ELF/receipt artifacts remain untouched. A real fresh ARM64 Linux compile/native receipt, privileged staging, actual kernel/native fixture run and full Cowork production acceptance remain unexecuted gates. No push, SDK release/pin or activation occurred.

Parent SHA256: `a5bfb29aac22bfce3cb218c16e39ea18c183812da6507cf8ac228012db0cd566`. This records source bytes for independent review; it does not admit execution.

| Log | SHA256 |
| --- | --- |
| `staging-tests.log` | `1dcafe354f89ce313f9d7b307b0ab195928be38532fa440629e869cc0e17df27` |
| `engine-tests.log` | `fbd03ccdb9f585e07dbe1ae6525e2eaff8b00811fac4c4e1568e572b82f2233a` |
| `supervisor-tests.log` | `d8549182c0500781b110ad9bbb044534477b5a102875e1ab6d1a78059d7eb033` |
| `typecheck.log` | `2eae81d9ee3f6489a4e1723a6da7ded9e731f52ff61c48cae3cfba7be45ea5b3` |
| `bootstrap-syntax.log` | `4afaafd07edfe4c3dfcd6cd493580574a646b606f7b5d90ded32d71dbcb28b83` |
