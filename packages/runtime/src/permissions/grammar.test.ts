// Task 3 (WS-07 §3): the rule-grammar core fixture corpus. Every fixture group below is cited to
// the WS-07 §3 clause it pins, per the task brief's "every clause becomes >=1 fixture" mandate.
// File-rule anchors (//, ~/, /, bare -- WS-07 §3.1) are explicitly OUT of scope here: Task 4 owns
// them in packages/runtime/src/permissions/paths.ts.
import { describe, test, expect } from "bun:test";
import {
  parseRule,
  matchesRule,
  splitCompound,
  stripWrappers,
  extractRedirectTargets,
  isRecognizedReadOnly,
  READ_ONLY_COMMANDS,
  PARSE_LIMIT,
  DANGEROUS_ASSIGNMENT_NAMES,
  FILE_RULE_TOOLS,
} from "./grammar.ts";

function call(toolName: string, input: Record<string, unknown>) {
  return { toolName, input };
}

describe("parseRule -- bare vs Tool(*) equivalence (WS-07 §3: 'Bash(*) is treated like bare Bash')", () => {
  test("a bare tool name has no specifier and is bare-equivalent", () => {
    const rule = parseRule("Bash");
    expect(rule.toolName).toBe("Bash");
    expect(rule.specifier).toBeUndefined();
    expect(rule.isBareEquivalent).toBe(true);
  });

  test("Tool(*) is a distinct parsed specifier but flagged bare-equivalent", () => {
    const rule = parseRule("Bash(*)");
    expect(rule.toolName).toBe("Bash");
    expect(rule.specifier).toEqual({ kind: "wildcardAll" });
    expect(rule.isBareEquivalent).toBe(true);
  });

  test("bare and Tool(*) match identically for every call, either direction", () => {
    const bare = parseRule("Bash");
    const starred = parseRule("Bash(*)");
    const c = call("Bash", { command: "anything at all, including spaces" });
    expect(matchesRule(bare, c, { direction: "allow" })).toBe(true);
    expect(matchesRule(starred, c, { direction: "allow" })).toBe(true);
    expect(matchesRule(bare, c, { direction: "denyAsk" })).toBe(true);
    expect(matchesRule(starred, c, { direction: "denyAsk" })).toBe(true);
  });

  test("a scoped specifier is NOT bare-equivalent", () => {
    expect(parseRule("Bash(ls *)").isBareEquivalent).toBe(false);
  });
});

describe("parseRule -- fix round 2, Ruling P2-G (file-rule tools are never generic param rules)", () => {
  test("Read(a:b/**) parses as a pattern specifier with the colon-bearing path intact, NOT a param rule", () => {
    const rule = parseRule("Read(a:b/**)");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "a:b/**" });
  });

  test("Edit-family case: a Windows-drive-letter-style colon path also parses as a pattern specifier", () => {
    const rule = parseRule("Edit(C:/Users/x/**)");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "C:/Users/x/**" });
  });

  test("Read(*) remains bare-equivalent wildcardAll, not a file pattern of the literal '*'", () => {
    const rule = parseRule("Read(*)");
    expect(rule.specifier).toEqual({ kind: "wildcardAll" });
    expect(rule.isBareEquivalent).toBe(true);
  });

  test("negative control: Agent(model:opus) is still a param rule -- Agent is not a file-rule tool", () => {
    const rule = parseRule("Agent(model:opus)");
    expect(rule.specifier).toEqual({ kind: "param", field: "model", value: "opus" });
  });

  test("negative control: Bash(ls:*) is still the trailing-wildcard sugar -- Bash is not a file-rule tool", () => {
    const rule = parseRule("Bash(ls:*)");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "ls:*" });
  });

  test("negative control: WebFetch(domain:example.com) still parses as the dedicated domain family", () => {
    const rule = parseRule("WebFetch(domain:example.com)");
    expect(rule.specifier).toEqual({ kind: "webFetchDomain", source: "example.com" });
  });

  test("FILE_RULE_TOOLS is exported data (not a scattered conditional) and contains Read and Edit", () => {
    expect(FILE_RULE_TOOLS.has("Read")).toBe(true);
    expect(FILE_RULE_TOOLS.has("Edit")).toBe(true);
    expect(FILE_RULE_TOOLS.has("Bash")).toBe(false);
    expect(FILE_RULE_TOOLS.has("Agent")).toBe(false);
  });
});

