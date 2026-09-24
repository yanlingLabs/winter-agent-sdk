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
  webFetchHostnameOf,
  webFetchUrlOf,
  isExactWebFetchDomainRule,
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

  // Item 4 (P2 fix-wave): the MOST confusable colon shape -- "x:*" simultaneously resembles BOTH
  // the generic FIELD_VALUE param grammar (field "x", value "*") AND Bash's own ":*"
  // trailing-wildcard sugar (Bash(ls:*) === Bash(ls *), tested below in the Bash describe block).
  // For a FILE_RULE_TOOLS tool, NEITHER reading applies -- the whole string is a literal file
  // pattern, verbatim, with no sugar/param semantics of its own. Distinct regression coverage from
  // the Read(a:b/**) fixture above: that pattern's post-colon text ("b/**") is unambiguously
  // path-shaped; "x:*"'s post-colon text ("*") is exactly the shape two OTHER dispatch families
  // would each claim for themselves.
  test("Read(x:*) parses as a pattern specifier with the literal string 'x:*' intact -- neither a param rule (field 'x') nor Bash's own trailing-wildcard sugar", () => {
    const rule = parseRule("Read(x:*)");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "x:*" });
    expect(rule.isBareEquivalent).toBe(false);
  });

  test("Edit(x:*) — the identical shape on Edit, the other FILE_RULE_TOOLS member", () => {
    const rule = parseRule("Edit(x:*)");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "x:*" });
  });

  test("Read(x:*) dispatches through matchesRuleForCall's FILE_RULE_TOOLS branch (paths.ts), never matchesRule's own generic 'pattern' case -- a Read call has no call.input.command for that branch to (wrongly) read", () => {
    // matchesRule's generic "pattern" case reads call.input.command (Bash-shaped) -- a Read call
    // has no such field, so if Read(x:*) were EVER routed through matchesRule's own pattern
    // handling instead of paths.ts's matchFileRule, it would silently fail closed (never match) on
    // the allow side regardless of the actual file_path. This proves the OPPOSITE: matchesRule
    // alone (bypassing the evaluator's own FILE_RULE_TOOLS dispatch) indeed fails closed here --
    // documenting exactly why evaluator.ts's matchesRuleForCall must never fall through to plain
    // matchesRule for this specifier kind (see that function's own header).
    const rule = parseRule("Read(x:*)");
    expect(matchesRule(rule, call("Read", { file_path: "x:*" }), { direction: "allow" })).toBe(false);
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

// Fix round 8 (a rule-content parity item found by the integration run on both real binaries):
// claude's `Tool(content)` parse step (dump-confirmed, byte offset ~11910950 of the pinned 2.1.250
// dump; the function itself is `jr`) finds the specifier boundary with an ESCAPE-AWARE search --
// the first UNESCAPED "(" and the last UNESCAPED ")" (an occurrence is escaped when it is preceded
// by an ODD run of backslashes, `jr`'s own helpers `l`/`u`) -- and then unescapes the captured
// content with THREE SEQUENTIAL passes (`jr`'s own `a`, byte offset ~11910950): `\(` -> `(`, then
// `\)` -> `)`, then `\\` -> `\`, in that exact order. This runs ONCE, before ANY specifier-family
// parsing (FILE_RULE_TOOLS/Bash/param/etc. below all see the ALREADY-UNESCAPED content). The write
// side (`Fr`/`c`, the same dump region) is the exact inverse: `c(e)` escapes `\` -> `\\` FIRST, then
// `(` -> `\(`, then `)` -> `\)` -- so a rule persisted BY claude for a path containing a literal
// backslash or literal parens is written pre-escaped this way, and Winter must parse it back the
// same way or silently fail to match a rule claude itself wrote (a shared-home, cross-leg fixture
// class, not a hypothetical one).
//
// Before this fix, `parseRule` extracted the specifier boundary with a plain greedy regex
// (`/^([^\s(]+)\((.*)\)$/s`) and performed NO unescaping at all -- so it required only ONE literal
// backslash character to match one in the real path (claude's own two-layer pipeline requires TWO,
// since its OWN parse-side unescape consumes one layer before the file-rule matcher's OWN,
// separately-ported, gitignore-style escape grammar ever sees the content) and misread an escaped
// `\)` mid-content as ordinary text rather than a literal `)`.
describe("parseRule -- fix round 8, claude's Tool(content) escape-aware extraction and unescape", () => {
  test("an UNESCAPED literal paren pair in the content is left exactly as authored (the common case: a real directory named 'Project (old)') -- unchanged from before this fix", () => {
    const rule = parseRule("Read(/repo/Project (old)/**)");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "/repo/Project (old)/**" });
  });

  test("an escaped paren pair, \\( and \\), unescapes to a literal ( and ) in the content -- claude's OWN serializer writes literal parens exactly this way", () => {
    const rule = parseRule("Read(/repo/Project \\(old\\)/**)");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "/repo/Project (old)/**" });
  });

  test("an escaped closing paren MID-CONTENT does not end the rule early -- the true terminator is the LAST unescaped ')'", () => {
    const rule = parseRule("Read(foo\\)bar/**)");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "foo)bar/**" });
  });

  test("a DOUBLE backslash in the authored content unescapes to a single literal backslash -- matching one literal backslash in the real path, not two", () => {
    const rule = parseRule("Read(C:\\\\Users\\\\x)");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "C:\\Users\\x" });
  });

  test("a backslash and parens together, exactly as claude's own serializer (c(e): backslash first, then parens) would write a path containing both", () => {
    // The real path is `C:\Projects\Old (v1)\file`. claude's Fr/c serializes it backslash-first
    // then parens: every "\" becomes "\\", then every "(" becomes "\(" and ")" becomes "\)".
    const rule = parseRule("Read(C:\\\\Projects\\\\Old \\(v1\\)\\\\file)");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "C:\\Projects\\Old (v1)\\file" });
  });

  test("this is the SAME extraction+unescape step for every specifier family, not just file-rule tools -- Bash content unescapes identically", () => {
    const rule = parseRule("Bash(echo foo\\(bar\\))");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "echo foo(bar)" });
  });

  test("empty content, Tool(), IS bare-equivalent -- fix round 9 supersedes round 8's disclosed non-port: full Tool() parity, including WebSearch() and mcp__s__x() (see the WebSearch and mcp__ describe blocks)", () => {
    const rule = parseRule("Bash()");
    expect(rule.specifier).toEqual({ kind: "wildcardAll" });
    expect(rule.isBareEquivalent).toBe(true);
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
  // EVERY call below is a real `{url, prompt}` shape. These rows used to hand-build `{domain}` -- a
  // field no WebFetch call carries -- which is how a matcher that was dead in production stayed green.
  const fetchCall = (url: unknown) => call("WebFetch", { url, prompt: "summarise this page" });

  test("the domain is DERIVED from input.url -- allow, and denyAsk, against a real call shape", () => {
    const rule = parseRule("WebFetch(domain:example.com)");
    expect(matchesRule(rule, fetchCall("https://example.com/a/b?c=d#e"), { direction: "allow" })).toBe(true);
    expect(matchesRule(rule, fetchCall("https://example.com/a/b?c=d#e"), { direction: "denyAsk" })).toBe(true);
    expect(matchesRule(rule, fetchCall("http://example.com:8080/"), { direction: "denyAsk" })).toBe(true); // scheme and port are not part of the domain
    expect(matchesRule(rule, fetchCall("https://user:pw@example.com/"), { direction: "denyAsk" })).toBe(true); // nor is userinfo
    expect(matchesRule(rule, fetchCall("https://other.com/"), { direction: "allow" })).toBe(false);
  });

  test("a hand-built `domain` field is NOT a match source -- it cannot vouch for a url that goes elsewhere", () => {
    const rule = parseRule("WebFetch(domain:example.com)");
    expect(matchesRule(rule, call("WebFetch", { domain: "example.com" }), { direction: "allow" })).toBe(false);
    expect(matchesRule(rule, call("WebFetch", { url: "https://evil.example/", domain: "example.com" }), { direction: "allow" })).toBe(false);
  });

  test("case: the rule and the url are both lowercased", () => {
    expect(matchesRule(parseRule("WebFetch(domain:Example.COM)"), fetchCall("https://EXAMPLE.com/"), { direction: "denyAsk" })).toBe(true);
    expect(matchesRule(parseRule("WebFetch(domain:example.com)"), fetchCall("HTTPS://ExAmPlE.CoM/Path"), { direction: "allow" })).toBe(true);
  });

  test("EXACT host: a rule for the apex does not cover a subdomain, nor a lookalike suffix or prefix", () => {
    const rule = parseRule("WebFetch(domain:example.com)");
    for (const direction of ["allow", "denyAsk"] as const) {
      expect(matchesRule(rule, fetchCall("https://docs.example.com/"), { direction })).toBe(false);
      expect(matchesRule(rule, fetchCall("https://www.example.com/"), { direction })).toBe(false);
      expect(matchesRule(rule, fetchCall("https://example.com.evil.test/"), { direction })).toBe(false);
      expect(matchesRule(rule, fetchCall("https://notexample.com/"), { direction })).toBe(false);
      expect(matchesRule(rule, fetchCall("https://exampleXcom/"), { direction })).toBe(false); // the rule's `.` is a literal dot
    }
  });

  test("domain:* is a wildcard glob (WS-07 §3 names this form explicitly) -- subdomains are opt-in, and the glob does not cover the apex", () => {
    const rule = parseRule("WebFetch(domain:*.example.com)");
    expect(matchesRule(rule, fetchCall("https://docs.example.com/x"), { direction: "allow" })).toBe(true);
    expect(matchesRule(rule, fetchCall("https://a.b.example.com/x"), { direction: "allow" })).toBe(true);
    expect(matchesRule(rule, fetchCall("https://example.com/x"), { direction: "allow" })).toBe(false);
    expect(matchesRule(parseRule("WebFetch(domain:*)"), fetchCall("https://anything.test/"), { direction: "allow" })).toBe(true);
  });

  test("an unparseable, absent or non-string url matches NO domain rule -- and never throws", () => {
    for (const source of ["WebFetch(domain:example.com)", "WebFetch(domain:*)"]) {
      const rule = parseRule(source);
      for (const bad of ["not a url", "example.com", "", "https://", "http://[::1", undefined, null, 42, { href: "https://example.com/" }]) {
        for (const direction of ["allow", "denyAsk"] as const) {
          expect(matchesRule(rule, fetchCall(bad), { direction })).toBe(false);
        }
      }
      expect(matchesRule(rule, call("WebFetch", {}), { direction: "allow" })).toBe(false);
    }
  });

  test("a url with an EMPTY host is not 'any website' -- domain:* must not pre-approve it", () => {
    const rule = parseRule("WebFetch(domain:*)");
    expect(matchesRule(rule, fetchCall("file:///etc/passwd"), { direction: "allow" })).toBe(false);
    expect(matchesRule(rule, fetchCall("data:text/plain,hi"), { direction: "allow" })).toBe(false);
  });

  test("a trailing root dot names the same host on either side -- it cannot walk past a deny", () => {
    expect(matchesRule(parseRule("WebFetch(domain:example.com)"), fetchCall("https://example.com./"), { direction: "denyAsk" })).toBe(true);
    expect(matchesRule(parseRule("WebFetch(domain:example.com.)"), fetchCall("https://example.com/"), { direction: "denyAsk" })).toBe(true);
  });

  test("the rule's host is canonicalised the way the url parser canonicalises the call's (IDN, IPv4 shorthand, IPv6)", () => {
    expect(matchesRule(parseRule("WebFetch(domain:münchen.de)"), fetchCall("https://münchen.de/"), { direction: "denyAsk" })).toBe(true);
    expect(matchesRule(parseRule("WebFetch(domain:münchen.de)"), fetchCall("https://xn--mnchen-3ya.de/"), { direction: "denyAsk" })).toBe(true);
    expect(matchesRule(parseRule("WebFetch(domain:127.0.0.1)"), fetchCall("http://127.1/"), { direction: "denyAsk" })).toBe(true);
    expect(matchesRule(parseRule("WebFetch(domain:127.0.0.1)"), fetchCall("http://0x7f000001/"), { direction: "denyAsk" })).toBe(true);
    expect(matchesRule(parseRule("WebFetch(domain:[::1])"), fetchCall("http://[::1]:3000/"), { direction: "allow" })).toBe(true);
    expect(matchesRule(parseRule("WebFetch(domain:[::1])"), fetchCall("http://[::2]:3000/"), { direction: "allow" })).toBe(false);
  });

  test("a source that is more than a host is left as written and matches nothing -- never quietly widened to the whole host", () => {
    // `:80` is the trap: it is http's DEFAULT port, which the url parser drops without a trace.
    for (const source of ["WebFetch(domain:example.com/docs)", "WebFetch(domain:example.com:8080)", "WebFetch(domain:example.com:80)", "WebFetch(domain:[::1]:80)", "WebFetch(domain:https://example.com)"]) {
      const rule = parseRule(source);
      expect(rule.specifier?.kind).toBe("webFetchDomain");
      expect(matchesRule(rule, fetchCall("https://example.com/docs"), { direction: "allow" })).toBe(false);
      expect(matchesRule(rule, fetchCall("https://example.com:8080/docs"), { direction: "allow" })).toBe(false);
      expect(matchesRule(rule, fetchCall("http://example.com:80/"), { direction: "allow" })).toBe(false);
      expect(matchesRule(rule, fetchCall("http://[::1]:80/"), { direction: "allow" })).toBe(false);
    }
  });

  test("webFetchHostnameOf / webFetchUrlOf: one parse for every consumer, never a throw", () => {
    expect(webFetchHostnameOf({ url: "https://Docs.Example.com./x" })).toBe("docs.example.com");
    expect(webFetchHostnameOf({ url: "nope" })).toBeUndefined();
    expect(webFetchHostnameOf({ url: "file:///x" })).toBeUndefined();
    expect(webFetchHostnameOf({})).toBeUndefined();
    expect(webFetchUrlOf({ url: "https://example.com/p" })?.pathname).toBe("/p");
    expect(webFetchUrlOf({ url: 7 })).toBeUndefined();
  });

  test("isExactWebFetchDomainRule: a glob matches a host without ever NAMING it", () => {
    expect(isExactWebFetchDomainRule(parseRule("WebFetch(domain:192.168.1.10)"), "192.168.1.10")).toBe(true);
    expect(isExactWebFetchDomainRule(parseRule("WebFetch(domain:192.168.1.*)"), "192.168.1.10")).toBe(false);
    expect(isExactWebFetchDomainRule(parseRule("WebFetch(domain:*)"), "192.168.1.10")).toBe(false);
    expect(isExactWebFetchDomainRule(parseRule("WebFetch(*)"), "192.168.1.10")).toBe(false);
    expect(isExactWebFetchDomainRule(parseRule("WebFetch"), "192.168.1.10")).toBe(false);
    expect(isExactWebFetchDomainRule(parseRule("WebFetch(domain:192.168.1.11)"), "192.168.1.10")).toBe(false);
  });

  test("WebFetch(*) is bare-equivalent, distinct from the domain family", () => {
    const rule = parseRule("WebFetch(*)");
    expect(rule.specifier).toEqual({ kind: "wildcardAll" });
    expect(rule.isBareEquivalent).toBe(true);
    expect(matchesRule(rule, fetchCall("not a url"), { direction: "denyAsk" })).toBe(true); // a bare rule is about the TOOL, url or no url
  });
});

