# Linux guest runtime build

The runtime builder accepts an explicit `bun-linux-arm64` target through
`--linux-arm64 --guest-base PINNED_BUN --out PATH`. It preserves the path-neutral source copy and disables
Bun config/dotenv autoload. A guest target requires an explicit output and refuses
host platform-package staging. Existing host builds retain their target behavior.

The actual runtime at source `bbab87d9` compiled successfully on macOS using this
builder. `file` and the installed LLVM object inspector identify ELF64 AArch64,
the `/lib/ld-linux-aarch64.so.1` interpreter, five system-library dependencies and
GLIBC_2.17 requirements. The companion JSON records the exact binary hash, size,
builder hash and tool version. The existing checkout-path exclusion check passed.
This artifact needs those Linux libraries in the immutable guest image; it is not
a statically linked standalone Linux root filesystem. That initial receipt records
the pre-pin build; the later pinned build has a separate receipt.

The builder now requires the executable pinned in `scripts/linux-runtime-base.json`.
The Bun 1.3.14 [official release](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14)
asset's SHA-256 was checked before reading its single executable entry. Both archive
and executable hashes are recorded. The compiler version must match the pin; the
builder hashes the supplied executable, copies those verified bytes into its
private scratch directory, and passes `--compile-executable-path` explicitly.
Compilation no longer falls back to Bun's download/cache selection. Provisioning
the pinned archive remains an explicit image/build step, not an automatic fetch.

The actual pinned cross-build passed; its receipt is
`2026-10-12-linux-runtime-pinned-artifact.json`. Linux execution must still verify
the guest's expected 4 KiB page size; the host's 16 KiB reclaim granularity is a
separate fact. Loader and library files must also be pinned in the image manifest.

Build guards and existing builder tests pass (10 tests, 21 assertions). No Linux
execution, VM boot, runtime helper integration, provider call or guest authority
acceptance is claimed. Confined startup still refuses. This prepares the real
engine artifact for the forthcoming supervisor integration; it does not release
a Linux package or change Winter's dependency pin.
