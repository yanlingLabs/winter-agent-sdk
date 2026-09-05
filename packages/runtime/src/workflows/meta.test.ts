// Phase 5 Lane W (task 4): the `meta` block is a PURE LITERAL (WS-11 §1.2, confirmed verbatim at
// the pinned declaration -- derived-shapes-p5 item (g), `sdk-tools.d.ts:2760`). This suite is the
// RED-first fixture set for every rule that makes it one.
//
// WHY A PARSER AND NOT AN EVALUATOR: `parseWorkflowMeta` runs in the DAEMON, unsandboxed, on a
// script the model just wrote and on every `.winter/workflows/*.js` a listing touches. Evaluating
// even the meta block there would defeat the entire reason the script body runs in a seatbelted
// subprocess. Norma's original (`workflows/store.ts`) reached the same conclusion and answered it
// with a regex that could only find `description`; this is the full literal grammar.
import { describe, test, expect } from "bun:test";
import { parseWorkflowMeta, matchPhaseGroup } from "./meta.ts";

function ok(source: string) {
  const parsed = parseWorkflowMeta(source);
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.error}`);
  return parsed.meta;
}

function err(source: string): string {
  const parsed = parseWorkflowMeta(source);
  if (parsed.ok) throw new Error(`expected a validation error, got: ${JSON.stringify(parsed.meta)}`);
  return parsed.error;
}

describe("parseWorkflowMeta -- the pure-literal grammar (WS-11 §1.2)", () => {
  test("a minimal literal meta parses: name + description are the two required keys", () => {
    const meta = ok(`export const meta = { name: "build", description: "Builds the thing" };\nreturn 1;`);
    expect(meta.name).toBe("build");
    expect(meta.description).toBe("Builds the thing");
  });

  test("single quotes, unquoted/quoted keys and a trailing comma are all legal JS object-literal syntax (this is NOT JSON.parse)", () => {
    const meta = ok(`export const meta = { 'name': 'a', "description": "b", whenToUse: 'when x', };`);
    expect(meta.name).toBe("a");
    expect(meta.whenToUse).toBe("when x");
  });

  test("nested arrays/objects of literals are allowed -- `phases` is the declared example", () => {
    const meta = ok(`export const meta = {
      name: "wf", description: "d",
      phases: [{ title: "Research", detail: "read", model: "sonnet" }, { title: "Write" }],
    };`);
    expect(meta.phases).toEqual([{ title: "Research", detail: "read", model: "sonnet" }, { title: "Write" }]);
  });

  test("numbers, booleans and null are literals too", () => {
    const meta = ok(`export const meta = { name: "n", description: "d", extra: [1, -2.5, true, false, null] };`);
    expect((meta as unknown as { extra: unknown[] }).extra).toEqual([1, -2.5, true, false, null]);
  });

  // --- The four rejection rules the brief enumerates by name -------------------------------------

  test("REJECTS an identifier reference -- a computed value is not a literal", () => {
    expect(err(`const n = "x";\nexport const meta = { name: n, description: "d" };`)).toContain("literal");
  });

  test("REJECTS a call expression", () => {
    expect(err(`export const meta = { name: String("x"), description: "d" };`)).toContain("literal");
  });

  test("REJECTS a spread", () => {
    expect(err(`export const meta = { ...base, name: "x", description: "d" };`)).toContain("literal");
  });

  test("REJECTS a template literal, interpolated or not", () => {
    expect(err("export const meta = { name: `wf-${id}`, description: \"d\" };")).toContain("literal");
    expect(err("export const meta = { name: `plain`, description: \"d\" };")).toContain("literal");
  });

  test("REJECTS an arithmetic expression -- `1 + 1` is computed, not a literal", () => {
    expect(err(`export const meta = { name: "x", description: "d", n: 1 + 1 };`)).toContain("literal");
  });

  // --- Structural requirements -------------------------------------------------------------------

  test("a missing meta block is a validation error naming what is missing", () => {
    expect(err(`return 42;`)).toContain("meta");
  });

  test("`name` and `description` are REQUIRED (each named individually)", () => {
    expect(err(`export const meta = { description: "d" };`)).toContain("name");
    expect(err(`export const meta = { name: "n" };`)).toContain("description");
  });

  test("`name` and `description` must be STRINGS -- a number `name` cannot key a filename", () => {
    expect(err(`export const meta = { name: 7, description: "d" };`)).toContain("name");
  });

  test("an unbalanced meta object is a validation error, never a hang or a silent empty meta", () => {
    expect(err(`export const meta = { name: "n", description: "d"`)).toBeTruthy();
  });

  test("a brace inside a STRING never desyncs the brace counter", () => {
    const meta = ok(`export const meta = { name: "n", description: "a } here { too" };`);
    expect(meta.description).toBe("a } here { too");
  });

  test("`phases` must be an array of objects with a STRING title", () => {
    expect(err(`export const meta = { name: "n", description: "d", phases: "Research" };`)).toContain("phases");
    expect(err(`export const meta = { name: "n", description: "d", phases: [{ detail: "no title" }] };`)).toContain("phases");
  });

  test("escape sequences inside a string literal are decoded, never re-evaluated", () => {
    const meta = ok(String.raw`export const meta = { name: "n", description: "line\none\ttab \"quoted\"" };`);
    expect(meta.description).toBe('line\none\ttab "quoted"');
  });

  test("`export const meta` may also be written `export let`/`export var`, and a leading comment does not hide it", () => {
    expect(ok(`// a workflow\nexport let meta = { name: "n", description: "d" };`).name).toBe("n");
    expect(ok(`export var meta = { name: "n", description: "d" };`).name).toBe("n");
  });
});

describe("matchPhaseGroup -- declared phases vs an unmatched phase() call (WS-11 §1.2)", () => {
  const phases = [{ title: "Research" }, { title: "Write", detail: "prose" }];

  test("a phase() title matching a declared phase EXACTLY resolves to that declared group", () => {
    expect(matchPhaseGroup(phases, "Write")).toEqual({ title: "Write", detail: "prose", declared: true });
  });

  test("matching is EXACT -- a near miss is not the declared group", () => {
    expect(matchPhaseGroup(phases, "write")).toEqual({ title: "write", declared: false });
  });

  test("an unmatched phase() call gets its OWN group rather than being dropped or folded into the last one", () => {
    expect(matchPhaseGroup(phases, "Cleanup")).toEqual({ title: "Cleanup", declared: false });
  });

  test("with no declared phases at all, every phase() call is its own group", () => {
    expect(matchPhaseGroup(undefined, "Anything")).toEqual({ title: "Anything", declared: false });
  });
});
