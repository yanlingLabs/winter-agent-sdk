import { expect, test } from "bun:test";
import { publicEvidenceJson, publicEvidenceText } from "./public-evidence";

test("public captures normalize private and canonical temp paths without changing fixture suffixes", () => {
  const input = 'file:///private/var/folders/ab/synthetic-user/T/fixture-one/a /var/folders/cd/another-user/T/fixture-two/b /Users/example/Library/tool';
  const output = publicEvidenceText(input, "/Users/example");
  expect(output).toBe('file:///private/var/folders/xx/yyyy/T/fixture-one/a /private/var/folders/xx/yyyy/T/fixture-two/b <USER_HOME>/Library/tool');
  expect(publicEvidenceText(output, "/Users/example")).toBe(output);
});

test("nested envelopes retain exit outcomes and byte content other than path substitutions", () => {
  const input = { exitCode: 77, passed: false, argv: ["/private/var/folders/ab/synthetic-user/T/run"], env: { HOME: "/Users/example/home" }, stdout: "fixture-ready\n", hash: "123abc" };
  const output = JSON.parse(publicEvidenceJson(input, "/Users/example"));
  expect(output).toEqual({ ...input, argv: ["/private/var/folders/xx/yyyy/T/run"], env: { HOME: "<USER_HOME>/home" } });
  expect(input.argv[0]).toContain("synthetic-user");
});