describe("Bash command-glob grammar (WS-07 §3)", () => {
  test("Bash(ls *) matches `ls` and `ls -la` but not `lsof`", () => {
    const rule = parseRule("Bash(ls *)");
    expect(matchesRule(rule, call("Bash", { command: "ls" }), { direction: "allow" })).toBe(true);
    expect(matchesRule(rule, call("Bash", { command: "ls -la" }), { direction: "allow" })).toBe(true);
    expect(matchesRule(rule, call("Bash", { command: "lsof" }), { direction: "allow" })).toBe(false);
  });

  test("Bash(ls*) (no space) also matches `lsof`", () => {
    const rule = parseRule("Bash(ls*)");
    expect(matchesRule(rule, call("Bash", { command: "lsof" }), { direction: "allow" })).toBe(true);
    expect(matchesRule(rule, call("Bash", { command: "ls -la" }), { direction: "allow" })).toBe(true);
  });

  test(":* is the trailing-wildcard spelling: Bash(ls:*) === Bash(ls *)", () => {
    const colon = parseRule("Bash(ls:*)");
    const space = parseRule("Bash(ls *)");
    for (const cmd of ["ls", "ls -la", "ls -la /tmp"]) {
      const c = call("Bash", { command: cmd });
      expect(matchesRule(colon, c, { direction: "allow" })).toBe(matchesRule(space, c, { direction: "allow" }));
      expect(matchesRule(colon, c, { direction: "allow" })).toBe(true);
    }
    expect(matchesRule(colon, call("Bash", { command: "lsof" }), { direction: "allow" })).toBe(false);
  });

  test("watch-item: Bash(ls:*) is the pattern family, not a param rule on a field named `ls`", () => {
    const rule = parseRule("Bash(ls:*)");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "ls:*" });
  });

  test("a rule without * matches exactly one value", () => {
    const rule = parseRule("Bash(npm test)");
    expect(matchesRule(rule, call("Bash", { command: "npm test" }), { direction: "allow" })).toBe(true);
    expect(matchesRule(rule, call("Bash", { command: "npm test --watch" }), { direction: "allow" })).toBe(false);
  });

  test("* matches any text including spaces", () => {
    const rule = parseRule("Bash(echo *)");
    expect(
      matchesRule(rule, call("Bash", { command: "echo hello world, this has many spaces" }), { direction: "allow" }),
    ).toBe(true);
  });
});

describe("splitCompound (WS-07 §3: parsed at &&, ||, ;, |, |&, &, and newlines)", () => {
  test("splits on each documented operator", () => {
    expect(splitCompound("ls && rm -rf /tmp/x")).toEqual(["ls", "rm -rf /tmp/x"]);
    expect(splitCompound("a || b")).toEqual(["a", "b"]);
    expect(splitCompound("a; b")).toEqual(["a", "b"]);
    expect(splitCompound("a | b")).toEqual(["a", "b"]);
    expect(splitCompound("a |& b")).toEqual(["a", "b"]);
    expect(splitCompound("a & b")).toEqual(["a", "b"]);
    expect(splitCompound("a\nb")).toEqual(["a", "b"]);
  });

  test("does not split inside single or double quotes", () => {
    expect(splitCompound("echo 'a && b'")).toEqual(["echo 'a && b'"]);
    expect(splitCompound('echo "a && b"')).toEqual(['echo "a && b"']);
  });

  test("does not split inside a command substitution (nested parens protect their content)", () => {
    expect(splitCompound("echo $(ls -la | grep foo) && echo done")).toEqual([
      "echo $(ls -la | grep foo)",
      "echo done",
    ]);
  });

  test("watch-item: 2>&1 and &> are redirects, not split operators", () => {
    expect(splitCompound("a 2>&1 && b")).toEqual(["a 2>&1", "b"]);
    expect(splitCompound("a &> /tmp/out")).toEqual(["a &> /tmp/out"]);
  });

  test("every subcommand is independently permitted -- composition with matchesRule", () => {
    const subs = splitCompound("ls -la && rm -rf /tmp/x");
    expect(subs).not.toBeNull();
    const rule = parseRule("Bash(ls *)");
    const results = subs!.map((s) => matchesRule(rule, call("Bash", { command: s }), { direction: "allow" }));
    expect(results).toEqual([true, false]);
  });

  test("an unterminated quote is unparseable -> null (falls back to permission handling)", () => {
    expect(splitCompound("echo 'unterminated")).toBeNull();
  });

  test("unbalanced parens are unparseable -> null", () => {
    expect(splitCompound("echo $(ls -la")).toBeNull();
    expect(splitCompound("echo ls)")).toBeNull();
  });

  test("a command over the parser length limit is unparseable -> null", () => {
    const huge = "echo " + "a".repeat(PARSE_LIMIT + 1);
    expect(huge.length).toBeGreaterThan(PARSE_LIMIT);
    expect(splitCompound(huge)).toBeNull();
  });

  test("a command at exactly the limit still parses", () => {
    const atLimit = "a".repeat(PARSE_LIMIT);
    expect(splitCompound(atLimit)).toEqual([atLimit]);
  });
});

