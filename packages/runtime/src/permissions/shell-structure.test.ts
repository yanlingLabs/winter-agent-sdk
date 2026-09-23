// shell-structure.ts: every command a Bash string runs, and grammar.ts's widened redirect scan.
import { describe, expect, test } from "bun:test";
import { extractHeredocs, flattenSubcommands, hasProcessSubstitution } from "./shell-structure.ts";
import { dequoteShellWord, extractRedirectTargets, joinLineContinuations, shellWords, splitCompound } from "./grammar.ts";

describe("flattenSubcommands", () => {
  const cases: Array<[string, string[]]> = [
    ["ls $(rm -rf ~)", ["rm -rf ~", "ls $(rm -rf ~)"]],
    ["echo `touch f`", ["touch f", "echo `touch f`"]],
    ["cat <(touch x)", ["touch x", "cat <(touch x)"]],
    ["echo \"$(date)\"", ["date", "echo \"$(date)\""]],
    ["(cp x .git/hooks/pre-commit)", ["cp x .git/hooks/pre-commit", "(cp x .git/hooks/pre-commit)"]],
    ["{ rm -rf ~; }", ["rm -rf ~"]],
    ["if true; then rm -rf ~; fi", ["true", "rm -rf ~", "fi"]],
    ["cat <<EOF\n$(touch pwn)\nEOF", ["touch pwn", "cat <<EOF"]],
    ["a=(1 2 3); echo ok", ["a=(1 2 3)", "echo ok"]],
    ["echo x # it's a comment", ["echo x"]],
  ];
  for (const [command, expected] of cases) {
    test(JSON.stringify(command), () => expect(flattenSubcommands(command)).toEqual(expected));
  }

  test("a QUOTED here-document body is literal: no command, and a later line is still a command", () => {
    // claude's documented attack: joining the continuation first would swallow `> /etc/passwd`.
    expect(flattenSubcommands("cat <<'ls'\nx\\\nls\n> /etc/passwd\nls")).toEqual(["cat <<'ls'", "> /etc/passwd", "ls"]);
    expect(flattenSubcommands("cat <<'EOF' > out\n$(touch pwn)\nEOF\necho done")).toEqual(["cat <<'EOF' > out", "echo done"]);
  });

  test("`$(cat <<'EOF' … EOF)` (the commit-message idiom) adds no subcommand", () => {
    expect(flattenSubcommands("git commit -m \"$(cat <<'EOF'\nFix (it's done)\nEOF\n)\"")).toEqual(["git commit -m \"$(cat <<'EOF'\n)\""]);
  });

  test("unparseable input is null, never a partial answer", () => {
    expect(flattenSubcommands("echo 'unterminated")).toBeNull();
    expect(flattenSubcommands("echo $(ls")).toBeNull();
    expect(flattenSubcommands("case $x in a) echo;; esac")).toBeNull();
    expect(flattenSubcommands("cat <<")).toBeNull();
  });

  test("empty input is an empty list", () => {
    expect(flattenSubcommands("")).toEqual([]);
  });
});

describe("extractHeredocs", () => {
  test("removes a body and its delimiter line; keeps an unquoted body as live", () => {
    expect(extractHeredocs("cat <<EOF > f\nhello $(id)\nEOF\necho after")).toEqual({ text: "cat <<EOF > f\necho after", liveBodies: ["hello $(id)"] });
  });
  test("`<<-` strips leading tabs from the delimiter line", () => {
    expect(extractHeredocs("cat <<-EOF\n\tbody\n\tEOF\nls")?.text).toBe("cat <<-EOF\nls");
  });
});

describe("hasProcessSubstitution", () => {
  test("outside quotes only", () => {
    expect(hasProcessSubstitution("diff <(ls a) <(ls b)")).toBe(true);
    expect(hasProcessSubstitution("echo x > >(tee f)")).toBe(true);
    expect(hasProcessSubstitution("echo '<(not)'")).toBe(false);
    expect(hasProcessSubstitution("a=(1 2)")).toBe(false);
  });
});

describe("the widened redirect scan (grammar.ts)", () => {
  const cases: Array<[string, string[]]> = [
    ["echo x >| .git/config", [".git/config"]],
    ["echo x >&.git/config", [".git/config"]],
    ["echo x >& out.log", ["out.log"]],
    ["echo x &>> .git/config", [".git/config"]],
    ["echo x &> both.log", ["both.log"]],
    ["exec 3<>.git/config", [".git/config"]],
    ["echo x 2>|err.log", ["err.log"]],
    ["echo x > \\\n.git/config", [".git/config"]],
    ["echo x >out;rm y", ["out"]],
    ["cmd 2>&1 >&2 >&- 3>&1", []],
    ["cat <<EOF\nx\nEOF", []],
    ["cat <<< hello", []],
    ["echo x > >(tee f)", []],
  ];
  for (const [command, expected] of cases) {
    test(JSON.stringify(command), () => expect(extractRedirectTargets(command)).toEqual(expected));
  }

  test("`>|` is a redirect, not a pipe: splitCompound keeps it in one subcommand", () => {
    expect(splitCompound("echo x >| .git/config")).toEqual(["echo x >| .git/config"]);
    expect(splitCompound("echo x | wc")).toEqual(["echo x", "wc"]);
  });

  test("line continuations: an odd backslash run joins, an even one is an escaped backslash", () => {
    expect(joinLineContinuations("a \\\nb")).toBe("a b");
    expect(joinLineContinuations("a \\\\\nb")).toBe("a \\\\\nb");
    expect(joinLineContinuations("a \\\\\\\nb")).toBe("a \\\\b");
  });
});

