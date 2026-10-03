// Edge cases of `substituteArguments`, the `/name args` placeholder expander: `$ARGUMENTS` (the whole
// args text), `$ARGUMENTS[n]` and `$n` (0-based words of the args), `$<name>` (named arguments),
// `\$` escapes, and the "\nARGUMENTS: <args>" append when nothing in the body was a placeholder.
import { describe, expect, test } from "bun:test";
import { substituteArguments as sub } from "./resolver.ts";

describe("substituteArguments: plain $ARGUMENTS", () => {
  test("every occurrence becomes the whole args text, inner spacing kept", () => {
    expect(sub("[$ARGUMENTS] [$ARGUMENTS]", "a   b")).toBe("[a   b] [a   b]");
  });

  test("no boundary is required after the token: $ARGUMENTSX and $ARGUMENTS_JSON substitute their $ARGUMENTS prefix", () => {
    expect(sub("$ARGUMENTSX", "q")).toBe("qX");
    expect(sub("$ARGUMENTS_JSON", "q")).toBe("q_JSON");
  });

  test("a token directly followed by digits is still plain $ARGUMENTS", () => {
    expect(sub("$ARGUMENTS0", "q")).toBe("q0");
  });

  test("whitespace-only args are inserted as-is", () => {
    expect(sub("<$ARGUMENTS>", "  ")).toBe("<  >");
  });

  test("JavaScript replacement patterns in the args ($$, $&, $`, $') are inserted literally", () => {
    expect(sub("$ARGUMENTS", "a $$ b $& c $` d $' e $1")).toBe("a $$ b $& c $` d $' e $1");
  });

  test("an args value containing $ARGUMENTS or $0 is never re-expanded", () => {
    expect(sub("$ARGUMENTS", "$ARGUMENTS $0 $ARGUMENTS[0]")).toBe("$ARGUMENTS $0 $ARGUMENTS[0]");
    expect(sub("$0", "$ARGUMENTS")).toBe("$ARGUMENTS");
  });

  test("text formed by a dollar in the body plus a substituted word is not re-scanned", () => {
    expect(sub("$$0", "ARGUMENTS")).toBe("$ARGUMENTS");
    expect(sub("$$0", "0")).toBe("$0");
  });
});

describe("substituteArguments: $ARGUMENTS[n]", () => {
  test("indexes the word split of the args, 0-based", () => {
    expect(sub("$ARGUMENTS[1]-$ARGUMENTS[0]", "a b")).toBe("b-a");
  });

  test("leading zeros are parsed as a decimal index", () => {
    expect(sub("$ARGUMENTS[01]", "a b")).toBe("b");
  });

  test("any character may follow the closing bracket", () => {
    expect(sub("$ARGUMENTS[0]x", "a b")).toBe("ax");
  });

  test("an out-of-range index stays literal, does not count as a substitution, and is not taken by the plain $ARGUMENTS rule", () => {
    expect(sub("v $ARGUMENTS[5] e", "a b")).toBe("v $ARGUMENTS[5] e\nARGUMENTS: a b");
    expect(sub("$ARGUMENTS[0]", "")).toBe("$ARGUMENTS[0]");
  });

  test("an out-of-range index beside a real $ARGUMENTS: the real one substitutes and nothing is appended", () => {
    expect(sub("$ARGUMENTS[9] $ARGUMENTS", "a b")).toBe("$ARGUMENTS[9] a b");
  });

  test("a non-numeric, empty or negative index is not an indexed token -- the plain rule takes the $ARGUMENTS prefix", () => {
    expect(sub("$ARGUMENTS[x] $ARGUMENTS[] $ARGUMENTS[-1]", "a b")).toBe("a b[x] a b[] a b[-1]");
  });

  test("a huge index is out of range", () => {
    expect(sub("$ARGUMENTS[99999999999999999999]", "a")).toBe("$ARGUMENTS[99999999999999999999]\nARGUMENTS: a");
  });
});