describe("stripWrappers -- fixed wrapper set (WS-07 §3)", () => {
  const FIXED_EXAMPLES: Array<[string, string]> = [
    ["timeout 30 ls -la", "ls -la"],
    ["time ls -la", "ls -la"],
    ["nice ls -la", "ls -la"],
    ["nohup ls -la", "ls -la"],
    ["stdbuf -oL ls -la", "ls -la"],
    ["command ls -la", "ls -la"],
    ["builtin ls -la", "ls -la"],
    ["noglob ls -la", "ls -la"],
  ];

  for (const [input, expected] of FIXED_EXAMPLES) {
    test(`strips wrapper in "${input}"`, () => {
      expect(stripWrappers(input, "allow")).toBe(expected);
      expect(stripWrappers(input, "denyAsk")).toBe(expected);
    });
  }

  test("flag-free xargs is stripped", () => {
    expect(stripWrappers("xargs rm", "allow")).toBe("rm");
  });

  test("xargs WITH flags is NOT stripped (only flag-free xargs is in the wrapper set)", () => {
    expect(stripWrappers("xargs -0 rm", "allow")).toBe("xargs -0 rm");
  });

  test("chained wrappers strip in sequence", () => {
    expect(stripWrappers("nice timeout 30 ls -la", "allow")).toBe("ls -la");
  });

  test("a command with no wrapper is returned unchanged", () => {
    expect(stripWrappers("ls -la", "allow")).toBe("ls -la");
  });
});

describe("stripWrappers -- leading env-assignment direction asymmetry (WS-07 §3)", () => {
  test("a safe leading assignment is stripped on the allow side", () => {
    expect(stripWrappers("FOO=bar ls -la", "allow")).toBe("ls -la");
  });

  test("multiple safe leading assignments are all stripped on the allow side", () => {
    expect(stripWrappers("FOO=bar BAZ=qux ls -la", "allow")).toBe("ls -la");
  });

  test("an UNSAFE leading assignment (command substitution) is NOT stripped on the allow side", () => {
    const cmd = "FOO=$(cat /etc/hostname) rm -rf /";
    expect(stripWrappers(cmd, "allow")).toBe(cmd);
  });

  test("deny/ask matching looks through ANY leading assignment, safe or not", () => {
    const cmd = "FOO=$(cat /etc/hostname) rm -rf /";
    expect(stripWrappers(cmd, "denyAsk")).toBe("rm -rf /");
  });

  test("a backtick-substitution assignment is also unsafe for allow, but seen through for denyAsk", () => {
    const cmd = "FOO=`whoami` rm -rf /";
    expect(stripWrappers(cmd, "allow")).toBe(cmd);
    expect(stripWrappers(cmd, "denyAsk")).toBe("rm -rf /");
  });

  test("consequence: an allow rule for the bare command does not match hidden behind an unsafe assignment, but denyAsk sees through it", () => {
    const rule = parseRule("Bash(rm *)");
    const c = call("Bash", { command: "FOO=$(cat /etc/hostname) rm -rf /" });
    expect(matchesRule(rule, c, { direction: "allow" })).toBe(false);
    expect(matchesRule(rule, c, { direction: "denyAsk" })).toBe(true);
  });
});