describe("WebSearch rules -- bare name only", () => {
  const searchCall = call("WebSearch", { query: "bun test runner", allowed_domains: ["bun.sh"] });

  test("a bare WebSearch rule (and WebSearch(*), and WebSearch() -- fix round 9, full Tool() parity) matches a real call on both directions", () => {
    for (const source of ["WebSearch", "WebSearch(*)", "WebSearch()"]) {
      const rule = parseRule(source);
      expect(rule.isBareEquivalent).toBe(true);
      expect(matchesRule(rule, searchCall, { direction: "allow" })).toBe(true);
      expect(matchesRule(rule, searchCall, { direction: "denyAsk" })).toBe(true);
      expect(matchesRule(rule, call("WebFetch", { url: "https://bun.sh/" }), { direction: "denyAsk" })).toBe(false);
    }
  });

  test("a SCOPED WebSearch rule is `invalid` -- whatever its content looks like -- and never matches", () => {
    for (const source of ["WebSearch(query:bun test runner)", "WebSearch(bun test runner)", "WebSearch(domain:bun.sh)", "WebSearch(bun*)"]) {
      const rule = parseRule(source);
      expect(rule.specifier?.kind).toBe("invalid");
      expect(rule.isBareEquivalent).toBe(false);
      expect(matchesRule(rule, searchCall, { direction: "allow" })).toBe(false);
      expect(matchesRule(rule, searchCall, { direction: "denyAsk" })).toBe(false);
    }
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

describe("read-only recognition refuses the find/rg/git forms that write or run a command", () => {
  for (const command of ["find . -exec touch /tmp/x \;", "find . -execdir rm {} +", "find . -ok rm {} \;", "find . -okdir rm {} \;", "find . -fprint out.txt", "find . -fprint0 out", "find . -fprintf out %p", "find . -fls out", "find . \"$X-exec\" touch f \;", "rg --pre 'sh -c id' x", "rg --pre=cat x", "rg . \"$Z--pre=bash\" FILE", "git diff --output=.git/hooks/pre-commit", "git log --output out.txt"]) {
    test(JSON.stringify(command), () => expect(isRecognizedReadOnly(command)).toBe(false));
  }
  for (const command of ["find . -name '*.ts'", "rg TODO src", "git diff HEAD~1", "git log --oneline", "grep -r x ."]) {
    test(`control: ${JSON.stringify(command)} stays read-only`, () => expect(isRecognizedReadOnly(command)).toBe(true));
  }
});
