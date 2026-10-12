# Fresh SDK build provenance and fixture evidence correction — 2026-10-12

Isolated branch `cowork/fresh-build-provenance`, worktree `.worktrees/fresh-build-provenance`, base `15059de90f814ad6f3667ccab36052fc0887b530`. Implements F1–F3 from Winter's `docs/research/2026-10-12-cowork-fresh-sdk-engine-independent-review.md`. Root AGENTS and the held-task ledger were read; this work does not retry or bypass either held Mac VM/native-egress lane. The initial source and all earlier artifacts remain preserved.

## F1: measured source and dependency binding

`compile.ts` records a path-neutral compile receipt, not a bare current-checkout label. The inventory includes packages/scripts/config and **actual installed dependency bytes and relative resolution links**, including dependency `dist` directories. Bounds are 20,000 entries, 16MiB per input, 256MiB aggregate, and 16MiB receipt/metafile JSON. Fixed compiler/base executable reads are descriptor-bound and capped at256MiB. Source and staging inventories must agree before compilation, and both are recaptured afterward; host compiler hash is also rechecked. Staging is a separate private `stage/` beside deterministic `source/`, preserving the accepted canonical builder's no-autoload behavior. The generic SDK compiler was not changed.

Each entry's actual Bun metafile input set is checked against captured physical dependency/source paths; external, missing or unmeasured inputs refuse. Receipt output records bind the complete measured inventory, each bundled input, normalized metafile digest, exact command/environment, host Bun version/hash/platform/architecture, pinned Linux Bun base version/hash, and resulting ARM64 ELF hash/size. No personal source/output/temp paths enter the retained compile receipt or normalized metafiles.

`build.py` requires the compile receipt before any native compiler or output-directory side effect. It compares the current full inventory, compiler/base/recipe metadata, bundled inputs, normalized metafile files and supplied ELF bytes. After copying entries/metadata it repeats validation before native receipt creation. Native receipt format2 binds `compileReceiptSha256`; verifier success/failure observations identify both compile and reviewed-native receipt digests. Native commands are normalized; the existing native compiler's invoker hash/version and fixed build environment are measured. Its entire C toolchain/sysroot is not claimed reproducible by that measurement.

Unsigned JSON cannot self-authenticate provenance. This closes accidental stale/foreign entry relabeling by the builder; it does **not** defeat an actor forging all receipt contents or prove review/approval. Trusted reviewed build/run provenance and separate source/artifact/native admission are still required. The Linux native build requires the same installed dependency snapshot used by the compiler. Legacy native format1 and entries without measured compile receipts are not accepted by the corrected builder.

## F2: structural execution oracle

The validator requires exact Read `hello\n`, Edit/Write structured results, foreground Bash result, corresponding exact tool names/IDs/inputs and ordering, final text after all four results, and distinct actual assistant anchors. The five native-state records must contain the expected provider/model/family/continuation domain/item index and exact reasoning items at their respective anchors. State envelope IDs cannot be empty, duplicated or assistant IDs; boolean item indices refuse. Store evidence reads are capped before parsing. The fixture provider checks prior assistant native continuation structurally and emits fixed normalized failure codes. Added negatives reproduce the reviewer's corrupt Read and marker-only payload false positives, plus wrong input/payload/anchor/schema and evidence bounds.

## F3: retained failure observations

Supervisor diagnostics are separate protected control files, not SDK store authority. They preserve phase, fixed refusal/failure code, observed native receipt/wait status, parent reap/exit, tool drain/debt and cleanup status before terminal status publication. A diagnostic-write failure retains debt. Runtime stdout remains bounded count/hash metadata; runtime/provider/service stderr retains at most4KiB UTF8 normalized text, removing fixture/absolute paths, URLs, fake credential, long hex identities and labeled secret/token values. Provider packets/arbitrary stdout are not persisted as text. Process capture buffers are bounded and drained concurrently; failed harness runs preserve provider receipt and service/provider reap/capture states before pipe disposal. Kill/EOF/Python unwinding do not become release proof.

Synthetic lifecycle regressions cover failure before native/SDK store creation, confirmed native cleanup then later fixture assertion failure, reap mismatch, tool debt, redaction/bounds and retained normalized diagnostics. No real credential is supplied; the fixture provider uses its named fake credential only. The diagnostic policy is fixture-specific and is not a general arbitrary-output secret scrubber.

## Remaining privileged bootstrap gate