describe("stripWrappers -- fix round 1, Finding B / Ruling P2-C (dangerous assignment NAMES)", () => {
  test("a dangerous assignment NAME is not stripped on the allow side even with an innocuous-looking value", () => {
    const cmd = "LD_PRELOAD=/tmp/evil.so cat /etc/passwd";
    expect(stripWrappers(cmd, "allow")).toBe(cmd);
  });

  test("deny/ask conservatism is unaffected -- it already looks through any assignment, dangerous or not", () => {
    const cmd = "LD_PRELOAD=/tmp/evil.so cat /etc/passwd";
    expect(stripWrappers(cmd, "denyAsk")).toBe("cat /etc/passwd");
  });

  test("a benign assignment name is still stripped on the allow side", () => {
    expect(stripWrappers("FOO=bar cat x", "allow")).toBe("cat x");
  });

  test("env-name matching is case-exact -- a differently-cased name is not in the denylist", () => {
    expect(stripWrappers("ld_preload=/tmp/evil.so cat x", "allow")).toBe("cat x");
  });

  test("DANGEROUS_ASSIGNMENT_NAMES carries the pinned Ruling P2-C list", () => {
    for (const name of [
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "PATH",
      "BASH_ENV",
      "ENV",
      "IFS",
      "PERL5LIB",
      "PYTHONPATH",
      "NODE_OPTIONS",
    ]) {
      expect(DANGEROUS_ASSIGNMENT_NAMES.has(name)).toBe(true);
    }
  });
});

describe("extractRedirectTargets (WS-07 §3)", () => {
  test("extracts a simple overwrite redirect", () => {
    expect(extractRedirectTargets("echo hi > /tmp/out.txt")).toEqual(["/tmp/out.txt"]);
  });

  test("extracts an append redirect", () => {
    expect(extractRedirectTargets("echo hi >> /tmp/out.txt")).toEqual(["/tmp/out.txt"]);
  });

  test("extracts a stderr fd redirect", () => {
    expect(extractRedirectTargets("cmd 2> /tmp/err.log")).toEqual(["/tmp/err.log"]);
  });

  test("extracts a combined-stream redirect", () => {
    expect(extractRedirectTargets("cmd &> /tmp/both.log")).toEqual(["/tmp/both.log"]);
  });

  test("a descriptor duplication (2>&1) is not a file-write target", () => {
    expect(extractRedirectTargets("cmd 2>&1")).toEqual([]);
  });

  test("here-docs are excluded", () => {
    expect(extractRedirectTargets("cat <<EOF\nbody\nEOF")).toEqual([]);
  });

  test("every subcommand's redirect target is extracted, compound-safe with no pre-split needed", () => {
    expect(extractRedirectTargets("echo a > /tmp/a && echo b > /tmp/b")).toEqual(["/tmp/a", "/tmp/b"]);
  });

  test("a quoted target with an embedded space is captured whole", () => {
    expect(extractRedirectTargets('echo hi > "/tmp/has space/out.txt"')).toEqual(["/tmp/has space/out.txt"]);
  });

  test("a Bash allow for the command never authorizes its redirect target -- two independent checks", () => {
    const rule = parseRule("Bash(echo *)");
    const cmd = "echo hi > /etc/passwd";
    expect(matchesRule(rule, call("Bash", { command: cmd }), { direction: "allow" })).toBe(true);
    expect(extractRedirectTargets(cmd)).toEqual(["/etc/passwd"]);
  });
});