describe("substituteArguments: $n", () => {
  test("$0 is the first word", () => {
    expect(sub("$0 then $1", "x y")).toBe("x then y");
  });

  test("the whole digit run is the index: $12 is word 12, never $1 followed by 2", () => {
    expect(sub("$12", "a b c d e f g h i j k l m")).toBe("m");
    expect(sub("$12", "a b")).toBe("$12\nARGUMENTS: a b");
  });

  test("leading zeros are parsed: $01 is word 1", () => {
    expect(sub("$01", "a b")).toBe("b");
  });

  test("a positional followed by an ASCII letter, digit or underscore is not a token", () => {
    expect(sub("$12a $1_ $0x", "a b")).toBe("$12a $1_ $0x\nARGUMENTS: a b");
  });

  test("a positional followed by a non-ASCII letter is a token (the boundary is ASCII-only)", () => {
    expect(sub("$1é", "a b")).toBe("bé");
  });

  test("an out-of-range positional stays exactly as written and does not count as a substitution", () => {
    expect(sub("val $9 end", "a b")).toBe("val $9 end\nARGUMENTS: a b");
  });

  test("an empty quoted word is a real word: $0 becomes the empty string and counts as a substitution", () => {
    expect(sub("[$0]", '"" b')).toBe("[]");
  });

  test("words follow shell quoting: quotes group and are removed", () => {
    expect(sub("$0|$1", "\"a b\" 'c d'")).toBe("a b|c d");
  });

  test("shell-shaped args split as ordinary words (no stop at ; and no special assignment prefix)", () => {
    expect(sub("$0|$1|$2", "X=1 a;b")).toBe("X=1|a;b|$2");
  });

  test("adjacent tokens: $1$ARGUMENTS[0] substitutes both", () => {
    expect(sub("$1$ARGUMENTS[0]", "a b")).toBe("ba");
    expect(sub("$0$1", "a b")).toBe("ab");
    expect(sub("$1$ARGUMENTS", "a b")).toBe("ba b");
  });

  test("an out-of-range indexed token right after a positional does not block the positional", () => {
    expect(sub("$1$ARGUMENTS[9]", "a b")).toBe("b$ARGUMENTS[9]");
  });
});

describe("substituteArguments: backslash escapes", () => {
  test("\\$ARGUMENTS is literal; the backslash is removed", () => {
    expect(sub("literal \\$ARGUMENTS here", "z")).toBe("literal $ARGUMENTS here\nARGUMENTS: z");
  });

  test("\\$0 is literal", () => {
    expect(sub("\\$0", "z")).toBe("$0\nARGUMENTS: z");
  });

  test("\\$ARGUMENTS[0] is literal", () => {
    expect(sub("\\$ARGUMENTS[0]", "z")).toBe("$ARGUMENTS[0]\nARGUMENTS: z");
  });

  test("the escape consumes the backslash before $<digit> or $ARGUMENTS even when no token would have matched there", () => {
    expect(sub("\\$1a", "x")).toBe("$1a\nARGUMENTS: x");
    expect(sub("\\$ARGUMENTSX", "x")).toBe("$ARGUMENTSX\nARGUMENTS: x");
    expect(sub("\\$ARGUMENTS[99]", "x")).toBe("$ARGUMENTS[99]\nARGUMENTS: x");
  });

  test("a backslash before $ followed by anything else is left alone", () => {
    expect(sub("\\$x \\$", "q")).toBe("\\$x \\$\nARGUMENTS: q");
  });

  test("two backslashes before a token: not an escape, both backslashes kept, token substituted", () => {
    expect(sub("\\\\$ARGUMENTS", "z")).toBe("\\\\z");
    expect(sub("\\\\$0", "x")).toBe("\\\\x");
  });

  test("three backslashes before a token: still not an escape (the backslash right before $ is itself preceded by one)", () => {
    expect(sub("\\\\\\$0", "x")).toBe("\\\\\\x");
  });

  test("an escaped named token is literal; a backslash before $name[ is not an escape", () => {
    expect(sub("\\$name", "x", ["name"])).toBe("$name\nARGUMENTS: x");
    expect(sub("\\$name[", "x", ["name"])).toBe("\\$name[\nARGUMENTS: x");
  });

  test("escape recognition comes before any other token and wins where they overlap", () => {
    // The named token would be `$a\`, but `\$0` inside it is an escape first.
    expect(sub("$a\\$0", "x y", ["a\\"])).toBe("$a$0\nARGUMENTS: x y");
  });
});

