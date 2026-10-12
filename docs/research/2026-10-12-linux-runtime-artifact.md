# Linux guest runtime build

The runtime builder accepts an explicit `bun-linux-arm64` target through
`--linux-arm64 --out PATH`. It preserves the path-neutral source copy and disables
Bun config/dotenv autoload. A guest target requires an explicit output and refuses
host platform-package staging. Existing host builds retain their target behavior.

The actual runtime at source `bbab87d9` compiled successfully on macOS using this
builder. `file` and the installed LLVM object inspector identify ELF64 AArch64,
the `/lib/ld-linux-aarch64.so.1` interpreter, five system-library dependencies and
GLIBC_2.17 requirements. The companion JSON records the exact binary hash, size,
builder hash and tool version. The existing checkout-path exclusion check passed.
This artifact needs those Linux libraries in the immutable guest image; it is not
a statically linked standalone Linux root filesystem.

Build guards and existing builder tests pass (9 tests, 17 assertions). No Linux
execution, VM boot, runtime helper integration, provider call or guest authority
acceptance is claimed. Confined startup still refuses. This prepares the real
engine artifact for the forthcoming supervisor integration; it does not release
a Linux package or change Winter's dependency pin.
