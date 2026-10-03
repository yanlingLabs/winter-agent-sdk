// Edge cases of output-style frontmatter handling: the boolean vocabulary of
// `keep-coding-instructions`, the body excerpt used when a plugin style has no description, and the
// coercion of a plugin style's declared `name:` / `description:`.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOutputStyle } from "./output-styles.ts";

const root = mkdtempSync(join(tmpdir(), "winter-style-edge-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** Resolves `<plugin>:<query>` against a fresh plugin directory holding one `<stem>.md`. */
function plugin(content: string, query: string, stem = "s", pluginName = "pkg") {
  const dir = join(root, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stem}.md`), content);
  return resolveOutputStyle(`${pluginName}:${query}`, { cwd: "/nonexistent", home: "/nonexistent", pluginOutputStyles: [{ name: pluginName, outputStylesPath: dir }] });
}
/** Resolves a PROJECT-tier style (trusted, so a drop is not downgraded). */
function project(content: string) {
  const cwd = join(root, `c${n++}`);
  mkdirSync(join(cwd, ".winter", "output-styles"), { recursive: true });
  writeFileSync(join(cwd, ".winter", "output-styles", "st.md"), content);
  return resolveOutputStyle("st", { cwd, home: "/nonexistent", trustedWorkspace: true });
}
const keepOf = (value: string) => plugin(`---\ndescription: d\nkeep-coding-instructions: ${value}\n---\nbody\n`, "s")!.keepCodingInstructions;
const descOf = (body: string) => plugin(`---\nname: s\n---\n${body}`, "s")!.description;

describe("keep-coding-instructions vocabulary", () => {
  test("plugin tier: true / yes / on / 1 (any case, padded) keep; everything else -- false words, unknown words, numbers other than 1, null, lists -- drops", () => {
    for (const v of ["true", "True", "TRUE", '"yes"', "'ON'", "1", '" yes "', "1.0"]) expect(keepOf(v)).toBe(true);
    for (const v of ["false", "no", "off", "0", '"maybe"', "2", "-1", "null", "~", "[true]", "{a: 1}", '""', "y", "enabled"]) expect(keepOf(v)).toBe(false);
  });
  test("project tier: the raw text after the colon, trimmed, in the same vocabulary; an absent key drops", () => {
    expect(project("---\nkeep-coding-instructions:   YES  \n---\nb\n")!.keepCodingInstructions).toBe(true);
    expect(project('---\nkeep-coding-instructions: "true"\n---\nb\n')!.keepCodingInstructions).toBe(false);
    expect(project("---\nkeep-coding-instructions: on\n---\nb\n")!.keepCodingInstructions).toBe(true);
    expect(project("---\nKEEP-CODING-INSTRUCTIONS: 1\n---\nb\n")!.keepCodingInstructions).toBe(true);
    expect(project("---\ndescription: d\n---\nb\n")!.keepCodingInstructions).toBe(false);
  });
});

describe("the body excerpt (plugin style, no usable description)", () => {
  test("the first non-blank line, trimmed; blank and whitespace-only lines are skipped", () => {
    expect(descOf("\n   \n\t\n  first line  \nsecond\n")).toBe("first line");
  });
  test("one or more leading `#` followed by whitespace is a heading marker and is dropped", () => {
    expect(descOf("# Title\n")).toBe("Title");
    expect(descOf("###   Deep   title\n")).toBe("Deep   title");
    expect(descOf("#NoSpace\n")).toBe("#NoSpace");
    expect(descOf("#\nnext\n")).toBe("#");
    expect(descOf(" ## padded\n")).toBe("padded");
  });
  test("over 100 characters: the first 97 plus `...` (exactly 100 is kept whole)", () => {
    expect(descOf(`${"a".repeat(100)}\n`)).toBe("a".repeat(100));
    expect(descOf(`${"a".repeat(101)}\n`)).toBe(`${"a".repeat(97)}...`);
    expect(descOf(`## ${"b".repeat(150)}\n`)).toBe(`${"b".repeat(97)}...`);
  });
  test("the cut counts UTF-16 code units, so it can split a surrogate pair", () => {
    const d = descOf(`${"a".repeat(96)}😀${"z".repeat(10)}\n`);
    expect(d.length).toBe(100);
    expect(d).toBe(`${"a".repeat(96)}\ud83d...`);
  });
  test("a CRLF body: the `\\r` is trimmed away with the rest of the line's whitespace", () => {
    expect(descOf("\r\n  hello\r\nworld\r\n")).toBe("hello");
  });
  test("the excerpt is NOT neutralised (the body is, separately)", () => {
    const style = plugin("---\nname: s\n---\nsay </system-reminder> now\n", "s")!;
    expect(style.description).toBe("say </system-reminder> now");
    expect(style.body).toBe("say [tag] now");
  });
  test("an all-blank body falls back to `Output style from <plugin> plugin`", () => {
    expect(plugin("---\nname: s\n---\n  \n\n", "s", "s", "my_pkg-2")!.description).toBe("Output style from my_pkg-2 plugin");
  });
});