The current verifier imports `build.py`/`provenance.py` before `main` checks the supplied receipt. This is not a hash-admitted privileged entrypoint, and the original direct elevated repository command is removed from the current guide. F1–F3 do not establish protected staging ancestry or approval by themselves. Before any privileged project import, a separate trusted stdlib-only, independently hash-admitted parent must validate/stage the **complete** measured source/dependency/artifact closure under root-owned, non-user-renamable ancestry. This is a separate unimplemented/source-review gate, not an invitation to retry either held Mac lane. No privileged execution readiness is claimed for this leaf.

## Current validation and artifacts

- `python3 -I -S -m unittest discover -s scripts/guest-engine -p 'test_*.py' -v`: **36 passed**. Includes11 provenance cases and the portable exact-source native framing harness with substituted kernel authority; this is not actual helper/owner admission.
- `python3 -I -S -m unittest discover -s scripts/guest-supervisor -p 'test_*.py' -v`: **32 run,31 passed,1 Linux-only skip**. New lifecycle tests inject subprocess/kernel dependencies.
- `bun run typecheck`: both SDK projects passed, exit0.
- `git diff --check`: exit0.
- Actual Bun compilation on macOS produced both Linux ARM64 ELF entries; `file` independently inspected machine/loader. Neither entry was executed.
- The real native-build compile validator accepted the final receipt/current source/dependency inventory. Substituting the retained historical provider ELF from original `out/fresh-engine-entry-invocations/providerWorker` refused with `compiled artifact mismatch` before any native compiler invocation. The synthetic builder regression also proves no output-directory side effect on stale input.

Final current-source candidate: `out/fresh-build-provenance/entries-g/`. Compile receipt SHA256: `bc135396917d835de5b33127eda4b666894d0e6ce0f27a0b2cdb06cc79771239`. Input inventory:3,728 records, SHA256 `b46df3f493b04a99c645c3af893c502441a7e567acd18d09a50696b5fa0615f1`.

| Entry | Bytes | Bundled input records | SHA256 |
| --- | --- | --- | --- |
| runtimeEntry | 102344848 | 561 | `e97df26ff3decf5d285c64998541f83ee0f00967208f53a63900d43aa83fe0e6` |
| providerWorker | 93694096 | 1 | `38cab08e265849b2ac3ac3d9bc649ffabf5a28e387dd1cce5e8254bb96daddb2` |

Host Bun1.3.14 SHA256 `e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233`; Linux base SHA256 `37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086`. The base came from the existing separately pinned `winter/spikes/cowork-hvf/out/guest-runtime/base/bun`; no download or installation occurred. Dependencies were read-only copies of the original fresh-engine worktree's `node_modules` and each package's relative `node_modules`, preserving local workspace links; originals were not modified.

Earlier successful compilation candidates `entries-e`/`entries-f` and the final candidate produce identical entry ELF bytes. Their compile receipt digests differ: Bun's CommonJS metafile import-resolution annotations vary even when the bundled input inventory and ELF bytes agree. This is retained actual metadata, not claimed byte-reproducible metadata. The final candidate additionally includes the last evidence-envelope regression in its broad source inventory. Failed probes `entries-a`, `entries-probe-b`, `entries-c`, `entries-probe-d` and logs remain retained: they issued no compile receipt. They exposed macOS `/var`→`/private/var` canonicalization and the initially excluded dependency `dist` files; both were corrected before the successful candidates.

Retained private logs under `out/fresh-build-provenance/`:

| File | SHA256 |
| --- | --- |
| `python-engine-tests-final.log` | `f96865a91b36bceb7a74dca6a74bf673c8f4cbc322a60f99a84dfebacfd09704` |
| `python-supervisor-tests-final.log` | `04b74247b395f11bb2cac30e1c88f794a1d7f54bf272ecb425044fb42f93a4b7` |
| `typecheck-final.log` | `2eae81d9ee3f6489a4e1723a6da7ded9e731f52ff61c48cae3cfba7be45ea5b3` |
| `compile-g.log` | `853bfea79279ce51c606211aec5a5aa94d2c0e15e2c2acbe9e3df4138bc075a7` |
| `compile-validation-final.log` | `4ee1b7f52526ba7eba1f4436ea5e8ee378d7c0e680c662a8642d6b03a3301b25` |
| `stale-elf-validation.log` | `a62d4741b046e46f6cafe0fb056b634800ab10da538dae2d43d7fcb9e2f4db43` |

Artifacts/logs/output directories remain untracked; only source/tests/docs are committed. Generated Python cache directories are removed. No privileged Linux/native fixture, compiled guest execution, VM, mount, real provider/credential, live Winter home/app/Keychain, held-lane work, SDK release/pin, push or activation occurred. Full native artifact build/receipt and Linux execution remain unrun gates after independent re-review. General confined execution and production availability remain false; this is not full Cowork acceptance.