describe("substituteArguments: the append", () => {
  test("no placeholder anywhere and non-empty args: appended after a newline", () => {
    expect(sub("no placeholder here", "some args")).toBe("no placeholder here\nARGUMENTS: some args");
  });

  test("whitespace-only args are non-empty and are appended", () => {
    expect(sub("body", " ")).toBe("body\nARGUMENTS:  ");
  });

  test("empty args never append", () => {
    expect(sub("no placeholder here", "")).toBe("no placeholder here");
  });

  test("an empty body with args", () => {
    expect(sub("", "a")).toBe("\nARGUMENTS: a");
  });

  test("any successful substitution suppresses the append", () => {
    expect(sub("has $ARGUMENTS here", "val")).toBe("has val here");
    expect(sub("$0 and $ARGUMENTS[7]", "val")).toBe("val and $ARGUMENTS[7]");
  });

  test("the appended text is the raw args, $ signs included", () => {
    expect(sub("x", "$0 $$")).toBe("x\n" + "ARGUMENTS: $0 $$");
  });
});

describe("substituteArguments: U+FFFE / U+FFFF", () => {
  test("in the body they become U+FFFD", () => {
    expect(sub("a\uFFFFb\uFFFEc", "")).toBe("a\uFFFDb\uFFFDc");
  });

  test("in a substituted value or the appended args they become U+FFFD", () => {
    expect(sub("$0", "\uFFFFz\uFFFE")).toBe("\uFFFDz\uFFFD");
    expect(sub("$ARGUMENTS", "a\uFFFF b")).toBe("a\uFFFD b");
    expect(sub("x", "\uFFFE")).toBe("x\nARGUMENTS: \uFFFD");
  });

  test("U+FFFD itself passes through untouched", () => {
    expect(sub("\uFFFD$0", "\uFFFD")).toBe("\uFFFD\uFFFD");
  });
});

describe("substituteArguments: named arguments", () => {
  test("$<name> takes the word at the name's position", () => {
    expect(sub("hello $name!", "world", ["name"])).toBe("hello world!");
    expect(sub("$a/$b", "x y", ["a", "b"])).toBe("x/y");
  });

  test("a named token followed by an ASCII word character or [ is not a token", () => {
    expect(sub("$xa", "a", ["x"])).toBe("$xa\nARGUMENTS: a");
    expect(sub("$x[0]", "a", ["x"])).toBe("$x[0]\nARGUMENTS: a");
  });

  test("a named arg past the end of the words becomes the empty string and still counts as a substitution", () => {
    expect(sub("[$z]", "x", ["q", "z"])).toBe("[]");
    expect(sub("$x", "", ["x"])).toBe("");
  });

  test("an empty name is ignored but the others keep their original position", () => {
    expect(sub("[$z]", "x y", ["", "z"])).toBe("[y]");
  });

  test("longest name first: a shorter name cannot take a longer name's occurrence", () => {
    expect(sub("$a-b", "x y", ["a", "a-b"])).toBe("y");
    expect(sub("$a-b", "x y", ["a-b", "a"])).toBe("x");
    expect(sub("$foo $foobar", "a b", ["foo", "foobar"])).toBe("a b");
  });

  test("a duplicated name: the first declaration takes every occurrence", () => {
    expect(sub("$d $d", "x y", ["d", "d"])).toBe("x x");
  });

  test("a name ARGUMENTS takes $ARGUMENTS before the plain rule", () => {
    expect(sub("$ARGUMENTS", "x y", ["ARGUMENTS"])).toBe("x");
  });

  test("a numeric name takes $<digits> before the positional rule", () => {
    expect(sub("$1", "x y", ["1"])).toBe("x");
  });

  test("names are literal text, regex metacharacters included", () => {
    expect(sub("$x.y $x+", "a b", ["x.y", "x+"])).toBe("a b");
    expect(sub("$xzy", "a", ["x.y"])).toBe("$xzy\nARGUMENTS: a");
  });

  test("a named value containing $ is inserted literally and not re-scanned", () => {
    expect(sub("$n $0", "$0 q", ["n"])).toBe("$0 $0");
  });

  test("adjacent named tokens both substitute", () => {
    expect(sub("$a$b", "x y", ["a", "b"])).toBe("xy");
  });
});