describe("parameter rules (WS-07 §3: 'available for deny/ask decisions')", () => {
  test("Agent(model:opus) matches literal scalar input on the denyAsk side", () => {
    const rule = parseRule("Agent(model:opus)");
    expect(matchesRule(rule, call("Agent", { model: "opus" }), { direction: "denyAsk" })).toBe(true);
    expect(matchesRule(rule, call("Agent", { model: "haiku" }), { direction: "denyAsk" })).toBe(false);
  });

  test("Bash(run_in_background:true) matches a real boolean, not the string 'true'", () => {
    const rule = parseRule("Bash(run_in_background:true)");
    expect(matchesRule(rule, call("Bash", { run_in_background: true }), { direction: "denyAsk" })).toBe(true);
    expect(matchesRule(rule, call("Bash", { run_in_background: false }), { direction: "denyAsk" })).toBe(false);
    expect(matchesRule(rule, call("Bash", { run_in_background: "true" }), { direction: "denyAsk" })).toBe(false);
  });

  test("an omitted parameter never matches, on either direction", () => {
    const rule = parseRule("Agent(model:opus)");
    expect(matchesRule(rule, call("Agent", {}), { direction: "denyAsk" })).toBe(false);
    expect(matchesRule(rule, call("Agent", {}), { direction: "allow" })).toBe(false);
  });

  test("judgment call: a param rule NEVER matches on the allow side (WS-07 §3 scopes it to deny/ask)", () => {
    const rule = parseRule("Agent(model:opus)");
    expect(matchesRule(rule, call("Agent", { model: "opus" }), { direction: "allow" })).toBe(false);
  });

  test("cosmetic rider: Bash(run_in_background:true) never matches on the allow side either -- the asymmetry pair's missing half", () => {
    const rule = parseRule("Bash(run_in_background:true)");
    expect(matchesRule(rule, call("Bash", { run_in_background: true }), { direction: "allow" })).toBe(false);
  });

  test("one field per rule: a colon inside the value is part of the value, not a second field", () => {
    const rule = parseRule("Agent(model:opus:extra)");
    expect(rule.specifier).toEqual({ kind: "param", field: "model", value: "opus:extra" });
  });
});

describe("MCP rules (WS-07 §3)", () => {
  test("a parenthetical specifier on an mcp__ tool is rejected -- parses but never matches", () => {
    const rule = parseRule("mcp__github__get_issue(foo:bar)");
    expect(rule.specifier?.kind).toBe("invalid");
    expect(matchesRule(rule, call("mcp__github__get_issue", { foo: "bar" }), { direction: "allow" })).toBe(false);
    expect(matchesRule(rule, call("mcp__github__get_issue", { foo: "bar" }), { direction: "denyAsk" })).toBe(false);
  });

  test("an exact mcp__server__tool name matches only that tool", () => {
    const rule = parseRule("mcp__github__get_issue");
    expect(matchesRule(rule, call("mcp__github__get_issue", {}), { direction: "allow" })).toBe(true);
    expect(matchesRule(rule, call("mcp__github__list_issues", {}), { direction: "allow" })).toBe(false);
  });

  test("mcp__* is a valid deny/ask glob matching any mcp tool", () => {
    const rule = parseRule("mcp__*");
    expect(matchesRule(rule, call("mcp__github__get_issue", {}), { direction: "denyAsk" })).toBe(true);
    expect(matchesRule(rule, call("mcp__anything__else", {}), { direction: "denyAsk" })).toBe(true);
  });

  test("mcp__* is REJECTED as an allow glob -- never matches on the allow side", () => {
    const rule = parseRule("mcp__*");
    expect(matchesRule(rule, call("mcp__github__get_issue", {}), { direction: "allow" })).toBe(false);
  });

  test("mcp__github__get_* is anchored with a literal server prefix -- valid on the allow side", () => {
    const rule = parseRule("mcp__github__get_*");
    expect(matchesRule(rule, call("mcp__github__get_issue", {}), { direction: "allow" })).toBe(true);
    expect(matchesRule(rule, call("mcp__github__list_issues", {}), { direction: "allow" })).toBe(false);
    expect(matchesRule(rule, call("mcp__other__get_issue", {}), { direction: "allow" })).toBe(false);
  });

  test("a glob that truncates the server segment itself is not anchored -- rejected on allow", () => {
    const rule = parseRule("mcp__gi*");
    expect(matchesRule(rule, call("mcp__github__get_issue", {}), { direction: "allow" })).toBe(false);
  });
});

