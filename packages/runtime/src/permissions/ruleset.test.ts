// Task 5 (WS-07 §3.2/§3.3): sourced rule store fixture corpus — precedence, PermissionUpdate
// application + authority validation, trust gating, and the permission journal. Every describe
// block cites the WS-07 clause or phase ruling it pins, mirroring grammar.test.ts/paths.test.ts's
// per-clause convention (Tasks 3/4).
//
// Fixture privacy (name-guard): every real-fs fixture below is a fresh mkdtemp root; no real
// usernames or personal paths appear anywhere in this file.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptyRuleSet,
  sourceRule,
  applyPermissionUpdate,
  resolveRules,
  effectiveDirectories,
  buildSdkSourcedEntries,
  appendPermissionJournal,
  PermissionRuleValidationError,
  PermissionUpdateAuthorityError,
  type SourcedRuleSet,
  type SourcedRuleEntry,
} from "./ruleset.ts";
import { MAX_DOUBLE_STARS } from "./paths.ts";
import type { PermissionUpdate, PermissionRuleValue } from "@yanlinglabs/winter-agent-sdk";

function call(toolName: string, input: Record<string, unknown> = {}) {
  return { toolName, input };
}

function rv(toolName: string, ruleContent?: string): PermissionRuleValue {
  return ruleContent !== undefined ? { toolName, ruleContent } : { toolName };
}

function seed(entries: SourcedRuleEntry[], directories: SourcedRuleSet["directories"] = []): SourcedRuleSet {
  return { entries, directories };
}

function freshHome(): string {
  // Real fs, realpath'd immediately (paths.test.ts's own precedent) — on macOS $TMPDIR resolves
  // through a symlink, and byte-comparing an un-realpath'd mkdtemp path against a later readback
  // would silently disagree.
  return realpathSync(mkdtempSync(join(tmpdir(), "winter-permissions-journal-")));
}

function journalPath(winterHome: string, projectKey: string, sessionId: string): string {
  return join(winterHome, "projects", projectKey, `${sessionId}.permission-journal.jsonl`);
}

