// Task 7 (WS-07 §6.2): recognizeEditOperation fixture corpus. Pure string logic, no fs, no engine
// imports -- mirrors grammar.test.ts's/paths.test.ts's own synthetic-string convention.
import { describe, test, expect } from "bun:test";
import { recognizeEditOperation, RECOGNIZED_BASH_FS_OPS } from "./edit-recognition.ts";

function bash(command: string) {
  return { toolName: "Bash", input: { command } };
}

describe("recognizeEditOperation -- Edit/Write direct (WS-07 §6.2)", () => {
  test("Edit with a string file_path recognizes as kind:edit", () => {
    expect(recognizeEditOperation({ toolName: "Edit", input: { file_path: "/work/a.ts" } })).toEqual({
      kind: "edit",
      paths: ["/work/a.ts"],
    });
  });

  test("Write with a string file_path recognizes as kind:edit", () => {
    expect(recognizeEditOperation({ toolName: "Write", input: { file_path: "/work/b.ts" } })).toEqual({
      kind: "edit",
      paths: ["/work/b.ts"],
    });
  });

  test("Edit missing file_path (or non-string) -> null (ambiguous)", () => {
    expect(recognizeEditOperation({ toolName: "Edit", input: {} })).toBeNull();
    expect(recognizeEditOperation({ toolName: "Edit", input: { file_path: 42 } })).toBeNull();
  });

  test("an unrelated tool (Read, MCP, etc.) -> null", () => {
    expect(recognizeEditOperation({ toolName: "Read", input: { file_path: "/work/a.ts" } })).toBeNull();
  });
});

describe("recognizeEditOperation -- Bash recognized fs-op subset (WS-07 §6.2 verbatim seven verbs)", () => {
  test("RECOGNIZED_BASH_FS_OPS is exactly the WS-07 §6.2 seven-verb list", () => {
    expect([...RECOGNIZED_BASH_FS_OPS].sort()).toEqual(["cp", "mkdir", "mv", "rm", "rmdir", "sed", "touch"]);
  });

  test("mkdir/touch/rm/rmdir: single operand recognized", () => {
    expect(recognizeEditOperation(bash("mkdir ./scratch"))).toEqual({ kind: "bashFsOp", paths: ["./scratch"] });
    expect(recognizeEditOperation(bash("touch ./scratch/file.txt"))).toEqual({
      kind: "bashFsOp",
      paths: ["./scratch/file.txt"],
    });
    expect(recognizeEditOperation(bash("rm ./tmp/x"))).toEqual({ kind: "bashFsOp", paths: ["./tmp/x"] });
    expect(recognizeEditOperation(bash("rmdir ./tmp/emptydir"))).toEqual({ kind: "bashFsOp", paths: ["./tmp/emptydir"] });
  });

  test("flags are skipped, not treated as paths (`rm -rf ./tmp/x`)", () => {
    expect(recognizeEditOperation(bash("rm -rf ./tmp/x"))).toEqual({ kind: "bashFsOp", paths: ["./tmp/x"] });
  });

  test("`--` ends flag parsing: a literal dash-prefixed operand after `--` is NOT dropped as a flag", () => {
    expect(recognizeEditOperation(bash("rm -rf -- -weird-name"))).toEqual({ kind: "bashFsOp", paths: ["-weird-name"] });
  });

  test("mv/cp: BOTH source and destination operands are collected (not just the last one)", () => {
    expect(recognizeEditOperation(bash("mv ./a.txt ./b.txt"))).toEqual({ kind: "bashFsOp", paths: ["./a.txt", "./b.txt"] });
    expect(recognizeEditOperation(bash("cp -r ./src ./dest"))).toEqual({ kind: "bashFsOp", paths: ["./src", "./dest"] });
  });

  test("quoted operands with spaces are read as one token", () => {
    expect(recognizeEditOperation(bash('mv "./a file.txt" ./dest/'))).toEqual({
      kind: "bashFsOp",
      paths: ["./a file.txt", "./dest/"],
    });
  });

  test("sed -i (GNU-style, script attached, one file): script dropped, file path recognized", () => {
    expect(recognizeEditOperation(bash("sed -i 's/x/y/' ./file.txt"))).toEqual({
      kind: "bashFsOp",
      paths: ["./file.txt"],
    });
  });

  test("sed -i '' (BSD/macOS-style empty-suffix idiom): script dropped, file path recognized", () => {
    expect(recognizeEditOperation(bash("sed -i '' 's/x/y/' ./file.txt"))).toEqual({
      kind: "bashFsOp",
      paths: ["./file.txt"],
    });
  });

  test("sed -i with multiple files: every file operand collected", () => {
    expect(recognizeEditOperation(bash("sed -i 's/x/y/' ./a.txt ./b.txt"))).toEqual({
      kind: "bashFsOp",
      paths: ["./a.txt", "./b.txt"],
    });
  });

  test("bare `sed` WITHOUT -i is not recognized as an edit op (no in-place mutation)", () => {
    expect(recognizeEditOperation(bash("sed 's/x/y/' ./file.txt"))).toBeNull();
  });

  test("an unrecognized leading command (e.g. `curl`) -> null when nothing else write-shaped is present", () => {
    expect(recognizeEditOperation(bash("curl https://example.com"))).toBeNull();
  });
});

describe("recognizeEditOperation -- compound commands (every subcommand independently classified)", () => {
  test("`mkdir foo && touch foo/bar`: both blessed -> kind bashFsOp, union of paths", () => {
    expect(recognizeEditOperation(bash("mkdir ./foo && touch ./foo/bar"))).toEqual({
      kind: "bashFsOp",
      paths: ["./foo", "./foo/bar"],
    });
  });

  test("`ls && rm -rf ./tmp/x`: one subcommand unrecognized -> kind:other, but the recognized path still surfaces", () => {
    expect(recognizeEditOperation(bash("ls && rm -rf ./tmp/x"))).toEqual({ kind: "other", paths: ["./tmp/x"] });
  });
});

describe("recognizeEditOperation -- redirect targets (write paths that never widen the blessed set)", () => {
  test("`echo x > file.txt`: redirect target surfaces as kind:other (never bashFsOp)", () => {
    expect(recognizeEditOperation(bash("echo x > ./file.txt"))).toEqual({ kind: "other", paths: ["./file.txt"] });
  });

  test("a blessed command that ALSO redirects is demoted to kind:other (redirect never rides along in the blessed set)", () => {
    expect(recognizeEditOperation(bash("touch ./a.txt > ./log.txt"))).toEqual({
      kind: "other",
      paths: ["./a.txt", "./log.txt"],
    });
  });
});

describe("recognizeEditOperation -- ambiguous/unparseable -> null (WS-07 §6.2: falls back to a prompt)", () => {
  test("an empty command -> null", () => {
    expect(recognizeEditOperation(bash(""))).toBeNull();
  });

  test("a command that is ONLY separators (splitCompound returns [], not null) -> null, never a vacuous match", () => {
    expect(recognizeEditOperation(bash("&&"))).toBeNull();
    expect(recognizeEditOperation(bash(";"))).toBeNull();
  });

  test("an unterminated quote (unparseable) -> null", () => {
    expect(recognizeEditOperation(bash("rm 'unterminated"))).toBeNull();
  });

  test("a non-Bash, non-Edit/Write tool -> null", () => {
    expect(recognizeEditOperation({ toolName: "WebFetch", input: { url: "https://example.com" } })).toBeNull();
  });
});