describe("WebFetch domain rules (WS-07 §3)", () => {
  test("matches case-insensitively", () => {
    const rule = parseRule("WebFetch(domain:example.com)");
    expect(matchesRule(rule, call("WebFetch", { domain: "EXAMPLE.com" }), { direction: "allow" })).toBe(true);
    expect(matchesRule(rule, call("WebFetch", { domain: "example.com" }), { direction: "allow" })).toBe(true);
    expect(matchesRule(rule, call("WebFetch", { domain: "other.com" }), { direction: "allow" })).toBe(false);
  });

  test("domain:* is a wildcard glob (WS-07 §3 names this form explicitly)", () => {
    const rule = parseRule("WebFetch(domain:*.example.com)");
    expect(matchesRule(rule, call("WebFetch", { domain: "docs.example.com" }), { direction: "allow" })).toBe(true);
    expect(matchesRule(rule, call("WebFetch", { domain: "example.com" }), { direction: "allow" })).toBe(false);
  });

  test("WebFetch(*) is bare-equivalent, distinct from the domain family", () => {
    const rule = parseRule("WebFetch(*)");
    expect(rule.specifier).toEqual({ kind: "wildcardAll" });
    expect(rule.isBareEquivalent).toBe(true);
  });

  test("works on the denyAsk side too (unlike generic param rules, domain is its own native family)", () => {
    const rule = parseRule("WebFetch(domain:example.com)");
    expect(matchesRule(rule, call("WebFetch", { domain: "example.com" }), { direction: "denyAsk" })).toBe(true);
  });
});

describe("isRecognizedReadOnly (WS-07 §3, brief's minimum list)", () => {
  test("the minimum list is recognized", () => {
    for (const cmd of [
      "ls",
      "cat file.txt",
      "head file.txt",
      "tail file.txt",
      "grep foo file.txt",
      "rg foo",
      "find .",
      "pwd",
      "echo hi",
    ]) {
      expect(isRecognizedReadOnly(cmd)).toBe(true);
    }
  });

  test("git status/log/diff are recognized; git push/commit are not", () => {
    expect(isRecognizedReadOnly("git status")).toBe(true);
    expect(isRecognizedReadOnly("git log")).toBe(true);
    expect(isRecognizedReadOnly("git diff")).toBe(true);
    expect(isRecognizedReadOnly("git push")).toBe(false);
    expect(isRecognizedReadOnly("git commit -m x")).toBe(false);
  });

  test("write-capable flags fall out of read-only: find -delete", () => {
    expect(isRecognizedReadOnly("find . -delete")).toBe(false);
  });

  test("a redirect disqualifies an otherwise read-only command", () => {
    expect(isRecognizedReadOnly("echo hi > /etc/passwd")).toBe(false);
    expect(isRecognizedReadOnly("git log > /tmp/out")).toBe(false);
  });

  test("an unrecognized command is not read-only", () => {
    expect(isRecognizedReadOnly("rm -rf /tmp/x")).toBe(false);
    expect(isRecognizedReadOnly("curl https://example.com")).toBe(false);
  });

  test("wrapper-stripping applies before recognition", () => {
    expect(isRecognizedReadOnly("timeout 5 ls -la")).toBe(true);
  });

  test("READ_ONLY_COMMANDS is exported so P3's tool work can extend it", () => {
    expect(READ_ONLY_COMMANDS.has("ls")).toBe(true);
    expect(READ_ONLY_COMMANDS.has("cat")).toBe(true);
  });
});

describe("isRecognizedReadOnly -- fix round 1 (Findings A + B)", () => {
  test("Finding A: an unparseable command (unterminated quote) with a recognized-looking prefix is not treated as read-only", () => {
    expect(isRecognizedReadOnly("cat 'foo && rm -rf /")).toBe(false);
  });

  test("Finding A: an over-limit command is not treated as read-only", () => {
    const huge = "cat " + "a".repeat(PARSE_LIMIT + 1);
    expect(isRecognizedReadOnly(huge)).toBe(false);
  });

  test("Finding B: a command hidden behind a dangerous assignment name is not recognized as read-only", () => {
    expect(isRecognizedReadOnly("LD_PRELOAD=/tmp/evil.so cat /etc/passwd")).toBe(false);
  });
});

