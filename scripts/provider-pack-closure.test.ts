// 0.0.56 (W9): the provider pair installs alone. See provider-pack-closure.ts for the rule.
import { describe, expect, test } from "bun:test";
import { closureViolations, packProviderClosure, type PackedView } from "./provider-pack-closure.ts";

const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
const MACHO64 = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]);
const TEXT = new Uint8Array([0x2f, 0x2f, 0x20, 0x61]);

function view(manifest: Record<string, unknown>, files: PackedView["files"] = []): PackedView {
  return { manifest: { name: "@yanlinglabs/winter-provider-runtime", ...manifest }, files };
}

describe("closureViolations (pure)", () => {
  test("a clean provider manifest passes: the catalog is the only dependency", () => {
    expect(closureViolations(view({ dependencies: { "@yanlinglabs/winter-provider-catalog": "0.0.56" } }, [{ path: "dist/index.js", head: TEXT, text: 'import { x } from "@yanlinglabs/winter-provider-catalog";' }]))).toEqual([]);
  });

  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    test(`refuses the sdk in ${field}`, () => {
      expect(closureViolations(view({ [field]: { "@yanlinglabs/winter-agent-sdk": "0.0.56" } })).join("\n")).toContain("carries the winter runtime binary");
    });
  }

  test("refuses the platform package even on its own", () => {
    expect(closureViolations(view({ optionalDependencies: { "@yanlinglabs/winter-agent-sdk-darwin-arm64": "0.0.56" } }))).toHaveLength(1);
  });

  test("refuses bundled dependencies written as an array", () => {
    expect(closureViolations(view({ bundleDependencies: ["@yanlinglabs/winter-agent-sdk"] }))).toHaveLength(1);
  });

  test("refuses any other dependency (the install would grow)", () => {
    expect(closureViolations(view({ dependencies: { "left-pad": "1.0.0" } })).join("\n")).toContain("outside the provider pair");
  });

  test("refuses a bin and a shipped native executable (Mach-O, ELF)", () => {
    expect(closureViolations(view({ bin: { winter: "bin/winter" } }))).toHaveLength(1);
    expect(closureViolations(view({}, [{ path: "bin/winter", head: MACHO64 }]))).toHaveLength(1);
    expect(closureViolations(view({}, [{ path: "bin/winter", head: ELF }]))).toHaveLength(1);
  });

  test("refuses compiled JS or a declaration that still imports the sdk", () => {
    expect(closureViolations(view({}, [{ path: "dist/identity.js", head: TEXT, text: 'import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";' }]))).toHaveLength(1);
    expect(closureViolations(view({}, [{ path: "dist/types.d.ts", head: TEXT, text: 'export type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";' }]))).toHaveLength(1);
    expect(closureViolations(view({}, [{ path: "dist/x.js", head: TEXT, text: 'const m = await import("@yanlinglabs/winter-agent-sdk/tools");' }]))).toHaveLength(1);
  });

  test("a prose mention of the sdk's name is not an import", () => {
    expect(closureViolations(view({}, [{ path: "dist/x.js", head: TEXT, text: '// replaces what @yanlinglabs/winter-agent-sdk used to provide; product "winter-agent-sdk"' }]))).toEqual([]);
  });
});

// The real pack + offline install: ~10 s (two builds, two packs, one npm install). Same opt-in rule
// as smoke-installed.test.ts: always in CI, locally with WINTER_TEST_PACK_SMOKE=1.
const PACK_SMOKE_ENABLED = (process.env["CI"] ?? "") !== "" || process.env["WINTER_TEST_PACK_SMOKE"] === "1";
if (!PACK_SMOKE_ENABLED) console.log("[provider-pack-closure] SKIPPING the pack+install leg; run it with WINTER_TEST_PACK_SMOKE=1 bun test scripts/provider-pack-closure.test.ts (CI always runs it).");

describe.skipIf(!PACK_SMOKE_ENABLED)("the packed provider pair", () => {
  test(
    "packs with no sdk dependency and no binary, and installs as exactly two packages",
    async () => {
      const result = await packProviderClosure();
      expect(result.violations).toEqual([]);
      expect(result.installed).toEqual(["@yanlinglabs/winter-provider-catalog", "@yanlinglabs/winter-provider-runtime"]);
    },
    240_000,
  );
});
