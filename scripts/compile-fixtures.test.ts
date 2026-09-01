import { test, expect } from "bun:test";
import { compile } from "./compile-fixtures.ts";

test("plain-query fixture compiles against the winter package (un-skipped in Task 7)", async () => {
  const r = await compile("packages/conformance/tsconfig.winter.json");
  expect(r.ok).toBe(true);
});