function readJournalLines(winterHome: string, projectKey: string, sessionId: string): unknown[] {
  const raw = readFileSync(journalPath(winterHome, projectKey, sessionId), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------------------------
// sourceRule — the shared construct-and-validate primitive (P5's future file-loader seam, per
// phase ruling 1: "P2 rule sources are injected, source-tagged inputs")
// ---------------------------------------------------------------------------------------------

describe("sourceRule: constructs a SourcedRuleEntry, running add-time validation", () => {
  test("a well-formed rule parses and carries the given behavior/source", () => {
    const entry = sourceRule(rv("Bash", "ls *"), "allow", "user");
    expect(entry.rule.toolName).toBe("Bash");
    expect(entry.behavior).toBe("allow");
    expect(entry.source).toBe("user");
    expect(entry.ruleValue).toEqual(rv("Bash", "ls *"));
  });

  test("a bare tool name is bare-equivalent, matching grammar.ts's own ParsedRule flag", () => {
    const entry = sourceRule(rv("Bash"), "deny", "sdk");
    expect(entry.rule.isBareEquivalent).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Add-time validation carries: (a) T3's `specifier.kind === "invalid"` carry + the unanchored MCP
// allow-glob rejection (WS-07 §3); (b) Ruling P2-E's Read/Edit glob-depth cap. Both are enforced
// through sourceRule, so this single describe block covers every caller (applyPermissionUpdate's
// addRules/replaceRules AND buildSdkSourcedEntries all route through it).
// ---------------------------------------------------------------------------------------------

describe("add-time validation carry (a): MCP parenthetical rules are rejected, not silently inert", () => {
  test("an MCP tool with ANY parenthetical specifier throws PermissionRuleValidationError", () => {
    expect(() => sourceRule(rv("mcp__x__y", "param:1"), "deny", "user")).toThrow(PermissionRuleValidationError);
  });

  test("the thrown error names the offending rule", () => {
    try {
      sourceRule(rv("mcp__x__y", "param:1"), "deny", "user");
      throw new Error("expected sourceRule to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionRuleValidationError);
      const e = err as PermissionRuleValidationError;
      expect(e.rule).toEqual(rv("mcp__x__y", "param:1"));
      expect(e.behavior).toBe("deny");
    }
  });

  test("a bare (non-parenthetical) MCP tool name is fine on any behavior", () => {
    expect(() => sourceRule(rv("mcp__github__get_issue"), "allow", "user")).not.toThrow();
  });
});

describe("add-time validation carry (a): unanchored MCP allow-side globs are rejected (WS-07 §3: 'mcp__* allow REJECTED')", () => {
  test("an unanchored allow-side glob (mcp__*) throws", () => {
    expect(() => sourceRule(rv("mcp__*"), "allow", "user")).toThrow(PermissionRuleValidationError);
  });

  test("an anchored allow-side glob with a literal server prefix (mcp__github__get_*) is legal", () => {
    expect(() => sourceRule(rv("mcp__github__get_*"), "allow", "user")).not.toThrow();
  });

  test("mcp__* is legal on the deny side (WS-07 §3: deny/ask may use full-name globs)", () => {
    expect(() => sourceRule(rv("mcp__*"), "deny", "user")).not.toThrow();
  });

  test("mcp__* is legal on the ask side", () => {
    expect(() => sourceRule(rv("mcp__*"), "ask", "user")).not.toThrow();
  });
});

describe("add-time validation carry (b), Ruling P2-E: Read/Edit rules over the glob-depth cap are rejected", () => {
  function overCapPattern(): string {
    return Array.from({ length: MAX_DOUBLE_STARS + 1 }, () => "**").join("/a/");
  }

  test("a Read rule whose pattern exceeds MAX_DOUBLE_STARS throws PermissionRuleValidationError", () => {
    expect(() => sourceRule(rv("Read", overCapPattern()), "deny", "project")).toThrow(PermissionRuleValidationError);
  });

  test("an Edit rule whose pattern exceeds MAX_DOUBLE_STARS throws", () => {
    expect(() => sourceRule(rv("Edit", overCapPattern()), "allow", "user")).toThrow(PermissionRuleValidationError);
  });

  test("the thrown error names the offending rule", () => {
    const pattern = overCapPattern();
    try {
      sourceRule(rv("Read", pattern), "deny", "project");
      throw new Error("expected sourceRule to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionRuleValidationError);
      expect((err as PermissionRuleValidationError).rule).toEqual(rv("Read", pattern));
    }
  });

  test("a Read/Edit pattern AT exactly the cap is accepted", () => {
    const pattern = Array.from({ length: MAX_DOUBLE_STARS }, () => "**").join("/a/");
    expect(() => sourceRule(rv("Read", pattern), "allow", "user")).not.toThrow();
  });

  test("an ordinary in-cap Read glob is accepted", () => {
    expect(() => sourceRule(rv("Read", "build/**"), "allow", "user")).not.toThrow();
  });

  test("the cap check runs on the RAW ruleContent regardless of how grammar.ts classifies it (e.g. a colon makes it parse as a 'param' specifier, not 'pattern')", () => {
    // "a:x/**/**/.../**" contains a literal ":" so grammar.ts's generic FIELD_VALUE dispatch
    // classifies it as a `param` specifier (field "a", value "x/**/**/...") rather than `pattern` --
    // the cap check must still fire because it is keyed on toolName===Read/Edit + the raw
    // ruleContent string, never on parsed.specifier.kind (see grammar.ts's own generic-params-
    // dispatch comment). The literal "x" segment between "a:" and the first "**" is deliberate: it
    // keeps the "a:" prefix from fusing with a "**" token when exceedsDoubleStarCap does its own
    // "/"-split, which would otherwise undercount by one and defeat the very thing this fixture is
    // trying to prove.
    const pattern = `a:x/${overCapPattern()}`;
    expect(() => sourceRule(rv("Read", pattern), "deny", "project")).toThrow(PermissionRuleValidationError);
  });

  test("a bare Read/Edit rule (no ruleContent) is never subject to the cap -- out of scope by construction", () => {
    expect(() => sourceRule(rv("Read"), "deny", "managed")).not.toThrow();
  });

  test("the cap does not apply to non-Read/Edit tools even with many '**' segments (Bash's own pattern grammar is unrelated)", () => {
    expect(() => sourceRule(rv("Bash", overCapPattern()), "allow", "user")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// applyPermissionUpdate — the six variants each mutate correctly (Step 1). Pure: never mutates the
// input SourcedRuleSet.
// ---------------------------------------------------------------------------------------------

describe("applyPermissionUpdate: addRules", () => {
  test("adds new entries tagged with the destination-derived source", () => {
    const set = emptyRuleSet();
    const update: PermissionUpdate = { type: "addRules", rules: [rv("Bash", "ls *")], behavior: "allow", destination: "userSettings" };
    const next = applyPermissionUpdate(set, update, { authority: "session" });
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]!.source).toBe("user");
    expect(next.entries[0]!.behavior).toBe("allow");
    expect(next.entries[0]!.rule.toolName).toBe("Bash");
  });

  test("does not mutate the input set", () => {
    const set = emptyRuleSet();
    const update: PermissionUpdate = { type: "addRules", rules: [rv("Bash", "ls *")], behavior: "allow", destination: "session" };
    applyPermissionUpdate(set, update, { authority: "session" });
    expect(set.entries).toHaveLength(0);
  });

  test("different destinations produce different sources: projectSettings -> project, localSettings -> local, session -> session", () => {
    let set = emptyRuleSet();
    set = applyPermissionUpdate(set, { type: "addRules", rules: [rv("Read", "a/**")], behavior: "deny", destination: "projectSettings" }, { authority: "session" });
    set = applyPermissionUpdate(set, { type: "addRules", rules: [rv("Edit", "b/**")], behavior: "deny", destination: "localSettings" }, { authority: "session" });
    set = applyPermissionUpdate(set, { type: "addRules", rules: [rv("WebFetch", "domain:x.com")], behavior: "ask", destination: "session" }, { authority: "session" });
    expect(set.entries.map((e) => e.source).sort()).toEqual(["local", "project", "session"]);
  });

  test("an invalid rule throws and is never added", () => {
    const set = emptyRuleSet();
    const update: PermissionUpdate = { type: "addRules", rules: [rv("mcp__x", "p:1")], behavior: "deny", destination: "session" };
    expect(() => applyPermissionUpdate(set, update, { authority: "session" })).toThrow(PermissionRuleValidationError);
  });
});

describe("applyPermissionUpdate: replaceRules", () => {
  function baseSet(): SourcedRuleSet {
    return seed([
      sourceRule(rv("Bash", "old *"), "allow", "user"),
      sourceRule(rv("Bash", "keep *"), "allow", "project"), // different source, same behavior -- must survive
      sourceRule(rv("Bash", "keep-deny *"), "deny", "user"), // different behavior, same source -- must survive
    ]);
  }

  test("replaces only entries matching the destination-derived source AND the given behavior", () => {
    const set = baseSet();
    const update: PermissionUpdate = { type: "replaceRules", rules: [rv("Bash", "new *")], behavior: "allow", destination: "userSettings" };
    const next = applyPermissionUpdate(set, update, { authority: "session" });
    // the OLD "user"+"allow" entry ("old *") is gone; the NEW one ("new *") is present -- scoped
    // strictly to source==="user" so this assertion doesn't also swallow the "project"-sourced
    // survivor below (which shares the same toolName+behavior but a DIFFERENT source).
    const userAllow = next.entries.filter((e) => e.rule.toolName === "Bash" && e.behavior === "allow" && e.source === "user");
    expect(userAllow.map((e) => e.rule.specifier)).toEqual([{ kind: "pattern", source: "new *" }]);
    // untouched: different source, and different behavior at the same source
    expect(next.entries.some((e) => e.source === "project" && e.behavior === "allow" && e.rule.specifier?.kind === "pattern" && (e.rule.specifier as { source: string }).source === "keep *")).toBe(true);
    expect(next.entries.some((e) => e.source === "user" && e.behavior === "deny")).toBe(true);
    expect(next.entries).toHaveLength(3); // keep(project,allow) + keep-deny(user,deny) + new(user,allow)
  });

  test("replaceRules can never remove a managed entry, structurally -- destination never maps to 'managed'", () => {
    const set = seed([
      sourceRule(rv("Bash", "*"), "allow", "managed"),
      sourceRule(rv("Bash", "old *"), "allow", "user"),
    ]);
    const update: PermissionUpdate = { type: "replaceRules", rules: [rv("Bash", "new *")], behavior: "allow", destination: "userSettings" };
    const next = applyPermissionUpdate(set, update, { authority: "session" });
    expect(next.entries.some((e) => e.source === "managed")).toBe(true);
  });

  test("an invalid replacement rule throws and the set is unchanged", () => {
    const set = baseSet();
    const update: PermissionUpdate = { type: "replaceRules", rules: [rv("mcp__*")], behavior: "allow", destination: "userSettings" };
    expect(() => applyPermissionUpdate(set, update, { authority: "session" })).toThrow(PermissionRuleValidationError);
  });
});

describe("applyPermissionUpdate: removeRules", () => {
  test("removes a matching rule by structural identity + behavior, regardless of its source", () => {
    const set = seed([sourceRule(rv("Bash", "rm *"), "deny", "user")]);
    const update: PermissionUpdate = { type: "removeRules", rules: [rv("Bash", "rm *")], behavior: "deny", destination: "userSettings" };
    const next = applyPermissionUpdate(set, update, { authority: "session" });
    expect(next.entries).toHaveLength(0);
  });

  test("a non-matching removal is a no-op", () => {
    const set = seed([sourceRule(rv("Bash", "rm *"), "deny", "user")]);
    const update: PermissionUpdate = { type: "removeRules", rules: [rv("Bash", "other *")], behavior: "deny", destination: "userSettings" };
    const next = applyPermissionUpdate(set, update, { authority: "session" });
    expect(next.entries).toHaveLength(1);
  });

  test("only the matching behavior category is affected", () => {
    const set = seed([sourceRule(rv("Bash", "rm *"), "deny", "user"), sourceRule(rv("Bash", "rm *"), "ask", "user")]);
    const update: PermissionUpdate = { type: "removeRules", rules: [rv("Bash", "rm *")], behavior: "deny", destination: "userSettings" };
    const next = applyPermissionUpdate(set, update, { authority: "session" });
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]!.behavior).toBe("ask");
  });
});

describe("applyPermissionUpdate: setMode", () => {
  test("sets the mode, tagged with the destination-derived source", () => {
    const set = emptyRuleSet();
    const update: PermissionUpdate = { type: "setMode", mode: "acceptEdits", destination: "session" };
    const next = applyPermissionUpdate(set, update, { authority: "session" });
    expect(next.mode).toEqual({ value: "acceptEdits", source: "session" });
  });

  test("a later setMode overwrites an earlier one", () => {
    let set = emptyRuleSet();
    set = applyPermissionUpdate(set, { type: "setMode", mode: "plan", destination: "session" }, { authority: "session" });
    set = applyPermissionUpdate(set, { type: "setMode", mode: "auto", destination: "session" }, { authority: "session" });
    expect(set.mode).toEqual({ value: "auto", source: "session" });
  });
});

describe("applyPermissionUpdate: addDirectories / removeDirectories", () => {
  test("addDirectories appends, tagged with the destination-derived source", () => {
    const set = emptyRuleSet();
    const update: PermissionUpdate = { type: "addDirectories", directories: ["/tmp/a", "/tmp/b"], destination: "projectSettings" };
    const next = applyPermissionUpdate(set, update, { authority: "session" });
    expect(next.directories).toEqual([
      { path: "/tmp/a", source: "project" },
      { path: "/tmp/b", source: "project" },
    ]);
  });

  test("removeDirectories removes by exact path match", () => {
    const set = seed([], [{ path: "/tmp/a", source: "user" }, { path: "/tmp/b", source: "user" }]);
    const update: PermissionUpdate = { type: "removeDirectories", directories: ["/tmp/a"], destination: "userSettings" };
    const next = applyPermissionUpdate(set, update, { authority: "session" });
    expect(next.directories).toEqual([{ path: "/tmp/b", source: "user" }]);
  });

  test("removeDirectories does not mutate the input set", () => {
    const set = seed([], [{ path: "/tmp/a", source: "user" }]);
    applyPermissionUpdate(set, { type: "removeDirectories", directories: ["/tmp/a"], destination: "userSettings" }, { authority: "session" });
    expect(set.directories).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Authority validation on applyPermissionUpdate
// ---------------------------------------------------------------------------------------------

describe("authority validation: cliArg is a startup-only bootstrap destination", () => {
  test("a session authority may not author a cliArg-destined update", () => {
    const set = emptyRuleSet();
    const update: PermissionUpdate = { type: "addRules", rules: [rv("Bash")], behavior: "allow", destination: "cliArg" };
    expect(() => applyPermissionUpdate(set, update, { authority: "session" })).toThrow(PermissionUpdateAuthorityError);
  });

  test("an sdk authority may not author a cliArg-destined update either", () => {
    const set = emptyRuleSet();
    const update: PermissionUpdate = { type: "addRules", rules: [rv("Bash")], behavior: "allow", destination: "cliArg" };
    expect(() => applyPermissionUpdate(set, update, { authority: "sdk" })).toThrow(PermissionUpdateAuthorityError);
  });

  test("a cliArg authority MAY author a cliArg-destined update", () => {
    const set = emptyRuleSet();
    const update: PermissionUpdate = { type: "addRules", rules: [rv("Bash")], behavior: "allow", destination: "cliArg" };
    const next = applyPermissionUpdate(set, update, { authority: "cliArg" });
    expect(next.entries[0]!.source).toBe("cliArg");
  });

  test("session authority MAY write userSettings/projectSettings/localSettings/session -- the sanctioned 'approve and remember' flow (WS-07 §3.3/§6.1)", () => {
    const set = emptyRuleSet();
    for (const destination of ["userSettings", "projectSettings", "localSettings", "session"] as const) {
      const update: PermissionUpdate = { type: "addRules", rules: [rv("Bash")], behavior: "allow", destination };
      expect(() => applyPermissionUpdate(set, update, { authority: "session" })).not.toThrow();
    }
  });
});

describe("authority validation: an unrecognized destination on a known update type is rejected, never silently accepted", () => {
  test("a forged destination string throws PermissionUpdateAuthorityError", () => {
    const set = emptyRuleSet();
    const forged = { type: "addRules", rules: [rv("Bash")], behavior: "allow", destination: "managedSettings" } as unknown as PermissionUpdate;
    expect(() => applyPermissionUpdate(set, forged, { authority: "session" })).toThrow(PermissionUpdateAuthorityError);
  });
});

describe("authority validation: managed rules are unweakenable — 'session→managed rejected' (WS-07 §3.2/§3.3)", () => {
  test("removeRules: a session authority cannot remove a rule that currently resolves to source:managed", () => {
    const set = seed([sourceRule(rv("Bash", "rm -rf /"), "deny", "managed")]);
    const update: PermissionUpdate = { type: "removeRules", rules: [rv("Bash", "rm -rf /")], behavior: "deny", destination: "session" };
    expect(() => applyPermissionUpdate(set, update, { authority: "session" })).toThrow(PermissionUpdateAuthorityError);
    // never a silent drop: the entry survives the attempt.
    let survived = false;
    try {
      applyPermissionUpdate(set, update, { authority: "session" });
    } catch {
      survived = set.entries.some((e) => e.source === "managed");
    }
    expect(survived).toBe(true);
  });

  test("removeRules: an sdk authority is equally rejected", () => {
    const set = seed([sourceRule(rv("Bash", "rm -rf /"), "deny", "managed")]);
    const update: PermissionUpdate = { type: "removeRules", rules: [rv("Bash", "rm -rf /")], behavior: "deny", destination: "session" };
    expect(() => applyPermissionUpdate(set, update, { authority: "sdk" })).toThrow(PermissionUpdateAuthorityError);
  });

  test("removeRules: a managed authority MAY remove a managed-sourced rule", () => {
    const set = seed([sourceRule(rv("Bash", "rm -rf /"), "deny", "managed")]);
    const update: PermissionUpdate = { type: "removeRules", rules: [rv("Bash", "rm -rf /")], behavior: "deny", destination: "session" };
    const next = applyPermissionUpdate(set, update, { authority: "managed" });
    expect(next.entries).toHaveLength(0);
  });

  test("removeRules: removing a NON-managed rule by a session authority is unaffected by this guard", () => {
    const set = seed([sourceRule(rv("Bash", "rm -rf /"), "deny", "user")]);
    const update: PermissionUpdate = { type: "removeRules", rules: [rv("Bash", "rm -rf /")], behavior: "deny", destination: "session" };
    const next = applyPermissionUpdate(set, update, { authority: "session" });
    expect(next.entries).toHaveLength(0);
  });

  test("removeDirectories: a session authority cannot remove a managed-sourced directory grant (symmetry with removeRules)", () => {
    const set = seed([], [{ path: "/etc", source: "managed" }]);
    const update: PermissionUpdate = { type: "removeDirectories", directories: ["/etc"], destination: "session" };
    expect(() => applyPermissionUpdate(set, update, { authority: "session" })).toThrow(PermissionUpdateAuthorityError);
  });

  test("removeDirectories: a managed authority MAY remove a managed-sourced directory grant", () => {
    const set = seed([], [{ path: "/etc", source: "managed" }]);
    const update: PermissionUpdate = { type: "removeDirectories", directories: ["/etc"], destination: "session" };
    const next = applyPermissionUpdate(set, update, { authority: "managed" });
    expect(next.directories).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Unknown future PermissionUpdate variants: lossless round-trip, inert in the live set (WS-07 §3.3)
// ---------------------------------------------------------------------------------------------

describe("applyPermissionUpdate: an unrecognized update `type` is never rejected and never mutates the set", () => {
  test("returns the set unchanged (same entries/mode/directories) for an unknown type", () => {
    const set = seed([sourceRule(rv("Bash"), "allow", "user")], [{ path: "/tmp", source: "user" }]);
    const future = { type: "futureUpdateKind", someField: 42, destination: "userSettings" } as unknown as PermissionUpdate;
    const next = applyPermissionUpdate(set, future, { authority: "session" });
    expect(next).toEqual(set);
  });

  test("does not throw regardless of authority", () => {
    const set = emptyRuleSet();
    const future = { type: "futureUpdateKind" } as unknown as PermissionUpdate;
    expect(() => applyPermissionUpdate(set, future, { authority: "cliArg" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// resolveRules — precedence and trust gating (WS-07 §2/§3.2)
// ---------------------------------------------------------------------------------------------

describe("resolveRules: deny from any source beats allow from every source (independent slots -- no short-circuit)", () => {
  test("a matching deny and a matching allow from a DIFFERENT source are both reported independently", () => {
    const set = seed([sourceRule(rv("Bash", "rm *"), "deny", "user"), sourceRule(rv("Bash", "rm *"), "allow", "project")]);
    const result = resolveRules(set, call("Bash", { command: "rm -rf x" }), { trustedWorkspace: true });
    expect(result.deny?.source).toBe("user");
    expect(result.allow?.source).toBe("project");
    // resolveRules reports both matches; applying "deny beats allow" is the caller's job (T6),
    // per the brief's independent-slot return shape.
  });

  test("no match in a category leaves that slot undefined", () => {
    const set = seed([sourceRule(rv("Bash", "rm *"), "deny", "user")]);
    const result = resolveRules(set, call("Bash", { command: "ls" }), { trustedWorkspace: true });
    expect(result.deny).toBeUndefined();
    expect(result.ask).toBeUndefined();
    expect(result.allow).toBeUndefined();
  });
});

describe("resolveRules: ask beats allow regardless of specificity -- fixed stage order, not a specificity engine (WS-07 §2)", () => {
  test("a broad ask rule and a narrower matching allow rule are BOTH reported (no 'most specific wins' logic)", () => {
    const set = seed([sourceRule(rv("Bash"), "ask", "user"), sourceRule(rv("Bash", "ls -la"), "allow", "user")]);
    const result = resolveRules(set, call("Bash", { command: "ls -la" }), { trustedWorkspace: true });
    expect(result.ask).toBeDefined();
    expect(result.allow).toBeDefined();
  });
});

describe("resolveRules: managed rules are unweakenable at resolution too -- a managed deny always wins regardless of how many lower-source allows match", () => {
  test("many allow sources cannot shadow a managed deny", () => {
    const set = seed([
      sourceRule(rv("Bash", "rm *"), "deny", "managed"),
      sourceRule(rv("Bash", "rm *"), "allow", "cliArg"),
      sourceRule(rv("Bash", "rm *"), "allow", "user"),
      sourceRule(rv("Bash", "rm *"), "allow", "project"),
      sourceRule(rv("Bash", "rm *"), "allow", "session"),
    ]);
    const result = resolveRules(set, call("Bash", { command: "rm -rf x" }), { trustedWorkspace: true });
    expect(result.deny?.source).toBe("managed");
  });
});

describe("resolveRules: allowManagedPermissionRulesOnly limits the ENTIRE effective rule set to managed policy", () => {
  test("a non-managed allow is ignored even though it would otherwise match", () => {
    const set = seed([sourceRule(rv("Bash", "ls *"), "allow", "user")]);
    const result = resolveRules(set, call("Bash", { command: "ls -la" }), { trustedWorkspace: true, allowManagedPermissionRulesOnly: true });
    expect(result.allow).toBeUndefined();
  });

  test("a non-managed deny/ask is ALSO ignored under the lockdown (the filter is total, not allow-only)", () => {
    const set = seed([sourceRule(rv("Bash", "rm *"), "deny", "user"), sourceRule(rv("Bash", "git push*"), "ask", "user")]);
    const denyResult = resolveRules(set, call("Bash", { command: "rm -rf x" }), { trustedWorkspace: true, allowManagedPermissionRulesOnly: true });
    const askResult = resolveRules(set, call("Bash", { command: "git push" }), { trustedWorkspace: true, allowManagedPermissionRulesOnly: true });
    expect(denyResult.deny).toBeUndefined();
    expect(askResult.ask).toBeUndefined();
  });

  test("a managed rule still matches under the lockdown", () => {
    const set = seed([sourceRule(rv("Bash", "ls *"), "allow", "managed"), sourceRule(rv("Bash", "ls *"), "allow", "user")]);
    const result = resolveRules(set, call("Bash", { command: "ls -la" }), { trustedWorkspace: true, allowManagedPermissionRulesOnly: true });
    expect(result.allow?.source).toBe("managed");
  });
});

describe("resolveRules: project allow rules require workspace trust; project deny/ask apply untrusted (WS-07 §3.2)", () => {
  test("a project-sourced allow rule is INERT when the workspace is untrusted", () => {
    const set = seed([sourceRule(rv("Bash", "ls *"), "allow", "project")]);
    const result = resolveRules(set, call("Bash", { command: "ls -la" }), { trustedWorkspace: false });
    expect(result.allow).toBeUndefined();
  });

  test("the SAME project-sourced allow rule is ACTIVE when the workspace is trusted", () => {
    const set = seed([sourceRule(rv("Bash", "ls *"), "allow", "project")]);
    const result = resolveRules(set, call("Bash", { command: "ls -la" }), { trustedWorkspace: true });
    expect(result.allow?.source).toBe("project");
  });

  test("a project-sourced DENY rule applies regardless of trust", () => {
    const set = seed([sourceRule(rv("Bash", "rm *"), "deny", "project")]);
    const untrusted = resolveRules(set, call("Bash", { command: "rm -rf x" }), { trustedWorkspace: false });
    const trusted = resolveRules(set, call("Bash", { command: "rm -rf x" }), { trustedWorkspace: true });
    expect(untrusted.deny?.source).toBe("project");
    expect(trusted.deny?.source).toBe("project");
  });

  test("a project-sourced ASK rule applies regardless of trust", () => {
    const set = seed([sourceRule(rv("Bash", "git push*"), "ask", "project")]);
    const untrusted = resolveRules(set, call("Bash", { command: "git push" }), { trustedWorkspace: false });
    expect(untrusted.ask?.source).toBe("project");
  });

  test("allow rules from every OTHER source are never trust-gated", () => {
    for (const source of ["user", "local", "cliArg", "session", "sdk", "managed"] as const) {
      const set = seed([sourceRule(rv("Bash", "ls *"), "allow", source)]);
      const result = resolveRules(set, call("Bash", { command: "ls -la" }), { trustedWorkspace: false });
      expect(result.allow?.source).toBe(source);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// effectiveDirectories — same trust-gating principle applied to additionalDirectories grants
// (WS-07 §3.2: "Project .winter/ ... additionalDirectories grant capability and require workspace
// trust")
// ---------------------------------------------------------------------------------------------

describe("effectiveDirectories: project-sourced directory grants require workspace trust", () => {
  test("a project-sourced directory is excluded when untrusted", () => {
    const set = seed([], [{ path: "/repo/vendor", source: "project" }]);
    expect(effectiveDirectories(set, { trustedWorkspace: false })).toEqual([]);
  });

  test("a project-sourced directory is included when trusted", () => {
    const set = seed([], [{ path: "/repo/vendor", source: "project" }]);
    expect(effectiveDirectories(set, { trustedWorkspace: true })).toEqual(["/repo/vendor"]);
  });

  test("a user-sourced directory is always included, regardless of trust", () => {
    const set = seed([], [{ path: "/home/extra", source: "user" }]);
    expect(effectiveDirectories(set, { trustedWorkspace: false })).toEqual(["/home/extra"]);
  });
});

// ---------------------------------------------------------------------------------------------
// buildSdkSourcedEntries — Options.{allowedTools,disallowedTools,permissions} seed builder
// ---------------------------------------------------------------------------------------------

describe("buildSdkSourcedEntries: Options fields become source:'sdk' entries with the correct behavior", () => {
  test("allowedTools become allow entries", () => {
    const entries = buildSdkSourcedEntries({ allowedTools: ["Read", "Bash(ls *)"] });
    expect(entries.every((e) => e.behavior === "allow" && e.source === "sdk")).toBe(true);
    expect(entries.map((e) => e.rule.toolName)).toEqual(["Read", "Bash"]);
  });

  test("disallowedTools become deny entries, bare vs scoped both preserved (isBareEquivalent)", () => {
    const entries = buildSdkSourcedEntries({ disallowedTools: ["Bash", "Bash(rm *)"] });
    expect(entries.every((e) => e.behavior === "deny" && e.source === "sdk")).toBe(true);
    expect(entries[0]!.rule.isBareEquivalent).toBe(true);
    expect(entries[1]!.rule.isBareEquivalent).toBe(false);
  });

  test("permissions.allow/ask/deny map to their respective behaviors", () => {
    const entries = buildSdkSourcedEntries({
      permissions: { allow: ["WebFetch(domain:example.com)"], ask: ["Bash(git push*)"], deny: ["Bash(curl *)"] },
    });
    const byBehavior = Object.fromEntries(entries.map((e) => [e.behavior, e.rule.toolName]));
    expect(byBehavior).toEqual({ allow: "WebFetch", ask: "Bash", deny: "Bash" });
    expect(entries.every((e) => e.source === "sdk")).toBe(true);
  });

  test("an empty/absent input produces no entries", () => {
    expect(buildSdkSourcedEntries({})).toEqual([]);
  });

  test("the SAME add-time validation applies here: an invalid MCP rule in allowedTools throws", () => {
    expect(() => buildSdkSourcedEntries({ allowedTools: ["mcp__x(p:1)"] })).toThrow(PermissionRuleValidationError);
  });

  test("an unanchored MCP allow glob in permissions.allow throws", () => {
    expect(() => buildSdkSourcedEntries({ permissions: { allow: ["mcp__*"] } })).toThrow(PermissionRuleValidationError);
  });

  test("an over-cap Read/Edit glob in allowedTools throws", () => {
    const overCap = `Read(${Array.from({ length: MAX_DOUBLE_STARS + 1 }, () => "**").join("/a/")})`;
    expect(() => buildSdkSourcedEntries({ allowedTools: [overCap] })).toThrow(PermissionRuleValidationError);
  });
});

// ---------------------------------------------------------------------------------------------
// appendPermissionJournal — phase ruling 2: file-destination updates persist session-effective
// immediately AND append to <sessionId>.permission-journal.jsonl for P5 replay.
// ---------------------------------------------------------------------------------------------

describe("appendPermissionJournal: file-destination updates are journaled (Ruling 2)", () => {
  test("a userSettings-destined update is appended as one JSONL line", () => {
    const home = freshHome();
    const update: PermissionUpdate = { type: "addRules", rules: [rv("Bash", "ls *")], behavior: "allow", destination: "userSettings" };
    appendPermissionJournal({ winterHome: home, projectKey: "proj", sessionId: "sess-1" }, update);
    const lines = readJournalLines(home, "proj", "sess-1");
    expect(lines).toEqual([update]);
  });

  test("projectSettings and localSettings destinations are also journaled", () => {
    const home = freshHome();
    const u1: PermissionUpdate = { type: "setMode", mode: "acceptEdits", destination: "projectSettings" };
    const u2: PermissionUpdate = { type: "addDirectories", directories: ["/tmp/x"], destination: "localSettings" };
    appendPermissionJournal({ winterHome: home, projectKey: "proj", sessionId: "sess-1" }, u1);
    appendPermissionJournal({ winterHome: home, projectKey: "proj", sessionId: "sess-1" }, u2);
    expect(readJournalLines(home, "proj", "sess-1")).toEqual([u1, u2]);
  });

  test("a session-destined update is NOT journaled (session is ephemeral, not a file)", () => {
    const home = freshHome();
    const update: PermissionUpdate = { type: "addRules", rules: [rv("Bash")], behavior: "allow", destination: "session" };
    appendPermissionJournal({ winterHome: home, projectKey: "proj", sessionId: "sess-1" }, update);
    expect(existsSync(journalPath(home, "proj", "sess-1"))).toBe(false);
  });

  test("a cliArg-destined update is NOT journaled", () => {
    const home = freshHome();
    const update: PermissionUpdate = { type: "addRules", rules: [rv("Bash")], behavior: "allow", destination: "cliArg" };
    appendPermissionJournal({ winterHome: home, projectKey: "proj", sessionId: "sess-1" }, update);
    expect(existsSync(journalPath(home, "proj", "sess-1"))).toBe(false);
  });

  test("an unrecognized update TYPE is journaled regardless of its claimed destination -- lossless wins (WS-07 §3.3)", () => {
    const home = freshHome();
    const future = { type: "futureUpdateKind", destination: "session", payload: { nested: [1, 2, 3] } } as unknown as PermissionUpdate;
    appendPermissionJournal({ winterHome: home, projectKey: "proj", sessionId: "sess-1" }, future);
    expect(readJournalLines(home, "proj", "sess-1")).toEqual([future]);
  });

  test("an unrecognized update TYPE with no destination field at all is still journaled", () => {
    const home = freshHome();
    const future = { type: "futureUpdateKind" } as unknown as PermissionUpdate;
    appendPermissionJournal({ winterHome: home, projectKey: "proj", sessionId: "sess-1" }, future);
    expect(readJournalLines(home, "proj", "sess-1")).toEqual([future]);
  });

  test("multiple appends accumulate as separate JSONL lines, in order", () => {
    const home = freshHome();
    const u1: PermissionUpdate = { type: "addRules", rules: [rv("Bash")], behavior: "allow", destination: "userSettings" };
    const u2: PermissionUpdate = { type: "addRules", rules: [rv("Read")], behavior: "deny", destination: "userSettings" };
    appendPermissionJournal({ winterHome: home, projectKey: "proj", sessionId: "sess-1" }, u1);
    appendPermissionJournal({ winterHome: home, projectKey: "proj", sessionId: "sess-1" }, u2);
    expect(readJournalLines(home, "proj", "sess-1")).toEqual([u1, u2]);
  });

  test("the journal lives store-adjacent: <home>/projects/<projectKey>/<sessionId>.permission-journal.jsonl", () => {
    const home = freshHome();
    const update: PermissionUpdate = { type: "setMode", mode: "auto", destination: "userSettings" };
    appendPermissionJournal({ winterHome: home, projectKey: "my-proj", sessionId: "my-sess" }, update);
    expect(existsSync(join(home, "projects", "my-proj", "my-sess.permission-journal.jsonl"))).toBe(true);
  });

  test("the journal directory is created fresh -- no pre-existing structure required", () => {
    const home = freshHome(); // brand-new mkdtemp: no projects/ dir exists yet
    const update: PermissionUpdate = { type: "setMode", mode: "auto", destination: "userSettings" };
    expect(() => appendPermissionJournal({ winterHome: home, projectKey: "proj", sessionId: "sess" }, update)).not.toThrow();
  });

  test("the journal file is written with a restrictive mode, mirroring the session store's own discipline", () => {
    const home = freshHome();
    const update: PermissionUpdate = { type: "setMode", mode: "auto", destination: "userSettings" };
    appendPermissionJournal({ winterHome: home, projectKey: "proj", sessionId: "sess" }, update);
    const mode = statSync(journalPath(home, "proj", "sess")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("different sessionIds under the same project get independent journal files", () => {
    const home = freshHome();
    const update: PermissionUpdate = { type: "setMode", mode: "auto", destination: "userSettings" };
    appendPermissionJournal({ winterHome: home, projectKey: "proj", sessionId: "sess-a" }, update);
    expect(existsSync(journalPath(home, "proj", "sess-b"))).toBe(false);
    expect(existsSync(journalPath(home, "proj", "sess-a"))).toBe(true);
  });
});
