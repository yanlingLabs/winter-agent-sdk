import { test, expect } from "bun:test";
import { verifyDigest, ChecksumMismatchError } from "./fetch-upstream.ts";

test("verifyDigest passes on a matching sha256", () => {
  const bytes = new TextEncoder().encode("hello");
  // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  expect(() => verifyDigest(bytes, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")).not.toThrow();
});
test("verifyDigest throws ChecksumMismatchError on mismatch", () => {
  const bytes = new TextEncoder().encode("hello");
  expect(() => verifyDigest(bytes, "0".repeat(64))).toThrow(ChecksumMismatchError);
});
