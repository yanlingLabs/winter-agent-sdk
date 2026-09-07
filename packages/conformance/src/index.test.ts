// The barrel's own import-surface smoke test (P7a Lane C): a typo in a re-export name is a runtime
// error the moment something imports it, not a compile error under this repo's tsconfig (no
// `noUnusedLocals`/exhaustive re-export checking) -- so this test is the thing that actually catches
// it, by importing the barrel exactly the way an external consumer would.
import { describe, test, expect } from "bun:test";
import * as barrel from "./index.ts";
import * as officialSubpath from "./official/index.ts";
import * as traceSubpath from "./trace.ts";

describe("the conformance package barrel (P7a Lane C, WS-02 §9 Step 2)", () => {
  test("re-exports the trace normalizer", () => {
    expect(typeof barrel.normalizeTrace).toBe("function");
    expect(typeof barrel.compareTraces).toBe("function");
    expect(barrel.normalizeTrace).toBe(traceSubpath.normalizeTrace);
  });

  test("re-exports the goldens loaders, and loadGolden actually reads a real committed golden", () => {
    expect(typeof barrel.listGoldens).toBe("function");
    expect(typeof barrel.goldenPath).toBe("function");
    expect(typeof barrel.loadGolden).toBe("function");
    const names = barrel.listGoldens();
    expect(names.length).toBeGreaterThan(0);
    expect(Array.isArray(barrel.loadGolden(names[0] as string))).toBe(true);
  });

  test("re-exports the official (pinned-upstream) mechanics, identical to the ./official subpath", () => {
    expect(typeof barrel.fetchAndVerifyUpstream).toBe("function");
    expect(typeof barrel.resolveCacheDir).toBe("function");
    expect(typeof barrel.verifyDigest).toBe("function");
    expect(typeof barrel.verifySha512Integrity).toBe("function");
    expect(typeof barrel.runCapture).toBe("function");
    expect(typeof barrel.ChecksumMismatchError).toBe("function");
    expect(barrel.fetchAndVerifyUpstream).toBe(officialSubpath.fetchAndVerifyUpstream);
    expect(barrel.runCapture).toBe(officialSubpath.runCapture);
  });
});
