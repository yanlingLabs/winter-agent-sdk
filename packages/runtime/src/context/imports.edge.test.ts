// Edge cases of the `@import` token grammar. Each case expands a PROJECT-tier file whose project root
// does not exist and is not an ancestor of the file: every token that is a valid import is then
// reported in `dropped` (with its resolved absolute path) and the text is left untouched, so the
// grammar is observable without reading any file.
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { expandImports } from "./imports.ts";

const FILE = "/cleanroom-imports-edge/dir/WINTER.md";
const ROOT = "/cleanroom-imports-edge/elsewhere-root";
const dropped = (content: string): string[] => {
  const out = expandImports({ content, filePath: FILE, tier: "project", projectRoot: ROOT });
  expect(out.content).toBe(content);
  return out.dropped;
};

describe("where a token starts", () => {
  test("at the start of the content or right after whitespace (space, tab, newline) -- never mid-word", () => {
    expect(dropped("@a")).toEqual(["/cleanroom-imports-edge/dir/a"]);
    expect(dropped("x @a\t@b\n@c")).toEqual(["/cleanroom-imports-edge/dir/a", "/cleanroom-imports-edge/dir/b", "/cleanroom-imports-edge/dir/c"]);
    expect(dropped("mail me@a.com or x(@b)")).toEqual([]);
  });
});

describe("where a token ends", () => {
  test("at whitespace; punctuation and further `@`s are part of the token", () => {
    expect(dropped("@a.md, then")).toEqual(["/cleanroom-imports-edge/dir/a.md,"]);
    expect(dropped("@a@b")).toEqual(["/cleanroom-imports-edge/dir/a@b"]);
  });
  test("a backslash-space continues the token and becomes a space; any other backslash ends it", () => {
    expect(dropped("@my\\ notes.md next")).toEqual(["/cleanroom-imports-edge/dir/my notes.md"]);
    expect(dropped("@a\\b")).toEqual(["/cleanroom-imports-edge/dir/a"]);
    expect(dropped("@a\\\\ b")).toEqual(["/cleanroom-imports-edge/dir/a"]);
  });
  test("a `#fragment` is cut off before anything else; a token that is ONLY a fragment is ignored", () => {
    expect(dropped("@a.md#section-2")).toEqual(["/cleanroom-imports-edge/dir/a.md"]);
    expect(dropped("@a#b#c")).toEqual(["/cleanroom-imports-edge/dir/a"]);
    expect(dropped("@#only")).toEqual([]);
    expect(dropped("@x\\ y#frag\\ z")).toEqual(["/cleanroom-imports-edge/dir/x y"]);
  });
});

describe("which tokens are valid imports", () => {
  test("`./`, `~/` and absolute paths (but never `/` alone)", () => {
    expect(dropped("@./x @~/y @/z @/")).toEqual(["/cleanroom-imports-edge/dir/x", `${homedir()}/y`, "/z"]);
  });
  test("a bare path must start with a letter, digit, `.`, `_` or `-`", () => {
    expect(dropped("@.hidden @_u @-d @9 @../up")).toEqual([
      "/cleanroom-imports-edge/dir/.hidden",
      "/cleanroom-imports-edge/dir/_u",
      "/cleanroom-imports-edge/dir/-d",
      "/cleanroom-imports-edge/dir/9",
      "/cleanroom-imports-edge/up",
    ]);
    expect(dropped("@@x @~x @%x @^x @&x @*x @(x @)x @é @+x @=x @'x @\"x @[x @{x @!x @?x @:x")).toEqual([]);
  });
  test("an escaped leading space makes the path start with a space: not valid", () => {
    expect(dropped("@\\ x")).toEqual([]);
  });
  test("resolution: relative tokens against the containing file's directory, normalised; absolute ones normalised", () => {
    expect(dropped("@a/../b/./c @/p//q/../r")).toEqual(["/cleanroom-imports-edge/dir/b/c", "/p/r"]);
  });
  test("`~` alone or `~user/...` is not the home form", () => {
    expect(dropped("@~ @~root/x")).toEqual([]);
  });
});
