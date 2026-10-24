// 0.0.58: `@yanlinglabs/winter-web` installs alone. See web-pack-closure.ts for the rule.
import { describe, expect, test } from "bun:test";
import type { PackedView } from "./provider-pack-closure.ts";
import { packWebClosure, WEB_PACKAGE, webClosureViolations } from "./web-pack-closure.ts";

const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
const TEXT = new Uint8Array([0x2f, 0x2f, 0x20, 0x61]);

function view(manifest: Record<string, unknown>, files: PackedView["files"] = []): PackedView {
  return { manifest: { name: WEB_PACKAGE, ...manifest }, files };
}

describe("webClosureViolations (pure)", () => {
  test("a clean manifest passes: no dependency, node: built-ins and relative imports only", () => {
    const js = 'import { STATUS_CODES } from "node:http";\nimport { x } from "./address.js";\nexport * from "../y.js";\nconst z = await import("node:zlib");';
    expect(webClosureViolations(view({ devDependencies: { "@types/node": "^26.4.0" } }, [{ path: "dist/index.js", head: TEXT, text: js }]))).toEqual([]);
  });

  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    test(`refuses ANY entry in ${field}, a winter package or not`, () => {
      expect(webClosureViolations(view({ [field]: { "@yanlinglabs/winter-provider-catalog": "0.0.58" } }))).toHaveLength(1);
      expect(webClosureViolations(view({ [field]: { undici: "7.0.0" } }))).toHaveLength(1);
    });
  }

  test("refuses bundled dependencies written as an array, a bin and a native executable", () => {
    expect(webClosureViolations(view({ bundleDependencies: ["x"] }))).toHaveLength(1);
    expect(webClosureViolations(view({ bin: { web: "bin/web" } }))).toHaveLength(1);
    expect(webClosureViolations(view({}, [{ path: "bin/x", head: ELF }]))).toHaveLength(1);
  });

  test("refuses a compiled file importing a bare package, a winter package or a bun: module", () => {
    expect(webClosureViolations(view({}, [{ path: "dist/a.js", head: TEXT, text: 'import x from "undici";' }]))).toHaveLength(1);
    expect(webClosureViolations(view({}, [{ path: "dist/b.d.ts", head: TEXT, text: 'export type { X } from "@yanlinglabs/winter-agent-sdk";' }]))).toHaveLength(1);
    expect(webClosureViolations(view({}, [{ path: "dist/c.js", head: TEXT, text: 'const m = await import("bun:sqlite");' }]))).toHaveLength(1);
    expect(webClosureViolations(view({}, [{ path: "dist/d.js", head: TEXT, text: 'const m = require("http");' }]))).toHaveLength(1);
  });
});

// The real pack + offline install + the Node and Bun probes: always in CI, locally with WINTER_TEST_PACK_SMOKE=1.
const PACK_SMOKE_ENABLED = (process.env["CI"] ?? "") !== "" || process.env["WINTER_TEST_PACK_SMOKE"] === "1";
if (!PACK_SMOKE_ENABLED) console.log("[web-pack-closure] SKIPPING the pack+install leg; run it with WINTER_TEST_PACK_SMOKE=1 bun test scripts/web-pack-closure.test.ts (CI always runs it).");

describe.skipIf(!PACK_SMOKE_ENABLED)("the packed winter-web package", () => {
  test(
    "packs with no dependency, installs as exactly one package, and passes the probe under Node and Bun",
    async () => {
      const result = await packWebClosure();
      expect(result.violations).toEqual([]);
      expect(result.installed).toEqual([WEB_PACKAGE]);
      expect(result.probes).toHaveLength(2);
    },
    240_000,
  );
});