// P2 fix-wave item 2 (Finding C / "O(n^2) worst case in stripWrappers/stripLeadingAssignments/
// extractRedirectTargets", refused at the trivial-bar during T3's own round): regression coverage
// for the threading fix (leadingWordAt/stripLeadingAssignmentsAt, grammar.ts). Each fixture below
// sizes its adversarial input so the PRE-FIX rescan-per-word shape (O(n) re-scans, each O(remaining
// length)) would take many seconds; the threaded O(n) implementation completes in well under a
// second even on a loaded CI runner. A generous 2s bound (not a tight micro-benchmark) is
// deliberate -- this is a regression tripwire against reintroducing the quadratic shape, not a
// performance SLO.
describe("P2 fix-wave item 2: the threading fix is linear, not quadratic, in adversarial inputs", () => {
  test("many chained single-char flags after a fixed wrapper (stripWrappers' own inner flag loop)", () => {
    // `timeout` also consumes exactly one trailing positional (its own duration argument, per
    // WRAPPERS_WITH_POSITIONAL_ARG) AFTER the flag loop -- the literal "30" here plays that role,
    // mirroring the established "timeout 30 ls -la" -> "ls -la" fixture above, just with many flags
    // prepended so this test actually exercises the inner flag-stripping loop's own iteration count.
    const manyFlags = Array.from({ length: 20_000 }, (_, i) => `-${i % 10}`).join(" ");
    const cmd = `timeout ${manyFlags} 30 realcmd`;
    const start = performance.now();
    const result = stripWrappers(cmd, "allow");
    const elapsedMs = performance.now() - start;
    expect(result).toBe("realcmd");
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("many chained xargs wrappers (stripWrappers' own outer loop, each iteration re-deriving afterAssignments pre-fix)", () => {
    const cmd = "xargs ".repeat(20_000) + "realcmd";
    const start = performance.now();
    const result = stripWrappers(cmd, "allow");
    const elapsedMs = performance.now() - start;
    expect(result).toBe("realcmd");
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("many chained leading assignments (stripLeadingAssignmentsAt's own loop)", () => {
    const manyAssignments = Array.from({ length: 20_000 }, (_, i) => `V${i}=x`).join(" ");
    const cmd = `${manyAssignments} realcmd`;
    const start = performance.now();
    const result = stripWrappers(cmd, "allow");
    const elapsedMs = performance.now() - start;
    expect(result).toBe("realcmd");
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("many chained redirects (extractRedirectTargets' own loop)", () => {
    const cmd = Array.from({ length: 20_000 }, (_, i) => `a${i}>f${i}`).join(" ");
    const start = performance.now();
    const targets = extractRedirectTargets(cmd);
    const elapsedMs = performance.now() - start;
    expect(targets).toHaveLength(20_000);
    expect(targets[0]).toBe("f0");
    expect(targets[19_999]).toBe("f19999");
    expect(elapsedMs).toBeLessThan(2000);
  });

  // Behavior-preservation spot checks alongside the perf regressions above -- the threading change
  // must never alter WHAT is stripped/extracted, only how fast.
  test("behavior is byte-identical to the pre-threading implementation on ordinary, non-adversarial inputs", () => {
    expect(stripWrappers("timeout 30 ls -la", "allow")).toBe("ls -la");
    expect(stripWrappers("FOO=bar BAZ=qux ls", "allow")).toBe("ls");
    expect(stripWrappers("xargs -0 rm", "allow")).toBe("xargs -0 rm"); // not flag-free -- stops stripping
    expect(stripWrappers("xargs rm -rf", "allow")).toBe("rm -rf");
    expect(extractRedirectTargets("echo hi > out.txt 2>> err.log")).toEqual(["out.txt", "err.log"]);
  });
});
