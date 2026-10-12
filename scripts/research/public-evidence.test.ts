import { expect, test } from "bun:test";
import { publicEvidenceJson, publicEvidenceText } from "./public-evidence";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

test("Seatbelt ancestor literals are normalized with or without a trailing slash", () => {
  const input = '(literal "/private/var/folders/ab/person123/T") (literal "/private/var/folders/ab/person123") (literal "/private/var/folders/ab")';
  expect(publicEvidenceText(input, "/Users/example")).toBe('(literal "/private/var/folders/xx/yyyy/T") (literal "/private/var/folders/xx/yyyy") (literal "/private/var/folders/xx")');
});

test("every dated public evidence file excludes device-specific temp and user-home paths", () => {
  const root = join(import.meta.dir, "../../docs/research"), files: string[] = [];
  const visit = (path: string) => { for (const item of readdirSync(path, { withFileTypes: true })) { const child = join(path, item.name); if (item.isDirectory()) visit(child); else if (item.isFile()) files.push(child); } };
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (!item.name.startsWith("2026-10-12-")) continue;
    const path = join(root, item.name); if (item.isDirectory()) visit(path); else if (item.isFile()) files.push(path);
  }
  expect(files.length).toBeGreaterThan(0);
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/\/(?:private\/)?var\/folders\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?/g)) {
      expect({ file: path.slice(root.length), bucket: match[1], owner: match[2] }).toEqual({ file: path.slice(root.length), bucket: "xx", owner: match[2] === undefined ? undefined : "yyyy" });
    }
    expect({ file: path.slice(root.length), hasUserHome: /\/Users\/[A-Za-z0-9_.-]+/.test(text) }).toEqual({ file: path.slice(root.length), hasUserHome: false });
  }
});
