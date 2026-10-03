// Edge cases of `parseFrontmatter`: where the fence is found, what the body keeps, and exactly what the
// one quote-and-detab retry rewrites. Every expectation here is the current behaviour, recorded.
import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "./definitions.ts";

const fm = (block: string) => parseFrontmatter(`---\n${block}\n---\nbody`).attrs;

describe("parseFrontmatter: the fence", () => {
  test("`----` on the first line is not an opening fence", () => {
    expect(parseFrontmatter("----\nname: x\n---\nbody")).toEqual({ attrs: {}, body: "----\nname: x\n---\nbody" });
  });

  test("the opening `---` must be followed by optional whitespace and a line break -- `---name` is not a fence", () => {
    expect(parseFrontmatter("---name: x\n---\nbody")).toEqual({ attrs: {}, body: "---name: x\n---\nbody" });
  });

  test("trailing spaces after the opening `---` are allowed", () => {
    expect(parseFrontmatter("---   \nname: x\n---\nbody")).toEqual({ attrs: { name: "x" }, body: "body" });
  });

  test("blank lines right after the opening fence are skipped", () => {
    expect(parseFrontmatter("---\n\n\nname: x\n---\nbody")).toEqual({ attrs: { name: "x" }, body: "body" });
  });

  test("the block ends at the FIRST `---` anywhere, even mid-line inside a value", () => {
    expect(parseFrontmatter("---\nname: a---b\n---\nbody")).toEqual({ attrs: { name: "a" }, body: "b\n---\nbody" });
    expect(parseFrontmatter("---\nname: x\ndescription: a --- b\n---\nbody")).toEqual({ attrs: { name: "x", description: "a" }, body: "b\n---\nbody" });
  });

  test("whitespace after the closing `---` -- blank lines included -- is consumed, so the body loses leading blank lines", () => {
    expect(parseFrontmatter("---\nname: x\n---\n\n\n  body")).toEqual({ attrs: { name: "x" }, body: "body" });
    expect(parseFrontmatter("---\nname: x\n---   \nbody")).toEqual({ attrs: { name: "x" }, body: "body" });
  });

  test("a closing `---` at the very end leaves an empty body", () => {
    expect(parseFrontmatter("---\nname: x\n---")).toEqual({ attrs: { name: "x" }, body: "" });
  });

  test("a single BOM before a CRLF fence is ignored", () => {
    expect(parseFrontmatter("﻿---\r\nname: x\r\n---\r\nbody")).toEqual({ attrs: { name: "x" }, body: "body" });
  });

  test("a BOM in front of text that is not a fence stays in the body", () => {
    expect(parseFrontmatter("﻿----\nname: x\n---\nbody")).toEqual({ attrs: {}, body: "﻿----\nname: x\n---\nbody" });
  });
});

describe("parseFrontmatter: what the block reads as", () => {
  test("an empty block, a list, a plain scalar or a null document all read as {}", () => {
    expect(parseFrontmatter("---\n---\nbody")).toEqual({ attrs: {}, body: "body" });
    expect(fm("- a\n- b")).toEqual({});
    expect(fm("just text")).toEqual({});
    expect(fm("~")).toEqual({});
  });

  test("a duplicate key: the last one wins", () => {
    expect(fm("name: a\nname: b")).toEqual({ name: "b" });
  });

  test("a value of only spaces is YAML null", () => {
    expect(fm("name:   ")).toEqual({ name: null });
  });

  test("a colon with no following space is plain text on the first pass", () => {
    expect(fm("name: a:b")).toEqual({ name: "a:b" });
  });

  test("a block that neither attempt can parse reads as {}", () => {
    expect(fm("name: x\nnot valid !!")).toEqual({});
    expect(fm("- a: b: c")).toEqual({});
  });
});

describe("parseFrontmatter: the retry's quoting", () => {
  test("a rewritten value is double-quoted, with backslashes and double quotes escaped", () => {
    expect(fm('name: a: "b" \\ c')).toEqual({ name: 'a: "b" \\ c' });
  });

  test("the separator after the key is normalised to one space when a value is quoted", () => {
    expect(fm("name:\t\tUse when: x")).toEqual({ name: "Use when: x" });
  });

  test("on the retry a `#` makes the value loose, so a trailing comment becomes part of the quoted string", () => {
    expect(fm("name: foo # c\ndescription: Use when: x")).toEqual({ name: "foo # c", description: "Use when: x" });
    // Without a retry the comment is an ordinary YAML comment.
    expect(fm("name: foo # c")).toEqual({ name: "foo" });
  });

  test("a value that merely STARTS with a quote is not treated as already quoted", () => {
    expect(fm('name: "a" b "c": d')).toEqual({ name: '"a" b "c": d' });
  });

  test("a bracketed value that does not parse as a list is quoted; one that does is left alone", () => {
    expect(fm("name: [a]b]\nx: y: z")).toEqual({ name: "[a]b]", x: "y: z" });
    expect(fm("x: y: z\ntools: [a, 'b, c']")).toEqual({ x: "y: z", tools: ["a", "b, c"] });
  });

  test("only `key: value` lines whose key is letters, `_` or `-` are rewritten: a digit in the key leaves the line as is", () => {
    expect(fm("key1: a: b")).toEqual({});
    expect(fm("name: a: b\nkey1: c")).toEqual({ name: "a: b", key1: "c" });
  });

  test("an indented line is never rewritten", () => {
    expect(fm("outer:\n  inner: a: b")).toEqual({});
  });

  test("a line ending in CR (a CRLF file) is never rewritten, so a CRLF file's loose value is not rescued", () => {
    expect(parseFrontmatter("---\r\nname: x\r\ndescription: Use when: foo\r\n---\r\nbody")).toEqual({ attrs: {}, body: "body" });
  });
});

describe("parseFrontmatter: the retry's detab", () => {
  test("each leading tab becomes two spaces", () => {
    expect(fm("description: hello\n\tworld")).toEqual({ description: "hello world" });
    expect(fm("description: hello\n\t\tworld")).toEqual({ description: "hello world" });
  });

  test("a line start for the detab is also right after a bare CR, U+2028 or U+2029", () => {
    expect(fm("k: v\r\tw")).toEqual({ k: "v w" });
    expect(fm("k: a: b\nm: v\r\tw")).toEqual({ k: "a: b", m: "v w" });
    expect(fm("k: a: b\nm: v \tw")).toEqual({ k: "a: b", m: "v   w" });
    expect(fm("k: a: b\nm: v \tw")).toEqual({ k: "a: b", m: "v   w" });
  });

  test("tabs are untouched when the first parse succeeds", () => {
    expect(fm("k: v \tw")).toEqual({ k: "v \tw" });
  });
});
