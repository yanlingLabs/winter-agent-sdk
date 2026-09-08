// THIN CALLER (P7a Lane C, WS-02 §9 Step 2): the real implementation (ten scenarios A-K, the
// ephemeral official-SDK install, every loopback fake) moved to
// `packages/conformance/src/official/capture.ts` so it is importable from the published
// `@yanlinglabs/winter-conformance` package. See that file's own header for the full procedure,
// hermeticity, and scenario documentation — nothing about the CAPTURE ITSELF changed in the move.
//
// This file keeps exactly two things, byte-for-byte unchanged: the `RUN_OFFICIAL_CAPTURE=1` gate
// (never runs in ordinary CI — needs the ~200MB darwin-arm64/linux-x64 native optional package and
// network egress) and the `bun run scripts/capture-official-golden.ts` CLI entry point.
import { runCapture } from "../packages/conformance/src/official/capture.ts";

if (import.meta.main) {
  if (process.env.RUN_OFFICIAL_CAPTURE !== "1") {
    console.log("capture-official-golden: skipped (set RUN_OFFICIAL_CAPTURE=1 to run — ephemeral, network-using, not part of default CI)");
    process.exit(0);
  }
  await runCapture();
}