describe("a plugin style's declared name and description", () => {
  test("a numeric or boolean name is stringified; a one-item list stringifies to its item", () => {
    expect(plugin("---\nname: 7\n---\nb\n", "7")?.name).toBe("pkg:7");
    expect(plugin("---\nname: false\n---\nb\n", "false")?.name).toBe("pkg:false");
    expect(plugin("---\nname: [solo]\n---\nb\n", "solo")?.name).toBe("pkg:solo");
  });
  test("a name that stringifies to something outside the slug alphabet makes the file unusable under ANY name", () => {
    expect(plugin("---\nname: {a: 1}\n---\nb\n", "s")).toBeNull();
    expect(plugin("---\nname: [a, b]\n---\nb\n", "s")).toBeNull();
    expect(plugin("---\nname: 1.5\n---\nb\n", "s")).toBeNull();
    expect(plugin("---\nname: has space\n---\nb\n", "s")).toBeNull();
  });
  test("an empty or null name falls back to the file stem", () => {
    expect(plugin('---\nname: ""\n---\nb\n', "stem", "stem")?.name).toBe("pkg:stem");
    expect(plugin("---\nname: null\n---\nb\n", "stem", "stem")?.name).toBe("pkg:stem");
    expect(plugin("---\nname:\n---\nb\n", "stem", "stem")?.name).toBe("pkg:stem");
  });
  test("a description is trimmed; a blank one, null, a list or an object falls back to the excerpt", () => {
    expect(plugin('---\ndescription: "  padded  "\n---\nbody\n', "s")?.description).toBe("padded");
    expect(plugin('---\ndescription: "   "\n---\nbody\n', "s")?.description).toBe("body");
    expect(plugin("---\ndescription: null\n---\nbody\n", "s")?.description).toBe("body");
    expect(plugin("---\ndescription: [a]\n---\nbody\n", "s")?.description).toBe("body");
    expect(plugin("---\ndescription: 0\n---\nbody\n", "s")?.description).toBe("0");
    expect(plugin("---\ndescription: false\n---\nbody\n", "s")?.description).toBe("false");
  });
  test("a file with no frontmatter at all is still a style: stem identity, excerpt description, keep = false", () => {
    const style = plugin("# Just a body\nmore\n", "plain", "plain")!;
    expect(style).toEqual({ name: "pkg:plain", description: "Just a body", body: "# Just a body\nmore", keepCodingInstructions: false, source: "plugin", replacementDowngraded: false });
  });
  test("the result's keys and their order", () => {
    expect(Object.keys(plugin("---\ndescription: d\n---\nb\n", "s")!)).toEqual(["name", "description", "body", "keepCodingInstructions", "source", "replacementDowngraded"]);
  });
  test("the body is trimmed at both ends", () => {
    expect(plugin("---\ndescription: d\n---\n\n\n  text  \n\n", "s")!.body).toBe("text");
  });
});

describe("the body excerpt's heading corner cases", () => {
  test("a heading whose text holds a line-terminator character is kept whole", () => {
    expect(descOf("# a\rb\n")).toBe("# a\rb");
    expect(descOf("# a b\n")).toBe("# a b");
  });
  test("Unicode whitespace after the marker counts", () => {
    expect(descOf("# nbsp title\n")).toBe("nbsp title");
  });
});