describe("comments: only an UNESCAPED word-start `#` begins one (bash)", () => {
  test("an escaped space does not end the word: `echo x\\ #; rm -rf ~` runs the rm", () => {
    expect(flattenSubcommands("echo x\\ #; rm -rf ~")).toEqual(["echo x\\ #", "rm -rf ~"]);
  });
  test("a quoted `#` is not a comment", () => {
    expect(flattenSubcommands("echo '#'; rm -rf ~")).toEqual(["echo '#'", "rm -rf ~"]);
  });
  test("a word-start `#` after `;` or a redirect operator is", () => {
    expect(flattenSubcommands("echo x;# rm -rf ~")).toEqual(["echo x"]);
    expect(flattenSubcommands("echo x ># rm -rf ~")).toEqual(["echo x >"]);
  });
});

describe("the scanners follow bash's contexts, so no command is dropped or hidden", () => {
  test("`<<` inside arithmetic is a shift, not a here-document: the next line still runs", () => {
    expect(flattenSubcommands("echo $((1<<2))\nrm -rf ~")).toContain("rm -rf ~");
    expect(flattenSubcommands("(( x = 1 << 2 ))\nrm -rf ~")).toContain("rm -rf ~");
    expect(flattenSubcommands("echo $[1<<2]\nrm -rf ~")).toContain("rm -rf ~");
    expect(flattenSubcommands("echo ${x:-<<EOF}\nrm -rf ~")).toContain("rm -rf ~");
  });

  test("a `#` inside a backtick body ends at the closing backtick (bash), not at the end of the line", () => {
    expect(flattenSubcommands("echo `#` ; rm -rf ~")).toContain("rm -rf ~");
  });

  test("ANSI-C `$'…'`: `\\'` does not end the quote, so the code after it is code", () => {
    expect(flattenSubcommands("echo $'\\' #' ; rm -rf ~")).toContain("rm -rf ~");
    expect(flattenSubcommands("echo $'\\'x' ; rm -rf ~ ; echo 'y'")).toContain("rm -rf ~");
    expect(flattenSubcommands("echo $'\\'' $(rm -rf ~) ''")).toContain("rm -rf ~");
    expect(flattenSubcommands("echo $'it\\'s'")).toEqual(["echo $'it\\'s'"]);
  });

  test("an escaped `$` does not open an ANSI-C quote", () => {
    expect(flattenSubcommands("echo \\$'a' ; rm -rf ~")).toContain("rm -rf ~");
  });
});

describe("a function definition's body is a command like any other", () => {
  const cases: Array<[string, string]> = [
    ["f() { rm -rf ~; }; f", "rm -rf ~"],
    ["f () { rm -rf ~; }", "rm -rf ~"],
    ["function f { cp x .git/hooks/pre-commit; }; f", "cp x .git/hooks/pre-commit"],
    ["function f() { rm -rf ~; }", "rm -rf ~"],
    ["g() (rm -rf ~); g", "rm -rf ~"],
  ];
  for (const [command, inner] of cases) {
    test(JSON.stringify(command), () => expect(flattenSubcommands(command)).toContain(inner));
  }
  test("an ordinary command is untouched", () => {
    expect(flattenSubcommands("functional-test run")).toEqual(["functional-test run"]);
  });
});

describe("shellWords / dequoteShellWord: bash's quote removal", () => {
  const cases: Array<[string, string]> = [
    ["'.git'/config", ".git/config"],
    ['".git"/config', ".git/config"],
    ['.g"i"t/config', ".git/config"],
    [".\\git/hooks", ".git/hooks"],
    ["''.git/config", ".git/config"],
    [".git''/config", ".git/config"],
    ["$'\\x2egit'/config", ".git/config"],
    ["$'\\056git'", ".git"],
    ["$'a\\'b'", "a'b"],
    ['$".git"', ".git"],
    ['"a b"', "a b"],
    ["$(echo .git)/config", "$(echo .git)/config"],
  ];
  for (const [word, expected] of cases) {
    test(JSON.stringify(word), () => expect(dequoteShellWord(word)).toBe(expected));
  }
  test("redirect targets are dequoted with it", () => {
    expect(extractRedirectTargets("echo x > '.git'/config 2>.g\"i\"t/err")).toEqual([".git/config", ".git/err"]);
  });
  test("word splitting keeps the raw spelling and whether any of it was quoted", () => {
    expect(shellWords("cp 'a b' c")).toEqual([
      { word: "cp", raw: "cp", quoted: false },
      { word: "a b", raw: "'a b'", quoted: true },
      { word: "c", raw: "c", quoted: false },
    ]);
  });
});
